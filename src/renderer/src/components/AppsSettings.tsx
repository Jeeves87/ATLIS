import { useEffect, useState } from 'react'
import { AppWindow, Check, FileText, Play, Plus, RefreshCw, Square, Trash2 } from 'lucide-react'
import type { AppConfig, AppStatus } from '../types'

/** Editable row shape: args/env as raw strings until save. */
interface Row {
  id: string
  name: string
  command: string
  args: string
  cwd: string
  env: string
  sandbox: 'fresh' | 'persistent'
  readyPattern: string
  healthUrl: string
  mcpUrl: string
  uiUrl: string
  enabled: boolean
}

const toRow = (c: AppConfig): Row => ({
  id: crypto.randomUUID(),
  name: c.name,
  command: c.command,
  args: (c.args ?? []).join(' '),
  cwd: c.cwd ?? '',
  env: Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`).join('; '),
  sandbox: c.sandbox === 'persistent' ? 'persistent' : 'fresh',
  readyPattern: c.readyPattern ?? '',
  healthUrl: c.healthUrl ?? '',
  mcpUrl: c.mcpUrl ?? '',
  uiUrl: c.uiUrl ?? '',
  enabled: c.enabled
})

const toConfig = (r: Row): AppConfig => ({
  name: r.name.trim(),
  command: r.command.trim(),
  args: r.args.trim() ? r.args.trim().split(/\s+/) : undefined,
  cwd: r.cwd.trim() || undefined,
  env: r.env.trim()
    ? Object.fromEntries(
        r.env.split(';').map((pair) => {
          const i = pair.indexOf('=')
          return i > 0 ? [pair.slice(0, i).trim(), pair.slice(i + 1).trim()] : ['', '']
        }).filter(([k]) => k)
      )
    : undefined,
  sandbox: r.sandbox,
  readyPattern: r.readyPattern.trim() || undefined,
  healthUrl: r.healthUrl.trim() || undefined,
  mcpUrl: r.mcpUrl.trim() || undefined,
  uiUrl: r.uiUrl.trim() || undefined,
  enabled: r.enabled
})

const STATE_STYLE: Record<AppStatus['state'], { dot: string; label: string }> = {
  running: { dot: 'bg-ok-400', label: 'text-ok-400' },
  starting: { dot: 'bg-ember-400 pulse-dot', label: 'text-ember-400' },
  exited: { dot: 'bg-danger-400', label: 'text-danger-400' },
  stopped: { dot: 'bg-mist-600', label: 'text-mist-500' }
}

const inputCls =
  'rounded border border-ink-600 bg-ink-800 px-2 py-1 font-mono text-[11.5px] text-mist-300 outline-none placeholder:text-mist-600 focus:border-volt-500'

export default function AppsSettings() {
  const [rows, setRows] = useState<Row[]>([])
  const [statuses, setStatuses] = useState<AppStatus[]>([])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [logText, setLogText] = useState('')

  useEffect(() => {
    window.atlis.apps.getConfig().then((cfg) => setRows(cfg.map(toRow)))
    window.atlis.apps.status().then(setStatuses)
    return window.atlis.apps.onChanged(() => window.atlis.apps.status().then(setStatuses))
  }, [])

  const patch = (id: string, p: Partial<Row>) => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...p } : r)))

  const save = async () => {
    setBusy(true)
    try {
      const configs = rows.map(toConfig).filter((c) => c.name && c.command)
      setStatuses(await window.atlis.apps.setConfig(configs))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setBusy(false)
    }
  }

  const showLogs = async (name: string) => {
    if (logsFor === name) {
      setLogsFor(null)
      return
    }
    setLogsFor(name)
    setLogText(await window.atlis.apps.logs(name))
  }

  const statusFor = (name: string) => statuses.find((s) => s.name === name.trim())

  return (
    <section className="mt-4 rounded-lg border border-ink-600 bg-ink-800 p-5">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
        <AppWindow size={13} className="text-pulse-400" /> Apps
        <span className="font-normal normal-case tracking-normal text-mist-500">— your applications, launched in a sandbox for agent-driven E2E testing</span>
      </div>
      <p className="mb-3 text-[10.5px] text-mist-500">
        Each launch gets a fresh sandbox directory (<span className="font-mono">ATLIS_SANDBOX_DIR</span>) and a free port
        (<span className="font-mono">PORT</span>, also substituted for <span className="font-mono">{'{port}'}</span> in args/URLs).
        If the app serves an MCP endpoint, its tools attach as <span className="font-mono">mcp__app-&lt;name&gt;__*</span>; the agent uses
        <span className="font-mono"> app_launch / app_logs / app_open_ui / app_stop</span>.
      </p>

      <div className="space-y-3">
        {rows.map((r) => {
          const st = statusFor(r.name)
          const style = st ? STATE_STYLE[st.state] : null
          const running = st?.state === 'running' || st?.state === 'starting'
          return (
            <div key={r.id} className="rounded-md border border-ink-600 bg-ink-900/60 p-3">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                  title="Enabled (launchable by you and the agent)"
                  className="accent-volt-500"
                />
                <input
                  value={r.name}
                  onChange={(e) => patch(r.id, { name: e.target.value })}
                  placeholder="app name"
                  className={`w-36 ${inputCls}`}
                />
                <select
                  value={r.sandbox}
                  onChange={(e) => patch(r.id, { sandbox: e.target.value as Row['sandbox'] })}
                  title="fresh = new sandbox dir per launch (deterministic E2E); persistent = one dir reused"
                  className="rounded border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-mist-300 outline-none focus:border-volt-500"
                >
                  <option value="fresh">fresh sandbox</option>
                  <option value="persistent">persistent</option>
                </select>
                {st && style && (
                  <span className="flex items-center gap-1.5" title={st.note ?? undefined}>
                    <span className={`h-2 w-2 rounded-full ${style.dot}`} />
                    <span className={`text-[10.5px] ${style.label}`}>
                      {st.state}
                      {st.port ? ` · :${st.port}` : ''}
                      {st.mcpServer ? ' · mcp' : ''}
                    </span>
                  </span>
                )}
                <div className="flex-1" />
                {running ? (
                  <button
                    onClick={() => window.atlis.apps.stop(r.name.trim())}
                    className="flex items-center gap-1 rounded-md border border-ink-600 px-2 py-1 text-[10.5px] text-mist-300 hover:border-danger-400 hover:text-danger-400"
                    title="Stop (kills the process tree)"
                  >
                    <Square size={10} /> Stop
                  </button>
                ) : (
                  <button
                    onClick={async () => {
                      setBusy(true)
                      try { await window.atlis.apps.launch(r.name.trim()) } finally { setBusy(false) }
                    }}
                    disabled={busy || !r.enabled || !r.name.trim()}
                    className="flex items-center gap-1 rounded-md border border-ink-600 px-2 py-1 text-[10.5px] text-mist-300 hover:border-ok-400 hover:text-ok-400 disabled:opacity-50"
                    title="Launch in a sandbox (save first if you changed fields)"
                  >
                    <Play size={10} /> Launch
                  </button>
                )}
                <button
                  onClick={() => showLogs(r.name.trim())}
                  className={`flex items-center gap-1 rounded-md border border-ink-600 px-2 py-1 text-[10.5px] hover:border-volt-500 hover:text-volt-400 ${logsFor === r.name.trim() ? 'text-volt-400' : 'text-mist-300'}`}
                  title="Show latest output"
                >
                  <FileText size={10} /> Logs
                </button>
                <button onClick={() => setRows((list) => list.filter((x) => x.id !== r.id))} className="text-mist-500 hover:text-danger-400" title="Remove app">
                  <Trash2 size={13} />
                </button>
              </div>

              <div className="mt-2 flex gap-2">
                <input
                  value={r.command}
                  onChange={(e) => patch(r.id, { command: e.target.value })}
                  placeholder="command — e.g. dotnet, npm, node, C:\path\to\app.exe"
                  className={`w-56 ${inputCls}`}
                />
                <input
                  value={r.args}
                  onChange={(e) => patch(r.id, { args: e.target.value })}
                  placeholder="args (space-separated) — e.g. run --urls http://127.0.0.1:{port}"
                  className={`min-w-0 flex-1 ${inputCls}`}
                />
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  value={r.cwd}
                  onChange={(e) => patch(r.id, { cwd: e.target.value })}
                  placeholder="working dir (the app's project folder) — defaults to the sandbox dir"
                  className={`min-w-0 flex-1 ${inputCls}`}
                />
                <input
                  value={r.env}
                  onChange={(e) => patch(r.id, { env: e.target.value })}
                  placeholder="env vars (optional) — KEY=value; OTHER=value"
                  className={`min-w-0 flex-1 ${inputCls}`}
                />
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  value={r.readyPattern}
                  onChange={(e) => patch(r.id, { readyPattern: e.target.value })}
                  placeholder="ready regex on output (optional) — e.g. Now listening on"
                  className={`min-w-0 flex-1 ${inputCls}`}
                />
                <input
                  value={r.healthUrl}
                  onChange={(e) => patch(r.id, { healthUrl: e.target.value })}
                  placeholder="…or health URL — e.g. http://127.0.0.1:{port}/health"
                  className={`min-w-0 flex-1 ${inputCls}`}
                />
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  value={r.mcpUrl}
                  onChange={(e) => patch(r.id, { mcpUrl: e.target.value })}
                  placeholder="MCP endpoint (optional) — e.g. http://127.0.0.1:{port}/mcp"
                  className={`min-w-0 flex-1 ${inputCls}`}
                />
                <input
                  value={r.uiUrl}
                  onChange={(e) => patch(r.id, { uiUrl: e.target.value })}
                  placeholder="UI URL (optional) — e.g. http://127.0.0.1:{port}"
                  className={`min-w-0 flex-1 ${inputCls}`}
                />
              </div>

              {logsFor === r.name.trim() && (
                <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-[10.5px] text-mist-400">
                  {logText || '(no output)'}
                </pre>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() =>
            setRows((list) => [
              ...list,
              {
                id: crypto.randomUUID(),
                name: '',
                command: '',
                args: '',
                cwd: '',
                env: '',
                sandbox: 'fresh',
                readyPattern: '',
                healthUrl: '',
                mcpUrl: '',
                uiUrl: '',
                enabled: true
              }
            ])
          }
          className="flex items-center gap-1 rounded-md border border-dashed border-ink-500 px-3 py-1.5 text-[11px] text-mist-400 hover:border-volt-500/60 hover:text-mist-200"
        >
          <Plus size={12} /> Add app
        </button>
        <div className="flex-1" />
        <button
          onClick={save}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md border border-volt-500/60 bg-volt-500/15 px-3 py-1.5 text-[11px] text-volt-400 hover:bg-volt-500/25 disabled:opacity-50"
        >
          {saved ? <Check size={12} className="text-ok-400" /> : busy ? <RefreshCw size={12} className="animate-spin" /> : null}
          Save
        </button>
      </div>
    </section>
  )
}
