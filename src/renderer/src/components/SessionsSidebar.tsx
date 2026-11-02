import { useState } from 'react'
import { Plus, Trash2, Bot } from 'lucide-react'
import { useAtlis } from '../state/store'
import { PROVIDER_COLORS, PROVIDER_LABELS, fmtTime } from '../lib/format'

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5-mini',
  copilot: 'gpt-4o',
  lmstudio: 'qwen/qwen3.6-35b-a3b'
}

export default function SessionsSidebar() {
  const { sessions, activeSessionId, setActiveSession, newSession, deleteSession, runningSessions, projects } = useAtlis()
  const [creating, setCreating] = useState(false)

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-ink-600 bg-ink-850">
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-mist-500">Sessions</span>
        <div className="relative">
          <button
            onClick={() => setCreating(!creating)}
            className="flex h-6 w-6 items-center justify-center rounded border border-ink-600 text-mist-400 transition-colors hover:border-volt-500 hover:text-volt-400"
            title="New session"
          >
            <Plus size={13} />
          </button>
          {creating && (
            <div className="absolute right-0 top-7 z-20 w-44 rounded-md border border-ink-600 bg-ink-800 p-1 shadow-xl">
              {(['anthropic', 'openai', 'copilot', 'lmstudio'] as const).map((p) => (
                <button
                  key={p}
                  onClick={async () => {
                    setCreating(false)
                    await newSession(p, DEFAULT_MODELS[p])
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <div className="mt-10 px-3 text-center text-[12px] leading-relaxed text-mist-500">
            No sessions yet.
            <br />
            Create one with <Plus size={11} className="inline" /> and pick a provider.
          </div>
        )}
        {sessions.map((s) => {
          const running = runningSessions.has(s.id)
          const project = projects.find((p) => p.id === s.project_id)
          return (
            <div
              key={s.id}
              onClick={() => setActiveSession(s.id)}
              className={`group mb-1 cursor-pointer rounded-md border px-2.5 py-2 transition-colors ${
                activeSessionId === s.id
                  ? 'border-volt-500/50 bg-volt-500/10'
                  : 'border-transparent hover:border-ink-600 hover:bg-ink-800'
              }`}
            >
              <div className="flex items-center gap-1.5">
                {running ? (
                  <Bot size={12} className="pulse-dot shrink-0 text-pulse-400" />
                ) : (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: PROVIDER_COLORS[s.provider] ?? '#888' }} />
                )}
                <span className="truncate text-[12.5px] font-medium text-mist-100">{s.title}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteSession(s.id)
                  }}
                  className="ml-auto hidden shrink-0 text-mist-500 hover:text-danger-400 group-hover:block"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="mt-0.5 flex items-center gap-2 pl-3 font-mono text-[10px] text-mist-500">
                <span>{s.model}</span>
                {project && <span style={{ color: project.color }}>{project.name}</span>}
                <span className="ml-auto">{fmtTime(s.updated_at)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
