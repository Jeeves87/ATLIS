import { useEffect, useState } from 'react'
import { Plus, Trash2, Users, X } from 'lucide-react'
import type { ModelInfo, Participant, ProviderId, Session } from '../types'
import { parseRoundtable } from '../types'
import { PROVIDER_LABELS } from '../lib/format'
import { authorColor } from './MessageItem'

const COLOR_CHOICES = ['#7c5cff', '#22d3ee', '#f59e0b', '#34d399', '#f472b6', '#a3e635', '#fb7185', '#60a5fa']

function newParticipant(n: number, provider: string, model: string): Participant {
  return {
    id: crypto.randomUUID(),
    name: `Model ${String.fromCharCode(64 + n)}`, // Model A, Model B…
    provider,
    model,
    persona: '',
    color: COLOR_CHOICES[(n - 1) % COLOR_CHOICES.length]
  }
}

/**
 * Modal editor for a session's roundtable participants. Two or more seats
 * turn the session into a multi-model conversation: each participant takes a
 * turn per round and sees the others' messages with attribution.
 */
export default function RoundtableSetup({ session, onClose, onSaved }: { session: Session; onClose: () => void; onSaved: () => void }) {
  const initial = parseRoundtable(session)
  const [participants, setParticipants] = useState<Participant[]>(initial.seats)
  const [maxTurns, setMaxTurns] = useState<number>(initial.maxTurns || 6)
  const [providers, setProviders] = useState<ProviderId[]>([])
  const [models, setModels] = useState<Record<string, ModelInfo[]>>({})

  useEffect(() => {
    window.atlis.providers.list().then(async (ids) => {
      setProviders(ids)
      for (const id of ids) {
        const res = await window.atlis.providers.models(id)
        if (res.ok && res.models) setModels((m) => ({ ...m, [id]: res.models! }))
      }
    })
  }, [])

  const patch = (id: string, p: Partial<Participant>) =>
    setParticipants((list) => list.map((x) => (x.id === id ? { ...x, ...p } : x)))

  const add = () =>
    setParticipants((list) => [...list, newParticipant(list.length + 1, session.provider, session.model)])

  const save = async () => {
    const valid = participants.filter((p) => p.name.trim() && p.model)
    await window.atlis.sessions.update(session.id, {
      participants: valid.length >= 2
        ? JSON.stringify({ seats: valid, maxTurns: Math.min(Math.max(Math.round(maxTurns) || valid.length * 3, 1), 24) })
        : null
    })
    onSaved()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/80 p-8 backdrop-blur-sm" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-[620px] flex-col rounded-lg border border-ink-600 bg-ink-850 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-ink-600 px-4 py-3">
          <Users size={15} className="text-volt-400" />
          <span className="text-[13px] font-semibold">Roundtable participants</span>
          <span className="text-[11px] text-mist-500">2+ seats = models converse with each other</span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-mist-500 hover:text-mist-300">
            <X size={15} />
          </button>
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
          {participants.length === 0 && (
            <p className="text-[12px] leading-relaxed text-mist-500">
              Add two or more model seats. Your message opens a real discussion: participants respond to each other,
              hand the floor by asking direct questions, and keep going until they reach a resolution or the turn
              budget runs out. Remove seats (below 2) to turn the session back into a normal single-model agent.
            </p>
          )}
          {participants.map((p) => (
            <div key={p.id} className="rounded-md border border-ink-600 bg-ink-900/60 p-3">
              <div className="flex items-center gap-2">
                <input
                  value={p.name}
                  onChange={(e) => patch(p.id, { name: e.target.value })}
                  placeholder="Name"
                  className="w-36 rounded border border-ink-600 bg-ink-800 px-2 py-1 text-[12px] outline-none focus:border-volt-500"
                />
                <select
                  value={p.provider}
                  onChange={(e) => {
                    const provider = e.target.value
                    const first = models[provider]?.[0]?.id ?? p.model
                    patch(p.id, { provider, model: first })
                  }}
                  className="rounded border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-mist-300 outline-none focus:border-volt-500"
                >
                  {providers.map((id) => (
                    <option key={id} value={id}>
                      {PROVIDER_LABELS[id] ?? id}
                    </option>
                  ))}
                </select>
                <select
                  value={p.model}
                  onChange={(e) => patch(p.id, { model: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-800 px-2 py-1 font-mono text-[11px] text-mist-300 outline-none focus:border-volt-500"
                >
                  {!(models[p.provider] ?? []).some((m) => m.id === p.model) && <option value={p.model}>{p.model}</option>}
                  {(models[p.provider] ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-1">
                  {COLOR_CHOICES.slice(0, 4).map((c) => (
                    <button
                      key={c}
                      onClick={() => patch(p.id, { color: c })}
                      className={`h-4 w-4 rounded-full border ${p.color === c ? 'border-mist-100' : 'border-transparent'}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <button
                  onClick={() => setParticipants((list) => list.filter((x) => x.id !== p.id))}
                  className="text-mist-500 hover:text-danger-400"
                  title="Remove seat"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <input
                value={p.persona ?? ''}
                onChange={(e) => patch(p.id, { persona: e.target.value })}
                placeholder="Persona / role (optional) — e.g. 'devil's advocate: challenge every claim'"
                className="mt-2 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1 text-[11.5px] text-mist-300 outline-none placeholder:text-mist-600 focus:border-volt-500"
              />
              <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-mist-500">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: authorColor(p.name, p.color) }} />
                speaks as <span style={{ color: authorColor(p.name, p.color) }}>{p.name || '?'}</span>
              </div>
            </div>
          ))}

          <button
            onClick={add}
            className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-ink-500 px-3 py-2 text-[12px] text-mist-400 hover:border-volt-500/60 hover:text-mist-200"
          >
            <Plus size={13} />
            Add seat
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-ink-600 px-4 py-3">
          {participants.length >= 2 ? (
            <label className="flex items-center gap-2 text-[11px] text-mist-500">
              Discussion budget
              <input
                type="number"
                min={2}
                max={24}
                value={maxTurns}
                onChange={(e) => setMaxTurns(Number(e.target.value))}
                className="w-14 rounded border border-ink-600 bg-ink-800 px-2 py-1 text-center font-mono text-[11px] text-mist-300 outline-none focus:border-volt-500"
              />
              turns per message (ends early on consensus)
            </label>
          ) : (
            <span className="text-[11px] text-mist-500">Fewer than 2 seats — saves as a normal session.</span>
          )}
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded border border-ink-600 px-3 py-1.5 text-[12px] text-mist-400 hover:text-mist-200">
              Cancel
            </button>
            <button
              onClick={save}
              className="rounded border border-volt-500/60 bg-volt-500/15 px-3 py-1.5 text-[12px] text-volt-400 hover:bg-volt-500/25"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
