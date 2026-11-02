import { useEffect, useState } from 'react'
import { KeyRound, FolderKanban, FolderCog, Plus, Trash2, Check, Cpu, Loader2 } from 'lucide-react'
import { useAtlis } from '../state/store'
import McpSettings from './McpSettings'
import AppsSettings from './AppsSettings'
import DesktopSettings from './DesktopSettings'
import AlertSettings from './AlertSettings'
import DiscordBotSettings from './DiscordBotSettings'
import DisplaySettings from './DisplaySettings'
import AppSelector from './AppSelector'

const KEY_FIELDS = [
  { key: 'anthropic_api_key', label: 'Anthropic API key', hint: 'console.anthropic.com → API keys' },
  { key: 'openai_api_key', label: 'OpenAI API key', hint: 'platform.openai.com → API keys' },
  { key: 'github_token', label: 'GitHub token (Copilot)', hint: 'output of `gh auth token` — exchanged for a Copilot bearer automatically' }
]

const PROJECT_COLORS = ['#7c5cff', '#22d3ee', '#fb923c', '#34d399', '#f472b6', '#facc15']

export default function SettingsView() {
  const [values, setValues] = useState<Record<string, string>>({})
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const [newProject, setNewProject] = useState('')
  const { projects, refreshProjects } = useAtlis()
  const [lmTest, setLmTest] = useState<{ busy: boolean; text?: string; ok?: boolean }>({ busy: false })

  const testLmStudio = async () => {
    await window.atlis.settings.set('lmstudio_base_url', values['lmstudio_base_url'] ?? '')
    setLmTest({ busy: true })
    const r = await window.atlis.providers.models('lmstudio')
    setLmTest(
      r.ok
        ? { busy: false, ok: true, text: `Connected — ${r.models?.length ?? 0} chat model(s): ${(r.models ?? []).slice(0, 4).map((m) => m.label).join(', ')}` }
        : { busy: false, ok: false, text: r.error ?? 'Could not reach LM Studio.' }
    )
  }

  useEffect(() => {
    window.atlis.settings.getAll().then(setValues)
  }, [])

  const save = async (key: string) => {
    const value = values[key] ?? ''
    if (KEY_FIELDS.some((f) => f.key === key) && !value.trim()) return
    await window.atlis.settings.set(key, value)
    setSavedKey(key)
    setTimeout(() => setSavedKey(null), 1200)
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-5 text-[15px] font-bold tracking-wide">SETTINGS</h1>

        {/* First, so it's findable when everything is too small to read. */}
        <DisplaySettings />

        <section className="rounded-lg border border-ink-600 bg-ink-800 p-5">
          <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
            <KeyRound size={13} className="text-volt-400" /> Provider credentials
          </div>
          <div className="space-y-4">
            {KEY_FIELDS.map((f) => (
              <div key={f.key}>
                <label className="mb-1 block text-[12px] font-medium text-mist-300">{f.label}</label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && save(f.key)}
                    placeholder="••••••••"
                    className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-3 py-1.5 font-mono text-[12px] text-mist-200 outline-none focus:border-volt-500"
                  />
                  <button
                    onClick={() => save(f.key)}
                    className="flex w-16 items-center justify-center gap-1 rounded-md border border-ink-600 text-[11px] text-mist-300 transition-colors hover:border-volt-500 hover:text-volt-400"
                  >
                    {savedKey === f.key ? <Check size={12} className="text-ok-400" /> : 'Save'}
                  </button>
                </div>
                <p className="mt-1 text-[10.5px] text-mist-500">{f.hint}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-4 rounded-lg border border-ink-600 bg-ink-800 p-5">
          <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
            <Cpu size={13} className="text-pulse-400" /> Local models (LM Studio)
          </div>
          <div className="flex gap-2">
            <input
              value={values['lmstudio_base_url'] ?? ''}
              onChange={(e) => setValues({ ...values, lmstudio_base_url: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && testLmStudio()}
              placeholder="http://127.0.0.1:1234/v1"
              className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-3 py-1.5 font-mono text-[12px] text-mist-200 outline-none focus:border-volt-500"
            />
            <button
              onClick={testLmStudio}
              className="flex w-24 items-center justify-center gap-1 rounded-md border border-ink-600 text-[11px] text-mist-300 transition-colors hover:border-volt-500 hover:text-volt-400"
            >
              {lmTest.busy ? <Loader2 size={12} className="animate-spin" /> : 'Save & test'}
            </button>
          </div>
          <p className={`mt-1 text-[10.5px] ${lmTest.text ? (lmTest.ok ? 'text-ok-400' : 'text-danger-400') : 'text-mist-500'}`}>
            {lmTest.text ??
              'LM Studio → Developer → Start Server. Blank uses the default port. For tool use, load the model with a context length of 16k or more — the 4k default overflows once tool definitions are included.'}
          </p>
        </section>

        <section className="mt-4 rounded-lg border border-ink-600 bg-ink-800 p-5">
          <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
            <FolderCog size={13} className="text-ember-400" /> Agent workspace
            <span className="font-normal normal-case tracking-normal text-mist-500">— fs_* tools are sandboxed to this folder</span>
          </div>
          <div className="flex gap-2">
            <input
              value={values['workspace_root'] ?? ''}
              onChange={(e) => setValues({ ...values, workspace_root: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && save('workspace_root')}
              placeholder="Defaults to your user folder — e.g. G:\Personal Repos"
              className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-3 py-1.5 font-mono text-[12px] text-mist-200 outline-none focus:border-volt-500"
            />
            <button
              onClick={() => save('workspace_root')}
              className="flex w-16 items-center justify-center gap-1 rounded-md border border-ink-600 text-[11px] text-mist-300 transition-colors hover:border-volt-500 hover:text-volt-400"
            >
              {savedKey === 'workspace_root' ? <Check size={12} className="text-ok-400" /> : 'Save'}
            </button>
          </div>
          <p className="mt-1 text-[10.5px] text-mist-500">
            Agents can list, read, write and edit files only inside this directory. Applies to new turns immediately.
          </p>
        </section>

        <AppSelector />

        <McpSettings />

        <AppsSettings />

        <DesktopSettings />

        <DiscordBotSettings />

        <AlertSettings />

        <section className="mt-4 rounded-lg border border-ink-600 bg-ink-800 p-5">
          <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
            <FolderKanban size={13} className="text-pulse-400" /> Projects
            <span className="font-normal normal-case tracking-normal text-mist-500">— attach sessions to projects to attribute usage</span>
          </div>
          <div className="mb-3 flex gap-2">
            <input
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter' && newProject.trim()) {
                  await window.atlis.projects.create(newProject.trim(), PROJECT_COLORS[projects.length % PROJECT_COLORS.length])
                  setNewProject('')
                  refreshProjects()
                }
              }}
              placeholder="New project name…"
              className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-3 py-1.5 text-[12px] outline-none focus:border-volt-500"
            />
            <button
              onClick={async () => {
                if (!newProject.trim()) return
                await window.atlis.projects.create(newProject.trim(), PROJECT_COLORS[projects.length % PROJECT_COLORS.length])
                setNewProject('')
                refreshProjects()
              }}
              className="flex items-center gap-1 rounded-md border border-ink-600 px-3 text-[11px] text-mist-300 hover:border-volt-500 hover:text-volt-400"
            >
              <Plus size={12} /> Add
            </button>
          </div>
          <div className="space-y-1">
            {projects.map((p) => (
              <div key={p.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-ink-700">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
                <span className="text-[12.5px]">{p.name}</span>
                <button
                  onClick={async () => {
                    await window.atlis.projects.remove(p.id)
                    refreshProjects()
                  }}
                  className="ml-auto hidden text-mist-500 hover:text-danger-400 group-hover:block"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {!projects.length && <p className="px-2 text-[11.5px] text-mist-500">No projects yet.</p>}
          </div>
        </section>

        <p className="mt-4 text-[10.5px] leading-relaxed text-mist-500">
          Keys are stored locally in ATLIS's SQLite database (%APPDATA%/atlis/atlis.db) and never leave this machine except
          in requests to the respective provider.
        </p>
      </div>
    </div>
  )
}
