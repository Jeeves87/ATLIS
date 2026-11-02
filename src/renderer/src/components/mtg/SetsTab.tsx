import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, ChevronDown, ChevronRight, Eye, EyeOff, Loader2, Plus, Search, X } from 'lucide-react'
import type { MtgFamilyProduct, MtgFamilyProducts, MtgProductGroup, MtgSetFamily } from '../../types'
import ProductThumb from './ProductThumb'
import { tcgplayerImage } from '../../lib/mtgImages'

/**
 * Sets — every Magic set as one header, opening to every sealed product it
 * has.
 *
 * WHY A FAMILY, NOT A SET CODE: "The Hobbit" is HOB plus its Commander decks
 * (HOC) plus tokens and promos. Scryfall files those as separate sets, but a
 * collector browsing "what Hobbit product is there" wants them under one
 * header, so the backend groups each set with its children (mtg.setFamilies).
 *
 * Opening a family is what fetches it: the MTGJSON catalogue the first time,
 * then a TCGplayer quote for anything not priced today. Nothing is fetched for
 * families that stay closed.
 */

const money = (v: number | null | undefined): string =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

type Filter = 'current' | 'out_of_print' | 'watched' | 'all'
const FILTERS: ReadonlyArray<readonly [Filter, string, string]> = [
  ['current', 'Upcoming & in print', 'Unreleased, or inside the print window'],
  ['out_of_print', 'Out of print', 'Past the print window'],
  ['watched', 'Watched', 'Families with something on your watchlist'],
  ['all', 'All', 'Every set family']
]

const GROUPS: ReadonlyArray<readonly [MtgProductGroup, string]> = [
  ['collector', 'Collector Boosters'],
  ['boosters', 'Play, Draft & Set Boosters'],
  ['commander', 'Commander Decks'],
  ['bundles', 'Bundles & Gift'],
  ['secret_lair', 'Secret Lair'],
  ['other', 'Other']
]
/** Rows shown per group before "show more" — Secret Lair alone has hundreds. */
const GROUP_PREVIEW = 8
/**
 * Opening a family quotes its unpriced products automatically only up to this
 * many. Each quote is a TCGplayer call; Secret Lair's 900+ products would be
 * minutes of traffic nobody asked for, so big families get a button instead.
 */
const AUTO_PRICE_MAX = 60

const STAGE: Record<MtgSetFamily['stage'], [string, string]> = {
  upcoming: ['Upcoming', 'border-sky-400/40 bg-sky-500/15 text-sky-200'],
  in_print: ['In print', 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'],
  out_of_print: ['Out of print', 'border-white/10 bg-white/[0.03] text-white/45']
}

function countdown(ymd: string | null): string {
  if (!ymd) return 'date TBA'
  const [y, m, d] = ymd.split('-').map(Number)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86_400_000)
  if (days > 0) return days < 60 ? `${ymd} · in ${days}d` : `${ymd} · in ${Math.round(days / 30)}mo`
  return ymd
}

export default function SetsTab({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [families, setFamilies] = useState<MtgSetFamily[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('current')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const loadFamilies = useCallback(async () => {
    setFamilies(await window.atlis.mtg.families())
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadFamilies()
    return window.atlis.mtg.onChanged(() => void loadFamilies())
  }, [loadFamilies])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return families.filter((f) => {
      if (q) return f.name.toLowerCase().includes(q) || f.codes.some((c) => c === q)
      if (filter === 'current') return f.stage !== 'out_of_print'
      if (filter === 'out_of_print') return f.stage === 'out_of_print'
      if (filter === 'watched') return f.watched > 0
      return true
    })
  }, [families, filter, query])

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-white/10 text-xs">
          {FILTERS.map(([f, label, title]) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              title={title}
              className={`px-2.5 py-1.5 ${filter === f && !query ? 'bg-violet-500/25 text-violet-200' : 'text-white/45 hover:bg-white/5'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a set by name or code (searches every set)…"
            className="w-full rounded-md border border-white/10 bg-white/[0.03] py-1.5 pl-8 pr-8 text-sm placeholder:text-white/25 focus:border-violet-400/50 focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              title="Clear"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <span className="text-[11px] tabular-nums text-white/35">{shown.length} sets</span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-white/40">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading sets…
        </div>
      ) : shown.length === 0 ? (
        <p className="text-sm text-white/40">
          {families.length === 0 ? 'No sets cached yet. Hit Sync sets above.' : 'No set matches that.'}
        </p>
      ) : (
        <div className="space-y-1.5">
          {shown.map((f) => (
            <FamilyRow
              key={f.code}
              family={f}
              open={open === f.code}
              onToggle={() => setOpen(open === f.code ? null : f.code)}
              onChanged={() => {
                void loadFamilies()
                onChanged()
              }}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function FamilyRow({
  family: f,
  open,
  onToggle,
  onChanged
}: {
  family: MtgSetFamily
  open: boolean
  onToggle: () => void
  onChanged: () => void
}): React.JSX.Element {
  const [data, setData] = useState<MtgFamilyProducts | null>(null)
  const [phase, setPhase] = useState<'idle' | 'syncing' | 'pricing'>('idle')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (price: boolean) => {
      setPhase(price ? 'pricing' : 'syncing')
      setError(null)
      try {
        const r = await window.atlis.mtg.familyProducts(f.code, { price })
        setData(r)
        if (r.errors.length) setError(r.errors.join(' · '))
        return r
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return null
      } finally {
        setPhase('idle')
      }
    },
    [f.code]
  )

  // Open → catalogue first (fast once synced), then quote whatever isn't
  // priced today. Re-opening the same day costs nothing.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const r = await load(false)
      if (!cancelled && r && r.unpricedToday > 0 && r.unpricedToday <= AUTO_PRICE_MAX) await load(true)
    })()
    return () => {
      cancelled = true
    }
  }, [open, load])

  const [label, tone] = STAGE[f.stage]
  const children = f.codes.length - 1

  return (
    <div className={`rounded-md border ${open ? 'border-violet-400/40 bg-white/[0.04]' : 'border-white/10 bg-white/[0.02]'}`}>
      <button onClick={onToggle} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-white/[0.03]">
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-violet-300" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-white/35" />
        )}
        {f.iconSvgUri ? (
          <img src={f.iconSvgUri} alt="" className="h-5 w-5 shrink-0 opacity-80 invert" />
        ) : (
          <Box className="h-5 w-5 shrink-0 text-white/30" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{f.name}</div>
          <div className="truncate text-[11px] text-white/40">
            {f.codes[0].toUpperCase()}
            {children > 0 && ` + ${f.codes.slice(1, 3).map((c) => c.toUpperCase()).join(', ')}${children > 2 ? ` +${children - 2}` : ''}`}
            {' · '}
            {countdown(f.releasedAt)}
          </div>
        </div>
        {f.watched > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-violet-200/80" title="Products from this set on your watchlist">
            <Eye className="h-3 w-3" /> {f.watched}
          </span>
        )}
        {f.products > 0 && <span className="text-[11px] tabular-nums text-white/35">{f.products} products</span>}
        <span className={`rounded border px-1.5 py-px text-[10px] ${tone}`}>{label}</span>
      </button>

      {open && (
        <div className="border-t border-white/10 px-3 pb-3 pt-2">
          {phase === 'syncing' && !data && (
            <div className="flex items-center gap-2 py-2 text-[12px] text-white/45">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {f.products ? 'Loading products…' : 'Fetching the product catalogue from MTGJSON (first time only)…'}
            </div>
          )}
          {phase === 'pricing' && (
            <div className="mb-2 flex items-center gap-2 text-[11px] text-white/45">
              <Loader2 className="h-3 w-3 animate-spin" /> Getting today's TCGplayer prices for {data?.unpricedToday ?? ''} products…
            </div>
          )}
          {error && <div className="mb-2 text-[11px] text-amber-300/80">{error}</div>}
          {data && phase === 'idle' && data.unpricedToday > AUTO_PRICE_MAX && (
            <button
              onClick={() => void load(true)}
              className="mb-2 rounded border border-white/10 px-2 py-1 text-[11px] text-white/55 hover:bg-white/10"
            >
              Get today's prices for {data.unpricedToday} products (about {Math.ceil((data.unpricedToday * 0.5) / 60)} min)
            </button>
          )}
          {data && data.products.length === 0 && phase === 'idle' && (
            <p className="py-1 text-[12px] text-white/40">
              MTGJSON lists no sealed products for this set
              {f.stage === 'upcoming' ? ' yet. Catalogues usually appear a few weeks before release.' : '.'}
            </p>
          )}
          {data && data.products.length > 0 && (
            <div className="space-y-3">
              {GROUPS.map(([g, title]) => {
                const rows = data.products.filter((p) => p.group === g)
                return rows.length ? (
                  <ProductGroup
                    key={g}
                    title={title}
                    rows={rows}
                    rootCode={f.codes[0]}
                    onChanged={() => {
                      void load(false)
                      onChanged()
                    }}
                  />
                ) : null
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ProductGroup({
  title,
  rows,
  rootCode,
  onChanged
}: {
  title: string
  rows: MtgFamilyProduct[]
  rootCode: string
  onChanged: () => void
}): React.JSX.Element {
  const [all, setAll] = useState(false)
  // Secret Lair is a stream of drops: newest first reads better than priciest.
  const ordered = useMemo(
    () =>
      title === 'Secret Lair'
        ? [...rows].sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
        : rows,
    [rows, title]
  )
  const visible = all ? ordered : ordered.slice(0, GROUP_PREVIEW)
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-white/45">{title}</h4>
        <span className="text-[10px] tabular-nums text-white/30">{rows.length}</span>
      </div>
      <div className="space-y-1">
        {visible.map((p) => (
          <ProductRow key={p.uuid} p={p} rootCode={rootCode} onChanged={onChanged} />
        ))}
      </div>
      {rows.length > GROUP_PREVIEW && (
        <button onClick={() => setAll((v) => !v)} className="mt-1 text-[11px] text-violet-300/80 hover:text-violet-200">
          {all ? 'Show fewer' : `Show ${rows.length - GROUP_PREVIEW} more`}
        </button>
      )}
    </div>
  )
}

function ProductRow({
  p,
  rootCode,
  onChanged
}: {
  p: MtgFamilyProduct
  rootCode: string
  onChanged: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const move = p.price != null && p.p30 != null && p.p30 !== 0 ? ((p.price - p.p30) / p.p30) * 100 : null

  async function toggleWatch(): Promise<void> {
    setBusy(true)
    try {
      if (p.watchId) {
        await window.atlis.mtg.removeWatch(p.watchId)
      } else {
        await window.atlis.mtg.createWatch({
          kind: 'sealed',
          name: p.name,
          set_code: p.setCode,
          ext_source: 'tcgplayer',
          ext_id: p.tcgplayerProductId,
          variant: 'sealed',
          target_price: null
        })
      }
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3 rounded border border-white/5 bg-black/10 px-2 py-1.5">
      <ProductThumb
        image={p.tcgplayerProductId ? tcgplayerImage(p.tcgplayerProductId, 'small') : null}
        alt={p.name}
        size="sm"
        icon={Box}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]" title={p.name}>
          {p.name}
        </div>
        <div className="truncate text-[11px] text-white/35">
          {p.setCode !== rootCode && <span className="mr-1.5 uppercase text-white/50">{p.setCode}</span>}
          {p.releaseDate ?? ''}
          {p.evNetPct != null && (
            <span
              className={`ml-1.5 ${p.evNetPct >= 0 ? 'text-emerald-400/80' : 'text-white/40'}`}
              title={`Expected value of the contents ${money(p.evMean)}, from the EV board`}
            >
              EV {p.evNetPct >= 0 ? '+' : ''}
              {p.evNetPct.toFixed(0)}%
            </span>
          )}
        </div>
      </div>
      {move != null && Math.abs(move) >= 0.05 && (
        <span
          className={`w-14 shrink-0 text-right text-[11px] tabular-nums ${move > 0 ? 'text-emerald-400' : 'text-red-400'}`}
          title={`${money(p.p30)} on ${p.p30On} → ${money(p.price)} on ${p.priceOn}`}
        >
          {move > 0 ? '+' : ''}
          {move.toFixed(1)}%
        </span>
      )}
      <div className="w-20 shrink-0 text-right text-sm tabular-nums" title={p.priceOn ? `TCGplayer market, ${p.priceOn}` : 'Not priced yet'}>
        {money(p.price)}
      </div>
      {p.watchId && (
        <span
          className={`shrink-0 rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${
            p.watchMode === 'hunt'
              ? 'border-sky-400/40 bg-sky-500/15 text-sky-200'
              : 'border-violet-400/30 bg-violet-500/10 text-violet-200/80'
          }`}
          title="On your watchlist"
        >
          {p.watchMode}
        </span>
      )}
      <button
        onClick={() => void toggleWatch()}
        disabled={busy || (!p.watchId && !p.tcgplayerProductId)}
        title={
          p.watchId
            ? 'Remove from watchlist'
            : p.tcgplayerProductId
              ? 'Add to watchlist (Hunt or Market is picked automatically)'
              : 'No TCGplayer id, so it cannot be priced or tracked'
        }
        className={`flex w-20 shrink-0 items-center justify-center gap-1 rounded border px-1.5 py-1 text-[11px] disabled:opacity-40 ${
          p.watchId
            ? 'border-white/10 text-white/45 hover:bg-white/10'
            : 'border-violet-400/40 text-violet-200 hover:bg-violet-500/20'
        }`}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : p.watchId ? (
          <>
            <EyeOff className="h-3 w-3" /> Unwatch
          </>
        ) : (
          <>
            <Plus className="h-3 w-3" /> Watch
          </>
        )}
      </button>
    </div>
  )
}
