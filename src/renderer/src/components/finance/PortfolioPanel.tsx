import { useMemo, useState } from 'react'
import { Plus, Trash2, Save, ChevronDown, ChevronRight } from 'lucide-react'
import type { Holding, Quote } from '../../types'
import { fmtPrice, fmtCompact, dir, portfolioSnapshotHtml, saveDoc, log } from './api'

interface Props {
  holdings: Holding[]
  quotes: Record<string, Quote>
  onChange: (holdings: Holding[]) => void
  onPick: (symbol: string) => void
}

function heatColor(pct: number | null): string {
  if (pct == null) return 'var(--fin-bg-raised)'
  const c = Math.max(-1, Math.min(1, pct / 4)) // saturate at ±4%
  if (c >= 0) return `color-mix(in srgb, var(--fin-positive) ${Math.round(c * 75 + 12)}%, var(--fin-bg-raised))`
  return `color-mix(in srgb, var(--fin-negative) ${Math.round(-c * 75 + 12)}%, var(--fin-bg-raised))`
}

export default function PortfolioPanel({ holdings, quotes, onChange, onPick }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [sym, setSym] = useState('')
  const [sh, setSh] = useState('')
  const [cost, setCost] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  const stats = useMemo(() => {
    let totalValue = 0, dayPL = 0, totalReturn = 0, costBasis = 0
    for (const h of holdings) {
      const q = quotes[h.symbol]
      if (!q?.price) continue
      const value = q.price * h.shares
      totalValue += value
      costBasis += h.avg_cost * h.shares
      totalReturn += (q.price - h.avg_cost) * h.shares
      if (q.dayChange != null) dayPL += q.dayChange * h.shares
    }
    const dayPLPct = totalValue - dayPL !== 0 ? (dayPL / (totalValue - dayPL)) * 100 : null
    const totalReturnPct = costBasis ? (totalReturn / costBasis) * 100 : null
    return { totalValue, dayPL, dayPLPct, totalReturn, totalReturnPct }
  }, [holdings, quotes])

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2000) }

  const add = () => {
    const s = sym.trim().toUpperCase()
    const shares = parseFloat(sh), avg = parseFloat(cost)
    if (!s || !isFinite(shares) || !isFinite(avg)) return flash('Symbol, shares and cost required.')
    if (holdings.some((h) => h.symbol === s)) return flash('Already held — edit the row instead.')
    onChange([...holdings, { symbol: s, shares, avg_cost: avg, added: new Date().toISOString().slice(0, 10), notes: '' }])
    setSym(''); setSh(''); setCost('')
  }

  const patch = (symbol: string, p: Partial<Holding>) =>
    onChange(holdings.map((h) => (h.symbol === symbol ? { ...h, ...p } : h)))
  const remove = (symbol: string) => onChange(holdings.filter((h) => h.symbol !== symbol))

  const saveSnapshot = async () => {
    if (!holdings.length) return flash('No holdings to snapshot.')
    const qmap: Record<string, Quote> = {}
    for (const h of holdings) if (quotes[h.symbol]) qmap[h.symbol] = quotes[h.symbol]
    const doc = await saveDoc(`Portfolio Snapshot — ${new Date().toISOString().slice(0, 10)}`,
      portfolioSnapshotHtml({ holdings, quotes: qmap, totalValue: stats.totalValue, dayPL: stats.dayPL, totalReturn: stats.totalReturn }))
    log({ event: 'portfolio_snapshot', holdings: holdings.length, total_value: Math.round(stats.totalValue), doc_id: doc.id })
    flash('Snapshot saved to Documents.')
  }

  const scheduleWeekly = async () => {
    // Next Sunday 09:00 local.
    const d = new Date()
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7))
    d.setHours(9, 0, 0, 0)
    const ev = await window.atlis.planner.events.create({
      title: 'Weekly Portfolio Review', start_at: d.getTime(), end_at: d.getTime() + 30 * 60_000,
      notes: 'Review ATLIS portfolio: P&L, allocation, trade plans.', tags: ['finance', 'portfolio'], recurrence_rule: 'FREQ=WEEKLY'
    })
    log({ event: 'weekly_review_scheduled', event_id: ev.id, at: d.getTime() })
    flash('Weekly review on the calendar.')
  }

  const Stat = (label: string, value: string, cls?: string) => (
    <div className="flex flex-col" key={label}>
      <span className="fin-sublabel">{label}</span>
      <span className={`fin-mono text-sm font-semibold ${cls ?? ''}`}>{value}</span>
    </div>
  )

  return (
    <section className="fin-panel-box mt-3">
      <button onClick={() => setCollapsed((c) => !c)} className="flex w-full items-center gap-2 px-3 py-2">
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <span className="fin-label">Portfolio</span>
        <span className="fin-chip">{holdings.length}</span>
        <div className="flex-1" />
        {toast && <span className="text-[11px] text-[var(--fin-positive)]">{toast}</span>}
      </button>

      {!collapsed && (
        <div className="border-t border-[var(--fin-border)]">
          {/* stats ribbon */}
          <div className="flex flex-wrap items-center gap-6 border-b border-[var(--fin-border)] px-4 py-2.5">
            {Stat('Total Value', '$' + fmtPrice(stats.totalValue), 'fin-amber')}
            {Stat('Day P&L', `${stats.dayPL >= 0 ? '+' : ''}$${fmtPrice(Math.abs(stats.dayPL))}${stats.dayPLPct != null ? ` (${stats.dayPLPct.toFixed(2)}%)` : ''}`, dir(stats.dayPL))}
            {Stat('Total Return', `${stats.totalReturn >= 0 ? '+' : ''}$${fmtPrice(Math.abs(stats.totalReturn))}${stats.totalReturnPct != null ? ` (${stats.totalReturnPct.toFixed(2)}%)` : ''}`, dir(stats.totalReturn))}
            {Stat('Holdings', String(holdings.length))}
            <div className="flex-1" />
            <button className="fin-btn" onClick={scheduleWeekly}>Weekly Review</button>
            <button className="fin-btn fin-btn-amber" onClick={saveSnapshot}><Save size={11} className="mr-1 inline" />Snapshot</button>
          </div>

          {/* heatmap */}
          {holdings.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-[var(--fin-border)] px-4 py-3">
              {holdings.map((h) => {
                const q = quotes[h.symbol]
                const val = q?.price ? q.price * h.shares : 0
                const size = Math.max(64, Math.min(150, Math.sqrt(val) * 1.6))
                return (
                  <button key={h.symbol} onClick={() => onPick(h.symbol)}
                    className="flex flex-col items-center justify-center rounded border border-[var(--fin-border)] p-1"
                    style={{ width: size, height: size * 0.62, background: heatColor(q?.dayChangePct ?? null) }}>
                    <span className="fin-mono text-[12px] font-bold text-white">{h.symbol}</span>
                    <span className="fin-mono text-[10px] text-white/85">{q?.dayChangePct != null ? `${q.dayChangePct >= 0 ? '+' : ''}${q.dayChangePct.toFixed(2)}%` : '—'}</span>
                  </button>
                )
              })}
            </div>
          )}

          {/* holdings table */}
          <div className="overflow-x-auto px-2 py-2">
            <table className="w-full text-[11px]">
              <thead className="fin-sublabel">
                <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-left">
                  <th>Symbol</th><th>Shares</th><th>Avg Cost</th><th>Current</th><th>Value</th><th>Gain / Loss</th><th></th>
                </tr>
              </thead>
              <tbody className="fin-mono">
                {holdings.map((h) => {
                  const q = quotes[h.symbol]
                  const cur = q?.price ?? null
                  const value = cur != null ? cur * h.shares : null
                  const gl = cur != null ? (cur - h.avg_cost) * h.shares : null
                  const glPct = cur != null && h.avg_cost ? ((cur - h.avg_cost) / h.avg_cost) * 100 : null
                  return (
                    <tr key={h.symbol} className="border-t border-[var(--fin-border)] [&>td]:px-2 [&>td]:py-1">
                      <td><button className="font-bold text-[var(--fin-amber)]" onClick={() => onPick(h.symbol)}>{h.symbol}</button></td>
                      <td><input className="fin-input w-16" value={h.shares} onChange={(e) => patch(h.symbol, { shares: parseFloat(e.target.value) || 0 })} inputMode="decimal" /></td>
                      <td><input className="fin-input w-20" value={h.avg_cost} onChange={(e) => patch(h.symbol, { avg_cost: parseFloat(e.target.value) || 0 })} inputMode="decimal" /></td>
                      <td>{cur == null ? '—' : '$' + fmtPrice(cur)}</td>
                      <td>{value == null ? '—' : '$' + fmtCompact(value)}</td>
                      <td className={dir(gl)}>{gl == null ? '—' : `${gl >= 0 ? '+' : ''}$${fmtPrice(Math.abs(gl))}`}{glPct != null ? ` (${glPct.toFixed(1)}%)` : ''}</td>
                      <td><button onClick={() => remove(h.symbol)} className="text-[var(--fin-text-3)] hover:text-[var(--fin-negative)]"><Trash2 size={12} /></button></td>
                    </tr>
                  )
                })}
                <tr className="border-t border-[var(--fin-border)] [&>td]:px-2 [&>td]:py-1.5">
                  <td><input className="fin-input w-16" placeholder="SYM" value={sym} onChange={(e) => setSym(e.target.value)} /></td>
                  <td><input className="fin-input w-16" placeholder="0" value={sh} onChange={(e) => setSh(e.target.value)} inputMode="decimal" /></td>
                  <td><input className="fin-input w-20" placeholder="0.00" value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" /></td>
                  <td colSpan={4}><button className="fin-btn" onClick={add}><Plus size={11} className="mr-1 inline" />Add Holding</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
