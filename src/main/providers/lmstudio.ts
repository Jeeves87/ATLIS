/**
 * LM Studio — local models over its OpenAI-compatible server.
 *
 * LM Studio speaks the chat-completions wire format (including streamed tool
 * calls) at http://127.0.0.1:1234/v1, so the actual turn reuses the shared
 * streamer the OpenAI and Copilot providers use. The only local-specific parts
 * are where the server lives and how models are listed.
 *
 * MODEL LISTING prefers LM Studio's native `/api/v0/models`, because it says
 * what each entry IS: the OpenAI-shaped `/v1/models` mixes embedding models in
 * with chat models and gives no way to tell them apart except by name. The
 * native list also reports which models are loaded, so those sort first.
 * Unloaded models still work — LM Studio loads on first request (JIT) — they
 * just pay the load time once.
 *
 * NO KEY IS NEEDED unless the user has turned on "Require API key" in LM
 * Studio's server settings; the OpenAI client insists on a non-empty string,
 * so a placeholder goes in when none is configured.
 */
import OpenAI from 'openai'
import type { ChatMessage, ModelInfo, Provider, ToolSpec } from './types'
import { streamChatCompletions } from './openai'
import { getSetting } from '../db'

/** Errors this module already phrased for the user — passed through, not re-wrapped. */
class LmStudioError extends Error {}

export const LMSTUDIO_DEFAULT_URL = 'http://127.0.0.1:1234/v1'

/** Base URL ending in /v1, whatever form the user typed it in. */
export function lmStudioBaseUrl(): string {
  const raw = (getSetting('lmstudio_base_url') ?? '').trim() || LMSTUDIO_DEFAULT_URL
  const noSlash = raw.replace(/\/+$/, '')
  return /\/v1$/.test(noSlash) ? noSlash : `${noSlash}/v1`
}

function client(): OpenAI {
  return new OpenAI({ baseURL: lmStudioBaseUrl(), apiKey: getSetting('lmstudio_api_key') || 'lm-studio' })
}

interface NativeModel {
  id: string
  type?: string
  state?: string
  max_context_length?: number
  capabilities?: string[]
}

async function nativeModels(): Promise<NativeModel[] | null> {
  const root = lmStudioBaseUrl().replace(/\/v1$/, '')
  try {
    const res = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const j = (await res.json()) as { data?: NativeModel[] }
    return Array.isArray(j.data) ? j.data : null
  } catch {
    return null
  }
}

export const lmstudioProvider: Provider = {
  id: 'lmstudio',

  async listModels(): Promise<ModelInfo[]> {
    const native = await nativeModels()
    if (native) {
      return native
        .filter((m) => m.type === 'llm' || m.type === 'vlm')
        .sort((a, b) => Number(b.state === 'loaded') - Number(a.state === 'loaded') || a.id.localeCompare(b.id))
        .map((m) => ({
          id: m.id,
          label: `${m.id}${m.state === 'loaded' ? ' · loaded' : ''}${m.capabilities?.includes('tool_use') ? '' : ' · no tools'}`,
          provider: 'lmstudio' as const
        }))
    }
    // Older LM Studio builds without the native API: name-filter the OpenAI list.
    try {
      const models = await client().models.list()
      return models.data
        .filter((m) => !/embed/i.test(m.id))
        .map((m) => ({ id: m.id, label: m.id, provider: 'lmstudio' as const }))
    } catch (err) {
      throw new Error(
        `LM Studio is not reachable at ${lmStudioBaseUrl()} — start its local server (Developer tab → Start Server). ${err instanceof Error ? err.message : ''}`.trim()
      )
    }
  },

  async chat({ model, system, messages, tools, handlers }) {
    const ctx = await loadedContext(model)
    const fitted = ctx ? fitToContext(model, ctx, system, messages, tools) : messages
    try {
      const result = await streamChatCompletions(client(), model, system, fitted, tools, handlers)
      // When a prompt overflows, LM Studio does not always return the error: it
      // can retry with the prompt truncated, run out of room almost at once and
      // hand back empty content. Passing that on as a normal reply is how a
      // conversation silently stops working, so it is an error here.
      if (!result.text.trim() && !result.toolCalls.length && result.stopReason !== 'aborted') {
        const why = result.finishReason === 'length' ? ' It ran out of context before it could answer.' : ''
        throw new LmStudioError(
          `${model} returned an empty reply.${why}${ctx ? ` It is loaded with a ${ctx.toLocaleString()}-token context` : ''} — reload it in LM Studio with Context Length 16384 or more (My Models → gear icon sets the default for auto-loads).`
        )
      }
      return result
    } catch (err) {
      if (err instanceof LmStudioError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      // LM Studio JIT-loads a model at its configured context, 4096 by default —
      // smaller than a system prompt plus tool definitions. The raw llama.cpp
      // message ("n_keep >= n_ctx") does not say what to do about it.
      if (/n_ctx|context length|context window|context size/i.test(msg)) {
        throw new Error(
          `${model} is loaded with too small a context window for this conversation. In LM Studio, eject the model and load it again with Context Length 16384 or more (My Models → gear icon sets the default for JIT loads). Details: ${msg}`
        )
      }
      if (/ECONNREFUSED|fetch failed|Connection error/i.test(msg)) {
        throw new Error(`LM Studio is not reachable at ${lmStudioBaseUrl()} — start its local server (Developer tab → Start Server).`)
      }
      throw err
    }
  }
}

// ---------------------------------------------------------------- context fitting

/**
 * The context the model is ACTUALLY loaded with, or null when unknown (not
 * loaded yet — LM Studio will auto-load it at its configured default).
 *
 * This is the number that matters, not the model's maximum: auto-loads use
 * 4096 unless the user changed the default, while a 4B model's system prompt
 * plus a couple dozen tool definitions is already ~3.8k tokens.
 */
async function loadedContext(model: string): Promise<number | null> {
  const root = lmStudioBaseUrl().replace(/\/v1$/, '')
  try {
    const res = await fetch(`${root}/api/v0/models/${encodeURIComponent(model).replace(/%2F/g, '/')}`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const m = (await res.json()) as { state?: string; loaded_context_length?: number }
    return m.state === 'loaded' && typeof m.loaded_context_length === 'number' ? m.loaded_context_length : null
  } catch {
    return null
  }
}

/**
 * Rough token count. Measured against LM Studio's own count for this app's
 * prompts (JSON tool schemas, English, prices): ~3.3 chars per token. Erring
 * high only trims a little early; erring low is the failure being prevented.
 */
const CHARS_PER_TOKEN = 3.3
const IMAGE_TOKENS = 800
const est = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN)

function msgTokens(m: ChatMessage): number {
  const content =
    typeof m.content === 'string'
      ? est(m.content.length)
      : m.content.reduce((n, p) => n + (p.type === 'text' ? est(p.text.length) : IMAGE_TOKENS), 0)
  const calls = (m.toolCalls ?? []).reduce((n, c) => n + est(c.name.length + c.arguments.length + 30), 0)
  return content + calls + 8
}

function shrinkTool(m: ChatMessage, maxChars: number, note: string): ChatMessage {
  const text = typeof m.content === 'string' ? m.content : m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
  if (text.length <= maxChars) return typeof m.content === 'string' ? m : { ...m, content: text }
  return { ...m, content: `${text.slice(0, maxChars)}\n…[${note}]` }
}

/**
 * Make the conversation fit the loaded context, cheapest loss first:
 *   1. shrink tool results from earlier exchanges — they were already answered;
 *   2. drop the oldest exchanges, always cutting on a user message so no tool
 *      result is left without its call;
 *   3. shrink the current exchange's tool results to share what room is left.
 * If the fixed part (system prompt + tool definitions + the question itself)
 * cannot fit, no trimming helps, and the error says what to change.
 */
export function fitToContext(model: string, ctx: number, system: string, messages: ChatMessage[], tools: ToolSpec[]): ChatMessage[] {
  const reserve = Math.min(1536, Math.floor(ctx * 0.25)) // room to answer
  const budget = ctx - reserve
  const fixed = est(system.length) + est(JSON.stringify(tools).length) + 16
  const total = (ms: ChatMessage[]): number => fixed + ms.reduce((n, m) => n + msgTokens(m), 0)
  if (total(messages) <= budget) return messages

  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  let out = messages.map((m, i) =>
    m.role === 'tool' && i < lastUser ? shrinkTool(m, 400, 'earlier tool result shortened to fit the context window') : m
  )

  let start = 0
  const current = out.length - (lastUser < 0 ? 0 : lastUser)
  while (total(out.slice(start)) > budget && out.length - start > current) {
    start++
    while (start < out.length - current && out[start].role !== 'user') start++
  }
  out = out.slice(start)

  if (total(out) > budget) {
    const toolIdx = out.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0)
    if (toolIdx.length) {
      const withoutTools = total(out.filter((m) => m.role !== 'tool'))
      const each = Math.max(300, Math.floor(((budget - withoutTools) * CHARS_PER_TOKEN) / toolIdx.length) - 120)
      out = out.map((m) =>
        m.role === 'tool'
          ? shrinkTool(m, each, `truncated to fit ${model}'s ${ctx}-token context — ask again with filters or a limit for the rest`)
          : m
      )
    }
  }

  if (total(out) > budget) {
    throw new LmStudioError(
      `${model} is loaded with a ${ctx.toLocaleString()}-token context, but its instructions and tool definitions alone need about ${fixed.toLocaleString()} tokens plus room to answer. Reload it in LM Studio with Context Length 16384 or more (My Models → gear icon sets the default for auto-loads).`
    )
  }
  return out
}

/**
 * Reasoning models (Qwen3, DeepSeek-R1 distills) put their chain of thought in
 * <think> tags inside the content unless LM Studio's "separate reasoning"
 * option is on. That belongs in the transcript, not in a Discord reply.
 */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '') // opening tag swallowed by the template
    .trim()
}
