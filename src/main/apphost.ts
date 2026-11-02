import { spawn, type ChildProcess } from 'child_process'
import { createServer, type AddressInfo } from 'net'
import { promises as fsp } from 'fs'
import { join, resolve } from 'path'
import { McpManager, type McpServerConfig } from './mcp'

/**
 * App Host: launches the user's own applications as managed child processes
 * for agent-driven E2E testing. Each launch gets a sandbox run directory
 * (fresh per run by default, so tests start from known state), a free port,
 * a rolling output buffer, and — once the app reports ready — its MCP
 * endpoint auto-connected so the app's tools appear as mcp__app-<name>__*.
 * Kept free of electron imports (like McpManager) so it can be exercised
 * from plain Node scripts.
 */

export interface AppConfig {
  name: string
  command: string // executable or shim (dotnet, npm, node, path to exe)
  args?: string[]
  cwd?: string // where to run from (the app's project dir); defaults to the sandbox run dir
  env?: Record<string, string>
  sandbox: 'fresh' | 'persistent' // fresh = new run dir per launch
  readyPattern?: string // regex on stdout/stderr meaning "app is up"
  healthUrl?: string //   …or poll this URL until 2xx
  mcpUrl?: string // app's MCP endpoint, connected once ready
  uiUrl?: string // opened in the embedded browser by app_open_ui
  readyTimeoutSeconds?: number
  enabled: boolean
}

export interface AppStatus {
  name: string
  state: 'stopped' | 'starting' | 'running' | 'exited'
  enabled: boolean
  pid?: number
  port?: number
  runDir?: string
  uiUrl?: string
  mcpServer?: string
  startedAt?: number
  exitCode?: number | null
  note?: string
}

interface RunningApp {
  config: AppConfig
  proc: ChildProcess
  port: number
  runDir: string
  uiUrl?: string
  mcpServer?: string
  output: string
  state: 'starting' | 'running' | 'exited'
  exitCode: number | null
  startedAt: number
  watchers: { pattern: RegExp; resolve: (line: string) => void }[]
  note?: string
}

const MAX_BUFFER = 200_000
const DEFAULT_READY_TIMEOUT_MS = 45_000
const KEEP_RUN_DIRS = 5

function clip(s: string, max = MAX_BUFFER): string {
  return s.length > max ? `…[${(s.length - max).toLocaleString()} chars trimmed]\n${s.slice(-max)}` : s
}

const dirSlug = (s: string): string => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'app'

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolvePromise(port))
    })
  })
}

export class AppHostManager {
  private configs: AppConfig[] = []
  private running = new Map<string, RunningApp>()

  constructor(
    private baseDir: string, // e.g. <userData>/apps — run dirs live under it
    private mcp: McpManager,
    private notify: () => void = () => {}
  ) {}

  setConfigs(configs: AppConfig[]): void {
    this.configs = configs.filter((c) => c && typeof c.name === 'string' && c.name.trim() && typeof c.command === 'string')
  }

  getConfigs(): AppConfig[] {
    return this.configs
  }

  /** Substitute launch-time placeholders in a config string. */
  private subst(s: string, port: number, runDir: string): string {
    return s.replace(/\{port\}/g, String(port)).replace(/\{sandbox\}/g, runDir)
  }

  private async prepareRunDir(cfg: AppConfig): Promise<string> {
    const appDir = join(this.baseDir, dirSlug(cfg.name))
    if (cfg.sandbox === 'persistent') {
      const dir = join(appDir, 'persistent')
      await fsp.mkdir(dir, { recursive: true })
      return dir
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dir = join(appDir, `run-${stamp}-${Math.random().toString(36).slice(2, 6)}`)
    await fsp.mkdir(dir, { recursive: true })
    // Keep recent runs for post-mortem, prune the rest (best-effort).
    fsp.readdir(appDir).then(async (names) => {
      const runs = names.filter((n) => n.startsWith('run-')).sort()
      for (const old of runs.slice(0, Math.max(0, runs.length - KEEP_RUN_DIRS))) {
        await fsp.rm(join(appDir, old), { recursive: true, force: true }).catch(() => {})
      }
    }).catch(() => {})
    return dir
  }

  /** Block until the app looks ready: output pattern, healthy URL, or a grace delay. */
  private async waitReady(entry: RunningApp): Promise<string> {
    const cfg = entry.config
    const timeoutMs = Math.min(Math.max((cfg.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_MS / 1000) * 1000, 1000), 300_000)
    const deadline = Date.now() + timeoutMs

    if (cfg.readyPattern) {
      let re: RegExp
      try {
        re = new RegExp(cfg.readyPattern, 'i')
      } catch {
        return `ready_pattern is not a valid regex — treating the app as ready`
      }
      const existing = entry.output.match(re)
      if (existing) return `ready (matched "${existing[0]}")`
      const matched = await new Promise<string>((resolvePromise) => {
        const watcher = { pattern: re, resolve: resolvePromise }
        entry.watchers.push(watcher)
        setTimeout(() => {
          const idx = entry.watchers.indexOf(watcher)
          if (idx >= 0) {
            entry.watchers.splice(idx, 1)
            resolvePromise('__TIMEOUT__')
          }
        }, timeoutMs)
      })
      if (matched === '__TIMEOUT__') return `no ready signal within ${Math.round(timeoutMs / 1000)}s (pattern /${cfg.readyPattern}/) — the process is still running; check app_logs`
      if (matched === '') return `process exited before becoming ready`
      return `ready (matched "${matched}")`
    }

    if (cfg.healthUrl) {
      const url = this.subst(cfg.healthUrl, entry.port, entry.runDir)
      while (Date.now() < deadline) {
        if (entry.state === 'exited') return 'process exited before becoming ready'
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
          if (res.ok) return `ready (healthy at ${url})`
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 700))
      }
      return `no healthy response from ${url} within ${Math.round(timeoutMs / 1000)}s — the process is still running; check app_logs`
    }

    // No ready signal configured: short grace period, then assume up if alive.
    await new Promise((r) => setTimeout(r, 1500))
    return entry.state === 'exited' ? 'process exited immediately' : 'assumed ready (no ready_pattern or health_url configured)'
  }

  async launch(name: string): Promise<string> {
    const cfg = this.configs.find((c) => c.name === name)
    if (!cfg) {
      const known = this.configs.map((c) => c.name).join(', ') || '(none configured — add apps in Settings)'
      return `Error: no app named "${name}". Known apps: ${known}`
    }
    if (!cfg.enabled) return `Error: app "${name}" is disabled in Settings.`
    const existing = this.running.get(name)
    if (existing && existing.state !== 'exited') return `App "${name}" is already ${existing.state} (pid ${existing.proc.pid}). Stop it first to relaunch.`

    const port = await freePort()
    const runDir = await this.prepareRunDir(cfg)
    const args = (cfg.args ?? []).map((a) => this.subst(a, port, runDir))
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...Object.fromEntries(Object.entries(cfg.env ?? {}).map(([k, v]) => [k, this.subst(v, port, runDir)])),
      PORT: String(port),
      ATLIS_APP_PORT: String(port),
      ATLIS_SANDBOX_DIR: runDir
    }
    // shell:true so Windows shims (npm.cmd, npx.cmd, dotnet on PATH) resolve;
    // taskkill /T later kills the shell's whole tree. The shell does NOT quote
    // for us, so build the command line with paths-with-spaces quoted.
    const q = (s: string) => (/[\s&|<>()^]/.test(s) ? `"${s}"` : s)
    const commandLine = [q(this.subst(cfg.command, port, runDir)), ...args.map(q)].join(' ')
    const proc = spawn(commandLine, {
      cwd: cfg.cwd ? resolve(this.subst(cfg.cwd, port, runDir)) : runDir,
      env,
      windowsHide: true,
      shell: true
    })

    const entry: RunningApp = {
      config: cfg,
      proc,
      port,
      runDir,
      uiUrl: cfg.uiUrl ? this.subst(cfg.uiUrl, port, runDir) : undefined,
      output: '',
      state: 'starting',
      exitCode: null,
      startedAt: Date.now(),
      watchers: []
    }
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      entry.output = clip(entry.output + text)
      for (let i = entry.watchers.length - 1; i >= 0; i--) {
        const w = entry.watchers[i]
        const m = text.match(w.pattern)
        if (m) {
          entry.watchers.splice(i, 1)
          w.resolve(m[0])
        }
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (err) => {
      entry.output = clip(`${entry.output}\n[spawn error: ${err.message}]`)
    })
    proc.on('exit', (code) => {
      entry.state = 'exited'
      entry.exitCode = code
      for (const w of entry.watchers.splice(0)) w.resolve('')
      if (entry.mcpServer) {
        const server = entry.mcpServer
        entry.mcpServer = undefined
        void this.mcp.removeServer(server).then(() => this.notify())
      }
      this.notify()
    })
    this.running.set(name, entry)
    this.notify()

    const readyNote = await this.waitReady(entry)
    entry.note = readyNote
    if (entry.state === 'exited') {
      this.notify()
      return `App "${name}" exited during startup (code ${entry.exitCode}).\n--- output ---\n${clip(entry.output, 4000) || '(no output)'}`
    }
    entry.state = 'running'

    let mcpNote = ''
    if (cfg.mcpUrl) {
      const serverName = `app-${dirSlug(cfg.name)}`
      const mcpConfig: McpServerConfig = { name: serverName, transport: 'http', url: this.subst(cfg.mcpUrl, port, runDir), enabled: true }
      const status = await this.mcp.addServer(mcpConfig, { ephemeral: true })
      if (status.status === 'connected') {
        entry.mcpServer = serverName
        mcpNote = `\nMCP connected: ${status.tools.length} tool(s) now available as mcp__${serverName}__* (visible from your next turn).`
      } else {
        await this.mcp.removeServer(serverName)
        mcpNote = `\nMCP endpoint ${mcpConfig.url} did not connect: ${status.error ?? 'unknown error'}. App is still running; fix and relaunch, or use app_logs.`
      }
    }
    this.notify()
    const ui = entry.uiUrl ? `\nUI: ${entry.uiUrl} (use app_open_ui to show it in the embedded browser).` : ''
    return `Launched "${name}" (pid ${proc.pid}) — ${readyNote}.\nPort: ${port}\nSandbox: ${runDir}${ui}${mcpNote}`
  }

  async stop(name: string): Promise<string> {
    const entry = this.running.get(name)
    if (!entry) return `Error: app "${name}" is not running.`
    if (entry.mcpServer) {
      await this.mcp.removeServer(entry.mcpServer)
      entry.mcpServer = undefined
    }
    if (entry.state !== 'exited' && entry.proc.pid) {
      spawn('taskkill', ['/pid', String(entry.proc.pid), '/T', '/F'], { windowsHide: true })
      entry.state = 'exited'
    }
    this.running.delete(name)
    this.notify()
    return `Stopped "${name}". Sandbox kept at ${entry.runDir} for inspection.`
  }

  logs(name: string, tailChars = 6000): string {
    const entry = this.running.get(name)
    if (!entry) return `Error: app "${name}" is not running (logs are kept only while an app is running or since it exited this session).`
    const status = entry.state === 'exited' ? `exited (code ${entry.exitCode})` : entry.state
    const out = entry.output.slice(-Math.min(Math.max(tailChars, 200), 40_000))
    return `[${name}] ${status} — pid ${entry.proc.pid}, port ${entry.port}\nsandbox: ${entry.runDir}\n--- output ---\n${out || '(no output yet)'}`
  }

  uiUrlFor(name: string): string | null {
    return this.running.get(name)?.uiUrl ?? null
  }

  statuses(): AppStatus[] {
    return this.configs.map((cfg) => {
      const r = this.running.get(cfg.name)
      if (!r) return { name: cfg.name, state: 'stopped', enabled: cfg.enabled }
      return {
        name: cfg.name,
        state: r.state === 'starting' ? 'starting' : r.state === 'exited' ? 'exited' : 'running',
        enabled: cfg.enabled,
        pid: r.proc.pid,
        port: r.port,
        runDir: r.runDir,
        uiUrl: r.uiUrl,
        mcpServer: r.mcpServer,
        startedAt: r.startedAt,
        exitCode: r.exitCode,
        note: r.note
      }
    })
  }

  /** Agent-facing summary of configured apps and their live state. */
  statusText(): string {
    if (!this.configs.length) return 'No apps configured. The user can add launchable apps in Settings → Apps.'
    return this.statuses()
      .map((s) => {
        const bits = [s.state, s.pid ? `pid ${s.pid}` : '', s.port ? `port ${s.port}` : '', s.mcpServer ? `tools: mcp__${s.mcpServer}__*` : '', s.note ?? '']
        return `- ${s.name}${s.enabled ? '' : ' (disabled)'}: ${bits.filter(Boolean).join(' · ')}`
      })
      .join('\n')
  }

  disposeAll(): void {
    for (const entry of this.running.values()) {
      if (entry.state !== 'exited' && entry.proc.pid) {
        spawn('taskkill', ['/pid', String(entry.proc.pid), '/T', '/F'], { windowsHide: true })
      }
    }
    this.running.clear()
  }
}

/** Parse the settings-stored JSON config, tolerating hand-edited input. */
export function parseAppConfig(json: string | null): AppConfig[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json) as unknown
    if (!Array.isArray(arr)) return []
    return (arr as AppConfig[])
      .filter((c) => c && typeof c.name === 'string' && c.name.trim() && typeof c.command === 'string')
      .map((c) => ({ ...c, sandbox: c.sandbox === 'persistent' ? 'persistent' : 'fresh' }))
  } catch {
    return []
  }
}
