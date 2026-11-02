import { useEffect, useMemo, useState } from 'react'
import { Bot, Check, FileCode2, Plus, RefreshCw, Save, Search, Sparkles } from 'lucide-react'
import type { AgentZooEntry, AgentZooKind } from '../types'

const KIND_LABELS: Record<AgentZooKind, string> = {
  agent: 'Agent',
  skill: 'Skill',
  tool: 'Tool',
  runtime: 'Runtime',
  config: 'Config'
}

const KIND_STYLES: Record<AgentZooKind, string> = {
  agent: 'border-volt-500/50 bg-volt-500/10 text-volt-400',
  skill: 'border-pulse-400/50 bg-pulse-400/10 text-pulse-400',
  tool: 'border-ok-400/50 bg-ok-400/10 text-ok-400',
  runtime: 'border-ember-400/50 bg-ember-400/10 text-ember-400',
  config: 'border-ink-500 bg-ink-700 text-mist-300'
}

function emptyAgentForm() {
  return { name: '', description: '', tools: '', instructions: '' }
}

export default function AgentZooView() {
  const [entries, setEntries] = useState<AgentZooEntry[]>([])
  const [selected, setSelected] = useState<AgentZooEntry | null>(null)
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<AgentZooKind | 'all'>('all')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [agentForm, setAgentForm] = useState(emptyAgentForm())

  const dirty = content !== savedContent

  const loadEntry = async (entry: AgentZooEntry) => {
    const text = await window.atlis.agentZoo.read(entry.path)
    setSelected(entry)
    setContent(text)
    setSavedContent(text)
    setStatus(null)
  }

  const openEntry = async (entry: AgentZooEntry, warn = true) => {
    if (warn && dirty && !confirm('Discard unsaved changes in the current Agent Zoo file?')) return
    await loadEntry(entry)
  }

  const refresh = async () => {
    setLoading(true)
    try {
      const list = await window.atlis.agentZoo.list()
      setEntries(list)
      if (!selected && list.length) await loadEntry(list[0])
      else if (selected) {
        const nextSelected = list.find((e) => e.path === selected.path) ?? null
        setSelected(nextSelected)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (kind !== 'all' && e.kind !== kind) return false
      if (!q) return true
      return [e.name, e.path, e.origin, e.description, e.kind].some((v) => v.toLowerCase().includes(q))
    })
  }, [entries, kind, query])

  const counts = useMemo(() => {
    const c: Record<AgentZooKind, number> = { agent: 0, skill: 0, tool: 0, runtime: 0, config: 0 }
    for (const e of entries) c[e.kind]++
    return c
  }, [entries])

  const save = async () => {
    if (!selected) return
    setSaving(true)
    try {
      await window.atlis.agentZoo.save(selected.path, content)
      setSavedContent(content)
      setStatus('Saved')
      setTimeout(() => setStatus(null), 1500)
    } finally {
      setSaving(false)
    }
  }

  const createAgent = async () => {
    if (!agentForm.name.trim()) return
    const entry = await window.atlis.agentZoo.createAgent({
      name: agentForm.name.trim(),
      description: agentForm.description.trim() || undefined,
      instructions: agentForm.instructions.trim() || undefined,
      tools: agentForm.tools.split(',').map((t) => t.trim()).filter(Boolean)
    })
    setAgentForm(emptyAgentForm())
    setShowCreate(false)
    await refresh()
    await loadEntry(entry)
  }

  return (
    <div className="flex min-h-0 flex-1 bg-ink-900">
      <aside className="flex w-80 shrink-0 flex-col border-r border-ink-600 bg-ink-850">
        <div className="border-b border-ink-600 p-3">
          <div className="mb-3 flex items-center gap-2">
            <Bot size={16} className="text-volt-400" />
            <div>
              <h1 className="text-[13px] font-bold uppercase tracking-[0.18em]">Agent Zoo</h1>
              <p className="text-[10.5px] text-mist-500">Agents, skills, tools, and runtime files</p>
            </div>
            <button
              onClick={refresh}
              title="Refresh"
              className="ml-auto rounded border border-ink-600 p-1.5 text-mist-400 hover:border-volt-500 hover:text-volt-400"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
          <div className="relative mb-2">
            <Search size={12} className="absolute left-2 top-2 text-mist-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search zoo…"
              className="w-full rounded-md border border-ink-600 bg-ink-900 py-1.5 pl-7 pr-2 text-[12px] outline-none focus:border-volt-500"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(['all', 'agent', 'skill', 'tool', 'runtime', 'config'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`rounded border px-2 py-1 text-[10.5px] ${kind === k ? 'border-volt-500 text-volt-400' : 'border-ink-600 text-mist-400 hover:text-mist-200'}`}
              >
                {k === 'all' ? `All ${entries.length}` : `${KIND_LABELS[k]} ${counts[k]}`}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {filtered.map((entry) => (
            <button
              key={entry.path}
              onClick={() => openEntry(entry)}
              className={`mb-1 w-full rounded-md border p-2 text-left transition-colors ${selected?.path === entry.path ? 'border-volt-500 bg-volt-500/10' : 'border-transparent hover:bg-ink-700'}`}
            >
              <div className="mb-1 flex items-center gap-2">
                <span className={`rounded border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ${KIND_STYLES[entry.kind]}`}>
                  {KIND_LABELS[entry.kind]}
                </span>
                <span className="truncate text-[12.5px] font-medium text-mist-200">{entry.name}</span>
              </div>
              <div className="truncate font-mono text-[10.5px] text-mist-500">{entry.path}</div>
              {entry.description && <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-mist-400">{entry.description}</p>}
            </button>
          ))}
          {!filtered.length && <p className="px-2 py-6 text-center text-[12px] text-mist-500">No matching zoo entries.</p>}
        </div>

        <div className="border-t border-ink-600 p-3">
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-volt-500/60 bg-volt-500/10 px-3 py-2 text-[12px] font-medium text-volt-400 hover:bg-volt-500/15"
          >
            <Plus size={13} /> Add new agent
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {showCreate && (
          <section className="border-b border-ink-600 bg-ink-850 p-4">
            <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
              <Sparkles size={13} className="text-volt-400" /> Create agent
              <span className="font-normal normal-case tracking-normal text-mist-500">— writes to .claude/agents/*.md in the workspace</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                value={agentForm.name}
                onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })}
                placeholder="Agent name"
                className="rounded border border-ink-600 bg-ink-900 px-3 py-1.5 text-[12px] outline-none focus:border-volt-500"
              />
              <input
                value={agentForm.tools}
                onChange={(e) => setAgentForm({ ...agentForm, tools: e.target.value })}
                placeholder="Tools, comma-separated (optional)"
                className="rounded border border-ink-600 bg-ink-900 px-3 py-1.5 text-[12px] outline-none focus:border-volt-500"
              />
              <input
                value={agentForm.description}
                onChange={(e) => setAgentForm({ ...agentForm, description: e.target.value })}
                placeholder="Description"
                className="col-span-2 rounded border border-ink-600 bg-ink-900 px-3 py-1.5 text-[12px] outline-none focus:border-volt-500"
              />
              <textarea
                value={agentForm.instructions}
                onChange={(e) => setAgentForm({ ...agentForm, instructions: e.target.value })}
                placeholder="Initial instructions…"
                rows={3}
                className="col-span-2 resize-none rounded border border-ink-600 bg-ink-900 px-3 py-2 text-[12px] outline-none focus:border-volt-500"
              />
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setShowCreate(false)} className="rounded border border-ink-600 px-3 py-1.5 text-[11px] text-mist-400 hover:text-mist-200">Cancel</button>
              <button onClick={createAgent} className="rounded border border-volt-500/60 bg-volt-500/10 px-3 py-1.5 text-[11px] text-volt-400 hover:bg-volt-500/15">Create</button>
            </div>
          </section>
        )}

        <div className="flex h-11 shrink-0 items-center gap-3 border-b border-ink-600 bg-ink-850 px-4">
          {selected ? (
            <>
              <FileCode2 size={14} className="text-mist-500" />
              <span className="truncate font-mono text-[12px] text-mist-200">{selected.path}</span>
              <span className={`rounded border px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider ${KIND_STYLES[selected.kind]}`}>{KIND_LABELS[selected.kind]}</span>
              {dirty && <span className="h-2 w-2 rounded-full bg-ember-400" title="Unsaved changes" />}
              <div className="flex-1" />
              {status && <span className="flex items-center gap-1 text-[11px] text-ok-400"><Check size={12} /> {status}</span>}
              <button
                onClick={save}
                disabled={!dirty || saving}
                className="flex items-center gap-1.5 rounded border border-ink-600 px-2.5 py-1 text-[11px] text-mist-300 transition-colors hover:border-volt-500 hover:text-volt-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Save size={11} /> {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <span className="text-[12px] text-mist-500">Select a zoo entry to inspect or edit.</span>
          )}
        </div>

        {selected ? (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-ink-950 p-4 font-mono text-[12.5px] leading-relaxed text-mist-200 outline-none"
          />
        ) : (
          <div className="grid-texture flex flex-1 items-center justify-center text-[12px] text-mist-500">No zoo entry selected.</div>
        )}
      </main>
    </div>
  )
}
