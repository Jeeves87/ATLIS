import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  BellOff,
  Crosshair,
  ExternalLink,
  Flame,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  TrendingUp,
  Trash2,
  Users
} from 'lucide-react'
import type {
  DiscordReading,
  DropCandidateCounts,
  DropEvent,
  DropEventKind,
  DropProduct,
  DropWatch,
  TermReading
} from '../types'

const money = (v: number | null | undefined): string =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function ago(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Only the two that mean "you can buy this now" get the loud treatment. */
const EVENT_STYLE: Record<DropEventKind, { label: string; cls: string }> = {
  restock: { label: 'BACK IN STOCK', cls: 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10' },
  new_product: { label: 'new listing', cls: 'text-sky-300 border-sky-400/30 bg-sky-500/10' },
  price_change: { label: 'price', cls: 'text-amber-300 border-amber-400/30 bg-amber-500/10' },
  sold_out: { label: 'sold out', cls: 'text-white/40 border-white/10 bg-white/[0.03]' },
  removed: { label: 'delisted', cls: 'text-white/40 border-white/10 bg-white/[0.03]' }
}

/**
 * Drops — limited-run availability watching.
 *
 * The page is arranged around one question: is any of this buyable right now?
 * In-stock products sort to the top of every watch and carry the only strong
 * colour on the page, so the answer is readable at a glance from across a room
 * rather than something you have to go hunting for.
 */
export default function DropsView(): React.JSX.Element {
  const [watches, setWatches] = useState<DropWatch[]>([])
  const [products, setProducts] = useState<DropProduct[]>([])
  const [events, setEvents] = useState<DropEvent[]>([])
  const [alerts, setAlerts] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [hot, setHot] = useState(true)
  const [terms, setTerms] = useState<TermReading[]>([])
  const [pool, setPool] = useState<DropCandidateCounts | null>(null)
  const [pane, setPane] = useState<'activity' | 'demand' | 'community'>('activity')
  const [termInput, setTermInput] = useState('')
  const [discords, setDiscords] = useState<DiscordReading[]>([])
  const [inviteInput, setInviteInput] = useState('')

  const load = useCallback(async () => {
    const [w, p, e, a, t, c, d] = await Promise.all([
      window.atlis.drops.watches(),
      window.atlis.drops.products(undefined, false),
      window.atlis.drops.events({ limit: 120 }),
      window.atlis.drops.alertsEnabled(),
      window.atlis.signals.readAll(),
      window.atlis.drops.candidateCounts(),
      window.atlis.discord.readAll()
    ])
    setWatches(w)
    setProducts(p)
    setEvents(e)
    setAlerts(a)
    setTerms(t)
    setPool(c)
    setDiscords(d)
  }, [])

  useEffect(() => {
    void load()
    const offDrops = window.atlis.drops.onChanged(() => void load())
    const offSignals = window.atlis.signals.onChanged(() => void load())
    const offDiscord = window.atlis.discord.onChanged(() => void load())
    return () => {
      offDrops()
      offSignals()
      offDiscord()
    }
  }, [load])

  // Mark the timeline read on the way out, so the nav badge reflects what the
  // user has actually looked at rather than everything ever recorded.
  useEffect(() => () => void window.atlis.drops.markSeen(), [])

  const byWatch = useMemo(() => {
    const m = new Map<string, DropProduct[]>()
    for (const p of products) {
      const list = m.get(p.watch_id) ?? []
      list.push(p)
      m.set(p.watch_id, list)
    }
    return m
  }, [products])

  const liveCount = products.filter((p) => p.available === 1).length

  async function pollAll(): Promise<void> {
    setBusy(true)
    setStatus('Checking every watch…')
    try {
      const r = await window.atlis.drops.poll()
      const hits = r.transitions.filter((t) => t.kind === 'restock' || t.kind === 'new_product').length
      setStatus(
        r.errors.length
          ? `Checked ${r.watches}. ${r.errors.length} failed: ${r.errors[0]}`
          : hits
            ? `${hits} thing${hits === 1 ? '' : 's'} just became buyable.`
            : `Checked ${r.watches} watch${r.watches === 1 ? '' : 'es'} — no change.`
      )
      await load()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function addWatch(): Promise<void> {
    if (!url.trim()) return
    setAdding(true)
    setStatus(null)
    try {
      const w = await window.atlis.drops.add({
        url: url.trim(),
        label: label.trim() || undefined,
        priority: hot ? 'hot' : 'normal'
      })
      setStatus(
        w.kind === 'shopify'
          ? `Watching ${w.label} — Shopify catalogue, availability tracked per product.`
          : w.kind === 'wix'
            ? `Watching ${w.label} — Wix Stores catalogue, availability and stock counts tracked per product.`
            : `Watching ${w.label} — not a Shopify or Wix store, so this falls back to detecting that the page changed.`
      )
      setUrl('')
      setLabel('')
      await load()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  async function removeWatch(w: DropWatch): Promise<void> {
    if (!confirm(`Stop watching ${w.label}? Its product history and timeline go with it.`)) return
    await window.atlis.drops.remove(w.id)
    await load()
  }

  async function trackTerm(): Promise<void> {
    const t = termInput.trim()
    if (!t) return
    setTermInput('')
    setStatus(`Sampling what people search for "${t}"…`)
    try {
      const term = await window.atlis.signals.track(t)
      const r = await window.atlis.signals.sample(term.id)
      setStatus(`"${r.term}": ${r.suggestions} completions, intent score ${r.score}/100.`)
      await load()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  async function trackInvite(): Promise<void> {
    const v = inviteInput.trim()
    if (!v) return
    setInviteInput('')
    setStatus('Resolving invite\u2026')
    try {
      const w = await window.atlis.discord.track(v)
      setStatus(`Watching ${w.label}. Growth and presence build from here \u2014 a surge needs about a day of history.`)
      await load()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  async function toggleAlerts(): Promise<void> {
    const next = await window.atlis.drops.setAlertsEnabled(!alerts)
    setAlerts(next)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden text-white/80">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-4 py-2.5">
        <Crosshair className="h-4 w-4 text-rose-300/80" />
        <h2 className="text-sm font-semibold tracking-wide">Drops</h2>
        <span className="text-[11px] text-white/35">
          {liveCount > 0 ? (
            <span className="font-medium text-emerald-300">
              {liveCount} product{liveCount === 1 ? '' : 's'} buyable right now
            </span>
          ) : (
            `${watches.length} watch${watches.length === 1 ? '' : 'es'} · nothing in stock`
          )}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void toggleAlerts()}
            title={alerts ? 'Desktop notifications are on' : 'Desktop notifications are muted'}
            className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10"
          >
            {alerts ? <Bell className="h-3 w-3 text-emerald-300/80" /> : <BellOff className="h-3 w-3" />}
            {alerts ? 'alerts on' : 'muted'}
          </button>
          <button
            onClick={() => void pollAll()}
            disabled={busy}
            title="Check every enabled watch now"
            className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            check now
          </button>
        </div>
      </div>

      {/* add a watch */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-4 py-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addWatch()
          }}
          placeholder="https://store.example.com"
          className="min-w-[220px] flex-1 rounded border border-white/10 bg-black/20 px-2 py-1 text-[12px] outline-none placeholder:text-white/20 focus:border-rose-400/40"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="label (optional)"
          className="w-40 rounded border border-white/10 bg-black/20 px-2 py-1 text-[12px] outline-none placeholder:text-white/20 focus:border-rose-400/40"
        />
        <button
          onClick={() => setHot(!hot)}
          title={hot ? 'Polled every minute' : 'Polled every ten minutes'}
          className={`flex items-center gap-1 rounded border px-1.5 py-1 text-[11px] ${
            hot ? 'border-rose-400/30 bg-rose-500/10 text-rose-200' : 'border-white/10 text-white/40 hover:bg-white/5'
          }`}
        >
          <Flame className="h-3 w-3" />
          {hot ? 'hot · 1 min' : 'normal · 10 min'}
        </button>
        <button
          onClick={() => void addWatch()}
          disabled={adding || !url.trim()}
          className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-40"
        >
          {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          watch
        </button>
      </div>

      {status && (
        <div className="border-b border-white/5 px-4 py-1.5 text-[11px] text-white/45">{status}</div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* watches + products */}
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
          {watches.length === 0 && (
            <div className="mt-10 text-center text-[12px] text-white/30">
              Nothing watched yet. Paste a store URL above — if it runs on Shopify, every product&apos;s
              availability is tracked automatically.
            </div>
          )}

          {watches.map((w) => {
            const items = byWatch.get(w.id) ?? []
            const live = items.filter((p) => p.available === 1)
            return (
              <section key={w.id} className="mb-4 rounded-md border border-white/10 bg-white/[0.02]">
                <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
                  <span className="text-[13px] font-medium text-white/85">{w.label}</span>
                  {w.priority === 'hot' && (
                    <span className="flex items-center gap-1 rounded border border-rose-400/30 bg-rose-500/10 px-1 py-px text-[10px] text-rose-200">
                      <Flame className="h-2.5 w-2.5" />
                      hot
                    </span>
                  )}
                  {w.kind === 'page' && (
                    <span className="rounded border border-white/10 px-1 py-px text-[10px] text-white/35">
                      page watch
                    </span>
                  )}
                  <a
                    href={w.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[11px] text-white/35 hover:text-white/70"
                  >
                    {host(w.url)}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                  {live.length > 0 && (
                    <span className="rounded border border-emerald-400/40 bg-emerald-500/15 px-1.5 py-px text-[10px] font-semibold text-emerald-200">
                      {live.length} IN STOCK
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-2 text-[10px] text-white/30">
                    <span title={w.last_checked_at ? new Date(w.last_checked_at).toLocaleString() : undefined}>
                      checked {ago(w.last_checked_at)}
                    </span>
                    <button
                      onClick={() => void window.atlis.drops.poll(w.id).then(load)}
                      title="Check this watch now"
                      className="rounded border border-white/10 px-1 py-px text-white/40 hover:bg-white/10"
                    >
                      <RefreshCw className="h-2.5 w-2.5" />
                    </button>
                    <button
                      onClick={() => void removeWatch(w)}
                      title="Stop watching"
                      className="rounded border border-white/10 px-1 py-px text-white/40 hover:bg-rose-500/20 hover:text-rose-200"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </button>
                  </div>
                </div>

                {w.last_error && (
                  <div className="flex items-center gap-1.5 border-b border-amber-400/10 bg-amber-500/[0.06] px-3 py-1.5 text-[11px] text-amber-200/80">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    {w.last_error}
                  </div>
                )}

                {items.length === 0 ? (
                  <div className="px-3 py-3 text-[11px] text-white/25">
                    No products listed yet — the store is empty, which is exactly the state a drop ends.
                  </div>
                ) : (
                  <div className="divide-y divide-white/5">
                    {items.map((p) => (
                      <a
                        key={p.id}
                        href={p.url ?? w.url}
                        target="_blank"
                        rel="noreferrer"
                        className={`flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.04] ${
                          p.available === 1 ? 'bg-emerald-500/[0.07]' : ''
                        }`}
                      >
                        <span
                          className={`w-[70px] shrink-0 rounded border px-1 py-px text-center text-[10px] font-semibold ${
                            p.available === 1
                              ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
                              : 'border-white/10 text-white/30'
                          }`}
                        >
                          {p.available === 1 ? 'IN STOCK' : 'sold out'}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-white/75">{p.title}</span>
                        {p.variants_total > 1 && (
                          <span className="shrink-0 text-[10px] tabular-nums text-white/25">
                            {p.variants_available}/{p.variants_total}
                          </span>
                        )}
                        <span className="w-24 shrink-0 text-right text-[12px] tabular-nums text-white/60">
                          {money(p.price)}
                        </span>
                        <span
                          className="w-20 shrink-0 text-right text-[10px] tabular-nums text-white/25"
                          title={`first seen ${new Date(p.first_seen_at).toLocaleString()}`}
                        >
                          {ago(p.first_seen_at)}
                        </span>
                        <ExternalLink className="h-3 w-3 shrink-0 text-white/20" />
                      </a>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>

        {/* side panel: what happened, and what people are chasing */}
        <aside className="hidden w-[340px] shrink-0 flex-col overflow-hidden border-l border-white/5 lg:flex">
          <div className="flex items-center gap-1 border-b border-white/5 px-2 py-1.5">
            {(['activity', 'demand', 'community'] as const).map((id) => (
              <button
                key={id}
                onClick={() => setPane(id)}
                className={`rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                  pane === id ? 'bg-white/10 text-white/80' : 'text-white/35 hover:text-white/60'
                }`}
              >
                {id}
              </button>
            ))}
            {pool && (
              <span
                className="ml-auto pr-1 text-[10px] tabular-nums text-white/25"
                title="Discovery pool: probed / total, and how many were confirmed Shopify"
              >
                pool {pool.probed}/{pool.total} · {pool.shopify} shops
              </span>
            )}
          </div>

          {pane === 'demand' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
                <Search className="h-3 w-3 shrink-0 text-white/25" />
                <input
                  value={termInput}
                  onChange={(e) => setTermInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void trackTerm()
                  }}
                  placeholder="track a brand or product…"
                  className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-white/20"
                />
              </div>
              {terms.length === 0 ? (
                <div className="px-3 py-4 text-[11px] leading-relaxed text-white/25">
                  Nothing tracked. This reads Google&apos;s own autocomplete — a completion like
                  &ldquo;where to buy&rdquo; or &ldquo;restock&rdquo; only exists because enough people typed it,
                  so it measures purchase intent instead of guessing at sentiment.
                </div>
              ) : (
                terms.map((t) => (
                  <div key={t.id} className="border-b border-white/5 px-3 py-2">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="truncate text-[12px] font-medium text-white/80">{t.term}</span>
                      <span
                        className={`rounded border px-1 py-px text-[10px] font-semibold tabular-nums ${
                          t.score >= 40
                            ? 'border-rose-400/40 bg-rose-500/15 text-rose-200'
                            : t.score >= 15
                              ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                              : 'border-white/10 text-white/35'
                        }`}
                        title="Share of what people type about this that is about getting hold of it"
                      >
                        {t.score}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-white/25">
                        {t.days}d · {t.suggestions}
                      </span>
                      <button
                        onClick={() => void window.atlis.signals.untrack(t.id).then(load)}
                        className="rounded border border-white/10 px-1 py-px text-white/30 hover:bg-rose-500/20 hover:text-rose-200"
                        title="Stop tracking"
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </button>
                    </div>
                    <div className="mb-1 flex flex-wrap gap-1">
                      {(['scarcity', 'purchase', 'release', 'resale'] as const).map((k) =>
                        t.byIntent[k] ? (
                          <span key={k} className="rounded border border-white/10 px-1 py-px text-[9px] text-white/40">
                            {k} {t.byIntent[k]}
                          </span>
                        ) : null
                      )}
                    </div>
                    {t.days < 2 ? (
                      <div className="text-[10px] text-white/25">
                        One day of history — movement needs at least two.
                      </div>
                    ) : t.rising.length ? (
                      <div className="space-y-0.5">
                        {t.rising.slice(0, 5).map((m) => (
                          <div key={m.suggestion} className="flex items-center gap-1.5 text-[11px]">
                            <TrendingUp className="h-2.5 w-2.5 shrink-0 text-emerald-300/70" />
                            <span className="min-w-0 flex-1 truncate text-white/60">{m.suggestion}</span>
                            <span className="shrink-0 text-[9px] tabular-nums text-emerald-300/70">
                              {m.wasRank == null ? 'new' : `+${m.delta}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[10px] text-white/25">Nothing climbing this week.</div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {pane === 'community' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
                <Users className="h-3 w-3 shrink-0 text-white/25" />
                <input
                  value={inviteInput}
                  onChange={(e) => setInviteInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void trackInvite()
                  }}
                  placeholder="discord.gg/…"
                  className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-white/20"
                />
              </div>
              {discords.length === 0 ? (
                <div className="px-3 py-4 text-[11px] leading-relaxed text-white/25">
                  No servers watched. This reads only PUBLIC invite data — member count and how many are
                  online — never messages. Members climbing over days means a community forming; the share
                  online jumping above its own baseline means the room is filling up right now.
                </div>
              ) : (
                discords.map((d) => {
                  const hot = (d.surge ?? 0) >= 1.8
                  const warm = !hot && (d.surge ?? 0) >= 1.4
                  return (
                    <div key={d.id} className="border-b border-white/5 px-3 py-2">
                      <div className="mb-1 flex items-center gap-2">
                        <a
                          href={`https://discord.gg/${d.inviteCode}`}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 flex-1 truncate text-[12px] font-medium text-white/80 hover:text-white"
                        >
                          {d.label}
                        </a>
                        {d.surge != null && (
                          <span
                            className={`rounded border px-1 py-px text-[10px] font-semibold tabular-nums ${
                              hot
                                ? 'border-rose-400/40 bg-rose-500/15 text-rose-200'
                                : warm
                                  ? 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                                  : 'border-white/10 text-white/35'
                            }`}
                            title="How busy the server is versus its own baseline"
                          >
                            {d.surge}x
                          </span>
                        )}
                        <button
                          onClick={() => void window.atlis.discord.untrack(d.id).then(load)}
                          className="rounded border border-white/10 px-1 py-px text-white/30 hover:bg-rose-500/20 hover:text-rose-200"
                          title="Stop watching"
                        >
                          <Trash2 className="h-2.5 w-2.5" />
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-white/40">
                        <span>{d.members?.toLocaleString() ?? '\u2014'} members</span>
                        <span className={hot ? 'text-rose-200' : ''}>
                          {d.online?.toLocaleString() ?? '\u2014'} online
                          {d.presencePct != null ? ` (${d.presencePct}%)` : ''}
                        </span>
                        {d.baselinePct != null && <span className="text-white/25">usually {d.baselinePct}%</span>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[10px] tabular-nums">
                        {d.growth24h != null && (
                          <span className={d.growth24h > 0 ? 'text-emerald-300/70' : 'text-white/30'}>
                            {d.growth24h > 0 ? '+' : ''}
                            {d.growth24h.toLocaleString()} /24h
                          </span>
                        )}
                        {d.growth7d != null && (
                          <span className={d.growth7d > 0 ? 'text-emerald-300/70' : 'text-white/30'}>
                            {d.growth7d > 0 ? '+' : ''}
                            {d.growth7d.toLocaleString()} /7d
                            {d.growthPct7d != null ? ` (${d.growthPct7d}%)` : ''}
                          </span>
                        )}
                        {d.samples < 12 && (
                          <span className="text-white/25">{d.samples} samples — surge needs 12</span>
                        )}
                      </div>
                      {d.lastError && (
                        <div className="mt-0.5 truncate text-[10px] text-amber-200/70">{d.lastError}</div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          )}

          {pane === 'activity' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {events.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-white/25">
                Nothing recorded yet. Every restock, new listing and price move lands here with a timestamp —
                which is what makes &ldquo;how long was it up&rdquo; answerable after the fact.
              </div>
            ) : (
              events.map((e) => {
                const s = EVENT_STYLE[e.kind] ?? EVENT_STYLE.sold_out
                return (
                  <a
                    key={e.id}
                    href={e.url ?? '#'}
                    target="_blank"
                    rel="noreferrer"
                    className={`block border-b border-white/5 px-3 py-2 hover:bg-white/[0.04] ${
                      e.seen === 0 ? 'bg-white/[0.02]' : ''
                    }`}
                  >
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <span className={`rounded border px-1 py-px text-[9px] font-semibold uppercase ${s.cls}`}>
                        {s.label}
                      </span>
                      <span className="truncate text-[10px] text-white/30">{e.watch_label}</span>
                      <span
                        className="ml-auto shrink-0 text-[10px] tabular-nums text-white/25"
                        title={new Date(e.created_at).toLocaleString()}
                      >
                        {ago(e.created_at)}
                      </span>
                    </div>
                    <div className="truncate text-[12px] text-white/70">{e.title}</div>
                    {(e.detail || e.price != null) && (
                      <div className="truncate text-[10px] text-white/35">
                        {[e.price != null ? money(e.price) : null, e.detail].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </a>
                )
              })
            )}
          </div>
          )}
        </aside>
      </div>
    </div>
  )
}
