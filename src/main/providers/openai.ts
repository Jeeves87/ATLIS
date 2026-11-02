import OpenAI from 'openai'
import type { ChatMessage, ContentPart, ChatResult, Provider, StreamHandlers, ToolCall, ToolSpec } from './types'
import { getSetting } from '../db'

function client(): OpenAI {
  const key = getSetting('openai_api_key')
  if (!key) throw new Error('OpenAI API key not set — add it in Settings.')
  return new OpenAI({ apiKey: key })
}

const textOf = (content: string | ContentPart[]): string =>
  typeof content === 'string' ? content : content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')

/** Map our content to an OpenAI user-message content value (string or parts with image_url data URIs). */
function toOpenAiUserContent(content: string | ContentPart[]): OpenAI.Chat.ChatCompletionUserMessageParam['content'] {
  if (typeof content === 'string') return content
  return content.map((p) =>
    p.type === 'image'
      ? { type: 'image_url' as const, image_url: { url: `data:${p.mime};base64,${p.dataBase64}` } }
      : { type: 'text' as const, text: p.text }
  )
}

export function toOpenAiMessages(system: string, messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId!, content: textOf(m.content) })
      // OpenAI-style tool messages are string-only per the API spec (unlike
      // Anthropic's tool_result blocks, which accept images directly) - so an
      // image-bearing tool result rides along as a separate user message.
      if (Array.isArray(m.content)) {
        const images = m.content.filter((p) => p.type === 'image')
        if (images.length) out.push({ role: 'user', content: toOpenAiUserContent(images) })
      }
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: textOf(m.content) || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments || '{}' }
        }))
      })
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: toOpenAiUserContent(m.content) })
    } else {
      out.push({ role: 'assistant', content: textOf(m.content) })
    }
  }
  return out
}

export function toOpenAiTools(tools: ToolSpec[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

/** Shared chat-completions streaming used by both OpenAI and Copilot (same wire format). */
export async function streamChatCompletions(
  api: OpenAI,
  model: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolSpec[],
  handlers: StreamHandlers
): Promise<ChatResult> {
  const stream = await api.chat.completions.create(
    {
      model,
      messages: toOpenAiMessages(system, messages),
      tools: tools.length ? toOpenAiTools(tools) : undefined,
      stream: true,
      stream_options: { include_usage: true }
    },
    { signal: handlers.signal }
  )

  let text = ''
  const callsByIndex = new Map<number, { id: string; name: string; args: string }>()
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let finish: string | null = null

  try {
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0]
      if (choice?.delta?.content) {
        text += choice.delta.content
        handlers.onTextDelta(choice.delta.content)
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const slot = callsByIndex.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name += tc.function.name
        if (tc.function?.arguments) slot.args += tc.function.arguments
        callsByIndex.set(tc.index, slot)
      }
      if (choice?.finish_reason) finish = choice.finish_reason
      if (chunk.usage) {
        const cached = (chunk.usage.prompt_tokens_details?.cached_tokens ?? 0)
        usage = {
          inputTokens: (chunk.usage.prompt_tokens ?? 0) - cached,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: cached,
          cacheWriteTokens: 0
        }
      }
    }
  } catch (err) {
    if (handlers.signal?.aborted) return { text, toolCalls: [], usage, stopReason: 'aborted' }
    throw err
  }

  const toolCalls: ToolCall[] = [...callsByIndex.values()].map((c) => ({ id: c.id, name: c.name, arguments: c.args }))
  for (const call of toolCalls) handlers.onToolCall?.(call)

  return { text, toolCalls, usage, stopReason: finish === 'tool_calls' ? 'tool_use' : 'end', finishReason: finish ?? undefined }
}

export const openaiProvider: Provider = {
  id: 'openai',

  async listModels() {
    const models = await client().models.list()
    return models.data
      .filter((m) => /^(gpt|o\d)/.test(m.id) && !/(audio|realtime|image|tts|transcribe|embedding|moderation|search|dall-e)/.test(m.id))
      .sort((a, b) => b.created - a.created)
      .map((m) => ({ id: m.id, label: m.id, provider: 'openai' as const }))
  },

  async chat({ model, system, messages, tools, handlers }) {
    return streamChatCompletions(client(), model, system, messages, tools, handlers)
  }
}
