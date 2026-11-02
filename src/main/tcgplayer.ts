/**
 * TCGplayer client — search, whole sets, and per-printing prices for EVERY
 * card game.
 *
 * Magic has Scryfall and MTGJSON behind it; most other games have nothing but
 * TCGplayer, which lists them all (Palworld OFFICIAL CARD GAME since
 * 2026-08-31, Cyberpunk TCG alongside it). Two endpoints tcgplayer.com itself
 * calls, the same family mtg.ts and retail.ts already rely on, with the same
 * caveat: no key, and no published stability guarantee.
 *
 *   mp-search-api  FINDS products: by name, or a whole set, in any game, split
 *                  by card vs sealed. Never used to price a watch: its
 *                  lowestPrice is taken across printings, so a Foil card's
 *                  "lowest" can be the Normal copy's price.
 *   pricepoints    prices ONE printing — the only thing a watch reads, so a
 *                  Foil watch can never quietly report the Normal price (the
 *                  rule retail.ts already enforces for Magic).
 *
 * Search limits, probed 2026-09-14: at most 50 results per request (100 is a
 * 400), paged with `from`; an empty query with a game filter lists everything
 * in that game; sort {field:'market-price', order:'desc'} is honoured server
 * side ('marketPrice' is a 500).
 *
 * Deliberately free of electron and the database, so it can be shared and
 * tested on its own.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 15_000
const SEARCH = 'https://mp-search-api.tcgplayer.com/v1/search/request'
const PAGE_SIZE = 50
/** A runaway guard, not a real limit: the largest sets are a few hundred products. */
const MAX_PAGES = 30

export interface TcgGame {
  /** TCGplayer's product-line url name — the value its search filter takes. */
  url: string
  label: string
}

/** Filter values exactly as TCGplayer reports them (probed 2026-09-14). Magic is the Magic tab's, not listed. */
export const TCG_GAMES: TcgGame[] = [
  { url: 'palworld-official-card-game', label: 'Palworld' },
  { url: 'cyberpunk-tcg', label: 'Cyberpunk' },
  { url: 'pokemon', label: 'Pokémon' },
  { url: 'pokemon-japan', label: 'Pokémon Japan' },
  { url: 'one-piece-card-game', label: 'One Piece' },
  { url: 'lorcana-tcg', label: 'Lorcana' },
  { url: 'riftbound-league-of-legends-trading-card-game', label: 'Riftbound' },
  { url: 'yugioh', label: 'Yu-Gi-Oh!' },
  { url: 'digimon-card-game', label: 'Digimon' },
  { url: 'dragon-ball-super-fusion-world', label: 'Dragon Ball Fusion World' },
  { url: 'gundam-card-game', label: 'Gundam' },
  { url: 'star-wars-unlimited', label: 'Star Wars: Unlimited' },
  { url: 'flesh-and-blood-tcg', label: 'Flesh and Blood' },
  { url: 'union-arena', label: 'Union Arena' },
  { url: 'hololive-official-card-game', label: 'hololive' },
  { url: 'weiss-schwarz', label: 'Weiss Schwarz' }
]

export type TcgPrinting = 'Normal' | 'Foil'
export type TcgType = 'cards' | 'sealed' | 'all'
type ProductType = 'Cards' | 'Sealed Products'

export interface TcgProduct {
  productId: string
  name: string
  /** TCGplayer's own name for the line, e.g. "Palworld OFFICIAL CARD GAME". */
  gameLabel: string
  set: string | null
  /** Collector number as the game prints it, e.g. "EBP01-001SSP". */
  number: string | null
  rarity: string | null
  sealed: boolean
  foilOnly: boolean
  /** Search-time figures, for choosing and ranking — NOT what a watch records. */
  market: number | null
  low: number | null
  listings: number
  image: string
  url: string
}

export interface TcgSet {
  /** TCGplayer's set url name — the value its search filter takes. */
  url: string
  name: string
  /** Products in the set, cards and sealed together, as TCGplayer counts them. */
  count: number
}

export interface TcgSetProducts {
  cards: TcgProduct[]
  sealed: TcgProduct[]
  /** True if the runaway guard stopped paging before the set was exhausted. */
  truncated: boolean
}

export function money(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

async function fetchText(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string }> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers ?? {}) },
      body: init.body,
      signal: ctl.signal
    })
    return { status: res.status, body: await res.text() }
  } finally {
    clearTimeout(t)
  }
}

export const tcgImage = (id: string): string => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_200w.jpg`

export const tcgUrl = (id: string, printing: TcgPrinting): string =>
  `https://www.tcgplayer.com/product/${id}${printing === 'Foil' ? '?Printing=Foil' : ''}`

export function tcgProductIdFrom(url: string): string | null {
  try {
    const u = new URL(url)
    if (!/(^|\.)tcgplayer\.com$/i.test(u.hostname)) return null
    return /\/product\/(\d+)/.exec(u.pathname)?.[1] ?? null
  } catch {
    return null
  }
}

interface Raw {
  score?: number
  productId?: number
  productName?: string
  productLineName?: string
  setName?: string
  rarityName?: string
  foilOnly?: boolean
  marketPrice?: number
  lowestPrice?: number
  totalListings?: number
  customAttributes?: { number?: string | null }
}

interface Bucket {
  urlValue?: string
  value?: string
  count?: number
}

interface Page {
  total: number
  rows: Array<TcgProduct & { score: number }>
  sets: Bucket[]
}

/**
 * One request to the search endpoint. Sealed-ness comes from WHICH product
 * type was asked for, never from the result: TCGplayer's per-result `sealed`
 * flag cannot be trusted (probed 2026-09-14, every Palworld booster box and
 * case came back sealed=false, productTypeId=0, while the productTypeName
 * FILTER returned exactly the sealed products).
 */
async function searchPage(opts: {
  q: string
  game?: string
  set?: string
  type?: ProductType
  from?: number
  size?: number
  byValue?: boolean
}): Promise<Page> {
  const term: Record<string, string[]> = {}
  if (opts.game) term.productLineName = [opts.game]
  if (opts.set) term.setName = [opts.set]
  if (opts.type) term.productTypeName = [opts.type]
  // The body tcgplayer.com's own search page sends; only filters, paging and sort vary.
  const body = {
    algorithm: 'sales_dismax',
    from: opts.from ?? 0,
    size: opts.size ?? PAGE_SIZE,
    filters: { term, range: {}, match: {} },
    listingSearch: {
      context: { cart: {} },
      filters: { term: { sellerStatus: 'Live', channelId: 0 }, range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } }
    },
    context: { cart: {}, shippingCountry: 'US' },
    settings: { useFuzzySearch: true, didYouMean: {} },
    sort: opts.byValue ? { field: 'market-price', order: 'desc' } : {}
  }
  const r = await fetchText(`${SEARCH}?q=${encodeURIComponent(opts.q)}&isList=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://www.tcgplayer.com', Referer: 'https://www.tcgplayer.com/' },
    body: JSON.stringify(body)
  })
  if (r.status !== 200) throw new Error(`TCGplayer search answered HTTP ${r.status}.`)
  const j = JSON.parse(r.body) as {
    results?: Array<{ totalResults?: number; results?: Raw[]; aggregations?: { setName?: Bucket[] } }>
  }
  const res = j.results?.[0]
  const isSealed = opts.type === 'Sealed Products'
  const rows = (res?.results ?? [])
    .filter((p) => p.productId != null)
    .map((p) => {
      const id = String(Math.round(Number(p.productId)))
      const foilOnly = !isSealed && !!p.foilOnly
      return {
        score: Number(p.score) || 0,
        productId: id,
        name: p.productName ?? `TCGplayer #${id}`,
        gameLabel: p.productLineName ?? '',
        set: p.setName ?? null,
        number: p.customAttributes?.number?.trim() || null,
        rarity: p.rarityName && p.rarityName !== 'None' ? p.rarityName : null,
        sealed: isSealed,
        foilOnly,
        market: money(p.marketPrice),
        low: money(p.lowestPrice),
        listings: Number(p.totalListings) || 0,
        image: tcgImage(id),
        url: tcgUrl(id, foilOnly ? 'Foil' : 'Normal')
      }
    })
  return { total: Number(res?.totalResults) || rows.length, rows, sets: res?.aggregations?.setName ?? [] }
}

const strip = (rows: Array<TcgProduct & { score: number }>): TcgProduct[] => rows.map(({ score: _s, ...p }) => p)

/** Search one game by name. A mixed search runs Cards and Sealed side by side (see searchPage). */
export async function tcgSearch(input: { q: string; game?: string; type?: TcgType }): Promise<TcgProduct[]> {
  const q = String(input?.q ?? '').trim()
  if (q.length < 2) throw new Error('Search for at least two characters.')
  const game = input.game ? String(input.game) : undefined
  if (input.type === 'cards') return strip((await searchPage({ q, game, type: 'Cards', size: 36 })).rows)
  if (input.type === 'sealed') return strip((await searchPage({ q, game, type: 'Sealed Products', size: 36 })).rows)
  const [cards, sealed] = await Promise.all([
    searchPage({ q, game, type: 'Cards', size: 24 }),
    searchPage({ q, game, type: 'Sealed Products', size: 12 })
  ])
  return strip([...cards.rows, ...sealed.rows].sort((a, b) => b.score - a.score))
}

/** Every set TCGplayer lists for a game, largest first — its own counts, one request. */
export async function tcgSets(game: string): Promise<TcgSet[]> {
  const page = await searchPage({ q: '', game, size: 0 })
  return page.sets
    .filter((b) => b.urlValue && b.value)
    .map((b) => ({ url: String(b.urlValue), name: String(b.value), count: Number(b.count) || 0 }))
}

async function everyProduct(game: string, set: string, type: ProductType): Promise<{ rows: TcgProduct[]; truncated: boolean }> {
  const rows: TcgProduct[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await searchPage({ q: '', game, set, type, from: page * PAGE_SIZE, size: PAGE_SIZE, byValue: true })
    rows.push(...strip(r.rows))
    if (r.rows.length < PAGE_SIZE || rows.length >= r.total) return { rows, truncated: false }
  }
  return { rows, truncated: true }
}

/** A whole set, cards and sealed, most valuable first. */
export async function tcgSetProducts(game: string, set: string): Promise<TcgSetProducts> {
  const [cards, sealed] = await Promise.all([everyProduct(game, set, 'Cards'), everyProduct(game, set, 'Sealed Products')])
  return { cards: cards.rows, sealed: sealed.rows, truncated: cards.truncated || sealed.truncated }
}

export interface PricePoint {
  printingType?: string
  marketPrice?: number | null
  listedMedianPrice?: number | null
}

export async function tcgPricePoints(productId: string): Promise<PricePoint[]> {
  if (!/^\d+$/.test(productId)) throw new Error('Not a TCGplayer product id.')
  const r = await fetchText(`https://mpapi.tcgplayer.com/v2/product/${productId}/pricepoints`)
  if (r.status !== 200) throw new Error(`TCGplayer answered HTTP ${r.status}.`)
  const rows = JSON.parse(r.body) as unknown
  if (!Array.isArray(rows)) throw new Error('TCGplayer returned no price data for this product.')
  return rows as PricePoint[]
}

export const tcgTrades = (rows: PricePoint[], p: TcgPrinting): boolean =>
  rows.some((r) => r.printingType === p && (money(r.marketPrice) != null || money(r.listedMedianPrice) != null))

export interface TcgQuote {
  /** Market Price (recent sales), with the listed median standing in before anything has sold. */
  market: number | null
  /** Median asking price — only present while copies are listed. */
  median: number | null
  /** Copies are listed right now. */
  listed: boolean
}

/**
 * One printing's quote, never the other printing as a fallback.
 *
 * A listed median only exists while copies are for sale, so its absence reads
 * as not listed — which is what lets an unreleased set, already on TCGplayer
 * with zero listings, alert the moment its first copies appear.
 */
export function quoteFor(rows: PricePoint[], printing: TcgPrinting): TcgQuote {
  const row = rows.find((x) => x.printingType === printing)
  const market = money(row?.marketPrice)
  const median = money(row?.listedMedianPrice)
  return { market: market ?? median, median, listed: median != null }
}

/**
 * Refuse a printing that does not trade while the other one does — it would be
 * a watch that never gets a price. When NEITHER trades (an upcoming set) the
 * choice is allowed, so it can alert on the first copies.
 */
export function assertPrintingTrades(rows: PricePoint[], printing: TcgPrinting): void {
  const other: TcgPrinting = printing === 'Foil' ? 'Normal' : 'Foil'
  if (!tcgTrades(rows, printing) && tcgTrades(rows, other)) {
    throw new Error(`This only trades as ${other} on TCGplayer — use the ${other.toLowerCase()} button.`)
  }
}
