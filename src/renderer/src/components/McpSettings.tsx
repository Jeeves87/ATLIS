import { useEffect, useState } from 'react'
import { Check, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { McpServerConfig, McpServerStatus } from '../types'

/** Editable row shape: args/env as raw strings until save. */
interface Row {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string
  env: string
  url: string
  enabled: boolean
}

const toRow = (c: McpServerConfig): Row => ({
  id: crypto.randomUUID(),
  name: c.name,
  transport: c.transport,
  command: c.command ?? '',
  args: (c.args ?? []).join(' '),
  env: Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`).join('; '),
  url: c.url ?? '',
  enabled: c.enabled
})

const toConfig = (r: Row): McpServerConfig => ({
  name: r.name.trim(),
  transport: r.transport,
  command: r.command.trim() || undefined,
  args: r.args.trim() ? r.args.trim().split(/\s+/) : undefined,
  env: r.env.trim()
    ? Object.fromEntries(
        r.env.split(';').map((pair) => {
          const i = pair.indexOf('=')
          return i > 0 ? [pair.slice(0, i).trim(), pair.slice(i + 1).trim()] : ['', '']
        }).filter(([k]) => k)
      )
    : undefined,
  url: r.url.trim() || undefined,
  enabled: r.enabled
})

const STATUS_STYLE: Record<McpServerStatus['status'], { dot: string; label: string }> = {
  connected: { dot: 'bg-ok-400', label: 'text-ok-400' },
  connecting: { dot: 'bg-ember-400 pulse-dot', label: 'text-ember-400' },
  error: { dot: 'bg-danger-400', label: 'text-danger-400' },
  disabled: { dot: 'bg-mist-600', label: 'text-mist-500' }
}

export default function McpSettings() {
  const [rows, setRows] = useState<Row[]>([])
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    window.atlis.mcp.getConfig().then((cfg) => setRows(cfg.map(toRow)))
    window.atlis.mcp.status().then(setStatuses)
    return window.atlis.mcp.onChanged(() => window.atlis.mcp.status().then(setStatuses))
  }, [])

  const patch = (id: string, p: Partial<Row>) => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...p } : r)))

  const save = async () => {
    setBusy(true)
    try {
      const configs = rows.map(toConfig).filter((c) => c.name)
      setStatuses(await window.atlis.mcp.setConfig(configs))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setBusy(false)
    }
  }

  const statusFor = (name: string) => statuses.find((s) => s.name === name.trim())

  return (
    <section className="mt-4 rounded-lg border border-ink-600 bg-ink-800 p-5">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
        <Plug size={13} className="text-ok-400" /> MCP servers
        <span className="font-normal normal-case tracking-normal text-mist-500">— external tools for the agent (Model Context Protocol)</span>
        <div className="flex-1" />
        <button
          onClick={async () => {
            setBusy(true)
            try { setStatuses(await window.atlis.mcp.reload()) } finally { setBusy(false) }
          }}
          disabled={busy}
          title="Reconnect all servers"
          className="flex items-center gap-1 rounded-md border border-ink-600 px-2 py-1 text-[10.5px] normal-case tracking-normal text-mist-300 hover:border-volt-500 hover:text-volt-400 disabled:opacity-50"
        >
          <RefreshCw size={11} className={busy ? 'animate-spin' : ''} /> Reconnect
        </button>
      </div>
      <p className="mb-3 text-[10.5px] text-mist-500">
        Connected servers' tools appear to agentic sessions as <span className="font-mono">mcp__&lt;server&gt;__&lt;tool&gt;</span>. stdio runs a local
        command (e.g. <span className="font-mono">npx -y @modelcontextprotocol/server-everything</span>); http connects to a running endpoint.
      </p>

      <div className="space-y-3">
        {rows.map((r) => {
          const st = statusFor(r.name)
          const style = st ? STATUS_STYLE[st.status] : null
          return (
            <div key={r.id} className="rounded-md border border-ink-600 bg-ink-900/60 p-3">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                  title="Enabled"
                  className="accent-volt-500"
                />
                <input
                  value={r.name}
                  onChange={(e) => patch(r.id, { name: e.target.value })}
                  placeholder="server name"
                  className="w-36 rounded border border-ink-600 bg-ink-800 px-2 py-1 text-[12px] outline-none focus:border-volt-500"
                />
                <select
                  value={r.transport}
                  onChange={(e) => patch(r.id, { transport: e.target.value as Row['transport'] })}
                  className="rounded border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-mist-300 outline-none focus:border-volt-500"
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                </select>
                {st && style && (
                  <button
                    onClick={() => setExpanded(expanded === r.name ? null : r.name)}
                    className="flex items-center gap-1.5"
                    title={st.error ?? `${st.tools.length} tools — click to list`}
                  >
                    <span className={`h-2 w-2 rounded-full ${style.dot}`} />
                    <span className={`text-[10.5px] ${style.label}`}>
                      {st.status}{st.status === 'connected' ? ` · ${st.tools.length} tools` : ''}
                    </span>
                  </button>
                )}
                <div className="flex-1" />
                <button onClick={() => setRows((list) => list.filter((x) => x.id !== r.id))} className="text-mist-500 hover:text-danger-400" title="Remove server">
                  <Trash2 size={13} />
                </button>
              </div>

              {r.transport === 'stdio' ? (
                <div className="mt-2 flex gap-2">
                  <input
                    value={r.command}
                    onChange={(e) => patch(r.id, { command: e.target.value })}
                    placeholder="command — e.g. npx"
                    className="w-40 rounded border border-ink-600 bg-ink-800 px-2 py-1 font-mono text-[11.5px] text-mist-300 outline-none focus:border-volt-500"
                  />
                  <input
                    value={r.args}
                    onChange={(e) => patch(r.id, { args: e.target.value })}
                    placeholder="args (space-separated) — e.g. -y @modelcontextprotocol/server-everything"
                    className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-800 px-2 py-1 font-mono text-[11.5px] text-mist-300 outline-none placeholder:text-mist-600 focus:border-volt-500"
                  />
                </div>
              ) : (
                <input
                  value={r.url}
                  onChange={(e) => patch(r.id, { url: e.target.value })}
                  placeholder="endpoint url — e.g. http://localhost:8080/mcp"
                  className="mt-2 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1 font-mono text-[11.5px] text-mist-300 outline-none placeholder:text-mist-600 focus:border-volt-500"
                />
              )}
              {r.transport === 'stdio' && (
                <input
                  value={r.env}
                  onChange={(e) => patch(r.id, { env: e.target.value })}
                  placeholder="env vars (optional) — KEY=value; OTHER_KEY=value"
                  className="mt-2 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1 font-mono text-[11.5px] text-mist-300 outline-none placeholder:text-mist-600 focus:border-volt-500"
                />
              )}

              {expanded === r.name && st && st.tools.length > 0 && (
                <div className="mt-2 max-h-40 overflow-y-auto rounded border border-ink-700 bg-ink-900 px-2 py-1.5">
                  {st.tools.map((t) => (
                    <div key={t.name} className="py-0.5">
                      <span className="font-mono text-[10.5px] text-pulse-400">{t.name}</span>
                      <span className="ml-2 text-[10.5px] text-mist-500">{t.description.slice(0, 120)}</span>
                    </div>
                  ))}
                </div>
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
              { id: crypto.randomUUID(), name: '', transport: 'stdio', command: 'npx', args: '', env: '', url: '', enabled: true }
            ])
          }
          className="flex items-center gap-1 rounded-md border border-dashed border-ink-500 px-3 py-1.5 text-[11px] text-mist-400 hover:border-volt-500/60 hover:text-mist-200"
        >
          <Plus size={12} /> Add server
        </button>
        <div className="flex-1" />
        <button
          onClick={save}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md border border-volt-500/60 bg-volt-500/15 px-3 py-1.5 text-[11px] text-volt-400 hover:bg-volt-500/25 disabled:opacity-50"
        >
          {saved ? <Check size={12} className="text-ok-400" /> : busy ? <RefreshCw size={12} className="animate-spin" /> : null}
          Save &amp; connect
        </button>
      </div>
    </section>
  )
}
