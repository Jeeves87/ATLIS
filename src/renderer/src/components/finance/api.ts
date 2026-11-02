import type { Quote, Fundamentals, NewsItem, Holding } from '../../types'

const fin = () => window.atlis.finance

// -------------------------------------------------- baskets

/** Large-cap basket used for market breadth + fear/greed (kept small to limit calls). */
export const BREADTH_BASKET = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'V',
  'UNH', 'XOM', 'JNJ', 'WMT', 'MA', 'PG', 'HD', 'COST', 'ABBV', 'KO',
  'BAC', 'CRM', 'AMD', 'NFLX', 'ADBE'
]
export const INDEX_SYMBOLS = ['^GSPC', '^IXIC', '^NYA'] // S&P 500, Nasdaq Comp, NYSE Composite
export const SNAPSHOT_SYMBOLS = ['^VIX', '^TNX', 'DX-Y.NYB', 'GC=F', 'CL=F', 'BTC-USD']
export const SNAPSHOT_LABELS: Record<string, string> = {
  '^VIX': 'VIX', '^TNX': 'US10Y', 'DX-Y.NYB': 'DXY', 'GC=F': 'Gold', 'CL=F': 'Oil WTI', 'BTC-USD': 'BTC'
}

// -------------------------------------------------- formatting

export const fmtPrice = (n: number | null | undefined, dp = 2): string =>
  n == null || !isFinite(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })

export const fmtPct = (n: number | null | undefined): string =>
  n == null || !isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`

export function fmtCompact(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T'
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toFixed(0)
}

/** Tailwind-free color class for a signed value. */
export const dir = (n: number | null | undefined): string =>
  n == null ? '' : n > 0 ? 'fin-pos' : n < 0 ? 'fin-neg' : ''

// -------------------------------------------------- fear & greed (computed, no API cost)

export interface FearGreed {
  score: number
  label: string
  breadthPct: number
  vix: number | null
}

export function computeFearGreed(basket: Quote[], vix: number | null): FearGreed {
  const valid = basket.filter((q) => q.dayChangePct != null)
  const up = valid.filter((q) => (q.dayChangePct ?? 0) > 0).length
  const breadthPct = valid.length ? (up / valid.length) * 100 : 50
  // VIX 12 → greed (100), 40 → fear (0).
  const vixScore = vix == null ? 50 : Math.max(0, Math.min(100, ((40 - vix) / (40 - 12)) * 100))
  const score = Math.round(0.5 * breadthPct + 0.5 * vixScore)
  return { score, label: fearGreedLabel(score), breadthPct, vix }
}

export function fearGreedLabel(score: number): string {
  if (score < 25) return 'Extreme Fear'
  if (score < 45) return 'Fear'
  if (score <= 55) return 'Neutral'
  if (score <= 75) return 'Greed'
  return 'Extreme Greed'
}

// -------------------------------------------------- market hours (system clock only)

export interface ExchangeStatus {
  code: string
  name: string
  tz: string
  state: 'open' | 'pre' | 'closed'
  localTime: string
}

const EXCHANGES: { code: string; name: string; tz: string; open: number; close: number; preMin?: number }[] = [
  { code: 'NYSE', name: 'New York', tz: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60, preMin: 4 * 60 },
  { code: 'LSE', name: 'London', tz: 'Europe/London', open: 8 * 60, close: 16 * 60 + 30 },
  { code: 'FRA', name: 'Frankfurt', tz: 'Europe/Berlin', open: 9 * 60, close: 17 * 60 + 30 },
  { code: 'TSE', name: 'Tokyo', tz: 'Asia/Tokyo', open: 9 * 60, close: 15 * 60 },
  { code: 'SSE', name: 'Shanghai', tz: 'Asia/Shanghai', open: 9 * 60 + 30, close: 15 * 60 }
]

export function marketHours(now = new Date()): ExchangeStatus[] {
  return EXCHANGES.map((ex) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: ex.tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(now)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    const wd = get('weekday')
    const hour = Number(get('hour') === '24' ? '0' : get('hour'))
    const minute = Number(get('minute'))
    const mins = hour * 60 + minute
    const weekend = wd === 'Sat' || wd === 'Sun'
    let state: ExchangeStatus['state'] = 'closed'
    if (!weekend) {
      if (mins >= ex.open && mins < ex.close) state = 'open'
      else if (ex.preMin != null && mins >= ex.preMin && mins < ex.open) state = 'pre'
    }
    return { code: ex.code, name: ex.name, tz: ex.tz, state, localTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` }
  })
}

// -------------------------------------------------- analyst personas

export interface Persona {
  id: string
  name: string
  blurb: string
  system: string
}

export const PERSONAS: Persona[] = [
  {
    id: 'buffett', name: 'Warren Buffett', blurb: 'Value · economic moats · long horizon',
    system: 'You are a value investor in the mold of Warren Buffett. Judge the business, not the ticker: durable competitive moats, owner earnings, return on capital, management quality, and a margin of safety versus intrinsic value. Be patient and skeptical of hype. Avoid leverage and complexity you cannot explain simply.'
  },
  {
    id: 'graham', name: 'Benjamin Graham', blurb: 'Deep value · balance-sheet margin of safety',
    system: 'You are Benjamin Graham, the father of value investing. Focus on quantitative margin of safety: net-net working capital, low P/E and P/B, strong current ratios, consistent earnings, and dividend record. Treat Mr. Market as a manic-depressive counterparty. Demand statistical cheapness; ignore narrative.'
  },
  {
    id: 'lynch', name: 'Peter Lynch', blurb: 'GARP · growth at a reasonable price',
    system: 'You are Peter Lynch. Look for growth at a reasonable price: PEG ratio, the category of stock (stalwart, fast grower, cyclical, turnaround), the story behind the numbers, and whether earnings growth justifies the multiple. Favor businesses you can understand. Flag when a story has broken.'
  },
  {
    id: 'technician', name: 'The Technician', blurb: 'Price action · trend · momentum',
    system: 'You are a disciplined technical analyst. Read trend (vs SMA50/200), momentum, support/resistance, volume confirmation, and 52-week range position. Ignore fundamentals; the chart and tape are your evidence. Be explicit about invalidation levels and risk.'
  },
  {
    id: 'bear', name: 'The Bear Case', blurb: 'Devil’s advocate · what breaks the thesis',
    system: 'You are a rigorous short-seller building the bear case. Hunt for overvaluation, deteriorating fundamentals, accounting red flags, competitive threats, and crowded positioning. Steelman the bull then dismantle it. Identify the catalysts that would prove you right or wrong.'
  }
]

export const ANALYSIS_SYSTEM_SUFFIX =
  ' Write a focused equity analysis in clean Markdown (## headings, bullet lists, a short bolded verdict line). Be concrete, cite the figures you were given, and end with a clearly labeled bias (Bullish / Neutral / Bearish) and the key risks. Do not invent data you were not given.'

// -------------------------------------------------- HTML report builders

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function row(label: string, value: string): string {
  return `<tr><th style="text-align:left">${esc(label)}</th><td>${value}</td></tr>`
}

const sign = (n: number | null | undefined) =>
  n == null ? '—' : `<span style="color:${n >= 0 ? '#22c55e' : '#ef4444'}">${fmtPct(n)}</span>`

export function quoteBarHtml(q: Quote): string {
  return `<table><tbody>
    ${row('Symbol', `<strong>${esc(q.symbol)}</strong> ${esc(q.shortName ?? '')}`)}
    ${row('Price', `$${fmtPrice(q.price)} ${sign(q.dayChangePct)}`)}
    ${row('Day / Week / Year', `${sign(q.dayChangePct)} / ${sign(q.weekChangePct)} / ${sign(q.yearChangePct)}`)}
    ${row('Volume', fmtCompact(q.volume))}
    ${row('Day Range', `$${fmtPrice(q.dayLow)} – $${fmtPrice(q.dayHigh)}`)}
    ${row('52wk Range', `$${fmtPrice(q.fiftyTwoWeekLow)} – $${fmtPrice(q.fiftyTwoWeekHigh)}`)}
    ${row('Market Cap', fmtCompact(q.marketCap))}
  </tbody></table>`
}

export function equityResearchHtml(opts: {
  q: Quote
  f: Fundamentals
  news: NewsItem[]
  persona: string
  analysisMd?: string
  analysisHtml?: string
}): string {
  const { q, f, news, persona, analysisHtml } = opts
  const date = new Date().toISOString().slice(0, 10)
  const newsList = news.length
    ? `<ul>${news.map((n) => `<li><a href="${esc(n.link)}">${esc(n.title)}</a> <em>${esc(n.publisher ?? '')}</em></li>`).join('')}</ul>`
    : '<p>No recent headlines.</p>'
  return `
  <h1>Equity Research — ${esc(q.symbol)} — ${date}</h1>
  <p><strong>${esc(f.longName ?? q.shortName ?? q.symbol)}</strong>${f.sector ? ` · ${esc(f.sector)}` : ''}${f.industry ? ` · ${esc(f.industry)}` : ''}</p>
  <h2>Quote</h2>
  ${quoteBarHtml(q)}
  <h2>Key Fundamentals</h2>
  <table><tbody>
    ${row('Market Cap', fmtCompact(f.marketCap ?? q.marketCap))}
    ${row('Trailing P/E', fmtPrice(f.trailingPE ?? q.trailingPE))}
    ${row('Forward P/E', fmtPrice(f.forwardPE))}
    ${row('Price / Book', fmtPrice(f.priceToBook ?? q.priceToBook))}
    ${row('Debt / Equity', fmtPrice(f.debtToEquity))}
    ${row('EPS (ttm)', fmtPrice(f.eps ?? q.eps))}
    ${row('Beta', fmtPrice(f.beta))}
    ${row('Profit Margin', f.profitMargins == null ? '—' : (f.profitMargins * 100).toFixed(1) + '%')}
    ${row('Revenue Growth', f.revenueGrowth == null ? '—' : (f.revenueGrowth * 100).toFixed(1) + '%')}
    ${row('Analyst Target', f.targetMeanPrice == null ? '—' : '$' + fmtPrice(f.targetMeanPrice))}
    ${row('Recommendation', esc(f.recommendationKey ?? '—'))}
  </tbody></table>
  ${f.summary ? `<h2>Business</h2><p>${esc(f.summary)}</p>` : ''}
  <h2>Analysis — ${esc(persona)}</h2>
  ${analysisHtml ?? '<p><em>No AI analysis was generated for this report.</em></p>'}
  <h2>Recent News</h2>
  ${newsList}
  <hr/>
  <p style="color:#475569;font-size:0.85em">Generated by ATLIS Finance Tracker · data via Yahoo Finance · ${date}</p>`
}

export function tradePlanHtml(p: {
  symbol: string; entry: number; stop: number; target: number; shares: number
  riskUsd: number; rewardRisk: number | null; positionValue: number; accountSize: number; riskPct: number
}): string {
  const date = new Date().toISOString().slice(0, 10)
  return `
  <h1>Trade Plan — ${esc(p.symbol)} — ${date}</h1>
  <table><tbody>
    ${row('Direction', p.target >= p.entry ? 'Long' : 'Short')}
    ${row('Entry', '$' + fmtPrice(p.entry))}
    ${row('Stop Loss', '$' + fmtPrice(p.stop))}
    ${row('Target', '$' + fmtPrice(p.target))}
    ${row('Shares', String(p.shares))}
    ${row('Position Value', '$' + fmtPrice(p.positionValue))}
    ${row('Risk ($)', '$' + fmtPrice(p.riskUsd))}
    ${row('Reward : Risk', p.rewardRisk == null ? '—' : p.rewardRisk.toFixed(2) + ' : 1')}
    ${row('Account Size', '$' + fmtPrice(p.accountSize))}
    ${row('Risk %', p.riskPct + '%')}
  </tbody></table>
  <p style="color:#475569;font-size:0.85em">Risk-first position sizing · ATLIS Finance Tracker · ${date}</p>`
}

export function dailySummaryHtml(opts: {
  fearGreed: FearGreed
  indices: Quote[]
  snapshot: Quote[]
  gainers: Quote[]
  losers: Quote[]
}): string {
  const date = new Date().toISOString().slice(0, 10)
  const moverRows = (list: Quote[]) =>
    list.map((q) => `<tr><td><strong>${esc(q.symbol)}</strong></td><td>$${fmtPrice(q.price)}</td><td>${sign(q.dayChangePct)}</td></tr>`).join('')
  const snapRows = opts.snapshot
    .map((q) => `<tr><td>${esc(SNAPSHOT_LABELS[q.symbol] ?? q.symbol)}</td><td>${fmtPrice(q.price)}</td><td>${sign(q.dayChangePct)}</td></tr>`)
    .join('')
  const idxRows = opts.indices
    .map((q) => `<tr><td>${esc(q.shortName ?? q.symbol)}</td><td>${fmtPrice(q.price)}</td><td>${sign(q.dayChangePct)}</td></tr>`)
    .join('')
  return `
  <h1>Daily Market Summary — ${date}</h1>
  <p><strong>Fear &amp; Greed:</strong> ${opts.fearGreed.score} (${esc(opts.fearGreed.label)}) · breadth ${opts.fearGreed.breadthPct.toFixed(0)}% advancing${opts.fearGreed.vix != null ? ` · VIX ${fmtPrice(opts.fearGreed.vix)}` : ''}</p>
  <h2>Indices</h2><table><tbody>${idxRows}</tbody></table>
  <h2>Macro Snapshot</h2><table><tbody>${snapRows}</tbody></table>
  <h2>Top Gainers</h2><table><tbody>${moverRows(opts.gainers)}</tbody></table>
  <h2>Top Losers</h2><table><tbody>${moverRows(opts.losers)}</tbody></table>
  <hr/><p style="color:#475569;font-size:0.85em">ATLIS Finance Tracker · ${date}</p>`
}

export function portfolioSnapshotHtml(opts: {
  holdings: Holding[]
  quotes: Record<string, Quote>
  totalValue: number
  dayPL: number
  totalReturn: number
}): string {
  const date = new Date().toISOString().slice(0, 10)
  const rows = opts.holdings
    .map((h) => {
      const q = opts.quotes[h.symbol]
      const cur = q?.price ?? null
      const value = cur != null ? cur * h.shares : null
      const gl = cur != null ? (cur - h.avg_cost) * h.shares : null
      const glPct = cur != null && h.avg_cost ? ((cur - h.avg_cost) / h.avg_cost) * 100 : null
      return `<tr><td><strong>${esc(h.symbol)}</strong></td><td>${h.shares}</td><td>$${fmtPrice(h.avg_cost)}</td><td>${cur == null ? '—' : '$' + fmtPrice(cur)}</td><td>${value == null ? '—' : '$' + fmtPrice(value)}</td><td>${gl == null ? '—' : sign(glPct)} (${gl == null ? '—' : '$' + fmtPrice(gl)})</td></tr>`
    })
    .join('')
  return `
  <h1>Portfolio Snapshot — ${date}</h1>
  <p><strong>Total Value:</strong> $${fmtPrice(opts.totalValue)} · <strong>Day P&amp;L:</strong> ${sign(opts.dayPL >= 0 ? 1 : -1)} $${fmtPrice(opts.dayPL)} · <strong>Total Return:</strong> $${fmtPrice(opts.totalReturn)}</p>
  <table><thead><tr><th>Symbol</th><th>Shares</th><th>Avg Cost</th><th>Current</th><th>Value</th><th>Gain/Loss</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <hr/><p style="color:#475569;font-size:0.85em">ATLIS Finance Tracker · ${date}</p>`
}

// -------------------------------------------------- thin IPC wrappers + logging

export const log = (entry: Record<string, unknown>) => fin().log(entry).catch(() => {})
export const saveDoc = (title: string, html: string) => window.atlis.docs.save({ title, html })
