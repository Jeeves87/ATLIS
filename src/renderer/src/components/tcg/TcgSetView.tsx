import { useEffect, useMemo, useState } from 'react'
import { Check, LayoutGrid, List, Loader2, Package, Plus, Search } from 'lucide-react'
import ProductThumb from '../mtg/ProductThumb'
import TcgTile from './TcgTile'
import { cardImage, money, printingLabel, printingsOf } from './tcgUi'
import type { TcgPrinting, TcgProduct, TcgSet, TcgSetProducts } from '../../types'

/**
 * A whole set from a non-Magic game, laid out like Magic's set view: chase
 * cards ranked by value, sealed product above, filter / rarity / sort / page
 * controls over the grid.
 *
 * RARITY ORDER IS MEASURED, NOT HAND-KEPT. Every game names rarities its own
 * way — Palworld SSP/OSR/SR, Cyberpunk "IS", Pokémon "Secret Rare" — so the
 * chips and the rarity sort are ordered by the median market price of each
 * rarity within THIS set. That stays right for any game without a table to
 * maintain.
 */

type SortKey = 'value' | 'valueAsc' | 'number' | 'name' | 'rarity'
const SORTS: Array<[SortKey, string]> = [
  ['value', 'Most valuable'],
  ['valueAsc', 'Least valuable'],
  ['number', 'Collector #'],
  ['name', 'Name'],
  ['rarity', 'Rarity']
]
const VIEW_KEY = 'atlis.tcg.setView'

/** Unpriced cards sort last whichever direction value is sorted. */
function byPrice(a: TcgProduct, b: TcgProduct, dir: 1 | -1): number {
  if (a.market == null && b.market == null) return 0
  if (a.market == null) return 1
  if (b.market == null) return -1
  return dir * (a.market - b.market)
}

function median(xs: number[]): number {
  if (!xs.length) return -1
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export default function TcgSetView({
  set,
  data,
  watched,
  adding,
  onPreview,
  onTrack,
  onOwn
}: {
  set: TcgSet
  data: TcgSetProducts
  watched: Set<string>
  adding: string | null
  onPreview: (p: TcgProduct) => void
  onTrack: (p: TcgProduct, printing: TcgPrinting) => void
  onOwn: (p: TcgProduct) => void
}) {
  const [view, setViewState] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const [filter, setFilter] = useState('')
  const [rarity, setRarity] = useState('all')
  const [sort, setSort] = useState<SortKey>('value')
  const [pageSize, setPageSize] = useState(60)
  const [page, setPage] = useState(0)

  const setView = (v: 'grid' | 'list'): void => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* storage unavailable */
    }
  }

  const rarities = useMemo(() => {
    const prices = new Map<string, number[]>()
    const counts = new Map<string, number>()
    for (const c of data.cards) {
      if (!c.rarity) continue
      counts.set(c.rarity, (counts.get(c.rarity) ?? 0) + 1)
      if (!prices.has(c.rarity)) prices.set(c.rarity, [])
      if (c.market != null) prices.get(c.rarity)!.push(c.market)
    }
    return [...counts.keys()]
      .map((r) => ({ r, median: median(prices.get(r) ?? []), count: counts.get(r) ?? 0 }))
      .sort((a, b) => b.median - a.median || a.r.localeCompare(b.r))
  }, [data.cards])
  const rank = useMemo(() => new Map(rarities.map((x, i) => [x.r, i])), [rarities])

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const list = data.cards.filter(
      (c) =>
        (rarity === 'all' || c.rarity === rarity) &&
        (!f || c.name.toLowerCase().includes(f) || (c.number ?? '').toLowerCase().includes(f))
    )
    const cmp: Record<SortKey, (a: TcgProduct, b: TcgProduct) => number> = {
      value: (a, b) => byPrice(a, b, -1),
      valueAsc: (a, b) => byPrice(a, b, 1),
      number: (a, b) => (a.number ?? '￿').localeCompare(b.number ?? '￿', undefined, { numeric: true }),
      name: (a, b) => a.name.localeCompare(b.name),
      rarity: (a, b) => (rank.get(a.rarity ?? '') ?? 99) - (rank.get(b.rarity ?? '') ?? 99) || byPrice(a, b, -1)
    }
    return [...list].sort(cmp[sort])
  }, [data.cards, filter, rarity, sort, rank])

  // Any change to what is listed goes back to page 1 — filtering while on page 4 must not land on an empty page.
  useEffect(() => setPage(0), [filter, rarity, sort, pageSize, set.url])

  const priced = data.cards.filter((c) => c.market != null)
  const total = priced.reduce((n, c) => n + (c.market ?? 0), 0)
  const pageCount = pageSize === 0 ? 1 : Math.max(1, Math.ceil(visible.length / pageSize))
  const current = Math.min(page, pageCount - 1)
  const shown = pageSize === 0 ? visible : visible.slice(current * pageSize, current * pageSize + pageSize)

  const trackButtons = (p: TcgProduct, compact = false) => (
    <div className="flex shrink-0 flex-wrap gap-1">
      {printingsOf(p).map((pr) => {
        const key = `${p.productId}:${pr}`
        const have = watched.has(key)
        return (
          <button
            key={pr}
            onClick={() => onTrack(p, pr)}
            disabled={have || adding != null}
            title={have ? 'Already tracking' : `Track ${p.sealed ? 'this' : pr === 'Foil' ? 'the foil' : 'the regular printing'}`}
            className={`flex items-center gap-1 rounded border border-white/10 hover:bg-white/10 disabled:opacity-50 ${compact ? 'px-1 py-0 text-[10.5px]' : 'px-1.5 py-0.5 text-[11px]'}`}
          >
            {adding === key ? <Loader2 className="h-3 w-3 animate-spin" /> : have ? <Check className="h-3 w-3 text-violet-300" /> : <Plus className="h-3 w-3" />}
            {p.sealed ? (have ? 'Tracking' : 'Track') : printingLabel(pr, false)}
          </button>
        )
      })}
    </div>
  )

  return (
    <section className="mb-6">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">Chase cards — {set.name}</h2>
        <span className="text-[11px] text-white/45">
          every card at market <span className="tabular-nums text-white/70">{money(total)}</span>
        </span>
        <span className="text-[11px] text-white/30">
          {priced.length}/{data.cards.length} priced
        </span>
        {data.truncated && <span className="text-[11px] text-amber-300/80">set is very large — showing the most valuable part</span>}
        <div className="ml-auto flex overflow-hidden rounded-md border border-white/10">
          {([['grid', LayoutGrid], ['list', List]] as const).map(([v, Icon]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              title={v === 'grid' ? 'Card art' : 'Compact list'}
              className={`p-1.5 ${view === v ? 'bg-violet-500/25 text-violet-200' : 'text-white/40 hover:bg-white/5'}`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      </div>

      {data.sealed.length > 0 && (
        <div className="mb-3 rounded-md border border-white/10 bg-black/20 p-2.5">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">Sealed products</div>
          <div className="space-y-0.5">
            {[...data.sealed].sort((a, b) => byPrice(a, b, -1)).map((p) => (
              <div key={p.productId} className="flex items-center gap-3 py-0.5 text-[11px]">
                <ProductThumb image={cardImage(p.productId, 'small', true)} alt={p.name} size="xs" onClick={() => onPreview(p)} />
                <span className="min-w-0 flex-1 truncate text-white/70" title={p.name}>
                  {p.name}
                </span>
                <span className="w-20 shrink-0 text-right tabular-nums">{p.market == null ? <span className="text-white/25">—</span> : money(p.market)}</span>
                <span className="w-20 shrink-0 text-right text-[10px] text-white/35">
                  {p.listings ? `${p.listings} listed` : <span className="text-amber-300/80">not listed</span>}
                </span>
                {trackButtons(p, true)}
                <button
                  onClick={() => onOwn(p)}
                  disabled={adding != null}
                  title="I own this — add a copy to Owned"
                  className="flex shrink-0 items-center gap-1 rounded border border-white/10 px-1 py-0 text-[10.5px] hover:bg-white/10 disabled:opacity-50"
                >
                  {adding === `own:${p.productId}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Package className="h-3 w-3" />}
                  Own
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Browse controls — the whole set is in memory; these only choose the slice on screen. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-white/30" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or #"
            className="w-44 rounded-md border border-white/10 bg-black/20 py-1 pl-7 pr-2 text-[11px] outline-none focus:border-violet-400/50"
          />
        </div>
        <div className="flex flex-wrap overflow-hidden rounded-md border border-white/10">
          {[{ r: 'all', count: data.cards.length }, ...rarities].map(({ r, count }) => (
            <button
              key={r}
              onClick={() => setRarity(r)}
              title={r === 'all' ? 'Every rarity' : `${count} card(s) · ordered by what this rarity is worth in this set`}
              className={`px-2 py-1 text-[11px] ${rarity === r ? 'bg-violet-500/25 text-violet-200' : 'text-white/40 hover:bg-white/5'}`}
            >
              {r}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] outline-none focus:border-violet-400/50"
        >
          {SORTS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] outline-none focus:border-violet-400/50"
        >
          <option value={60}>60 per page</option>
          <option value={120}>120 per page</option>
          <option value={0}>all</option>
        </select>
        <span className="text-[11px] text-white/30">{visible.length} shown</span>
      </div>

      {view === 'grid' ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {shown.map((p) => (
            <TcgTile key={p.productId} p={p} watched={watched} adding={adding} onPreview={() => onPreview(p)} onTrack={(pr) => onTrack(p, pr)} />
          ))}
        </div>
      ) : (
        <div className="divide-y divide-white/5 rounded-md border border-white/10">
          {shown.map((p) => (
            <div key={p.productId} className="flex items-center gap-3 px-2 py-1 text-[11.5px]">
              <ProductThumb image={cardImage(p.productId, 'small', false)} alt={p.name} size="sm" onClick={() => onPreview(p)} />
              <span className="min-w-0 flex-1 truncate text-white/80" title={p.name}>
                {p.name}
              </span>
              <span className="w-28 shrink-0 truncate text-white/40">{p.number ?? ''}</span>
              <span className="w-16 shrink-0 truncate text-white/50">{p.rarity ?? ''}</span>
              <span className="w-20 shrink-0 text-right tabular-nums">{money(p.market)}</span>
              <span className="w-20 shrink-0 text-right text-[10.5px] text-white/35">
                {p.listings ? `${p.listings} listed` : <span className="text-amber-300/80">not listed</span>}
              </span>
              {trackButtons(p, true)}
            </div>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3 text-[11px] text-white/50">
          <button
            onClick={() => setPage((n) => Math.max(0, n - 1))}
            disabled={current === 0}
            className="rounded border border-white/10 px-2 py-0.5 hover:bg-white/10 disabled:opacity-30"
          >
            ‹ Prev
          </button>
          <span className="tabular-nums">
            page {current + 1} of {pageCount}
          </span>
          <button
            onClick={() => setPage((n) => Math.min(pageCount - 1, n + 1))}
            disabled={current >= pageCount - 1}
            className="rounded border border-white/10 px-2 py-0.5 hover:bg-white/10 disabled:opacity-30"
          >
            Next ›
          </button>
        </div>
      )}
    </section>
  )
}
