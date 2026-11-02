import { useEffect, useMemo, useRef, useState } from 'react'
import { Dices, EyeOff, Eye, Play, Square, Swords, Trash2, Trophy } from 'lucide-react'
import type { ArenaEvent, Comparison, LeaderboardRow, ModelInfo, ProviderId } from '../types'
import { PROVIDER_COLORS, PROVIDER_LABELS, fmtUsd } from '../lib/format'
import { renderContent } from '../lib/markdown'

interface Seat {
  provider: string
  model: string
}

type Winner = 'a' | 'b' | 'tie' | 'both_bad'

const WINNER_LABELS: Record<Winner, string> = { a: 'A wins', b: 'B wins', tie: 'Tie', both_bad: 'Both bad' }

/**
 * Blind model arena (Odysseus Compare, ATLIS-native): one prompt, two models
 * streaming side by side under anonymous labels. Vote → names revealed →
 * result feeds the leaderboard.
 */
export default function ArenaView() {
  const [providers, setProviders] = useState<ProviderId[]>([])
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({})
  const [seatA, setSeatA] = useState<Seat | null>(null)
  const [seatB, setSeatB] = useState<Seat | null>(null)
  const [blind, setBlind] = useState(true)
  const [prompt, setPrompt] = useState('')

  const [current, setCurrent] = useState<Comparison | null>(null)
  const [textA, setTextA] = useState('')
  const [textB, setTextB] = useState('')
  const [doneA, setDoneA] = useState(false)
  const [doneB, setDoneB] = useState(false)
  const [revealed, setRevealed] = useState(false)

  const [board, setBoard] = useState<LeaderboardRow[]>([])
  const [history, setHistory] = useState<Comparison[]>([])

  const currentId = useRef<string | null>(null)
  const running = current != null && !(doneA && doneB)

  const allModels = useMemo(
    () => providers.flatMap((p) => (models[p] ?? []).map((m) => ({ provider: p as string, model: m.id }))),
    [providers, models]
  )

  const refreshBoards = async () => {
    setBoard(await window.atlis.arena.leaderboard())
    setHistory(await window.atlis.arena.list(20))
  }

  useEffect(() => {
    window.atlis.providers.list().then(async (ids) => {
      setProviders(ids)
      for (const id of ids) {
        const res = await window.atlis.providers.models(id)
        if (res.ok && res.models) setModels((m) => ({ ...m, [id]: res.models! }))
      }
    })
    refreshBoards()
    const off = window.atlis.arena.onEvent((ev: ArenaEvent) => {
      if (ev.compareId !== currentId.current) return
      if (ev.type === 'delta') {
        if (ev.side === 'a') setTextA((t) => t + (ev.delta ?? ''))
        else setTextB((t) => t + (ev.delta ?? ''))
      } else if (ev.type === 'done') {
        if (ev.side === 'a') setDoneA(true)
        else setDoneB(true)
      } else if (ev.type === 'error') {
        const msg = `\n\n> ⚠ ${ev.error}`
        if (ev.side === 'a') {
          setTextA((t) => t + msg)
          setDoneA(true)
        } else {
          setTextB((t) => t + msg)
          setDoneB(true)
        }
      }
    })
    return off
  }, [])

  // Default seats once models arrive: two different models when possible.
  useEffect(() => {
    if (allModels.length && !seatA) setSeatA(allModels[0])
    if (allModels.length > 1 && !seatB) setSeatB(allModels[1] ?? allModels[0])
  }, [allModels])

  const randomize = () => {
    if (allModels.length < 2) return
    const i = Math.floor(Math.random() * allModels.length)
    let j = Math.floor(Math.random() * (allModels.length - 1))
    if (j >= i) j++
    setSeatA(allModels[i])
    setSeatB(allModels[j])
  }

  const start = async () => {
    if (!seatA || !seatB || !prompt.trim() || running) return
    setTextA('')
    setTextB('')
    setDoneA(false)
    setDoneB(false)
    setRevealed(!blind)
    const row = await window.atlis.arena.start({
      prompt: prompt.trim(),
      provider_a: seatA.provider,
      model_a: seatA.model,
      provider_b: seatB.provider,
      model_b: seatB.model,
      is_blind: blind
    })
    currentId.current = row.id
    setCurrent(row)
  }

  const stop = () => {
    if (currentId.current) window.atlis.arena.stop(currentId.current)
  }

  const castVote = async (winner: Winner) => {
    if (!current) return
    await window.atlis.arena.vote(current.id, winner)
    setRevealed(true)
    setCurrent((c) => (c ? { ...c, winner } : c))
    refreshBoards()
  }

  const seatLabel = (side: 'a' | 'b') => {
    const seat = side === 'a' ? seatA : seatB
    if (!current) return ''
    if (!revealed && current.is_blind) return side === 'a' ? 'MODEL A' : 'MODEL B'
    return seat ? seat.model : ''
  }

  const seatColor = (side: 'a' | 'b') => {
    const seat = side === 'a' ? seatA : seatB
    if (current && !revealed && current.is_blind) return '#8b93a7'
    return seat ? (PROVIDER_COLORS[seat.provider] ?? '#7c5cff') : '#8b93a7'
  }

  const modelSelect = (seat: Seat | null, set: (s: Seat) => void) => (
    <select
      value={seat ? `${seat.provider}|${seat.model}` : ''}
      onChange={(e) => {
        const [provider, ...rest] = e.target.value.split('|')
        set({ provider, model: rest.join('|') })
      }}
      disabled={running}
      className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-800 px-2 py-1.5 font-mono text-[11px] text-mist-300 outline-none focus:border-volt-500 disabled:opacity-50"
    >
      {allModels.map((m) => (
        <option key={`${m.provider}|${m.model}`} value={`${m.provider}|${m.model}`}>
          {PROVIDER_LABELS[m.provider] ?? m.provider} · {m.model}
        </option>
      ))}
    </select>
  )

  const votable = current != null && doneA && doneB && !current.winner

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Controls */}
        <div className="shrink-0 border-b border-ink-600 bg-ink-850 px-4 py-3">
          <div className="flex items-center gap-2">
            <Swords size={15} className="text-volt-400" />
            <span className="text-[13px] font-semibold">Arena</span>
            <span className="text-[11px] text-mist-500">blind head-to-head model battles</span>
            <div className="flex-1" />
            <button
              onClick={() => setBlind(!blind)}
              disabled={running}
              className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-50 ${
                blind ? 'border-volt-500/60 bg-volt-500/10 text-volt-400' : 'border-ink-600 text-mist-500 hover:text-mist-300'
              }`}
              title="Blind mode hides which model is which until you vote"
            >
              {blind ? <EyeOff size={11} /> : <Eye size={11} />}
              {blind ? 'Blind' : 'Open'}
            </button>
            <button
              onClick={randomize}
              disabled={running || allModels.length < 2}
              className="flex items-center gap-1.5 rounded border border-ink-600 px-2 py-1 text-[11px] text-mist-400 hover:text-mist-200 disabled:opacity-50"
              title="Pick two random different models"
            >
              <Dices size={11} />
              Random pair
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            {modelSelect(seatA, setSeatA)}
            <span className="font-mono text-[11px] text-mist-500">vs</span>
            {modelSelect(seatB, setSeatB)}
          </div>
          <div className="mt-2 flex items-end gap-2">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start()
              }}
              placeholder="One prompt, two models… (Ctrl+Enter to fight)"
              rows={2}
              className="min-h-[42px] flex-1 resize-y rounded border border-ink-600 bg-ink-800 px-3 py-2 text-[13px] outline-none placeholder:text-mist-600 focus:border-volt-500"
            />
            {running ? (
              <button
                onClick={stop}
                className="flex items-center gap-1.5 rounded border border-danger-400/50 bg-danger-400/10 px-3 py-2 text-[12px] text-danger-400 hover:bg-danger-400/20"
              >
                <Square size={11} fill="currentColor" />
                Stop
              </button>
            ) : (
              <button
                onClick={start}
                disabled={!prompt.trim() || !seatA || !seatB}
                className="flex items-center gap-1.5 rounded border border-volt-500/60 bg-volt-500/15 px-3 py-2 text-[12px] text-volt-400 hover:bg-volt-500/25 disabled:opacity-40"
              >
                <Play size={11} />
                Fight
              </button>
            )}
          </div>
        </div>

        {/* Battle panes */}
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-ink-600">
          {(['a', 'b'] as const).map((side) => {
            const text = side === 'a' ? textA : textB
            const done = side === 'a' ? doneA : doneB
            return (
              <div key={side} className="flex min-h-0 flex-col bg-ink-900">
                <div className="flex h-8 shrink-0 items-center gap-2 border-b border-ink-600 bg-ink-850 px-3">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: seatColor(side) }} />
                  <span className="font-mono text-[11px] font-semibold tracking-wide" style={{ color: seatColor(side) }}>
                    {current ? seatLabel(side) : side === 'a' ? (seatA?.model ?? '—') : (seatB?.model ?? '—')}
                  </span>
                  {current && revealed && (
                    <span className="text-[10px] text-mist-500">
                      {(() => {
                        const c = side === 'a' ? current.cost_a : current.cost_b
                        const l = side === 'a' ? current.latency_a_ms : current.latency_b_ms
                        return `${c ? fmtUsd(c) : ''}${l ? ` · ${(l / 1000).toFixed(1)}s` : ''}`
                      })()}
                    </span>
                  )}
                  {current && !done && <span className="pulse-dot ml-auto h-1.5 w-1.5 rounded-full bg-pulse-400" />}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  {text ? (
                    <div className="prose-atlis text-[13px]" dangerouslySetInnerHTML={{ __html: renderContent(text) }} />
                  ) : (
                    <p className="text-[12px] text-mist-600">{current ? 'waiting for first token…' : 'Responses stream here.'}</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Vote bar */}
        <div className="flex h-12 shrink-0 items-center justify-center gap-2 border-t border-ink-600 bg-ink-850 px-4">
          {votable ? (
            <>
              <span className="mr-2 text-[11px] text-mist-500">Who won?</span>
              <button onClick={() => castVote('a')} className="rounded border border-volt-500/60 bg-volt-500/10 px-4 py-1.5 text-[12px] text-volt-400 hover:bg-volt-500/25">
                ◀ A is better
              </button>
              <button onClick={() => castVote('tie')} className="rounded border border-ink-500 px-4 py-1.5 text-[12px] text-mist-300 hover:bg-ink-700">
                Tie
              </button>
              <button onClick={() => castVote('both_bad')} className="rounded border border-ink-500 px-4 py-1.5 text-[12px] text-mist-400 hover:bg-ink-700">
                Both bad
              </button>
              <button onClick={() => castVote('b')} className="rounded border border-pulse-400/60 bg-pulse-400/10 px-4 py-1.5 text-[12px] text-pulse-400 hover:bg-pulse-400/25">
                B is better ▶
              </button>
            </>
          ) : current?.winner ? (
            <span className="text-[12px] text-mist-400">
              Voted: <span className="text-mist-100">{WINNER_LABELS[current.winner as Winner]}</span>
              {current.is_blind ? ` — A was ${current.model_a}, B was ${current.model_b}` : ''}
            </span>
          ) : (
            <span className="text-[11px] text-mist-600">
              {running ? 'Streaming… vote unlocks when both finish.' : 'Run a battle to unlock voting.'}
            </span>
          )}
        </div>
      </div>

      {/* Right rail: leaderboard + history */}
      <aside className="flex w-72 shrink-0 flex-col border-l border-ink-600 bg-ink-850">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-ink-600 px-3">
          <Trophy size={13} className="text-volt-400" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-mist-300">Leaderboard</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-3 py-2">
            {board.length === 0 && <p className="text-[11px] text-mist-600">No voted battles yet.</p>}
            {board.map((r, i) => (
              <div key={`${r.provider}/${r.model}`} className="flex items-center gap-2 border-b border-ink-700/60 py-1.5 last:border-0">
                <span className="w-4 text-right font-mono text-[10px] text-mist-500">{i + 1}</span>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_COLORS[r.provider] ?? '#7c5cff' }} />
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mist-300" title={r.model}>
                  {r.model}
                </span>
                <span className="font-mono text-[10.5px] text-mist-100">{Math.round(r.winRate * 100)}%</span>
                <span className="font-mono text-[9.5px] text-mist-500">
                  {r.wins}-{r.losses}-{r.ties}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-ink-600 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-mist-500">Recent battles</span>
            {history.map((c) => (
              <div key={c.id} className="group mt-1.5 rounded border border-ink-700/60 px-2 py-1.5">
                <p className="truncate text-[11px] text-mist-300" title={c.prompt}>
                  {c.prompt}
                </p>
                <div className="mt-0.5 flex items-center gap-1 font-mono text-[9.5px] text-mist-500">
                  <span className={c.winner === 'a' ? 'text-ok-400' : ''}>{c.model_a}</span>
                  <span>vs</span>
                  <span className={c.winner === 'b' ? 'text-ok-400' : ''}>{c.model_b}</span>
                  <span className="flex-1" />
                  {c.winner && <span>{WINNER_LABELS[c.winner as Winner]}</span>}
                  <button
                    onClick={async () => {
                      await window.atlis.arena.remove(c.id)
                      refreshBoards()
                    }}
                    className="hidden text-mist-600 hover:text-danger-400 group-hover:block"
                    title="Delete battle"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  )
}
