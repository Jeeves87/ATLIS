import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bell, BellOff, ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import ProductThumb from '../mtg/ProductThumb'
import TcgLightbox from './TcgLightbox'
import { ago, cardImage, clean, money, num, type Tone } from './tcgUi'
import type { TcgGame, TcgHistoryPoint, TcgPrinting, TcgWatch } from '../../types'

/**
 * The Magic page's Watchlist tab when another game is picked: that game's
 * watches, each with a picture that opens the same preview as search.
 *
 * A watch is ONE printing. Prices are TCGplayer Market Price (recent sales);
 * the listed median sits beside it only while copies are actually for sale.
 */
export default function TcgWatchlist({ game, onChanged }: { game: TcgGame; onChanged: () => Promise<void> | void }) {
  const [watches, setWatches] = useState<TcgWatch[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Tone | null>(null)
  const [preview, setPreview] = useState<TcgWatch | null>(null)

  const load = useCallback(async () => {
    setWatches(await window.atlis.tcg.watches(game.url))
  }, [game.url])

  useEffect(() => {
    void load()
    return window.atlis.tcg.onChanged(() => void load())
  }, [load])

  const watched = useMemo(() => new Set(watches.map((w) => `${w.product_id}:${w.printing}`)), [watches])
  const refresh = async (): Promise<void> => {
    await load()
    await onChanged()
  }

  async function checkAll(): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.atlis.tcg.check({ game: game.url })
      setMsg({
        tone: r.errors.length ? 'bad' : 'ok',
        text: `Checked ${r.checked} · ${r.changed} changed${r.errors.length ? ` · ${r.errors.length} failed` : ''}`
      })
      await refresh()
    } catch (err) {
      setMsg({ tone: 'bad', text: clean(err) })
    } finally {
      setBusy(false)
    }
  }

  async function trackOther(w: TcgWatch, printing: TcgPrinting): Promise<void> {
    await window.atlis.tcg.add({
      productId: w.product_id,
      printing,
      game: game.url,
      gameLabel: w.game_label,
      kind: w.kind,
      name: w.name,
      set: w.set_name,
      rarity: w.rarity
    })
    await refresh()
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">Watchlist — {game.label}</h2>
        {msg && <span className={`text-[11px] ${msg.tone === 'ok' ? 'text-emerald-300' : 'text-rose-300'}`}>{msg.text}</span>}
        <button
          onClick={() => void checkAll()}
          disabled={busy || !watches.length}
          className="ml-auto flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Check prices
        </button>
      </div>

      {watches.length === 0 ? (
        <p className="text-sm text-white/40">
          Nothing tracked in {game.label} yet. Find something on the Search tab and hit Track. Something with no copies
          listed — an upcoming set — is tracked as &ldquo;not listed&rdquo; and alerts you when the first copies appear.
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,600px),1fr))] items-start gap-1.5">
          {watches.map((w) => (
            <WatchRow
              key={w.id}
              w={w}
              open={open === w.id}
              onToggle={() => setOpen((o) => (o === w.id ? null : w.id))}
              onPreview={() => setPreview(w)}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      {preview && (
        <TcgLightbox
          product={{
            productId: preview.product_id,
            name: preview.name,
            set: preview.set_name,
            rarity: preview.rarity,
            sealed: preview.kind === 'sealed'
          }}
          game={game}
          watched={watched}
          onTrack={(pr) => trackOther(preview, pr)}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  )
}

function WatchRow({
  w,
  open,
  onToggle,
  onPreview,
  onChanged
}: {
  w: TcgWatch
  open: boolean
  onToggle: () => void
  onPreview: () => void
  onChanged: () => Promise<void>
}) {
  const [target, setTarget] = useState(w.target_price != null ? String(w.target_price) : '')
  const [busy, setBusy] = useState(false)
  const sealed = w.kind === 'sealed'
  const atTarget = w.target_price != null && w.last_price != null && w.last_price <= w.target_price + 1e-9 && w.last_in_stock === 1

  async function saveTarget(): Promise<void> {
    const t = num(target)
    if (t === w.target_price) return
    await window.atlis.tcg.update(w.id, { target_price: t })
    await onChanged()
  }

  async function check(): Promise<void> {
    setBusy(true)
    try {
      await window.atlis.tcg.check({ id: w.id })
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(`Stop tracking ${w.name}${w.printing === 'Foil' ? ' (foil)' : ''}? Its price history goes with it.`)) return
    await window.atlis.tcg.remove(w.id)
    await onChanged()
  }

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02]">
      <div className="flex items-center gap-3 px-2.5 py-2">
        <button onClick={onToggle} className="text-white/30 hover:text-white/70" title="Price history">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        {/* ProductThumb renders its own button when given onClick — no wrapper, or buttons nest. */}
        <ProductThumb image={cardImage(w.product_id, 'small', sealed)} alt={w.name} size="md" onClick={onPreview} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] text-white/85">{w.name}</span>
            {w.printing === 'Foil' && !sealed && (
              <span className="rounded border border-violet-400/30 bg-violet-500/10 px-1 text-[9.5px] text-violet-200">foil</span>
            )}
            {sealed && <span className="rounded border border-white/10 px-1 text-[9.5px] text-white/40">sealed</span>}
            <a
              href={`https://www.tcgplayer.com/product/${w.product_id}${w.printing === 'Foil' ? '?Printing=Foil' : ''}`}
              target="_blank"
              rel="noreferrer"
              className="text-white/30 hover:text-white/70"
              title="Open on TCGplayer"
            >
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          </div>
          <div className="truncate text-[10.5px] text-white/35">{[w.set_name, w.rarity].filter(Boolean).join(' · ')}</div>
          {w.last_error && (
            <div className="mt-0.5 flex items-start gap-1 text-[10.5px] text-rose-300/80">
              <AlertTriangle className="mt-px h-2.5 w-2.5 shrink-0" />
              {w.last_error}
            </div>
          )}
        </div>

        <div className="w-24 whitespace-nowrap text-right">
          <div className={`text-[13px] tabular-nums ${atTarget ? 'font-semibold text-emerald-300' : 'text-white/80'}`}>{money(w.last_price)}</div>
          <div className="text-[10.5px]">
            {w.last_in_stock === 1 ? (
              <span className="text-white/35">listed ~{money(w.last_median)}</span>
            ) : w.last_in_stock === 0 ? (
              <span className="text-amber-300/80">not listed</span>
            ) : (
              <span className="text-white/30">—</span>
            )}
          </div>
        </div>

        <label className="flex items-center gap-1 text-[10.5px] text-white/40">
          alert ≤
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onBlur={() => void saveTarget()}
            onKeyDown={(e) => e.key === 'Enter' && void saveTarget()}
            placeholder="$"
            className="w-16 rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-[12px] outline-none focus:border-violet-400/50"
          />
        </label>

        <div className="flex items-center gap-1">
          <button
            onClick={async () => {
              await window.atlis.tcg.update(w.id, { notify: w.notify ? 0 : 1 })
              await onChanged()
            }}
            className="rounded border border-white/10 p-1 text-white/55 hover:bg-white/10"
            title={w.notify ? 'Alerts on' : 'Alerts muted'}
          >
            {w.notify ? <Bell className="h-3 w-3 text-violet-300/80" /> : <BellOff className="h-3 w-3" />}
          </button>
          <button
            onClick={() => void check()}
            disabled={busy}
            className="rounded border border-white/10 p-1 text-white/55 hover:bg-white/10 disabled:opacity-40"
            title={`Checked ${ago(w.last_ok_at)}`}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </button>
          <button onClick={() => void remove()} className="rounded border border-white/10 p-1 text-white/55 hover:bg-white/10" title="Stop tracking">
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {open && <History w={w} />}
    </div>
  )
}

/**
 * Market price as a step chart — a quote holds until it moves, and only changes
 * are stored, so a smoothed line would draw prices that never existed. The
 * listed median is dashed and breaks wherever nothing was for sale.
 */
function History({ w }: { w: TcgWatch }) {
  const [points, setPoints] = useState<TcgHistoryPoint[] | null>(null)

  useEffect(() => {
    void window.atlis.tcg.history(w.id).then(setPoints)
  }, [w.id, w.last_price, w.last_median, w.last_in_stock])

  const data = useMemo(() => {
    if (!points?.length) return []
    const last = points[points.length - 1]
    return [...points, { ...last, t: Date.now() }].map((p) => ({ t: p.t, market: p.price, median: p.listed ? p.median : null }))
  }, [points])

  if (points == null) return <div className="px-10 pb-3 text-[11px] text-white/35">Loading history…</div>
  if (points.length < 2) {
    return (
      <div className="px-10 pb-3 text-[11px] text-white/35">
        One reading so far. Only changes are stored, so the chart appears once the price moves.
      </div>
    )
  }
  return (
    <div className="h-44 px-4 pb-3">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.4)' }}
          />
          <YAxis tickFormatter={(v: number) => `$${v}`} tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.4)' }} width={52} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{ background: '#0b0b0f', border: '1px solid rgba(255,255,255,0.1)', fontSize: 11 }}
            labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
            formatter={(v) => money(Number(v))}
          />
          <Line type="stepAfter" dataKey="market" name="market" stroke="#a78bfa" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line
            type="stepAfter"
            dataKey="median"
            name="listed median"
            stroke="rgba(255,255,255,0.45)"
            strokeDasharray="4 3"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
