import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, ContentPart, ChatResult, Provider, StreamHandlers, ToolCall, ToolSpec } from './types'
import { getSetting } from '../db'

function client(): Anthropic {
  const key = getSetting('anthropic_api_key')
  if (!key) throw new Error('Anthropic API key not set — add it in Settings.')
  return new Anthropic({ apiKey: key })
}

type AnthropicToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicToolResultContent[] }

const textOf = (content: string | ContentPart[]): string =>
  typeof content === 'string' ? content : content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')

/** Map our content (string or parts) to an Anthropic message content value. */
function toAnthropicContent(content: string | ContentPart[]): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') return content
  const parts: AnthropicContent[] = content.map((p) =>
    p.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.dataBase64 } }
      : { type: 'text', text: p.text }
  )
  return parts as Anthropic.MessageParam['content']
}

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      // Anthropic's tool_result content accepts text+image blocks natively -
      // unlike OpenAI-style tool messages, which are string-only (see openai.ts).
      const resultContent: string | AnthropicToolResultContent[] = typeof m.content === 'string'
        ? m.content
        : m.content.map((p) =>
            p.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.dataBase64 } } : { type: 'text', text: p.text }
          )
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId!, content: resultContent } as AnthropicContent] as Anthropic.MessageParam['content']
      })
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: AnthropicContent[] = []
      const text = textOf(m.content)
      if (text) content.push({ type: 'text', text })
      for (const tc of m.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: JSON.parse(tc.arguments || '{}') })
      }
      out.push({ role: 'assistant', content: content as Anthropic.MessageParam['content'] })
    } else {
      out.push({ role: m.role as 'user' | 'assistant', content: toAnthropicContent(m.content) })
    }
  }
  return out
}

export const anthropicProvider: Provider = {
  id: 'anthropic',

  async listModels() {
    const models = await client().models.list({ limit: 50 })
    return models.data.map((m) => ({ id: m.id, label: m.display_name ?? m.id, provider: 'anthropic' as const }))
  },

  async chat({ model, system, messages, tools, handlers }): Promise<ChatResult> {
    const anthropicTools: Anthropic.Tool[] = tools.map((t: ToolSpec) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema
    }))

    const stream = client().messages.stream(
      {
        model,
        max_tokens: 16384,
        system: system || undefined,
        messages: toAnthropicMessages(messages),
        tools: anthropicTools.length ? anthropicTools : undefined
      },
      { signal: handlers.signal }
    )

    let text = ''
    const toolCalls: ToolCall[] = []

    stream.on('text', (delta) => {
      text += delta
      handlers.onTextDelta(delta)
    })

    try {
      const final = await stream.finalMessage()
      for (const block of final.content) {
        if (block.type === 'tool_use') {
          const call: ToolCall = { id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }
          toolCalls.push(call)
          handlers.onToolCall?.(call)
        }
      }
      return {
        text,
        toolCalls,
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
          cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0
        },
        stopReason: final.stop_reason === 'tool_use' ? 'tool_use' : 'end'
      }
    } catch (err) {
      if (handlers.signal?.aborted) {
        return { text, toolCalls, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'aborted' }
      }
      throw err
    }
  }
}
