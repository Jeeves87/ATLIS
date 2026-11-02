import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles, Search, Plus, RefreshCw, Loader2, CalendarDays, Bell, BellOff,
  Trash2, PackageCheck, TrendingDown, TrendingUp, Minus, Box, ShoppingCart, ExternalLink,
  LayoutGrid, List, X, Layers, PackageOpen, Pin, Settings2
} from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import ReleasesTab from './mtg/ReleasesTab'
import SetsTab from './mtg/SetsTab'
import EvTab from './mtg/EvTab'
import CommandersTab from './mtg/CommandersTab'
import DecksTab from './mtg/DecksTab'
import PlayTab from './mtg/PlayTab'
import DealsPanel from './mtg/DealsPanel'
import ProductThumb, { ImageZoom } from './mtg/ProductThumb'
import TcgSearchPane from './tcg/TcgSearchPane'
import TcgWatchlist from './tcg/TcgWatchlist'
import { imageFor, tcgplayerImage, type ImageRef } from '../lib/mtgImages'
import type { MtgSet, MtgWatch, MtgWatchRow, MtgPeriodPrices, MtgBandVerdict, MtgLifecycleSettings, MtgPrice, ScryfallCard, MtgSealed, MtgOwnedItem, MtgListing, MtgSetValuation, MtgSetCardValue, MtgCardInsight, MtgCardInsights, MtgSealedContents, MtgSealedCard, MtgBackfillProgress, MtgPackEv, MtgSealedPriceRow, TcgGame } from '../types'

/** Unified selection shape — the chart doesn't care if it's watched or owned. */
interface Tracked {
  key: string
  name: string
  extId: string | null
  variant: string
  subtitle: string
  lastPrice: number | null
  owned: boolean
  extSource: string | null
  imageUrl: string | null
  /** Owned Magic sealed only — ripping needs MTGJSON's decklist, which other games lack. */
  rippable?: boolean
  /** Magic sealed (owned or watched): "What's inside" can look it up. */
  magicSealed?: boolean
  /** Set code to pull the catalogue from if the product isn't catalogued yet. */
  setHint?: string | null
}

/** What the full-size image overlay is showing. */
interface Zoom {
  image: ImageRef
  name: string
  subtitle?: string | null
}

const OWNED_LAYOUT_KEY = 'atlis.mtg.ownedLayout'
const OWNED_PERIOD_KEY = 'atlis.mtg.ownedPeriod'
const MARKET_PERIOD_KEY = 'atlis.mtg.marketPeriod'
const WATCH_MODE_KEY = 'atlis.mtg.watchMode'
type OwnedSort = 'value' | 'holding' | 'gainers' | 'losers' | 'cedh'

/**
 * How often a card shows up in cEDH tournament decks (EDHTop16 play rate),
 * bucketed so the badge reads at a glance. Cut-offs from the spread on
 * 2026-10-11: format staples (Rhystic Study, Mental Misstep) sit near 90%,
 * Swords and Sol Ring around 45%, real-but-niche includes in single digits.
 */
const CEDH_TIERS = [
  { min: 0.25, label: 'cEDH staple', cls: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200' },
  { min: 0.05, label: 'cEDH played', cls: 'border-sky-400/40 bg-sky-500/15 text-sky-200' },
  { min: 0.01, label: 'cEDH fringe', cls: 'border-white/15 bg-white/[0.06] text-white/55' }
] as const
const cedhTier = (rate: number | null | undefined) =>
  rate == null ? null : (CEDH_TIERS.find((t) => rate >= t.min) ?? null)

/** Percent with one decimal under 10%, so 4.2% and 0.6% stay distinguishable. */
const pct = (r: number): string => `${r * 100 < 10 ? (r * 100).toFixed(1) : Math.round(r * 100)}%`

function CedhBadge({ rate }: { rate: number | null | undefined }) {
  const t = cedhTier(rate)
  if (!t || rate == null) return null
  return (
    <span
      title={`${t.label} — in ${pct(rate)} of cEDH tournament decks over the last year (EDHTop16)`}
      className={`shrink-0 rounded border px-1 py-px text-[10px] font-medium tabular-nums ${t.cls}`}
    >
      cEDH {pct(rate)}
    </span>
  )
}

/** Which saved decks run this card; nothing for loose cards. */
function DeckBadge({ decks }: { decks: string[] | undefined }) {
  if (!decks?.length) return null
  return (
    <span
      title={`In ${decks.join(', ')}`}
      className="shrink-0 truncate rounded border border-violet-400/30 bg-violet-500/10 px-1 py-px text-[10px] text-violet-200 max-w-[140px]"
    >
      {decks.length === 1 ? decks[0] : `${decks.length} decks`}
    </span>
  )
}

const WUBRG_ORDER = ['W', 'U', 'B', 'R', 'G']

/**
 * How the colour pips combine.
 *
 * 'within' is the default because it answers the question people actually
 * bring to a collection — "what can legally go in this commander's deck" —
 * where a mono-white card belongs in an Abzan list but an Abzan card does not
 * belong in a mono-white one. 'any' and 'exact' are the looser and tighter
 * readings, kept for browsing and for finding exact colour pairs.
 */
type ColorMode = 'any' | 'within' | 'exact'

/**
 * Why a row says ×N — and, when the cost basis is missing, why.
 *
 * Copies logged as separate vault entries are merged for display, so the
 * tooltip says how many entries were folded together; otherwise ×N is just
 * one entry that already recorded a quantity.
 */
function stackHint(o: MtgOwnedItem): string {
  const base = o.entries > 1
    ? `${o.quantity} copies, merged from ${o.entries} vault entries`
    : `${o.quantity} copies in one vault entry`
  return o.entries > 1 && o.purchase_price == null
    ? `${base}. No cost basis shown because not every entry recorded one.`
    : base
}

/** Lookbacks the Owned and Market views can measure a move over. */
type Period = 1 | 7 | 30 | 90
const PERIODS: ReadonlyArray<readonly [Period, string, string]> = [
  [1, '1D', 'day'],
  [7, '1W', 'week'],
  [30, '1M', 'month'],
  [90, '3M', '3 months']
]

function readPeriod(key: string, fallback: Period): Period {
  try {
    const n = Number(localStorage.getItem(key))
    return PERIODS.some(([p]) => p === n) ? (n as Period) : fallback
  } catch {
    return fallback
  }
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86_400_000)
}

/** +$1.20 / −$8.90 — the sign ahead of the dollar. */
const signedMoney = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${money(Math.abs(v))}`

interface Move {
  abs: number
  pct: number
  fromOn: string | null
  toOn: string | null
  /** True when history is shorter than the period, so the move covers less time than it claims. */
  partial: boolean
}

type MovableRow = MtgPeriodPrices & {
  last_price: number | null
  prev_price?: number | null
  prev_on?: string | null
  last_on?: string | null
}

/**
 * Per-unit price move over a period. 1D compares against the previous
 * observed day; longer periods against the lookback point the backend picked
 * (see db.attachPeriodPrices), which may be the oldest point when history is
 * short — `partial` says so rather than letting a 12-day move pass as 30.
 */
function moveOver(r: MovableRow, period: Period): Move | null {
  const [from, fromOn] =
    period === 1 ? [r.prev_price ?? null, r.prev_on ?? null] : [r[`p${period}`], r[`p${period}_on`]]
  if (r.last_price == null || from == null || from === 0) return null
  const toOn = r.last_on ?? null
  const partial = period > 1 && fromOn != null && toOn != null && daysBetween(fromOn, toOn) < period * 0.8
  const abs = r.last_price - from
  return { abs, pct: (abs / from) * 100, fromOn, toOn, partial }
}

/**
 * The move over the chosen period, as a compact badge.
 *
 * Shows PER-UNIT movement, not the holding's — a spike is a fact about the
 * card, and multiplying by quantity would make two copies of a mover look
 * twice as newsworthy as one. The tooltip names both dates, so a move across
 * a gap in the history can't quietly read as a clean one.
 */
function PeriodDelta({ r, period, className = '' }: { r: MovableRow; period: Period; className?: string }): React.JSX.Element | null {
  const m = moveOver(r, period)
  if (!m) return null

  // Sub-0.05% is rounding noise on a cheap card, not a move worth colouring.
  if (Math.abs(m.pct) < 0.05) {
    return <span className={`text-[11px] text-white/30 ${className}`} title={`No change since ${m.fromOn ?? 'the comparison quote'}`}>—</span>
  }

  const up = m.abs > 0
  const span = m.fromOn ? `${m.fromOn} → ${m.toOn ?? 'latest'}` : 'since the comparison quote'
  const short = m.partial ? ' (history is shorter than the period)' : ''
  return (
    <span
      title={`${signedMoney(m.abs)} per unit, ${span}${short}`}
      className={`inline-flex items-center gap-0.5 text-[11px] tabular-nums ${up ? 'text-emerald-400' : 'text-red-400'} ${className}`}
    >
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {m.partial ? '~' : ''}{up ? '+' : ''}{m.pct.toFixed(1)}%
    </span>
  )
}

/** The rung of the MSRP ladder a price sits on (lifecycle.msrpBand). */
function BandChip({ v, prefix }: { v: MtgBandVerdict | null; prefix?: string }): React.JSX.Element | null {
  if (!v) return null
  const pct = (n: number): string => `${n > 0 ? '+' : ''}${n.toFixed(0)}%`
  const [label, tone, title] =
    v.band === 'below_msrp'
      ? [`Below MSRP ${pct(v.overPct)}`, 'border-emerald-400/60 bg-emerald-500/25 text-emerald-200', 'Under list price']
      : v.band === 'at_msrp'
        ? ['At MSRP', 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300', 'Within 2% of list price']
        : v.band === 'near_msrp'
          ? [
              `${pct(v.overPct)} MSRP${v.underMarketPct != null ? ` · ${v.underMarketPct.toFixed(0)}% < mkt` : ''}`,
              'border-amber-400/40 bg-amber-500/15 text-amber-200',
              'A little over list, still well under the secondary market'
            ]
          : [`${pct(v.overPct)} MSRP`, 'border-white/10 bg-white/[0.03] text-white/45', 'Over list price']
  return (
    <span title={title} className={`whitespace-nowrap rounded border px-1.5 py-px text-[10px] tabular-nums ${tone}`}>
      {prefix ? `${prefix} ` : ''}
      {label}
    </span>
  )
}

/**
 * Below this, a percentage move is mostly noise — a $0.40 card going to $0.80
 * is "+100%" and tells you nothing about the market. Applied to the higher of
 * the two prices, so a card that crashed FROM real money still shows up.
 */
const MOVER_MIN_PRICE = 2
const MOVERS_SHOWN = 5

type MoverRow = MovableRow & {
  id: string
  name: string
  quantity?: number
  ext_source: string | null
  ext_id: string | null
  image_url?: string | null
  category?: string
  kind?: string
}

interface MoverSummary<T extends MoverRow> {
  /** Basket value at the start and end of the period, over rows that HAVE a comparison point. */
  from: number
  to: number
  counted: number
  total: number
  /** Rows whose comparison point is younger than the period. */
  partial: number
  up: Array<{ r: T; m: Move }>
  down: Array<{ r: T; m: Move }>
}

/** Basket change plus the top winners and losers by %, for the movers strip. */
function summariseMovers<T extends MoverRow>(rows: T[], period: Period): MoverSummary<T> {
  const out: MoverSummary<T> = { from: 0, to: 0, counted: 0, total: rows.length, partial: 0, up: [], down: [] }
  const moves: Array<{ r: T; m: Move }> = []
  for (const r of rows) {
    const m = moveOver(r, period)
    if (!m || r.last_price == null) continue
    const qty = r.quantity ?? 1
    out.counted++
    if (m.partial) out.partial++
    out.to += r.last_price * qty
    out.from += (r.last_price - m.abs) * qty
    if (Math.max(r.last_price, r.last_price - m.abs) >= MOVER_MIN_PRICE && Math.abs(m.pct) >= 0.05) moves.push({ r, m })
  }
  out.up = moves.filter((x) => x.m.pct > 0).sort((a, b) => b.m.pct - a.m.pct).slice(0, MOVERS_SHOWN)
  out.down = moves.filter((x) => x.m.pct < 0).sort((a, b) => a.m.pct - b.m.pct).slice(0, MOVERS_SHOWN)
  return out
}

function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }): React.JSX.Element {
  return (
    <div className="flex overflow-hidden rounded-md border border-white/10 text-[11px]" title="Measure price moves over">
      {PERIODS.map(([p, label, words]) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          title={`Change over the last ${words}`}
          className={`px-2 py-1 ${value === p ? 'bg-violet-500/25 text-violet-200' : 'text-white/40 hover:bg-white/5'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * "How did the market treat this list over the period" at a glance: the
 * basket's move, then the biggest winners and losers. The basket total only
 * counts rows that have a comparison point, and says how many that is, so a
 * week-old collection isn't reported as having doubled.
 */
function MoversStrip<T extends MoverRow>({
  movers,
  period,
  onPick,
  noun = 'holdings'
}: {
  movers: MoverSummary<T>
  period: Period
  onPick: (r: T) => void
  noun?: string
}): React.JSX.Element | null {
  const words = PERIODS.find(([p]) => p === period)?.[2] ?? `${period} days`
  if (!movers.counted) {
    return (
      <p className="mb-3 text-[11px] text-white/35">
        No price history reaching back a {words} yet. Backfill 90 days to fill it in.
      </p>
    )
  }
  const abs = movers.to - movers.from
  const pct = movers.from > 0 ? (abs / movers.from) * 100 : 0
  const up = abs >= 0
  const column = (title: string, list: Array<{ r: T; m: Move }>, tone: string): React.JSX.Element => (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-white/35">{title}</div>
      {list.length === 0 ? (
        <div className="text-[11px] text-white/25">none over {money(MOVER_MIN_PRICE)}</div>
      ) : (
        <div className="space-y-0.5">
          {list.map(({ r, m }) => (
            <button
              key={r.id}
              onClick={() => onPick(r)}
              title={`${money(r.last_price! - m.abs)} → ${money(r.last_price)}${m.fromOn ? ` · ${m.fromOn} → ${m.toOn ?? 'latest'}` : ''}`}
              className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/5"
            >
              <ProductThumb
                image={imageFor({ extSource: r.ext_source, extId: r.ext_id, imageUrl: r.image_url ?? null }, 'small')}
                alt={r.name}
                size="xs"
                icon={r.category === 'mtg_sealed' || r.category === 'tcg_sealed' || r.kind === 'sealed' ? Box : Sparkles}
              />
              <span className="min-w-0 flex-1 truncate text-xs">{r.name}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-white/40">{signedMoney(m.abs)}</span>
              <span className={`w-14 shrink-0 text-right text-[11px] tabular-nums ${tone}`}>
                {m.partial ? '~' : ''}
                {m.pct > 0 ? '+' : ''}
                {m.pct.toFixed(1)}%
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
  return (
    <div className="mb-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-white/50">Last {words}:</span>
        <span className={`font-semibold tabular-nums ${up ? 'text-emerald-400' : 'text-red-400'}`}>
          {signedMoney(abs)} ({up ? '+' : ''}
          {pct.toFixed(1)}%)
        </span>
        <span className="text-[11px] text-white/35">
          {money(movers.from)} → {money(movers.to)} across {movers.counted}
          {movers.counted < movers.total ? ` of ${movers.total}` : ''} {noun}
          {movers.partial > 0 && ` · ${movers.partial} with shorter history (~)`}
        </span>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        {column('Winners', movers.up, 'text-emerald-400')}
        {column('Losers', movers.down, 'text-red-400')}
      </div>
    </div>
  )
}

/** The card's colour identity as pips — nothing at all when unsynced. */
function IdentityPips({ identity }: { identity: string | null }): React.JSX.Element | null {
  if (identity == null) return null
  const letters = identity ? identity.split(',') : ['C']
  return (
    <span className="inline-flex items-center gap-0.5 align-middle">
      {letters.map((c) => (
        <span
          key={c}
          title={PIPS[c]?.label ?? c}
          className={`inline-block h-2 w-2 rounded-full ${PIP_DOT[c] ?? 'bg-white/30'}`}
        />
      ))}
    </span>
  )
}

/** Solid fills for the row pips — the filter buttons need borders, these don't. */
const PIP_DOT: Record<string, string> = {
  W: 'bg-amber-100',
  U: 'bg-sky-400',
  B: 'bg-violet-400',
  R: 'bg-red-400',
  G: 'bg-emerald-400',
  C: 'bg-white/40'
}

/** Pip colours, keyed by WUBRG letter plus C for colourless. */
const PIPS: Record<string, { label: string; cls: string; on: string }> = {
  W: { label: 'White', cls: 'text-amber-100/70', on: 'bg-amber-100/25 text-amber-50 border-amber-200/50' },
  U: { label: 'Blue', cls: 'text-sky-300/70', on: 'bg-sky-400/25 text-sky-100 border-sky-300/50' },
  B: { label: 'Black', cls: 'text-violet-300/70', on: 'bg-violet-500/25 text-violet-100 border-violet-300/50' },
  R: { label: 'Red', cls: 'text-red-300/70', on: 'bg-red-500/25 text-red-100 border-red-300/50' },
  G: { label: 'Green', cls: 'text-emerald-300/70', on: 'bg-emerald-500/25 text-emerald-100 border-emerald-300/50' },
  C: { label: 'Colorless', cls: 'text-white/45', on: 'bg-white/20 text-white border-white/50' }
}
/** Which card game the Search and Watchlist tabs show — Magic, or a TCGplayer game (tcg.ts). */
const GAME_KEY = 'atlis.mtg.game'

/** An Owned row as the chart panel's selection — shared by the gallery and list. */
function ownedTracked(o: MtgOwnedItem): Tracked {
  return {
    key: `o:${o.id}`,
    name: o.name,
    extId: o.ext_id,
    variant: o.variant ?? 'nonfoil',
    subtitle: `${o.maker ?? o.category} · ${o.variant ?? ''}${o.quantity > 1 ? ` · ×${o.quantity}` : ''}`,
    lastPrice: o.last_price,
    owned: true,
    extSource: o.ext_source,
    imageUrl: null,
    rippable: o.category === 'mtg_sealed',
    magicSealed: o.category === 'mtg_sealed' && o.ext_source === 'tcgplayer',
    // Acquired rows store the set as "SLD" or "SLD #123" in maker.
    setHint: o.set_code ?? o.maker?.split(/[\s#]/)[0]?.toLowerCase() ?? null
  }
}

/** Zoom for a sealed product, from its TCGplayer id — null when it has none. */
function sealedZoom(productId: string | null | undefined, name: string, subtitle?: string | null): Zoom | null {
  const image = productId ? tcgplayerImage(productId, 'large') : null
  return image ? { image, name, subtitle } : null
}

const money = (v: number | null | undefined): string =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const VARIANTS = ['nonfoil', 'foil', 'etched'] as const

type MtgTab = 'search' | 'sets' | 'watchlist' | 'owned' | 'decks' | 'play' | 'commanders' | 'releases' | 'ev'

type SetSort = 'value' | 'valueAsc' | 'reprintPrice' | 'cedh' | 'number' | 'name' | 'rarity'

const SET_SORTS: Array<{ id: SetSort; label: string }> = [
  { id: 'value', label: 'Value high to low' },
  { id: 'valueAsc', label: 'Value low to high' },
  { id: 'reprintPrice', label: 'Cheapest other printing' },
  { id: 'cedh', label: 'cEDH play rate' },
  { id: 'number', label: 'Collector number' },
  { id: 'name', label: 'Name' },
  { id: 'rarity', label: 'Rarity' }
]

/** Scryfall rarities, scarcest first. 'special'/'bonus' are the Eternal-sheet tiers. */
const RARITY_RANK: Record<string, number> = {
  bonus: 0, special: 1, mythic: 2, rare: 3, uncommon: 4, common: 5
}
const RARITY_FILTERS = ['all', 'mythic', 'rare', 'uncommon', 'common', 'special'] as const

/** The set view's "cEDH played" filter keeps the played + staple tiers, not the fringe. */
const CEDH_PLAYED = CEDH_TIERS[1].min

type SetKind = 'all' | 'reprint' | 'new'

/** Reprint / new, cheapest other printing, cEDH rate — the markers on a set card. */
function InsightBadges({ card, ins, busy }: { card: MtgSetCardValue; ins: MtgCardInsight | undefined; busy: boolean }) {
  const cheapest = ins?.cheapest
  const rate = ins?.cedhRate ?? null
  const tier = cedhTier(rate)
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
      {card.reprint === true && (
        <span
          className="rounded bg-sky-500/20 px-1 py-px text-sky-200"
          title={
            cheapest
              ? `Cheapest other printing: ${cheapest.setName} #${cheapest.collectorNumber} (${cheapest.finish})${ins ? ` · ${ins.otherPrintings} other printing(s)` : ''}`
              : 'Printed before'
          }
        >
          Reprint
          {cheapest ? (
            <span className="ml-1 tabular-nums text-sky-100">
              {money(cheapest.price)} <span className="text-sky-200/60">{cheapest.setCode.toUpperCase()}</span>
            </span>
          ) : busy && !ins ? (
            <span className="ml-1 text-sky-200/50">…</span>
          ) : ins ? (
            <span className="ml-1 text-sky-200/50">no quote</span>
          ) : null}
        </span>
      )}
      {card.reprint === false && (
        <span className="rounded bg-emerald-500/20 px-1 py-px text-emerald-200" title="First printing">
          New
        </span>
      )}
      {tier && rate != null && (
        <span
          className={`rounded border px-1 py-px font-medium tabular-nums ${tier.cls}`}
          title={
            ins?.cedhSource === 'lists'
              ? `${tier.label} — in ${pct(rate)} of the cached cEDH top-16 lists (EDHTop16's own rate unavailable)`
              : `${tier.label} — in ${pct(rate)} of cEDH tournament decks over the last year (EDHTop16)`
          }
        >
          cEDH {pct(rate)}
          {ins?.cedhSource === 'lists' && '*'}
        </span>
      )}
    </div>
  )
}

/**
 * Collector numbers are not integers — they carry suffixes ('249★', '5z') and
 * letter prefixes, so a plain string sort puts #10 before #2. Sort on the
 * numeric part, then the raw string to break ties.
 */
function collectorKey(n: string): [number, string] {
  const m = /(\d+)/.exec(n)
  return [m ? Number(m[1]) : Number.MAX_SAFE_INTEGER, n]
}

/**
 * Ranking band, mirroring the main process: unpriced headliners/serialized
 * first (rarest cards in the set, no market has formed), then everything
 * priced, then ordinary unpriced bulk.
 */
const valueBand = (c: MtgSetCardValue): number => (c.bestPrice == null ? (c.notable ? 0 : 2) : 1)

/** Which finishes a printing actually exists in — foil-only cards shouldn't offer nonfoil. */
function finishesOf(card: ScryfallCard): string[] {
  const f = card.finishes?.length ? card.finishes : ['nonfoil']
  return VARIANTS.filter((v) => f.includes(v))
}

function priceOf(card: ScryfallCard, variant: string): number | null {
  const key = variant === 'foil' ? 'usd_foil' : variant === 'etched' ? 'usd_etched' : 'usd'
  const n = Number(card.prices?.[key])
  return isFinite(n) ? n : null
}

/** Double-faced cards carry their images per face, not at the top level. */
const imageOf = (card: ScryfallCard, size: 'normal' | 'large' | 'art_crop' = 'normal'): string | null => {
  const src = card.image_uris ?? card.card_faces?.[0]?.image_uris
  return src?.[size] ?? src?.normal ?? null
}

/**
 * Card search returns raw Scryfall rows; the lightbox speaks the shape the set
 * valuation produces. Converting here means one lightbox serves both, so a
 * result found by name behaves exactly like the same card found by set.
 */
/** Content rows carry the same images and prices, so they get the same lightbox. */
function sealedCardToValue(c: MtgSealedCard): MtgSetCardValue {
  return {
    id: c.scryfallId,
    name: c.name,
    setCode: c.setCode,
    collectorNumber: c.collectorNumber,
    rarity: c.rarity,
    reprint: null,
    bestPrice: c.unitPrice,
    bestFinish: c.priceFinish ?? (c.foil ? 'foil' : 'nonfoil'),
    cheapestPrice: c.unitPrice,
    prices: c.prices,
    promoTypes: [],
    notable: false,
    imageUrl: c.imageUrl,
    imageLarge: c.imageLarge,
    artCrop: c.artCrop
  }
}

function asCardValue(card: ScryfallCard): MtgSetCardValue {
  const prices: Record<string, number | null> = {}
  let bestPrice: number | null = null
  let bestFinish: string | null = null
  let cheapestPrice: number | null = null
  for (const f of finishesOf(card)) {
    const p = priceOf(card, f)
    prices[f] = p
    if (p == null) continue
    if (bestPrice == null || p > bestPrice) { bestPrice = p; bestFinish = f }
    if (cheapestPrice == null || p < cheapestPrice) cheapestPrice = p
  }
  const promoTypes = card.promo_types ?? []
  return {
    id: card.id,
    name: card.name,
    setCode: card.set,
    collectorNumber: card.collector_number,
    rarity: card.rarity,
    reprint: typeof card.reprint === 'boolean' ? card.reprint : null,
    bestPrice,
    bestFinish,
    cheapestPrice,
    prices,
    promoTypes,
    notable: promoTypes.some((t) => t === 'headliner' || t === 'serialized'),
    imageUrl: imageOf(card),
    imageLarge: imageOf(card, 'large'),
    artCrop: imageOf(card, 'art_crop')
  }
}

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

/**
 * MTG tracker: upcoming set calendar, a price-tracked watchlist with target
 * alerts, and Scryfall search to fill both. Prices come from the main-process
 * scheduler; this view only reads and edits.
 */
export default function MtgView() {
  const [sets, setSets] = useState<MtgSet[]>([])
  const [watch, setWatch] = useState<MtgWatchRow[]>([])
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'cards' | 'sealed' | 'set'>('cards')
  const [results, setResults] = useState<ScryfallCard[]>([])
  const [sealedResults, setSealedResults] = useState<MtgSealed[]>([])
  const [setValue, setSetValue] = useState<MtgSetValuation | null>(null)
  const [setView, setSetView] = useState<'grid' | 'list'>('grid')
  const [setSort, setSetSort] = useState<SetSort>('value')
  const [setRarity, setSetRarity] = useState<string>('all')
  const [setFilter, setSetFilter] = useState('')
  const [setKind, setSetKind] = useState<SetKind>('all')
  const [setCedhOnly, setSetCedhOnly] = useState(false)
  const [insights, setInsights] = useState<MtgCardInsights | null>(null)
  const [insightsBusy, setInsightsBusy] = useState(false)
  // Bumped per load so a slow lookup for the previous set can't land on this one.
  const insightsSeq = useRef(0)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteLabel, setPasteLabel] = useState('')
  const [pasteUrl, setPasteUrl] = useState('')
  const [setPage, setSetPage] = useState(0)
  const [pageSize, setPageSize] = useState(60)
  const [ev, setEv] = useState<MtgPackEv | null>(null)
  const [sealedPrices, setSealedPrices] = useState<MtgSealedPriceRow[]>([])
  const [followed, setFollowed] = useState<string[]>([])
  const [sealedBusy, setSealedBusy] = useState(false)
  const [contents, setContents] = useState<MtgSealedContents | null>(null)
  const [contentsBusy, setContentsBusy] = useState<string | null>(null)
  // "What's inside" for the selected Owned / Watchlist row, keyed to that row.
  const [inside, setInside] = useState<{
    key: string
    contents: MtgSealedContents | null
    setCode: string | null
    note: string | null
  } | null>(null)
  const [insideBusy, setInsideBusy] = useState(false)
  const [evBusy, setEvBusy] = useState(false)
  const [lightbox, setLightbox] = useState<MtgSetCardValue | null>(null)
  const [zoom, setZoom] = useState<Zoom | null>(null)
  const [searching, setSearching] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [alertsOn, setAlertsOn] = useState(true)
  const [status, setStatus] = useState<string | null>(null)
  const [owned, setOwned] = useState<MtgOwnedItem[]>([])
  const [ownedQuery, setOwnedQuery] = useState('')
  const [ownedColors, setOwnedColors] = useState<string[]>([])
  const [colorMode, setColorMode] = useState<ColorMode>('within')
  const [syncingMeta, setSyncingMeta] = useState(false)
  // Owned and Market each remember their own lookback: a week is the natural
  // glance for a collection, but an old box barely moves in one.
  const [ownedPeriod, setOwnedPeriodState] = useState<Period>(() => readPeriod(OWNED_PERIOD_KEY, 7))
  const [marketPeriod, setMarketPeriodState] = useState<Period>(() => readPeriod(MARKET_PERIOD_KEY, 30))
  const [ownedSort, setOwnedSort] = useState<OwnedSort>('value')
  /** Minimum cEDH play rate to show; 0 = no filter. */
  const [ownedCedh, setOwnedCedh] = useState(0)
  // Saved-deck membership: everything, cards some deck runs, or cards no deck runs.
  const [ownedDeck, setOwnedDeck] = useState<'all' | 'in_deck' | 'loose'>('all')
  const [syncingCedh, setSyncingCedh] = useState(false)
  const [watchMode, setWatchModeState] = useState<'hunt' | 'market'>(() => {
    try {
      return localStorage.getItem(WATCH_MODE_KEY) === 'market' ? 'market' : 'hunt'
    } catch {
      return 'hunt'
    }
  })
  const remember = (key: string, v: string): void => {
    try {
      localStorage.setItem(key, v)
    } catch {
      /* not persisted — fine */
    }
  }
  const setOwnedPeriod = (p: Period): void => { setOwnedPeriodState(p); remember(OWNED_PERIOD_KEY, String(p)) }
  const setMarketPeriod = (p: Period): void => { setMarketPeriodState(p); remember(MARKET_PERIOD_KEY, String(p)) }
  const setWatchMode = (m: 'hunt' | 'market'): void => { setWatchModeState(m); remember(WATCH_MODE_KEY, m) }
  const [tab, setTab] = useState<MtgTab>('search')
  // Other card games share this page through one dropdown. Magic is this
  // page's own Scryfall/MTGJSON world and renders exactly as before; any other
  // game swaps in TCGplayer-backed Search and Watchlist panes. A running app
  // whose preload predates tcg:* simply shows no dropdown — Magic keeps working.
  const tcgBridge = typeof window.atlis.tcg?.games === 'function'
  const [game, setGameState] = useState<string>(() => {
    try {
      return localStorage.getItem(GAME_KEY) || 'magic'
    } catch {
      return 'magic'
    }
  })
  const [tcgGames, setTcgGames] = useState<TcgGame[]>([])
  const [tcgCounts, setTcgCounts] = useState<Record<string, number>>({})
  const activeGame: TcgGame | null =
    game === 'magic' || !tcgBridge ? null : (tcgGames.find((g) => g.url === game) ?? { url: game, label: '…' })
  const loadTcgCounts = useCallback(async () => {
    if (tcgBridge) setTcgCounts(await window.atlis.tcg.counts())
  }, [tcgBridge])
  useEffect(() => {
    if (!tcgBridge) return
    void window.atlis.tcg.games().then(setTcgGames)
    void loadTcgCounts()
    return window.atlis.tcg.onChanged(() => void loadTcgCounts())
  }, [tcgBridge, loadTcgCounts])
  const setGame = (g: string): void => {
    setGameState(g)
    try {
      localStorage.setItem(GAME_KEY, g)
    } catch {
      /* storage unavailable — the choice just doesn't persist */
    }
    // Releases and EV are Magic's own data; another game has nothing to show there.
    if (g !== 'magic' && (tab === 'sets' || tab === 'releases' || tab === 'ev' || tab === 'commanders' || tab === 'decks' || tab === 'play')) setTab('search')
  }
  const [backfilling, setBackfilling] = useState(false)
  const [backfillNote, setBackfillNote] = useState<string | null>(null)
  const [selected, setSelected] = useState<Tracked | null>(null)
  const [ripping, setRipping] = useState(false)
  const [ownedLayout, setOwnedLayoutState] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem(OWNED_LAYOUT_KEY) === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const setOwnedLayout = (v: 'grid' | 'list'): void => {
    setOwnedLayoutState(v)
    try {
      localStorage.setItem(OWNED_LAYOUT_KEY, v)
    } catch {
      /* not persisted — fine */
    }
  }
  const [history, setHistory] = useState<MtgPrice[]>([])

  const load = useCallback(async () => {
    const [u, w, o] = await Promise.all([
      window.atlis.mtg.upcoming(540),
      window.atlis.mtg.watchlist(),
      window.atlis.mtg.owned()
    ])
    setSets(u)
    setWatch(w)
    setOwned(o)
  }, [])

  useEffect(() => {
    void load()
    void window.atlis.mtg.alertsEnabled().then(setAlertsOn)
    return window.atlis.mtg.onChanged(() => void load())
  }, [load])

  useEffect(() => { void window.atlis.mtg.sealedFollowed().then(setFollowed).catch(() => {}) }, [])
  // First run has an empty set cache — pull it so the calendar isn't blank.
  useEffect(() => {
    if (sets.length === 0 && !syncing) void syncSets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sets.length])

  useEffect(() => {
    if (!selected?.extId) { setHistory([]); return }
    void window.atlis.mtg.prices(selected.extId, selected.variant, 400).then(setHistory)
  }, [selected])

  // One-off, opt-in, and slow: MTGJSON's 90-day file is the only price-history
  // source that exists (Scryfall has none, TCGplayer exposes no history
  // endpoint) and it streams ~900MB. Progress is surfaced so it doesn't look
  // hung.
  useEffect(() => window.atlis.mtg.onBackfillProgress((p) => {
    const q = p as MtgBackfillProgress
    if (q.phase === 'streaming') {
      setBackfillNote(`Streaming MTGJSON history… ${q.megabytes ?? 0} MB scanned, ${q.found ?? 0} card(s) matched`)
    } else if (q.phase === 'done') {
      setBackfillNote(null)
    } else if (q.message) {
      setBackfillNote(q.message)
    }
  }), [])

  async function toggleFollowSealed(): Promise<void> {
    const code = setValue?.sets[0]?.code
    if (!code) return
    const next = await window.atlis.mtg.followSealed(code, !followed.includes(code))
    setFollowed(next)
    setStatus(
      next.includes(code)
        ? `Now tracking every sealed product in ${setValue.sets[0].name} daily.`
        : `Stopped tracking sealed for ${setValue.sets[0].name}.`
    )
  }

  async function refreshSealedNow(): Promise<void> {
    setSealedBusy(true)
    try {
      const r = await window.atlis.mtg.refreshSealed()
      setStatus(
        r.products === 0
          ? 'No followed sets yet — hit "Track sealed" on a set first.'
          : `Priced ${r.priced}/${r.products} sealed product(s) across ${r.sets} set(s).`
      )
      const code = setValue?.sets[0]?.code
      if (code) setSealedPrices(await window.atlis.mtg.sealedPrices(code, 60))
    } finally {
      setSealedBusy(false)
    }
  }

  async function loadEv(boosterType: 'collector' | 'play'): Promise<void> {
    if (!setValue) return
    setEvBusy(true)
    try {
      setEv(await window.atlis.mtg.packEv(setValue.sets[0].code, boosterType))
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setEvBusy(false)
    }
  }

  async function backfill(): Promise<void> {
    setBackfilling(true)
    setBackfillNote('Starting…')
    try {
      const r = await window.atlis.mtg.backfill()
      setStatus(
        r.points === 0
          ? `No history found. Streamed ${r.megabytes} MB; ${r.matched}/${r.cards} card(s) mapped.${r.errors.length ? ` ${r.errors[0]}` : ''}`
          : `Backfilled ${r.points} price point(s) across ${r.matched} card(s) — ${r.megabytes} MB in ${Math.round(r.seconds)}s.`
      )
      await load()
      if (selected?.extId) {
        setHistory(await window.atlis.mtg.prices(selected.extId, selected.variant, 400))
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBackfilling(false)
      setBackfillNote(null)
    }
  }

  async function rebuildHistory(): Promise<void> {
    const r = await window.atlis.mtg.rebuildHistory()
    setStatus(
      r.points === 0
        ? 'Every owned item already has its full history — nothing to rebuild.'
        : `Rebuilt ${r.points} price point${r.points === 1 ? '' : 's'} across ${r.items} owned item${r.items === 1 ? '' : 's'}.`
    )
    await load()
  }

  async function syncSets(): Promise<void> {
    setSyncing(true)
    try {
      const r = await window.atlis.mtg.syncSets()
      setStatus(`${r.count} sets synced · ${r.created} calendar entries added${r.updated ? `, ${r.updated} moved` : ''}`)
      await load()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
    }
  }

  async function refreshPrices(): Promise<void> {
    setRefreshing(true)
    try {
      const r = await window.atlis.mtg.refreshPrices()
      setStatus(
        r.checked === 0
          ? 'Nothing tracked yet — search for a card and add it to the watchlist.'
          : `${r.priced}/${r.checked} priced${r.alerts ? ` · ${r.alerts} target hit` : ''}${r.errors.length ? ` · ${r.errors.length} problem(s)` : ''}`
      )
      await load()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  /**
   * Second pass over a loaded set: cheapest other printing for each reprint,
   * cEDH rate for every card. Slow for a big family (a request per ~20
   * reprints), so the cards render first and the markers fill in after.
   */
  async function loadInsights(v: MtgSetValuation): Promise<void> {
    const seq = ++insightsSeq.current
    setInsights(null)
    if (!v.cardCount) { setInsightsBusy(false); return }
    const names = [...new Set(v.cards.map((c) => c.name))]
    const reprintNames = [...new Set(v.cards.filter((c) => c.reprint).map((c) => c.name))]
    setInsightsBusy(true)
    try {
      const source = v.source ?? 'set'
      const r = await window.atlis.mtg.cardInsights(
        names,
        reprintNames,
        source === 'set' ? v.sets.map((x) => x.code) : [],
        // A product lives inside a shared set (all of Secret Lair is `sld`),
        // so only its own printings are left out of "cheapest elsewhere".
        source === 'product' ? v.cards.map((c) => c.id) : []
      )
      if (seq !== insightsSeq.current) return
      setInsights(r)
      const notes = [r.cedhNote, r.priceNote].filter(Boolean)
      if (notes.length) setStatus(notes.join(' '))
    } catch (err) {
      if (seq === insightsSeq.current) setStatus(`Reprint/cEDH lookup failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (seq === insightsSeq.current) setInsightsBusy(false)
    }
  }

  /**
   * A product Scryfall has no set for yet: value its card list instead —
   * pasted, or read off a spoiler article / announcement by URL.
   */
  async function loadList(fromUrl = false): Promise<void> {
    if (fromUrl ? !pasteUrl.trim() : !pasteText.trim()) return
    setSearching(true)
    try {
      const v = fromUrl
        ? await window.atlis.mtg.valueFromUrl(pasteUrl)
        : await window.atlis.mtg.valueCardList(pasteText, pasteLabel || query || undefined)
      setSetValue(v.cardCount ? v : null)
      setSetSort('reprintPrice')
      setEv(null)
      setSealedPrices([])
      setResults([])
      setSealedResults([])
      setStatus(v.note)
      setPasteOpen(false)
      void loadInsights(v)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }

  async function loadSet(q: string): Promise<void> {
    const v = await window.atlis.mtg.valueSet(q)
    setSetValue(v.cardCount ? v : null)
    // A Secret Lair product is mostly reprints with no price of its own yet.
    if (v.source === 'product') setSetSort('reprintPrice')
    void loadInsights(v)
    setEv(null)
    setSealedPrices(v.sets[0] ? await window.atlis.mtg.sealedPrices(v.sets[0].code, 60) : [])
    setResults([])
    setSealedResults([])
    setStatus(
      v.note ??
        `${v.sets.map((x) => x.name).join(' + ')} — ${v.cardCount} printings, ${v.pricedCount} priced.`
    )
  }

  /** Look inside the selected sealed row; a second press hides it. */
  async function showInside(t: Tracked): Promise<void> {
    if (inside?.key === t.key) { setInside(null); return }
    if (!t.extId) return
    setInsideBusy(true)
    try {
      const r = await window.atlis.mtg.productContents(t.extId, t.setHint ?? null)
      setInside({ key: t.key, ...r })
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setInsideBusy(false)
    }
  }

  /** A Secret Lair product from the Releases tab: its card list, in the Set search. */
  async function showProduct(name: string): Promise<void> {
    if (activeGame) setGame('magic')
    setTab('search')
    setMode('set')
    setQuery(name)
    setSearching(true)
    try {
      await loadSet(name)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }

  /** Random-booster products have no fixed list — the set is the answer. */
  async function showSet(code: string): Promise<void> {
    if (activeGame) setGame('magic')
    setTab('search')
    setMode('set')
    setQuery(code)
    setSearching(true)
    try {
      await loadSet(code)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }

  async function runSearch(e?: React.FormEvent): Promise<void> {
    e?.preventDefault()
    if (!query.trim()) return
    setSearching(true)
    try {
      if (mode === 'set') {
        await loadSet(query)
      } else if (mode === 'sealed') {
        const r = await window.atlis.mtg.searchSealed(query)
        setSealedResults(r.products)
        setResults([])
        setSetValue(null)
        setStatus(r.note)
      } else {
        const r = await window.atlis.mtg.search(query)
        setResults(r.cards)
        setSealedResults([])
        setSetValue(null)
        // Always say when the query was rewritten, so the results never look arbitrary.
        setStatus(
          r.cards.length === 0
            ? `No matches for “${query.trim()}”. Try just the card name, or add the set name (e.g. “arcane signet hobbit”).`
            : r.note
        )
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
      setResults([])
      setSealedResults([])
      setSetValue(null)
    } finally {
      setSearching(false)
    }
  }

  /**
   * Open a sealed product up. Slow the first time (a decklist is a 600KB
   * MTGJSON fetch plus batched Scryfall pricing), cached for six hours after.
   */
  async function openContents(p: MtgSealed): Promise<void> {
    if (contents?.uuid === p.uuid) { setContents(null); return }
    setContentsBusy(p.uuid)
    setContents(null)
    try {
      const c = await window.atlis.mtg.sealedContents(p.uuid)
      setContents(c)
      if (c && !c.cards.length) setStatus(c.note)
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setContentsBusy(null)
    }
  }

  async function addSealedToWatch(p: MtgSealed): Promise<void> {
    if (!p.tcgplayer_product_id) {
      setStatus(`“${p.name}” has no TCGplayer id in MTGJSON, so it can't be auto-priced. Add it to the Vault manually instead.`)
      return
    }
    await window.atlis.mtg.createWatch({
      kind: 'sealed',
      name: p.name,
      set_code: p.set_code,
      ext_source: 'tcgplayer',
      ext_id: p.tcgplayer_product_id,
      variant: 'sealed',
      target_price: null
    })
    setStatus(`${p.name} added — hit Refresh prices to pull its first quote.`)
    await load()
  }

  /**
   * "I own this" — one press instead of track-then-find-it-and-acquire. The
   * Vault item is created through the same acquire path the watchlist uses, so
   * any price history already collected for that printing is carried over.
   */
  async function ownIt(
    input: Parameters<typeof window.atlis.mtg.createWatch>[0],
    label = input.name
  ): Promise<void> {
    try {
      const w = await window.atlis.mtg.createWatch(input)
      const item = await window.atlis.mtg.acquireWatch(w.id)
      setStatus(
        `${label} added to Owned` +
          (item.carriedPoints ? ` — ${item.carriedPoints} day(s) of price history carried over.` : '.')
      )
      await load()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * "Ripped" — one owned sealed copy becomes the cards it held. Asks first,
   * since the sealed copy leaves Owned and that isn't undoable from here.
   */
  async function ripIt(t: Tracked): Promise<void> {
    const id = t.key.slice(2)
    if (!window.confirm(`Mark one “${t.name}” as ripped? Its cards are added to Owned and the sealed copy is removed.`)) return
    setRipping(true)
    try {
      const r = await window.atlis.mtg.ripSealed(id)
      setStatus(
        `Ripped ${r.product} — added ${r.cards} card${r.cards === 1 ? '' : 's'} (${r.added} printing${r.added === 1 ? '' : 's'}) to Owned` +
          (r.remaining > 0 ? `, ${r.remaining} sealed left.` : '.') +
          (r.note ? ` Note: ${r.note}` : '')
      )
      setSelected(null)
      await load()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setRipping(false)
    }
  }

  async function addToWatch(card: ScryfallCard, variant: string): Promise<void> {
    await window.atlis.mtg.createWatch({
      kind: 'card',
      name: card.name,
      set_code: card.set,
      collector_number: card.collector_number,
      image_url: imageOf(card),
      ext_source: 'scryfall',
      ext_id: card.id,
      variant,
      target_price: null
    })
    setStatus(`${card.name} (${variant}) added — set a target price to get alerts.`)
    await load()
  }

  /**
   * Pull the Scryfall facts the colour filter needs for cards that lack them.
   *
   * Runs on its own rather than as part of load() because it is a network
   * round trip against a rate-limited API: the list must render immediately
   * from what is already cached, and fill in behind it.
   */
  const syncCardMeta = useCallback(async (): Promise<void> => {
    setSyncingMeta(true)
    try {
      const r = await window.atlis.mtg.syncCardMeta()
      if (r.fetched) await load()
      if (r.missing) setStatus(`${r.fetched} card${r.fetched === 1 ? '' : 's'} synced — Scryfall had no record of ${r.missing}.`)
    } catch (e) {
      setStatus(`Card sync failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSyncingMeta(false)
    }
  }, [load])

  /**
   * The Owned rows after the search box and colour pips.
   *
   * Text matches name, set and type line together, so "goblin" finds the
   * tribe by name and "creature" finds the whole board — one box rather than
   * three, because at collection scale you rarely know which field holds the
   * word you remember.
   */
  const filteredOwned = useMemo(() => {
    const q = ownedQuery.trim().toLowerCase()
    const terms = q ? q.split(/\s+/) : []
    return owned.filter((o) => {
      if (terms.length) {
        const hay = `${o.name} ${o.maker ?? ''} ${o.set_code ?? ''} ${o.type_line ?? ''}`.toLowerCase()
        if (!terms.every((t) => hay.includes(t))) return false
      }
      // Unplayed and not-yet-synced both fail a cEDH floor; sealed has no rate.
      if (ownedCedh > 0 && (o.cedh_play_rate ?? 0) < ownedCedh) return false
      // Only singles can sit in a deck; sealed product drops out of both views.
      if (ownedDeck !== 'all') {
        if (o.category !== 'mtg_card') return false
        if ((ownedDeck === 'in_deck') !== ((o.decks?.length ?? 0) > 0)) return false
      }
      if (!ownedColors.length) return true
      // Unsynced rows have no identity to test, so a colour filter hides them
      // rather than guessing — the header says how many are waiting.
      if (o.color_identity == null) return false
      const ci = o.color_identity ? o.color_identity.split(',') : []
      const want = ownedColors.filter((c) => c !== 'C')
      const wantColorless = ownedColors.includes('C')
      if (colorMode === 'exact') {
        if (wantColorless && !want.length) return ci.length === 0
        return ci.join(',') === WUBRG_ORDER.filter((c) => want.includes(c)).join(',')
      }
      if (colorMode === 'within') {
        // Deckbuilding's real question: legal in a commander of these colours.
        // Colourless fits every deck, which is exactly why it swamps a colour
        // search — so it only joins when the C pip is picked too.
        if (!ci.length) return wantColorless
        return ci.every((c) => want.includes(c))
      }
      // 'any' — at least one of the picked colours, colourless counted only if asked.
      if (!ci.length) return wantColorless
      return ci.some((c) => want.includes(c))
    })
  }, [owned, ownedQuery, ownedColors, colorMode, ownedCedh, ownedDeck])

  const unsyncedOwned = useMemo(
    () => owned.filter((o) => o.color_identity == null && o.category !== 'mtg_sealed' && o.category !== 'tcg_sealed').length,
    [owned]
  )

  const ownedTotal = useMemo(
    () => filteredOwned.reduce((sum, o) => sum + (o.last_price ?? 0) * o.quantity, 0),
    [filteredOwned]
  )

  /**
   * "Most valuable" ranks by what ONE copy is worth, so 100 × $1 cards don't
   * sit beside a $100 card; "Largest holdings" is the backend's price ×
   * quantity order. Movers rank by % over the chosen period, unknowns last.
   */
  const sortedOwned = useMemo(() => {
    if (ownedSort === 'holding') return filteredOwned
    if (ownedSort === 'value') {
      return [...filteredOwned].sort((a, b) =>
        (b.last_price ?? -1) - (a.last_price ?? -1) || (b.last_price ?? 0) * b.quantity - (a.last_price ?? 0) * a.quantity)
    }
    if (ownedSort === 'cedh') {
      return [...filteredOwned].sort((a, b) => (b.cedh_play_rate ?? -1) - (a.cedh_play_rate ?? -1))
    }
    const dir = ownedSort === 'gainers' ? -1 : 1
    return [...filteredOwned].sort((a, b) => {
      const ma = moveOver(a, ownedPeriod)
      const mb = moveOver(b, ownedPeriod)
      if (!ma || !mb) return ma ? -1 : mb ? 1 : 0
      return dir * (ma.pct - mb.pct)
    })
  }, [filteredOwned, ownedSort, ownedPeriod])

  const ownedMovers = useMemo(() => summariseMovers(filteredOwned, ownedPeriod), [filteredOwned, ownedPeriod])

  const watchCounts = useMemo(
    () => ({
      hunt: watch.filter((w) => w.mode === 'hunt').length,
      market: watch.filter((w) => w.mode === 'market').length
    }),
    [watch]
  )
  /**
   * Hunt sorts what's buyable at a good price first, then by street date
   * (soonest first). Market keeps the newest-tracked order.
   */
  const shownWatch = useMemo(() => {
    const rows = watch.filter((w) => w.mode === watchMode)
    if (watchMode === 'market') return rows
    const rank = (w: MtgWatchRow): number =>
      w.retail_band ? ['below_msrp', 'at_msrp', 'near_msrp', 'over_msrp'].indexOf(w.retail_band.band) : 4
    return [...rows].sort(
      (a, b) => rank(a) - rank(b) || (a.released_at ?? '9999').localeCompare(b.released_at ?? '9999')
    )
  }, [watch, watchMode])
  const marketMovers = useMemo(
    () => summariseMovers(watchMode === 'market' ? shownWatch : [], marketPeriod),
    [shownWatch, watchMode, marketPeriod]
  )
  const watchSelection = (w: MtgWatchRow): Tracked => ({
    key: `w:${w.id}`,
    name: w.name,
    extId: w.ext_id,
    variant: w.variant,
    subtitle: `${w.set_code?.toUpperCase() ?? ''}${w.collector_number ? ` #${w.collector_number}` : ''} · ${w.variant}`,
    lastPrice: w.last_price,
    owned: false,
    extSource: w.ext_source,
    imageUrl: w.image_url,
    magicSealed: w.kind === 'sealed' && w.ext_source === 'tcgplayer',
    setHint: w.set_code
  })

  /**
   * Fill the metadata gap the first time the Owned tab is opened with cards
   * waiting on it. Gated on the tab so a user who never opens Owned never
   * pays for the calls.
   *
   * The ref is load-bearing, not a nicety: a card Scryfall has no record of
   * stays a gap after a successful sync, so keying the effect on "gaps remain"
   * alone would refire forever against a rate-limited API. One automatic
   * attempt per session; the count in the header stays clickable for a retry.
   */
  const metaSyncTried = useRef(false)
  useEffect(() => {
    if (tab !== 'owned' || unsyncedOwned === 0 || metaSyncTried.current) return
    metaSyncTried.current = true
    void syncCardMeta()
  }, [tab, unsyncedOwned, syncCardMeta])

  /** Cards with colour data (so a Scryfall name to ask about) but no cEDH answer yet. */
  const unsyncedCedh = useMemo(
    () => owned.filter((o) => o.ext_source === 'scryfall' && o.color_identity != null && !o.cedh_synced).length,
    [owned]
  )

  const syncCedh = useCallback(
    async (force = false): Promise<void> => {
      setSyncingCedh(true)
      try {
        const r = await window.atlis.mtg.syncCedh(force)
        if (r.asked) await load()
        if (r.failed.length) setStatus(`cEDH sync stopped early — ${r.failed[0]}`)
        else if (force) setStatus(`cEDH play rates refreshed for ${r.asked} card(s); ${r.played} show up in tournament decks.`)
      } catch (e) {
        setStatus(`cEDH sync failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setSyncingCedh(false)
      }
    },
    [load]
  )

  /**
   * On opening Owned: the first run asks EDHTop16 about anything new or more
   * than a week old (the backend decides, so it is usually a no-op). One more
   * run is allowed if a colour sync then makes new cards askable — capped, so
   * an EDHTop16 outage cannot turn this into a retry loop.
   */
  const cedhRuns = useRef(0)
  useEffect(() => {
    if (tab !== 'owned' || syncingMeta || syncingCedh) return
    if (cedhRuns.current === 0 || (unsyncedCedh > 0 && cedhRuns.current < 2)) {
      cedhRuns.current++
      void syncCedh()
    }
  }, [tab, syncingMeta, syncingCedh, unsyncedCedh, syncCedh])

  const totalTracked = useMemo(
    () => watch.reduce((sum, w) => sum + (w.last_price ?? 0), 0),
    [watch]
  )

  const chartData = useMemo(
    () => [...history].reverse().map((p) => ({ day: p.observed_on.slice(5), price: p.price })),
    [history]
  )

  // ------------------------------------------------- set browsing
  // valueSet() returns EVERY printing in the family; the page slices it here so
  // a 479-card set can be browsed whole without rendering 479 card images.

  /** Rarities actually present, so the chips don't offer empty filters. */
  const rarityChips = useMemo(() => {
    if (!setValue) return []
    const present = new Set(setValue.cards.map((c) => c.rarity))
    return RARITY_FILTERS.filter((r) => r === 'all' || present.has(r))
  }, [setValue])

  const visibleCards = useMemo(() => {
    if (!setValue) return []
    const q = setFilter.trim().toLowerCase()
    let out = setValue.cards
    if (setRarity !== 'all') out = out.filter((c) => c.rarity === setRarity)
    if (setKind !== 'all') out = out.filter((c) => (setKind === 'reprint' ? c.reprint === true : c.reprint === false))
    if (setCedhOnly) out = out.filter((c) => (insights?.cards[c.name]?.cedhRate ?? 0) >= CEDH_PLAYED)
    const elsewhere = (c: MtgSetCardValue): number | null => insights?.cards[c.name]?.cheapest?.price ?? null
    const rate = (c: MtgSetCardValue): number => insights?.cards[c.name]?.cedhRate ?? -1
    if (q)
      out = out.filter(
        (c) => c.name.toLowerCase().includes(q) || c.collectorNumber.toLowerCase() === q
      )
    const sorted = [...out]
    sorted.sort((a, b) => {
      switch (setSort) {
        case 'valueAsc':
          // Unpriced cards have no place at the "cheapest" end — park them last
          // in both directions rather than pretending they're worth $0.
          return (
            Number(a.bestPrice == null) - Number(b.bestPrice == null) ||
            (a.bestPrice ?? 0) - (b.bestPrice ?? 0) ||
            a.name.localeCompare(b.name)
          )
        case 'reprintPrice':
          // Cards with no other printing (new cards) park at the bottom.
          return (
            Number(elsewhere(a) == null) - Number(elsewhere(b) == null) ||
            (elsewhere(b) ?? 0) - (elsewhere(a) ?? 0) ||
            a.name.localeCompare(b.name)
          )
        case 'cedh':
          return rate(b) - rate(a) || (elsewhere(b) ?? 0) - (elsewhere(a) ?? 0) || a.name.localeCompare(b.name)
        case 'number': {
          const [an, as_] = collectorKey(a.collectorNumber)
          const [bn, bs] = collectorKey(b.collectorNumber)
          return a.setCode.localeCompare(b.setCode) || an - bn || as_.localeCompare(bs)
        }
        case 'name':
          return a.name.localeCompare(b.name) || collectorKey(a.collectorNumber)[0] - collectorKey(b.collectorNumber)[0]
        case 'rarity':
          return (
            (RARITY_RANK[a.rarity] ?? 9) - (RARITY_RANK[b.rarity] ?? 9) ||
            (b.bestPrice ?? 0) - (a.bestPrice ?? 0) ||
            a.name.localeCompare(b.name)
          )
        default:
          return (
            valueBand(a) - valueBand(b) ||
            (b.bestPrice ?? 0) - (a.bestPrice ?? 0) ||
            a.name.localeCompare(b.name)
          )
      }
    })
    return sorted
  }, [setValue, setFilter, setRarity, setSort, setKind, setCedhOnly, insights])

  /**
   * What the reprints in view cost at their cheapest other printing — one per
   * card NAME, since a set's borderless/showcase copies are the same reprint.
   */
  const reprintTotal = useMemo(() => {
    if (!insights) return null
    const seen = new Set<string>()
    let sum = 0
    let n = 0
    for (const c of visibleCards) {
      if (!c.reprint || seen.has(c.name)) continue
      seen.add(c.name)
      const p = insights.cards[c.name]?.cheapest?.price
      if (p != null) { sum += p; n++ }
    }
    return { sum, n }
  }, [visibleCards, insights])

  const cedhCount = useMemo(() => {
    if (!insights || !setValue) return 0
    return new Set(setValue.cards.filter((c) => (insights.cards[c.name]?.cedhRate ?? 0) >= CEDH_PLAYED).map((c) => c.name)).size
  }, [insights, setValue])

  /** Value of what's currently filtered in — answers "what do the rares cost?". */
  const visibleTotal = useMemo(
    () => visibleCards.reduce((sum, c) => sum + (c.bestPrice ?? 0), 0),
    [visibleCards]
  )

  // pageSize 0 = show everything on one page
  const isList = tab === 'watchlist' || tab === 'owned'
  // Another game's watchlist charts inline per row; the side panel is Magic's.
  const showChart = isList && !(tab === 'watchlist' && activeGame)

  const pageCount = pageSize === 0 ? 1 : Math.max(1, Math.ceil(visibleCards.length / pageSize))
  const page = Math.min(setPage, pageCount - 1)
  const pageStart = pageSize === 0 ? 0 : page * pageSize
  const pageCards = pageSize === 0 ? visibleCards : visibleCards.slice(pageStart, pageStart + pageSize)

  // Any change to what's listed sends you back to page 1 — otherwise filtering a
  // 479-card set while on page 7 lands you on an empty page.
  useEffect(() => {
    setSetPage(0)
  }, [setValue, setFilter, setRarity, setSort, pageSize, setKind, setCedhOnly])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-white/10 px-5 py-3">
        <Sparkles className="h-5 w-5 text-violet-400" />
        <div className="flex-1">
          <h1 className="text-sm font-semibold">Magic</h1>
          <p className="text-xs text-white/50">
            {watch.length} tracked · {money(totalTracked)} at last quote
          </p>
        </div>
        {/* Master mute. The per-row bell decides WHICH rows may alert; this
            decides whether any desktop notification fires at all. */}
        <button
          onClick={() =>
            void window.atlis.mtg.setAlertsEnabled(!alertsOn).then(() => {
              setAlertsOn(!alertsOn)
              setStatus(!alertsOn ? 'Desktop alerts on.' : 'Desktop alerts muted — nothing will pop up.')
            })
          }
          title={alertsOn ? 'Desktop alerts are on — click to mute' : 'Desktop alerts are muted — click to unmute'}
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${
            alertsOn ? 'border-white/10 hover:bg-white/5' : 'border-amber-400/40 bg-amber-500/10 text-amber-200'
          }`}
        >
          {alertsOn ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
          {alertsOn ? 'Alerts on' : 'Muted'}
        </button>
        <button
          onClick={() => void syncSets()}
          disabled={syncing}
          className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-xs hover:bg-white/5 disabled:opacity-50"
        >
          {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarDays className="h-3.5 w-3.5" />}
          Sync sets
        </button>
        <button
          onClick={() => void refreshPrices()}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-xs hover:bg-white/5 disabled:opacity-50"
        >
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh prices
        </button>
      </header>

      {status && (
        <div className="border-b border-white/10 bg-white/5 px-5 py-2 text-xs text-white/70">{status}</div>
      )}
      {backfillNote && (
        <div className="flex items-center gap-2 border-b border-white/10 bg-violet-500/10 px-5 py-2 text-xs text-violet-200">
          <Loader2 className="h-3 w-3 animate-spin" />
          {backfillNote}
        </div>
      )}

      {/* One page, four jobs. They used to share a single scroll column, which
          meant the search box, the release calendar and the watchlist all
          competed for the top of the page. */}
      <nav className="flex items-center gap-1 border-b border-white/10 px-5 py-2">
        {tcgBridge && (
          <select
            value={activeGame ? activeGame.url : 'magic'}
            onChange={(e) => setGame(e.target.value)}
            title="Which card game Search and Watchlist show"
            className="mr-2 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs font-medium text-white/85 outline-none focus:border-violet-400/50"
          >
            <option value="magic">Magic</option>
            {tcgGames.map((g) => (
              <option key={g.url} value={g.url}>
                {g.label}
                {tcgCounts[g.url] ? ` (${tcgCounts[g.url]})` : ''}
              </option>
            ))}
          </select>
        )}
        {([
          ['search', 'Search', null],
          ['sets', 'Sets', null],
          ['watchlist', 'Watchlist', activeGame ? (tcgCounts[activeGame.url] ?? 0) : watch.length],
          ['owned', 'Owned', owned.length],
          ['decks', 'Decks', null],
          ['play', 'Play', null],
          ['commanders', 'Commanders', null],
          ['releases', 'Releases', null],
          ['ev', 'EV', null]
        ] as const)
          .filter(([id]) => !activeGame || (id !== 'sets' && id !== 'releases' && id !== 'ev' && id !== 'commanders' && id !== 'decks' && id !== 'play'))
          .map(([id, label, count]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === id ? 'bg-violet-500/20 text-violet-200' : 'text-white/45 hover:bg-white/5 hover:text-white/80'
            }`}
          >
            {label}
            {count ? <span className="ml-1.5 text-[10px] opacity-60">{count}</span> : null}
          </button>
        ))}
        {tab === 'owned' && owned.length > 0 && (
          <span className="ml-auto text-[11px] tabular-nums text-white/40">{money(ownedTotal)} at last quote</span>
        )}
      </nav>

      {/* The price chart only means something next to a selected row, so the
          side column exists on the list tabs and nowhere else. */}
      {/* The side panel grows with the window (up to 560px) so a wide screen
          gives the chart and picture the room instead of a longer row. */}
      <div
        className={`grid flex-1 overflow-hidden ${
          showChart ? 'grid-cols-[minmax(0,1fr)_clamp(320px,26vw,560px)]' : 'grid-cols-1'
        }`}
      >
        {tab === 'sets' ? (
          <div className="overflow-y-auto p-5">
            <SetsTab onChanged={() => void load()} />
          </div>
        ) : tab === 'releases' ? (
          <div className="overflow-y-auto">
            <ReleasesTab onStatus={setStatus} onShowCards={(name) => void showProduct(name)} />
          </div>
        ) : tab === 'ev' ? (
          <div className="overflow-y-auto">
            <EvTab onStatus={setStatus} />
          </div>
        ) : tab === 'commanders' ? (
          <div className="overflow-y-auto p-5">
            <CommandersTab onStatus={setStatus} />
          </div>
        ) : tab === 'decks' ? (
          <div className="overflow-y-auto p-5">
            <DecksTab onStatus={setStatus} />
          </div>
        ) : tab === 'play' ? (
          <div className="overflow-y-auto p-5">
            <PlayTab onStatus={setStatus} />
          </div>
        ) : (
        <div className="overflow-y-auto p-5">
          {tab === 'search' && activeGame && <TcgSearchPane game={activeGame} onChanged={loadTcgCounts} />}
          {tab === 'search' && !activeGame && (
          <>
          <form onSubmit={runSearch} className="mb-5 flex gap-2">
            <div className="flex shrink-0 overflow-hidden rounded-md border border-white/10">
              {(['cards', 'sealed', 'set'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-3 py-2 text-xs capitalize ${
                    mode === m ? 'bg-violet-500/80 font-medium' : 'text-white/50 hover:bg-white/5'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  mode === 'set'
                    ? 'A set name or code — e.g. hobbit, reality fracture, hoc'
                    : mode === 'sealed'
                      ? 'Product, plus its set — e.g. secret lair orks, or hobbit collector booster'
                      : 'Card name, plus a set if you know it — e.g. arcane signet hobbit'
                }
                className="w-full rounded-md border border-white/10 bg-black/20 py-2 pl-9 pr-3 text-sm outline-none focus:border-violet-400/50"
              />
            </div>
            <button
              type="submit"
              disabled={searching}
              className="rounded-md bg-violet-500/80 px-3 py-2 text-sm font-medium hover:bg-violet-500 disabled:opacity-50"
            >
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Search'}
            </button>
            {mode === 'set' && (
              <button
                type="button"
                onClick={() => setPasteOpen((o) => !o)}
                title="For a product Scryfall has no set for yet — a spoiled Secret Lair or Countdown Kit"
                className={`shrink-0 rounded-md border px-3 py-2 text-xs ${
                  pasteOpen ? 'border-violet-400/50 bg-violet-500/15 text-violet-200' : 'border-white/10 text-white/50 hover:bg-white/5'
                }`}
              >
                Paste list
              </button>
            )}
          </form>
          {mode === 'set' && pasteOpen && (
            <div className="-mt-3 mb-5 rounded-md border border-white/10 bg-black/20 p-2.5">
              <p className="mb-2 text-[11px] text-white/45">
                Searching a Secret Lair by name (e.g. “marvel countdown”) finds announced drops on its own. For
                anything else, import the spoiler article or official announcement by URL, or paste the list one card
                per line — counts, “#63” numbers and “(SET) 123” suffixes are fine.
              </p>
              <div className="mb-2 flex gap-2">
                <input
                  value={pasteUrl}
                  onChange={(e) => setPasteUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void loadList(true) }}
                  placeholder="https://magic.wizards.com/en/news/announcements/… or any spoiler article"
                  className="flex-1 rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[12px] outline-none focus:border-violet-400/50"
                />
                <button
                  onClick={() => void loadList(true)}
                  disabled={searching || !pasteUrl.trim()}
                  className="shrink-0 rounded-md border border-violet-400/40 px-3 py-1 text-xs text-violet-200 hover:bg-violet-500/15 disabled:opacity-50"
                >
                  Import page
                </button>
              </div>
              <input
                value={pasteLabel}
                onChange={(e) => setPasteLabel(e.target.value)}
                placeholder="Product name (optional) — e.g. Marvel History of Heroes Countdown Kit"
                className="mb-2 w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[12px] outline-none focus:border-violet-400/50"
              />
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={8}
                placeholder={'Fierce Guardianship\nMjölnir, Storm Hammer\nSnuff Out\n…'}
                className="w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 font-mono text-[12px] outline-none focus:border-violet-400/50"
              />
              <div className="mt-2 flex justify-end">
                <button
                  onClick={() => void loadList()}
                  disabled={searching || !pasteText.trim()}
                  className="rounded-md bg-violet-500/80 px-3 py-1.5 text-xs font-medium hover:bg-violet-500 disabled:opacity-50"
                >
                  Look up list
                </button>
              </div>
            </div>
          )}

          {setValue && (
            <section className="mb-6">
              <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">
                  Chase cards — {setValue.sets.map((x) => x.name).join(' + ')}
                </h2>
                {setValue.source !== 'list' && (
                  <>
                    <span className="text-[11px] text-white/45">
                      complete the set <span className="tabular-nums text-white/70">{money(setValue.totalCheapest)}</span>
                    </span>
                    <span className="text-[11px] text-white/45">
                      all-premium <span className="tabular-nums text-white/70">{money(setValue.totalBest)}</span>
                    </span>
                    <span className="text-[11px] text-white/30">
                      {setValue.pricedCount}/{setValue.cardCount} priced
                    </span>
                  </>
                )}
                {insightsBusy ? (
                  <span className="flex items-center gap-1 text-[11px] text-white/35">
                    <Loader2 className="h-3 w-3 animate-spin" /> pricing reprints + cEDH rates…
                  </span>
                ) : (
                  reprintTotal && (
                    <>
                      <span className="text-[11px] text-white/45" title="Each reprinted card once, at its cheapest printing outside this product">
                        reprints elsewhere{' '}
                        <span className="tabular-nums text-sky-200">{money(reprintTotal.sum)}</span>
                        <span className="text-white/30"> ({reprintTotal.n} cards)</span>
                      </span>
                      <span className="text-[11px] text-white/45">
                        cEDH-played <span className="tabular-nums text-violet-200">{cedhCount}</span>
                      </span>
                    </>
                  )
                )}
                <div className="ml-auto flex overflow-hidden rounded-md border border-white/10">
                  {([['grid', LayoutGrid], ['list', List]] as const).map(([v, Icon]) => (
                    <button
                      key={v}
                      onClick={() => setSetView(v)}
                      title={v === 'grid' ? 'Card art' : 'Compact list'}
                      className={`p-1.5 ${setView === v ? 'bg-violet-500/25 text-violet-200' : 'text-white/40 hover:bg-white/5'}`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </button>
                  ))}
                </div>
              </div>

              {(setValue.source ?? 'set') === 'set' && (
              <>
              <div className="mb-3 rounded-md border border-white/10 bg-black/20 p-2.5">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
                    Sealed products
                  </span>
                  <button
                    onClick={() => void toggleFollowSealed()}
                    title="Price every sealed product in this set once a day"
                    className={`rounded border px-1.5 py-0.5 text-[11px] ${
                      followed.includes(setValue.sets[0].code)
                        ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
                        : 'border-white/10 text-white/50 hover:bg-white/10'
                    }`}
                  >
                    {followed.includes(setValue.sets[0].code) ? 'Tracking daily' : 'Track sealed'}
                  </button>
                  <button
                    onClick={() => void refreshSealedNow()}
                    disabled={sealedBusy}
                    className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-50"
                  >
                    {sealedBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                    Price now
                  </button>
                </div>

                {sealedPrices.length === 0 ? (
                  <p className="text-[11px] text-white/40">
                    No sealed products catalogued for this set yet — run a Sealed search for it once.
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {sealedPrices.map((p) => {
                      // Change over the window, but only when there are two
                      // distinct days to compare — otherwise it reads as 0%.
                      const change =
                        p.latest != null && p.earliest != null && p.earliest > 0 && p.latestOn !== p.earliestOn
                          ? (p.latest - p.earliest) / p.earliest
                          : null
                      return (
                        <div key={p.uuid} className="flex items-center gap-3 py-0.5 text-[11px]">
                          <ProductThumb
                            image={tcgplayerImage(p.tcgplayerProductId, 'small')}
                            alt={p.name}
                            size="xs"
                            onClick={() => setZoom(sealedZoom(p.tcgplayerProductId, p.name, p.category?.replace(/_/g, ' ')))}
                          />
                          <span className="min-w-0 flex-1 truncate text-white/70" title={p.name}>
                            {p.name.replace(new RegExp('^' + setValue.sets[0].name + ' ', 'i'), '')}
                          </span>
                          <span className="w-20 shrink-0 text-right tabular-nums">
                            {p.latest == null ? <span className="text-white/25">—</span> : money(p.latest)}
                          </span>
                          <span
                            className={`w-16 shrink-0 text-right tabular-nums ${
                              change == null ? 'text-white/25' : change >= 0 ? 'text-emerald-400' : 'text-red-400'
                            }`}
                          >
                            {change == null ? '' : `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`}
                          </span>
                          <span className="w-14 shrink-0 text-right text-[10px] text-white/25">
                            {p.points ? `${p.points}d` : ''}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="mb-3 rounded-md border border-white/10 bg-black/20 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-white/40">Pack EV</span>
                  {(['collector', 'play'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => void loadEv(t)}
                      disabled={evBusy}
                      className={`rounded border border-white/10 px-1.5 py-0.5 text-[11px] capitalize hover:bg-white/10 disabled:opacity-50 ${
                        ev?.boosterType === t ? 'bg-violet-500/20 text-violet-200' : 'text-white/50'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                  {evBusy && <Loader2 className="h-3 w-3 animate-spin text-white/40" />}
                </div>

                {ev && !ev.note && (
                  <>
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
                      {/* Median first: it's what a pack actually tends to return.
                          The mean is dragged upward by rare chase hits. */}
                      <span className="text-white/45">
                        median <span className="text-base font-semibold tabular-nums text-white">{money(ev.median)}</span>
                      </span>
                      <span className="text-white/45">
                        mean <span className="tabular-nums text-white/80">{money(ev.mean)}</span>
                      </span>
                      <span className="text-white/45">
                        p10–p90 <span className="tabular-nums text-white/70">{money(ev.p10)}–{money(ev.p90)}</span>
                      </span>
                      <span className="text-white/45">
                        ≥${ev.liquidThreshold} only <span className="tabular-nums text-white/70">{money(ev.medianLiquid)}</span>
                      </span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-white/30">
                      {ev.simulations.toLocaleString()} simulated {ev.booster.toLowerCase()}s. Prices are retail asks —
                      selling into a buylist realises roughly half.
                      {ev.unpricedChase > 0 &&
                        ` ${ev.unpricedChase} unpriced chase card(s) excluded, so the real ceiling is higher.`}
                    </p>
                  </>
                )}
                {ev?.note && <p className="mt-2 text-[11px] text-white/40">{ev.note}</p>}
              </div>
              </>
              )}

              {/* Browse controls — the whole set is in memory, this decides
                  which slice of it is on screen. */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-white/30" />
                  <input
                    value={setFilter}
                    onChange={(e) => setSetFilter(e.target.value)}
                    placeholder="Filter by name or #"
                    className="w-44 rounded-md border border-white/10 bg-black/20 py-1 pl-7 pr-2 text-[11px] outline-none focus:border-violet-400/50"
                  />
                </div>
                <div className="flex overflow-hidden rounded-md border border-white/10">
                  {rarityChips.map((r) => (
                    <button
                      key={r}
                      onClick={() => setSetRarity(r)}
                      className={`px-2 py-1 text-[11px] capitalize ${
                        setRarity === r ? 'bg-violet-500/25 text-violet-200' : 'text-white/40 hover:bg-white/5'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <div className="flex overflow-hidden rounded-md border border-white/10">
                  {([['all', 'All'], ['reprint', 'Reprints'], ['new', 'New']] as const).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setSetKind(k)}
                      className={`px-2 py-1 text-[11px] ${
                        setKind === k ? 'bg-violet-500/25 text-violet-200' : 'text-white/40 hover:bg-white/5'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setSetCedhOnly((v) => !v)}
                  disabled={!insights}
                  title={`Only cards in at least ${pct(CEDH_PLAYED)} of cEDH tournament decks`}
                  className={`rounded-md border px-2 py-1 text-[11px] disabled:opacity-40 ${
                    setCedhOnly ? 'border-amber-400/50 bg-amber-400/15 text-amber-200' : 'border-white/10 text-white/40 hover:bg-white/5'
                  }`}
                >
                  cEDH played
                </button>
                <select
                  value={setSort}
                  onChange={(e) => setSetSort(e.target.value as SetSort)}
                  className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] outline-none focus:border-violet-400/50"
                >
                  {SET_SORTS.map((o) => (
                    <option key={o.id} value={o.id} className="bg-neutral-900">
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  title="Printings per page"
                  className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] outline-none focus:border-violet-400/50"
                >
                  {[60, 120, 240, 0].map((n) => (
                    <option key={n} value={n} className="bg-neutral-900">
                      {n === 0 ? 'All on one page' : `${n} per page`}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-white/35">
                  {visibleCards.length === setValue.cardCount
                    ? `${setValue.cardCount} printings`
                    : `${visibleCards.length} of ${setValue.cardCount} printings`}
                  {visibleTotal > 0 && (
                    <>
                      {' · '}
                      <span className="tabular-nums text-white/55">{money(visibleTotal)}</span> at best finish
                    </>
                  )}
                </span>
                {reprintTotal && reprintTotal.n > 0 && (setFilter || setRarity !== 'all' || setKind !== 'all' || setCedhOnly) && (
                  <span className="text-[11px] text-white/35">
                    · reprints in view <span className="tabular-nums text-sky-200/80">{money(reprintTotal.sum)}</span> elsewhere
                  </span>
                )}
                {(setFilter || setRarity !== 'all' || setKind !== 'all' || setCedhOnly) && (
                  <button
                    onClick={() => { setSetFilter(''); setSetRarity('all'); setSetKind('all'); setSetCedhOnly(false) }}
                    className="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/40 hover:bg-white/10"
                  >
                    Clear
                  </button>
                )}
              </div>

              {visibleCards.length === 0 ? (
                <p className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-6 text-center text-[12px] text-white/40">
                  Nothing in this set matches those filters.
                </p>
              ) : setView === 'grid' ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
                  {pageCards.map((c, i) => (
                    <div key={c.id} className="group relative">
                      <button
                        onClick={() => setLightbox(c)}
                        className="block w-full overflow-hidden rounded-lg ring-1 ring-white/10 transition hover:ring-violet-400/60"
                        title="Click to enlarge"
                      >
                        {c.imageUrl ? (
                          <img src={c.imageUrl} alt={c.name} className="w-full" loading="lazy" />
                        ) : (
                          <div className="flex aspect-[5/7] items-center justify-center bg-white/5 p-2 text-center text-xs text-white/40">
                            {c.name}
                          </div>
                        )}
                      </button>
                      {/* Rank + price ride on the art so the grid stays scannable. */}
                      <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[10px] tabular-nums text-white/70">
                        #{pageStart + i + 1}
                      </span>
                      <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium tabular-nums">
                        {c.bestPrice == null ? <span className="text-white/50">no quote</span> : money(c.bestPrice)}
                        {c.bestFinish === 'foil' && <span className="ml-1 text-amber-300">✦</span>}
                      </span>
                      {c.notable && (
                        <span
                          className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-amber-400/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black"
                          title="Headliner / serialized — too rare to have a market price"
                        >
                          {c.promoTypes.includes('serialized') ? 'serialized' : 'headliner'}
                        </span>
                      )}
                      <div className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 transition group-hover:opacity-100">
                        <button
                          onClick={() =>
                            void window.atlis.mtg
                              .createWatch({
                                kind: 'card',
                                name: c.name,
                                set_code: c.setCode,
                                collector_number: c.collectorNumber,
                                image_url: c.imageUrl,
                                ext_source: 'scryfall',
                                ext_id: c.id,
                                variant: c.bestFinish ?? 'nonfoil'
                              })
                              .then(load)
                          }
                          title={`Track the ${c.bestFinish ?? 'nonfoil'} printing`}
                          className="rounded bg-black/75 p-1 hover:bg-violet-500/80"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() =>
                            void ownIt(
                              {
                                kind: 'card',
                                name: c.name,
                                set_code: c.setCode,
                                collector_number: c.collectorNumber,
                                image_url: c.imageUrl,
                                ext_source: 'scryfall',
                                ext_id: c.id,
                                variant: c.bestFinish ?? 'nonfoil'
                              },
                              `${c.name} (${c.bestFinish ?? 'nonfoil'})`
                            )
                          }
                          title={`I own the ${c.bestFinish ?? 'nonfoil'} printing`}
                          className="rounded bg-black/75 p-1 hover:bg-emerald-500/80"
                        >
                          <PackageCheck className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="mt-1 truncate text-[11px] text-white/50" title={c.name}>
                        {setValue.source === 'list' ? c.name : `${c.setCode.toUpperCase()} #${c.collectorNumber} · ${c.bestFinish ?? '—'}`}
                      </div>
                      <InsightBadges card={c} ins={insights?.cards[c.name]} busy={insightsBusy} />
                    </div>
                  ))}
                </div>
              ) : (
              <div className="space-y-1">
                {pageCards.map((c, i) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5"
                  >
                    <span className="w-7 shrink-0 text-right text-[11px] tabular-nums text-white/25">{pageStart + i + 1}</span>
                    {c.imageUrl && (
                      <img src={c.imageUrl} alt="" className="h-9 w-6 shrink-0 rounded-sm object-cover" loading="lazy" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm">{c.name}</span>
                        {c.notable && (
                          <span
                            className="shrink-0 rounded bg-amber-400/90 px-1 text-[9px] font-semibold uppercase text-black"
                            title="Headliner / serialized — too rare to have a market price"
                          >
                            {c.promoTypes.includes('serialized') ? 'serialized' : 'headliner'}
                          </span>
                        )}
                      </div>
                      <InsightBadges card={c} ins={insights?.cards[c.name]} busy={insightsBusy} />
                      <div className="truncate text-[11px] text-white/45">
                        {c.setCode.toUpperCase()} #{c.collectorNumber} · {c.rarity}
                        {/* Spell out every finish: the gap between them is the
                            whole reason one printing is a chase card. */}
                        {Object.entries(c.prices).map(([f, p]) => (
                          <span key={f}> · {f} {p == null ? '—' : money(p)}</span>
                        ))}
                      </div>
                    </div>
                    <div className="w-24 shrink-0 text-right">
                      <div className="text-sm tabular-nums">
                        {c.bestPrice == null ? <span className="text-[11px] text-white/40">no quote</span> : money(c.bestPrice)}
                      </div>
                      {c.bestFinish && <div className="text-[10px] text-white/35">{c.bestFinish}</div>}
                    </div>
                    <button
                      onClick={() =>
                        void window.atlis.mtg
                          .createWatch({
                            kind: 'card',
                            name: c.name,
                            set_code: c.setCode,
                            collector_number: c.collectorNumber,
                            image_url: c.imageUrl,
                            ext_source: 'scryfall',
                            ext_id: c.id,
                            variant: c.bestFinish ?? 'nonfoil'
                          })
                          .then(load)
                      }
                      title={`Track the ${c.bestFinish ?? 'nonfoil'} printing`}
                      className="shrink-0 rounded border border-white/10 p-1 hover:bg-white/10"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() =>
                        void ownIt(
                          {
                            kind: 'card',
                            name: c.name,
                            set_code: c.setCode,
                            collector_number: c.collectorNumber,
                            image_url: c.imageUrl,
                            ext_source: 'scryfall',
                            ext_id: c.id,
                            variant: c.bestFinish ?? 'nonfoil'
                          },
                          `${c.name} (${c.bestFinish ?? 'nonfoil'})`
                        )
                      }
                      title={`I own the ${c.bestFinish ?? 'nonfoil'} printing`}
                      className="shrink-0 rounded border border-emerald-400/25 p-1 text-emerald-200/80 hover:bg-emerald-500/15"
                    >
                      <PackageCheck className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
              )}
              {pageCount > 1 && (
                <div className="mt-3 flex items-center justify-center gap-2">
                  <button
                    onClick={() => setSetPage(page - 1)}
                    disabled={page === 0}
                    className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-30"
                  >
                    Previous
                  </button>
                  {/* A window of page buttons, so a 479-card set doesn't render
                      a row of 8 numbers you have to count through. */}
                  {Array.from({ length: pageCount }, (_, n) => n)
                    .filter((n) => n === 0 || n === pageCount - 1 || Math.abs(n - page) <= 1)
                    .map((n, idx, arr) => (
                      <span key={n} className="flex items-center gap-2">
                        {idx > 0 && n - arr[idx - 1] > 1 && <span className="text-[11px] text-white/20">…</span>}
                        <button
                          onClick={() => setSetPage(n)}
                          className={`min-w-[26px] rounded-md px-1.5 py-1 text-[11px] tabular-nums ${
                            n === page ? 'bg-violet-500/80 font-medium' : 'text-white/50 hover:bg-white/10'
                          }`}
                        >
                          {n + 1}
                        </button>
                      </span>
                    ))}
                  <button
                    onClick={() => setSetPage(page + 1)}
                    disabled={page >= pageCount - 1}
                    className="rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-30"
                  >
                    Next
                  </button>
                  <span className="ml-1 text-[11px] text-white/30 tabular-nums">
                    {pageStart + 1}–{pageStart + pageCards.length} of {visibleCards.length}
                  </span>
                </div>
              )}
            </section>
          )}

          {sealedResults.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">
                Sealed products ({sealedResults.length})
              </h2>
              <div className="space-y-1.5">
                {sealedResults.map((p) => (
                  <div key={p.uuid}>
                  <div
                    className={`flex items-center gap-3 rounded-md border bg-white/[0.03] px-3 py-2 ${
                      contents?.uuid === p.uuid ? 'border-violet-400/50' : 'border-white/10'
                    }`}
                  >
                    <ProductThumb
                      image={p.tcgplayer_product_id ? tcgplayerImage(p.tcgplayer_product_id, 'small') : null}
                      alt={p.name}
                      size="md"
                      onClick={
                        p.tcgplayer_product_id
                          ? () => setZoom(sealedZoom(p.tcgplayer_product_id, p.name, `${p.set_code.toUpperCase()} · ${p.category?.replace(/_/g, ' ') ?? 'sealed'}`))
                          : undefined
                      }
                      title={p.tcgplayer_product_id ? 'Click to enlarge' : 'No TCGplayer listing, so no product photo'}
                    />
                    <button
                      onClick={() => void openContents(p)}
                      className="min-w-0 flex-1 text-left"
                      title="See what's inside and what it's worth"
                    >
                      <div className="truncate text-sm hover:text-violet-200" title={p.name}>{p.name}</div>
                      <div className="truncate text-[11px] text-white/45">
                        {p.set_code.toUpperCase()} · {p.category?.replace(/_/g, ' ')}
                        {p.subtype ? ` · ${p.subtype.replace(/_/g, ' ')}` : ''}
                        {p.release_date ? ` · ${p.release_date}` : ''}
                      </div>
                    </button>
                    <button
                      onClick={() => void openContents(p)}
                      disabled={contentsBusy === p.uuid}
                      className="flex shrink-0 items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-50"
                    >
                      {contentsBusy === p.uuid ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Layers className="h-3 w-3" />
                      )}
                      {contents?.uuid === p.uuid ? 'Hide' : "What's inside"}
                    </button>
                    <button
                      onClick={() => void addSealedToWatch(p)}
                      disabled={!p.tcgplayer_product_id}
                      title={p.tcgplayer_product_id ? 'Track this product' : 'No TCGplayer id — cannot auto-price'}
                      className="flex shrink-0 items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-40"
                    >
                      <Plus className="h-3 w-3" />
                      Track
                    </button>
                    <button
                      onClick={() =>
                        void ownIt({
                          kind: 'sealed',
                          name: p.name,
                          set_code: p.set_code,
                          ext_source: 'tcgplayer',
                          ext_id: p.tcgplayer_product_id,
                          variant: 'sealed'
                        })
                      }
                      disabled={!p.tcgplayer_product_id}
                      title={p.tcgplayer_product_id ? 'I own this — add it to the Vault' : 'No TCGplayer id — cannot auto-price'}
                      className="flex shrink-0 items-center gap-1 rounded border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
                    >
                      <PackageCheck className="h-3 w-3" />
                      I own this
                    </button>
                  </div>
                  {contents?.uuid === p.uuid && <SealedContentsPanel data={contents} onCard={setLightbox} />}
                  </div>
                ))}
              </div>
            </section>
          )}

          {results.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">
                Results ({results.length})
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                {results.slice(0, 60).map((card) => (
                  <div key={card.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
                    {imageOf(card) && (
                      <button
                        onClick={() => setLightbox(asCardValue(card))}
                        title="Click to enlarge"
                        className="mb-2 block w-full overflow-hidden rounded ring-1 ring-transparent transition hover:ring-violet-400/60"
                      >
                        <img src={imageOf(card)!} alt={card.name} className="w-full" loading="lazy" />
                      </button>
                    )}
                    <div className="truncate text-xs font-medium" title={card.name}>{card.name}</div>
                    <div className="truncate text-[11px] text-white/50" title={card.set_name}>
                      {card.set.toUpperCase()} #{card.collector_number} · {card.rarity}
                    </div>
                    {/* Track picks the finish; owning needs one too, so the same
                        finish buttons drive both rows. */}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {finishesOf(card).map((v) => (
                        <button
                          key={v}
                          onClick={() => void addToWatch(card, v)}
                          title={`Track ${v}`}
                          className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] hover:bg-white/10"
                        >
                          <Plus className="h-3 w-3" />
                          {v === 'nonfoil' ? 'reg' : v} {money(priceOf(card, v))}
                        </button>
                      ))}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {finishesOf(card).map((v) => (
                        <button
                          key={v}
                          onClick={() =>
                            void ownIt(
                              {
                                kind: 'card',
                                name: card.name,
                                set_code: card.set,
                                collector_number: card.collector_number,
                                image_url: imageOf(card),
                                ext_source: 'scryfall',
                                ext_id: card.id,
                                variant: v
                              },
                              `${card.name} (${v})`
                            )
                          }
                          title={`I own the ${v} printing`}
                          className="flex items-center gap-1 rounded border border-emerald-400/25 px-1.5 py-0.5 text-[11px] text-emerald-200/80 hover:bg-emerald-500/15"
                        >
                          <PackageCheck className="h-3 w-3" />
                          own {v === 'nonfoil' ? 'reg' : v}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          </>
          )}

          {isList && tab === 'watchlist' && activeGame && <TcgWatchlist game={activeGame} onChanged={loadTcgCounts} />}
          {isList && !(tab === 'watchlist' && activeGame) && (
          <section>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">
                {tab === 'watchlist' ? 'Watchlist — things I want' : 'Owned — what my collection is worth'}
              </h2>
              <button
                onClick={() => void backfill()}
                disabled={backfilling}
                title="Pull up to 90 days of past prices from MTGJSON. One-off and slow — streams ~900MB."
                className="ml-auto flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-50"
              >
                {backfilling && <Loader2 className="h-3 w-3 animate-spin" />}
                Backfill 90 days
              </button>
              {tab === 'owned' && owned.length > 0 && (
                <button
                  onClick={() => void rebuildHistory()}
                  title="Replay collected prices into the Vault charts"
                  className="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10"
                >
                  Rebuild history
                </button>
              )}
              {tab === 'owned' && (
                <div className="flex overflow-hidden rounded-md border border-white/10">
                  {([['grid', LayoutGrid, 'Gallery'], ['list', List, 'List']] as const).map(([v, Icon, label]) => (
                    <button
                      key={v}
                      onClick={() => setOwnedLayout(v)}
                      title={label}
                      className={`p-1.5 ${ownedLayout === v ? 'bg-violet-500/25 text-violet-200' : 'text-white/40 hover:bg-white/5'}`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Filter bar. Only on Owned, and only once there is enough here to
                be worth sifting — on a five-card collection it is just clutter. */}
            {tab === 'owned' && owned.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative min-w-[200px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
                  <input
                    value={ownedQuery}
                    onChange={(e) => setOwnedQuery(e.target.value)}
                    placeholder="Search name, set or type…"
                    className="w-full rounded-md border border-white/10 bg-white/[0.03] py-1.5 pl-8 pr-8 text-sm placeholder:text-white/25 focus:border-violet-400/50 focus:outline-none"
                  />
                  {ownedQuery && (
                    <button
                      onClick={() => setOwnedQuery('')}
                      title="Clear"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1">
                  {(['W', 'U', 'B', 'R', 'G', 'C'] as const).map((c) => {
                    const on = ownedColors.includes(c)
                    return (
                      <button
                        key={c}
                        title={PIPS[c].label}
                        onClick={() =>
                          setOwnedColors((prev) => (on ? prev.filter((x) => x !== c) : [...prev, c]))
                        }
                        className={`h-7 w-7 rounded-full border text-xs font-semibold transition-colors ${
                          on ? PIPS[c].on : `border-white/10 bg-white/[0.03] ${PIPS[c].cls} hover:bg-white/10`
                        }`}
                      >
                        {c}
                      </button>
                    )
                  })}
                </div>

                {/* Mode only matters once a colour is picked. */}
                {ownedColors.length > 0 && (
                  <div className="flex overflow-hidden rounded-md border border-white/10 text-[11px]">
                    {([
                      ['within', 'Fits', 'Legal in a deck of exactly these colours (add C to include colourless)'],
                      ['any', 'Any', 'Uses at least one of these colours'],
                      ['exact', 'Exact', 'Colour identity is precisely this combination']
                    ] as const).map(([m, label, title]) => (
                      <button
                        key={m}
                        onClick={() => setColorMode(m)}
                        title={title}
                        className={`px-2 py-1 ${
                          colorMode === m ? 'bg-violet-500/25 text-violet-200' : 'text-white/40 hover:bg-white/5'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}

                <select
                  value={ownedCedh}
                  onChange={(e) => setOwnedCedh(Number(e.target.value))}
                  title="How often the card shows up in cEDH tournament decks over the last year (EDHTop16)"
                  className={`rounded-md border px-1.5 py-1 text-[11px] focus:outline-none ${
                    ownedCedh > 0
                      ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
                      : 'border-white/10 bg-white/[0.03] text-white/70'
                  }`}
                >
                  <option value={0}>Any cEDH play</option>
                  <option value={0.25}>cEDH staples (25%+ of decks)</option>
                  <option value={0.05}>Played in cEDH (5%+)</option>
                  <option value={0.01}>Seen in cEDH (1%+)</option>
                </select>

                <div
                  className="flex overflow-hidden rounded-md border border-white/10 text-[11px]"
                  title="Whether a saved deck (Decks tab) runs the card — matched by name, any printing"
                >
                  {([['all', 'All cards'], ['in_deck', 'In a deck'], ['loose', 'Loose']] as const).map(([m, label]) => (
                    <button
                      key={m}
                      onClick={() => setOwnedDeck(m)}
                      className={`px-2 py-1 ${
                        ownedDeck === m ? 'bg-violet-500/25 text-violet-200' : 'text-white/40 hover:bg-white/5'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {(ownedQuery || ownedColors.length > 0 || ownedCedh > 0 || ownedDeck !== 'all') && (
                  <button
                    onClick={() => { setOwnedQuery(''); setOwnedColors([]); setOwnedCedh(0); setOwnedDeck('all') }}
                    className="rounded border border-white/10 px-1.5 py-1 text-[11px] text-white/45 hover:bg-white/10"
                  >
                    Reset
                  </button>
                )}

                <PeriodPicker value={ownedPeriod} onChange={setOwnedPeriod} />
                <select
                  value={ownedSort}
                  onChange={(e) => setOwnedSort(e.target.value as OwnedSort)}
                  title="Order the collection"
                  className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-1 text-[11px] text-white/70 focus:outline-none"
                >
                  <option value="value">Most valuable (per card)</option>
                  <option value="holding">Largest holdings (price × qty)</option>
                  <option value="gainers">Biggest gainers</option>
                  <option value="losers">Biggest losers</option>
                  <option value="cedh">Most played in cEDH</option>
                </select>

                <span className="ml-auto text-[11px] tabular-nums text-white/40">
                  {filteredOwned.length === owned.length
                    ? `${owned.length} items`
                    : `${filteredOwned.length} of ${owned.length}`}
                  {unsyncedOwned > 0 && (
                    <button
                      onClick={() => void syncCardMeta()}
                      title="These cards have no colour identity cached yet — pull it from Scryfall"
                      className="ml-2 text-amber-300/70 underline decoration-dotted hover:text-amber-200"
                    >
                      {syncingMeta ? 'syncing…' : `${unsyncedOwned} unsynced`}
                    </button>
                  )}
                  <button
                    onClick={() => void syncCedh(true)}
                    disabled={syncingCedh}
                    title="Re-ask EDHTop16 for every owned card's cEDH tournament play rate"
                    className="ml-2 text-white/35 underline decoration-dotted hover:text-white/70 disabled:no-underline"
                  >
                    {syncingCedh ? 'cEDH syncing…' : unsyncedCedh > 0 ? `cEDH: ${unsyncedCedh} unsynced` : 'refresh cEDH'}
                  </button>
                </span>
              </div>
            )}

            {tab === 'owned' && filteredOwned.length > 0 && (
              <MoversStrip
                movers={ownedMovers}
                period={ownedPeriod}
                onPick={(o) => setSelected(ownedTracked(o as MtgOwnedItem))}
              />
            )}

            {/* Store watcher sits above the rows: a product being buyable under
                market right now is time-sensitive in a way the list is not. */}
            {tab === 'watchlist' && watch.length > 0 && (
              <WatchModeBar
                mode={watchMode}
                onMode={setWatchMode}
                counts={watchCounts}
                period={marketPeriod}
                onPeriod={setMarketPeriod}
              />
            )}
            {tab === 'watchlist' && watchMode === 'hunt' && <DealsPanel onChanged={load} />}
            {tab === 'watchlist' && watchMode === 'market' && shownWatch.length > 0 && (
              <MoversStrip
                movers={marketMovers}
                period={marketPeriod}
                noun="watched items"
                onPick={(w) => setSelected(watchSelection(w as MtgWatchRow))}
              />
            )}

            {tab === 'watchlist' ? (
              watch.length === 0 ? (
                <p className="text-sm text-white/40">
                  Nothing tracked yet. Find something on the Search tab and hit Track to start a price history.
                </p>
              ) : shownWatch.length === 0 ? (
                <p className="text-sm text-white/40">
                  {watchMode === 'hunt'
                    ? 'Nothing to hunt: no watched sealed product is unreleased or inside the print window.'
                    : 'Nothing on the market list yet. Cards and out-of-print sealed land here automatically.'}
                </p>
              ) : (
                /* Rows go two- or three-across once there's room for each to be
                   a comfortable width; items-start so opening one row's
                   where-to-buy panel doesn't stretch its neighbour. */
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,600px),1fr))] items-start gap-1.5">
                  {shownWatch.map((w) => {
                    const key = `w:${w.id}`
                    return (
                      <WatchRow
                        key={w.id}
                        watch={w}
                        period={marketPeriod}
                        active={selected?.key === key}
                        onSelect={() => setSelected(selected?.key === key ? null : watchSelection(w))}
                        onChanged={load}
                      />
                    )
                  })}
                </div>
              )
            ) : owned.length === 0 ? (
              <p className="text-sm text-white/40">
                Nothing owned yet. Hit “I own this” on a search result, or the box icon on a watchlist row once
                you've bought it.
              </p>
            ) : filteredOwned.length === 0 ? (
              <p className="text-sm text-white/40">
                No owned card matches that filter.
                {ownedCedh > 0 && unsyncedCedh > 0 && ` ${unsyncedCedh} card(s) haven't been checked against cEDH results yet.`}
                {unsyncedOwned > 0 && ` ${unsyncedOwned} card${unsyncedOwned === 1 ? ' has' : 's have'} no colour identity cached yet — sync above to include ${unsyncedOwned === 1 ? 'it' : 'them'}.`}
              </p>
            ) : ownedLayout === 'grid' ? (
              /* Gallery — the collection as pictures, reflowing to the width. */
              <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                {sortedOwned.map((o) => {
                  const key = `o:${o.id}`
                  const active = selected?.key === key
                  const total = o.last_price == null ? null : o.last_price * o.quantity
                  const gain =
                    total != null && o.purchase_price != null && o.purchase_price > 0
                      ? ((total - o.purchase_price) / o.purchase_price) * 100
                      : null
                  return (
                    <button
                      key={o.id}
                      onClick={() => setSelected(active ? null : ownedTracked(o))}
                      className={`flex flex-col overflow-hidden rounded-lg border text-left transition-colors ${
                        active
                          ? 'border-emerald-400/60 bg-emerald-500/10'
                          : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]'
                      }`}
                    >
                      {/* Absolute inset = a definite box for the picture to fit. */}
                      <div className="relative aspect-square bg-black/25">
                        <div className="absolute inset-3 flex items-center justify-center">
                          <ProductThumb
                            image={imageFor({ extSource: o.ext_source, extId: o.ext_id }, 'normal')}
                            alt={o.name}
                            size="fill"
                            icon={o.category === 'mtg_sealed' || o.category === 'tcg_sealed' ? Box : Sparkles}
                            className="rounded shadow-lg shadow-black/40"
                          />
                        </div>
                      </div>
                      <div className="flex flex-1 flex-col gap-0.5 border-t border-white/10 px-3 py-2">
                        <div className="line-clamp-2 text-sm leading-snug" title={o.name}>
                          {o.name}
                          {o.quantity > 1 && (
                            <span className="ml-1.5 text-[11px] text-white/40" title={stackHint(o)}>×{o.quantity}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 truncate text-[11px] text-white/45">
                          <IdentityPips identity={o.color_identity} />
                          <span className="truncate">
                            {o.maker ?? o.category}
                            {o.variant ? ` · ${o.variant}` : ''}
                          </span>
                          <span className="ml-auto" />
                          <DeckBadge decks={o.decks} />
                          <CedhBadge rate={o.cedh_play_rate} />
                        </div>
                        {/* Today's move sits with the current price; gain vs
                            what you paid sits with what you paid. Two different
                            questions, so they do not share a line. */}
                        <div className="mt-auto flex items-baseline justify-between gap-2 pt-1.5">
                          <span className="text-base font-semibold tabular-nums">
                            {money(total)}
                            {/* A stack's total hides what one copy is worth, which is what the value sort ranks. */}
                            {o.quantity > 1 && o.last_price != null && (
                              <span className="ml-1 text-[10px] font-normal text-white/40">{money(o.last_price)} ea</span>
                            )}
                          </span>
                          <PeriodDelta r={o} period={ownedPeriod} />
                        </div>
                        <div className="flex justify-between gap-2 text-[10px] text-white/35">
                          <span>
                            {o.purchase_price != null ? `paid ${money(o.purchase_price)}` : 'paid —'}
                            {gain != null && (
                              <span className={gain >= 0 ? 'text-emerald-400/80' : 'text-red-400/80'}>
                                {' '}({gain >= 0 ? '+' : ''}
                                {gain.toFixed(1)}%)
                              </span>
                            )}
                          </span>
                          <span>{o.points}d</span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="space-y-1.5">
                {sortedOwned.map((o) => {
                  const key = `o:${o.id}`
                  const active = selected?.key === key
                  return (
                    <button
                      key={o.id}
                      onClick={() => setSelected(active ? null : ownedTracked(o))}
                      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left ${
                        active ? 'border-emerald-400/50 bg-emerald-500/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'
                      }`}
                    >
                      {/* Not clickable on its own — the row is already a button,
                          and selecting it shows the full picture in the side panel. */}
                      <ProductThumb
                        image={imageFor({ extSource: o.ext_source, extId: o.ext_id }, 'small')}
                        alt={o.name}
                        size="sm"
                        icon={o.category === 'mtg_sealed' || o.category === 'tcg_sealed' ? Box : Sparkles}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <PackageCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400/70" />
                          <span className="truncate text-sm">{o.name}</span>
                          <DeckBadge decks={o.decks} />
                          <CedhBadge rate={o.cedh_play_rate} />
                        </div>
                        <div className="flex items-center gap-1.5 truncate text-[11px] text-white/45">
                          <IdentityPips identity={o.color_identity} />
                          <span className="truncate">
                            {o.type_line ?? o.maker ?? o.category}
                            {o.variant ? ` · ${o.variant}` : ''}
                            {o.quantity > 1 && <span title={stackHint(o)}> · ×{o.quantity}</span>}
                            {` · ${o.points} day${o.points === 1 ? '' : 's'} of history`}
                          </span>
                        </div>
                      </div>
                      {o.purchase_price != null && (
                        <div className="w-20 shrink-0 text-right text-[11px] text-white/40">
                          paid {money(o.purchase_price)}
                        </div>
                      )}
                      <div className="w-16 shrink-0 text-right">
                        <PeriodDelta r={o} period={ownedPeriod} />
                      </div>
                      <div className="w-24 shrink-0 text-right">
                        <div className="text-sm tabular-nums">
                          {money(o.last_price == null ? null : o.last_price * o.quantity)}
                        </div>
                        {o.quantity > 1 && o.last_price != null && (
                          <div className="text-[10px] tabular-nums text-white/35">{money(o.last_price)} ea</div>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </section>
          )}
        </div>
        )}

        {showChart && (
        <aside className="overflow-y-auto border-l border-white/10 p-4">
          {selected ? (
            <>
              {(() => {
                const big = imageFor(selected, 'normal')
                if (!big) return null
                return (
                  <div className={`mx-auto mb-3 ${big.shape === 'card' ? 'w-[min(100%,300px)]' : 'w-[min(100%,340px)]'}`}>
                    <ProductThumb
                      image={big}
                      alt={selected.name}
                      size="lg"
                      className="rounded-lg"
                      icon={selected.variant === 'sealed' ? Box : Sparkles}
                      onClick={() => {
                        // Prefer the derived large scan over the stored (normal-size) URL.
                        const large =
                          imageFor({ extSource: selected.extSource, extId: selected.extId }, 'large') ??
                          imageFor(selected, 'large')
                        if (large) setZoom({ image: large, name: selected.name, subtitle: selected.subtitle })
                      }}
                    />
                  </div>
                )
              })()}
              <h2 className="mb-1 text-sm font-semibold">{selected.name}</h2>
              <p className="mb-3 text-xs text-white/50">
                {selected.subtitle}{selected.owned ? ' · owned' : ''}
              </p>
              {selected.owned && selected.variant === 'sealed' && selected.rippable && (
                <button
                  onClick={() => void ripIt(selected)}
                  disabled={ripping}
                  className="mb-3 flex items-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
                  title="Opened it — add its cards to Owned and remove one sealed copy"
                >
                  {ripping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageOpen className="h-3.5 w-3.5" />}
                  Ripped
                </button>
              )}
              {selected.magicSealed && (
                <button
                  onClick={() => void showInside(selected)}
                  disabled={insideBusy}
                  className="mb-3 flex items-center gap-1.5 rounded-md border border-violet-400/40 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-200 hover:bg-violet-500/20 disabled:opacity-50"
                  title="The decklist or fixed cards inside, priced — or the set, for random boosters"
                >
                  {insideBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Box className="h-3.5 w-3.5" />}
                  {inside?.key === selected.key ? 'Hide contents' : "What's inside"}
                </button>
              )}
              {inside?.key === selected.key && (
                <div className="mb-4">
                  {inside.contents?.cards.length ? (
                    <SealedContentsPanel data={inside.contents} onCard={setLightbox} />
                  ) : (
                    <p className="rounded-md border border-white/10 bg-white/[0.03] p-2.5 text-[12px] text-white/55">
                      {inside.note ?? 'No fixed contents listed for this product.'}
                    </p>
                  )}
                  {/* Boosters, a bundle, a box: no fixed list, so offer the set itself.
                      Not for Secret Lair — "the set" is every drop ever made. */}
                  {inside.setCode && !inside.contents?.cards.length && inside.setCode !== 'sld' && (
                    <button
                      onClick={() => void showSet(inside.setCode!)}
                      className="mt-2 flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5"
                    >
                      <Search className="h-3.5 w-3.5" />
                      Show the {inside.setCode.toUpperCase()} set
                    </button>
                  )}
                </div>
              )}
              {chartData.length > 1 ? (
                <div className="h-[clamp(10rem,30vh,20rem)]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.4)' }} />
                      <YAxis tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.4)' }} width={44} />
                      <Tooltip
                        contentStyle={{ background: '#18181b', border: '1px solid rgba(255,255,255,0.1)', fontSize: 12 }}
                        formatter={(v) => money(Number(v))}
                      />
                      <Line type="monotone" dataKey="price" stroke="#a78bfa" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-xs text-white/40">
                  {chartData.length === 1
                    ? 'One data point so far — history builds one snapshot per day.'
                    : 'No price history yet. Hit Refresh prices to take the first snapshot.'}
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-white/40">
              Pick a row to see its price history. Snapshots are taken once a day.
            </p>
          )}
        </aside>
        )}
      </div>

      {zoom && <ImageZoom image={zoom.image} name={zoom.name} subtitle={zoom.subtitle} onClose={() => setZoom(null)} />}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightbox(null)}
          role="presentation"
        >
          <div
            className="flex max-h-full max-w-full items-start gap-5"
            onClick={(e) => e.stopPropagation()}
            role="presentation"
          >
            {lightbox.imageLarge || lightbox.imageUrl ? (
              /* Cap the width too, not just the height: on a narrow window a
                 full-size card pushed the details panel off the screen edge. */
              <img
                src={lightbox.imageLarge ?? lightbox.imageUrl ?? ''}
                alt={lightbox.name}
                className="max-h-[85vh] max-w-[52vw] rounded-xl object-contain shadow-2xl ring-1 ring-white/15"
              />
            ) : null}
            <div className="w-64 shrink-0 pt-2">
              <h3 className="text-base font-semibold">{lightbox.name}</h3>
              <p className="mt-0.5 text-xs text-white/50">
                {lightbox.setCode.toUpperCase()} #{lightbox.collectorNumber} · {lightbox.rarity}
              </p>
              <div className="mt-3 space-y-1">
                {Object.entries(lightbox.prices).map(([f, p]) => (
                  <div key={f} className="flex justify-between text-sm">
                    <span className={f === lightbox.bestFinish ? 'text-violet-300' : 'text-white/50'}>{f}</span>
                    <span className="tabular-nums">{money(p)}</span>
                  </div>
                ))}
              </div>
              {/* The artwork alone, since the framed card hides most of it. */}
              {lightbox.artCrop && (
                <img
                  src={lightbox.artCrop}
                  alt={`${lightbox.name} artwork`}
                  className="mt-4 w-full rounded-md ring-1 ring-white/10"
                  loading="lazy"
                />
              )}
              <button
                onClick={() => {
                  void window.atlis.mtg
                    .createWatch({
                      kind: 'card',
                      name: lightbox.name,
                      set_code: lightbox.setCode,
                      collector_number: lightbox.collectorNumber,
                      image_url: lightbox.imageUrl,
                      ext_source: 'scryfall',
                      ext_id: lightbox.id,
                      variant: lightbox.bestFinish ?? 'nonfoil'
                    })
                    .then(load)
                  setLightbox(null)
                }}
                className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-md bg-violet-500/80 py-2 text-sm font-medium hover:bg-violet-500"
              >
                <Plus className="h-4 w-4" /> Track {lightbox.bestFinish ?? 'nonfoil'}
              </button>
            </div>
          </div>
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-5 top-5 rounded-md p-2 text-white/60 hover:bg-white/10 hover:text-white"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  )
}

const STATUS_META: Record<string, { label: string; tone: string }> = {
  in_stock: { label: 'in stock', tone: 'text-emerald-400' },
  in_store_only: { label: 'in store', tone: 'text-emerald-300' },
  preorder: { label: 'preorder', tone: 'text-amber-400' },
  listed: { label: 'listed', tone: 'text-sky-300/70' },
  sold_out_restocking: { label: 'restocking', tone: 'text-orange-300' },
  out_of_stock: { label: 'out of stock', tone: 'text-white/35' },
  unknown: { label: '—', tone: 'text-white/30' }
}
/** How much the URL can be trusted, spelled out rather than implied. */
const KIND_META: Record<string, { label: string; title: string }> = {
  product: { label: 'exact', title: 'Built from a product id we hold — cannot be the wrong item' },
  searched: { label: 'matched', title: 'Found by searching the retailer by name — check it is the right product' },
  search: { label: 'search', title: 'No product page resolved; this opens the retailer search results' },
  manual: { label: 'yours', title: 'A link you pasted' }
}

/** Buy links for one watchlist entry, with an explicit manual-link fallback. */
/**
 * A sealed product opened up: every card it definitely contains, priced at the
 * finish it actually contains, against what the product itself costs.
 *
 * The caveats are on screen rather than in a comment, because the headline
 * number is the kind people repeat ("commander decks are good investments")
 * and every one of them pushes the true figure down.
 */
function SealedContentsPanel({
  data,
  onCard
}: {
  data: MtgSealedContents
  onCard: (c: MtgSetCardValue) => void
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? data.cards : data.cards.slice(0, 24)
  const up = (data.netGain ?? 0) >= 0

  return (
    <div className="mt-1 rounded-md border border-violet-400/20 bg-violet-500/[0.05] p-3">
      {data.cards.length === 0 ? (
        <p className="text-[12px] text-white/50">{data.note}</p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-[11px] text-white/45">
              {data.complete ? 'cards inside' : 'cards identified'}{' '}
              <span className="tabular-nums text-white/75">{money(data.singlesTotal)}</span>
            </span>
            <span className="text-[11px] text-white/45">
              sealed price <span className="tabular-nums text-white/75">{money(data.sealedPrice)}</span>
            </span>
            {data.netGain != null ? (
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${
                  up ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
                }`}
              >
                {/* money() would render a negative as "$-90.11"; the sign belongs first. */}
                {up ? '+' : '−'}{money(Math.abs(data.netGain))} ({data.netGainPct}%){' '}
                {up ? 'cracking it wins' : 'sealed wins'}
              </span>
            ) : (
              !data.complete && (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-200">
                  partial list — no verdict
                </span>
              )
            )}
            <span className="text-[11px] text-white/30">
              {data.cardCount}
              {data.expectedCardCount != null && data.expectedCardCount !== data.cardCount
                ? ` of ${data.expectedCardCount}`
                : ''}{' '}
              cards · {data.cards.length} distinct · {data.pricedCount} priced
            </span>
          </div>

          {/* Say why the comparison is missing, rather than quietly omitting it. */}
          {!data.complete && data.note && (
            <p className="mb-2.5 rounded border border-amber-400/25 bg-amber-500/[0.07] px-2 py-1.5 text-[11px] leading-relaxed text-amber-200/90">
              {data.note} Compare against the sealed price yourself only once the full list is known — the cards
              below are the ones ATLIS could identify, not the whole product.
            </p>
          )}

          <p className="mb-2.5 text-[11px] leading-relaxed text-white/35">
            Card prices are retail asks — a buylist realises roughly half — and bulk commons count at face value, so
            the real spread is worse than it looks.
            {data.randomComponents.length > 0 &&
              ` Not counted: ${data.randomComponents.join(', ')} — random contents, so the true ceiling is a little higher.`}
            {data.estimatedFinishCount > 0 &&
              ` ${data.estimatedFinishCount} card(s) have no market quote for the finish this product contains, so the other finish stood in.`}
          </p>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
            {shown.map((c) => (
              <button
                key={`${c.scryfallId}-${c.foil ? 'f' : 'n'}`}
                onClick={() => onCard(sealedCardToValue(c))}
                title={`${c.name} — click to enlarge`}
                className="group relative block overflow-hidden rounded-md ring-1 ring-white/10 transition hover:ring-violet-400/60"
              >
                {c.imageUrl ? (
                  /* Reserve the card's shape: without it a tile has zero height
                     until its image arrives, and the grid renders as one row of
                     collapsed slivers. */
                  <img
                    src={c.imageUrl}
                    alt={c.name}
                    className="aspect-[5/7] w-full bg-white/5 object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex aspect-[5/7] items-center justify-center bg-white/5 p-1 text-center text-[10px] text-white/40">
                    {c.name}
                  </div>
                )}
                {c.count > 1 && (
                  <span className="absolute left-1 top-1 rounded bg-black/75 px-1 py-0.5 text-[10px] tabular-nums text-white/80">
                    {c.count}×
                  </span>
                )}
                <span className="absolute right-1 top-1 rounded bg-black/75 px-1 py-0.5 text-[10px] font-medium tabular-nums">
                  {money(c.lineTotal)}
                  {c.foil && <span className="ml-0.5 text-amber-300">✦</span>}
                </span>
                {/* An estimated price shouldn't look like a quoted one. */}
                {c.unitPrice != null && c.priceFinish !== (c.foil ? 'foil' : 'nonfoil') && (
                  <span
                    className="absolute bottom-1 left-1 rounded bg-black/75 px-1 py-0.5 text-[9px] uppercase tracking-wide text-amber-200/80"
                    title={`No ${c.foil ? 'foil' : 'nonfoil'} quote — priced from the ${c.priceFinish} printing`}
                  >
                    est
                  </span>
                )}
              </button>
            ))}
          </div>

          {data.cards.length > 24 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="mt-2 rounded border border-white/10 px-2 py-0.5 text-[11px] text-white/50 hover:bg-white/10"
            >
              {showAll ? 'Show top 24' : `Show all ${data.cards.length}`}
            </button>
          )}

          {data.expanded.length > 0 && (
            <p className="mt-2 text-[11px] text-white/25">Opened: {data.expanded.join(' · ')}</p>
          )}
        </>
      )}
    </div>
  )
}

function BuyPanel({ watchId, onChanged }: { watchId: string; onChanged: () => Promise<void> }) {
  const [listings, setListings] = useState<MtgListing[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [manual, setManual] = useState('')

  const load = useCallback(async () => {
    setListings(await window.atlis.mtg.listings(watchId))
  }, [watchId])
  useEffect(() => { void load() }, [load])

  async function discover(): Promise<void> {
    setBusy(true)
    setNote('Checking retailers…')
    try {
      const r = await window.atlis.mtg.discover(watchId)
      setNote(r.note)
      await load()
      await onChanged()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function addManual(): Promise<void> {
    if (!manual.trim()) return
    setBusy(true)
    try {
      await window.atlis.mtg.addListing(watchId, manual.trim())
      setManual('')
      setNote(null)
      await load()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-1.5 rounded-md border border-white/10 bg-black/20 p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <ShoppingCart className="h-3.5 w-3.5 text-white/40" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-white/40">Where to buy</span>
        <button
          onClick={() => void discover()}
          disabled={busy}
          className="ml-auto rounded border border-white/10 px-1.5 py-0.5 text-[11px] hover:bg-white/10 disabled:opacity-50"
        >
          {busy ? 'Checking…' : listings.length ? 'Re-check' : 'Find retailers'}
        </button>
      </div>

      {note && <p className="mb-2 text-[11px] leading-relaxed text-white/50">{note}</p>}

      {listings.length > 0 && (
        <div className="space-y-1">
          {listings.map((l) => {
            const st = STATUS_META[l.status] ?? STATUS_META.unknown
            const kd = KIND_META[l.kind] ?? KIND_META.search
            return (
              <div key={l.id} className="flex items-center gap-2 text-[11px]">
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 flex-1 items-center gap-1 truncate text-violet-300 hover:underline"
                  title={l.url}
                >
                  {l.retailer}
                  <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                </a>
                <span className="shrink-0 rounded bg-white/5 px-1 text-[10px] text-white/40" title={kd.title}>
                  {kd.label}
                </span>
                <span
                  className={`w-20 shrink-0 text-right ${st.tone}`}
                  title={l.raw_state ? `Retailer says: ${l.raw_state}` : undefined}
                >
                  {st.label}
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-white/60">
                  {l.price == null ? '' : money(l.price)}
                </span>
                <button
                  onClick={() => void window.atlis.mtg.removeListing(l.id).then(load)}
                  className="shrink-0 rounded p-0.5 text-white/30 hover:bg-white/10 hover:text-white/60"
                  title="Remove this link"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-2 flex gap-1.5">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void addManual() }}
          placeholder="Paste a product URL if discovery missed it"
          className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] outline-none focus:border-violet-400/50"
        />
        <button
          onClick={() => void addManual()}
          disabled={busy || !manual.trim()}
          className="rounded border border-white/10 px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  )
}

function WatchRow({
  watch: w,
  period,
  active,
  onSelect,
  onChanged
}: {
  watch: MtgWatchRow
  /** Lookback for the Market-mode move badge. */
  period: Period
  active: boolean
  onSelect: () => void
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [showBuy, setShowBuy] = useState(false)
  const [target, setTarget] = useState(w.target_price == null ? '' : String(w.target_price))

  async function saveTarget(): Promise<void> {
    const n = target.trim() === '' ? null : Number(target)
    await window.atlis.mtg.updateWatch(w.id, { target_price: n != null && isFinite(n) ? n : null })
    setEditing(false)
    await onChanged()
  }

  // Distance to target drives the arrow: at/below target is the buy signal.
  const delta = w.target_price != null && w.last_price != null ? w.last_price - w.target_price : null
  const Arrow = delta == null ? Minus : delta <= 0 ? TrendingDown : TrendingUp
  const arrowTone = delta == null ? 'text-white/30' : delta <= 0 ? 'text-emerald-400' : 'text-white/40'

  return (
    <div>
    <div
      className={`rounded-md border px-3 py-2 ${
        active ? 'border-violet-400/50 bg-violet-500/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'
      }`}
    >
    <div className="flex items-center gap-3">
      {/* Thumbnail sits inside the select button so clicking the picture
          does what clicking the name does. Sealed watches never stored an
          image, so theirs is derived from the TCGplayer product id. */}
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <ProductThumb
          image={imageFor({ extSource: w.ext_source, extId: w.ext_id, imageUrl: w.image_url }, 'small')}
          alt={w.name}
          size="sm"
          icon={w.kind === 'sealed' ? Box : Sparkles}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{w.name}</div>
          <div className="truncate text-[11px] text-white/45">
            {w.set_code?.toUpperCase()}
            {w.collector_number ? ` #${w.collector_number}` : ''} · {w.variant}
            {w.last_checked_at ? ` · checked ${new Date(w.last_checked_at).toLocaleDateString()}` : ' · never checked'}
          </div>
        </div>
      </button>

      <Arrow className={`h-4 w-4 shrink-0 ${arrowTone}`} />
      <div className="w-20 shrink-0 text-right text-sm tabular-nums">{money(w.last_price)}</div>

      {editing ? (
        <input
          autoFocus
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onBlur={() => void saveTarget()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveTarget()
            if (e.key === 'Escape') setEditing(false)
          }}
          placeholder="target"
          className="w-20 rounded border border-white/20 bg-black/30 px-1.5 py-0.5 text-right text-xs outline-none"
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          title="Alert when the price drops to this"
          className="w-20 shrink-0 rounded px-1.5 py-0.5 text-right text-xs text-white/50 hover:bg-white/10"
        >
          {w.target_price == null ? 'set target' : `≤ ${money(w.target_price)}`}
        </button>
      )}

      <button
        onClick={() => void window.atlis.mtg.updateWatch(w.id, { alert_enabled: w.alert_enabled ? 0 : 1 }).then(onChanged)}
        title={w.alert_enabled ? 'Alerts on' : 'Alerts off'}
        className="shrink-0 rounded p-1 hover:bg-white/10"
      >
        {w.alert_enabled ? (
          <Bell className="h-3.5 w-3.5 text-violet-300" />
        ) : (
          <BellOff className="h-3.5 w-3.5 text-white/30" />
        )}
      </button>
      <button
        onClick={() => void window.atlis.mtg.acquireWatch(w.id).then(onChanged)}
        title="I bought this — move to Vault"
        className="shrink-0 rounded p-1 hover:bg-white/10"
      >
        <PackageCheck className="h-3.5 w-3.5 text-white/40" />
      </button>
      <button
        onClick={() => setShowBuy((v) => !v)}
        title="Where to buy"
        className={`shrink-0 rounded p-1 hover:bg-white/10 ${showBuy ? 'text-violet-300' : 'text-white/40'}`}
      >
        <ShoppingCart className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => void window.atlis.mtg.removeWatch(w.id).then(onChanged)}
        title="Remove"
        className="shrink-0 rounded p-1 hover:bg-white/10"
      >
        <Trash2 className="h-3.5 w-3.5 text-white/40" />
      </button>
    </div>
    {/* Lifecycle line: which mode and why, the MSRP rung, and the move. */}
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[52px] text-[11px] text-white/45">
      <ModeChip w={w} onChanged={onChanged} />
      {w.mode === 'hunt' ? (
        w.retail_best ? (
          <>
            <BandChip v={w.retail_band} />
            <a
              href={w.retail_best.url}
              target="_blank"
              rel="noreferrer"
              className="tabular-nums text-white/60 hover:text-white hover:underline"
              title={w.retail_best.status === 'preorder' ? 'Open for preorder' : 'In stock online'}
            >
              {RETAIL_SHORT[w.retail_best.retailer] ?? w.retail_best.retailer} {money(w.retail_best.price)}
              {w.retail_best.status === 'preorder' ? ' preorder' : ''}
            </a>
          </>
        ) : (
          <span className="text-white/30">not orderable at a big-box store</span>
        )
      ) : (
        <PeriodDelta r={w} period={period} />
      )}
      {w.kind === 'sealed' && <MsrpEditor w={w} onChanged={onChanged} />}
      {w.kind === 'sealed' && w.mode === 'market' && <BandChip v={w.market_band} prefix="mkt" />}
      {w.released_at && w.mode === 'hunt' && <span className="text-white/30">street {w.released_at}</span>}
    </div>
    </div>
    {showBuy && <BuyPanel watchId={w.id} onChanged={onChanged} />}
    </div>
  )
}

const RETAIL_SHORT: Record<string, string> = { bestbuy: 'Best Buy', target: 'Target', amazon: 'Amazon' }

/**
 * HUNT / MARKET, with the reason in the tooltip. Clicking pins the row to the
 * other mode; clicking a pinned row hands it back to the automatic rule.
 */
function ModeChip({ w, onChanged }: { w: MtgWatchRow; onChanged: () => Promise<void> }): React.JSX.Element {
  const next = w.mode_auto ? (w.mode === 'hunt' ? 'market' : 'hunt') : null
  const tone =
    w.mode === 'hunt'
      ? 'border-sky-400/40 bg-sky-500/15 text-sky-200'
      : 'border-violet-400/30 bg-violet-500/10 text-violet-200/80'
  return (
    <button
      onClick={() => void window.atlis.mtg.updateWatch(w.id, { mode_override: next }).then(onChanged)}
      title={`${w.mode_reason}. ${next ? `Click to pin to ${next}.` : 'Click to go back to automatic.'}`}
      className={`flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${tone}`}
    >
      {w.mode}
      {!w.mode_auto && <Pin className="h-2.5 w-2.5" />}
    </button>
  )
}

/** MSRP, inline-editable. A typed figure is `manual` and always beats the inferred one. */
function MsrpEditor({ w, onChanged }: { w: MtgWatchRow; onChanged: () => Promise<void> }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(w.msrp == null ? '' : String(w.msrp))
  async function save(): Promise<void> {
    const n = val.trim() === '' ? null : Number(val)
    const msrp = n != null && isFinite(n) && n > 0 ? n : null
    await window.atlis.mtg.updateWatch(w.id, { msrp, msrp_source: msrp == null ? null : 'manual' })
    setEditing(false)
    await onChanged()
  }
  if (editing) {
    return (
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') setEditing(false)
        }}
        placeholder="MSRP"
        className="w-16 rounded border border-white/20 bg-black/30 px-1 py-px text-right text-[11px] outline-none"
      />
    )
  }
  return (
    <button
      onClick={() => {
        setVal(w.msrp == null ? '' : String(w.msrp))
        setEditing(true)
      }}
      title={
        w.msrp == null
          ? 'No MSRP yet. Set one, or it is inferred from the first Best Buy / Target price seen.'
          : w.msrp_source === 'inferred'
            ? 'Inferred from the lowest Best Buy / Target price seen. Click to set it yourself.'
            : 'Set by you'
      }
      className="rounded px-1 py-px tabular-nums hover:bg-white/10"
    >
      {w.msrp == null ? 'set MSRP' : `MSRP ${money(w.msrp)}${w.msrp_source === 'inferred' ? '*' : ''}`}
    </button>
  )
}

/** Hunt | Market switch for the watchlist, plus the knobs that drive the split. */
function WatchModeBar({
  mode,
  onMode,
  counts,
  period,
  onPeriod
}: {
  mode: 'hunt' | 'market'
  onMode: (m: 'hunt' | 'market') => void
  counts: { hunt: number; market: number }
  period: Period
  onPeriod: (p: Period) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-white/10 text-xs">
          {([
            ['hunt', 'Hunt', 'Unreleased and in-print sealed: where and when can I buy it at MSRP?'],
            ['market', 'Market', 'Cards and out-of-print sealed: what is it worth, and which way is it going?']
          ] as const).map(([m, label, title]) => (
            <button
              key={m}
              onClick={() => onMode(m)}
              title={title}
              className={`px-3 py-1.5 ${mode === m ? 'bg-violet-500/25 text-violet-200' : 'text-white/45 hover:bg-white/5'}`}
            >
              {label} <span className="tabular-nums text-white/35">{counts[m]}</span>
            </button>
          ))}
        </div>
        {mode === 'market' && <PeriodPicker value={period} onChange={onPeriod} />}
        <span className="text-[11px] text-white/35">
          {mode === 'hunt'
            ? 'Stock checks every 20 min. Pings for preorders, restocks and MSRP-or-better prices.'
            : 'Priced once a day. No store checks.'}
        </span>
        <button
          onClick={() => setOpen((v) => !v)}
          title="Hunt / Market settings"
          className={`ml-auto rounded p-1 hover:bg-white/10 ${open ? 'text-violet-300' : 'text-white/40'}`}
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && <LifecyclePanel />}
    </div>
  )
}

function LifecyclePanel(): React.JSX.Element {
  const [cfg, setCfg] = useState<MtgLifecycleSettings | null>(null)
  useEffect(() => {
    void window.atlis.mtg.lifecycleSettings().then(setCfg)
  }, [])
  if (!cfg) return <div className="mt-2 text-[11px] text-white/35">Loading…</div>
  const save = (patch: Partial<MtgLifecycleSettings>): void => {
    void window.atlis.mtg.setLifecycleSettings(patch).then(setCfg)
  }
  const pct = (v: string): number | undefined => {
    const n = Number(v.replace('%', ''))
    return isFinite(n) && n >= 0 ? n / 100 : undefined
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-[11px]">
      <SettingField
        label="Print window (months)"
        hint="Sealed stays in Hunt this long after its street date"
        value={String(cfg.inPrintMonths)}
        onCommit={(v) => save({ inPrintMonths: Number(v) || cfg.inPrintMonths })}
      />
      <SettingField
        label="Near MSRP: at most +%"
        hint="How far over list still counts as a buy"
        value={String(Math.round(cfg.maxPremium * 100))}
        onCommit={(v) => save({ maxPremium: pct(v) ?? cfg.maxPremium })}
      />
      <SettingField
        label="…and at least % under market"
        hint="A near-MSRP price must also be this far under the secondary market"
        value={String(Math.round(cfg.minUnderMarket * 100))}
        onCommit={(v) => save({ minUnderMarket: pct(v) ?? cfg.minUnderMarket })}
      />
      <SettingField
        label="Home ZIP"
        hint="For local store stock"
        value={cfg.zip ?? ''}
        width="w-20"
        onCommit={(v) => save({ zip: v })}
      />
      <SettingField
        label="Radius (mi)"
        hint="Only stores within this distance"
        value={String(cfg.radiusMi)}
        onCommit={(v) => save({ radiusMi: Number(v) || cfg.radiusMi })}
      />
    </div>
  )
}

/** A small label + input that commits on blur or Enter. */
function SettingField({
  label,
  hint,
  value,
  onCommit,
  width = 'w-16'
}: {
  label: string
  hint: string
  value: string
  onCommit: (v: string) => void
  width?: string
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-1.5" title={hint}>
      <span className="text-white/50">{label}</span>
      <input
        defaultValue={value}
        onBlur={(e) => {
          if (e.target.value !== value) onCommit(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className={`${width} rounded border border-white/15 bg-black/30 px-1.5 py-0.5 text-right tabular-nums outline-none focus:border-violet-400/50`}
      />
    </label>
  )
}
