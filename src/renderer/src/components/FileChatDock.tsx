import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, Globe, MessageSquare, Plus, SendHorizonal, Square, X } from 'lucide-react'
import { useAtlis } from '../state/store'
import { PROVIDER_COLORS, PROVIDER_LABELS, fmtTime } from '../lib/format'
import { withPageContext } from '../lib/pageContext'
import MessageItem from './MessageItem'

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5-mini',
  copilot: 'gpt-4o',
  lmstudio: 'qwen/qwen3.6-35b-a3b'
}

function MiniComposer({ sessionId, running }: { sessionId: string; running: boolean }) {
  const [text, setText] = useState('')
  const loadMessages = useAtlis((s) => s.loadMessages)
  const pendingPage = useAtlis((s) => s.pendingPage)
  const stagePage = useAtlis((s) => s.stagePage)

  const send = async () => {
    if (running) return
    const trimmed = text.trim()
    if (!trimmed && !pendingPage) return
    setText('')
    let md = trimmed
    let html = trimmed ? await window.atlis.docs.toHtml(trimmed) : ''
    if (pendingPage) {
      ;({ md, html } = withPageContext(md, html, pendingPage))
      stagePage(null)
    }
    await window.atlis.chat.send(sessionId, md, html)
    loadMessages(sessionId)
  }

  return (
    <div className="shrink-0 border-t border-ink-600 bg-ink-850 p-2">
      {pendingPage && (
        <div className="mb-1.5 flex items-center">
          <div className="flex min-w-0 items-center gap-1.5 rounded-full border border-volt-500/40 bg-volt-500/10 px-2.5 py-1 text-[11px] text-volt-300">
            <Globe size={11} className="shrink-0" />
            <span className="truncate" title={pendingPage.url}>{pendingPage.title || pendingPage.url}</span>
            <button onClick={() => stagePage(null)} title="Remove page" className="shrink-0 text-mist-400 hover:text-danger-400">
              <X size={11} />
            </button>
          </div>
        </div>
      )}
      <div className="flex items-end gap-1.5 rounded-md border border-ink-600 bg-ink-800 p-1.5 focus-within:border-volt-500/70">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Message…"
          rows={2}
          className="max-h-24 min-h-9 flex-1 resize-none bg-transparent px-1 py-0.5 text-[12.5px] leading-relaxed text-mist-100 outline-none placeholder:text-mist-500"
        />
        <button
          onClick={send}
          disabled={running || (!text.trim() && !pendingPage)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-volt-500 text-white transition-colors hover:bg-volt-400 disabled:opacity-40"
          title="Send"
        >
          <SendHorizonal size={13} />
        </button>
      </div>
    </div>
  )
}

export default function FileChatDock() {
  const {
    sessions,
    activeSessionId,
    messages,
    runningSessions,
    projects,
    setActiveSession,
    newSession,
    dockSessionId: expandedId,
    setDockSession: setExpandedId,
    dockCreating: creating,
    setDockCreating: setCreating
  } = useAtlis()
  const scrollRef = useRef<HTMLDivElement>(null)

  const expandedSession = sessions.find((s) => s.id === expandedId) ?? null
  const expandedMessages = expandedSession ? (messages[expandedSession.id] ?? []) : []
  const expandedRunning = expandedSession ? runningSessions.has(expandedSession.id) : false
  const lastMessage = expandedMessages[expandedMessages.length - 1]

  // jump to the bottom when a chat window opens…
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [expandedId])

  // …but while it's open, only follow new output if the user is already near
  // the bottom — never yank the scroll position away from them
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTo({ top: el.scrollHeight })
  }, [expandedMessages.length, lastMessage?.content_md.length])

  const openSession = (id: string) => {
    setActiveSession(id)
    setExpandedId(id)
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex items-end justify-end gap-2 px-4 pb-3">
      {/* Minimized session strip */}
      <div className="pointer-events-auto flex min-w-0 flex-1 items-end justify-end gap-1.5 overflow-hidden">
        {sessions.map((s) => {
          const running = runningSessions.has(s.id)
          const project = projects.find((p) => p.id === s.project_id)
          const active = activeSessionId === s.id
          const expanded = expandedSession?.id === s.id
          return (
            <button
              key={s.id}
              onClick={() => (expanded ? setExpandedId(null) : openSession(s.id))}
              title={`${s.title} · ${s.model}`}
              className={`flex h-8 max-w-44 items-center gap-1.5 rounded-t-md border px-2 text-left text-[11px] shadow-xl backdrop-blur transition-colors ${
                active
                  ? 'border-volt-500/60 bg-ink-800/95 text-mist-100'
                  : 'border-ink-600 bg-ink-850/90 text-mist-300 hover:border-volt-500/50'
              }`}
            >
              {running ? (
                <Bot size={12} className="pulse-dot shrink-0 text-pulse-400" />
              ) : (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: PROVIDER_COLORS[s.provider] ?? '#888' }} />
              )}
              <span className="truncate">{s.title}</span>
              {project && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: project.color }} />}
            </button>
          )
        })}

        <div className="relative">
          <button
            onClick={() => setCreating(!creating)}
            className="flex h-8 w-8 items-center justify-center rounded-t-md border border-ink-600 bg-ink-850/90 text-mist-400 shadow-xl backdrop-blur transition-colors hover:border-volt-500/50 hover:text-volt-400"
            title="New session"
          >
            <Plus size={13} />
          </button>
          {creating && (
            <div className="absolute right-0 bottom-9 w-44 rounded-md border border-ink-600 bg-ink-800 p-1 shadow-xl">
              {(['anthropic', 'openai', 'copilot', 'lmstudio'] as const).map((p) => (
                <button
                  key={p}
                  onClick={async () => {
                    setCreating(false)
                    const s = await newSession(p, DEFAULT_MODELS[p])
                    setExpandedId(s.id)
                  }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-mist-300 hover:bg-ink-700"
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: PROVIDER_COLORS[p] }} />
                  {PROVIDER_LABELS[p]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Expanded IM window */}
      {expandedSession && expandedId && (
        <section className="pointer-events-auto flex h-[54vh] w-[min(420px,32vw)] min-w-[320px] flex-col overflow-hidden rounded-t-xl border border-ink-600 bg-ink-900/96 shadow-2xl backdrop-blur">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-ink-600 bg-ink-850 px-3">
            {expandedRunning ? (
              <Bot size={13} className="pulse-dot shrink-0 text-pulse-400" />
            ) : (
              <MessageSquare size={13} className="shrink-0 text-volt-400" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold text-mist-100">{expandedSession.title}</div>
              <div className="truncate font-mono text-[9.5px] text-mist-500">
                {PROVIDER_LABELS[expandedSession.provider]} · {expandedSession.model} · {fmtTime(expandedSession.updated_at)}
              </div>
            </div>
            {expandedRunning && (
              <button
                onClick={() => window.atlis.chat.stop(expandedSession.id)}
                className="flex h-6 w-6 items-center justify-center rounded border border-danger-400/50 bg-danger-400/10 text-danger-400 hover:bg-danger-400/20"
                title="Stop"
              >
                <Square size={9} fill="currentColor" />
              </button>
            )}
            <button
              onClick={() => setExpandedId(null)}
              className="flex h-6 w-6 items-center justify-center rounded text-mist-500 hover:bg-ink-700 hover:text-mist-300"
              title="Minimize"
            >
              <ChevronDown size={14} />
            </button>
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <div className="flex flex-col gap-2">
              {expandedMessages.length === 0 ? (
                <div className="mt-10 text-center text-[12px] leading-relaxed text-mist-500">
                  No messages yet.
                  <br />
                  This mini chat is tied to the active session.
                </div>
              ) : (
                expandedMessages.map((m) => <MessageItem key={m.id} message={m} />)
              )}
              {expandedRunning && expandedMessages[expandedMessages.length - 1]?.kind !== 'streaming' && (
                <div className="flex items-center gap-2 px-1 text-[12px] text-mist-500">
                  <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-pulse-400" />
                  working…
                </div>
              )}
            </div>
          </div>

          <MiniComposer sessionId={expandedSession.id} running={expandedRunning} />
        </section>
      )}
    </div>
  )
}
