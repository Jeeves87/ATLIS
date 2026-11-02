import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk'
import type { CopilotSession, Tool, ToolInvocation, ToolResultObject } from '@github/copilot-sdk'
import { createRequire } from 'node:module'
import type { ChatMessage, ContentPart, ChatResult, Provider, StreamHandlers, ToolCall, ToolSpec } from './types'
import { getSetting } from '../db'

/**
 * GitHub Copilot provider.
 *
 * This intentionally uses the official Copilot SDK/runtime instead of directly
 * calling api.github.com/copilot_internal/v2/token. The direct token exchange
 * can fail with 403 for CLI OAuth tokens even when the same logged-in account
 * works through the supported SDK path.
 *
 * Option A integration: plain chat streaming only. ATLIS tool calls are ignored
 * for now; the SDK/runtime can be wired to ATLIS tools later.
 */

let client: CopilotClient | null = null
let clientStarted = false
let clientStartPromise: Promise<void> | null = null

const requireFromHere = createRequire(import.meta.url)

function copilotPlatformPackageName(): string {
  const arch = process.arch
  const platform = process.platform
  if (platform === 'win32') return `@github/copilot-win32-${arch}`
  if (platform === 'darwin') return `@github/copilot-darwin-${arch}`
  return `@github/copilot-linux-${arch}`
}

function resolveCopilotCliPath(): string | undefined {
  try {
    // Important for Electron: the SDK default resolves the platform package's
    // JS shim and launches it with process.execPath. In Electron, process.execPath
    // is electron/ATLIS, not node.exe, so the child can exit cleanly with code 0
    // as soon as the runtime is exercised. Resolve the package's exported binary
    // instead so the SDK spawns copilot.exe directly.
    return requireFromHere.resolve(copilotPlatformPackageName())
  } catch {
    return undefined
  }
}

async function getClient(): Promise<CopilotClient> {
  if (!client) {
    const gh = getSetting('github_token')?.trim()
    const cliPath = resolveCopilotCliPath()
    client = new CopilotClient({
      // Match Waygent/the SDK default path: prefer the logged-in Copilot/GitHub
      // user. If ATLIS has an explicit token saved, pass it through; otherwise
      // the runtime falls back to stored Copilot CLI / gh CLI credentials.
      ...(gh ? { gitHubToken: gh } : { useLoggedInUser: true }),
      ...(cliPath ? { connection: RuntimeConnection.forStdio({ path: cliPath }) } : {}),
      logLevel: 'error',
      env: process.env as Record<string, string | undefined>
    })
  }

  if (!clientStarted) {
    clientStartPromise ??= client.start().then(() => {
      clientStarted = true
    })
    await clientStartPromise
  }

  return client
}

const textOf = (content: string | ContentPart[]): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('\n')

function promptFromMessages(messages: ChatMessage[]): string {
  // The Copilot SDK session is not OpenAI chat-completions shaped, so flatten
  // ATLIS history into one prompt. Tool activity from earlier turns is kept as
  // compact text so the model retains what it already did and learned.
  return messages
    .map((m) => {
      const text = textOf(m.content).trim()
      if (m.role === 'tool') {
        if (!text) return ''
        return `Tool result (${m.toolName ?? 'tool'}):\n${text.length > 1500 ? text.slice(0, 1500) + '\n[...truncated]' : text}`
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const calls = m.toolCalls.map((c) => c.name).join(', ')
        return `Assistant:\n${text ? text + '\n' : ''}[called tools: ${calls}]`
      }
      if (!text) return ''
      if (m.role === 'user') return `User:\n${text}`
      if (m.role === 'assistant') return `Assistant:\n${text}`
      if (m.role === 'system') return `System:\n${text}`
      return text
    })
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Bridge ATLIS ToolSpecs into SDK custom tools. The SDK runtime runs the
 * agentic loop itself; each invocation is routed back to the runner via
 * handlers.onToolExecute, which persists transcript rows and executes the
 * real ATLIS tool.
 */
function bridgeTools(specs: ToolSpec[], handlers: StreamHandlers, executed: ToolCall[]): Tool[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    // ATLIS/MCP names may collide with CLI builtins; the CLI's own tools are
    // excluded from the session, so a collision always means "the ATLIS tool".
    overridesBuiltInTool: true,
    // ATLIS has no per-tool permission UI — parity with the other providers.
    skipPermission: true,
    defer: 'never' as const,
    handler: async (args: unknown, invocation: ToolInvocation): Promise<ToolResultObject> => {
      const call: ToolCall = {
        id: invocation.toolCallId,
        name: spec.name,
        arguments: JSON.stringify(args ?? {})
      }
      executed.push(call)
      handlers.onToolCall?.(call)
      const result = await handlers.onToolExecute!(call)
      return {
        textResultForLlm: result.text,
        resultType: 'success',
        ...(result.imageBase64 && result.imageMime
          ? { binaryResultsForLlm: [{ type: 'image' as const, data: result.imageBase64, mimeType: result.imageMime }] }
          : {})
      }
    }
  }))
}

function toCopilotModel(model: string): string {
  // Keep explicit SDK/Copilot model IDs intact. Map older UI defaults to models
  // the SDK examples/runtime commonly know about.
  if (!model || model === 'gpt-4o-copilot') return 'gpt-5'
  return model
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const copilotProvider: Provider = {
  id: 'copilot',

  async listModels() {
    try {
      const c = await getClient()
      const models = await c.listModels()
      return models.map((m) => ({
        id: m.id,
        label: m.name || m.id,
        provider: 'copilot' as const
      }))
    } catch {
      // Keep Settings/model picker usable even if Copilot runtime/auth is not
      // ready yet. The chat call will surface the detailed startup/auth error.
      return [
        { id: 'gpt-5', label: 'GPT-5 (Copilot SDK)', provider: 'copilot' as const },
        { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (Copilot SDK)', provider: 'copilot' as const }
      ]
    }
  },

  async chat({ model, system, messages, tools, handlers }: { model: string; system: string; messages: ChatMessage[]; tools: ToolSpec[]; handlers: StreamHandlers }): Promise<ChatResult> {
    const c = await getClient()
    let session: CopilotSession | null = null
    let text = ''
    let sawDelta = false
    let completed = false
    let abortHandler: (() => void) | null = null
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const executedCalls: ToolCall[] = []
    // Tools require the runner-side executor; without it stay chat-only.
    const sdkTools = tools.length && handlers.onToolExecute ? bridgeTools(tools, handlers, executedCalls) : []

    try {
      session = await c.createSession({
        model: toCopilotModel(model),
        streaming: true,
        systemMessage: system?.trim()
          ? {
              mode: 'append',
              content: system.trim()
            }
          : undefined,
        ...(sdkTools.length ? { tools: sdkTools } : {}),
        // The CLI's ambient coding tools stay off either way — in agent mode
        // ATLIS supplies its own via `tools` (source `custom:*`, which must
        // then stay enabled for the bridge to work).
        excludedTools: sdkTools.length ? ['builtin:*', 'mcp:*'] : ['builtin:*', 'mcp:*', 'custom:*'],
        infiniteSessions: { enabled: false },
        memory: { enabled: false },
        skipCustomInstructions: true,
        enableSessionTelemetry: false
      } as any)

      const done = new Promise<void>((resolve, reject) => {
        session!.on('assistant.message_delta' as any, (event: any) => {
          const delta = event?.data?.deltaContent ?? ''
          if (delta) {
            sawDelta = true
            text += delta
            handlers.onTextDelta(delta)
          }
        })

        session!.on('assistant.message' as any, (event: any) => {
          const content = event?.data?.content ?? ''
          if (content && !sawDelta) {
            // Non-streaming turn: emit the whole message. Multi-turn episodes
            // (tool use) produce several of these, so append rather than assign.
            const chunk = (text ? '\n\n' : '') + content
            text += chunk
            handlers.onTextDelta(chunk)
          } else if (content && sawDelta && !text.trim()) {
            text = content
          } else if (sawDelta && text && !text.endsWith('\n')) {
            // Streamed turn boundary within a tool-use episode: keep the next
            // turn's deltas from gluing onto this turn's last sentence.
            text += '\n\n'
            handlers.onTextDelta('\n\n')
          }
        })

        session!.on('assistant.usage' as any, (event: any) => {
          const d = event?.data ?? {}
          usage.inputTokens += d.inputTokens ?? 0
          usage.outputTokens += d.outputTokens ?? 0
          usage.cacheReadTokens += d.cacheReadTokens ?? 0
          usage.cacheWriteTokens += d.cacheWriteTokens ?? 0
        })

        session!.on('session.idle' as any, () => {
          completed = true
          resolve()
        })

        // The runtime's error event type is 'session.error' (verified against
        // SDK 1.0.5): listening to 'error' silently missed auth failures and
        // produced empty assistant messages.
        session!.on('session.error' as any, (event: any) => {
          reject(new Error(event?.data?.message ?? errorMessage(event?.data ?? event)))
        })

        if (handlers.signal) {
          abortHandler = () => {
            session
              ?.abort()
              .catch(() => {})
              .finally(() => resolve())
          }
          if (handlers.signal.aborted) abortHandler()
          else handlers.signal.addEventListener('abort', abortHandler, { once: true })
        }
      })

      // `done` can reject while send() is still pending (e.g. session.error on
      // auth failure) — mark it handled up front so the early rejection can't
      // escape as an unhandled rejection; `await done` below still rethrows.
      done.catch(() => {})

      const prompt = promptFromMessages(messages)
      await session.send({ prompt })
      await done

      // Tool calls were already executed in-session (via handlers.onToolExecute),
      // so none are returned as pending — the runner's outer loop must not rerun them.
      void executedCalls
      return {
        text,
        toolCalls: [],
        usage,
        stopReason: handlers.signal?.aborted ? 'aborted' : completed ? 'end' : 'aborted'
      }
    } catch (error) {
      throw new Error(`Copilot SDK chat failed: ${errorMessage(error)}`)
    } finally {
      if (handlers.signal && abortHandler) handlers.signal.removeEventListener('abort', abortHandler)
      if (session) await session.disconnect().catch(() => {})
    }
  }
}
