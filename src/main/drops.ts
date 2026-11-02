/**
 * Drop watching — "tell me the moment this thing is buyable".
 *
 * WHY SHOPIFY GETS ITS OWN ADAPTER: an enormous share of artist, streetwear
 * and nostalgia-revival drops run on Shopify, and every Shopify storefront
 * publishes its whole catalogue at /products.json — keyless, unauthenticated,
 * and carrying a per-variant `available` boolean that flips the instant stock
 * is loaded. That is a far better signal than scraping a product page, which
 * is client-rendered, A/B tested, and rate-limited. One JSON read answers
 * "is it buyable" for the entire store at once.
 *
 * WHAT IS ACTUALLY WATCHED, and why it is not just "did it restock":
 *   restock       a product flipped unavailable -> available
 *   new_product   a handle appeared that was not there before
 *   removed       a handle disappeared (often unpublished ahead of a relaunch)
 *   price_change  the asking price moved
 *   sold_out      available -> unavailable, recorded but deliberately quiet
 * A drop very often arrives as a NEW product rather than a restock of an
 * existing one, so watching only the availability bit would miss it entirely.
 *
 * ON updated_at: Shopify sends one, and it is NOT a usable trigger. Probed
 * against munko.com on 2026-09-07, all eleven products carried the same
 * updated_at as that morning — bulk edits and inventory apps touch it
 * constantly. `available` is the only field that means what it says.
 *
 * THIS MODULE ONLY READS. It never adds to a cart, never authenticates and
 * never checks out. Shopify's own robots.txt asks that agents leave checkout
 * to humans, and that is respected here — the job is to tell you a thing is
 * on sale, not to buy it for you.
 */
import { BrowserWindow } from 'electron'
import * as db from './db'
import * as alerts from './alerts'

const UA = 'ATLIS/1.0 (personal drop tracker)'
const FETCH_TIMEOUT_MS = 15_000
/** Gap between watches inside one sweep, so a sweep is never a burst. */
const GAP_MS = 350

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- http

interface Fetched {
  status: number
  body: string
  etag: string | null
}

/** fetch with a timeout and an optional conditional request. */
async function get(url: string, etag?: string | null, accept = 'application/json'): Promise<Fetched> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'User-Agent': UA, Accept: accept }
    // A 304 costs the store almost nothing and costs us no parsing, which is
    // what makes a one-minute poll defensible rather than rude.
    if (etag) headers['If-None-Match'] = etag
    const res = await fetch(url, { headers, signal: ctl.signal })
    const body = res.status === 304 ? '' : await res.text()
    return { status: res.status, body, etag: res.headers.get('etag') }
  } finally {
    clearTimeout(t)
  }
}

// ---------------------------------------------------------------- shopify

interface ShopifyVariant {
  id?: number | string
  price?: string
  available?: boolean
}
interface ShopifyProduct {
  id?: number | string
  title?: string
  handle?: string
  product_type?: string | null
  published_at?: string | null
  variants?: ShopifyVariant[]
  images?: Array<{ src?: string }>
}

/** The normalized shape both adapters produce. */
export interface SeenProduct {
  extId: string
  handle: string | null
  title: string
  url: string | null
  image: string | null
  price: number | null
  available: boolean
  variantsTotal: number
  variantsAvailable: number
  /** Units on hand, when the store publishes a count (Wix does; Shopify's feed does not). */
  quantity?: number | null
  productType: string | null
  publishedAt: number | null
}

const origin = (url: string): string => url.trim().replace(/\/+$/, '')

/**
 * Read a Shopify catalogue.
 *
 * Paginates, because a big store exceeds the 250 cap and stopping at the first
 * page would silently watch only part of it. Returns null on 304 — meaning
 * "provably unchanged", which is different from "empty".
 */
async function readShopify(
  storeUrl: string,
  etag?: string | null
): Promise<{ products: SeenProduct[] | null; etag: string | null }> {
  const base = origin(storeUrl)
  const first = await get(`${base}/products.json?limit=250`, etag)
  if (first.status === 304) return { products: null, etag: etag ?? null }
  if (first.status !== 200) throw new Error(`HTTP ${first.status}`)

  const out: SeenProduct[] = []
  let page = 1
  let body = first.body
  for (;;) {
    let parsed: { products?: ShopifyProduct[] }
    try {
      parsed = JSON.parse(body) as { products?: ShopifyProduct[] }
    } catch {
      throw new Error('Response was not JSON — is this a Shopify store?')
    }
    const batch = Array.isArray(parsed.products) ? parsed.products : []
    for (const p of batch) {
      const norm = normalizeShopify(base, p)
      if (norm) out.push(norm)
    }
    // A short page is the last page. Cap at 10 pages (2,500 products) so a
    // pathological store cannot turn one poll into an unbounded crawl.
    if (batch.length < 250 || page >= 10) break
    page++
    await sleep(GAP_MS)
    const next = await get(`${base}/products.json?limit=250&page=${page}`)
    if (next.status !== 200) break
    body = next.body
  }
  return { products: out, etag: first.etag }
}

function normalizeShopify(base: string, p: ShopifyProduct): SeenProduct | null {
  if (!p.handle && p.id == null) return null
  const variants = Array.isArray(p.variants) ? p.variants : []
  const availableCount = variants.filter((v) => v.available).length
  // Cheapest variant is the headline price; that is the one a drop is judged on.
  const prices = variants.map((v) => Number(v.price)).filter((n) => Number.isFinite(n))
  const published = p.published_at ? Date.parse(p.published_at) : NaN
  return {
    extId: String(p.id ?? p.handle),
    handle: p.handle ?? null,
    title: String(p.title ?? p.handle ?? 'Untitled'),
    url: p.handle ? `${base}/products/${p.handle}` : null,
    image: p.images?.[0]?.src ?? null,
    price: prices.length ? Math.min(...prices) : null,
    available: availableCount > 0,
    variantsTotal: variants.length,
    variantsAvailable: availableCount,
    productType: p.product_type ?? null,
    publishedAt: Number.isFinite(published) ? published : null
  }
}

/**
 * Is this URL a Shopify storefront? Used when adding a watch, so the UI can
 * pick the right adapter instead of asking the user to know.
 */
export async function probeShopify(url: string): Promise<{ ok: boolean; products: number; note: string | null }> {
  try {
    const r = await get(`${origin(url)}/products.json?limit=1`)
    if (r.status !== 200) return { ok: false, products: 0, note: `The store answered HTTP ${r.status}.` }
    const parsed = JSON.parse(r.body) as { products?: unknown[] }
    if (!Array.isArray(parsed.products)) return { ok: false, products: 0, note: 'No product feed at that address.' }
    return { ok: true, products: parsed.products.length, note: null }
  } catch (err) {
    return { ok: false, products: 0, note: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------- wix

/**
 * Wix Stores — the other big storefront builder, and what magicmonday.shop
 * (PaymoneyWubby's Magic Monday box breaks) runs on.
 *
 * WHY NOT THE PAGE HTML: Wix server-renders the product grid with the whole
 * catalogue embedded, but serves that HTML from a CDN cache — probed
 * 2026-09-12 it came back with `Age: 322211`, i.e. rendered 3.7 days earlier.
 * A drop that sells out in minutes cannot be watched through that.
 *
 * WHAT IS READ INSTEAD is the catalogue endpoint the storefront's own scripts
 * use. `/_api/v1/access-tokens` hands any visitor an instance token for the
 * Stores app, and `/_api/catalog-reader-server/api/v1/products/query` answers
 * with every visible product, uncached, with `stock.inStock` and
 * `stock.quantity`. Against magicmonday.shop: 18 products, ~52KB, ~300ms.
 * (`/_api/stores-reader/v1/products/query`, the documented-looking one,
 * answers 403 to a visitor token.)
 *
 * UNDOCUMENTED, like TCGplayer's pricepoints route: a failure throws, the
 * watch records the error, and the last-known products stay as they were.
 * There is no ETag on this endpoint, so every poll is a full read — which is
 * why it is a POST of one small query, not a page render.
 */
const WIX_STORES_APP = '1380b703-ce81-ff05-f115-39571d94dfcd'
/** Visitor tokens are short-lived; re-minted well inside their life and on any auth refusal. */
const WIX_TOKEN_TTL_MS = 20 * 60_000
/** The query endpoint's page cap. */
const WIX_PAGE = 100

const wixTokens = new Map<string, { instance: string; origin: string; at: number }>()

async function wixToken(storeUrl: string, fresh = false): Promise<{ instance: string; origin: string } | null> {
  const key = origin(storeUrl)
  const cached = wixTokens.get(key)
  if (!fresh && cached && Date.now() - cached.at < WIX_TOKEN_TTL_MS) return cached

  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${key}/_api/v1/access-tokens`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctl.signal
    })
    if (res.status !== 200) return null
    const body = (await res.json()) as { apps?: Record<string, { instance?: string }> }
    const instance = body.apps?.[WIX_STORES_APP]?.instance
    if (!instance) return null
    // The bare domain redirects to www; POSTing to the pre-redirect host would
    // be answered with a redirect a POST cannot follow, so pin the final one.
    const entry = { instance, origin: new URL(res.url).origin, at: Date.now() }
    wixTokens.set(key, entry)
    return entry
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

interface WixProduct {
  id?: string
  name?: string
  slug?: string
  visible?: boolean
  productType?: string
  stock?: { trackInventory?: boolean; quantity?: number | null; inStock?: boolean; inventoryStatus?: string }
  priceData?: { price?: number; discountedPrice?: number }
  media?: { mainMedia?: { id?: string; image?: { url?: string } } }
  productPageUrl?: { path?: string }
  manageVariants?: boolean
  variants?: Array<{ stock?: { inStock?: boolean } }>
  createdDate?: string
}

async function queryWix(tok: { instance: string; origin: string }, offset: number): Promise<{ status: number; products: WixProduct[]; total: number | null }> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${tok.origin}/_api/catalog-reader-server/api/v1/products/query`, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json', Authorization: tok.instance },
      body: JSON.stringify({ query: { paging: { limit: WIX_PAGE, offset } } }),
      signal: ctl.signal
    })
    if (res.status !== 200) return { status: res.status, products: [], total: null }
    const body = (await res.json()) as { products?: WixProduct[]; totalResults?: number }
    return {
      status: 200,
      products: Array.isArray(body.products) ? body.products : [],
      total: typeof body.totalResults === 'number' ? body.totalResults : null
    }
  } finally {
    clearTimeout(t)
  }
}

function normalizeWix(base: string, p: WixProduct): SeenProduct | null {
  if (!p.id) return null
  const stock = p.stock ?? {}
  // A hidden product is staged, not for sale. If the endpoint ever returns
  // one, it must not read as available — its going visible IS the drop.
  const inStock = p.visible !== false && (stock.inStock === true || /^(IN_STOCK|PARTIALLY_OUT_OF_STOCK)$/.test(stock.inventoryStatus ?? ''))
  const variants = p.manageVariants && Array.isArray(p.variants) ? p.variants : []
  const price = p.priceData?.discountedPrice ?? p.priceData?.price
  const mediaId = p.media?.mainMedia?.id
  const published = p.createdDate ? Date.parse(p.createdDate) : NaN
  const path = p.productPageUrl?.path ?? (p.slug ? `/product-page/${p.slug}` : null)
  return {
    extId: p.id,
    handle: p.slug ?? null,
    title: String(p.name ?? p.slug ?? 'Untitled'),
    url: path ? `${base}${path.startsWith('/') ? '' : '/'}${path}` : null,
    // The media id alone serves the original image; the API's own URL is a
    // resize template that is not a usable address without parameters.
    image: mediaId ? `https://static.wixstatic.com/media/${mediaId}` : (p.media?.mainMedia?.image?.url ?? null),
    price: typeof price === 'number' && Number.isFinite(price) ? price : null,
    available: inStock,
    variantsTotal: variants.length || 1,
    variantsAvailable: variants.length ? variants.filter((v) => v.stock?.inStock).length : inStock ? 1 : 0,
    quantity: stock.trackInventory && typeof stock.quantity === 'number' ? stock.quantity : null,
    productType: p.productType ?? null,
    publishedAt: Number.isFinite(published) ? published : null
  }
}

/** Read a Wix Stores catalogue. Paginated and capped like readShopify. */
async function readWix(storeUrl: string): Promise<{ products: SeenProduct[]; etag: string | null }> {
  let tok = await wixToken(storeUrl)
  if (!tok) throw new Error('No Wix Stores catalogue at that address.')
  const out: SeenProduct[] = []
  for (let page = 0; page < 10; page++) {
    const offset = page * WIX_PAGE
    let r = await queryWix(tok, offset)
    if (r.status === 401 || r.status === 403) {
      // Expired or revoked visitor token: mint one and retry once.
      tok = await wixToken(storeUrl, true)
      if (!tok) throw new Error('Wix refused a fresh visitor token.')
      r = await queryWix(tok, offset)
    }
    if (r.status !== 200) throw new Error(`Wix catalogue: HTTP ${r.status}`)
    for (const p of r.products) {
      const norm = normalizeWix(tok.origin, p)
      if (norm) out.push(norm)
    }
    if (r.products.length < WIX_PAGE) break
    await sleep(GAP_MS)
  }
  return { products: out, etag: null }
}

/** Is this URL a Wix Stores storefront? */
export async function probeWix(url: string): Promise<{ ok: boolean; products: number; note: string | null }> {
  try {
    const tok = await wixToken(url, true)
    if (!tok) return { ok: false, products: 0, note: 'Not a Wix Stores site.' }
    const r = await queryWix(tok, 0)
    if (r.status !== 200) return { ok: false, products: 0, note: `The Wix catalogue answered HTTP ${r.status}.` }
    return { ok: true, products: r.total ?? r.products.length, note: null }
  } catch (err) {
    return { ok: false, products: 0, note: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------- page watch

/**
 * Fallback for a store that is not Shopify: hash the page and report that it
 * changed. Deliberately crude — it cannot say WHAT changed, only that
 * something did, which is still enough to make you go look.
 *
 * Scripts, styles and anything that looks like a cache-busting token are
 * stripped first, because otherwise every single poll differs and the watch
 * becomes a noise generator.
 */
async function readPage(pageUrl: string, etag?: string | null): Promise<{ products: SeenProduct[] | null; etag: string | null }> {
  const r = await get(pageUrl, etag, 'text/html')
  if (r.status === 304) return { products: null, etag: etag ?? null }
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
  const stripped = r.body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\b[0-9a-f]{16,}\b/gi, '')
    .replace(/\d{10,}/g, '')
    .replace(/\s+/g, ' ')
  let hash = 0
  for (let i = 0; i < stripped.length; i++) hash = (Math.imul(31, hash) + stripped.charCodeAt(i)) | 0
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.body)?.[1]?.trim() || pageUrl
  // One synthetic product whose "price" is the content hash; a change in it is
  // what the differ turns into an event.
  return {
    products: [{
      extId: 'page',
      handle: null,
      title: title.slice(0, 200),
      url: pageUrl,
      image: null,
      price: hash,
      available: false,
      variantsTotal: 0,
      variantsAvailable: 0,
      productType: 'page',
      publishedAt: null
    }],
    etag: r.etag
  }
}

// ---------------------------------------------------------------- diff

export interface DropTransition {
  watchId: string
  watchLabel: string
  kind: 'restock' | 'sold_out' | 'new_product' | 'removed' | 'price_change'
  /**
   * The product this is about, stable across polls. Carried so a sink can
   * suppress a repeat without having to guess identity from the title — two
   * different colourways share a title far more often than they share an id.
   */
  extId: string
  title: string
  detail: string | null
  url: string | null
  image: string | null
  price: number | null
}

/** A transition as the alert layer wants it. */
export function toAlert(t: DropTransition): alerts.Alert {
  return {
    kind: t.kind,
    watchId: t.watchId,
    watchLabel: t.watchLabel,
    extId: t.extId,
    title: t.title,
    detail: t.detail,
    url: t.url,
    image: t.image,
    price: t.price
  }
}

const matches = (title: string, filter: string | null): boolean =>
  !filter || title.toLowerCase().includes(filter.toLowerCase())

/**
 * Compare one poll against what is stored, write the changes, return them.
 *
 * The event rows are written here rather than by the caller so that a poll is
 * atomic from the UI's point of view: by the time a transition is returned,
 * the timeline already contains it.
 */
function diffAndRecord(watch: db.DropWatch, seen: SeenProduct[]): DropTransition[] {
  const previous = new Map(db.listDropProducts(watch.id, true).map((p) => [p.ext_id, p]))
  const transitions: DropTransition[] = []
  const kept: string[] = []

  for (const s of seen) {
    if (!matches(s.title, watch.title_match)) continue
    kept.push(s.extId)
    const id = `${watch.id}:${s.extId}`
    const before = previous.get(s.extId)

    if (!before) {
      // A brand-new handle. On the very first poll of a watch this would fire
      // for the whole catalogue, which is noise, not news — the caller passes
      // `quiet` for that case and we only seed the table.
      transitions.push({
        watchId: watch.id,
        watchLabel: watch.label,
        kind: 'new_product',
        extId: s.extId,
        title: s.title,
        detail: s.available
          ? `listed and IN STOCK${s.quantity != null ? ` — ${s.quantity} available` : ''}`
          : 'listed, not yet in stock',
        url: s.url,
        image: s.image,
        price: s.price
      })
    } else {
      const wasAvailable = before.available === 1 && before.gone === 0
      if (!wasAvailable && s.available) {
        transitions.push({
          watchId: watch.id,
          watchLabel: watch.label,
          kind: 'restock',
          extId: s.extId,
          title: s.title,
          // A count beats a variant ratio when the store publishes one: "2
          // available" says how fast to move, "1/1 variants" says nothing.
          detail: s.quantity != null ? `${s.quantity} available` : `${s.variantsAvailable}/${s.variantsTotal} variants in stock`,
          url: s.url,
          image: s.image,
          price: s.price
        })
      } else if (wasAvailable && !s.available) {
        transitions.push({
          watchId: watch.id,
          watchLabel: watch.label,
          kind: 'sold_out',
          extId: s.extId,
          title: s.title,
          detail: before.last_available_at ? `was up for ${humanGap(Date.now() - before.last_available_at)}` : null,
          url: s.url,
          image: s.image,
          price: s.price
        })
      }
      if (before.price != null && s.price != null && Math.abs(before.price - s.price) > 0.005) {
        transitions.push({
          watchId: watch.id,
          watchLabel: watch.label,
          kind: 'price_change',
          extId: s.extId,
          title: s.title,
          detail: `${money(before.price)} to ${money(s.price)}`,
          url: s.url,
          image: s.image,
          price: s.price
        })
      }
    }

    db.upsertDropProduct({
      id,
      watch_id: watch.id,
      ext_id: s.extId,
      handle: s.handle,
      title: s.title,
      url: s.url,
      image: s.image,
      price: s.price,
      available: s.available,
      variants_total: s.variantsTotal,
      variants_available: s.variantsAvailable,
      product_type: s.productType,
      published_at: s.publishedAt
    })
  }

  // Anything previously live that this poll did not return has been pulled.
  for (const [extId, before] of previous) {
    if (before.gone === 1 || kept.includes(extId)) continue
    transitions.push({
      watchId: watch.id,
      watchLabel: watch.label,
      kind: 'removed',
      extId,
      title: before.title,
      detail: 'no longer listed',
      url: before.url,
      image: before.image,
      price: before.price
    })
  }
  db.markDropProductsGone(watch.id, kept)

  return transitions
}

const money = (n: number): string => `$${n.toFixed(2)}`

function humanGap(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

// ---------------------------------------------------------------- polling

export interface PollResult {
  watches: number
  changed: number
  transitions: DropTransition[]
  errors: string[]
}

/** Poll one watch. `quiet` seeds the product table without raising events. */
export async function pollWatch(watchId: string, quiet = false): Promise<DropTransition[]> {
  const watch = db.getDropWatch(watchId)
  if (!watch) return []
  try {
    const read =
      watch.kind === 'page'
        ? await readPage(watch.url, watch.etag)
        : watch.kind === 'wix'
          ? await readWix(watch.url)
          : await readShopify(watch.url, watch.etag)
    db.updateDropWatch(watch.id, { last_checked_at: Date.now(), last_error: null, etag: read.etag })
    // 304: provably unchanged, nothing to diff.
    if (read.products == null) return []

    const transitions = diffAndRecord(watch, read.products)
    db.updateDropWatch(watch.id, { last_ok_at: Date.now() })
    if (quiet) return []
    for (const t of transitions) {
      db.addDropEvent({
        watch_id: t.watchId,
        kind: t.kind,
        title: t.title,
        detail: t.detail,
        url: t.url,
        price: t.price
      })
    }
    return transitions
  } catch (err) {
    db.updateDropWatch(watch.id, {
      last_checked_at: Date.now(),
      last_error: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}

/** Poll every enabled watch, optionally only the hot ones. */
export async function pollAll(opts: { hotOnly?: boolean } = {}): Promise<PollResult> {
  const watches = db.listDropWatches().filter((w) => w.enabled === 1 && (!opts.hotOnly || w.priority === 'hot'))
  const result: PollResult = { watches: watches.length, changed: 0, transitions: [], errors: [] }
  for (const w of watches) {
    try {
      const t = await pollWatch(w.id)
      if (t.length) result.changed++
      result.transitions.push(...t)
    } catch (err) {
      result.errors.push(`${w.label}: ${err instanceof Error ? err.message : String(err)}`)
    }
    await sleep(GAP_MS)
  }
  return result
}

/**
 * Add a watch, detecting the adapter from the URL.
 * The first poll runs quiet, so adding a store does not fire a notification
 * for every product it already has.
 */
export async function addWatch(input: {
  label?: string
  url: string
  title_match?: string | null
  priority?: string
}): Promise<db.DropWatch> {
  const url = origin(input.url)
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter a full URL, including https://')
  const existing = db.findDropWatchByUrl(url)
  if (existing) throw new Error(`Already watching ${existing.label}.`)

  // Shopify first (most drop stores), then Wix; anything else falls back to
  // detecting that the page changed.
  const probe = await probeShopify(url)
  const wix = probe.ok ? null : await probeWix(url)
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  })()
  const watch = db.createDropWatch({
    label: input.label?.trim() || host,
    kind: probe.ok ? 'shopify' : wix?.ok ? 'wix' : 'page',
    url,
    title_match: input.title_match ?? null,
    priority: input.priority ?? 'normal'
  })
  try {
    await pollWatch(watch.id, true)
  } catch {
    // A watch that cannot be reached right now is still worth keeping; the
    // error is recorded on the row and the next sweep retries.
  }
  return watch
}

// ---------------------------------------------------------------- alerts

// The master switch lives with the sinks it governs; re-exported so existing
// IPC callers keep working.
export const alertsEnabled = alerts.alertsEnabled
export const setAlertsEnabled = alerts.setAlertsEnabled

// ---------------------------------------------------------------- scheduler

// A drop can sell out inside two minutes, so a 'hot' watch is polled every
// minute. That is one conditional request per store per minute — comparable to
// a person sitting on the page hitting refresh, and mostly answered with 304.
const HOT_EVERY_MS = 60_000
// Everything else rides a slower clock; most stores are not about to drop.
const NORMAL_EVERY_MS = 10 * 60_000
const STARTUP_GRACE_MS = 6_000
// Heat scoring and demand sampling are daily-cadence work: autocomplete data
// moves once a day, and sell-out behaviour is only meaningful over days.
const MAINTENANCE_EVERY_MS = 6 * 60 * 60_000

/**
 * Periodic scoring + signal sampling, injected rather than imported.
 *
 * discovery.ts imports this module for probeShopify, so importing it back
 * would be circular — the same reason ev.ts is injected into mtg.ts.
 */
type Maintenance = () => Promise<unknown> | unknown
let maintenance: Maintenance | null = null
export function setDropsMaintenance(fn: Maintenance | null): void {
  maintenance = fn
}

function dropsAppHidden(): boolean {
  try {
    return (JSON.parse(db.getSetting('disabled_apps') || '[]') as string[]).includes('drops')
  } catch {
    return false
  }
}

/** Background poller; pushes `drops:changed` after any sweep that saw movement. */
export function startDropsScheduler(win: BrowserWindow): () => void {
  let stopped = false
  let lastNormal = 0
  let lastMaintenance = 0
  let running = false

  const tick = async (): Promise<void> => {
    if (stopped || win.isDestroyed() || running) return
    if (dropsAppHidden()) return
    running = true
    try {
      const wantNormal = Date.now() - lastNormal > NORMAL_EVERY_MS
      if (wantNormal) lastNormal = Date.now()
      const r = await pollAll({ hotOnly: !wantNormal })
      if (maintenance && Date.now() - lastMaintenance > MAINTENANCE_EVERY_MS) {
        lastMaintenance = Date.now()
        // Never fatal: a failed sample or score must not stop the poller, which
        // is the part with a deadline.
        try {
          await maintenance()
        } catch {
          /* retried on the next maintenance window */
        }
      }
      if (r.transitions.length) {
        // Policy, cooldown and fan-out are the dispatcher's problem. A sink
        // that throws is reported there and never reaches here, because a dead
        // webhook must not stop the sweep that found the drop.
        await alerts.dispatch(r.transitions.map(toAlert))
        db.pruneDropEvents()
        if (!win.isDestroyed()) win.webContents.send('drops:changed', {})
      }
    } catch {
      // Network blips are expected; the next tick retries.
    } finally {
      running = false
    }
  }

  const startup = setTimeout(() => void tick(), STARTUP_GRACE_MS)
  const interval = setInterval(() => void tick(), HOT_EVERY_MS)
  interval.unref?.()
  const stop = (): void => {
    stopped = true
    clearTimeout(startup)
    clearInterval(interval)
  }
  win.on('closed', stop)
  return stop
}

// ---------------------------------------------------------------- seed

/**
 * First-run seed: the Munko store, plus the feed sources that would have given
 * advance warning of it. Runs once — a user who deletes the watch does not get
 * it silently recreated, which is why the marker is a setting rather than a
 * check for the row.
 */
const SEEDED_KEY = 'drops_seeded_v1'

export interface SeedResult {
  created: string[]
  feeds: string[]
}

/**
 * Later seeds, each with its own marker so an install that already ran the
 * first seed still gets them exactly once — and a user who removes one does
 * not get it back.
 */
const LATER_SEEDS: Array<{ key: string; label: string; url: string; priority: string }> = [
  // PaymoneyWubby's Magic Monday box breaks: a handful of packs/boxes put up
  // for a very short window, so it rides the one-minute hot clock.
  { key: 'drops_seeded_magic_monday', label: 'Magic Monday (Wubby)', url: 'https://www.magicmonday.shop', priority: 'hot' }
]

async function seedLater(out: SeedResult): Promise<void> {
  for (const s of LATER_SEEDS) {
    if (db.getSetting(s.key) === '1') continue
    if (!db.findDropWatchByUrl(s.url)) {
      try {
        const w = await addWatch({ label: s.label, url: s.url, priority: s.priority })
        out.created.push(w.label)
      } catch {
        // Offline right now: leave the marker unset so the next launch retries.
        continue
      }
    }
    db.setSetting(s.key, '1')
  }
}

export async function seedDefaults(): Promise<SeedResult> {
  const out: SeedResult = { created: [], feeds: [] }
  if (db.getSetting(SEEDED_KEY) === '1') {
    await seedLater(out)
    return out
  }

  if (!db.findDropWatchByUrl('https://munko.com')) {
    try {
      const w = await addWatch({ label: 'MUNKO', url: 'https://munko.com', priority: 'hot' })
      out.created.push(w.label)
    } catch {
      /* offline at first launch; the user can add it by hand */
    }
  }

  // The announcement side. Munko's own Shopify blog feed is the only
  // first-party channel that does not need a login, so it is the best
  // automated proxy available for announcements.
  const feeds: Array<{ kind: string; title: string; url: string; category: string }> = [
    { kind: 'rss', title: 'MUNKO — store news', url: 'https://munko.com/blogs/news.atom', category: 'drops' }
  ]
  const have = new Set(db.listFeedSources().map((s) => s.url))
  for (const f of feeds) {
    if (have.has(f.url)) continue
    try {
      db.createFeedSource(f)
      out.feeds.push(f.title)
    } catch {
      /* a bad seed feed must not block startup */
    }
  }

  db.setSetting(SEEDED_KEY, '1')
  await seedLater(out)
  return out
}
