/**
 * Coverage — finding storefronts worth watching, without anyone pasting links.
 *
 * THE DISCOVERY TRICK: every Shopify store, however custom its public domain,
 * also answers on an opaque `*.myshopify.com` backend (munko.com is really
 * 0gthhu-tv.myshopify.com, verified 2026-09-07). Common Crawl's URL index can
 * enumerate that whole namespace, so a candidate pool can be built from a
 * public dataset rather than from links a human found. The domains themselves
 * are meaningless strings — the brand is recovered afterwards from the store's
 * own product titles, which is more reliable than any domain heuristic.
 *
 * WHY A CANDIDATE POOL AND NOT A WATCHLIST: most of that namespace is dead
 * dev stores, password pages and dropshippers. Probing is cheap but polling is
 * not, so candidates sit in their own table until one earns promotion. The
 * watchlist stays small and fast; the pool can be enormous and idle.
 *
 * THE POLITENESS BUDGET is the real constraint, not the technology. One store
 * on a 15-minute clock is one request per 15 minutes, and the ETag handling in
 * drops.ts turns most of those into a bodiless 304 — so a couple of thousand
 * watched stores is roughly two requests a second, which is nothing. Discovery
 * is therefore rate-limited by choice rather than by capability, and every
 * sweep is capped.
 */
import * as db from './db'
import { probeShopify } from './drops'

const UA = 'ATLIS/1.0 (personal drop tracker)'
const FETCH_TIMEOUT_MS = 25_000
const PROBE_GAP_MS = 400

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- common crawl

interface CrawlInfo {
  id: string
  'cdx-api': string
}

/** Newest crawl index. Cached for the process; new crawls land ~monthly. */
let cachedIndex: string | null = null
async function latestIndex(): Promise<string> {
  if (cachedIndex) return cachedIndex
  const res = await fetch('https://index.commoncrawl.org/collinfo.json', { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Common Crawl index list: HTTP ${res.status}`)
  const list = (await res.json()) as CrawlInfo[]
  if (!list.length) throw new Error('Common Crawl returned no crawls.')
  cachedIndex = list[0]['cdx-api']
  return cachedIndex
}

export interface DiscoverResult {
  scanned: number
  domains: number
  added: number
  page: number
  note: string | null
}

/**
 * Pull one page of the myshopify namespace into the candidate pool.
 *
 * Paged rather than exhaustive on purpose: the namespace is millions of URLs,
 * and the useful move is to accumulate a pool over many small runs instead of
 * hammering the index once. `page` is stored so successive runs advance.
 */
const PAGE_KEY = 'drops_discovery_page'

export async function discoverShopifyStores(opts: { page?: number; limit?: number } = {}): Promise<DiscoverResult> {
  const page = opts.page ?? Number(db.getSetting(PAGE_KEY) ?? '0')
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000)
  const index = await latestIndex()

  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  let body: string
  try {
    const url = `${index}?url=*.myshopify.com%2F&output=json&limit=${limit}&page=${page}`
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal })
    if (res.status === 404) {
      return { scanned: 0, domains: 0, added: 0, page, note: 'That page of the crawl index is empty — start again from page 0.' }
    }
    if (!res.ok) throw new Error(`Common Crawl: HTTP ${res.status}`)
    body = await res.text()
  } finally {
    clearTimeout(t)
  }

  const hosts = new Set<string>()
  let scanned = 0
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    scanned++
    try {
      const row = JSON.parse(line) as { url?: string }
      if (!row.url) continue
      const host = new URL(row.url).hostname.toLowerCase()
      // Skip Shopify's own infrastructure hosts, which are not shops.
      if (!host.endsWith('.myshopify.com') || host.startsWith('checkout.')) continue
      hosts.add(host)
    } catch {
      /* a malformed index row is not worth failing the sweep over */
    }
  }

  const added = db.addDropCandidates([...hosts].map((domain) => ({ domain, source: 'commoncrawl' })))
  db.setSetting(PAGE_KEY, String(page + 1))
  return { scanned, domains: hosts.size, added, page, note: null }
}

// ---------------------------------------------------------------- niche fit

/**
 * Vocabulary of the things worth chasing. Weighted, because "booster box" is a
 * far stronger indicator than "art".
 *
 * This is where the system's taste lives, and it is deliberately data rather
 * than a model: it is inspectable, cheap, and trivially editable when the
 * collecting interest moves on.
 */
const NICHE_TERMS: Array<[RegExp, number]> = [
  [/\b(booster box|booster pack|blind box|mystery box|grail)\b/, 5],
  [/\b(trading card|tcg|card pack|collector box|sealed)\b/, 4],
  [/\b(limited edition|numbered|signed|artist proof|first edition|exclusive drop)\b/, 3],
  [/\b(vinyl|test press|colorway|deadstock|og release)\b/, 3],
  [/\b(enamel pin|art print|screen print|giclee|zine|plush|figure|resin|sofubi|vinyl toy)\b/, 2],
  [/\b(preorder|pre-order|drop|restock|waitlist|raffle)\b/, 2],
  [/\b(poster|sticker|patch|tee|hoodie|collectible|edition)\b/, 1]
]

/** Shops that are plainly not in the niche, however much Shopify they run. */
const ANTI_TERMS = /\b(cbd|vape|kratom|supplement|gummies|detox|weight loss|essential oil|phone case|lash|wig|nail)\b/

/**
 * Score a shop's fit from its own product titles.
 *
 * Density-normalised so a 500-product store cannot out-score a 12-product
 * artist shop purely on volume — the question is what KIND of thing this shop
 * sells, not how much of it.
 */
export function nicheScore(titles: string[], productTypes: string[] = []): number {
  if (!titles.length) return 0
  const hay = [...titles, ...productTypes].join(' | ').toLowerCase()
  if (ANTI_TERMS.test(hay)) return 0
  let score = 0
  for (const [re, weight] of NICHE_TERMS) {
    const hits = hay.match(new RegExp(re.source, 'g'))
    if (hits) score += weight * Math.min(hits.length, 5)
  }
  return Math.round(Math.min(100, (score / Math.max(6, titles.length)) * 25))
}

export interface ProbeResult {
  probed: number
  shopify: number
  scored: number
  errors: number
}

/**
 * Probe unprobed candidates: is it a live Shopify shop, and is it in the niche?
 *
 * A password-protected or empty store answers with no products; those are
 * recorded as probed-but-not-shopify so they are never retried, which is what
 * keeps the pool from re-walking dead domains forever.
 */
export async function probeCandidates(limit = 40): Promise<ProbeResult> {
  const queue = db.listUnprobedCandidates(limit)
  const out: ProbeResult = { probed: 0, shopify: 0, scored: 0, errors: 0 }

  for (const c of queue) {
    const base = `https://${c.domain}`
    try {
      const probe = await probeShopify(base)
      out.probed++
      if (!probe.ok || probe.products === 0) {
        db.updateDropCandidate(c.domain, {
          shopify: probe.ok ? 1 : 0,
          products: probe.products,
          probed_at: Date.now(),
          error: probe.note
        })
      } else {
        // Pull a sample to judge the niche. 30 titles is plenty to characterise
        // a shop and keeps the request small.
        const sample = await fetchTitles(base, 30)
        const score = nicheScore(sample.titles, sample.types)
        db.updateDropCandidate(c.domain, {
          shopify: 1,
          products: sample.titles.length,
          title_sample: sample.titles.slice(0, 8).join(' | ').slice(0, 500),
          niche_score: score,
          probed_at: Date.now(),
          error: null
        })
        out.shopify++
        out.scored++
      }
    } catch (err) {
      out.errors++
      db.updateDropCandidate(c.domain, {
        shopify: 0,
        probed_at: Date.now(),
        error: err instanceof Error ? err.message : String(err)
      })
    }
    await sleep(PROBE_GAP_MS)
  }
  return out
}

async function fetchTitles(base: string, limit: number): Promise<{ titles: string[]; types: string[] }> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/products.json?limit=${limit}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctl.signal
    })
    if (!res.ok) return { titles: [], types: [] }
    const parsed = (await res.json()) as { products?: Array<{ title?: string; product_type?: string }> }
    const products = Array.isArray(parsed.products) ? parsed.products : []
    return {
      titles: products.map((p) => String(p.title ?? '')).filter(Boolean),
      types: products.map((p) => String(p.product_type ?? '')).filter(Boolean)
    }
  } finally {
    clearTimeout(t)
  }
}

/**
 * Turn the best-fitting candidates into real watches.
 *
 * New watches start on the SLOW clock regardless of score: nothing has been
 * observed selling out yet, and a store earns fast polling by behaving like a
 * drop store, not by scoring well on vocabulary.
 */
export async function promoteCandidates(count = 10, minScore = 20): Promise<{ promoted: string[]; skipped: number }> {
  const top = db.listTopCandidates(count * 3).filter((c) => (c.niche_score ?? 0) >= minScore)
  const promoted: string[] = []
  let skipped = 0

  for (const c of top) {
    if (promoted.length >= count) break
    const url = `https://${c.domain}`
    if (db.findDropWatchByUrl(url)) {
      db.updateDropCandidate(c.domain, { promoted: 1 })
      skipped++
      continue
    }
    // Label from the store's own titles where possible; the domain is opaque.
    const label = c.title_sample?.split(' | ')[0]?.slice(0, 40) || c.domain.replace('.myshopify.com', '')
    const w = db.createDropWatch({ label, kind: 'shopify', url, priority: 'normal' })
    db.updateDropCandidate(c.domain, { promoted: 1 })
    promoted.push(w.label)
  }
  return { promoted, skipped }
}

// ---------------------------------------------------------------- heat

/**
 * Score watched stores on observed behaviour rather than vocabulary.
 *
 * Three things matter and they are genuinely different questions:
 *   sellout_rate  what share of the catalogue is currently unbuyable
 *   churn         how often things actually flip, per week
 *   uptime        how long a thing stays buyable once it is
 * A store where everything has been sold out untouched for a year is NOT hot —
 * it is abandoned — which is why churn is weighted above raw sell-out share.
 */
const WEEK_MS = 7 * 86_400_000

export interface HeatResult {
  scored: number
  hottest: Array<{ label: string; heat: number; selloutRate: number; medianUptimeMs: number | null }>
}

export function scoreWatches(): HeatResult {
  const out: HeatResult = { scored: 0, hottest: [] }

  for (const w of db.listDropWatches()) {
    const products = db.listDropProducts(w.id, false)
    if (!products.length) continue

    const soldOut = products.filter((p) => p.available === 0).length
    const selloutRate = soldOut / products.length

    const events = db.listDropEvents({ watchId: w.id, limit: 1000 })
    const since = Date.now() - 4 * WEEK_MS
    const recent = events.filter((e) => e.created_at >= since && (e.kind === 'restock' || e.kind === 'sold_out'))
    const churnPerWeek = recent.length / 4

    // Pair each restock with the sold_out that followed it for the same title.
    const uptimes: number[] = []
    const openedAt = new Map<string, number>()
    for (const e of [...events].reverse()) {
      if (e.kind === 'restock') openedAt.set(e.title, e.created_at)
      else if (e.kind === 'sold_out') {
        const start = openedAt.get(e.title)
        if (start != null && e.created_at > start) {
          uptimes.push(e.created_at - start)
          openedAt.delete(e.title)
        }
      }
    }
    uptimes.sort((a, b) => a - b)
    const medianUptime = uptimes.length ? uptimes[Math.floor(uptimes.length / 2)] : null

    // Churn dominates; a fast median uptime is a strong bonus because it means
    // stock does not survive contact with buyers.
    const churnPart = Math.min(60, churnPerWeek * 12)
    const soldPart = selloutRate * 25
    const speedPart = medianUptime == null ? 0 : Math.max(0, 15 - Math.min(15, medianUptime / (2 * 3_600_000)))
    const heat = Math.round(Math.min(100, churnPart + soldPart + speedPart))

    db.updateDropWatch(w.id, {
      heat,
      sellout_rate: Math.round(selloutRate * 1000) / 1000,
      median_uptime_ms: medianUptime,
      scored_at: Date.now()
    })
    out.scored++
    out.hottest.push({ label: w.label, heat, selloutRate, medianUptimeMs: medianUptime })
  }

  out.hottest.sort((a, b) => b.heat - a.heat)
  out.hottest = out.hottest.slice(0, 10)
  return out
}

/**
 * Re-tier polling from observed heat.
 *
 * This is what makes the watchlist self-curating: a store that has proven it
 * sells out fast earns the one-minute clock, and one that has not moved in a
 * month drops back to the slow one. Manual 'hot' watches are left alone —
 * an explicit choice by the user outranks the scorer.
 */
export function retier(hotThreshold = 45, coolThreshold = 10): { promoted: string[]; demoted: string[] } {
  const promoted: string[] = []
  const demoted: string[] = []
  for (const w of db.listDropWatches()) {
    if (w.heat == null || w.scored_at == null) continue
    if (w.heat >= hotThreshold && w.priority !== 'hot') {
      db.updateDropWatch(w.id, { priority: 'hot' })
      promoted.push(w.label)
    } else if (w.heat <= coolThreshold && w.priority === 'hot' && w.pinned !== 1) {
      db.updateDropWatch(w.id, { priority: 'normal' })
      demoted.push(w.label)
    }
  }
  return { promoted, demoted }
}
