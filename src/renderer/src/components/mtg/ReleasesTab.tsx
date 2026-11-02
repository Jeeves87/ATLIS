import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, ExternalLink, Gift, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import type { MtgSet, MtgPreorderSet, MtgSlUpcomingDrop } from '../../types'
import ProductThumb from './ProductThumb'
import { tcgplayerImage } from '../../lib/mtgImages'

const money = (v: number | null | undefined): string =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Days until a YYYY-MM-DD date, local. Negative means it already happened. */
function daysUntil(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return NaN
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((then - today.getTime()) / 86_400_000)
}

function countdown(ymd: string | null): string {
  if (!ymd) return 'TBA'
  const d = daysUntil(ymd)
  if (!isFinite(d)) return ymd
  if (d === 0) return 'today'
  if (d === 1) return 'tomorrow'
  if (d < 0) return `${-d}d ago`
  if (d < 60) return `in ${d}d`
  return `in ${Math.round(d / 30)}mo`
}

/** Month heading for the timeline, e.g. "September 2026". */
function monthLabel(ymd: string | null): string {
  if (!ymd) return 'Date to be announced'
  const m = /^(\d{4})-(\d{2})/.exec(ymd)
  if (!m) return ymd
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  })
}

type Entry =
  | { kind: 'set'; key: string; date: string | null; set: MtgSet; preorder: MtgPreorderSet | null }
  | { kind: 'lair'; key: string; date: string | null; drop: MtgSlUpcomingDrop }

/**
 * Everything that has not come out yet, on one timeline: Wizards set releases
 * (with whatever collector-grade preorders have been found for them) and
 * announced Secret Lair superdrops.
 *
 * The two feeds are merged rather than stacked because the only question this
 * page answers is "what is coming, and when do I need money ready" — and a
 * Secret Lair drop landing between two set releases is exactly the sort of
 * collision the split view used to hide.
 */
export default function ReleasesTab({
  onStatus,
  onShowCards
}: {
  onStatus?: (msg: string | null) => void
  /** Open a Secret Lair product's card list in the Set search. */
  onShowCards?: (productName: string) => void
}): React.JSX.Element {
  const [sets, setSets] = useState<MtgSet[]>([])
  const [preorders, setPreorders] = useState<MtgPreorderSet[]>([])
  const [lairs, setLairs] = useState<MtgSlUpcomingDrop[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [syncingLairs, setSyncingLairs] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const [u, b, l] = await Promise.all([
      window.atlis.mtg.upcoming(540),
      window.atlis.mtg.preorderBoard(),
      window.atlis.mtg.secretLairUpcoming()
    ])
    setSets(u)
    setPreorders(b)
    setLairs(l)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
    return window.atlis.mtg.onChanged(() => void load())
  }, [load])

  useEffect(() => window.atlis.mtg.onPreorderProgress((p) => setScanNote(p.message)), [])

  async function scan(): Promise<void> {
    setScanning(true)
    setScanNote('Starting…')
    try {
      const r = await window.atlis.mtg.scanPreorders()
      setScanNote(
        `${r.found} listing(s) across ${r.products} collector product(s) in ${r.sets} set(s).` +
          (r.errors.length ? ` ${r.errors[0]}` : '')
      )
      await load()
    } catch (err) {
      setScanNote(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }

  async function syncLairs(): Promise<void> {
    setSyncingLairs(true)
    try {
      const r = await window.atlis.mtg.syncSecretLair()
      onStatus?.(r.note ?? `${r.count} announced lair(s) across ${r.drops} drop(s).`)
      await load()
    } finally {
      setSyncingLairs(false)
    }
  }

  const entries = useMemo<Entry[]>(() => {
    const byDate = new Map<string, MtgPreorderSet>()
    for (const p of preorders) byDate.set(p.setCode, p)
    const rows: Entry[] = [
      ...sets.map<Entry>((s) => ({
        kind: 'set',
        key: `set:${s.code}`,
        date: s.released_at,
        set: s,
        preorder: byDate.get(s.code) ?? null
      })),
      ...lairs.map<Entry>((d) => ({ kind: 'lair', key: `lair:${d.dropId}`, date: d.releaseDate, drop: d }))
    ]
    // Undated things sort last: "TBA" is not a date, and floating it to the top
    // would push real, imminent releases below the noise.
    return rows.sort(
      (a, b) =>
        Number(!a.date) - Number(!b.date) ||
        (a.date ?? '').localeCompare(b.date ?? '') ||
        a.key.localeCompare(b.key)
    )
  }, [sets, preorders, lairs])

  /** Month headings, computed once so the list can stay a flat map. */
  const headings = useMemo(() => {
    const seen = new Set<string>()
    const out = new Map<string, string>()
    for (const e of entries) {
      const label = monthLabel(e.date)
      if (!seen.has(label)) {
        seen.add(label)
        out.set(e.key, label)
      }
    }
    return out
  }, [entries])

  return (
    <div className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">Releases</h2>
        <span className="text-[11px] text-white/30">
          {sets.length} set{sets.length === 1 ? '' : 's'} · {lairs.length} Secret Lair drop
          {lairs.length === 1 ? '' : 's'} announced
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void syncLairs()}
            disabled={syncingLairs}
            title="Re-pull the announced Secret Lair list"
            className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-50"
          >
            {syncingLairs ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Secret Lairs
          </button>
          <button
            onClick={() => void scan()}
            disabled={scanning}
            title="Check Target, Best Buy, Amazon and TCGplayer for collector-grade preorders. Takes a couple of minutes."
            className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-50"
          >
            {scanning && <Loader2 className="h-3 w-3 animate-spin" />}
            Scan preorders
          </button>
        </div>
      </div>

      {scanNote && (
        <p className="mb-3 truncate rounded-md border border-violet-400/20 bg-violet-500/10 px-2.5 py-1.5 text-[11px] text-violet-200">
          {scanNote}
        </p>
      )}

      <p className="mb-4 text-[11px] leading-relaxed text-white/30">
        Preorder scanning is deliberately limited to <strong className="text-white/50">collector-grade</strong>{' '}
        product — Collector Boosters in any form, Collector Commander decks, and signature or serialized editions.
        Play Boosters, bundles and plain Commander decks sit on shelves for months and are not tracked. Street dates
        and prerelease weekends (street − 7d) are mirrored into Planner, so reminders fire there.
      </p>

      {loading ? (
        <div className="flex justify-center py-10 text-white/40">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-white/40">
          Nothing upcoming cached. Hit “Sync sets” in the header to pull the release calendar.
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <div key={e.key}>
              {headings.has(e.key) && (
                <h3 className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wider text-white/25 first:mt-0">
                  {headings.get(e.key)}
                </h3>
              )}
              {e.kind === 'set' ? <SetCard entry={e} /> : <LairCard drop={e.drop} onShowCards={onShowCards} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SetCard({ entry }: { entry: Extract<Entry, { kind: 'set' }> }): React.JSX.Element {
  const { set, preorder } = entry
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <CalendarDays className="h-3.5 w-3.5 shrink-0 self-center text-white/30" />
        <span className="text-sm font-medium">{set.name}</span>
        <span className="text-[11px] text-violet-300">{countdown(set.released_at)}</span>
        <span className="text-[11px] text-white/30">
          {set.code.toUpperCase()} · {set.set_type?.replace(/_/g, ' ')} · {set.released_at ?? 'TBA'}
        </span>
      </div>

      {preorder?.products.length ? (
        <div className="mt-2 space-y-1.5 border-t border-white/5 pt-2">
          {preorder.products.map((p) => (
            <div key={p.uuid} className="flex items-start gap-2.5">
              <ProductThumb
                image={p.tcgplayerProductId ? tcgplayerImage(p.tcgplayerProductId, 'small') : null}
                alt={p.name}
                size="sm"
              />
              <div className="min-w-0 flex-1">
              <div className="text-[11px] text-white/55">{p.name.replace(set.name + ' ', '')}</div>
              <div className="mt-0.5 flex flex-wrap gap-1.5">
                {p.listings
                  .filter((l) => l.kind !== 'search')
                  .map((l) => {
                    const tone =
                      l.status === 'preorder'
                        ? 'border-amber-400/40 bg-amber-400/10 text-amber-200'
                        : l.status === 'in_stock' || l.status === 'in_store_only'
                          ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                          : l.status === 'sold_out_restocking'
                            ? 'border-orange-400/40 bg-orange-400/10 text-orange-200'
                            : l.status === 'out_of_stock'
                              ? 'border-white/10 text-white/30'
                              : 'border-white/10 text-white/40'
                    return (
                      <a
                        key={l.id}
                        href={l.url}
                        target="_blank"
                        rel="noreferrer"
                        title={l.last_error ?? l.url}
                        className={`rounded border px-1.5 py-0.5 text-[11px] hover:brightness-125 ${tone}`}
                      >
                        {l.retailer}
                        {l.status === 'preorder'
                          ? ' · preorder'
                          : l.status === 'in_store_only'
                            ? ' · in store'
                            : l.status === 'sold_out_restocking'
                              ? ' · restocking'
                              : l.status === 'listed'
                                ? ' · listed'
                                : l.status === 'out_of_stock'
                                  ? ' · out'
                                  : ''}
                        {l.price != null && ` ${money(l.price)}`}
                      </a>
                    )
                  })}
              </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function LairCard({ drop, onShowCards }: { drop: MtgSlUpcomingDrop; onShowCards?: (name: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border border-fuchsia-400/20 bg-fuchsia-500/[0.06] p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Gift className="h-3.5 w-3.5 shrink-0 self-center text-fuchsia-300/80" />
        <span className="text-sm font-medium">{drop.dropName}</span>
        <span className="text-[11px] text-fuchsia-300">{countdown(drop.releaseDate)}</span>
        <span className="text-[11px] text-white/30">
          Secret Lair · {drop.releaseDate ?? 'TBA'} · {drop.items.length} lair{drop.items.length === 1 ? '' : 's'} ·{' '}
          {money(drop.msrpTotal)} for one of each
        </span>
        <button
          onClick={() => setOpen(!open)}
          className="ml-auto rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10"
        >
          {open ? 'Hide' : 'Show'} lairs
        </button>
      </div>

      {open && (
        <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 border-t border-white/5 pt-2">
          {drop.items.map((i) => (
            <div key={i.id} className="overflow-hidden rounded border border-white/10 bg-black/20">
              {i.picture && <img src={i.picture} alt="" className="h-20 w-full object-cover" loading="lazy" />}
              <div className="p-1.5">
                <div className="line-clamp-2 text-[11px] leading-tight" title={i.name}>
                  {/* The "Secret Lair x " prefix is on every row and costs a line of text. */}
                  {i.name.replace(/^Secret Lair (x )?/i, '')}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-white/40">
                  <span className="tabular-nums">{money(i.msrp)}</span>
                  {i.foil ? <span className="rounded bg-amber-400/15 px-1 text-amber-200">foil</span> : null}
                  {i.randomized ? <span className="rounded bg-white/10 px-1">random</span> : null}
                  {onShowCards && (
                    <button
                      onClick={() => onShowCards(i.name)}
                      title="Card list, reprint prices and cEDH play — from Scryfall once it files the drop, else the announcement"
                      className="ml-auto rounded border border-white/10 px-1 text-white/55 hover:bg-white/10"
                    >
                      Cards
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-3">
        <a
          href="https://secretlair.wizards.com/us/en"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-fuchsia-300 hover:underline"
        >
          Secret Lair store <ExternalLink className="h-2.5 w-2.5" />
        </a>
        <span className="inline-flex items-center gap-1 text-[11px] text-white/25">
          <Sparkles className="h-2.5 w-2.5" /> limited run — sold direct, only while the window is open
        </span>
      </div>
    </div>
  )
}
