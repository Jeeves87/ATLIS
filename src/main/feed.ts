/**
 * Feed aggregator for the ATLIS Feed page — a personal, reddit-like timeline
 * that pulls from heterogeneous sources and normalizes them into one stream.
 *
 * Lives in the main process so it can hit arbitrary feeds without browser CORS
 * and parse XML/JSON without a DOM. Three source kinds, all reduced to a single
 * `FeedItem` shape:
 *   • youtube — a channel's Atom feed (videos.xml?channel_id=UC…)
 *   • reddit  — a subreddit listing (…/r/<sub>/<sort>.json)
 *   • rss     — any RSS 2.0 / Atom feed (with light feed auto-discovery)
 *
 * No new dependencies: a small, tolerant regex parser handles RSS + Atom
 * (incl. YouTube's media: namespace), mirroring the no-build-tools constraints
 * the rest of ATLIS lives under. Everything degrades gracefully — a failing
 * source records `last_error` and the others keep going.
 */
import { BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import * as db from './db'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
// Reddit blocks spoofed browser UAs (403 on JSON, 429 on .rss); it serves its
// public Atom feed fine to a plain descriptive UA, so reddit uses this instead.
const REDDIT_UA = 'ATLIS/0.1 (personal feed reader)'

export type FeedKind = 'youtube' | 'reddit' | 'rss' | 'site'

interface ParsedItem {
  guid: string
  title: string
  url: string
  author?: string | null
  summary?: string | null
  thumbnail?: string | null
  publishedAt?: number | null
  score?: number | null
  comments?: number | null
  extra?: Record<string, unknown>
}

// ---------------------------------------------------------------- http

async function getText(url: string, headers: Record<string, string> = {}, retries = 1): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } })
  // Feeds (reddit especially) rate-limit bursts; back off once before giving up.
  if ((res.status === 429 || res.status === 503) && retries > 0) {
    await new Promise((r) => setTimeout(r, 2500))
    return getText(url, headers, retries - 1)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ---------------------------------------------------------------- xml helpers

/** Decode CDATA + the common HTML entities. Order matters: CDATA, then &amp; last. */
function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#0?39);/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .trim()
}
function safeChar(code: number): string {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  } catch {
    return ''
  }
}

/** First inner text of <name>…</name> (namespace-agnostic on the local part). */
function tagText(block: string, name: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, 'i')
  const m = block.match(re)
  return m ? decodeXml(m[1]) : null
}

/** Value of an attribute on the first <name …> tag (self-closing or not). */
function tagAttr(block: string, name: string, attr: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?\\b${attr}=["']([^"']+)["']`, 'i')
  const m = block.match(re)
  return m ? decodeXml(m[1]) : null
}

/** Strip tags to a short plain-text snippet for card summaries. */
function snippet(html: string | null, max = 280): string | null {
  if (!html) return null
  const text = decodeXml(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return text.length > max ? text.slice(0, max).trimEnd() + '…' : text
}

function parseDate(s: string | null): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(m[1])
  return out
}

/** Best-effort thumbnail from media:/enclosure/og:image/inline <img>. */
function findThumb(block: string): string | null {
  return (
    tagAttr(block, 'thumbnail', 'url') ||
    tagAttr(block, 'content', 'url') ||
    tagAttr(block, 'enclosure', 'url') ||
    (block.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? null)
  )
}

// ---------------------------------------------------------------- rss / atom

/** Parse an RSS 2.0 or Atom document into normalized items + a feed title. */
function parseFeed(xml: string): { title: string | null; items: ParsedItem[] } {
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml)
  // Feed-level title is the first <title> not inside an item/entry.
  const head = xml.split(isAtom ? /<entry[\s>]/i : /<item[\s>]/i)[0]
  const feedTitle = tagText(head, 'title')

  const items: ParsedItem[] = []
  for (const b of blocks(xml, isAtom ? 'entry' : 'item')) {
    const title = tagText(b, 'title') || '(untitled)'
    let url = ''
    if (isAtom) {
      // Prefer rel="alternate"; fall back to the first <link href>.
      const alt = b.match(/<link[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i)
      url = decodeXml(alt?.[1] || tagAttr(b, 'link', 'href') || '')
    } else {
      url = tagText(b, 'link') || tagAttr(b, 'link', 'href') || ''
    }
    const guid = tagText(b, 'guid') || tagText(b, 'id') || url || title
    const author = tagText(b, 'creator') || tagText(b, 'name') || tagText(b, 'author')
    const summary = snippet(tagText(b, 'description') || tagText(b, 'summary') || tagText(b, 'content'))
    const publishedAt =
      parseDate(tagText(b, 'pubDate')) ?? parseDate(tagText(b, 'published')) ?? parseDate(tagText(b, 'updated'))
    const thumbnail = findThumb(b)
    if (!url) continue
    items.push({ guid, title, url, author: author?.replace(/<[^>]+>/g, '').trim() || null, summary, thumbnail, publishedAt })
  }
  return { title: feedTitle, items }
}

// ---------------------------------------------------------------- site adapters

/**
 * Some sites the user wants (Anthropic's news) publish no RSS — just a page.
 * A site adapter scrapes such a page into the same ParsedItem shape. Adapters
 * are matched from free-form input on add, and re-run by url on refresh, so the
 * generic RSS path stays untouched. Add more adapters here as needed.
 */
interface SiteAdapter {
  id: string
  title: string
  homeUrl: string
  match: (raw: string) => boolean
  scrape: () => Promise<ParsedItem[]>
}

/** slug → lastmod date from a site's sitemap.xml, for entries under /news/. */
async function anthropicSitemapDates(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  try {
    const sm = await getText('https://www.anthropic.com/sitemap.xml')
    for (const block of sm.split('<url>').slice(1)) {
      const slug = block.match(/<loc>[^<]*\/news\/([a-z0-9-]+)<\/loc>/)?.[1]
      if (slug) out[slug] = block.match(/<lastmod>(.*?)<\/lastmod>/)?.[1] ?? ''
    }
  } catch {
    /* no dates — items still resolve, just unsorted by recency */
  }
  return out
}

/**
 * Anthropic news: the listing page renders each post as
 * `<a href="/news/slug"><h…>Title</h…>…</a>`; publish dates come from the
 * sitemap's <lastmod>. No RSS, but both of those are stable, structured inputs.
 */
async function scrapeAnthropicNews(): Promise<ParsedItem[]> {
  const base = 'https://www.anthropic.com'
  const html = await getText(`${base}/news`)
  const dateBySlug = await anthropicSitemapDates()

  const re = /<a\b[^>]*href="(\/news\/[a-z0-9][a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/g
  const seen = new Set<string>()
  const items: ParsedItem[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const path = m[1]
    if (seen.has(path)) continue
    // Featured cards wrap the title in a heading; grid cards use a *Title class.
    const heading =
      m[2].match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] ||
      m[2].match(/class="[^"]*[Tt]itle[^"]*"[^>]*>([\s\S]*?)</)?.[1]
    if (!heading) continue
    const title = decodeXml(heading.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    if (!title) continue
    seen.add(path)
    const slug = path.replace('/news/', '')
    const date = dateBySlug[slug]
    items.push({
      guid: `${base}${path}`,
      title,
      url: `${base}${path}`,
      author: 'Anthropic',
      summary: null,
      thumbnail: null,
      publishedAt: date ? Date.parse(date) || null : null
    })
  }
  return items
}

const SITE_ADAPTERS: SiteAdapter[] = [
  {
    id: 'anthropic-news',
    title: 'Anthropic News',
    homeUrl: 'https://www.anthropic.com/news',
    match: (raw) => /anthropic\.com/i.test(raw) || /^anthropic$/i.test(raw.trim()),
    scrape: scrapeAnthropicNews
  }
]

// ---------------------------------------------------------------- source resolution

const YT_RE = /(?:youtube\.com|youtu\.be)/i
const REDDIT_RE = /^(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/([\w-]+)/i
const SUB_RE = /^\/?r\/([\w-]+)\/?$/i

/** Pull a UC… channel id out of input or a fetched channel page. */
async function resolveYouTube(input: string): Promise<{ url: string; title: string; items: ParsedItem[] }> {
  let channelId: string | null = null

  const directId = input.match(/(?:channel_id=|\/channel\/)(UC[0-9A-Za-z_-]{20,})/)?.[1]
  if (directId) channelId = directId

  if (!channelId) {
    // Handle/custom/user URL or bare @handle — fetch the page and dig out the id.
    let pageUrl = input.trim()
    if (/^@[\w.-]+$/.test(pageUrl)) pageUrl = `https://www.youtube.com/${pageUrl}`
    else if (!/^https?:\/\//i.test(pageUrl)) pageUrl = `https://www.youtube.com/${pageUrl.replace(/^\/+/, '')}`
    const html = await getText(pageUrl)
    // Prefer the page's OWN canonical id. A channel page mentions many other
    // channel ids first (featured/related), so a naive first `"channelId"` match
    // resolves to the wrong channel (e.g. @t3dotgg → a side channel of old clips).
    // canonical link / og:url / itemprop / externalId all carry the real one.
    channelId =
      html.match(/<link[^>]+rel="canonical"[^>]+\/channel\/(UC[0-9A-Za-z_-]{20,})/)?.[1] ||
      html.match(/<meta[^>]+property="og:url"[^>]+\/channel\/(UC[0-9A-Za-z_-]{20,})/)?.[1] ||
      html.match(/<meta[^>]+itemprop="(?:identifier|channelId)"[^>]+content="(UC[0-9A-Za-z_-]{20,})"/)?.[1] ||
      html.match(/"externalId":"(UC[0-9A-Za-z_-]{20,})"/)?.[1] ||
      html.match(/"channelId":"(UC[0-9A-Za-z_-]{20,})"/)?.[1] ||
      html.match(/\/channel\/(UC[0-9A-Za-z_-]{20,})/)?.[1] ||
      null
  }
  if (!channelId) throw new Error('Could not find a YouTube channel id for that input.')

  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
  const { title, items } = parseFeed(await getText(url))
  return { url, title: title || 'YouTube channel', items }
}

/** Discover an RSS/Atom feed url: use the input if it's already a feed, else
 *  scan an HTML page for <link rel="alternate" type="application/rss+xml">. */
async function resolveRss(input: string): Promise<{ url: string; title: string; items: ParsedItem[] }> {
  const start = /^https?:\/\//i.test(input) ? input : `https://${input}`
  const body = await getText(start)
  const looksLikeFeed = /<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(body.slice(0, 2000))
  if (looksLikeFeed) {
    const { title, items } = parseFeed(body)
    return { url: start, title: title || start, items }
  }
  // HTML — find the first declared feed.
  const link = body.match(
    /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi
  )?.map((tag) => tag.match(/href=["']([^"']+)["']/i)?.[1])?.find(Boolean)
  if (!link) throw new Error('No RSS/Atom feed found at that URL. Paste a direct feed link instead.')
  const feedUrl = new URL(link, start).toString()
  const { title, items } = parseFeed(await getText(feedUrl))
  return { url: feedUrl, title: title || feedUrl, items }
}

interface Resolved {
  kind: FeedKind
  url: string
  title: string
  handle: string
  items: ParsedItem[] // already fetched during resolution — reused so add = one request
}

/** Detect the source kind from free-form input and resolve a fetchable url + title. */
export async function resolveSource(input: string): Promise<Resolved> {
  const raw = input.trim()
  if (!raw) throw new Error('Empty source.')

  const redditMatch = raw.match(REDDIT_RE) || raw.match(SUB_RE)
  if (redditMatch) {
    const sub = redditMatch[1]
    // Reddit's public Atom feed for the subreddit's top-of-week threads.
    const url = `https://www.reddit.com/r/${sub}/top/.rss?t=week`
    const { title, items } = parseFeed(await getText(url, { 'User-Agent': REDDIT_UA }))
    return { kind: 'reddit', url, title: title || `r/${sub}`, handle: `r/${sub}`, items }
  }

  if (YT_RE.test(raw) || /^@[\w.-]+$/.test(raw)) {
    const { url, title, items } = await resolveYouTube(raw)
    return { kind: 'youtube', url, title, handle: raw, items }
  }

  // Feedless sites with a dedicated scraper (e.g. Anthropic news).
  const adapter = SITE_ADAPTERS.find((a) => a.match(raw))
  if (adapter) {
    return { kind: 'site', url: adapter.homeUrl, title: adapter.title, handle: raw, items: await adapter.scrape() }
  }

  const { url, title, items } = await resolveRss(raw)
  return { kind: 'rss', url, title, handle: raw, items }
}

// ---------------------------------------------------------------- fetch + persist

function itemId(sourceId: string, guid: string): string {
  return createHash('sha1').update(`${sourceId}|${guid}`).digest('hex').slice(0, 20)
}

async function fetchSourceItems(source: db.FeedSource): Promise<ParsedItem[]> {
  // Site sources are scraped by their adapter (matched by the stored home url).
  if (source.kind === 'site') {
    const adapter = SITE_ADAPTERS.find((a) => a.homeUrl === source.url)
    if (!adapter) throw new Error(`No site adapter for ${source.url}`)
    return adapter.scrape()
  }
  // youtube + rss + reddit are XML feeds; reddit just needs its descriptive UA.
  const headers: Record<string, string> = source.kind === 'reddit' ? { 'User-Agent': REDDIT_UA } : {}
  return parseFeed(await getText(source.url, headers)).items
}

/** Upsert a batch of parsed items under a source; returns how many were new. */
function persistItems(source: db.FeedSource, items: ParsedItem[]): number {
  let added = 0
  for (const it of items) {
    const wasNew = db.upsertFeedItem({
      id: itemId(source.id, it.guid),
      source_id: source.id,
      kind: source.kind,
      title: it.title,
      url: it.url,
      author: it.author ?? null,
      summary: it.summary ?? null,
      thumbnail: it.thumbnail ?? null,
      published_at: it.publishedAt ?? null,
      score: it.score ?? null,
      comments: it.comments ?? null,
      extra_json: it.extra ? JSON.stringify(it.extra) : null
    })
    if (wasNew) added++
  }
  return added
}

/** Refresh a single source; returns the count of newly-seen items. Never throws. */
export async function refreshSource(id: string): Promise<{ ok: boolean; added: number; error?: string }> {
  const source = db.getFeedSource(id)
  if (!source) return { ok: false, added: 0, error: 'Source not found.' }
  try {
    const added = persistItems(source, await fetchSourceItems(source))
    db.updateFeedSource(id, { last_fetched_at: Date.now(), last_error: null })
    return { ok: true, added }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    db.updateFeedSource(id, { last_fetched_at: Date.now(), last_error: msg })
    return { ok: false, added: 0, error: msg }
  }
}

/** Refresh every enabled source (bounded concurrency), then prune. */
export async function refreshAll(): Promise<{ added: number; sources: number }> {
  const sources = db.listFeedSources().filter((s) => s.enabled)
  let added = 0
  const limit = 4
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, sources.length) }, async () => {
      while (i < sources.length) {
        const s = sources[i++]
        const r = await refreshSource(s.id)
        added += r.added
      }
    })
  )
  db.pruneFeedItems()
  return { added, sources: sources.length }
}

/**
 * Add a source from free-form input. Resolution already fetched the feed, so we
 * persist those items directly rather than fetching a second time (a quick
 * repeat would just get rate-limited, especially by reddit).
 */
export async function addSource(input: string, category?: string | null): Promise<db.FeedSource> {
  const r = await resolveSource(input)
  const source = db.createFeedSource({ kind: r.kind, title: r.title, url: r.url, handle: r.handle, category: category ?? null })
  persistItems(source, r.items)
  db.updateFeedSource(source.id, { last_fetched_at: Date.now(), last_error: null })
  return db.getFeedSource(source.id) ?? source
}

// ---------------------------------------------------------------- scheduler

const REFRESH_EVERY_MS = 15 * 60_000
const STARTUP_GRACE_MS = 4_000

// `disabled_apps` is the renderer's App Selector setting (JSON string[] of view ids)
function feedAppHidden(): boolean {
  try {
    return (JSON.parse(db.getSetting('disabled_apps') || '[]') as string[]).includes('feed')
  } catch {
    return false
  }
}

/** Periodically refresh all sources while ATLIS runs; pushes `feed:changed`. */
export function startFeedScheduler(win: BrowserWindow): () => void {
  let stopped = false
  const tick = async () => {
    if (stopped || win.isDestroyed()) return
    if (feedAppHidden()) return // Settings app selector hides Feed → no background fetching
    if (!db.listFeedSources().some((s) => s.enabled)) return
    await refreshAll().catch(() => {})
    if (!stopped && !win.isDestroyed()) win.webContents.send('feed:changed', {})
  }
  const startup = setTimeout(tick, STARTUP_GRACE_MS)
  const interval = setInterval(tick, REFRESH_EVERY_MS)
  interval.unref?.()
  const stop = () => {
    stopped = true
    clearTimeout(startup)
    clearInterval(interval)
  }
  win.on('closed', stop)
  return stop
}
