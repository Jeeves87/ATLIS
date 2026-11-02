import { useEffect, useMemo, useState } from 'react'
import { X, Star, Calculator, Loader2, FileText, Bell } from 'lucide-react'
import {
  ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend
} from 'recharts'
import type { Quote, Fundamentals, NewsItem, ChartSeries, ModelInfo } from '../../types'
import {
  fmtPrice, fmtPct, fmtCompact, dir, PERSONAS, ANALYSIS_SYSTEM_SUFFIX,
  equityResearchHtml, saveDoc, log
} from './api'
import { sanitizeHtml } from '../../lib/markdown'

type Tab = 'overview' | 'technicals' | 'financials' | 'peers' | 'news' | 'sentiment' | 'analysis'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'technicals', label: 'Technicals' },
  { id: 'financials', label: 'Financials' }, { id: 'peers', label: 'Peers' },
  { id: 'news', label: 'News' }, { id: 'sentiment', label: 'Sentiment' }, { id: 'analysis', label: 'Analysis' }
]
const RANGES: { id: string; range: string; interval: string }[] = [
  { id: '1M', range: '1mo', interval: '1d' }, { id: '3M', range: '3mo', interval: '1d' },
  { id: '6M', range: '6mo', interval: '1d' }, { id: '1Y', range: '1y', interval: '1d' },
  { id: 'ALL', range: 'max', interval: '1wk' }
]

const sma = (data: (number | null)[], period: number): (number | null)[] =>
  data.map((_, i) => {
    if (i < period - 1) return null
    const slice = data.slice(i - period + 1, i + 1).filter((v): v is number => v != null)
    return slice.length === period ? slice.reduce((a, b) => a + b, 0) / period : null
  })

interface Props {
  symbol: string
  quote: Quote | undefined
  isFavorite: boolean
  sectors: Record<string, string | null>
  allQuotes: Record<string, Quote>
  onClose: () => void
  onToggleFavorite: (symbol: string) => void
  onOpenCalc: () => void
  onSector: (symbol: string, sector: string | null) => void
}

export default function DeepDive({ symbol, quote, isFavorite, sectors, allQuotes, onClose, onToggleFavorite, onOpenCalc, onSector }: Props) {
  const [tab, setTab] = useState<Tab>('overview')
  const [fund, setFund] = useState<Fundamentals | null>(null)
  const [news, setNews] = useState<NewsItem[]>([])
  const [series, setSeries] = useState<ChartSeries | null>(null)
  const [rangeId, setRangeId] = useState('1Y')
  const [loadingChart, setLoadingChart] = useState(false)

  // analysis tab
  const [personaId, setPersonaId] = useState(PERSONAS[0].id)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelId, setModelId] = useState('')
  const [providerId, setProviderId] = useState('')
  const [analysisMd, setAnalysisMd] = useState('')
  const [analysisHtml, setAnalysisHtml] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisErr, setAnalysisErr] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200) }

  // Load fundamentals + news once per symbol; reset analysis.
  useEffect(() => {
    let alive = true
    setFund(null); setNews([]); setAnalysisMd(''); setAnalysisHtml(''); setAnalysisErr('')
    window.atlis.finance.fundamentals(symbol).then((f) => { if (alive) { setFund(f); onSector(symbol, f.sector) } })
    window.atlis.finance.news(symbol).then((n) => { if (alive) setNews(n) })
    return () => { alive = false }
  }, [symbol])

  // Load chart on symbol/range change; snapshot history for favorites.
  useEffect(() => {
    let alive = true
    const r = RANGES.find((x) => x.id === rangeId)!
    setLoadingChart(true)
    window.atlis.finance.chart(symbol, r.range, r.interval)
      .then((s) => { if (alive) setSeries(s) })
      .catch(() => { if (alive) setSeries(null) })
      .finally(() => { if (alive) setLoadingChart(false) })
    return () => { alive = false }
  }, [symbol, rangeId])

  useEffect(() => {
    if (isFavorite && quote?.price != null) {
      window.atlis.finance.appendHistory(symbol, {
        price: quote.price, change_pct: quote.dayChangePct, volume: quote.volume
      }).catch(() => {})
    }
  }, [symbol, isFavorite, quote?.price])

  // Lazy-load providers for the analysis tab.
  useEffect(() => {
    if (tab !== 'analysis' || models.length) return
    ;(async () => {
      const ids = await window.atlis.providers.list()
      const all: ModelInfo[] = []
      for (const id of ids) {
        const res = await window.atlis.providers.models(id)
        if (res.ok && res.models) all.push(...res.models)
      }
      setModels(all)
      if (all.length) { setModelId(all[0].id); setProviderId(all[0].provider) }
    })()
  }, [tab])

  const chartData = useMemo(() => {
    if (!series) return []
    const sma50 = sma(series.close, 50)
    const sma200 = sma(series.close, 200)
    return series.timestamps.map((t, i) => ({
      t, date: new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: rangeId === 'ALL' || rangeId === '1Y' ? '2-digit' : undefined }),
      close: series.close[i], sma50: sma50[i], sma200: sma200[i], volume: series.volume[i]
    }))
  }, [series, rangeId])

  // Derived technical sentiment from price vs moving averages + momentum.
  const sentiment = useMemo(() => {
    if (!series) return null
    const closes = series.close.filter((c): c is number => c != null)
    if (closes.length < 60) return null
    const sma50arr = sma(series.close, 50)
    const sma200arr = sma(series.close, 200)
    const last = closes[closes.length - 1]
    const s50 = sma50arr.filter((c): c is number => c != null).at(-1) ?? null
    const s200 = sma200arr.filter((c): c is number => c != null).at(-1) ?? null
    const mom = closes.length > 21 ? ((last - closes[closes.length - 22]) / closes[closes.length - 22]) * 100 : 0
    let score = 50
    if (s50 != null) score += last > s50 ? 12 : -12
    if (s200 != null) score += last > s200 ? 12 : -12
    if (s50 != null && s200 != null) score += s50 > s200 ? 10 : -10
    score += Math.max(-16, Math.min(16, mom * 1.5))
    score = Math.round(Math.max(0, Math.min(100, score)))
    const label = score >= 70 ? 'Bullish' : score >= 55 ? 'Mildly Bullish' : score > 45 ? 'Neutral' : score > 30 ? 'Mildly Bearish' : 'Bearish'
    // rolling trend-score history for the mini chart
    const history = series.timestamps.map((t, i) => {
      const c = series.close[i]
      if (c == null) return null
      let v = 50
      if (sma50arr[i] != null) v += c > (sma50arr[i] as number) ? 18 : -18
      if (sma200arr[i] != null) v += c > (sma200arr[i] as number) ? 18 : -18
      return { t, date: new Date(t).toLocaleDateString(undefined, { month: 'short', day: '2-digit' }), score: Math.max(0, Math.min(100, v)) }
    }).filter(Boolean) as { t: number; date: string; score: number }[]
    return { score, label, s50, s200, mom, history }
  }, [series])

  const peers = useMemo(() => {
    const sec = fund?.sector ?? sectors[symbol]
    if (!sec) return []
    return Object.values(allQuotes)
      .filter((q) => q.symbol !== symbol && sectors[q.symbol] === sec)
      .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
      .slice(0, 4)
  }, [fund, sectors, allQuotes, symbol])

  const generate = async () => {
    if (!modelId || !providerId) return setAnalysisErr('No model available — add a provider key in Settings.')
    const persona = PERSONAS.find((p) => p.id === personaId)!
    setAnalyzing(true); setAnalysisErr('')
    const ctx = [
      `Ticker: ${symbol}${fund?.longName ? ` (${fund.longName})` : ''}`,
      fund?.sector ? `Sector: ${fund.sector}${fund.industry ? ` / ${fund.industry}` : ''}` : '',
      quote ? `Price $${fmtPrice(quote.price)} | Day ${fmtPct(quote.dayChangePct)} | Week ${fmtPct(quote.weekChangePct)} | Year ${fmtPct(quote.yearChangePct)}` : '',
      quote ? `52wk range $${fmtPrice(quote.fiftyTwoWeekLow)}–$${fmtPrice(quote.fiftyTwoWeekHigh)} | Volume ${fmtCompact(quote.volume)}` : '',
      `Market cap ${fmtCompact(fund?.marketCap ?? quote?.marketCap)} | P/E ${fmtPrice(fund?.trailingPE ?? quote?.trailingPE)} | Fwd P/E ${fmtPrice(fund?.forwardPE)} | P/B ${fmtPrice(fund?.priceToBook ?? quote?.priceToBook)}`,
      `D/E ${fmtPrice(fund?.debtToEquity)} | EPS ${fmtPrice(fund?.eps)} | Margin ${fund?.profitMargins != null ? (fund.profitMargins * 100).toFixed(1) + '%' : '—'} | Rev growth ${fund?.revenueGrowth != null ? (fund.revenueGrowth * 100).toFixed(1) + '%' : '—'}`,
      fund?.targetMeanPrice ? `Analyst target $${fmtPrice(fund.targetMeanPrice)} (${fund.recommendationKey ?? 'n/a'})` : '',
      sentiment ? `Technical read: price ${sentiment.s50 != null && quote?.price != null ? (quote.price > sentiment.s50 ? 'above' : 'below') : '?'} SMA50, trend score ${sentiment.score}/100 (${sentiment.label}), 1mo momentum ${sentiment.mom.toFixed(1)}%` : '',
      news.length ? `Recent headlines:\n${news.slice(0, 6).map((n) => `- ${n.title}`).join('\n')}` : ''
    ].filter(Boolean).join('\n')
    const res = await window.atlis.finance.analyze({
      provider: providerId, model: modelId,
      system: persona.system + ANALYSIS_SYSTEM_SUFFIX,
      prompt: `Analyze ${symbol} as ${persona.name}. Use only the data below.\n\n${ctx}`
    })
    setAnalyzing(false)
    if (!res.ok || !res.text) return setAnalysisErr(res.error || 'Analysis failed.')
    setAnalysisMd(res.text)
    const html = await window.atlis.docs.toHtml(res.text)
    setAnalysisHtml(html)
    log({ event: 'deep_analysis', symbol, persona: persona.name, provider: providerId, model: modelId })
  }

  const saveReport = async () => {
    if (!quote || !fund) return flash('Data still loading.')
    const persona = PERSONAS.find((p) => p.id === personaId)!
    const html = equityResearchHtml({ q: quote, f: fund, news, persona: persona.name, analysisHtml: analysisHtml || undefined })
    const title = `Equity Research — ${symbol} — ${new Date().toISOString().slice(0, 10)}`
    const doc = await saveDoc(title, html)
    await window.atlis.planner.reminders.create({ title: `Research ready: ${symbol} analysis`, remind_at: Date.now() + 60_000 })
    log({ event: 'document_saved', title, doc_id: doc.id, symbol })
    flash('Saved to Documents + reminder set.')
  }

  const statGrid = (rows: [string, string, string?][]) => (
    <div className="grid grid-cols-2 gap-x-8 gap-y-2 md:grid-cols-3">
      {rows.map(([k, v, cls]) => (
        <div key={k} className="flex items-center justify-between border-b border-[var(--fin-border)] py-1">
          <span className="fin-sublabel">{k}</span>
          <span className={`fin-mono text-[12.5px] ${cls ?? ''}`}>{v}</span>
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* quote bar */}
      <div className="flex items-center gap-4 border-b border-[var(--fin-border)] bg-[var(--fin-bg-surface)] px-4 py-2">
        <button onClick={onClose} className="text-[var(--fin-text-2)] hover:text-[var(--fin-text-1)]"><X size={16} /></button>
        <span className="fin-mono text-lg font-bold text-[var(--fin-amber)]">{symbol}</span>
        <span className="text-[12px] text-[var(--fin-text-2)]">{fund?.longName ?? quote?.shortName ?? ''}</span>
        <span className="fin-mono text-lg">{quote?.price != null ? '$' + fmtPrice(quote.price) : '—'}</span>
        <span className={`fin-mono ${dir(quote?.dayChangePct)}`}>
          {quote?.dayChange != null ? `${quote.dayChange >= 0 ? '▲' : '▼'} ${fmtPrice(Math.abs(quote.dayChange))}` : ''} {fmtPct(quote?.dayChangePct)}
        </span>
        <span className="fin-sublabel">VOL {fmtCompact(quote?.volume)}</span>
        <span className="fin-sublabel">H {fmtPrice(quote?.dayHigh)} · L {fmtPrice(quote?.dayLow)}</span>
        <span className="fin-sublabel">MKT {fmtCompact(quote?.marketCap)}</span>
        <div className="flex-1" />
        {toast && <span className="text-[11px] text-[var(--fin-positive)]">{toast}</span>}
        <button onClick={() => onToggleFavorite(symbol)} title="Favorite" className={isFavorite ? 'text-[var(--fin-amber)]' : 'text-[var(--fin-text-3)] hover:text-[var(--fin-amber)]'}>
          <Star size={15} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>
        <button onClick={onOpenCalc} title="Trade Calculator" className="text-[var(--fin-text-2)] hover:text-[var(--fin-amber)]"><Calculator size={15} /></button>
        <button onClick={saveReport} title="Save research document" className="text-[var(--fin-text-2)] hover:text-[var(--fin-amber)]"><FileText size={15} /></button>
      </div>

      {/* tabs */}
      <div className="flex border-b border-[var(--fin-border)] bg-[var(--fin-bg-surface)] px-2">
        {TABS.map((t) => (
          <button key={t.id} className={`fin-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'overview' && quote && statGrid([
          ['Price', '$' + fmtPrice(quote.price)],
          ['Day Change', fmtPct(quote.dayChangePct), dir(quote.dayChangePct)],
          ['Week Change', fmtPct(quote.weekChangePct), dir(quote.weekChangePct)],
          ['Year Change', fmtPct(quote.yearChangePct), dir(quote.yearChangePct)],
          ['Open', '$' + fmtPrice(quote.open)],
          ['Prev Close', '$' + fmtPrice(quote.previousClose)],
          ['Day Range', `$${fmtPrice(quote.dayLow)} – $${fmtPrice(quote.dayHigh)}`],
          ['52wk Range', `$${fmtPrice(quote.fiftyTwoWeekLow)} – $${fmtPrice(quote.fiftyTwoWeekHigh)}`],
          ['Volume', fmtCompact(quote.volume)],
          ['Market Cap', fmtCompact(fund?.marketCap ?? quote.marketCap)],
          ['Sector', fund?.sector ?? '—'],
          ['Industry', fund?.industry ?? '—']
        ])}
        {tab === 'overview' && fund?.summary && (
          <p className="mt-4 max-w-3xl text-[12px] leading-relaxed text-[var(--fin-text-2)]">{fund.summary}</p>
        )}

        {tab === 'technicals' && (
          <div>
            <div className="mb-2 flex gap-1">
              {RANGES.map((r) => (
                <button key={r.id} className={`fin-btn ${rangeId === r.id ? 'fin-btn-amber' : ''}`} onClick={() => setRangeId(r.id)}>{r.id}</button>
              ))}
              {loadingChart && <Loader2 size={14} className="ml-2 animate-spin self-center text-[var(--fin-amber)]" />}
            </div>
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#1e2d45" strokeDasharray="2 4" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} minTickGap={40} />
                  <YAxis yAxisId="p" domain={['auto', 'auto']} tick={{ fontSize: 9, fill: '#94a3b8' }} width={48} />
                  <YAxis yAxisId="v" orientation="right" tick={false} axisLine={false} width={0} domain={[0, (d: number) => d * 4]} />
                  <Tooltip contentStyle={{ background: '#0f1117', border: '1px solid #1e2d45', fontSize: 11 }} labelStyle={{ color: '#f59e0b' }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar yAxisId="v" dataKey="volume" name="Vol" fill="#1e2d45" />
                  <Line yAxisId="p" dataKey="close" name="Price" stroke="#f59e0b" dot={false} strokeWidth={1.5} />
                  <Line yAxisId="p" dataKey="sma50" name="SMA50" stroke="#38bdf8" dot={false} strokeWidth={1} />
                  <Line yAxisId="p" dataKey="sma200" name="SMA200" stroke="#c084fc" dot={false} strokeWidth={1} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {tab === 'financials' && fund && statGrid([
          ['Market Cap', fmtCompact(fund.marketCap)],
          ['Trailing P/E', fmtPrice(fund.trailingPE)],
          ['Forward P/E', fmtPrice(fund.forwardPE)],
          ['Price / Book', fmtPrice(fund.priceToBook)],
          ['Debt / Equity', fmtPrice(fund.debtToEquity)],
          ['EPS (ttm)', fmtPrice(fund.eps)],
          ['Book Value', fmtPrice(fund.bookValue)],
          ['Beta', fmtPrice(fund.beta)],
          ['Dividend Yield', fund.dividendYield != null ? (fund.dividendYield * 100).toFixed(2) + '%' : '—'],
          ['Profit Margin', fund.profitMargins != null ? (fund.profitMargins * 100).toFixed(1) + '%' : '—'],
          ['Revenue Growth', fund.revenueGrowth != null ? (fund.revenueGrowth * 100).toFixed(1) + '%' : '—', dir(fund.revenueGrowth)],
          ['Earnings Growth', fund.earningsGrowth != null ? (fund.earningsGrowth * 100).toFixed(1) + '%' : '—', dir(fund.earningsGrowth)],
          ['Analyst Target', fund.targetMeanPrice != null ? '$' + fmtPrice(fund.targetMeanPrice) : '—'],
          ['Recommendation', fund.recommendationKey ?? '—'],
          ['Next Earnings', fund.earningsTimestamp ? new Date(fund.earningsTimestamp).toLocaleDateString() : '—']
        ])}
        {tab === 'financials' && !fund && <div className="fin-sublabel">Loading fundamentals…</div>}

        {tab === 'peers' && (
          <div>
            <div className="fin-sublabel mb-2">{fund?.sector ? `Sector: ${fund.sector} · watchlist peers` : 'Sector unknown — open more tickers to populate peers.'}</div>
            {peers.length === 0 ? (
              <div className="fin-sublabel">No watchlist peers in this sector yet.</div>
            ) : (
              <table className="w-full text-[11.5px]">
                <thead className="fin-sublabel"><tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-left"><th>Symbol</th><th>Price</th><th>Day%</th><th>P/E</th><th>P/B</th><th>Mkt Cap</th></tr></thead>
                <tbody className="fin-mono">
                  {[quote, ...peers].filter(Boolean).map((q) => (
                    <tr key={q!.symbol} className={`border-t border-[var(--fin-border)] [&>td]:px-2 [&>td]:py-1 ${q!.symbol === symbol ? 'bg-[var(--fin-bg-raised)]' : ''}`}>
                      <td className="font-bold text-[var(--fin-amber)]">{q!.symbol}</td>
                      <td>${fmtPrice(q!.price)}</td>
                      <td className={dir(q!.dayChangePct)}>{fmtPct(q!.dayChangePct)}</td>
                      <td>{fmtPrice(q!.trailingPE)}</td>
                      <td>{fmtPrice(q!.priceToBook)}</td>
                      <td>{fmtCompact(q!.marketCap)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'news' && (
          <div className="flex flex-col gap-2">
            {news.length === 0 && <div className="fin-sublabel">No recent headlines.</div>}
            {news.map((n, i) => (
              <a key={i} href={n.link} target="_blank" rel="noreferrer" className="fin-card block px-3 py-2">
                <div className="text-[12.5px] text-[var(--fin-text-1)]">{n.title}</div>
                <div className="fin-sublabel mt-0.5">{n.publisher ?? ''}{n.publishedAt ? ` · ${new Date(n.publishedAt).toLocaleDateString()}` : ''}</div>
              </a>
            ))}
          </div>
        )}

        {tab === 'sentiment' && (
          sentiment ? (
            <div>
              <div className="mb-3 flex items-center gap-4">
                <span className="fin-mono text-3xl font-bold fin-amber">{sentiment.score}</span>
                <div>
                  <div className="fin-label" style={{ color: sentiment.score >= 55 ? 'var(--fin-positive)' : sentiment.score <= 45 ? 'var(--fin-negative)' : 'var(--fin-amber)' }}>{sentiment.label}</div>
                  <div className="fin-sublabel">Technical trend score · price vs SMA50/200 + 1mo momentum {sentiment.mom.toFixed(1)}%</div>
                </div>
              </div>
              <div style={{ height: 180 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={sentiment.history} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#1e2d45" strokeDasharray="2 4" />
                    <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} minTickGap={50} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#94a3b8' }} width={28} />
                    <Tooltip contentStyle={{ background: '#0f1117', border: '1px solid #1e2d45', fontSize: 11 }} />
                    <Line dataKey="score" name="Trend score" stroke="#22d3ee" dot={false} strokeWidth={1.5} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : <div className="fin-sublabel">Not enough history to compute sentiment.</div>
        )}

        {tab === 'analysis' && (
          <div className="max-w-3xl">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <select className="fin-input" value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
                {PERSONAS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select className="fin-input" value={modelId} onChange={(e) => {
                const m = models.find((x) => x.id === e.target.value); setModelId(e.target.value); if (m) setProviderId(m.provider)
              }}>
                {models.length === 0 && <option value="">No models — set a key in Settings</option>}
                {models.map((m) => <option key={`${m.provider}:${m.id}`} value={m.id}>{m.label}</option>)}
              </select>
              <button className="fin-btn fin-btn-amber" onClick={generate} disabled={analyzing || !modelId}>
                {analyzing ? <><Loader2 size={12} className="mr-1 inline animate-spin" />Analyzing…</> : 'Generate Analysis'}
              </button>
              {analysisHtml && <button className="fin-btn" onClick={saveReport}><FileText size={11} className="mr-1 inline" />Save Report</button>}
            </div>
            <p className="fin-sublabel mb-3">{PERSONAS.find((p) => p.id === personaId)?.blurb}</p>
            {analysisErr && <div className="mb-3 rounded border border-[var(--fin-negative)] px-3 py-2 text-[11.5px] text-[var(--fin-negative)]">{analysisErr}</div>}
            {analysisHtml
              ? <div className="prose-atlis text-[13px]" dangerouslySetInnerHTML={{ __html: sanitizeHtml(analysisHtml) }} />
              : !analyzing && <div className="fin-sublabel flex items-center gap-1.5"><Bell size={12} /> Pick a persona + model, then generate. Saving files the report to ATLIS Documents and sets a reminder.</div>}
          </div>
        )}
      </div>
    </div>
  )
}
