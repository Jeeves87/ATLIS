/**
 * Retail availability — "where can I actually buy this".
 *
 * Three tiers of link, and the UI is explicit about which you're looking at,
 * because they are not equally trustworthy:
 *
 *   product   — built from an id we already hold (TCGplayer product id from
 *               MTGJSON, Scryfall's own purchase_uris). Exact, cannot mismatch.
 *   searched  — we hit the retailer's search page and pulled a product link out
 *               of the HTML by name. Usually right, CAN be the wrong product.
 *   search    — no product resolved; a link to that retailer's results page.
 *               Always valid, never wrong, just doesn't prove anything is stocked.
 *
 * Discovery deliberately degrades to `search` rather than guessing a URL shape,
 * and reports when nothing resolved so the user can paste a link themselves.
 *
 * Known constraints (probed 2026-08-22): Target's RedSky JSON answers 403 with
 * a CAPTCHA challenge, so only its HTML is usable here; Best Buy's real API
 * needs a key the user must supply; TCGplayer's price endpoint carries price
 * but no stock count. This module reads public pages only — it never logs in,
 * never adds to a cart, and never buys anything.
 */
import * as db from './db'
import * as lifecycle from './lifecycle'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 15_000
const GAP_MS = 400

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const enc = encodeURIComponent

/**
 * What a listing says about buying the thing, as a decision rather than a word.
 *
 *   in_stock              buyable and shippable now
 *   in_store_only         buyable, but only by going to a store
 *   preorder              orderable ahead of release
 *   listed                the page exists but nothing can be ordered yet
 *   sold_out_restocking   out, and the retailer's wording says more is expected
 *   out_of_stock          out, with no sign of more
 *   unknown               the page could not be read — never news
 *
 * "restocking" is an inference from retailer wording, not a promise, and the
 * alert says so. The verbatim wording travels beside it as `rawState`.
 */
export type ListingStatus =
  | 'in_stock'
  | 'in_store_only'
  | 'preorder'
  | 'listed'
  | 'sold_out_restocking'
  | 'out_of_stock'
  | 'unknown'

/** Statuses where money can change hands today. */
export const BUYABLE: ReadonlySet<string> = new Set(['in_stock', 'in_store_only', 'preorder'])

export interface ProductRef {
  kind: 'card' | 'sealed'
  name: string
  setCode?: string | null
  scryfallId?: string | null
  tcgplayerProductId?: string | null
  /**
   * The finish being tracked — nonfoil | foil | etched, or 'sealed'.
   *
   * A printing is one TCGplayer product carrying BOTH finishes at different
   * prices (Flubs, the Fool BLC #356: Normal $3.30, Foil $9.31), so without
   * this the price read silently returns the nonfoil one for a foil watch —
   * which then reads as the card being far under market.
   */
  finish?: string | null
  /** Scryfall's own per-printing purchase links — exact for the EXACT printing. */
  purchaseUris?: Record<string, string> | null
}

/**
 * Scryfall publishes purchase links per printing. For a card these beat any
 * name search: searching "Arcane Signet" by name finds *an* Arcane Signet, and
 * there are 90 of them across sets — this finds the one the user actually
 * tracks, collector number and finish included.
 */
async function scryfallPurchaseUris(scryfallId: string): Promise<Record<string, string> | null> {
  const r = await get(`https://api.scryfall.com/cards/${scryfallId}`, 'application/json')
  if (!r.ok) return null
  try {
    return (JSON.parse(r.body) as { purchase_uris?: Record<string, string> }).purchase_uris ?? null
  } catch {
    return null
  }
}

export interface ListingState {
  price: number | null
  status: ListingStatus
  /** The retailer's own words the status was read from, verbatim. */
  rawState?: string | null
  title?: string | null
  error?: string | null
}

interface Found {
  retailer: string
  kind: 'product' | 'searched' | 'search'
  url: string
  title?: string | null
  /** Set when discovery already read price/stock, so check() can be skipped. */
  state?: ListingState
}

/**
 * Optional Chromium-backed fetcher, injected by the main process.
 *
 * Kept as an injection rather than a direct import so this module stays
 * electron-free and can be exercised headlessly; without it everything simply
 * falls back to plain fetch (and the bot-walled retailers degrade to links).
 */
type Renderer = (url: string, opts?: { settleMs?: number }) => Promise<string | null>
let renderer: Renderer | null = null
export function setRenderer(fn: Renderer | null): void {
  renderer = fn
}
export const hasRenderer = (): boolean => renderer != null

/**
 * Fetch through real Chromium when available, else plain HTTP.
 * Used for the retailers that reject scripted requests outright.
 */
async function getRendered(url: string, settleMs = 1_200): Promise<{ ok: boolean; status: number; body: string }> {
  if (renderer) {
    const html = await renderer(url, { settleMs })
    if (html) return { ok: true, status: 200, body: html }
  }
  return get(url)
}

/** fetch with a timeout — a hung retailer must not wedge the whole sweep. */
async function get(url: string, accept = 'text/html'): Promise<{ ok: boolean; status: number; body: string }> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctl.signal
    })
    return { ok: res.ok, status: res.status, body: await res.text() }
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(t)
  }
}

// ---------------------------------------------------------------- retailers

/**
 * Amazon serves an intermittent bot-check page (a ~4KB interstitial, HTTP 200)
 * when hit twice in quick succession — which is exactly what discover-then-check
 * does. Detect it explicitly rather than reading it as "no price", and give
 * Amazon a longer gap than the other retailers.
 */
const AMAZON_BOT_RE = /api-services-support@amazon|Type the characters you see|just need to make sure/i
const AMAZON_GAP_MS = 2_200

async function getAmazon(url: string): Promise<{ ok: boolean; status: number; body: string }> {
  let r = await getRendered(url, 1_500)
  if ((!r.ok || AMAZON_BOT_RE.test(r.body)) && renderer) {
    // A real browser usually clears the interstitial on a second pass, because
    // the first one seeds the cookies the check is looking for.
    await sleep(AMAZON_GAP_MS)
    r = await getRendered(url, 2_500)
  }
  // Still the interstitial: report it as unknown rather than a bogus price.
  if (r.ok && AMAZON_BOT_RE.test(r.body)) return { ok: false, status: 429, body: '' }
  return r
}

interface Retailer {
  id: string
  label: string
  /** Extra pacing this retailer needs beyond the default gap. */
  gapMs?: number
  /** Exact product URL from an id we already hold. */
  derive?: (ref: ProductRef) => string | null
  /** Retailer results page — always safe, never proves availability. */
  searchUrl: (ref: ProductRef) => string
  /** Try to pull a real product link out of the results HTML. */
  discover?: (ref: ProductRef) => Promise<Found | null>
  /** Read price/stock from a resolved product URL, for a specific finish. */
  check?: (url: string, finish?: string | null) => Promise<ListingState>
}

/** TCGplayer market price for a product id. Price present ⇒ live listings exist. */
async function tcgPricePoints(productId: string, finish?: string | null): Promise<ListingState> {
  const r = await get(`https://mpapi.tcgplayer.com/v2/product/${productId}/pricepoints`, 'application/json')
  if (!r.ok) return { price: null, status: 'unknown', error: `HTTP ${r.status}` }
  try {
    const rows = JSON.parse(r.body) as Array<{ printingType?: string; marketPrice?: number | null; listedMedianPrice?: number | null }>
    // Sealed has no finish split, so 'Normal' is its real row. A CARD tracked
    // as foil must read the Foil row, or the quote belongs to a different
    // version of the card than the one being watched.
    const wantFoil = finish === 'foil' || finish === 'etched'
    const preferred = wantFoil ? 'Foil' : 'Normal'
    const ordered = [...rows].sort(
      (a, b) => (a.printingType === preferred ? -1 : 0) - (b.printingType === preferred ? -1 : 0)
    )
    // A foil watch must not silently fall back to the nonfoil price: report no
    // quote instead, so nothing downstream mistakes it for a bargain.
    const usable = wantFoil ? ordered.filter((row) => row.printingType === 'Foil') : ordered
    for (const row of usable) {
      const v = row.marketPrice ?? row.listedMedianPrice
      if (typeof v === 'number' && isFinite(v) && v > 0) return { price: v, status: 'in_stock' }
    }
    // Endpoint answered but quoted nothing — nobody has it listed.
    return { price: null, status: 'out_of_stock' }
  } catch {
    return { price: null, status: 'unknown', error: 'unparseable price response' }
  }
}

/**
 * Sealed products differ by two things word-overlap scoring cannot see.
 *
 * FORM: box vs pack vs case vs bundle. "The Hobbit Collector Booster Pack"
 * shares 4 of 5 words with "The Hobbit Collector Booster Box" and sails past
 * any similarity threshold — but one is $73 and the other is $849.
 *
 * LINE: collector vs play vs draft. Same trap: Target's "Play Booster Display"
 * matched a Collector Box query and reported $224.99 for an $849 product.
 *
 * Both are treated as hard gates: if the query names a form or a line, a
 * candidate that names a DIFFERENT one is rejected outright, no matter how
 * many words it shares.
 */
type ProductForm = 'case' | 'box' | 'pack' | 'bundle' | 'deck' | null
type ProductLine = 'collector' | 'play' | 'draft' | 'jumpstart' | null

function productForm(s: string): ProductForm {
  const t = s.toLowerCase()
  // Order matters: "Collector Booster Box Case" is a case, not a box.
  if (/\bcase\b/.test(t)) return 'case'
  if (/\bbox\b|\bdisplay\b/.test(t)) return 'box'
  if (/\bpacks?\b|\bbooster pack\b/.test(t)) return 'pack'
  if (/\bbundle\b|\bgift\b/.test(t)) return 'bundle'
  if (/\bdeck\b/.test(t)) return 'deck'
  return null
}

function productLine(s: string): ProductLine {
  const t = s.toLowerCase()
  if (/\bcollector\b/.test(t)) return 'collector'
  if (/\bplay\b/.test(t)) return 'play'
  if (/\bdraft\b/.test(t)) return 'draft'
  if (/\bjumpstart\b/.test(t)) return 'jumpstart'
  return null
}

/**
 * The language a product title declares, or null for English.
 *
 * English is the unmarked default and is treated as such even when a listing
 * says so outright, so "… Collector Booster Box English" still matches a plain
 * "… Collector Booster Box".
 *
 * This matters because a Japanese box is NOT a cheaper version of the English
 * one — it is a different product with its own market. Amazon and Target both
 * list import stock alongside domestic, the titles say so plainly, and without
 * this gate word-overlap scoring matched them perfectly (every token of the
 * English name is present) at an import price, which then surfaced as a
 * spurious "below market" deal.
 */
const LANGUAGE_PATTERNS: Array<[string, RegExp]> = [
  ['japanese', /\bjapanese\b|日本語/i],
  ['korean', /\bkorean\b|한국/i],
  ['chinese-simplified', /\bsimplified\b\s+chinese\b|\bchinese\b\s+simplified\b/i],
  ['chinese-traditional', /\btraditional\b\s+chinese\b|\bchinese\b\s+traditional\b/i],
  ['chinese', /\bchinese\b|中文/i],
  ['german', /\bgerman\b|\bdeutsch\b/i],
  ['french', /\bfrench\b|\bfran[cç]ais\b/i],
  ['italian', /\bitalian\b|\bitaliano\b/i],
  ['spanish', /\bspanish\b|\bespa[nñ]ol\b/i],
  ['portuguese', /\bportuguese\b|\bportugu[eê]s\b/i],
  ['russian', /\brussian\b|\bрусск/i]
]

export function productLanguage(s: string): string | null {
  for (const [lang, re] of LANGUAGE_PATTERNS) if (re.test(s)) return lang
  return null
}

/**
 * Word overlap, gated on form, line and language. Returns null when the
 * candidate is a different product rather than a worse match.
 */
export function scoreCandidate(wanted: string, title: string): number | null {
  const wantForm = productForm(wanted)
  const wantLine = productLine(wanted)
  const gotForm = productForm(title)
  const gotLine = productLine(title)
  // Symmetric: an import listing can't stand in for the domestic product, and
  // a domestic one can't stand in for an import the user deliberately tracks.
  if (productLanguage(wanted) !== productLanguage(title)) return null
  if (wantForm && gotForm && wantForm !== gotForm) return null
  // A listing that names no form is a single pack: boxes, cases and displays
  // always say so, but retailers routinely list the single as just
  // "Collector Booster" (Best Buy does exactly this). Only that direction is
  // safe to assume — an undeclared listing is never silently treated as a box.
  if (wantForm && !gotForm && wantForm !== 'pack') return null
  if (wantLine && gotLine && wantLine !== gotLine) return null
  if (wantLine && !gotLine) return null

  const tokens = wanted.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2)
  if (!tokens.length) return null
  const lower = title.toLowerCase()
  return tokens.filter((t) => lower.includes(t)).length / tokens.length
}

/**
 * Pick the Amazon search result that actually matches what we're looking for.
 *
 * Amazon's results page is mostly noise for this: sponsored placements, other
 * Universes Beyond sets, and accessory bundles all rank alongside the real
 * product. Scoring on how much of the query appears in the title stops a
 * search for a Hobbit box resolving to a Marvel one. Prices are NOT read here
 * — search markup omits them for almost every result (1 of 51 in testing), so
 * the price comes from the product page instead.
 */
function bestAmazonMatch(html: string, wanted: string): { asin: string; title: string } | null {
  if (!wanted.trim()) return null

  const seen = new Set<string>()
  let best: { asin: string; title: string; score: number } | null = null

  for (const chunk of html.split(/data-asin="/).slice(1)) {
    const asin = /^([A-Z0-9]{10})"/.exec(chunk)?.[1]
    if (!asin || seen.has(asin)) continue
    seen.add(asin)
    const near = chunk.slice(0, 6000)
    const title =
      /<h2[^>]*aria-label="([^"]{10,200})"/.exec(near)?.[1] ??
      /<h2[\s\S]{0,300}?<span[^>]*>([^<]{10,200})<\/span>/.exec(near)?.[1]
    if (!title) continue
    const clean = title.replace(/\s+/g, ' ').trim()
    if (/^Sponsored Ad/i.test(clean)) continue
    const score = scoreCandidate(wanted, clean)
    if (score == null) continue // wrong form or product line entirely
    if (!best || score > best.score) best = { asin, title: clean, score }
  }
  // Below ~⅔ of the query's words present, it's a different product.
  return best && best.score >= 0.66 ? { asin: best.asin, title: best.title } : null
}

/**
 * Product entries out of Best Buy's embedded Apollo payload.
 *
 * Their search page has no scrapable product markup at all — the results live
 * in a GraphQL blob (`skuId`, `url.skuSpecificUrl`, `name.title`,
 * `customerPrice`, `fulfillmentOptions.buttonStates[].buttonState`). Splitting
 * on skuId and reading forward keeps each product's fields together.
 */
function bestBuyEntries(html: string): Array<{ sku: string; url: string; title: string; price: number | null; button: string | null }> {
  const out: Array<{ sku: string; url: string; title: string; price: number | null; button: string | null }> = []
  const seen = new Set<string>()
  for (const m of html.matchAll(/"skuId"\s*:\s*"(\d{6,9})"/g)) {
    const sku = m[1]
    if (seen.has(sku)) continue
    seen.add(sku)
    const chunk = html.slice(m.index ?? 0, (m.index ?? 0) + 4000)
    const url = /"skuSpecificUrl"\s*:\s*"([^"]+)"/.exec(chunk)?.[1]
    const title = /"title"\s*:\s*"([^"]{5,140})"/.exec(chunk)?.[1]
    if (!url || !title) continue
    const rawPrice = /"customerPrice"\s*:\s*([\d.]+)/.exec(chunk)?.[1] ?? /"currentPrice"\s*:\s*([\d.]+)/.exec(chunk)?.[1]
    const n = rawPrice ? Number(rawPrice) : null
    out.push({
      sku,
      url,
      title: title.replace(/\\u0026/g, '&').replace(/\s+/g, ' ').trim(),
      price: n != null && isFinite(n) ? n : null,
      button: /"buttonState"\s*:\s*"([A-Z_]+)"/.exec(chunk)?.[1] ?? null
    })
  }
  return out
}

/**
 * Trim a product name into something Target's search will actually answer.
 *
 * Measured: the full MTGJSON name ("The Hobbit Collector Booster Pack")
 * renders an EMPTY page, while "hobbit collector booster" returns 28 products.
 * Dropping the leading article and the words Target never uses in its own
 * titles is what makes the difference.
 */
const TARGET_NOISE = new Set(['the', 'a', 'an', 'pack', 'packs', 'edition'])
function targetQuery(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !TARGET_NOISE.has(w))
  // Target's relevance falls apart past a handful of terms.
  return words.slice(0, 5).join(' ')
}

type BestBuyEntry = { sku: string; url: string; title: string; price: number | null; button: string | null }

/**
 * Look a product up through Best Buy's name search.
 *
 * `skuFilter` pins the result to one SKU (used when re-checking a known URL);
 * without it the best form/line-gated title match wins.
 */
async function bestBuyLookup(query: string, skuFilter?: string | null): Promise<BestBuyEntry | null> {
  if (!hasRenderer()) return null
  const r = await getRendered(`https://www.bestbuy.com/site/searchpage.jsp?st=${enc(query)}`, 4_000)
  if (!r.ok) return null
  const entries = bestBuyEntries(r.body)
  if (skuFilter) return entries.find((e) => e.sku === skuFilter) ?? null
  let best: { entry: BestBuyEntry; score: number } | null = null
  for (const e of entries) {
    const score = scoreCandidate(query, e.title)
    if (score == null || score < 0.66) continue
    if (!best || score > best.score) best = { entry: e, score }
  }
  return best?.entry ?? null
}

function bestBuyState(e: BestBuyEntry): ListingState {
  return {
    price: e.price,
    title: e.title,
    status: bestBuyStatus(e.button, e.price),
    rawState: e.button,
    // Surface the raw state: "in store only" and "sold out" are very different
    // situations that both mean "not shipping to you right now".
    error: e.button && e.button !== 'ADD_TO_CART' ? `Best Buy: ${e.button.replace(/_/g, ' ').toLowerCase()}` : null
  }
}

/** Best Buy's buttonState is the authoritative availability signal. */
function bestBuyStatus(button: string | null, price: number | null): ListingStatus {
  switch (button) {
    case 'ADD_TO_CART':
      return 'in_stock'
    case 'PREORDER':
      return 'preorder'
    // A page with no order button yet. Reading this as 'preorder' announced
    // preorders that could not actually be placed. After a sell-out it means
    // something else again — see withHistory().
    case 'COMING_SOON':
      return 'listed'
    case 'SOLD_OUT':
    case 'SOLD_OUT_ONLINE':
    // SEE_DETAILS is what Best Buy shows for an item you can't order — it
    // usually comes with no published price either, which is why these rows
    // legitimately show a status but no number.
    case 'SEE_DETAILS':
    case 'UNAVAILABLE':
      return 'out_of_stock'
    // Buyable, just not shippable. Kept apart from in_stock because "drive to
    // a store" and "click buy" are different decisions.
    case 'IN_STORE_ONLY':
    case 'CHECK_STORES':
      return 'in_store_only'
    default:
      return price != null ? 'in_stock' : 'unknown'
  }
}

/** Sold prices out of an eBay completed-listings page, ascending. */
function ebaySoldPrices(html: string): number[] {
  const out: number[] = []
  for (const m of html.matchAll(/s-item__price[^>]*>[\s\S]{0,120}?\$([\d,]+\.\d{2})/g)) {
    const n = Number(m[1].replace(/,/g, ''))
    if (isFinite(n) && n > 0) out.push(n)
  }
  return out.sort((a, b) => a - b)
}

const TCG_ID_RE = /\/product\/(\d+)/

/**
 * Pull a TCGplayer product id out of a URL.
 *
 * Scryfall's purchase link is an affiliate redirect that carries the real URL
 * percent-encoded in a query param (…&u=https%3A%2F%2F…%2Fproduct%2F693050…),
 * so the plain pattern has to be tried against the decoded form too or every
 * card link silently reports "unknown" instead of its price.
 */
function tcgProductId(url: string): string | null {
  const direct = TCG_ID_RE.exec(url)?.[1]
  if (direct) return direct
  try {
    return TCG_ID_RE.exec(decodeURIComponent(url))?.[1] ?? null
  } catch {
    return null
  }
}

const RETAILERS: Retailer[] = [
  {
    id: 'tcgplayer',
    label: 'TCGplayer',
    derive: (ref) => {
      // Land on the finish being tracked, not whatever the page defaults to.
      const printing = ref.finish === 'foil' || ref.finish === 'etched' ? '?Printing=Foil' : ''
      if (ref.tcgplayerProductId) return `https://www.tcgplayer.com/product/${ref.tcgplayerProductId}${printing}`
      const uri = ref.purchaseUris?.tcgplayer ?? null
      if (!uri) return null
      // Scryfall's link is an affiliate redirect; rebuild a direct one when the
      // product id can be recovered so the printing hint survives.
      const id = printing ? tcgProductId(uri) : null
      return id ? `https://www.tcgplayer.com/product/${id}${printing}` : uri
    },
    searchUrl: (ref) =>
      `https://www.tcgplayer.com/search/all/product?q=${enc(ref.name)}${
        ref.finish === 'foil' || ref.finish === 'etched' ? '&Printing=Foil' : ''
      }`,
    check: async (url, finish) => {
      const id = tcgProductId(url)
      if (!id) return { price: null, status: 'unknown', error: 'no product id in url' }
      return tcgPricePoints(id, finish)
    }
  },
  {
    id: 'cardkingdom',
    label: 'Card Kingdom',
    searchUrl: (ref) => `https://www.cardkingdom.com/catalog/search?search=header&filter%5Bname%5D=${enc(ref.name)}`,
    discover: async (ref) => {
      // Sealed names are unique enough to match alone; a card name is not
      // ("Arcane Signet" has ~90 printings), so only sealed is auto-matched
      // here and cards rely on the exact Scryfall-derived links instead.
      if (ref.kind !== 'sealed') return null
      const r = await get(`https://www.cardkingdom.com/catalog/search?search=header&filter%5Bname%5D=${enc(ref.name)}`)
      if (!r.ok) return null
      const m = /href="(\/mtg\/[^"']+)"/.exec(r.body)
      return m ? { retailer: 'cardkingdom', kind: 'searched', url: `https://www.cardkingdom.com${m[1]}` } : null
    },
    check: async (url) => {
      const r = await get(url)
      if (!r.ok) return { price: null, status: 'unknown', error: `HTTP ${r.status}` }
      const price = /\$\s?([\d,]+\.\d{2})/.exec(r.body)?.[1]
      const out = /out of stock|sold out/i.exec(r.body)?.[0]
      return {
        price: price ? Number(price.replace(/,/g, '')) : null,
        status: out ? 'out_of_stock' : price ? 'in_stock' : 'unknown',
        rawState: out ?? null
      }
    }
  },
  {
    id: 'target',
    label: 'Target',
    gapMs: 1_200,
    // RedSky (Target's JSON API) answers 403 + CAPTCHA, and the rendered DOM
    // carries no product JSON either — only descriptive URL slugs. Those are
    // enough, PROVIDED the query is short: Target's search returns nothing at
    // all for a long verbose phrase (a full MTGJSON product name renders as an
    // empty page), while a trimmed one returns 20-40 products.
    searchUrl: (ref) => `https://www.target.com/s?searchTerm=${enc(targetQuery(ref.name))}`,
    discover: async (ref) => {
      const q = targetQuery(ref.name)
      let r = await getRendered(`https://www.target.com/s?searchTerm=${enc(q)}`, 4_000)
      // An empty render is Target refusing the query, not "no results".
      if (!r.ok || r.body.length < 50_000) {
        await sleep(1_500)
        r = await getRendered(`https://www.target.com/s?searchTerm=${enc(q)}`, 5_000)
      }
      if (!r.ok || r.body.length < 20_000) return null

      let best: { tcin: string; slug: string; score: number } | null = null
      for (const m of r.body.matchAll(/href="\/p\/([^"]{5,120})\/-\/A-(\d+)/g)) {
        const slug = decodeURIComponent(m[1]).replace(/-/g, ' ')
        const score = scoreCandidate(ref.name, slug)
        if (score == null || score < 0.66) continue
        if (!best || score > best.score) best = { tcin: m[2], slug, score }
      }
      if (!best) return null
      return {
        retailer: 'target',
        kind: 'searched',
        url: `https://www.target.com/p/-/A-${best.tcin}`,
        title: best.slug
      }
    },
    check: async (url) => {
      const r = await getRendered(url, 3_000)
      if (!r.ok) return { price: null, status: 'unknown', error: `HTTP ${r.status}` }
      const preorder = /pre-?order/i.exec(r.body)?.[0]
      // "Notify me when available" (data-test="notifyMe") is NOT a restock
      // signal: it is Target's standard button on every sold-out product,
      // verified 2026-09-12 on the Fallout Mutant Menace page. Only explicit
      // backorder wording claims more stock is coming.
      const backorder = /\bbackorder(?:ed)?\b/i.exec(r.body)?.[0]
      const oos = /out of stock|sold out|Currently unavailable/i.exec(r.body)?.[0]
      // A sold-out Target page shows no price of its own. The loose fallback
      // then grabbed a number from some other tile ($249.99 against a $59.99
      // deck), so it is only trusted while the product is actually buyable.
      const price =
        /data-test="product-price"[^>]*>\s*\$?([\d,.]+)/.exec(r.body)?.[1] ??
        (oos ? undefined : /price[^$]{0,120}\$([\d,]+\.\d{2})/i.exec(r.body)?.[1])
      const n = price ? Number(String(price).replace(/,/g, '')) : null
      const buyable = /add to cart/i.test(r.body)
      return {
        price: n != null && isFinite(n) ? n : null,
        status: backorder
          ? 'sold_out_restocking'
          : oos
            ? 'out_of_stock'
            : preorder
              ? 'preorder'
              : buyable || n != null
                ? 'in_stock'
                : 'unknown',
        rawState: backorder ?? oos ?? preorder ?? (buyable ? 'add to cart' : null)
      }
    }
  },
  {
    id: 'cardmarket',
    label: 'Cardmarket (EU)',
    derive: (ref) => ref.purchaseUris?.cardmarket ?? null,
    searchUrl: (ref) => `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${enc(ref.name)}`
  },
  {
    id: 'bestbuy',
    label: 'Best Buy',
    gapMs: 1_200,
    searchUrl: (ref) => `https://www.bestbuy.com/site/searchpage.jsp?st=${enc(ref.name)}`,
    // NOTE: Best Buy PRODUCT pages cannot be loaded at all — Chromium fails
    // them with ERR_HTTP2_PROTOCOL_ERROR and plain fetch throws outright, and
    // searching a bare SKU just redirects to that same broken page. Everything
    // therefore comes from the NAME search, whose Apollo payload already
    // carries price and buttonState for every result.
    discover: async (ref) => {
      const entry = await bestBuyLookup(ref.name)
      if (!entry) return null
      return {
        retailer: 'bestbuy',
        kind: 'searched',
        url: entry.url,
        title: entry.title,
        state: bestBuyState(entry)
      }
    },
    check: async (url) => {
      // Recover the product name from the URL slug and re-run the name search,
      // then pick out this exact SKU.
      const sku = /\/sku\/(\d{6,9})/.exec(url)?.[1] ?? null
      const slug = /\/product\/([^/]+)/.exec(url)?.[1] ?? null
      if (!slug) return { price: null, status: 'unknown', error: 'unrecognised Best Buy URL' }
      const query = decodeURIComponent(slug).replace(/-/g, ' ')
      // Prefer the exact SKU, but Best Buy search doesn't always surface it
      // (results are paginated and it may rank a sibling higher). The slug is
      // the product name, so the best title match against it is a sound
      // fallback rather than giving up.
      const entry = (await bestBuyLookup(query, sku)) ?? (await bestBuyLookup(query))
      if (!entry) {
        return { price: null, status: 'unknown', error: 'Best Buy search did not return this product' }
      }
      return bestBuyState(entry)
    }
  },
  {
    id: 'amazon',
    label: 'Amazon',
    gapMs: AMAZON_GAP_MS,
    searchUrl: (ref) => `https://www.amazon.com/s?k=${enc(`magic the gathering ${ref.name}`)}`,
    discover: async (ref) => {
      const r = await getAmazon(`https://www.amazon.com/s?k=${enc(`magic the gathering ${ref.name}`)}`)
      if (!r.ok) return null
      const best = bestAmazonMatch(r.body, ref.name)
      if (!best) return null
      return { retailer: 'amazon', kind: 'searched', url: `https://www.amazon.com/dp/${best.asin}`, title: best.title }
    },
    check: async (url) => {
      const r = await getAmazon(url)
      if (!r.ok) {
        return { price: null, status: 'unknown', error: r.status === 429 ? 'Amazon bot check' : `HTTP ${r.status}` }
      }
      const b = r.body
      const title = /id="productTitle"[^>]*>([\s\S]{5,300}?)<\/span>/.exec(b)?.[1]?.replace(/\s+/g, ' ').trim() ?? null

      // ONLY trust a buy-box price. An Amazon product page carries dozens of
      // `a-price-whole` spans belonging to OTHER products — sponsored tiles,
      // "similar items", "customers also viewed" — so grabbing the first one
      // reports a completely unrelated number. Observed live: the Hobbit
      // 1-pack page has no buy box at all and its first a-price-whole is $69,
      // from a carousel, while the real offers start in the $80s.
      const raw =
        /desktop_buybox_group_1":\[\{"displayPrice":"\$([\d,.]+)"/.exec(b)?.[1] ??
        /id="corePrice_feature_div"[\s\S]{0,2000}?"priceAmount":\s*([\d.]+)/.exec(b)?.[1] ??
        /id="corePrice_feature_div"[\s\S]{0,2000}?class="a-price-whole">([\d,]+)/.exec(b)?.[1] ??
        /id="apex_desktop"[\s\S]{0,3000}?"priceAmount":\s*([\d.]+)/.exec(b)?.[1] ??
        null
      const n = raw == null ? null : Number(String(raw).replace(/,/g, ''))
      const price = n != null && isFinite(n) && n > 0 ? n : null

      const preorder = /will be released on/i.exec(b)?.[0]
      // Amazon separates these in its own words: "Temporarily out of stock"
      // comes with an order-now-ship-later offer, i.e. more is coming;
      // "Currently unavailable" makes no such claim.
      const restocking = /Temporarily out of stock/i.exec(b)?.[0]
      const gone = /Currently unavailable/i.exec(b)?.[0]
      const oos = restocking ?? gone
      if (price == null && !oos && !preorder) {
        // A page with no buy box usually means Amazon itself isn't selling it
        // and only third-party offers exist. Reporting nothing beats reporting
        // a number scraped off an unrelated tile.
        return {
          price: null,
          title,
          status: 'unknown',
          rawState: 'no buy box',
          error: 'no Amazon buy-box offer — third-party sellers only, open the link for real prices'
        }
      }
      return {
        price,
        title,
        status: restocking ? 'sold_out_restocking' : gone ? 'out_of_stock' : preorder ? 'preorder' : 'in_stock',
        rawState: oos ?? preorder ?? 'buy box'
      }
    }
  },
  {
    id: 'ebay',
    label: 'eBay (sold)',
    // Sold comps are the only honest read on what sealed actually trades for,
    // but eBay cannot be read automatically: plain fetch 403s in every shape
    // (desktop, mobile, referer, legacy RSS) AND a real Chromium render returns
    // the same ~1.8KB block page, so this is an IP-level block, not a
    // fingerprint one. Automating it needs eBay Browse API OAuth credentials.
    searchUrl: (ref) => `https://www.ebay.com/sch/i.html?_nkw=${enc(ref.name)}&LH_Sold=1&LH_Complete=1`
  }
]

export const RETAILER_LABELS: Record<string, string> = Object.fromEntries(RETAILERS.map((r) => [r.id, r.label]))

// ---------------------------------------------------------------- discovery

export interface DiscoverResult {
  found: number
  productLinks: number
  needsManualLink: boolean
  note: string
}

/** Build a ProductRef from a watchlist row, filling in ids we already hold. */
function refFromWatch(w: db.MtgWatch): ProductRef {
  return {
    kind: w.kind === 'sealed' ? 'sealed' : 'card',
    name: w.name,
    setCode: w.set_code,
    scryfallId: w.ext_source === 'scryfall' ? w.ext_id : null,
    tcgplayerProductId: w.ext_source === 'tcgplayer' ? w.ext_id : null,
    finish: w.variant
  }
}

/**
 * Find buy links for one watchlist entry.
 *
 * Order matters: exact id-derived links first, then a real discovery attempt
 * per retailer, and only then a plain search link. Every retailer ends up with
 * SOMETHING clickable, but `kind` records how much that link is worth.
 */
export async function discoverForWatch(watchId: string): Promise<DiscoverResult> {
  const w = db.getMtgWatch(watchId)
  if (!w) return { found: 0, productLinks: 0, needsManualLink: true, note: `No watchlist entry ${watchId}.` }
  const ref = refFromWatch(w)

  // A sealed row knows its TCGplayer id directly; a card row can borrow one
  // from the sealed catalogue if it happens to be a product rather than a card.
  if (!ref.tcgplayerProductId && w.ext_source === 'tcgplayer' && w.ext_id) ref.tcgplayerProductId = w.ext_id
  if (ref.scryfallId) {
    ref.purchaseUris = await scryfallPurchaseUris(ref.scryfallId)
    await sleep(GAP_MS)
  }

  let productLinks = 0
  let found = 0

  for (const r of RETAILERS) {
    let hit: Found | null = null

    const exact = r.derive?.(ref) ?? null
    if (exact) {
      hit = { retailer: r.id, kind: 'product', url: exact }
    } else if (r.discover) {
      try {
        hit = await r.discover(ref)
      } catch {
        hit = null // discovery is best-effort; the search link still lands below
      }
      await sleep(r.gapMs ?? GAP_MS)
    }
    if (!hit) hit = { retailer: r.id, kind: 'search', url: r.searchUrl(ref) }

    // Price/stock only where the retailer actually exposes it.
    let state: ListingState = hit.state ?? { price: null, status: 'unknown' }
    if (!hit.state && hit.kind !== 'search' && r.check) {
      try {
        state = await r.check(hit.url, ref.finish)
      } catch (err) {
        state = { price: null, status: 'unknown', error: err instanceof Error ? err.message : String(err) }
      }
      await sleep(r.gapMs ?? GAP_MS)
    }

    db.upsertMtgListing({
      watch_id: w.id,
      retailer: hit.retailer,
      kind: hit.kind,
      title: hit.title ?? state.title ?? null,
      url: hit.url,
      price: state.price,
      status: state.status,
      raw_state: state.rawState ?? null,
      last_checked_at: hit.kind === 'search' ? null : Date.now(),
      last_error: state.error ?? null
    })
    found++
    if (hit.kind !== 'search') productLinks++
  }

  // Name matching can still land on the wrong SKU when a retailer's markup
  // hides the product name (Target exposes neither og:title nor an h1 we can
  // read, only the URL slug). The exact id-derived listing gives a reference
  // price, so a searched listing that disagrees wildly is flagged rather than
  // presented as fact — a $79.99 "Play Booster Box" next to a $193 one is
  // almost certainly a different product.
  const listings = db.listMtgListings({ watchId: w.id })
  const reference = listings.find((l) => l.kind === 'product' && l.price != null)?.price ?? null
  let suspect = 0
  if (reference != null) {
    for (const l of listings) {
      if (l.kind !== 'searched' || l.price == null) continue
      const ratio = l.price / reference
      if (ratio < 0.5 || ratio > 2) {
        suspect++
        db.updateMtgListing(l.id, {
          last_error: `price is ${ratio.toFixed(1)}× the ${reference.toFixed(2)} reference — likely a different product, verify before trusting`
        })
      }
    }
  }

  const needsManualLink = productLinks === 0
  const suspectNote = suspect ? ` ${suspect} matched listing(s) flagged as price-implausible.` : ''
  const note = needsManualLink
    ? `No retailer resolved an exact product page for "${w.name}" — only search links. Paste a product URL to track it properly.`
    : `${productLinks} exact product link(s) of ${found} retailer(s) for "${w.name}".${suspectNote}`
  return { found, productLinks, needsManualLink, note }
}

// ---------------------------------------------------------------- preorder scan

export interface PreorderProduct {
  uuid: string
  name: string
  setCode: string
  setName: string
  releasedAt: string | null
  /** For the product photo; MTGJSON leaves it null for a few catalogue rows. */
  tcgplayerProductId: string | null
  listings: db.MtgListing[]
}

export interface PreorderScanResult {
  sets: number
  products: number
  checked: number
  found: number
  errors: string[]
}

/**
 * Which sealed products are worth scanning for preorders.
 *
 * Cases and master cases are distributor stock that big-box retailers never
 * list, and scanning them just burns requests, so the sweep sticks to the
 * forms a consumer can actually preorder.
 */
const PREORDER_FORMS: ProductForm[] = ['box', 'pack', 'bundle', 'deck']
// Cardmarket and eBay never carry preorders, so they're excluded from the sweep.
const PREORDER_RETAILERS = new Set(['target', 'bestbuy', 'amazon', 'tcgplayer'])
// Every check is a rendered page load. An unbounded sweep ran past ten minutes,
// so it's capped at chase products and a total budget per run.
//
// COLLECTOR-GRADE ONLY. A general release calendar isn't worth checking: a Play
// Booster box or a plain Commander deck sits on a shelf for months and never
// sells out, so knowing its preorder date buys nothing. What's worth watching
// ahead of time is limited-run stock — Collector Boosters in any form,
// Collector Commander decks, and anything the product name flags as signature,
// serialized or limited. Everything else is invisible to the sweep by design.
const CHASE_RE =
  /collector\s+(?:booster|commander|edition)|collector's\s+(?:booster|edition)|\bsignature\b|\bserialized\b|\blimited\s+edition\b|\bgalaxy\s*foil\b/i
/** Lines that carry no collector premium even when the word appears nearby. */
const CHASE_EXCLUDE_RE = /\bplay\s+booster|\bdraft\s+booster|\bjumpstart\b|\bstarter\b|\bwelcome\b/i
const MAX_PRODUCTS_PER_SET = 3
const MAX_CHECKS = 40

/** True when a sealed product is the kind of limited-run thing worth watching. */
export function isChaseProduct(name: string): boolean {
  return CHASE_RE.test(name) && !CHASE_EXCLUDE_RE.test(name)
}

function preorderCandidates(setCode: string): db.MtgSealed[] {
  const chase = db
    .listSealedForSet(setCode)
    .filter((p) => !/\bcase\b/i.test(p.name) && PREORDER_FORMS.includes(productForm(p.name)))
    .filter((p) => isChaseProduct(p.name))
  // Boxes before packs — the box is the thing that actually sells out.
  chase.sort((a, b) => Number(productForm(b.name) === 'box') - Number(productForm(a.name) === 'box'))
  return chase.slice(0, MAX_PRODUCTS_PER_SET)
}

/**
 * Sweep upcoming sets for preorder availability across retailers.
 *
 * Deliberately on-demand rather than scheduled: it's dozens of rendered page
 * loads, and preorder windows open on WotC's calendar, not minute to minute.
 */
export async function scanPreorders(
  aheadDays = 180,
  onProgress?: (msg: string) => void
): Promise<PreorderScanResult> {
  const out: PreorderScanResult = { sets: 0, products: 0, checked: 0, found: 0, errors: [] }
  const now = Date.now()
  const horizon = now + aheadDays * 86_400_000

  const upcoming = db.listMtgSets().filter((s) => {
    if (!s.released_at || s.digital) return false
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.released_at)
    if (!m) return false
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
    return t >= now - 86_400_000 && t <= horizon
  })

  for (const set of upcoming) {
    out.sets++
    // Catalogue syncing lives in mtg.ts; importing it here would be circular,
    // so the caller primes it and anything unsynced is skipped with a note.
    if (!db.mtgSealedSetSynced(set.code)) {
      out.errors.push(`${set.code.toUpperCase()}: sealed catalogue not synced yet`)
      continue
    }
    const products = preorderCandidates(set.code)
    for (const p of products) {
      out.products++
      onProgress?.(`${set.name} — ${p.name}`)
      const ref: ProductRef = {
        kind: 'sealed',
        name: p.name,
        setCode: set.code,
        tcgplayerProductId: p.tcgplayer_product_id
      }
      for (const r of RETAILERS) {
        // Only retailers that carry preorders AND can report availability.
        if (!PREORDER_RETAILERS.has(r.id)) continue
        if (!r.discover && !r.derive) continue
        if (out.checked >= MAX_CHECKS) {
          out.errors.push(`stopped at the ${MAX_CHECKS}-check budget — run again to continue`)
          return out
        }
        let hit: Found | null = null
        try {
          hit = r.derive?.(ref) ? { retailer: r.id, kind: 'product', url: r.derive(ref)! } : await r.discover?.(ref) ?? null
        } catch {
          hit = null
        }
        out.checked++
        if (!hit) continue
        let state: ListingState = hit.state ?? { price: null, status: 'unknown' }
        if (!hit.state && r.check) {
          try {
            state = await r.check(hit.url, ref.finish)
          } catch {
            state = { price: null, status: 'unknown' }
          }
        }
        db.upsertMtgListing({
          sealed_uuid: p.uuid,
          retailer: hit.retailer,
          kind: hit.kind,
          title: hit.title ?? state.title ?? p.name,
          url: hit.url,
          price: state.price,
          status: state.status,
          raw_state: state.rawState ?? null,
          last_checked_at: Date.now(),
          last_error: state.error ?? null
        })
        out.found++
        await sleep(r.gapMs ?? GAP_MS)
      }
    }
  }
  return out
}

/** Upcoming sets with their sealed products and whatever listings we've found. */
export function preorderBoard(aheadDays = 180): Array<{ setCode: string; setName: string; releasedAt: string | null; products: PreorderProduct[] }> {
  const now = Date.now()
  const horizon = now + aheadDays * 86_400_000
  const out: Array<{ setCode: string; setName: string; releasedAt: string | null; products: PreorderProduct[] }> = []

  for (const set of db.listMtgSets()) {
    if (!set.released_at || set.digital) continue
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(set.released_at)
    if (!m) continue
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
    if (t < now - 86_400_000 || t > horizon) continue

    const products = preorderCandidates(set.code)
      .map((p) => ({
        uuid: p.uuid,
        name: p.name,
        setCode: set.code,
        setName: set.name,
        releasedAt: set.released_at,
        tcgplayerProductId: p.tcgplayer_product_id ?? null,
        listings: db.listMtgListings({ sealedUuid: p.uuid })
      }))
      .filter((p) => p.listings.length > 0)
    if (products.length) out.push({ setCode: set.code, setName: set.name, releasedAt: set.released_at, products })
  }
  return out.sort((a, b) => (a.releasedAt ?? '').localeCompare(b.releasedAt ?? ''))
}

/** Attach a product URL the user resolved themselves. */
export async function addManualListing(watchId: string, url: string, retailer?: string): Promise<db.MtgListing> {
  const w = db.getMtgWatch(watchId)
  if (!w) throw new Error(`No watchlist entry ${watchId}`)
  let host = retailer
  try {
    host = retailer ?? new URL(url).hostname.replace(/^www\./, '')
  } catch {
    throw new Error(`"${url}" is not a valid URL.`)
  }
  // A pasted TCGplayer link still carries a usable product id.
  const known = RETAILERS.find((r) => url.includes(`${r.id}.com`))
  let state: ListingState = { price: null, status: 'unknown' }
  if (known?.check) {
    try { state = await known.check(url, w.variant) } catch { /* leave unknown */ }
  }
  return db.upsertMtgListing({
    watch_id: w.id,
    retailer: known?.id ?? host ?? 'manual',
    kind: 'manual',
    url,
    price: state.price,
    status: state.status,
    raw_state: state.rawState ?? null,
    last_checked_at: Date.now(),
    last_error: state.error ?? null
  })
}

// ---------------------------------------------------------------- refresh

// ---------------------------------------------------------------- deals

/**
 * Retailers that sell at list. This is the whole trick behind deal-spotting:
 * we never need to know a product's MSRP, because a big-box retailer's price
 * IS list — so "Target has it at $54.99 while TCGplayer's market is $214.72"
 * says everything a stated MSRP would, and stays true when MSRP is unpublished
 * or the market has drifted far above it.
 *
 * TCGplayer, Card Kingdom, Cardmarket and eBay are excluded because they ARE
 * the secondary market — comparing them against it is circular.
 */
const BIG_BOX = new Set(['target', 'bestbuy', 'amazon'])

const DEAL_KEY = 'mtg_deal_discount'
const DEFAULT_DISCOUNT = 0.4

export function dealThreshold(): number {
  const raw = Number(db.getSetting(DEAL_KEY))
  return isFinite(raw) && raw > 0 && raw < 1 ? raw : DEFAULT_DISCOUNT
}
export function setDealThreshold(v: number): number {
  const clamped = Math.min(0.95, Math.max(0.05, v))
  db.setSetting(DEAL_KEY, String(clamped))
  return clamped
}

export interface RetailDeal {
  listingId: string
  watchId: string
  name: string
  setCode: string | null
  retailer: string
  url: string
  price: number
  /** Secondary-market price the discount is measured against. */
  market: number
  /** 0..1 — how far under market the retail price sits. */
  discount: number
  status: string
  /**
   * `preorder` is a product that hasn't come out yet, `restock` is one already
   * on the market reappearing at list. They're the same test but a different
   * decision, so they're reported separately.
   */
  kind: 'preorder' | 'restock'
  /** Where the price sits against MSRP, when the watch has one. */
  band: lifecycle.MsrpBand | null
  /** (price / msrp − 1) × 100, when the watch has an MSRP. */
  overMsrpPct: number | null
  msrp: number | null
  checkedAt: number | null
  alertedAt: number | null
  /** The watch row's price handle + stored image, so the panel can show a thumbnail. */
  extSource: string
  extId: string | null
  imageUrl: string | null
}

/**
 * Hunt-mode watchlist products a big-box retailer can sell you right now at a
 * price worth acting on.
 *
 * With an MSRP on the watch, "worth acting on" is the MSRP ladder: below list,
 * at list, or a little over list while still well under market (see
 * lifecycle.msrpBand). Without one, it falls back to the original test of
 * sitting `minDiscount` under market.
 *
 * Hunt-only because Market rows are not swept, so their listings are stale and
 * would report availability that ended weeks ago. Orderable-only because
 * in_store_only means "go look in a store", and a drive to browse is not a buy.
 */
export function deals(minDiscount = dealThreshold()): RetailDeal[] {
  const out: RetailDeal[] = []
  const cfg = lifecycle.settings()
  for (const w of db.listMtgWatchlist()) {
    const market = w.last_price
    if (market == null || market <= 0) continue
    if (lifecycle.classifyMode(w).mode !== 'hunt') continue
    for (const l of db.listMtgListings({ watchId: w.id })) {
      if (!BIG_BOX.has(l.retailer)) continue
      if (l.price == null || l.price <= 0) continue
      if (l.status !== 'in_stock' && l.status !== 'preorder') continue
      const discount = 1 - l.price / market
      const band = lifecycle.msrpBand(l.price, w.msrp, market, cfg)
      if (band ? !lifecycle.BUY_BANDS.has(band.band) : discount < minDiscount) continue
      out.push({
        listingId: l.id,
        watchId: w.id,
        name: w.name,
        setCode: w.set_code,
        retailer: l.retailer,
        url: l.url,
        price: l.price,
        market,
        discount: Math.round(discount * 1000) / 10,
        status: l.status,
        kind: l.status === 'preorder' ? 'preorder' : 'restock',
        band: band?.band ?? null,
        overMsrpPct: band?.overPct ?? null,
        msrp: w.msrp,
        checkedAt: l.last_checked_at,
        alertedAt: l.deal_alert_at ?? null,
        extSource: w.ext_source,
        extId: w.ext_id,
        imageUrl: w.image_url
      })
    }
  }
  return out.sort((a, b) => b.discount - a.discount)
}

export interface StockTransition {
  name: string
  retailer: string
  from: string
  to: string
  /** Verbatim retailer wording behind `to` — Best Buy's buttonState and the like. */
  rawState: string | null
  price: number | null
  url: string
  listingId: string
  /** Only set when the owning watch has its bell on. */
  watchId: string | null
}

export interface StockRefreshResult {
  checked: number
  changed: number
  errors: string[]
  skipped: number
  transitions: StockTransition[]
}

/**
 * Read a status in light of the one before it.
 *
 * Best Buy shows COMING_SOON both for a product that has never been orderable
 * and for one that sold out and is due back. One reading can't tell those
 * apart; the previous status can. After a sell-out it's a restock signal.
 */
function withHistory(prev: string, state: ListingState): ListingState {
  if (state.status === 'listed' && (prev === 'out_of_stock' || prev === 'sold_out_restocking')) {
    return { ...state, status: 'sold_out_restocking' }
  }
  return state
}

/**
 * Re-check every resolved listing. Plain `search` rows are skipped — there is
 * nothing to read from a results page, and hammering them buys nothing.
 *
 * `watchedOnly` is what the background scheduler passes: a listing is only
 * worth a periodic HTTP round trip if something is actually listening to it,
 * i.e. it hangs off a watchlist row with alerts ON. Preorder-board rows
 * (sealed_uuid, no watch) and muted watches are checked on demand instead —
 * otherwise every set the preorder scan ever touched keeps generating stock
 * notifications the user never asked for.
 */
export async function refreshListings(opts: { watchedOnly?: boolean } = {}): Promise<StockRefreshResult> {
  const out: StockRefreshResult = { checked: 0, changed: 0, errors: [], skipped: 0, transitions: [] }
  for (const l of db.listMtgListings()) {
    if (l.kind === 'search') continue
    if (opts.watchedOnly) {
      const owner = l.watch_id ? db.getMtgWatch(l.watch_id) : undefined
      if (!owner?.alert_enabled) {
        out.skipped++
        continue
      }
      // Market-mode rows are out of print: no shelf to check, so no fetch.
      // A manual refresh still reads them, which is how a reprint gets seen.
      if (lifecycle.classifyMode(owner).mode === 'market') {
        out.skipped++
        continue
      }
    }
    const r = RETAILERS.find((x) => x.id === l.retailer)
    if (!r?.check) continue
    let state: ListingState
    try {
      // The finish comes from the row that owns the listing; a listing hanging
      // off a catalogue product (preorder board) is sealed by definition.
      const owner = l.watch_id ? db.getMtgWatch(l.watch_id) : undefined
      state = withHistory(l.status, await r.check(l.url, owner?.variant ?? 'sealed'))
    } catch (err) {
      out.errors.push(`${l.retailer}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    out.checked++
    // An unreadable page is not a status change. Recording it as one used to
    // make the NEXT good read look like a restock ("unknown → in_stock").
    if (state.status === 'unknown' && l.status !== 'unknown') {
      db.updateMtgListing(l.id, { last_checked_at: Date.now(), last_error: state.error ?? 'unreadable' })
      await sleep(r.gapMs ?? GAP_MS)
      continue
    }
    if (state.status !== l.status) {
      out.changed++
      const w = l.watch_id ? db.getMtgWatch(l.watch_id) : undefined
      out.transitions.push({
        name: w?.name ?? l.title ?? l.url,
        retailer: l.retailer,
        from: l.status,
        to: state.status,
        rawState: state.rawState ?? null,
        price: state.price,
        url: l.url,
        listingId: l.id,
        // Carried so the notifier can honour the row's bell without re-reading it.
        watchId: w?.alert_enabled ? l.watch_id : null
      })
    }
    db.updateMtgListing(l.id, {
      price: state.price,
      status: state.status,
      raw_state: state.rawState ?? null,
      last_checked_at: Date.now(),
      last_error: state.error ?? null
    })
    if (l.watch_id && l.kind !== 'searched') lifecycle.noteFirstPartyPrice(l.watch_id, l.retailer, state.price)
    await sleep(r.gapMs ?? GAP_MS)
  }
  return out
}
