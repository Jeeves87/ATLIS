import { useCallback, useEffect, useState } from 'react'
import { BellRing, Check, Loader2, Send } from 'lucide-react'
import type { AlertsConfig } from '../types'

/**
 * Where a drop alert goes. The desktop notification has always existed and
 * needs no configuration; Discord is the one that reaches a phone, so this
 * section is mostly about getting one URL pasted correctly and then PROVING
 * it works — a webhook that silently does nothing is worse than none at all,
 * which is why the test button bypasses every filter between here and Discord.
 */
export default function AlertSettings() {
  const [cfg, setCfg] = useState<AlertsConfig | null>(null)
  const [webhook, setWebhook] = useState('')
  const [mention, setMention] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const load = useCallback(async () => {
    const c = await window.atlis.alerts.config()
    setCfg(c)
    setWebhook(c.discord.webhook)
    setMention(c.discord.mention)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Main throws a readable message; Electron wraps it in its own IPC preamble.
  const clean = (err: unknown): string =>
    String(err instanceof Error ? err.message : err).replace(/^.*?Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')

  async function save(field: 'webhook' | 'mention'): Promise<void> {
    setStatus(null)
    try {
      const next = await window.atlis.alerts.setDiscord(field === 'webhook' ? { webhook } : { mention })
      setCfg((c) => (c ? { ...c, discord: next } : c))
      setSaved(field)
      setTimeout(() => setSaved(null), 1200)
      await load()
    } catch (err) {
      setStatus({ tone: 'bad', text: clean(err) })
    }
  }

  async function test(): Promise<void> {
    setTesting(true)
    setStatus(null)
    try {
      const r = await window.atlis.alerts.test()
      if (r.errors.length) setStatus({ tone: 'bad', text: r.errors.join(' · ') })
      else if (!r.delivered.length)
        setStatus({ tone: 'bad', text: 'No sink is configured — paste a webhook above, or check that notifications are allowed.' })
      else setStatus({ tone: 'ok', text: `Delivered to ${r.delivered.join(' and ')}.` })
    } catch (err) {
      setStatus({ tone: 'bad', text: clean(err) })
    } finally {
      setTesting(false)
    }
  }

  const sinkReady = (name: string): boolean => cfg?.sinks.find((s) => s.name === name)?.ready ?? false

  return (
    <section className="mt-4 rounded-lg border border-ink-600 bg-ink-800 p-5">
      <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
        <BellRing size={13} className="text-ember-400" /> Drop alerts
        <span className="font-normal normal-case tracking-normal text-mist-500">
          — where a restock goes when it is found
        </span>
      </div>

      <div>
        <label className="mb-1 block text-[12px] font-medium text-mist-300">Discord webhook</label>
        <div className="flex gap-2">
          <input
            type="password"
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save('webhook')}
            placeholder="https://discord.com/api/webhooks/…"
            className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-3 py-1.5 font-mono text-[12px] text-mist-200 outline-none focus:border-volt-500"
          />
          <button
            onClick={() => void save('webhook')}
            className="flex w-16 items-center justify-center gap-1 rounded-md border border-ink-600 text-[11px] text-mist-300 transition-colors hover:border-volt-500 hover:text-volt-400"
          >
            {saved === 'webhook' ? <Check size={12} className="text-ok-400" /> : 'Save'}
          </button>
        </div>
        <p className="mt-1 text-[10.5px] leading-relaxed text-mist-500">
          Channel Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL. Set that channel to{' '}
          <span className="text-mist-400">All Messages</span> on your phone and a restock reaches you whether or not
          ATLIS is in front of you. Clear the field and save to turn Discord off.
        </p>
      </div>

      <div className="mt-4">
        <label className="mb-1 block text-[12px] font-medium text-mist-300">Ping (optional)</label>
        <div className="flex gap-2">
          <input
            value={mention}
            onChange={(e) => setMention(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save('mention')}
            placeholder="<@your-user-id>"
            className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-3 py-1.5 font-mono text-[12px] text-mist-200 outline-none focus:border-volt-500"
          />
          <button
            onClick={() => void save('mention')}
            className="flex w-16 items-center justify-center gap-1 rounded-md border border-ink-600 text-[11px] text-mist-300 transition-colors hover:border-volt-500 hover:text-volt-400"
          >
            {saved === 'mention' ? <Check size={12} className="text-ok-400" /> : 'Save'}
          </button>
        </div>
        <p className="mt-1 text-[10.5px] leading-relaxed text-mist-500">
          A mention is what turns a message into a phone push rather than a badge. Developer Mode on → right-click
          yourself → Copy User ID and paste it straight in; it is saved as{' '}
          <span className="font-mono text-mist-400">&lt;@id&gt;</span>, the only form Discord pings. Typing @name
          does not work — webhooks post it as plain text.
          {cfg?.discord.mention && (
            <span className={cfg.discord.pings ? ' text-ok-400' : ' text-danger-400'}>
              {cfg.discord.pings ? ' Will ping.' : ' This will post as text and will not ping.'}
            </span>
          )}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-ink-700 pt-3">
        <button
          onClick={() => void test()}
          disabled={testing}
          className="flex items-center gap-1.5 rounded-md border border-ink-600 px-3 py-1.5 text-[11px] text-mist-300 transition-colors hover:border-volt-500 hover:text-volt-400 disabled:opacity-40"
        >
          {testing ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          Send a test alert
        </button>
        <span className="text-[10.5px] text-mist-500">
          desktop{' '}
          <span className={sinkReady('desktop') ? 'text-ok-400' : 'text-mist-400'}>
            {sinkReady('desktop') ? 'ready' : 'unavailable'}
          </span>{' '}
          · discord{' '}
          <span className={sinkReady('discord') ? 'text-ok-400' : 'text-mist-400'}>
            {sinkReady('discord') ? 'ready' : 'not configured'}
          </span>
        </span>
        {status && (
          <span className={`text-[10.5px] ${status.tone === 'ok' ? 'text-ok-400' : 'text-danger-400'}`}>
            {status.text}
          </span>
        )}
      </div>

      <p className="mt-3 text-[10.5px] leading-relaxed text-mist-500">
        Restocks and new listings are loud by default; sold-out and price changes stay on the timeline only. The same
        product will not alert twice within {cfg ? Math.round(cfg.defaultCooldownMs / 60000) : 30} minutes — an
        abandoned checkout releases stock and makes the availability flag blink, which without that window is four
        pings for one drop.
      </p>
    </section>
  )
}
