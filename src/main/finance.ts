/**
 * Finance data + workspace layer for the ATLIS Finance Tracker page.
 *
 * Lives in the main process so it can (a) hit Yahoo Finance JSON endpoints
 * without browser CORS, and (b) read/write the finance/ workspace files.
 * The renderer reaches everything here through the `finance:*` IPC channels.
 *
 * Free, no-key Yahoo endpoints are used throughout; v7/v10 now want a
 * cookie+crumb, so we acquire one lazily and degrade gracefully when a
 * request fails (cards fall back to chart-meta prices, fundamentals show "—").
 */
import { promises as fsp } from 'fs'
import { dirname } from 'path'
import { resolveWorkspacePath } from './workspace'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

// ---------------------------------------------------------------- types

export interface Quote {
  symbol: string
  shortName: string | null
  price: number | null
  previousClose: number | null
  open: number | null
  dayHigh: number | null
  dayLow: number | null
  volume: number | null
  fiftyTwoWeekHigh: number | null
  fiftyTwoWeekLow: number | null
  marketCap: number | null
  trailingPE: number | null
  priceToBook: number | null
  eps: number | null
  currency: string | null
  exchange: string | null
  marketState: string | null
  dayChange: number | null
  dayChangePct: number | null
  weekChangePct: number | null
  yearChangePct: number | null
}

export interface ChartSeries {
  symbol: string
  timestamps: number[] // epoch ms
  open: (number | null)[]
  high: (number | null)[]
  low: (number | null)[]
  close: (number | null)[]
  volume: (number | null)[]
  meta: { price: number | null; previousClose: number | null; currency: string | null; exchange: string | null }
}

export interface Fundamentals {
  symbol: string
  shortName: string | null
  longName: string | null
  sector: string | null
  industry: string | null
  website: string | null
  summary: string | null
  marketCap: number | null
  trailingPE: number | null
  forwardPE: number | null
  priceToBook: number | null
  debtToEquity: number | null
  eps: number | null
  bookValue: number | null
  beta: number | null
  dividendYield: number | null
  earningsGrowth: number | null
  revenueGrowth: number | null
  profitMargins: number | null
  targetMeanPrice: number | null
  recommendationKey: string | null
  earningsTimestamp: number | null // epoch ms
}

export interface NewsItem {
  title: string
  publisher: string | null
  link: string
  publishedAt: number | null // epoch ms
}

// ---------------------------------------------------------------- yahoo http

let crumb: { value: string; cookie: string; at: number } | null = null

/** Fetch (and cache for ~25 min) a Yahoo cookie + crumb pair for v7/v10 calls. */
async function getCrumb(): Promise<{ value: string; cookie: string } | null> {
  if (crumb && Date.now() - crumb.at < 25 * 60_000) return crumb
  try {
    const seed = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } })
    const setCookies =
      typeof (seed.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (seed.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [seed.headers.get('set-cookie') ?? '']
    const cookie = setCookies
      .map((c) => c.split(';')[0])
      .filter(Boolean)
      .join('; ')
    const res = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Cookie: cookie }
    })
    const value = (await res.text()).trim()
    if (value && !value.includes('<') && value.length < 40) {
      crumb = { value, cookie, at: Date.now() }
      return crumb
    }
  } catch {
    /* fall through — caller degrades */
  }
  return null
}

/** GET JSON from a Yahoo host, trying query1 then query2. */
async function yget<T = unknown>(path: string, search: Record<string, string>, withCrumb = false): Promise<T> {
  const params = new URLSearchParams(search)
  let cookie = ''
  if (withCrumb) {
    const c = await getCrumb()
    if (c) {
      params.set('crumb', c.value)
      cookie = c.cookie
    }
  }
  const qs = params.toString()
  let lastErr: unknown
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const res = await fetch(`${host}${path}?${qs}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json', ...(cookie ? { Cookie: cookie } : {}) }
      })
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} from ${host}${path}`)
        continue
      }
      return (await res.json()) as T
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null)
const raw = (v: unknown): number | null => (v && typeof v === 'object' && 'raw' in v ? num((v as { raw: unknown }).raw) : num(v))

// ---------------------------------------------------------------- quotes

interface ChartMetaResp {
  chart?: {
    result?: Array<{
      meta?: Record<string, unknown>
      timestamp?: number[]
      indicators?: { quote?: Array<Record<string, (number | null)[]>>; adjclose?: Array<{ adjclose: (number | null)[] }> }
    }>
  }
}

/** A single chart fetch. range/interval are passed straight to Yahoo. */
export async function chart(symbol: string, range = '1y', interval = '1d'): Promise<ChartSeries> {
  const data = await yget<ChartMetaResp>(`/v8/finance/chart/${encodeURIComponent(symbol)}`, { range, interval })
  const r = data.chart?.result?.[0]
  const q = r?.indicators?.quote?.[0] ?? {}
  const meta = (r?.meta ?? {}) as Record<string, unknown>
  return {
    symbol,
    timestamps: (r?.timestamp ?? []).map((t) => t * 1000),
    open: q.open ?? [],
    high: q.high ?? [],
    low: q.low ?? [],
    close: q.close ?? [],
    volume: q.volume ?? [],
    meta: {
      price: num(meta.regularMarketPrice),
      previousClose: num(meta.chartPreviousClose) ?? num(meta.previousClose),
      currency: (meta.currency as string) ?? null,
      exchange: (meta.fullExchangeName as string) ?? (meta.exchangeName as string) ?? null
    }
  }
}

function changePct(closes: (number | null)[], lookback: number): number | null {
  const valid = closes.filter((c): c is number => typeof c === 'number')
  if (valid.length < 2) return null
  const last = valid[valid.length - 1]
  const idx = Math.max(0, valid.length - 1 - lookback)
  const base = valid[idx]
  if (base == null || base === 0) return null
  return ((last - base) / base) * 100
}

/**
 * Batch quote. Tries the v7 quote endpoint (one request, needs crumb); if that
 * fails, falls back to one chart-meta fetch per symbol so cards still price.
 */
export async function quotes(symbols: string[]): Promise<Quote[]> {
  const syms = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)
  if (!syms.length) return []

  try {
    const data = await yget<{ quoteResponse?: { result?: Record<string, unknown>[] } }>(
      '/v7/finance/quote',
      { symbols: syms.join(',') },
      true
    )
    const rows = data.quoteResponse?.result ?? []
    if (rows.length) {
      const bySym = new Map(rows.map((r) => [String(r.symbol).toUpperCase(), r]))
      return syms.map((s) => {
        const r = bySym.get(s)
        if (!r) return emptyQuote(s)
        return {
          symbol: s,
          shortName: (r.shortName as string) ?? (r.longName as string) ?? null,
          price: num(r.regularMarketPrice),
          previousClose: num(r.regularMarketPreviousClose),
          open: num(r.regularMarketOpen),
          dayHigh: num(r.regularMarketDayHigh),
          dayLow: num(r.regularMarketDayLow),
          volume: num(r.regularMarketVolume),
          fiftyTwoWeekHigh: num(r.fiftyTwoWeekHigh),
          fiftyTwoWeekLow: num(r.fiftyTwoWeekLow),
          marketCap: num(r.marketCap),
          trailingPE: num(r.trailingPE),
          priceToBook: num(r.priceToBook),
          eps: num(r.epsTrailingTwelveMonths),
          currency: (r.currency as string) ?? null,
          exchange: (r.fullExchangeName as string) ?? null,
          marketState: (r.marketState as string) ?? null,
          dayChange: num(r.regularMarketChange),
          dayChangePct: num(r.regularMarketChangePercent),
          weekChangePct: null,
          yearChangePct: null
        }
      })
    }
  } catch {
    /* fall through to chart-meta fallback */
  }

  // Fallback: chart meta per symbol (capped concurrency).
  return mapLimit(syms, 6, async (s) => {
    try {
      const c = await chart(s, '5d', '1d')
      const price = c.meta.price
      const prev = c.meta.previousClose
      return {
        ...emptyQuote(s),
        price,
        previousClose: prev,
        currency: c.meta.currency,
        exchange: c.meta.exchange,
        dayChange: price != null && prev != null ? price - prev : null,
        dayChangePct: price != null && prev != null && prev !== 0 ? ((price - prev) / prev) * 100 : null
      }
    } catch {
      return emptyQuote(s)
    }
  })
}

function emptyQuote(symbol: string): Quote {
  return {
    symbol,
    shortName: null,
    price: null,
    previousClose: null,
    open: null,
    dayHigh: null,
    dayLow: null,
    volume: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    marketCap: null,
    trailingPE: null,
    priceToBook: null,
    eps: null,
    currency: null,
    exchange: null,
    marketState: null,
    dayChange: null,
    dayChangePct: null,
    weekChangePct: null,
    yearChangePct: null
  }
}

/** Compute week + year % change for each symbol from 1y daily history. */
export async function enrich(symbols: string[]): Promise<Record<string, { weekChangePct: number | null; yearChangePct: number | null }>> {
  const syms = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)
  const out: Record<string, { weekChangePct: number | null; yearChangePct: number | null }> = {}
  await mapLimit(syms, 6, async (s) => {
    try {
      const c = await chart(s, '1y', '1d')
      out[s] = { weekChangePct: changePct(c.close, 5), yearChangePct: changePct(c.close, 251) }
    } catch {
      out[s] = { weekChangePct: null, yearChangePct: null }
    }
  })
  return out
}

// ---------------------------------------------------------------- fundamentals + news

interface SummaryResp {
  quoteSummary?: { result?: Array<Record<string, Record<string, unknown>>> }
}

export async function fundamentals(symbol: string): Promise<Fundamentals> {
  const s = symbol.trim().toUpperCase()
  const base: Fundamentals = {
    symbol: s, shortName: null, longName: null, sector: null, industry: null, website: null, summary: null,
    marketCap: null, trailingPE: null, forwardPE: null, priceToBook: null, debtToEquity: null, eps: null,
    bookValue: null, beta: null, dividendYield: null, earningsGrowth: null, revenueGrowth: null,
    profitMargins: null, targetMeanPrice: null, recommendationKey: null, earningsTimestamp: null
  }
  try {
    const data = await yget<SummaryResp>(
      `/v10/finance/quoteSummary/${encodeURIComponent(s)}`,
      { modules: 'summaryDetail,defaultKeyStatistics,assetProfile,financialData,price,calendarEvents' },
      true
    )
    const r = data.quoteSummary?.result?.[0]
    if (!r) return base
    const sd = r.summaryDetail ?? {}
    const ks = r.defaultKeyStatistics ?? {}
    const ap = r.assetProfile ?? {}
    const fd = r.financialData ?? {}
    const pr = r.price ?? {}
    const ce = r.calendarEvents ?? {}
    const earnings = (ce.earnings as { earningsDate?: Array<{ raw?: number }> } | undefined)?.earningsDate?.[0]?.raw
    return {
      ...base,
      shortName: (pr.shortName as string) ?? null,
      longName: (pr.longName as string) ?? null,
      sector: (ap.sector as string) ?? null,
      industry: (ap.industry as string) ?? null,
      website: (ap.website as string) ?? null,
      summary: (ap.longBusinessSummary as string) ?? null,
      marketCap: raw(sd.marketCap) ?? raw(pr.marketCap),
      trailingPE: raw(sd.trailingPE),
      forwardPE: raw(sd.forwardPE) ?? raw(ks.forwardPE),
      priceToBook: raw(ks.priceToBook),
      debtToEquity: raw(fd.debtToEquity),
      eps: raw(ks.trailingEps),
      bookValue: raw(ks.bookValue),
      beta: raw(sd.beta) ?? raw(ks.beta),
      dividendYield: raw(sd.dividendYield),
      earningsGrowth: raw(fd.earningsGrowth),
      revenueGrowth: raw(fd.revenueGrowth),
      profitMargins: raw(fd.profitMargins) ?? raw(ks.profitMargins),
      targetMeanPrice: raw(fd.targetMeanPrice),
      recommendationKey: (fd.recommendationKey as string) ?? null,
      earningsTimestamp: earnings ? earnings * 1000 : null
    }
  } catch {
    return base
  }
}

export async function news(symbol: string): Promise<NewsItem[]> {
  try {
    const data = await yget<{ news?: Array<Record<string, unknown>> }>('/v1/finance/search', {
      q: symbol,
      newsCount: '10',
      quotesCount: '0'
    })
    return (data.news ?? []).slice(0, 10).map((n) => ({
      title: String(n.title ?? ''),
      publisher: (n.publisher as string) ?? null,
      link: String(n.link ?? ''),
      publishedAt: typeof n.providerPublishTime === 'number' ? n.providerPublishTime * 1000 : null
    }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- concurrency

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

// ---------------------------------------------------------------- workspace files

const FIN = (rel: string) => resolveWorkspacePath(`finance/${rel}`)

async function readJson<T>(rel: string, fallback: T): Promise<T> {
  try {
    const text = await fsp.readFile(FIN(rel), 'utf8')
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

async function writeJson(rel: string, data: unknown): Promise<void> {
  const file = FIN(rel)
  await fsp.mkdir(dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}

export interface WatchlistTicker {
  symbol: string
  added: string
  is_favorite: boolean
  notes: string
  tags: string[]
  trade_plans: string[]
}
export interface Watchlist {
  tickers: WatchlistTicker[]
  last_synced: string | null
}
export interface Holding {
  symbol: string
  shares: number
  avg_cost: number
  added: string
  notes: string
}
export interface Portfolio {
  holdings: Holding[]
}
export interface FinanceSettings {
  account_size: number
  risk_pct: number
  show_ticker_tape: boolean
}

const DEFAULT_WATCHLIST: Watchlist = {
  tickers: ['NVDA', 'AAPL', 'MSFT', 'TSLA', 'AMD', 'GOOGL', 'AMZN', 'META'].map((symbol, i) => ({
    symbol,
    added: new Date().toISOString().slice(0, 10),
    is_favorite: i < 3,
    notes: '',
    tags: [],
    trade_plans: []
  })),
  last_synced: null
}
const DEFAULT_SETTINGS: FinanceSettings = { account_size: 10000, risk_pct: 1, show_ticker_tape: true }

export const getWatchlist = () => readJson<Watchlist>('watchlist.json', DEFAULT_WATCHLIST)
export const setWatchlist = (w: Watchlist) => writeJson('watchlist.json', w)
export const getPortfolio = () => readJson<Portfolio>('portfolio.json', { holdings: [] })
export const setPortfolio = (p: Portfolio) => writeJson('portfolio.json', p)
export const getFinanceSettings = () => readJson<FinanceSettings>('settings.json', DEFAULT_SETTINGS)
export const setFinanceSettings = (s: FinanceSettings) => writeJson('settings.json', s)

/** Append one structured JSON-line to finance/activity.log. */
export async function logActivity(entry: Record<string, unknown>): Promise<void> {
  const file = FIN('activity.log')
  await fsp.mkdir(dirname(file), { recursive: true })
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
  await fsp.appendFile(file, line, 'utf8')
}

export async function readActivity(limit = 20): Promise<Record<string, unknown>[]> {
  try {
    const text = await fsp.readFile(FIN('activity.log'), 'utf8')
    const lines = text.split('\n').filter((l) => l.trim())
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return { raw: l }
        }
      })
  } catch {
    return []
  }
}

/** Append a daily price snapshot for a favorite ticker (cost-controlled history). */
export async function appendHistory(symbol: string, snapshot: Record<string, unknown>): Promise<void> {
  const s = symbol.trim().toUpperCase()
  const rel = `history/${s}.json`
  const arr = await readJson<Record<string, unknown>[]>(rel, [])
  const today = new Date().toISOString().slice(0, 10)
  if (arr.length && (arr[arr.length - 1] as { date?: string }).date === today) return // one per day
  arr.push({ date: today, ...snapshot })
  await writeJson(rel, arr.slice(-400))
}
export const getHistory = (symbol: string) => readJson<Record<string, unknown>[]>(`history/${symbol.trim().toUpperCase()}.json`, [])
