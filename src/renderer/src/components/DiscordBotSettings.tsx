import { useCallback, useEffect, useState } from 'react'
import { Bot, Check, ExternalLink, Loader2, RotateCw } from 'lucide-react'
import type { DiscordBotConfig, DiscordBotStatus } from '../types'

const PROVIDERS = [
  { id: 'lmstudio', label: 'LM Studio (local)' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'copilot', label: 'Copilot' }
]

const STATE_TONE: Record<DiscordBotStatus['state'], string> = {
  off: 'bg-mist-500',
  connecting: 'bg-ember-400 animate-pulse',
  online: 'bg-ok-400',
  error: 'bg-danger-400'
}

/**
 * The inbound half of Discord: a bot you message, answered by the agent.
 * The allowlist is the part that matters — until it holds an id the bot
 * answers nobody, because the agent behind it can read the whole database.
 */
export default function DiscordBotSettings() {
  const [cfg, setCfg] = useState<DiscordBotConfig | null>(null)
  const [status, setStatus] = useState<DiscordBotStatus | null>(null)
  const [token, setToken] = useState('')
  const [users, setUsers] = useState('')
  const [channels, setChannels] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clean = (err: unknown): string =>
    String(err instanceof Error ? err.message : err).replace(/^.*?Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([window.atlis.discordBot.config(), window.atlis.discordBot.status()])
    setCfg(c)
    setStatus(s)
    setUsers(c.allowedUsers.join(', '))
    setChannels(c.channels.join(', '))
    setModel(c.model)
  }, [])

  useEffect(() => {
    void load()
    return window.atlis.discordBot.onChanged(setStatus)
  }, [load])

  useEffect(() => {
    if (!cfg) return
    setModels([])
    setModelsError(null)
    window.atlis.providers.models(cfg.provider).then((r) => {
      if (r.ok && r.models) setModels(r.models.map((m) => m.id))
      else setModelsError(r.error ?? 'Could not list models.')
    })
  }, [cfg?.provider])

  async function patch(p: Parameters<typeof window.atlis.discordBot.setConfig>[0], field?: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const next = await window.atlis.discordBot.setConfig(p)
      setCfg(next)
      if (field) {
        setSaved(field)
        setTimeout(() => setSaved(null), 1200)
      }
    } catch (err) {
      setError(clean(err))
    } finally {
      setBusy(false)
    }
  }

  const input =
    'min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-3 py-1.5 font-mono text-[12px] text-mist-200 outline-none focus:border-volt-500'
  const btn =
    'flex w-16 items-center justify-center gap-1 rounded-md border border-ink-600 text-[11px] text-mist-300 transition-colors hover:border-volt-500 hover:text-volt-400 disabled:opacity-40'
  const tick = (field: string, label = 'Save') => (saved === field ? <Check size={12} className="text-ok-400" /> : label)

  if (!cfg) return null

  return (
    <section className="mt-4 rounded-lg border border-ink-600 bg-ink-800 p-5">
      <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
        <Bot size={13} className="text-pulse-400" /> Discord bot
        <span className="font-normal normal-case tracking-normal text-mist-500">— message ATLIS from Discord</span>
        <label className="ml-auto flex cursor-pointer items-center gap-2 font-normal normal-case tracking-normal text-mist-300">
          <input
            type="checkbox"
            checked={cfg.enabled}
            disabled={busy}
            onChange={(e) => void patch({ enabled: e.target.checked })}
            className="accent-volt-500"
          />
          Enabled
        </label>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-[11.5px]">
        <span className={`h-2 w-2 rounded-full ${status ? STATE_TONE[status.state] : 'bg-mist-500'}`} />
        <span className="text-mist-300">
          {status?.state === 'online' ? `Online as ${status.botUser}` : status?.state ?? 'off'}
        </span>
        {status?.lastMessageAt && (
          <span className="text-mist-500">· last message {new Date(status.lastMessageAt).toLocaleTimeString()}</span>
        )}
        {status?.inviteUrl && (
          <a
            href={status.inviteUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex items-center gap-1 text-volt-400 hover:underline"
          >
            Invite to a server <ExternalLink size={11} />
          </a>
        )}
        <button
          onClick={async () => setStatus(await window.atlis.discordBot.restart())}
          disabled={!cfg.enabled}
          title="Reconnect"
          className={`${status?.inviteUrl ? '' : 'ml-auto'} rounded border border-ink-600 p-1 text-mist-400 hover:border-volt-500 hover:text-volt-400 disabled:opacity-30`}
        >
          <RotateCw size={11} />
        </button>
        {status?.error && <p className="w-full text-danger-400">{status.error}</p>}
        {status?.note && <p className="w-full text-ember-400">{status.note}</p>}
      </div>

      <div>
        <label className="mb-1 block text-[12px] font-medium text-mist-300">
          Bot token {cfg.hasToken && <span className="font-normal text-ok-400">· saved</span>}
        </label>
        <div className="flex gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && token.trim() && void patch({ token }, 'token').then(() => setToken(''))}
            placeholder={cfg.hasToken ? '•••••••• (paste to replace)' : 'Bot token from the Developer Portal'}
            className={input}
          />
          <button
            disabled={!token.trim() || busy}
            onClick={() => void patch({ token }, 'token').then(() => setToken(''))}
            className={btn}
          >
            {tick('token')}
          </button>
        </div>
        <p className="mt-1 text-[10.5px] leading-relaxed text-mist-500">
          discord.com/developers/applications → New Application → Bot → Reset Token. On the same page, turn on{' '}
          <span className="text-mist-400">Message Content Intent</span> if you want it to read a whole channel (DMs and
          @mentions work without it). Then use “Invite to a server” above once it is online.
        </p>
      </div>

      <div className="mt-4">
        <label className="mb-1 block text-[12px] font-medium text-mist-300">Allowed Discord user ids</label>
        <div className="flex gap-2">
          <input
            value={users}
            onChange={(e) => setUsers(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void patch({ allowedUsers: users }, 'users')}
            placeholder="123456789012345678"
            className={input}
          />
          <button onClick={() => void patch({ allowedUsers: users }, 'users')} disabled={busy} className={btn}>
            {tick('users')}
          </button>
        </div>
        <p className="mt-1 text-[10.5px] leading-relaxed text-mist-500">
          The bot answers these people only and ignores everyone else silently. Discord → Settings → Advanced →
          Developer Mode, then right-click yourself → Copy User ID.
          {!cfg.allowedUsers.length && <span className="text-ember-400"> Empty = it answers nobody.</span>}
        </p>
      </div>

      <div className="mt-4">
        <label className="mb-1 block text-[12px] font-medium text-mist-300">Listen channels (optional)</label>
        <div className="flex gap-2">
          <input
            value={channels}
            onChange={(e) => setChannels(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void patch({ channels }, 'channels')}
            placeholder="channel ids — answers every message there without an @mention"
            className={input}
          />
          <button onClick={() => void patch({ channels }, 'channels')} disabled={busy} className={btn}>
            {tick('channels')}
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-mist-300">Provider</label>
          <select
            value={cfg.provider}
            onChange={(e) => void patch({ provider: e.target.value, model: '' }).then(() => setModel(''))}
            className="w-full rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-[12px] text-mist-200 outline-none focus:border-volt-500"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-mist-300">Model</label>
          <div className="flex gap-2">
            <input
              list="discord-bot-models"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void patch({ model }, 'model')}
              placeholder={cfg.provider === 'lmstudio' ? 'blank = first loaded model' : 'model id'}
              className={input}
            />
            <datalist id="discord-bot-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <button onClick={() => void patch({ model }, 'model')} disabled={busy} className={btn}>
              {busy && saved !== 'model' ? <Loader2 size={12} className="animate-spin" /> : tick('model')}
            </button>
          </div>
        </div>
      </div>
      {modelsError && <p className="mt-1 text-[10.5px] text-danger-400">{modelsError}</p>}

      <label className="mt-4 flex cursor-pointer items-start gap-2 text-[12px] text-mist-300">
        <input
          type="checkbox"
          checked={cfg.allowWrites}
          onChange={(e) => void patch({ allowWrites: e.target.checked })}
          className="mt-0.5 accent-volt-500"
        />
        <span>
          Allow changes
          <span className="block text-[10.5px] leading-relaxed text-mist-500">
            Off: read-only (collection, prices, Vault, planner, feed, and read-only SQL over the database). On: also
            add watchlist entries, to-dos, reminders, calendar events and memories. Shell, files, browser and desktop
            control are never available from Discord.
          </span>
        </span>
      </label>

      {error && <p className="mt-3 text-[10.5px] text-danger-400">{error}</p>}

      <p className="mt-3 border-t border-ink-700 pt-3 text-[10.5px] leading-relaxed text-mist-500">
        DM the bot, @mention it, or reply to it. Each channel becomes a session in Chat, so you can follow its tool
        calls and continue from here. In Discord: <span className="font-mono text-mist-400">!new</span> resets the
        conversation, <span className="font-mono text-mist-400">!stop</span> cancels,{' '}
        <span className="font-mono text-mist-400">!status</span> shows the model.
      </p>
    </section>
  )
}
