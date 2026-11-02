/**
 * The engine is blocked on a question: choose targets, pick a mode, order
 * triggers, confirm an optional cost. The answer goes straight back to Forge,
 * which validates it — this dialog only enforces the min/max Forge asked for.
 */
import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Minus, Plus } from 'lucide-react'
import GameCardView from './GameCardView'
import type { GameCard, GameRequest, GameState } from '../../../types'

export default function RequestDialog({
  req, state, onAnswer, onHover
}: {
  req: GameRequest
  state: GameState | null
  onAnswer: (rid: number, value: unknown) => void
  onHover: (c: GameCard | null) => void
}): React.JSX.Element {
  const opts = req.options ?? []
  const [picked, setPicked] = useState<number[]>([])
  const [order, setOrder] = useState<number[]>(() => opts.map((o) => o.i))
  const [text, setText] = useState(req.initial ?? '')
  // assign: how much of the total goes to each option.
  const [split, setSplit] = useState<number[]>(() => opts.map(() => (req.atLeastOne ? 1 : 0)))
  // Long lists (a whole library during a search) get a name filter.
  const [filter, setFilter] = useState('')
  const cardOf = (id?: number): GameCard | null => (id != null && state ? state.cards[String(id)] ?? null : null)
  const source = cardOf(req.card)
  const anyCards = useMemo(() => opts.some((o) => o.card != null), [opts])

  const toggle = (i: number): void => {
    setPicked((p) => {
      if (p.includes(i)) return p.filter((x) => x !== i)
      if (req.max === 1) return [i]
      return p.length >= req.max ? p : [...p, i]
    })
  }
  const move = (idx: number, d: -1 | 1): void => {
    setOrder((o) => {
      const n = [...o]
      const j = idx + d
      if (j < 0 || j >= n.length) return o
      ;[n[idx], n[j]] = [n[j], n[idx]]
      return n
    })
  }

  const body = (() => {
    if (req.kind === 'confirm' || req.kind === 'option') {
      return (
        <div className="flex flex-wrap justify-end gap-2">
          {opts.map((o) => (
            <button key={o.i} onClick={() => onAnswer(req.rid, o.i)}
              className={`rounded-md border px-3 py-1.5 text-sm ${o.i === (req.default ?? 0)
                ? 'border-violet-400/50 bg-violet-500/25 text-violet-100 hover:bg-violet-500/35'
                : 'border-white/15 text-white/75 hover:bg-white/10'}`}>
              {o.label}
            </button>
          ))}
        </div>
      )
    }
    if (req.kind === 'input') {
      return (
        <div className="flex gap-2">
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} type={req.numeric ? 'number' : 'text'}
            onKeyDown={(e) => { if (e.key === 'Enter') onAnswer(req.rid, text) }}
            className="flex-1 rounded-md border border-white/15 bg-black/30 px-2 py-1.5 text-sm" />
          <button onClick={() => onAnswer(req.rid, text)} className="rounded-md border border-violet-400/50 bg-violet-500/25 px-3 text-sm text-violet-100">OK</button>
        </div>
      )
    }
    if (req.kind === 'assign') {
      const total = req.amount ?? 0
      const used = split.reduce((a, b) => a + b, 0)
      const left = total - used
      const floor = req.atLeastOne ? 1 : 0
      const cap = (i: number): number => opts[i]?.max ?? total
      const set = (i: number, n: number): void => setSplit((s) => s.map((v, j) => (j === i ? Math.max(floor, Math.min(cap(i), n)) : v)))
      // "All to this one": give it everything still unassigned.
      const all = (i: number): void => setSplit((s) => s.map((v, j) => (j === i ? Math.min(cap(i), v + left) : v)))
      const GEM: Record<string, string> = { W: 'bg-amber-100 text-amber-950', U: 'bg-sky-500 text-white', B: 'bg-zinc-700 text-white', R: 'bg-red-500 text-white', G: 'bg-emerald-600 text-white', C: 'bg-zinc-300 text-zinc-900' }
      return (
        <>
          <p className="mb-2 text-[12px] text-white/45">
            Split {total}{req.unit ? ` ${req.unit}` : ''} however you like{req.atLeastOne ? ' (at least 1 each)' : ''}. <span className={left ? 'text-amber-300' : 'text-emerald-300'}>{left ? `${left} left to assign` : 'All assigned'}</span>
          </p>
          <div className="max-h-[55vh] space-y-1.5 overflow-y-auto">
            {opts.map((o) => {
              const c = cardOf(o.card) ?? o.cardData ?? null
              return (
                <div key={o.i} className="flex items-center gap-3 rounded-lg bg-white/[0.04] px-2 py-1.5"
                  onMouseEnter={() => c && onHover(c)} onMouseLeave={() => onHover(null)}>
                  {o.color
                    ? <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${GEM[o.color] ?? GEM.C}`}>{o.color}</span>
                    : c ? <GameCardView card={{ ...c, tapped: false }} size="xs" onHover={onHover} /> : null}
                  <span className="flex-1 truncate text-sm">{o.label}</span>
                  <button onClick={() => set(o.i, split[o.i] - 1)} disabled={split[o.i] <= floor} className="rounded-md bg-white/5 p-1.5 hover:bg-white/10 disabled:opacity-30"><Minus className="h-3.5 w-3.5" /></button>
                  <span className="w-8 text-center text-lg font-semibold tabular-nums">{split[o.i]}</span>
                  <button onClick={() => set(o.i, split[o.i] + 1)} disabled={!left || split[o.i] >= cap(o.i)} className="rounded-md bg-white/5 p-1.5 hover:bg-white/10 disabled:opacity-30"><Plus className="h-3.5 w-3.5" /></button>
                  <button onClick={() => all(o.i)} disabled={!left || split[o.i] >= cap(o.i)} className="rounded-md px-2 py-1 text-[11px] text-white/55 hover:bg-white/10 disabled:opacity-30">+ rest</button>
                </div>
              )
            })}
          </div>
          <div className="mt-3 flex justify-end">
            <button disabled={left !== 0} onClick={() => onAnswer(req.rid, split)}
              className="flex items-center gap-1 rounded-md border border-violet-400/50 bg-violet-500/25 px-3 py-1.5 text-sm text-violet-100 disabled:opacity-40">
              <Check className="h-4 w-4" /> Confirm
            </button>
          </div>
        </>
      )
    }
    if (req.kind === 'order') {
      return (
        <>
          {req.top && <p className="mb-2 text-[12px] text-white/50">First in the list = {req.top}</p>}
          <div className="max-h-[50vh] space-y-1 overflow-y-auto">
            {order.map((i, idx) => {
              const o = opts[i]
              return (
                <div key={i} className="flex items-center gap-2 rounded bg-white/[0.04] px-2 py-1 text-sm"
                  onMouseEnter={() => onHover(cardOf(o.card) ?? o.cardData ?? null)} onMouseLeave={() => onHover(null)}>
                  <span className="w-5 text-right text-white/35">{idx + 1}</span>
                  <span className="flex-1 truncate">{o.label}</span>
                  <button onClick={() => move(idx, -1)} className="rounded p-1 hover:bg-white/10"><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button onClick={() => move(idx, 1)} className="rounded p-1 hover:bg-white/10"><ArrowDown className="h-3.5 w-3.5" /></button>
                </div>
              )
            })}
          </div>
          <div className="mt-3 flex justify-end">
            <button onClick={() => onAnswer(req.rid, order)} className="flex items-center gap-1 rounded-md border border-violet-400/50 bg-violet-500/25 px-3 py-1.5 text-sm text-violet-100">
              <Check className="h-4 w-4" /> Done
            </button>
          </div>
        </>
      )
    }
    // choose / ability
    const ready = picked.length >= req.min && picked.length <= req.max
    return (
      <>
        <p className="mb-2 text-[12px] text-white/45">
          {req.min === req.max ? `Choose ${req.min}.` : req.min === 0 ? `Choose up to ${req.max}.` : `Choose ${req.min}–${req.max}.`}
        </p>
        {opts.length > 12 && (
          <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Search ${opts.length} cards by name or type…`}
            className="mb-2 w-full rounded-md border border-white/15 bg-black/30 px-2 py-1.5 text-sm placeholder:text-white/30" />
        )}
        <div className={`max-h-[55vh] overflow-y-auto ${anyCards ? 'flex flex-wrap gap-3' : 'space-y-1'}`}>
          {opts.filter((o) => {
            if (!filter) return true
            const c = cardOf(o.card) ?? o.cardData
            return `${o.label} ${c?.type ?? ''}`.toLowerCase().includes(filter.toLowerCase())
          }).map((o) => {
            const on = picked.includes(o.i)
            // Cards on the table come from the snapshot; library cards ride in with the question.
            const c = cardOf(o.card) ?? o.cardData ?? null
            if (anyCards && c) {
              return (
                <div key={o.i} className="space-y-1" onDoubleClick={() => req.max === 1 && req.min <= 1 && onAnswer(req.rid, [o.i])}>
                  <div className={`rounded-md ${on ? 'ring-2 ring-amber-300' : ''}`}>
                    <GameCardView card={{ ...c, tapped: false }} size="lg" onClick={() => toggle(o.i)} onHover={onHover} />
                  </div>
                  <div className="w-[112px] truncate text-center text-[11px] text-white/60">{o.label}</div>
                </div>
              )
            }
            return (
              <button key={o.i} onClick={() => toggle(o.i)} onDoubleClick={() => req.max === 1 && onAnswer(req.rid, [o.i])}
                disabled={o.canPlay === false}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm disabled:opacity-40 ${on ? 'bg-amber-500/20 text-amber-50' : 'bg-white/[0.04] hover:bg-white/[0.08]'}`}>
                <span className={`h-3.5 w-3.5 shrink-0 rounded-sm border ${on ? 'border-amber-300 bg-amber-300' : 'border-white/30'}`} />
                <span className="flex-1">{o.label}</span>
              </button>
            )
          })}
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          {req.min === 0 && (
            <button onClick={() => onAnswer(req.rid, [])} className="rounded-md border border-white/15 px-3 py-1.5 text-sm text-white/70 hover:bg-white/10">
              {req.kind === 'ability' ? 'Cancel' : 'Choose none'}
            </button>
          )}
          <button disabled={!ready} onClick={() => onAnswer(req.rid, picked)}
            className="flex items-center gap-1 rounded-md border border-violet-400/50 bg-violet-500/25 px-3 py-1.5 text-sm text-violet-100 disabled:opacity-40">
            <Check className="h-4 w-4" /> Confirm{req.max > 1 ? ` (${picked.length})` : ''}
          </button>
        </div>
      </>
    )
  })()

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-6">
      <div className="w-full max-w-3xl rounded-xl border border-white/15 bg-[#17171f] p-4 shadow-2xl">
        <div className="mb-3 flex items-start gap-3">
          {source && <GameCardView card={{ ...source, tapped: false }} size="sm" onHover={onHover} />}
          <h3 className="flex-1 whitespace-pre-line text-sm font-medium leading-snug">{req.title}</h3>
        </div>
        {body}
      </div>
    </div>
  )
}
