import { useEffect, useState } from 'react'
import type { Quote } from '../../types'
import {
  fmtPrice, fmtPct, dir, marketHours, SNAPSHOT_LABELS, type FearGreed, type ExchangeStatus
} from './api'

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[var(--fin-border)] px-3 py-2.5">
      <div className="fin-label mb-1.5">{label}</div>
      {children}
    </div>
  )
}

function MoverRow({ q, onPick }: { q: Quote; onPick: (s: string) => void }) {
  return (
    <button onClick={() => onPick(q.symbol)} className="flex w-full items-center justify-between py-0.5 text-left hover:text-[var(--fin-amber)]">
      <span className="fin-mono">{q.symbol}</span>
      <span className={`fin-mono ${dir(q.dayChangePct)}`}>{fmtPct(q.dayChangePct)}</span>
    </button>
  )
}

const dotColor = (s: ExchangeStatus['state']) =>
  s === 'open' ? 'var(--fin-positive)' : s === 'pre' ? 'var(--fin-amber)' : 'var(--fin-text-3)'

export default function MarketPulse({
  fearGreed, indices, snapshot, gainers, losers, onPick
}: {
  fearGreed: FearGreed | null
  indices: Quote[]
  snapshot: Quote[]
  gainers: Quote[]
  losers: Quote[]
  onPick: (s: string) => void
}) {
  const [hours, setHours] = useState<ExchangeStatus[]>(() => marketHours())
  useEffect(() => {
    const id = setInterval(() => setHours(marketHours()), 30_000)
    return () => clearInterval(id)
  }, [])

  const fgColor =
    !fearGreed ? 'var(--fin-text-3)'
      : fearGreed.score < 25 ? 'var(--fin-negative)'
      : fearGreed.score < 45 ? '#f59e0b'
      : fearGreed.score <= 55 ? '#eab308'
      : fearGreed.score <= 75 ? '#84cc16'
      : 'var(--fin-positive)'

  return (
    <aside className="flex w-[210px] shrink-0 flex-col overflow-y-auto border-r border-[var(--fin-border)] bg-[var(--fin-bg-surface)]">
      <Section label="Fear & Greed">
        {fearGreed ? (
          <>
            <div className="flex items-end justify-between">
              <span className="fin-mono text-2xl font-bold" style={{ color: fgColor }}>{fearGreed.score}</span>
              <span className="fin-sublabel" style={{ color: fgColor }}>{fearGreed.label}</span>
            </div>
            <div className="mt-1.5 h-1.5 w-full rounded-full" style={{ background: 'linear-gradient(90deg,#ef4444,#f59e0b,#eab308,#84cc16,#22c55e)' }}>
              <div className="relative h-full">
                <div className="absolute top-[-2px] h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-white" style={{ left: `${fearGreed.score}%`, background: fgColor }} />
              </div>
            </div>
            <div className="fin-sublabel mt-1.5">{fearGreed.breadthPct.toFixed(0)}% advancing{fearGreed.vix != null ? ` · VIX ${fmtPrice(fearGreed.vix)}` : ''}</div>
          </>
        ) : (
          <div className="fin-sublabel">computing…</div>
        )}
      </Section>

      <Section label="Breadth · Indices">
        {indices.length === 0 && <div className="fin-sublabel">—</div>}
        {indices.map((q) => {
          const pct = q.dayChangePct ?? 0
          const w = Math.min(50, Math.abs(pct) * 12)
          return (
            <div key={q.symbol} className="mb-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-[var(--fin-text-2)]">{q.shortName ?? q.symbol}</span>
                <span className={`fin-mono ${dir(pct)}`}>{fmtPct(q.dayChangePct)}</span>
              </div>
              <div className="mt-0.5 flex h-1 justify-center bg-[var(--fin-bg-base)]">
                <div className="h-full self-center" style={{ width: `${w}%`, marginLeft: pct < 0 ? 0 : '50%', marginRight: pct < 0 ? '50%' : 0, background: pct >= 0 ? 'var(--fin-positive)' : 'var(--fin-negative)' }} />
              </div>
            </div>
          )
        })}
      </Section>

      <Section label="Top Gainers">
        {gainers.length === 0 && <div className="fin-sublabel">—</div>}
        {gainers.map((q) => <MoverRow key={q.symbol} q={q} onPick={onPick} />)}
      </Section>
      <Section label="Top Losers">
        {losers.length === 0 && <div className="fin-sublabel">—</div>}
        {losers.map((q) => <MoverRow key={q.symbol} q={q} onPick={onPick} />)}
      </Section>

      <Section label="Global Snapshot">
        {snapshot.length === 0 && <div className="fin-sublabel">—</div>}
        {snapshot.map((q) => (
          <div key={q.symbol} className="flex items-center justify-between py-0.5">
            <span className="text-[10px] text-[var(--fin-text-2)]">{SNAPSHOT_LABELS[q.symbol] ?? q.symbol}</span>
            <span className="fin-mono">{fmtPrice(q.price)}</span>
            <span className={`fin-mono text-[10px] ${dir(q.dayChangePct)}`}>{fmtPct(q.dayChangePct)}</span>
          </div>
        ))}
      </Section>

      <Section label="Market Hours">
        {hours.map((h) => (
          <div key={h.code} className="flex items-center justify-between py-0.5">
            <span className="flex items-center gap-1.5">
              <span className="fin-dot" style={{ background: dotColor(h.state) }} />
              <span className="text-[10px] text-[var(--fin-text-1)]">{h.code}</span>
            </span>
            <span className="fin-mono text-[10px] text-[var(--fin-text-2)]">{h.localTime}</span>
            <span className="fin-sublabel" style={{ color: dotColor(h.state) }}>{h.state}</span>
          </div>
        ))}
      </Section>
    </aside>
  )
}
