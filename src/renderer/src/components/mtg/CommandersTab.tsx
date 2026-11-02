/**
 * "Which of my legendary creatures is anyone actually building?"
 *
 * A vault can say you own 40 legends. It cannot say which of them are real
 * commanders — that is a fact about the wider format, not about the card, so
 * it comes from EDHREC's aggregated decklists.
 *
 * The honest framing matters here and drives the whole layout: EDHREC
 * publishes the top ~100 commanders per colour identity, so a card missing
 * from that list is "outside the top 100 of its colours", NOT "zero decks".
 * Yargle has 312 real decks and still does not chart in mono-black. Labelling
 * the unranked rows "nobody plays this" would be a lie the data cannot support,
 * so they are shown as unranked with a link to go look.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Crown, ExternalLink, Loader2, RefreshCw, Search, X } from 'lucide-react'
import ProductThumb from './ProductThumb'
import { imageFor } from '../../lib/mtgImages'
import type { MtgOwnedCommander } from '../../types'

const money = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })

/** Solid pip fills, matching the Owned tab's identity dots. */
const PIP_DOT: Record<string, string> = {
  W: 'bg-amber-100', U: 'bg-sky-400', B: 'bg-violet-400',
  R: 'bg-red-400', G: 'bg-emerald-400', C: 'bg-white/40'
}

/**
 * How well-played a commander is, as a band rather than a raw number.
 *
 * The user's question is "is anyone other than one weirdo playing this",
 * which is a threshold question, not a ranking one — 8,000 decks and 9,000
 * decks mean the same thing in practice, while 8,000 and 80 do not.
 */
function tierOf(numDecks: number | null): { label: string; cls: string; hint: string } {
  if (numDecks == null) return {
    label: 'Unranked',
    cls: 'bg-white/10 text-white/50',
    hint: 'Outside EDHREC’s top 100 for its colours — it may still have real decks, just not many'
  }
  if (numDecks >= 10_000) return {
    label: 'Staple', cls: 'bg-emerald-500/25 text-emerald-200',
    hint: 'A mainstream commander with a deep, well-documented deck pool'
  }
  if (numDecks >= 2_000) return {
    label: 'Popular', cls: 'bg-sky-500/25 text-sky-200',
    hint: 'Plenty of decks to crib from'
  }
  if (numDecks >= 500) return {
    label: 'Niche', cls: 'bg-amber-500/25 text-amber-200',
    hint: 'A real but small following — lists exist, fewer of them'
  }
  return {
    label: 'Fringe', cls: 'bg-white/10 text-white/50',
    hint: 'Charts, but barely — expect to brew rather than netdeck'
  }
}

export default function CommandersTab({ onStatus }: { onStatus: (s: string | null) => void }): React.JSX.Element {
  const [rows, setRows] = useState<MtgOwnedCommander[]>([])
  const [stats, setStats] = useState<{ rows: number; synced_at: number | null } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [query, setQuery] = useState('')
  const [rankedOnly, setRankedOnly] = useState(false)

  const load = useCallback(async () => {
    const [r, s] = await Promise.all([
      window.atlis.mtg.commanders(),
      window.atlis.mtg.commanderStats()
    ])
    setRows(r)
    setStats(s)
  }, [])

  useEffect(() => { void load() }, [load])

  const sync = useCallback(async () => {
    setSyncing(true)
    onStatus('Pulling commander popularity from EDHREC…')
    try {
      const r = await window.atlis.mtg.syncCommanders()
      await load()
      onStatus(
        `${r.commanders.toLocaleString()} commanders across ${r.colors} colour identities.` +
        (r.failed.length ? ` ${r.failed.length} colour(s) failed: ${r.failed[0]}` : '')
      )
    } catch (e) {
      onStatus(`Commander sync failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSyncing(false)
    }
  }, [load, onStatus])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      if (rankedOnly && r.num_decks == null) return false
      if (!q) return true
      return `${r.name} ${r.type_line ?? ''} ${r.set_code ?? ''}`.toLowerCase().includes(q)
    })
  }, [rows, query, rankedOnly])

  const rankedCount = useMemo(() => rows.filter((r) => r.num_decks != null).length, [rows])

  // No popularity data at all is a different problem from no legends owned,
  // and needs a different prompt — so it gets checked first.
  if (stats && stats.rows === 0) {
    return (
      <div className="p-6 text-center">
        <Crown className="mx-auto mb-3 h-8 w-8 text-white/20" />
        <p className="mb-1 text-sm text-white/70">No commander popularity data yet.</p>
        <p className="mx-auto mb-4 max-w-md text-xs text-white/40">
          ATLIS pulls the top ~100 commanders for each of the 32 colour identities from EDHREC — about 2,700
          commanders in total. One sync, then it can tell you which of your legends people actually build.
        </p>
        <button
          onClick={() => void sync()}
          disabled={syncing}
          className="inline-flex items-center gap-2 rounded-md border border-violet-400/40 bg-violet-500/20 px-3 py-1.5 text-sm text-violet-100 hover:bg-violet-500/30 disabled:opacity-50"
        >
          {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Pull commander data
        </button>
      </div>
    )
  }

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">
          Commanders — legends I own that people actually build
        </h2>
        <button
          onClick={() => void sync()}
          disabled={syncing}
          title="Refresh the EDHREC popularity table (32 requests, ~15s)"
          className="ml-auto flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-50"
        >
          {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refresh popularity
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-white/40">
          No legendary creatures in your collection yet — or the Owned tab has not synced card details.
          Open Owned once and the types fill in.
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your legends…"
                className="w-full rounded-md border border-white/10 bg-white/[0.03] py-1.5 pl-8 pr-8 text-sm placeholder:text-white/25 focus:border-violet-400/50 focus:outline-none"
              />
              {query && (
                <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <button
              onClick={() => setRankedOnly((v) => !v)}
              className={`rounded border px-2 py-1 text-[11px] ${
                rankedOnly ? 'border-violet-400/50 bg-violet-500/20 text-violet-200' : 'border-white/10 text-white/45 hover:bg-white/10'
              }`}
            >
              Charting only
            </button>
            <span className="text-[11px] tabular-nums text-white/40">
              {rankedCount} of {rows.length} chart on EDHREC
            </span>
          </div>

          <div className="space-y-1.5">
            {visible.map((c) => {
              const tier = tierOf(c.num_decks)
              const letters = c.color_identity ? c.color_identity.split(',') : ['C']
              return (
                <div
                  key={c.id}
                  className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2"
                >
                  <ProductThumb
                    image={imageFor({ extSource: c.ext_source, extId: c.ext_id }, 'small')}
                    alt={c.name}
                    size="sm"
                    icon={Crown}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm">{c.name}</span>
                      <span className="inline-flex shrink-0 items-center gap-0.5">
                        {letters.map((l) => (
                          <span key={l} className={`inline-block h-2 w-2 rounded-full ${PIP_DOT[l] ?? 'bg-white/30'}`} />
                        ))}
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-white/45">
                      {c.type_line ?? '—'}
                      {c.set_code ? ` · ${c.set_code.toUpperCase()}` : ''}
                      {c.quantity > 1 ? ` · ×${c.quantity}` : ''}
                    </div>
                  </div>

                  <div className="w-28 shrink-0 text-right">
                    <div className="text-sm tabular-nums">
                      {c.num_decks == null ? '—' : c.num_decks.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-white/35">
                      {c.num_decks == null ? 'not in top 100' : 'decks'}
                      {c.rank_in_color != null && c.color_slug ? ` · #${c.rank_in_color} ${c.color_slug}` : ''}
                    </div>
                  </div>

                  <span title={tier.hint} className={`w-20 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] ${tier.cls}`}>
                    {tier.label}
                  </span>

                  <div className="w-16 shrink-0 text-right text-[11px] tabular-nums text-white/40">
                    {money(c.last_price)}
                  </div>

                  <a
                    href={c.edhrec_url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open on EDHREC"
                    className="shrink-0 rounded border border-white/10 p-1.5 text-white/40 hover:bg-white/10 hover:text-white/80"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              )
            })}
            {visible.length === 0 && (
              <p className="text-sm text-white/40">No legend matches that filter.</p>
            )}
          </div>

          {stats?.synced_at != null && (
            <p className="mt-3 text-[11px] text-white/30">
              Popularity from EDHREC, {stats.rows.toLocaleString()} commanders, synced{' '}
              {new Date(stats.synced_at).toLocaleDateString()}. Unranked means outside the top 100 for that
              colour identity — not that the deck count is zero.
            </p>
          )}
        </>
      )}
    </section>
  )
}
