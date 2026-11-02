/**
 * Lifecycle — is a watched thing something to HUNT or something to follow on
 * the MARKET?
 *
 * WHY TWO MODES: a 2021 Collector Box and a box whose preorders open next month
 * were being treated identically — a daily price check AND a retail stock
 * sweep. They want opposite things. The old box will almost certainly never be
 * on a Best Buy shelf again, so polling for it is wasted traffic and the only
 * honest number is the secondary market's. The new box is the opposite: one
 * price a day is useless, the question is where and when it can be bought at
 * list.
 *
 *   hunt    retail availability matters: stock sweeps, preorder/restock pings,
 *           and price judged against MSRP.
 *   market  out of print: the daily price check only, judged as a trend.
 *
 * THE MODE IS DERIVED, NOT FILED. Nobody should have to sort their own
 * watchlist, and a set ages out of print on its own schedule. The rule (cards
 * are always market; sealed is hunt while unreleased, inside the print window,
 * or recently seen at a first-party retailer near list) is evaluated on every
 * read. `mode_override` pins a row when the rule is wrong for it.
 *
 * This module depends on db only, so retail.ts and mtg.ts can both import it.
 */
import * as db from './db'

export type WatchMode = 'hunt' | 'market'

export interface ModeVerdict {
  mode: WatchMode
  /** False when the row is pinned with mode_override. */
  auto: boolean
  /** One line a person can read: why this row landed where it did. */
  reason: string
  /** Street date used for the decision, YYYY-MM-DD. */
  releasedAt: string | null
}

// ------------------------------------------------------------------ settings

const WINDOW_KEY = 'mtg_inprint_months'
const DEFAULT_WINDOW_MONTHS = 12
const PREMIUM_KEY = 'mtg_band_max_premium'
const DEFAULT_PREMIUM = 0.25
const UNDER_MARKET_KEY = 'mtg_band_min_under_market'
const DEFAULT_UNDER_MARKET = 0.2
const ZIP_KEY = 'local_zip'
const RADIUS_KEY = 'local_radius_mi'
const DEFAULT_RADIUS_MI = 25

export interface LifecycleSettings {
  /** Months after street date a sealed product is still assumed to be in print. */
  inPrintMonths: number
  /** "Near MSRP" ceiling: at most this far over list (0.25 = +25%). */
  maxPremium: number
  /** ...and at least this far under the secondary market (0.2 = 20% under). */
  minUnderMarket: number
  /** Home ZIP and radius for local store stock. Read by the local-stock adapter. */
  zip: string | null
  radiusMi: number
}

function num(key: string, fallback: number, min: number, max: number): number {
  const raw = Number(db.getSetting(key))
  return isFinite(raw) && raw >= min && raw <= max ? raw : fallback
}

export function settings(): LifecycleSettings {
  return {
    inPrintMonths: num(WINDOW_KEY, DEFAULT_WINDOW_MONTHS, 1, 120),
    maxPremium: num(PREMIUM_KEY, DEFAULT_PREMIUM, 0, 5),
    minUnderMarket: num(UNDER_MARKET_KEY, DEFAULT_UNDER_MARKET, 0, 0.95),
    zip: db.getSetting(ZIP_KEY),
    radiusMi: num(RADIUS_KEY, DEFAULT_RADIUS_MI, 1, 200)
  }
}

export function saveSettings(patch: Partial<LifecycleSettings>): LifecycleSettings {
  if (patch.inPrintMonths != null) db.setSetting(WINDOW_KEY, String(Math.round(patch.inPrintMonths)))
  if (patch.maxPremium != null) db.setSetting(PREMIUM_KEY, String(patch.maxPremium))
  if (patch.minUnderMarket != null) db.setSetting(UNDER_MARKET_KEY, String(patch.minUnderMarket))
  if (patch.zip !== undefined) db.setSetting(ZIP_KEY, (patch.zip ?? '').trim())
  if (patch.radiusMi != null) db.setSetting(RADIUS_KEY, String(Math.round(patch.radiusMi)))
  return settings()
}

// ------------------------------------------------------------------ classify

/**
 * Retailers whose own price is list. Amazon is deliberately absent: it hosts
 * marketplace sellers, so an Amazon price alone says nothing about MSRP.
 */
const FIRST_PARTY = new Set(['bestbuy', 'target'])
/** Retailers that sell at or near list when they sell it themselves. */
const BIG_BOX = new Set(['bestbuy', 'target', 'amazon'])
/** Orderable right now. in_store_only is NOT here: it means "go look", not "order". */
const ORDERABLE = new Set(['in_stock', 'preorder'])
const SIGHTING_DAYS = 60
const SIGHTING_SLACK = 1.15
const DAY_MS = 86_400_000

function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthsBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map(Number)
  const [ty, tm, td] = toYmd.split('-').map(Number)
  return (ty - fy) * 12 + (tm - fm) + (td - fd) / 31
}

interface Ctx {
  sets: Map<string, db.MtgSet>
  cfg: LifecycleSettings
}

function context(): Ctx {
  return { sets: new Map(db.listMtgSets().map((s) => [s.code.toLowerCase(), s])), cfg: settings() }
}

/**
 * The street date that decides a sealed product's lifecycle. The catalogue
 * product's own date wins over its set's, because a Commander deck reprint
 * ships under an old set code with a NEW release date — exactly the case where
 * the set's date would wrongly call it out of print.
 */
function releaseDateOf(w: db.MtgWatch, ctx: Ctx): string | null {
  if (w.ext_source === 'tcgplayer' && w.ext_id) {
    const p = db.findMtgSealedByTcgplayer(w.ext_id)
    if (p?.release_date) return p.release_date
  }
  return w.set_code ? (ctx.sets.get(w.set_code.toLowerCase())?.released_at ?? null) : null
}

const RETAILER_NAMES: Record<string, string> = { bestbuy: 'Best Buy', target: 'Target', amazon: 'Amazon' }

export function classifyMode(w: db.MtgWatch, ctx: Ctx = context()): ModeVerdict {
  const releasedAt = w.kind === 'sealed' ? releaseDateOf(w, ctx) : null
  if (w.mode_override === 'hunt' || w.mode_override === 'market') {
    return { mode: w.mode_override, auto: false, reason: 'pinned by you', releasedAt }
  }
  if (w.kind !== 'sealed') {
    return { mode: 'market', auto: true, reason: 'single cards trade on the secondary market', releasedAt }
  }
  if (!releasedAt) {
    return { mode: 'hunt', auto: true, reason: 'no street date known yet', releasedAt }
  }
  const today = todayYmd()
  if (releasedAt > today) {
    return { mode: 'hunt', auto: true, reason: `releases ${releasedAt}`, releasedAt }
  }
  const months = monthsBetween(releasedAt, today)
  if (months <= ctx.cfg.inPrintMonths) {
    return {
      mode: 'hunt',
      auto: true,
      reason: `released ${releasedAt}, inside the ${ctx.cfg.inPrintMonths}-month print window`,
      releasedAt
    }
  }
  // A first-party retailer selling it near list recently is direct evidence it
  // is back in print, whatever the calendar says.
  const since = Date.now() - SIGHTING_DAYS * DAY_MS
  for (const l of db.listMtgListings({ watchId: w.id })) {
    if (!FIRST_PARTY.has(l.retailer) || !ORDERABLE.has(l.status)) continue
    if (l.price == null || !l.last_checked_at || l.last_checked_at < since) continue
    if (w.msrp != null && l.price > w.msrp * SIGHTING_SLACK) continue
    return {
      mode: 'hunt',
      auto: true,
      reason: `${RETAILER_NAMES[l.retailer] ?? l.retailer} had it at $${l.price.toFixed(2)} on ${new Date(l.last_checked_at).toLocaleDateString()}`,
      releasedAt
    }
  }
  return {
    mode: 'market',
    auto: true,
    reason: `released ${releasedAt}, past the ${ctx.cfg.inPrintMonths}-month print window`,
    releasedAt
  }
}

/** Mode for one row by id — what the stock sweep asks before fetching anything. */
export function modeOf(watchId: string): WatchMode | null {
  const w = db.getMtgWatch(watchId)
  return w ? classifyMode(w).mode : null
}

// ------------------------------------------------------------------ MSRP

/**
 * Remember a first-party price as the MSRP when we have nothing better.
 *
 * Best Buy and Target sell sealed Magic at list, so the lowest price either
 * has quoted is a good stand-in for an MSRP Wizards rarely publishes in a
 * readable form. Labelled `inferred` so the UI can say so, and never allowed
 * to overwrite a manual figure. The floor guards against a one-off clearance
 * price permanently dragging the MSRP down.
 */
export function noteFirstPartyPrice(watchId: string, retailer: string, price: number | null): void {
  if (!FIRST_PARTY.has(retailer) || price == null || price <= 0) return
  const w = db.getMtgWatch(watchId)
  if (!w || w.kind !== 'sealed' || w.msrp_source === 'manual') return
  if (w.msrp != null && (price >= w.msrp || price < w.msrp * 0.75)) return
  db.updateMtgWatch(watchId, { msrp: Math.round(price * 100) / 100, msrp_source: 'inferred' })
}

// ------------------------------------------------------------------ bands

/**
 * Where a price sits against list — the ladder that replaced a generic dip
 * flag, because "is this a buy" for sealed is a question about MSRP:
 *
 *   below_msrp  under list
 *   at_msrp     within 2% of list
 *   near_msrp   over list by at most maxPremium AND under market by at least
 *               minUnderMarket (the market test is skipped when the price IS
 *               the market, i.e. a Market-mode row)
 *   over_msrp   anything else
 */
export type MsrpBand = 'below_msrp' | 'at_msrp' | 'near_msrp' | 'over_msrp'

export interface BandVerdict {
  band: MsrpBand
  /** (price / msrp − 1) × 100. Negative below list. */
  overPct: number
  /** (1 − price / market) × 100, when a separate market price was given. */
  underMarketPct: number | null
}

const AT_TOLERANCE = 0.02

export function msrpBand(
  price: number | null,
  msrp: number | null,
  market: number | null,
  cfg: LifecycleSettings = settings()
): BandVerdict | null {
  if (price == null || price <= 0 || msrp == null || msrp <= 0) return null
  const ratio = price / msrp
  const overPct = Math.round((ratio - 1) * 1000) / 10
  const underMarketPct = market != null && market > 0 ? Math.round((1 - price / market) * 1000) / 10 : null
  let band: MsrpBand
  if (ratio < 1 - AT_TOLERANCE) band = 'below_msrp'
  else if (ratio <= 1 + AT_TOLERANCE) band = 'at_msrp'
  else if (
    ratio <= 1 + cfg.maxPremium &&
    (underMarketPct == null || underMarketPct >= cfg.minUnderMarket * 100)
  ) band = 'near_msrp'
  else band = 'over_msrp'
  return { band, overPct, underMarketPct }
}

/** The bands that count as "worth buying" — what deals and pings key on. */
export const BUY_BANDS: ReadonlySet<MsrpBand> = new Set(['below_msrp', 'at_msrp', 'near_msrp'])

// ------------------------------------------------------------------ annotate

export interface RetailBest {
  retailer: string
  price: number
  status: string
  url: string
}

export type AnnotatedWatch = db.MtgWatch &
  db.PeriodPrices & {
    mode: WatchMode
    mode_auto: boolean
    mode_reason: string
    released_at: string | null
    /** Cheapest orderable big-box listing, the "can I buy it at list" price. */
    retail_best: RetailBest | null
    retail_band: BandVerdict | null
    /** The secondary market's price against list. */
    market_band: BandVerdict | null
  }

/**
 * The watchlist as the UI wants it: each row with its mode, the reason for
 * it, its best retail price, both MSRP bands and its period lookbacks. One
 * pass, one settings read and one set-table read for the whole list.
 */
export function annotateWatchlist(rows: db.MtgWatch[] = db.listMtgWatchlist()): AnnotatedWatch[] {
  const ctx = context()
  return db.attachPeriodPrices(rows).map((w) => {
    const v = classifyMode(w, ctx)
    let best: RetailBest | null = null
    for (const l of db.listMtgListings({ watchId: w.id })) {
      if (!BIG_BOX.has(l.retailer) || !ORDERABLE.has(l.status) || l.price == null || l.price <= 0) continue
      if (!best || l.price < best.price) best = { retailer: l.retailer, price: l.price, status: l.status, url: l.url }
    }
    return {
      ...w,
      mode: v.mode,
      mode_auto: v.auto,
      mode_reason: v.reason,
      released_at: v.releasedAt,
      retail_best: best,
      retail_band: best ? msrpBand(best.price, w.msrp, w.last_price, ctx.cfg) : null,
      market_band: msrpBand(w.last_price, w.msrp, null, ctx.cfg)
    }
  })
}
