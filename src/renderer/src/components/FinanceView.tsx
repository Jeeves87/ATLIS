import { useEffect, useMemo, useState, useCallback } from 'react'
import { RefreshCw, Star, Calculator, Brain, Search, FileDown, ScrollText, X, Loader2 } from 'lucide-react'
import type { Quote, Watchlist, Portfolio, FinanceSettings } from '../types'
import MarketPulse from './finance/MarketPulse'
import DeepDive from './finance/DeepDive'
import TradeCalculator from './finance/TradeCalculator'
import PortfolioPanel from './finance/PortfolioPanel'
import {
  fmtPrice, fmtPct, fmtCompact, dir, computeFearGreed, BREADTH_BASKET, INDEX_SYMBOLS,
  SNAPSHOT_SYMBOLS, dailySummaryHtml, saveDoc, log, type FearGreed
} from './finance/api'

type Strategy = 'all' | 'gainers' | 'losers' | 'movers'

const isUndervalued = (q: Quote) =>
  (q.trailingPE != null && q.trailingPE > 0 && q.trailingPE < 18) ||
  (q.priceToBook != null && q.priceToBook > 0 && q.priceToBook < 2)

export default function FinanceView() {
  const [watchlist, setWatchlist] = useState<Watchlist>({ tickers: [], last_synced: null })
  const [portfolio, setPortfolio] = useState<Portfolio>({ holdings: [] })
  const [settings, setSettings] = useState<FinanceSettings>({ account_size: 10000, risk_pct: 1, show_ticker_tape: true })
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [sectors, setSectors] = useState<Record<string, string | null>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [calcOpen, setCalcOpen] = useState(false)
  const [calcSymbol, setCalcSymbol] = useState('')
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // filters
  const [strategy, setStrategy] = useState<Strategy>('all')
  const [sectorFilter, setSectorFilter] = useState('all')
  const [favOnly, setFavOnly] = useState(false)
  const [undervaluedOnly, setUndervaluedOnly] = useState(false)
  const [search, setSearch] = useState('')

  // panels
  const [showActivity, setShowActivity] = useState(false)
  const [activity, setActivity] = useState<Record<string, unknown>[]>([])
  const [addSym, setAddSym] = useState('')

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2200) }

  const watchSymbols = useMemo(() => watchlist.tickers.map((t) => t.symbol), [watchlist])
  const portfolioSymbols = useMemo(() => portfolio.holdings.map((h) => h.symbol), [portfolio])

  const refresh = useCallback(async (wl = watchlist, pf = portfolio) => {
    setLoading(true)
    const all = Array.from(new Set([
      ...wl.tickers.map((t) => t.symbol), ...pf.holdings.map((h) => h.symbol),
      ...BREADTH_BASKET, ...INDEX_SYMBOLS, ...SNAPSHOT_SYMBOLS
    ]))
    try {
      const rows = await window.atlis.finance.quotes(all)
      const map: Record<string, Quote> = {}
      for (const q of rows) map[q.symbol] = q
      setQuotes((prev) => ({ ...prev, ...map }))
      // week/year change for the watchlist (capped chart calls)
      const wsyms = wl.tickers.map((t) => t.symbol)
      window.atlis.finance.enrich(wsyms).then((enr) => {
        setQuotes((prev) => {
          const next = { ...prev }
          for (const s of wsyms) if (next[s] && enr[s]) next[s] = { ...next[s], ...enr[s] }
          return next
        })
      }).catch(() => {})
      const synced = new Date().toISOString()
      setWatchlist((w) => { const nw = { ...w, last_synced: synced }; window.atlis.finance.setWatchlist(nw); return nw })
      log({ event: 'sync', tickers: wsyms, status: 'ok' })
    } catch (err) {
      flash('Sync failed — check connection.')
      log({ event: 'sync', status: 'error', error: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoading(false)
    }
  }, [watchlist, portfolio])

  // initial load
  useEffect(() => {
    window.atlis.finance.state().then((st) => {
      setWatchlist(st.watchlist); setPortfolio(st.portfolio); setSettings(st.settings)
      refresh(st.watchlist, st.portfolio)
    })
  }, [])

  // derived market context
  const vix = quotes['^VIX']?.price ?? null
  const fearGreed: FearGreed | null = useMemo(() => {
    const basket = BREADTH_BASKET.map((s) => quotes[s]).filter(Boolean) as Quote[]
    return basket.length ? computeFearGreed(basket, vix) : null
  }, [quotes, vix])
  const indices = useMemo(() => INDEX_SYMBOLS.map((s) => quotes[s]).filter(Boolean) as Quote[], [quotes])
  const snapshot = useMemo(() => SNAPSHOT_SYMBOLS.map((s) => quotes[s]).filter(Boolean) as Quote[], [quotes])
  const moversPool = useMemo(() => {
    const set = new Set([...watchSymbols, ...BREADTH_BASKET])
    return Array.from(set).map((s) => quotes[s]).filter((q): q is Quote => !!q && q.dayChangePct != null)
  }, [quotes, watchSymbols])
  const gainers = useMemo(() => [...moversPool].sort((a, b) => (b.dayChangePct ?? 0) - (a.dayChangePct ?? 0)).slice(0, 3), [moversPool])
  const losers = useMemo(() => [...moversPool].sort((a, b) => (a.dayChangePct ?? 0) - (b.dayChangePct ?? 0)).slice(0, 3), [moversPool])

  const knownSectors = useMemo(() => Array.from(new Set(Object.values(sectors).filter(Boolean) as string[])).sort(), [sectors])

  // screener
  const cards = useMemo(() => {
    let rows = watchlist.tickers.map((t) => ({ t, q: quotes[t.symbol] }))
    if (favOnly) rows = rows.filter((r) => r.t.is_favorite)
    if (undervaluedOnly) rows = rows.filter((r) => r.q && isUndervalued(r.q))
    if (sectorFilter !== 'all') rows = rows.filter((r) => sectors[r.t.symbol] === sectorFilter)
    if (search.trim()) {
      const s = search.trim().toLowerCase()
      rows = rows.filter((r) => r.t.symbol.toLowerCase().includes(s) || (r.q?.shortName ?? '').toLowerCase().includes(s))
    }
    const sd = (r: { q?: Quote }) => r.q?.dayChangePct ?? 0
    if (strategy === 'gainers') rows = rows.filter((r) => sd(r) > 0).sort((a, b) => sd(b) - sd(a))
    else if (strategy === 'losers') rows = rows.filter((r) => sd(r) < 0).sort((a, b) => sd(a) - sd(b))
    else if (strategy === 'movers') rows = [...rows].sort((a, b) => Math.abs(sd(b)) - Math.abs(sd(a)))
    return rows
  }, [watchlist, quotes, sectors, favOnly, undervaluedOnly, sectorFilter, search, strategy])

  // actions
  const recordSector = useCallback((symbol: string, sector: string | null) => setSectors((p) => ({ ...p, [symbol]: sector })), [])

  const toggleFavorite = useCallback((symbol: string) => {
    setWatchlist((w) => {
      const nw = { ...w, tickers: w.tickers.map((t) => t.symbol === symbol ? { ...t, is_favorite: !t.is_favorite } : t) }
      window.atlis.finance.setWatchlist(nw)
      return nw
    })
  }, [])

  const addTicker = async () => {
    const s = addSym.trim().toUpperCase()
    if (!s) return
    if (watchlist.tickers.some((t) => t.symbol === s)) { setAddSym(''); return flash('Already on the watchlist.') }
    const nw: Watchlist = { ...watchlist, tickers: [...watchlist.tickers, { symbol: s, added: new Date().toISOString().slice(0, 10), is_favorite: false, notes: '', tags: [], trade_plans: [] }] }
    setWatchlist(nw); setAddSym('')
    await window.atlis.finance.setWatchlist(nw)
    const rows = await window.atlis.finance.quotes([s])
    if (rows[0]) setQuotes((p) => ({ ...p, [s]: rows[0] }))
    window.atlis.finance.enrich([s]).then((enr) => setQuotes((p) => p[s] && enr[s] ? { ...p, [s]: { ...p[s], ...enr[s] } } : p))
  }

  const removeTicker = (symbol: string) => {
    const nw: Watchlist = { ...watchlist, tickers: watchlist.tickers.filter((t) => t.symbol !== symbol) }
    setWatchlist(nw); window.atlis.finance.setWatchlist(nw)
    if (selected === symbol) setSelected(null)
  }

  const updatePortfolio = (holdings: Portfolio['holdings']) => {
    const np = { holdings }; setPortfolio(np); window.atlis.finance.setPortfolio(np)
    if (holdings.some((h) => !quotes[h.symbol])) refresh(watchlist, np)
  }

  const persistSettings = (account_size: number, risk_pct: number) => {
    const ns = { ...settings, account_size, risk_pct }; setSettings(ns); window.atlis.finance.setSettings(ns)
  }
  const toggleTape = () => {
    const ns = { ...settings, show_ticker_tape: !settings.show_ticker_tape }; setSettings(ns); window.atlis.finance.setSettings(ns)
  }

  const openCalcFor = (symbol: string) => { setCalcSymbol(symbol); setCalcOpen(true) }

  const saveDailySummary = async () => {
    if (!fearGreed) return flash('Market data still loading.')
    const html = dailySummaryHtml({ fearGreed, indices, snapshot, gainers, losers })
    const doc = await saveDoc(`Daily Market Summary — ${new Date().toISOString().slice(0, 10)}`, html)
    log({ event: 'daily_summary', fear_greed: fearGreed.score, top_gainer: gainers[0]?.symbol, top_loser: losers[0]?.symbol, doc_id: doc.id })
    flash('Daily summary saved to Documents.')
  }

  const openActivity = async () => {
    setShowActivity((s) => !s)
    if (!showActivity) setActivity(await window.atlis.finance.activity(20))
  }

  const tapeItems = useMemo(() => [...INDEX_SYMBOLS, ...watchSymbols].map((s) => quotes[s]).filter(Boolean) as Quote[], [quotes, watchSymbols])

  return (
    <div className="fin relative flex min-h-0 flex-1 flex-col">
      {/* ticker tape */}
      {settings.show_ticker_tape && tapeItems.length > 0 && (
        <div className="overflow-hidden border-b border-[var(--fin-border)] bg-[var(--fin-bg-base)] py-1">
          <div className="fin-marquee-track">
            {[...tapeItems, ...tapeItems].map((q, i) => (
              <span key={i} className="mx-4 inline-flex items-center gap-1.5 text-[11px]">
                <span className="fin-mono font-semibold">{q.symbol}</span>
                <span className="fin-mono">{fmtPrice(q.price)}</span>
                <span className={`fin-mono ${dir(q.dayChangePct)}`}>{fmtPct(q.dayChangePct)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* header */}
      <header className="flex items-center gap-3 border-b border-[var(--fin-border)] bg-[var(--fin-bg-surface)] px-4 py-2">
        <span className="fin-label text-[12px]">⬡ Market Intelligence</span>
        <span className="fin-sublabel">{new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        {watchlist.last_synced && <span className="fin-sublabel">· synced {new Date(watchlist.last_synced).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}
        <div className="flex-1" />
        {toast && <span className="text-[11px] text-[var(--fin-positive)]">{toast}</span>}
        <button className="fin-btn" onClick={toggleTape} title="Toggle ticker tape">Tape {settings.show_ticker_tape ? 'On' : 'Off'}</button>
        <button className="fin-btn" onClick={openActivity}><ScrollText size={12} className="mr-1 inline" />Activity</button>
        <button className="fin-btn" onClick={saveDailySummary}><FileDown size={12} className="mr-1 inline" />Daily Summary</button>
        <button className="fin-btn fin-btn-amber" onClick={() => refresh()} disabled={loading}>
          {loading ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : <RefreshCw size={12} className="mr-1 inline" />}Refresh
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <MarketPulse fearGreed={fearGreed} indices={indices} snapshot={snapshot} gainers={gainers} losers={losers} onPick={setSelected} />

        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {selected ? (
            <DeepDive
              symbol={selected}
              quote={quotes[selected]}
              isFavorite={watchlist.tickers.find((t) => t.symbol === selected)?.is_favorite ?? false}
              sectors={sectors}
              allQuotes={quotes}
              onClose={() => setSelected(null)}
              onToggleFavorite={toggleFavorite}
              onOpenCalc={() => openCalcFor(selected)}
              onSector={recordSector}
            />
          ) : (
            <div className="p-3">
              {/* filter bar */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="flex overflow-hidden rounded border border-[var(--fin-border)]">
                  {(['all', 'gainers', 'losers', 'movers'] as Strategy[]).map((s) => (
                    <button key={s} className={`fin-tab !border-b-0 ${strategy === s ? 'active !border-b-2' : ''}`} onClick={() => setStrategy(s)}>{s}</button>
                  ))}
                </div>
                <select className="fin-input" value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}>
                  <option value="all">All sectors</option>
                  {knownSectors.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button className={`fin-btn ${undervaluedOnly ? 'fin-btn-amber' : ''}`} onClick={() => setUndervaluedOnly((v) => !v)}>Undervalued</button>
                <button className={`fin-btn ${favOnly ? 'fin-btn-amber' : ''}`} onClick={() => setFavOnly((v) => !v)}><Star size={11} className="mr-1 inline" />Favorites</button>
                <label className="flex items-center gap-1 rounded border border-[var(--fin-border)] px-2">
                  <Search size={12} className="text-[var(--fin-text-3)]" />
                  <input className="bg-transparent py-1 text-[11px] outline-none" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
                </label>
                <div className="flex-1" />
                <label className="flex items-center gap-1 rounded border border-[var(--fin-border)] px-2">
                  <input className="w-16 bg-transparent py-1 text-[11px] uppercase outline-none" placeholder="ADD" value={addSym}
                    onChange={(e) => setAddSym(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTicker()} />
                  <button className="fin-amber text-[11px]" onClick={addTicker}>+ Add</button>
                </label>
              </div>

              {/* card grid */}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2.5">
                {cards.map(({ t, q }) => (
                  <div key={t.symbol} onClick={() => setSelected(t.symbol)}
                    className={`fin-card group relative cursor-pointer px-3 py-2.5 ${q && isUndervalued(q) ? 'undervalued' : ''}`}>
                    <div className="flex items-start justify-between">
                      <div>
                        <span className="fin-mono text-[15px] font-bold text-[var(--fin-amber)]">{t.symbol}</span>
                        <div className="fin-sublabel max-w-[150px] truncate normal-case tracking-normal">{q?.shortName ?? '—'}</div>
                      </div>
                      <div className="text-right">
                        <div className="fin-mono text-[15px]">{q?.price != null ? '$' + fmtPrice(q.price) : '—'}</div>
                        <div className={`fin-mono text-[11px] ${dir(q?.dayChangePct)}`}>{fmtPct(q?.dayChangePct)}</div>
                      </div>
                    </div>

                    <div className="mt-2 grid grid-cols-3 gap-1 text-center">
                      {([['D', q?.dayChangePct], ['W', q?.weekChangePct], ['Y', q?.yearChangePct]] as const).map(([k, v]) => (
                        <div key={k} className="rounded bg-[var(--fin-bg-base)] py-1">
                          <div className="fin-sublabel">{k}</div>
                          <div className={`fin-mono text-[11px] ${dir(v)}`}>{fmtPct(v)}</div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1">
                      <span className="fin-chip">P/E {fmtPrice(q?.trailingPE)}</span>
                      <span className="fin-chip">P/B {fmtPrice(q?.priceToBook)}</span>
                      <span className="fin-chip">{fmtCompact(q?.marketCap)}</span>
                      {sectors[t.symbol] && <span className="fin-chip">{sectors[t.symbol]}</span>}
                    </div>

                    <div className="mt-2 flex items-center gap-2 border-t border-[var(--fin-border)] pt-1.5 text-[var(--fin-text-3)]">
                      <button onClick={(e) => { e.stopPropagation(); toggleFavorite(t.symbol) }} title="Favorite"
                        className={t.is_favorite ? 'text-[var(--fin-amber)]' : 'hover:text-[var(--fin-amber)]'}>
                        <Star size={13} fill={t.is_favorite ? 'currentColor' : 'none'} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); openCalcFor(t.symbol) }} title="Trade calculator" className="hover:text-[var(--fin-amber)]"><Calculator size={13} /></button>
                      <button onClick={(e) => { e.stopPropagation(); setSelected(t.symbol) }} title="Deep dive" className="hover:text-[var(--fin-amber)]"><Brain size={13} /></button>
                      <div className="flex-1" />
                      <button onClick={(e) => { e.stopPropagation(); removeTicker(t.symbol) }} title="Remove" className="opacity-0 hover:text-[var(--fin-negative)] group-hover:opacity-100"><X size={13} /></button>
                    </div>
                  </div>
                ))}
                {cards.length === 0 && (
                  <div className="fin-sublabel col-span-full py-10 text-center">No tickers match. Add one above or clear filters.</div>
                )}
              </div>

              <PortfolioPanel holdings={portfolio.holdings} quotes={quotes} onChange={updatePortfolio} onPick={setSelected} />
            </div>
          )}
        </div>
      </div>

      {/* activity log drawer */}
      {showActivity && (
        <div className="absolute right-3 top-12 z-30 max-h-[60vh] w-96 overflow-y-auto fin-panel-box p-2 shadow-xl">
          <div className="mb-1 flex items-center justify-between">
            <span className="fin-label">Activity Log</span>
            <button onClick={() => setShowActivity(false)}><X size={13} className="text-[var(--fin-text-2)]" /></button>
          </div>
          {activity.length === 0 && <div className="fin-sublabel px-1 py-2">No activity yet.</div>}
          {activity.map((e, i) => (
            <div key={i} className="border-b border-[var(--fin-border)] py-1 font-mono text-[10px] text-[var(--fin-text-2)]">
              <span className="fin-amber">{String(e.event ?? 'event')}</span>{' '}
              <span className="text-[var(--fin-text-3)]">{e.ts ? new Date(String(e.ts)).toLocaleTimeString() : ''}</span>
              <div className="truncate">{Object.entries(e).filter(([k]) => k !== 'event' && k !== 'ts').map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</div>
            </div>
          ))}
        </div>
      )}

      <TradeCalculator
        open={calcOpen} onClose={() => setCalcOpen(false)} symbol={calcSymbol}
        prefillEntry={quotes[calcSymbol]?.price ?? null}
        accountSize={settings.account_size} riskPct={settings.risk_pct}
        onAccountChange={persistSettings} onSaved={() => { /* refresh planner views happen via planner:changed */ }}
      />
    </div>
  )
}
