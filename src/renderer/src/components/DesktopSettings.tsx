import { useEffect, useState } from 'react'
import { Camera, Check, MonitorSmartphone, Play, Plus, RefreshCw, Square, Trash2 } from 'lucide-react'
import type { DesktopAppConfig, DesktopStatus } from '../types'

/** Editable row shape: args as a raw string until save. */
interface Row {
  id: string
  name: string
  command: string
  args: string
  windowTitlePattern: string
  launchTimeoutSeconds: string
  enabled: boolean
}

const toRow = (c: DesktopAppConfig): Row => ({
  id: crypto.randomUUID(),
  name: c.name,
  command: c.command,
  args: (c.args ?? []).join(' '),
  windowTitlePattern: c.windowTitlePattern,
  launchTimeoutSeconds: c.launchTimeoutSeconds ? String(c.launchTimeoutSeconds) : '',
  enabled: c.enabled
})

const toConfig = (r: Row): DesktopAppConfig => ({
  name: r.name.trim(),
  command: r.command.trim(),
  args: r.args.trim() ? r.args.trim().split(/\s+/) : undefined,
  windowTitlePattern: r.windowTitlePattern.trim(),
  launchTimeoutSeconds: r.launchTimeoutSeconds.trim() ? Number(r.launchTimeoutSeconds) : undefined,
  enabled: r.enabled
})

const inputCls =
  'rounded border border-ink-600 bg-ink-800 px-2 py-1 font-mono text-[11.5px] text-mist-300 outline-none placeholder:text-mist-600 focus:border-volt-500'

export default function DesktopSettings() {
  const [rows, setRows] = useState<Row[]>([])
  const [statuses, setStatuses] = useState<DesktopStatus[]>([])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [shotFor, setShotFor] = useState<string | null>(null)
  const [shotSrc, setShotSrc] = useState<string | null>(null)

  useEffect(() => {
    window.atlis.desktop.getConfig().then((cfg) => setRows(cfg.map(toRow)))
    window.atlis.desktop.status().then(setStatuses)
  }, [])

  const patch = (id: string, p: Partial<Row>) => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...p } : r)))

  const refreshStatus = () => window.atlis.desktop.status().then(setStatuses)

  const save = async () => {
    setBusy(true)
    try {
      const configs = rows.map(toConfig).filter((c) => c.name && c.command && c.windowTitlePattern)
      setStatuses(await window.atlis.desktop.setConfig(configs))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setBusy(false)
    }
  }

  const showShot = async (name: string) => {
    setShotFor(name)
    setShotSrc(null)
    const r = await window.atlis.desktop.screenshot(name)
    setShotSrc(`data:${r.imageMime};base64,${r.imageBase64}`)
  }

  const statusFor = (name: string) => statuses.find((s) => s.name === name.trim())

  return (
    <section className="mt-4 rounded-lg border border-ink-600 bg-ink-800 p-5">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
        <MonitorSmartphone size={13} className="text-ember-400" /> Desktop
        <span className="font-normal normal-case tracking-normal text-mist-500">— existing apps the agent can see and drive like a human at the keyboard</span>
      </div>
      <p className="mb-3 text-[10.5px] text-mist-500">
        The agent screenshots the app's real window and clicks/types with real OS input — the window is brought to the foreground and the
        real cursor moves while it works, since background windows (Discord included) ignore simulated input. The window title pattern is a
        regex matched against currently open windows; if a match already exists it's reused instead of starting a new instance.
      </p>

      <div className="space-y-3">
        {rows.map((r) => {
          const st = statusFor(r.name)
          const tracked = st?.state === 'tracked'
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
                  placeholder="app name"
                  className={`w-32 ${inputCls}`}
                />
                {st && (
                  <span className="flex items-center gap-1.5" title={st.windowTitle}>
                    <span className={`h-2 w-2 rounded-full ${tracked ? 'bg-ok-400' : 'bg-mist-600'}`} />
                    <span className={`text-[10.5px] ${tracked ? 'text-ok-400' : 'text-mist-500'}`}>
                      {tracked ? `tracked${st.adopted ? ' (adopted)' : ''}` : 'stopped'}
                    </span>
                  </span>
                )}
                <div className="flex-1" />
                {tracked ? (
                  <button
                    onClick={async () => { setBusy(true); try { await window.atlis.desktop.stop(r.name.trim()); await refreshStatus() } finally { setBusy(false) } }}
                    className="flex items-center gap-1 rounded-md border border-ink-600 px-2 py-1 text-[10.5px] text-mist-300 hover:border-danger-400 hover:text-danger-400"
                  >
                    <Square size={10} /> Stop
                  </button>
                ) : (
                  <button
                    onClick={async () => { setBusy(true); try { await window.atlis.desktop.launch(r.name.trim()); await refreshStatus() } finally { setBusy(false) } }}
                    disabled={busy || !r.enabled || !r.name.trim()}
                    className="flex items-center gap-1 rounded-md border border-ink-600 px-2 py-1 text-[10.5px] text-mist-300 hover:border-ok-400 hover:text-ok-400 disabled:opacity-50"
                    title="Save first if you changed fields"
                  >
                    <Play size={10} /> Launch
                  </button>
                )}
                <button
                  onClick={() => showShot(r.name.trim())}
                  disabled={!tracked}
                  className="flex items-center gap-1 rounded-md border border-ink-600 px-2 py-1 text-[10.5px] text-mist-300 hover:border-volt-500 hover:text-volt-400 disabled:opacity-40"
                  title="Preview a screenshot (what the agent would see)"
                >
                  <Camera size={10} /> Preview
                </button>
                <button onClick={() => setRows((list) => list.filter((x) => x.id !== r.id))} className="text-mist-500 hover:text-danger-400" title="Remove app">
                  <Trash2 size={13} />
                </button>
              </div>

              <div className="mt-2 flex gap-2">
                <input
                  value={r.command}
                  onChange={(e) => patch(r.id, { command: e.target.value })}
                  placeholder="launch command — e.g. C:\Users\you\AppData\Local\Discord\app-1.0\Discord.exe"
                  className={`min-w-0 flex-1 ${inputCls}`}
                />
                <input
                  value={r.args}
                  onChange={(e) => patch(r.id, { args: e.target.value })}
                  placeholder="args (optional)"
                  className={`w-40 ${inputCls}`}
                />
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  value={r.windowTitlePattern}
                  onChange={(e) => patch(r.id, { windowTitlePattern: e.target.value })}
                  placeholder="window title regex — e.g. Discord$"
                  className={`min-w-0 flex-1 ${inputCls}`}
                />
                <input
                  value={r.launchTimeoutSeconds}
                  onChange={(e) => patch(r.id, { launchTimeoutSeconds: e.target.value })}
                  placeholder="timeout sec (default 20)"
                  className={`w-40 ${inputCls}`}
                />
              </div>

              {shotFor === r.name.trim() && (
                <div className="mt-2 rounded border border-ink-700 bg-ink-900 p-2">
                  {shotSrc ? (
                    <img src={shotSrc} alt="" className="max-h-72 w-full rounded object-contain" />
                  ) : (
                    <div className="flex items-center gap-2 py-6 text-[11px] text-mist-500">
                      <RefreshCw size={12} className="animate-spin" /> capturing…
                    </div>
                  )}
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
              { id: crypto.randomUUID(), name: '', command: '', args: '', windowTitlePattern: '', launchTimeoutSeconds: '', enabled: true }
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
