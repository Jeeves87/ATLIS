import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { ToolSpec } from './providers/types'

/**
 * MCP client manager: connects configured servers (stdio or HTTP), exposes
 * their tools to the agent loop namespaced as `mcp__<server>__<tool>`, and
 * routes calls back. Kept free of electron imports so it can be exercised
 * from plain Node scripts.
 */

export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http'
  command?: string // stdio: executable
  args?: string[] // stdio: arguments
  env?: Record<string, string> // stdio: extra environment
  url?: string // http: endpoint
  enabled: boolean
}

export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  status: 'connected' | 'connecting' | 'error' | 'disabled'
  error?: string
  tools: { name: string; description: string }[]
}

interface ExposedTool {
  exposedName: string
  serverName: string
  mcpName: string
  description: string
  inputSchema: Record<string, unknown>
}

interface ServerState {
  config: McpServerConfig
  client: Client | null
  status: McpServerStatus['status']
  error?: string
  tools: ExposedTool[]
  /** Attached at runtime (e.g. by the App Host), not part of the settings config — survives connectAll. */
  ephemeral?: boolean
}

// OpenAI caps tool names at 64 chars ([a-zA-Z0-9_-]); Anthropic allows 128.
const MAX_TOOL_NAME = 64
const MAX_RESULT_CHARS = 40_000

const slug = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x'

export class McpManager {
  private servers = new Map<string, ServerState>()
  private routes = new Map<string, { serverName: string; mcpName: string }>()

  /** (Re)connect every server in the config; previous config-backed connections are closed, ephemeral ones survive. */
  async connectAll(configs: McpServerConfig[]): Promise<void> {
    for (const [name, s] of [...this.servers]) {
      if (s.ephemeral) continue
      if (s.client) await s.client.close().catch(() => {})
      this.servers.delete(name)
    }
    const seen = new Set<string>()
    for (const cfg of configs) {
      if (!cfg?.name || seen.has(cfg.name) || this.servers.has(cfg.name)) continue
      seen.add(cfg.name)
      this.servers.set(cfg.name, { config: cfg, client: null, status: cfg.enabled ? 'connecting' : 'disabled', tools: [] })
    }
    await Promise.allSettled(
      [...this.servers.values()].filter((s) => s.config.enabled && s.status === 'connecting').map((s) => this.connectOne(s))
    )
    this.rebuildRoutes()
  }

  /** Attach a single server at runtime without disturbing the others. Replaces any same-named server. */
  async addServer(cfg: McpServerConfig, opts?: { ephemeral?: boolean }): Promise<McpServerStatus> {
    await this.removeServer(cfg.name)
    const state: ServerState = {
      config: cfg,
      client: null,
      status: cfg.enabled ? 'connecting' : 'disabled',
      tools: [],
      ephemeral: opts?.ephemeral
    }
    this.servers.set(cfg.name, state)
    if (cfg.enabled) await this.connectOne(state)
    this.rebuildRoutes()
    return {
      name: cfg.name,
      transport: cfg.transport,
      enabled: cfg.enabled,
      status: state.status,
      error: state.error,
      tools: state.tools.map((t) => ({ name: t.exposedName, description: t.description }))
    }
  }

  /** Detach a single server; no-op if it isn't registered. */
  async removeServer(name: string): Promise<void> {
    const state = this.servers.get(name)
    if (!state) return
    if (state.client) await state.client.close().catch(() => {})
    this.servers.delete(name)
    this.rebuildRoutes()
  }

  private async connectOne(state: ServerState): Promise<void> {
    const cfg = state.config
    try {
      const client = new Client({ name: 'atlis', version: '0.1.0' })
      client.onerror = () => {
        // transport-level failure after connect (server died); surface on next status read
        state.status = 'error'
        state.error = 'connection lost'
      }
      await client.connect(this.makeTransport(cfg))
      const tools: ExposedTool[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : {})
        for (const t of page.tools) {
          tools.push({
            exposedName: '', // assigned in rebuildRoutes (needs global collision view)
            serverName: cfg.name,
            mcpName: t.name,
            description: (t.description ?? '').slice(0, 1000) || `${t.name} (from MCP server "${cfg.name}")`,
            inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
          })
        }
        cursor = page.nextCursor
      } while (cursor)
      state.client = client
      state.tools = tools
      state.status = 'connected'
      state.error = undefined
    } catch (err) {
      state.client = null
      state.tools = []
      state.status = 'error'
      state.error = err instanceof Error ? err.message : String(err)
    }
  }

  private makeTransport(cfg: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
    if (cfg.transport === 'http') {
      if (!cfg.url) throw new Error('http server needs a url')
      return new StreamableHTTPClientTransport(new URL(cfg.url))
    }
    if (!cfg.command) throw new Error('stdio server needs a command')
    // The SDK spawns via cross-spawn, which resolves Windows .cmd shims (npx, uvx…).
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
      stderr: 'ignore'
    })
  }

  /** Assign collision-free exposed names across all connected servers. */
  private rebuildRoutes(): void {
    this.routes.clear()
    const used = new Set<string>()
    for (const state of this.servers.values()) {
      for (const tool of state.tools) {
        const base = `mcp__${slug(state.config.name)}__${slug(tool.mcpName)}`.slice(0, MAX_TOOL_NAME)
        let name = base
        for (let n = 2; used.has(name); n++) name = `${base.slice(0, MAX_TOOL_NAME - 3)}_${n}`
        used.add(name)
        tool.exposedName = name
        this.routes.set(name, { serverName: state.config.name, mcpName: tool.mcpName })
      }
    }
  }

  /** Provider-format specs for every connected MCP tool. */
  toolSpecs(): ToolSpec[] {
    const out: ToolSpec[] = []
    for (const state of this.servers.values()) {
      if (state.status !== 'connected') continue
      for (const t of state.tools) {
        out.push({ name: t.exposedName, description: t.description, parameters: t.inputSchema })
      }
    }
    return out
  }

  hasTool(name: string): boolean {
    return this.routes.has(name)
  }

  async call(exposedName: string, args: Record<string, unknown>): Promise<string> {
    const route = this.routes.get(exposedName)
    if (!route) return `Error: unknown MCP tool ${exposedName} (server may have disconnected).`
    const state = this.servers.get(route.serverName)
    if (!state?.client || state.status !== 'connected') return `Error: MCP server "${route.serverName}" is not connected.`
    try {
      const result = await state.client.callTool({ name: route.mcpName, arguments: args }, undefined, { timeout: 120_000 })
      const parts: string[] = []
      for (const item of (result.content ?? []) as { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string } }[]) {
        if (item.type === 'text') parts.push(item.text ?? '')
        else if (item.type === 'image') parts.push(`[image returned (${item.mimeType ?? 'unknown type'}) — not displayable in tool results yet]`)
        else if (item.type === 'resource') parts.push(item.resource?.text ?? `[resource: ${item.resource?.uri ?? 'unknown'}]`)
        else parts.push(`[${item.type} content]`)
      }
      let text = parts.join('\n').trim() || '(empty result)'
      if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated, ${text.length.toLocaleString()} chars total]`
      return result.isError ? `Tool error: ${text}` : text
    } catch (err) {
      return `Tool error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  statuses(): McpServerStatus[] {
    return [...this.servers.values()].map((s) => ({
      name: s.config.name,
      transport: s.config.transport,
      enabled: s.config.enabled,
      status: s.status,
      error: s.error,
      tools: s.tools.map((t) => ({ name: t.exposedName, description: t.description }))
    }))
  }

  async disposeAll(): Promise<void> {
    for (const s of this.servers.values()) {
      if (s.client) await s.client.close().catch(() => {})
    }
    this.servers.clear()
    this.routes.clear()
  }
}

/** Parse the settings-stored JSON config, tolerating hand-edited input. */
export function parseMcpConfig(json: string | null): McpServerConfig[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json) as unknown
    if (!Array.isArray(arr)) return []
    return (arr as McpServerConfig[]).filter((c) => c && typeof c.name === 'string' && (c.transport === 'stdio' || c.transport === 'http'))
  } catch {
    return []
  }
}
