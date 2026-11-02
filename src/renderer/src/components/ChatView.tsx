import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquarePlus, Square, Users, Wrench, Zap } from 'lucide-react'
import { useAtlis } from '../state/store'
import { PROVIDER_LABELS } from '../lib/format'
import type { ModelInfo } from '../types'
import { parseParticipants } from '../types'
import MessageItem, { authorColor } from './MessageItem'
import RoundtableSetup from './RoundtableSetup'
import Composer from './Composer'

export default function ChatView() {
  const { sessions, activeSessionId, messages, runningSessions, refreshSessions, projects } = useAtlis()
  const session = sessions.find((s) => s.id === activeSessionId)
  const msgs = session ? (messages[session.id] ?? []) : []
  const running = session ? runningSessions.has(session.id) : false
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [showRoundtable, setShowRoundtable] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)

  const participants = useMemo(() => parseParticipants(session), [session?.participants])
  const isRoundtable = participants.length >= 2
  const authorColors = useMemo(
    () => Object.fromEntries(participants.map((p) => [p.name, authorColor(p.name, p.color)])),
    [participants]
  )

  useEffect(() => {
    if (!session) return
    let alive = true
    // Clear first: a failed fetch must not leave the previous provider's models in the picker.
    setModels([])
    setModelsError(null)
    window.atlis.providers.models(session.provider).then((res) => {
      if (!alive) return
      if (res.ok && res.models) setModels(res.models)
      else setModelsError(res.error ?? 'failed to load models')
    })
    return () => {
      alive = false
    }
  }, [session?.provider])

  useEffect(() => {
    if (pinnedToBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [msgs])

  if (!session) {
    return (
      <div className="grid-texture flex flex-1 flex-col items-center justify-center gap-3 text-mist-500">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-ink-600 bg-ink-800">
          <Zap size={24} className="text-volt-400" />
        </div>
        <p className="text-[13px]">Select a session or create one to begin.</p>
        <p className="max-w-sm text-center text-[11.5px] leading-relaxed text-mist-500">
          Each session is an independent agentic workspace — run several at once, across Anthropic, OpenAI and Copilot.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Session header */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-ink-600 bg-ink-850 px-4">
        <span className="truncate text-[13px] font-semibold">{session.title}</span>
        {isRoundtable ? (
          <button
            onClick={() => setShowRoundtable(true)}
            title="Edit roundtable participants"
            className="flex items-center gap-1.5 rounded border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-mist-300 hover:border-volt-500/60"
          >
            {participants.map((p) => (
              <span key={p.id} className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: authorColors[p.name] }} />
                <span className="max-w-[90px] truncate">{p.name}</span>
              </span>
            ))}
          </button>
        ) : (
          <>
            <span className="rounded border border-ink-600 px-1.5 py-0.5 font-mono text-[10px] text-mist-400">
              {PROVIDER_LABELS[session.provider]}
            </span>
            <select
              value={session.model}
              onChange={async (e) => {
                await window.atlis.sessions.update(session.id, { model: e.target.value })
                refreshSessions()
              }}
              className="max-w-[260px] rounded border border-ink-600 bg-ink-800 px-2 py-1 font-mono text-[11px] text-mist-300 outline-none focus:border-volt-500"
            >
              {!models.some((m) => m.id === session.model) && <option value={session.model}>{session.model}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
            {modelsError && (
              <span
                title={modelsError}
                className="max-w-[300px] truncate rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-400"
              >
                ⚠ models: {modelsError}
              </span>
            )}
          </>
        )}
        <select
          value={session.project_id ?? ''}
          onChange={async (e) => {
            await window.atlis.sessions.update(session.id, { project_id: e.target.value || null })
            refreshSessions()
          }}
          className="rounded border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-mist-300 outline-none focus:border-volt-500"
          title="Project (for usage attribution)"
        >
          <option value="">no project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {!isRoundtable && (
          <button
            onClick={async () => {
              await window.atlis.sessions.update(session.id, { agent_mode: session.agent_mode ? 0 : 1 })
              refreshSessions()
            }}
            className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors ${
              session.agent_mode
                ? 'border-pulse-400/60 bg-pulse-400/10 text-pulse-400'
                : 'border-ink-600 text-mist-500 hover:text-mist-300'
            }`}
            title="Toggle agentic tools (browser, fetch, documents)"
          >
            <Wrench size={11} />
            {session.agent_mode ? 'Agentic' : 'Chat only'}
          </button>
        )}
        <button
          onClick={() => setShowRoundtable(true)}
          className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors ${
            isRoundtable
              ? 'border-volt-500/60 bg-volt-500/10 text-volt-400'
              : 'border-ink-600 text-mist-500 hover:text-mist-300'
          }`}
          title="Roundtable: let 2+ models converse in this session"
        >
          <Users size={11} />
          {isRoundtable ? `Roundtable ×${participants.length}` : 'Roundtable'}
        </button>
        <div className="flex-1" />
        {isRoundtable && !running && msgs.length > 0 && (
          <button
            onClick={() => window.atlis.chat.roundtableContinue(session.id)}
            className="flex items-center gap-1.5 rounded border border-pulse-400/50 bg-pulse-400/10 px-2.5 py-1 text-[11px] text-pulse-400 hover:bg-pulse-400/20"
            title="Grant another discussion budget without saying anything — they pick up where they left off"
          >
            <MessageSquarePlus size={11} />
            Continue discussion
          </button>
        )}
        {running && (
          <button
            onClick={() => window.atlis.chat.stop(session.id)}
            className="flex items-center gap-1.5 rounded border border-danger-400/50 bg-danger-400/10 px-2.5 py-1 text-[11px] text-danger-400 hover:bg-danger-400/20"
          >
            <Square size={10} fill="currentColor" />
            Stop
          </button>
        )}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {msgs.map((m) => (
            <MessageItem key={m.id} message={m} authorColors={authorColors} />
          ))}
          {running && msgs[msgs.length - 1]?.kind !== 'streaming' && (
            <div className="flex items-center gap-2 px-1 text-[12px] text-mist-500">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-pulse-400" />
              working…
            </div>
          )}
        </div>
      </div>

      <Composer sessionId={session.id} running={running} />

      {showRoundtable && (
        <RoundtableSetup session={session} onClose={() => setShowRoundtable(false)} onSaved={refreshSessions} />
      )}
    </div>
  )
}
