import { useEffect, useMemo, useState } from 'react'
import { X, Check } from 'lucide-react'
import { fmtPrice, tradePlanHtml, saveDoc, log } from './api'

interface Props {
  open: boolean
  onClose: () => void
  symbol: string
  prefillEntry: number | null
  accountSize: number
  riskPct: number
  onAccountChange: (accountSize: number, riskPct: number) => void
  onSaved: () => void
}

export default function TradeCalculator({ open, onClose, symbol, prefillEntry, accountSize, riskPct, onAccountChange, onSaved }: Props) {
  const [acct, setAcct] = useState(String(accountSize))
  const [risk, setRisk] = useState(String(riskPct))
  const [entry, setEntry] = useState('')
  const [stop, setStop] = useState('')
  const [target, setTarget] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [reviewDate, setReviewDate] = useState('')
  const [alertAt, setAlertAt] = useState('')

  useEffect(() => { setAcct(String(accountSize)) }, [accountSize])
  useEffect(() => { setRisk(String(riskPct)) }, [riskPct])
  useEffect(() => { if (prefillEntry != null) setEntry(prefillEntry.toFixed(2)) }, [prefillEntry, symbol])

  const calc = useMemo(() => {
    const a = parseFloat(acct), r = parseFloat(risk), e = parseFloat(entry), s = parseFloat(stop), t = parseFloat(target)
    const riskUsd = isFinite(a) && isFinite(r) ? a * (r / 100) : null
    const perShareRisk = isFinite(e) && isFinite(s) ? Math.abs(e - s) : null
    const shares = riskUsd != null && perShareRisk && perShareRisk > 0 ? Math.floor(riskUsd / perShareRisk) : null
    const positionValue = shares != null && isFinite(e) ? shares * e : null
    const reward = isFinite(e) && isFinite(t) ? Math.abs(t - e) : null
    const rewardRisk = reward != null && perShareRisk && perShareRisk > 0 ? reward / perShareRisk : null
    const actualRisk = shares != null && perShareRisk != null ? shares * perShareRisk : null
    return { riskUsd, shares, positionValue, rewardRisk, actualRisk, e, s, t, a, r }
  }, [acct, risk, entry, stop, target])

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200) }

  const persistAccount = () => {
    const a = parseFloat(acct), r = parseFloat(risk)
    if (isFinite(a) && isFinite(r)) onAccountChange(a, r)
  }

  const ready = symbol && calc.shares != null && calc.shares > 0 && isFinite(calc.e) && isFinite(calc.s) && isFinite(calc.t)

  const saveTradePlan = async () => {
    if (!ready) return flash('Enter symbol, entry, stop and target first.')
    const plan = {
      symbol, entry: calc.e, stop: calc.s, target: calc.t, shares: calc.shares!,
      riskUsd: calc.actualRisk ?? calc.riskUsd ?? 0, rewardRisk: calc.rewardRisk,
      positionValue: calc.positionValue ?? 0, accountSize: calc.a, riskPct: calc.r
    }
    const dir = calc.t >= calc.e ? 'Long' : 'Short'
    const notes = `Entry $${fmtPrice(calc.e)} / Stop $${fmtPrice(calc.s)} / Target $${fmtPrice(calc.t)} / ${calc.shares} shares / Risk $${fmtPrice(plan.riskUsd)}${calc.rewardRisk ? ` / R:R ${calc.rewardRisk.toFixed(2)}:1` : ''}`
    const todo = await window.atlis.planner.todos.create({
      title: `Trade Plan: ${symbol} ${dir}`, notes, priority: 'normal', tags: ['finance', 'trade-plan', symbol]
    })
    const doc = await saveDoc(`Trade Plan — ${symbol} — ${new Date().toISOString().slice(0, 10)}`, tradePlanHtml(plan))
    log({ event: 'trade_plan', symbol, entry: calc.e, stop: calc.s, target: calc.t, shares: calc.shares, risk_usd: plan.riskUsd, todo_id: todo.id, doc_id: doc.id })
    onSaved()
    flash('Trade plan → To-Do + Document.')
  }

  const scheduleReview = async () => {
    if (!symbol) return flash('Pick a ticker first.')
    if (!reviewDate) return flash('Choose a review date.')
    const start = new Date(reviewDate + 'T09:00:00').getTime()
    const ev = await window.atlis.planner.events.create({
      title: `${symbol} Trade Review`, start_at: start, end_at: start + 30 * 60_000,
      notes: `Review ${symbol} position. ${ready ? `Entry $${fmtPrice(calc.e)} / Stop $${fmtPrice(calc.s)} / Target $${fmtPrice(calc.t)}.` : ''}`,
      tags: ['finance', symbol]
    })
    log({ event: 'review_scheduled', symbol, event_id: ev.id, at: start })
    onSaved()
    flash('Review scheduled on the calendar.')
  }

  const setAlert = async () => {
    if (!symbol) return flash('Pick a ticker first.')
    if (!alertAt) return flash('Choose an alert date/time.')
    const at = new Date(alertAt).getTime()
    const tgt = isFinite(calc.t) ? ` — approaching target $${fmtPrice(calc.t)}` : ''
    const r = await window.atlis.planner.reminders.create({ title: `Check ${symbol}${tgt}`, remind_at: at })
    log({ event: 'price_alert', symbol, reminder_id: r.id, at })
    onSaved()
    flash('Price alert reminder set.')
  }

  // Plain render helpers (not components) so inputs keep focus across keystrokes.
  const field = (label: string, value: string, set: (v: string) => void, prefix?: string) => (
    <label className="flex flex-col gap-1" key={label}>
      <span className="fin-sublabel">{label}</span>
      <span className="flex items-center gap-1">
        {prefix && <span className="text-[var(--fin-text-3)]">{prefix}</span>}
        <input className="fin-input w-full" value={value} onChange={(e) => set(e.target.value)} onBlur={persistAccount} inputMode="decimal" />
      </span>
    </label>
  )

  const out = (label: string, value: string, cls?: string) => (
    <div className="flex flex-col" key={label}>
      <span className="fin-sublabel">{label}</span>
      <span className={`fin-mono text-base font-semibold ${cls ?? ''}`}>{value}</span>
    </div>
  )

  return (
    <div
      className="fin-drawer absolute inset-x-0 bottom-0 z-20 border-t border-[var(--fin-amber)] bg-[var(--fin-bg-surface)] shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.7)]"
      style={{ transform: open ? 'translateY(0)' : 'translateY(110%)' }}
    >
      <div className="flex items-center gap-3 border-b border-[var(--fin-border)] px-4 py-2">
        <span className="fin-label">Trade Calculator</span>
        {symbol && <span className="fin-chip">{symbol}</span>}
        <div className="flex-1" />
        {toast && <span className="flex items-center gap-1 text-[11px] text-[var(--fin-positive)]"><Check size={12} /> {toast}</span>}
        <button onClick={onClose} className="text-[var(--fin-text-2)] hover:text-[var(--fin-text-1)]"><X size={16} /></button>
      </div>

      <div className="grid grid-cols-[repeat(5,1fr)_1.4fr] gap-3 px-4 py-3">
        {field('Account $', acct, setAcct, '$')}
        {field('Risk %', risk, setRisk)}
        {field('Entry', entry, setEntry, '$')}
        {field('Stop Loss', stop, setStop, '$')}
        {field('Target', target, setTarget, '$')}
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 fin-panel-box px-3 py-2">
          {out('Shares', calc.shares != null ? String(calc.shares) : '—', 'fin-amber')}
          {out('Risk $', calc.actualRisk != null ? '$' + fmtPrice(calc.actualRisk) : '—', 'fin-neg')}
          {out('Reward : Risk', calc.rewardRisk != null ? calc.rewardRisk.toFixed(2) + ':1' : '—', calc.rewardRisk != null && calc.rewardRisk >= 2 ? 'fin-pos' : '')}
          {out('Position $', calc.positionValue != null ? '$' + fmtPrice(calc.positionValue) : '—')}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2 border-t border-[var(--fin-border)] px-4 py-2.5">
        <button className="fin-btn fin-btn-amber" onClick={saveTradePlan} disabled={!ready}>Save as To-Do + Doc</button>
        <span className="mx-1 h-5 w-px bg-[var(--fin-border)]" />
        <label className="flex items-center gap-1.5">
          <span className="fin-sublabel">Review</span>
          <input type="date" className="fin-input" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} />
          <button className="fin-btn" onClick={scheduleReview}>Schedule</button>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="fin-sublabel">Alert</span>
          <input type="datetime-local" className="fin-input" value={alertAt} onChange={(e) => setAlertAt(e.target.value)} />
          <button className="fin-btn" onClick={setAlert}>Set Reminder</button>
        </label>
      </div>
    </div>
  )
}
