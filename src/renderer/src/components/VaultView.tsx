import { useCallback, useEffect, useMemo, useState } from 'react'
import { Gem, Plus, RefreshCw, Coins, Layers, Slice, Package, Loader2, Sparkles, Box, LayoutGrid, List } from 'lucide-react'
import { useAtlis } from '../state/store'
import type { VaultItem, VaultLatest, SpotPrices, ImageAttachment } from '../types'
import ItemDialog from './vault/ItemDialog'
import ItemDetail from './vault/ItemDetail'
import ProductThumb from './mtg/ProductThumb'
import { imageFor } from '../lib/mtgImages'

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5-mini',
  copilot: 'gpt-4o'
}

const CATEGORY_META: Record<string, { icon: typeof Gem; label: string }> = {
  mtg_card: { icon: Sparkles, label: 'Cards' },
  mtg_sealed: { icon: Box, label: 'Sealed' },
  tcg_sealed: { icon: Box, label: 'Other TCG sealed' },
  coin: { icon: Coins, label: 'Coins' },
  bullion: { icon: Layers, label: 'Bullion' },
  knife: { icon: Slice, label: 'Knives' },
  other: { icon: Package, label: 'Other' }
}
const CATEGORIES = ['all', 'mtg_card', 'mtg_sealed', 'tcg_sealed', 'coin', 'bullion', 'knife', 'other'] as const

type SortKey = 'value' | 'valueAsc' | 'paid' | 'name' | 'added'

const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: 'value', label: 'Most valuable' },
  { id: 'valueAsc', label: 'Least valuable' },
  { id: 'paid', label: 'Most paid' },
  { id: 'name', label: 'Name' },
  { id: 'added', label: 'Recently added' }
]

/** Categories priced automatically from a feed rather than metal content. */
const FEED_PRICED = new Set(['mtg_card', 'mtg_sealed', 'tcg_sealed'])

const money = (v: number | null | undefined) =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const mediaUrl = (a: ImageAttachment) => `atlis-media://media/${a.filename}`

type Layout = 'grid' | 'list'
const LAYOUT_KEY = 'atlis.vault.layout'
/** Gallery by default — the collection is the point, and it fills a wide screen. */
function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

/** Return on what was paid, as a percentage — null when either side is unknown. */
function gainPct(est: number | null, paid: number | null): number | null {
  if (est == null || paid == null || paid <= 0) return null
  return ((est - paid) / paid) * 100
}

/** Set / mint, finish, grade, year — the line that tells two same-named items apart. */
function detailsOf(item: VaultItem): string {
  // 'sealed' as a variant just repeats the category.
  const variant = item.variant === 'sealed' ? null : item.variant
  return [CATEGORY_META[item.category]?.label, item.maker, variant, item.grade, item.year]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The item's picture: your own photo first, then the catalog image a Magic item
 * can derive (Scryfall scan / TCGplayer product shot), then its category icon.
 */
function ItemPicture({ item, size }: { item: VaultItem; size: 'row' | 'tile' }) {
  const Icon = CATEGORY_META[item.category]?.icon ?? Package
  if (item.photos[0]) {
    return (
      <img
        src={mediaUrl(item.photos[0])}
        alt=""
        className={
          size === 'tile'
            ? 'h-full w-full rounded object-cover'
            : 'h-10 w-10 shrink-0 rounded border border-ink-600 object-cover'
        }
      />
    )
  }
  const catalog = imageFor({ extSource: item.ext_source, extId: item.ext_id }, size === 'tile' ? 'normal' : 'small')
  if (catalog) {
    return (
      <ProductThumb
        image={catalog}
        alt={item.name}
        size={size === 'tile' ? 'fill' : 'sm'}
        icon={Icon}
        className={size === 'tile' ? 'rounded shadow-lg shadow-black/40' : 'border border-ink-600'}
      />
    )
  }
  return size === 'tile' ? (
    <Icon size={40} className="text-ink-500" />
  ) : (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-ink-600 bg-ink-850 text-mist-500">
      <Icon size={15} />
    </span>
  )
}

/** Escape + wrap plain text so it can ride the (md, html) chat:send signature. */
const asHtml = (md: string) =>
  `<p>${md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`

function appraisePrompt(item: VaultItem): string {
  const attrs = [
    `- Name: ${item.name}`,
    `- Category: ${item.category}`,
    item.year ? `- Year: ${item.year}` : '',
    item.maker ? `- Mint/maker/set: ${item.maker}` : '',
    item.grade ? `- Grade/condition: ${item.grade}` : '',
    `- Quantity: ${item.quantity}`,
    item.variant ? `- Finish/variant: ${item.variant}` : '',
    item.ext_source === 'scryfall' && item.ext_id ? `- Scryfall id: ${item.ext_id} (https://scryfall.com/card/${item.ext_id})` : '',
    item.ext_source === 'tcgplayer' && item.ext_id ? `- TCGplayer product id: ${item.ext_id}` : '',
    item.metal && item.metal_weight_ozt ? `- Metal: ${item.metal}, ${item.metal_weight_ozt} ozt per item` : '',
    item.purchase_price != null ? `- I paid: $${item.purchase_price}` : '',
    item.notes ? `- Notes: ${item.notes}` : ''
  ].filter(Boolean).join('\n')
  // Magic items already carry an automated feed price (Scryfall for singles,
  // TCGplayer for sealed), so their appraisal is worth doing only where the
  // feed is blind: condition, grading, serialization, and thin sealed markets.
  const isMtg = FEED_PRICED.has(item.category)
  const research = isMtg
    ? [
        item.category === 'mtg_sealed' || item.category === 'tcg_sealed'
          ? 'This is a SEALED trading-card product. ATLIS already tracks its TCGplayer market price automatically, so your job is the part that feed misses: check eBay SOLD listings (not active asks — sealed asking prices are wildly optimistic), and note whether the product is still in print, out of print, or in a limited window. Sealed markets are thin, so a handful of real sales matters more than any listed price.'
          : 'This is a Magic single. ATLIS already tracks its Scryfall price automatically, so do NOT just restate that — your job is what Scryfall cannot see: condition/grade premiums, whether this specific printing or treatment trades above the generic one, serialized or low-serial premiums, and graded population if it is slabbed.',
        'Cross-check TCGplayer, Card Kingdom, and eBay SOLD comps using fetch_url and the browser tools. Be explicit about which printing you priced — set code and collector number matter enormously, and foil vs nonfoil can differ 3x on the same card.'
      ].join(' ')
    : 'Research recent comparable sales — eBay SOLD listings, auction results, and price guides (PCGS/NGC/Numista for coins; dealer listings and forum sales for knives) — using fetch_url and the browser tools. Weigh condition and grade carefully.'

  return [
    `Appraise the current market value of this collectible from my Vault (item id ${item.id}):`,
    '',
    attrs,
    '',
    research,
    '',
    `Then record your estimate with vault_record_valuation (item_id ${item.id}; value_low / value_mid / value_high in USD for the whole quantity of ${item.quantity}), citing in notes which comps you used, their prices, and your confidence. If good comps are scarce, record a wide range and say so honestly rather than inventing precision.`
  ].join('\n')
}

/**
 * The Vault: collectibles inventory with live melt-value floor and an
 * agent-researched market-value history per item (the "Beckett list").
 */
export default function VaultView() {
  const { sessions, refreshSessions, setActiveSession, setView } = useAtlis()
  const [items, setItems] = useState<VaultItem[]>([])
  const [latest, setLatest] = useState<VaultLatest>({})
  const [spot, setSpot] = useState<SpotPrices | null>(null)
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('all')
  const [sort, setSort] = useState<SortKey>('value')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'add' | 'edit' | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [appraisingId, setAppraisingId] = useState<string | null>(null)
  const [layout, setLayoutState] = useState<Layout>(readLayout)
  const setLayout = (next: Layout) => {
    setLayoutState(next)
    try {
      localStorage.setItem(LAYOUT_KEY, next)
    } catch {
      /* storage unavailable — the choice just won't stick */
    }
  }

  const load = useCallback(async () => {
    const [rows, vals] = await Promise.all([window.atlis.vault.items(), window.atlis.vault.latest()])
    setItems(rows)
    setLatest(vals)
    setLoading(false)
  }, [])

  // initial load + live updates (agent tools / other windows), plus one melt
  // refresh per mount so the floor tracks today's spot without manual clicks
  useEffect(() => {
    load()
    window.atlis.vault.spot().then(setSpot).catch(() => {})
    window.atlis.vault.refreshMelt().catch(() => {})
    const off = window.atlis.vault.onChanged(() => load())
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshMelt = async () => {
    setRefreshing(true)
    try {
      await window.atlis.vault.refreshMelt()
      setSpot(await window.atlis.vault.spot())
    } finally {
      setRefreshing(false)
    }
  }

  const inCategory = category === 'all' ? items : items.filter((i) => i.category === category)
  const selected = items.find((i) => i.id === selectedId) ?? null

  // latest non-melt valuation — agent-researched 'market' or hand-entered 'manual', whichever is newer
  const marketFor = useCallback(
    (id: string) => {
      const m = latest[id]?.market
      const man = latest[id]?.manual
      if (m && man) return m.created_at >= man.created_at ? m : man
      return m ?? man ?? null
    },
    [latest]
  )
  // estimated value per item: latest market when we have one, else melt floor
  const estFor = useCallback(
    (id: string) => marketFor(id)?.value_mid ?? latest[id]?.melt?.value_mid ?? null,
    [marketFor, latest]
  )

  // Sorted view of the list. Default is most-valuable-first: the whole point of
  // the page is what the collection is worth, and creation order buries a
  // $900 booster box under whatever was added last. Items with no valuation at
  // all sink to the bottom in BOTH value directions — an unappraised item isn't
  // worth $0, it's unknown, so it shouldn't lead the "least valuable" list.
  const filtered = useMemo(() => {
    const rows = [...inCategory]
    rows.sort((a, b) => {
      const av = estFor(a.id)
      const bv = estFor(b.id)
      switch (sort) {
        case 'valueAsc':
          return (
            Number(av == null) - Number(bv == null) ||
            (av ?? 0) - (bv ?? 0) ||
            a.name.localeCompare(b.name)
          )
        case 'paid':
          return (b.purchase_price ?? 0) - (a.purchase_price ?? 0) || a.name.localeCompare(b.name)
        case 'name':
          return a.name.localeCompare(b.name)
        case 'added':
          return b.created_at - a.created_at
        default:
          return (
            Number(av == null) - Number(bv == null) ||
            (bv ?? 0) - (av ?? 0) ||
            a.name.localeCompare(b.name)
          )
      }
    })
    return rows
  }, [inCategory, sort, estFor])
  const totals = useMemo(() => {
    let paid = 0, melt = 0, est = 0
    for (const it of filtered) {
      paid += it.purchase_price ?? 0
      melt += latest[it.id]?.melt?.value_mid ?? 0
      est += estFor(it.id) ?? 0
    }
    return { paid, melt, est }
  }, [filtered, latest, estFor])

  // Only give melt a column when something in view actually has metal in it.
  const showMelt = useMemo(() => filtered.some((it) => latest[it.id]?.melt), [filtered, latest])
  const listCols = showMelt
    ? 'minmax(0,2.2fr) minmax(0,1.6fr) 3rem 6.5rem 6.5rem 7rem 5.5rem'
    : 'minmax(0,2.2fr) minmax(0,1.6fr) 3rem 6.5rem 7rem 5.5rem'

  const removeItem = async (id: string) => {
    if (selectedId === id) setSelectedId(null)
    await window.atlis.vault.removeItem(id)
  }

  /** Hand the item to the agent in a fresh chat session; the run records the valuation. */
  const appraise = async (item: VaultItem) => {
    setAppraisingId(item.id)
    try {
      const last = sessions[0]
      const provider = last?.provider ?? 'anthropic'
      const model = last?.model ?? DEFAULT_MODELS[provider] ?? DEFAULT_MODELS.anthropic
      const s = await window.atlis.sessions.create({ title: `Appraise: ${item.name}`, provider, model })
      const md = appraisePrompt(item)
      await window.atlis.chat.send(s.id, md, asHtml(md))
      await refreshSessions()
      setActiveSession(s.id)
      setView('chat')
    } finally {
      setAppraisingId(null)
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col bg-ink-900">
        {/* header */}
        <div className="flex items-center gap-3 border-b border-ink-600 px-4 py-2.5">
          <Gem size={15} className="text-volt-400" />
          <span className="text-[13px] font-semibold text-mist-100">Vault</span>

          <div className="ml-2 flex items-center gap-1">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  category === c ? 'bg-volt-500/15 text-volt-400' : 'text-mist-400 hover:bg-ink-700 hover:text-mist-100'
                }`}
              >
                {c === 'all' ? 'All' : CATEGORY_META[c].label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <div className="flex overflow-hidden rounded-md border border-ink-600">
              {([['grid', LayoutGrid, 'Gallery'], ['list', List, 'Table']] as const).map(([id, LayoutIcon, label]) => (
                <button
                  key={id}
                  onClick={() => setLayout(id)}
                  title={label}
                  className={`px-2 py-1 ${layout === id ? 'bg-volt-500/15 text-volt-400' : 'text-mist-500 hover:bg-ink-700 hover:text-mist-100'}`}
                >
                  <LayoutIcon size={13} />
                </button>
              ))}
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              title="Sort order"
              className="rounded-md border border-ink-600 bg-ink-850 px-2 py-1 text-[11px] text-mist-400 outline-none hover:border-pulse-400 focus:border-pulse-400"
            >
              {SORTS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {spot && (
              <div className="hidden items-center gap-2.5 font-mono text-[10px] text-mist-500 lg:flex">
                {(['gold', 'silver', 'platinum'] as const).map((m) =>
                  spot.usdPerOzt[m] != null ? (
                    <span key={m}>
                      <span className="uppercase">{m.slice(0, 2)}</span>{' '}
                      <span className="text-pulse-400">${spot.usdPerOzt[m]!.toFixed(m === 'silver' ? 2 : 0)}</span>
                    </span>
                  ) : null
                )}
              </div>
            )}
            <button
              onClick={refreshMelt}
              disabled={refreshing}
              title="Refresh spot prices + melt values"
              className="flex items-center gap-1 rounded-md border border-ink-600 px-2.5 py-1 text-[11px] text-mist-400 hover:border-pulse-400 hover:text-pulse-400 disabled:opacity-50"
            >
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> Melt
            </button>
            <button
              onClick={() => setDialog('add')}
              className="flex items-center gap-1 rounded-md border border-volt-500/50 bg-volt-500/15 px-2.5 py-1 text-[11px] font-medium text-volt-400 hover:bg-volt-500/25"
            >
              <Plus size={12} /> Add item
            </button>
          </div>
        </div>

        {/* totals strip */}
        {items.length > 0 && (
          <div className="flex items-center gap-6 border-b border-ink-600 bg-ink-850/50 px-4 py-2 font-mono text-[11px]">
            <span className="text-mist-500">
              {filtered.length} item{filtered.length === 1 ? '' : 's'}
            </span>
            <span className="text-mist-400">paid <span className="text-mist-100">{money(totals.paid)}</span></span>
            {/* Melt is a metal-content floor — meaningless for cards, so hide it
                rather than show a confusing $0.00 next to a real market value. */}
            {totals.melt > 0 && (
              <span className="text-mist-400">melt floor <span className="text-pulse-400">{money(totals.melt)}</span></span>
            )}
            <span className="text-mist-400">est. value <span className="text-volt-400">{money(totals.est)}</span></span>
            {totals.paid > 0 && totals.est > 0 && (
              <span className={totals.est >= totals.paid ? 'text-ok-400' : 'text-danger-400'}>
                {totals.est >= totals.paid ? '+' : ''}{(((totals.est - totals.paid) / totals.paid) * 100).toFixed(1)}%
              </span>
            )}
          </div>
        )}

        {/* item list */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center text-mist-500">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState hasItems={items.length > 0} onAdd={() => setDialog('add')} />
          ) : layout === 'grid' ? (
            /* Gallery: tiles reflow to fill whatever width there is, so a wide
               screen shows more of the collection instead of a longer gap
               between a name and its price. */
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3 p-4">
              {filtered.map((item) => {
                const l = latest[item.id] ?? {}
                const mkt = marketFor(item.id)
                const est = estFor(item.id)
                const gain = gainPct(est, item.purchase_price)
                const active = item.id === selectedId
                return (
                  <button
                    key={item.id}
                    onClick={() => setSelectedId(active ? null : item.id)}
                    className={`group flex flex-col overflow-hidden rounded-lg border text-left transition-colors ${
                      active
                        ? 'border-volt-500 bg-volt-500/10'
                        : 'border-ink-600 bg-ink-850/40 hover:border-mist-500 hover:bg-ink-850'
                    }`}
                  >
                    {/* Absolute inset gives the picture a definite box — percentage
                        heights don't resolve against an aspect-ratio parent, and a
                        card scan would spill out of the square. */}
                    <div className="relative aspect-square bg-ink-850">
                      <div className="absolute inset-3 flex items-center justify-center">
                        <ItemPicture item={item} size="tile" />
                      </div>
                    </div>
                    <div className="flex flex-1 flex-col gap-1 border-t border-ink-700 px-3 py-2.5">
                      <div className="line-clamp-2 text-[13px] font-medium leading-snug text-mist-100" title={item.name}>
                        {item.name}
                        {item.quantity > 1 && <span className="ml-1.5 font-mono text-[10px] text-mist-500">×{item.quantity}</span>}
                      </div>
                      <div className="truncate font-mono text-[9.5px] uppercase tracking-wider text-mist-500" title={detailsOf(item)}>
                        {detailsOf(item)}
                      </div>
                      <div className="mt-auto flex items-baseline justify-between gap-2 pt-1.5">
                        <span className={`font-mono text-[15px] font-semibold ${mkt ? 'text-volt-400' : 'text-pulse-400'}`}>
                          {est == null ? <span className="text-[11px] font-normal text-mist-500">not appraised</span> : money(est)}
                        </span>
                        {gain != null && (
                          <span className={`font-mono text-[11px] ${gain >= 0 ? 'text-ok-400' : 'text-danger-400'}`}>
                            {gain >= 0 ? '+' : ''}
                            {gain.toFixed(1)}%
                          </span>
                        )}
                      </div>
                      <div className="flex justify-between gap-2 font-mono text-[10px] text-mist-500">
                        <span>paid {money(item.purchase_price)}</span>
                        {/* A metal item's number is its melt floor until someone appraises it. */}
                        {!mkt && l.melt ? <span>melt</span> : l.melt ? <span>melt {money(l.melt.value_mid)}</span> : null}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            /* Table: the middle column carries set/finish/grade detail, and the
               numbers sit in proportional columns — wide screens spread a real
               table instead of pushing the prices to the far edge. */
            <div className="flex flex-col">
              <div
                className="sticky top-0 z-10 grid items-center gap-4 border-b border-ink-600 bg-ink-900 px-4 py-1.5 font-mono text-[9px] uppercase tracking-[0.15em] text-mist-500"
                style={{ gridTemplateColumns: listCols }}
              >
                <span>item</span>
                <span>details</span>
                <span className="text-right">qty</span>
                <span className="text-right">paid</span>
                {showMelt && <span className="text-right">melt</span>}
                <span className="text-right">market</span>
                <span className="text-right">gain</span>
              </div>
              {filtered.map((item) => {
                const l = latest[item.id] ?? {}
                const mkt = marketFor(item.id)
                const gain = gainPct(estFor(item.id), item.purchase_price)
                const active = item.id === selectedId
                return (
                  <button
                    key={item.id}
                    onClick={() => setSelectedId(active ? null : item.id)}
                    style={{ gridTemplateColumns: listCols }}
                    className={`grid items-center gap-4 border-b border-ink-700 px-4 py-2 text-left transition-colors ${
                      active ? 'bg-volt-500/10' : 'hover:bg-ink-850'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <ItemPicture item={item} size="row" />
                      <span className="truncate text-[13px] font-medium text-mist-100" title={item.name}>{item.name}</span>
                    </div>
                    <div className="truncate font-mono text-[10px] uppercase tracking-wider text-mist-500" title={detailsOf(item)}>
                      {detailsOf(item)}
                    </div>
                    <div className="text-right font-mono text-[11px] text-mist-400">{item.quantity}</div>
                    <div className="text-right font-mono text-[11px] text-mist-400">{money(item.purchase_price)}</div>
                    {showMelt && (
                      <div className="text-right font-mono text-[11px] text-pulse-400">{money(l.melt?.value_mid)}</div>
                    )}
                    <div className="text-right font-mono text-[11.5px] font-semibold text-volt-400">
                      {mkt ? money(mkt.value_mid) : <Sparkles size={11} className="ml-auto inline text-ink-500" aria-label="not appraised yet" />}
                    </div>
                    <div
                      className={`text-right font-mono text-[11px] ${
                        gain == null ? 'text-mist-500' : gain >= 0 ? 'text-ok-400' : 'text-danger-400'
                      }`}
                    >
                      {gain == null ? '—' : `${gain >= 0 ? '+' : ''}${gain.toFixed(1)}%`}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {selected && (
        <ItemDetail
          item={selected}
          onEdit={() => setDialog('edit')}
          onDelete={() => removeItem(selected.id)}
          onAppraise={() => appraise(selected)}
          appraising={appraisingId === selected.id}
          onChanged={load}
        />
      )}

      {dialog && (
        <ItemDialog
          item={dialog === 'edit' ? selected : null}
          onClose={() => setDialog(null)}
          onSaved={(it) => {
            setSelectedId(it.id)
            load()
          }}
        />
      )}
    </div>
  )
}

function EmptyState({ hasItems, onAdd }: { hasItems: boolean; onAdd: () => void }) {
  return (
    <div className="grid-texture flex h-full flex-col items-center justify-center text-center">
      <Gem size={34} className="mb-3 text-ink-500" />
      {hasItems ? (
        <p className="text-[12.5px] text-mist-500">Nothing in this category yet.</p>
      ) : (
        <>
          <p className="text-[13px] font-medium text-mist-300">Your Vault is empty</p>
          <p className="mt-1 max-w-sm text-[12px] leading-relaxed text-mist-500">
            Catalog your coins, bullion, and knives. Metal items get a live melt-value floor from spot prices, and the
            agent can research real market comps on command.
          </p>
          <button
            onClick={onAdd}
            className="mt-4 rounded-md border border-volt-500/50 bg-volt-500/15 px-3.5 py-1.5 text-[12px] font-medium text-volt-400 hover:bg-volt-500/25"
          >
            Add your first item
          </button>
        </>
      )}
    </div>
  )
}
