export type ProviderId = 'anthropic' | 'openai' | 'copilot' | 'lmstudio'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; dataBase64: string }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  // A plain string for text-only turns, or content parts for multimodal (vision) turns.
  content: string | ContentPart[]
  // assistant tool calls
  toolCalls?: ToolCall[]
  // tool result linkage
  toolCallId?: string
  toolName?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: string // raw JSON string
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON schema
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Outcome of executing one tool call on behalf of a self-executing provider. */
export interface ToolExecutionResult {
  text: string
  imageMime?: string
  imageBase64?: string
}

export interface StreamHandlers {
  onTextDelta: (delta: string) => void
  onToolCall?: (call: ToolCall) => void
  /**
   * When set, the provider may run its own agentic loop (Copilot SDK does):
   * each model tool call is routed here, and the result is fed back to the
   * model in-session. Providers using this path resolve chat() only when the
   * whole episode is done, returning stopReason 'end' with no pending
   * toolCalls — the runner's outer tool loop is bypassed.
   */
  onToolExecute?: (call: ToolCall) => Promise<ToolExecutionResult>
  signal?: AbortSignal
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  usage: TokenUsage
  stopReason: 'end' | 'tool_use' | 'aborted' | 'error'
  /** Raw finish reason from the wire, when the provider reports one ('stop', 'length', …). */
  finishReason?: string
}

export interface ModelInfo {
  id: string
  label: string
  provider: ProviderId
}

export interface Provider {
  id: ProviderId
  listModels(): Promise<ModelInfo[]>
  /** Stream one assistant turn. Resolves when the turn completes (or aborts). */
  chat(opts: {
    model: string
    system: string
    messages: ChatMessage[]
    tools: ToolSpec[]
    handlers: StreamHandlers
  }): Promise<ChatResult>
}
