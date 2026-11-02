import { Globe, Minus, Plus, Zap } from 'lucide-react'
import { useAtlis } from '../state/store'
import { fmtTokens, fmtUsd, fmtWh } from '../lib/format'
import { useUiZoom } from '../lib/useUiZoom'

export default function TitleBar() {
  const { liveUsage, browserOpen, setBrowserOpen, runningSessions } = useAtlis()
  const { zoom, setZoom, step } = useUiZoom()

  return (
    <header className="titlebar-drag flex h-10 shrink-0 items-center gap-4 border-b border-ink-600 bg-ink-900 pl-4 pr-[150px] select-none">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded bg-volt-500 glow-volt">
          <Zap size={12} strokeWidth={2.5} className="text-white" />
        </div>
        <span className="text-[13px] font-bold tracking-[0.28em] text-mist-100">ATLIS</span>
        <span className="text-[10px] uppercase tracking-widest text-mist-500">Agentic Studio</span>
      </div>

      <div className="flex-1" />

      {runningSessions.size > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-pulse-400">
          <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-pulse-400" />
          {runningSessions.size} agent{runningSessions.size > 1 ? 's' : ''} running
        </div>
      )}

      <div className="flex items-center gap-3 font-mono text-[11px] text-mist-400" title="Tokens · cost · energy this app session">
        <span>{fmtTokens(liveUsage.tokens)} tok</span>
        <span className="text-ember-400">{fmtUsd(liveUsage.cost)}</span>
        <span className="text-ok-400">{fmtWh(liveUsage.energy)}</span>
      </div>

      {/* Interface scale — always in reach, since the moment you need it is
          the moment everything is too small to go looking in Settings. */}
      <div
        className="titlebar-nodrag flex items-center overflow-hidden rounded border border-ink-600 text-[11px] text-mist-400"
        title="Interface size — Ctrl + / Ctrl − / Ctrl 0, or Ctrl + mouse wheel"
      >
        <button onClick={() => step(-1)} className="px-1.5 py-0.5 hover:bg-ink-700 hover:text-mist-100" aria-label="Smaller">
          <Minus size={11} />
        </button>
        <button
          onClick={() => setZoom(1)}
          className="min-w-[3.25rem] border-x border-ink-600 px-1 py-0.5 font-mono tabular-nums hover:bg-ink-700 hover:text-mist-100"
          title="Reset to 100%"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => step(1)} className="px-1.5 py-0.5 hover:bg-ink-700 hover:text-mist-100" aria-label="Larger">
          <Plus size={11} />
        </button>
      </div>

      <button
        onClick={() => setBrowserOpen(!browserOpen)}
        className={`titlebar-nodrag flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] transition-colors ${
          browserOpen
            ? 'border-volt-500 bg-volt-500/15 text-volt-400'
            : 'border-ink-600 text-mist-400 hover:border-mist-500 hover:text-mist-300'
        }`}
      >
        <Globe size={12} />
        Browser
      </button>
    </header>
  )
}
