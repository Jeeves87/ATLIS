import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, Trash2, TrendingUp } from 'lucide-react'
import type { MtgEvRow } from '../../types'
import ProductThumb, { ImageZoom } from './ProductThumb'
import { tcgplayerImage, type ImageRef } from '../../lib/mtgImages'

const money = (v: number | null | undefined): string =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const pct = (v: number | null): string => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`)

const KINDS = ['all', 'pack', 'box', 'case', 'deck', 'bundle'] as const
type Kind = (typeof KINDS)[number]

type Sort = 'net' | 'netAbs' | 'liquid' | 'price' | 'name'

/**
 * The standing expected-value board: what sealed product is worth opening,
 * evaluated in the background instead of one product at a time.
 *
 * The board deliberately shows the MEDIAN next to the mean on simulated rows.
 * A booster box whose mean beats its price while its median does not is a
 * lottery ticket — the average is carried by chase cards most boxes don't
 * contain — and ranking on the mean alone is how people talk themselves into
 * buying cases. Deterministic rows (Commander decks) have no median because
 * their contents are not random; their figure is a fact about today's prices.
 */
export default function EvTab({ onStatus }: { onStatus?: (msg: string | null) => void }): React.JSX.Element {
  const [rows, setRows] = useState<MtgEvRow[]>([])
  const [kind, setKind] = useState<Kind>('all')
  const [positiveOnly, setPositiveOnly] = useState(false)
  const [sort, setSort] = useState<Sort>('net')
  const [busy, setBusy] = useState<null | 'scan' | 'reprice'>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [zoom, setZoom] = useState<{ image: ImageRef; name: string; subtitle: string } | null>(null)

  const load = useCallback(async () => {
    setRows(await window.atlis.mtg.evBoard())
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
    return window.atlis.mtg.onChanged(() => void load())
  }, [load])

  useEffect(() => window.atlis.mtg.onEvProgress((p) => setProgress(p.message)), [])

  async function scan(recompute = false): Promise<void> {
    setBusy('scan')
    setProgress('Starting…')
    try {
      const r = await window.atlis.mtg.evScan({ recompute })
      onStatus?.(
        `EV scan: ${r.evaluated} evaluated, ${r.repriced} repriced, ${r.skipped} skipped across ${r.sets} set(s).` +
          (r.errors.length ? ` ${r.errors[0]}` : '')
      )
      await load()
    } catch (err) {
      onStatus?.(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  async function reprice(): Promise<void> {
    setBusy('reprice')
    try {
      const r = await window.atlis.mtg.evReprice()
      onStatus?.(`Repriced ${r.checked} product(s), ${r.changed} moved.`)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const shown = useMemo(() => {
    let out = rows
    if (kind !== 'all') out = out.filter((r) => r.kind === kind)
    if (positiveOnly) out = out.filter((r) => (r.net_pct ?? -1) > 0)
    const sorted = [...out]
    sorted.sort((a, b) => {
      switch (sort) {
        case 'netAbs':
          return (b.net ?? -1e9) - (a.net ?? -1e9)
        case 'liquid': {
          // Ranks on what's left once bulk is thrown away, which is the only
          // number that survives contact with actually selling the cards.
          const ratio = (r: MtgEvRow): number =>
            r.ev_liquid == null || !r.price ? -1e9 : (r.ev_liquid - r.price) / r.price
          return ratio(b) - ratio(a)
        }
        case 'price':
          return (b.price ?? 0) - (a.price ?? 0)
        case 'name':
          return a.name.localeCompare(b.name)
        default:
          // Unevaluated rows last rather than pretending they're the worst deal.
          return Number(a.net_pct == null) - Number(b.net_pct == null) || (b.net_pct ?? 0) - (a.net_pct ?? 0)
      }
    })
    return sorted
  }, [rows, kind, positiveOnly, sort])

  const positives = rows.filter((r) => (r.net_pct ?? -1) > 0).length

  return (
    <div className="p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">Expected value</h2>
        <span className="text-[11px] text-white/30">
          {rows.length} product{rows.length === 1 ? '' : 's'} · {positives} above cost
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void reprice()}
            disabled={busy !== null || rows.length === 0}
            title="Re-check every price on the board. Cheap — one request per product."
            className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-40"
          >
            {busy === 'reprice' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Reprice
          </button>
          <button
            onClick={() => void scan(false)}
            disabled={busy !== null}
            title="Evaluate sealed product from recent and upcoming sets. Takes a minute or two."
            className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-40"
          >
            {busy === 'scan' && <Loader2 className="h-3 w-3 animate-spin" />}
            Scan
          </button>
          <button
            onClick={() => void scan(true)}
            disabled={busy !== null}
            title="Re-simulate everything from scratch, not just re-price it. Slow."
            className="rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/40 hover:bg-white/10 disabled:opacity-40"
          >
            Recompute
          </button>
        </div>
      </div>

      {progress && (
        <p className="mb-3 truncate rounded-md border border-violet-400/20 bg-violet-500/10 px-2.5 py-1.5 text-[11px] text-violet-200">
          {progress}
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-white/10">
          {KINDS.map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`px-2 py-1 text-[11px] capitalize ${
                kind === k ? 'bg-violet-500/25 text-violet-200' : 'text-white/40 hover:bg-white/5'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <button
          onClick={() => setPositiveOnly(!positiveOnly)}
          className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] ${
            positiveOnly ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200' : 'border-white/10 text-white/45 hover:bg-white/5'
          }`}
        >
          <TrendingUp className="h-3 w-3" /> Above cost only
        </button>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] outline-none focus:border-violet-400/50"
        >
          <option value="net" className="bg-neutral-900">Best return %</option>
          <option value="netAbs" className="bg-neutral-900">Biggest $ gap</option>
          <option value="liquid" className="bg-neutral-900">Best return, ≥$2 cards only</option>
          <option value="price" className="bg-neutral-900">Most expensive</option>
          <option value="name" className="bg-neutral-900">Name</option>
        </select>
      </div>

      <p className="mb-4 text-[11px] leading-relaxed text-white/30">
        <strong className="text-white/50">Return is measured against the median</strong> — what a typical single unit
        returns — not the mean, which is set by how often a four-figure chase card turns up and is the least reliable
        part of the model. Rows marked <strong className="text-white/50">sheets</strong> are simulated from the
        set&apos;s real published print sheets — every card carries its own weight, so a 1-in-1,667 chase printing is
        drawn at 1-in-1,667 rather than at its rarity&apos;s average. Rows marked{' '}
        <strong className="text-white/50">approx</strong> come from a set that hasn&apos;t published sheets yet and
        fall back to a slot-and-rarity estimate. Card prices are retail asks — a buylist realises roughly half — and
        totals count bulk at face value, which flatters anything mostly made of it: a beginner box&apos;s largest
        line items are basic lands. The <strong className="text-white/50">≥$2</strong> figure under each exact total
        is what remains once bulk is dropped; sort by it to rank on what you could realistically sell. Prices refresh daily;
        the simulation is only redone when you hit Scan or Recompute.
      </p>

      {loading ? (
        <div className="flex justify-center py-10 text-white/40">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-white/40">
          Nothing evaluated yet. Hit <strong className="text-white/60">Scan</strong> to work through the sealed
          product of recent and upcoming sets — booster packs, boxes, cases, bundles and Commander decks.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-white/40">Nothing on the board matches those filters.</p>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-3 px-3 text-[9.5px] uppercase tracking-[0.12em] text-white/25">
            <span className="flex-1">product</span>
            <span className="w-20 text-right">costs</span>
            <span className="w-24 text-right">typical / mean</span>
            <span className="w-20 text-right">return</span>
            <span className="w-5" />
          </div>
          {shown.map((r) => {
            const up = (r.net_pct ?? -1) > 0
            // A simulated row only really pays if the TYPICAL unit clears cost.
            const medianBeats = r.ev_median != null && r.price != null && r.ev_median >= r.price
            const lottery = up && r.method === 'simulated' && r.ev_median != null && !medianBeats
            return (
              <div
                key={r.uuid}
                className={`flex items-start gap-3 rounded-md border px-3 py-2 ${
                  up ? 'border-emerald-400/25 bg-emerald-500/[0.06]' : 'border-white/10 bg-white/[0.03]'
                }`}
              >
                <ProductThumb
                  image={r.tcgplayer_product_id ? tcgplayerImage(r.tcgplayer_product_id, 'small') : null}
                  alt={r.name}
                  size="sm"
                  onClick={(() => {
                    const large = r.tcgplayer_product_id ? tcgplayerImage(r.tcgplayer_product_id, 'large') : null
                    return large
                      ? () => setZoom({ image: large, name: r.name, subtitle: r.setName ?? r.set_code.toUpperCase() })
                      : undefined
                  })()}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm" title={r.name}>{r.name}</span>
                    <span className="shrink-0 rounded bg-white/5 px-1 text-[9.5px] uppercase tracking-wide text-white/40">
                      {r.kind}
                    </span>
                    {r.method === 'deterministic' ? (
                      <span
                        className="shrink-0 rounded bg-sky-500/15 px-1 text-[9.5px] uppercase tracking-wide text-sky-300"
                        title="Contents are known exactly — this is today's card prices, not an average"
                      >
                        exact
                      </span>
                    ) : (
                      <span
                        className="shrink-0 rounded bg-white/5 px-1 text-[9.5px] uppercase tracking-wide text-white/40"
                        title={`Simulated: ${r.packs} random pack(s)`}
                      >
                        {r.packs} pack{r.packs === 1 ? '' : 's'}
                      </span>
                    )}
                    {r.ev_mean == null && (
                      <span
                        className="shrink-0 rounded bg-amber-500/15 px-1 text-[9.5px] uppercase tracking-wide text-amber-200"
                        title="Not enough price data to value this product yet"
                      >
                        no data
                      </span>
                    )}
                    {lottery && (
                      <span
                        className="shrink-0 rounded bg-amber-500/15 px-1 text-[9.5px] uppercase tracking-wide text-amber-200"
                        title="The average beats the price but the typical unit does not — the mean is carried by chase cards"
                      >
                        lottery
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-white/40">
                    {r.setName ?? r.set_code.toUpperCase()}
                    {r.chance_of_profit != null && ` · ${Math.round(r.chance_of_profit * 100)}% of units beat the price`}
                    {r.ev_mean != null && r.note && ` · ${r.note}`}
                  </div>
                  {/* A refused row's whole content is the reason, so it gets a
                      line of its own rather than being truncated away. */}
                  {r.ev_mean == null && r.note && (
                    <div className="mt-0.5 text-[11px] leading-relaxed text-amber-200/70">{r.note}</div>
                  )}
                </div>
                <div className="w-20 shrink-0 text-right text-[12px] tabular-nums text-white/70">{money(r.price)}</div>
                <div className="w-24 shrink-0 text-right">
                  {/* The median leads on simulated rows because it is what the
                      return column is computed from. */}
                  <div
                    className="text-[12px] tabular-nums"
                    title={r.ev_median != null ? 'Median — what a typical single unit returns' : 'Exact contents at current prices'}
                  >
                    {money(r.ev_median ?? r.ev_mean)}
                  </div>
                  {r.ev_median != null ? (
                    <div className="text-[10px] tabular-nums text-white/35" title="Mean across many units — tail-sensitive">
                      mean {money(r.ev_mean)}
                    </div>
                  ) : (
                    r.ev_liquid != null && (
                      /* Deterministic products are summed at retail ask including
                         bulk — a beginner box's biggest line items are basic
                         lands. This is what's left above $2 a card. */
                      <div
                        className={`text-[10px] tabular-nums ${
                          r.price != null && r.ev_liquid < r.price ? 'text-amber-200/70' : 'text-white/35'
                        }`}
                        title="Counting only cards worth $2 or more — the part you could realistically sell"
                      >
                        ≥$2 {money(r.ev_liquid)}
                      </div>
                    )
                  )}
                </div>
                <div
                  className={`w-20 shrink-0 text-right text-[12px] font-medium tabular-nums ${
                    r.net_pct == null ? 'text-white/30' : up ? 'text-emerald-300' : 'text-red-300/80'
                  }`}
                >
                  {pct(r.net_pct)}
                  {r.net != null && (
                    <div className="text-[10px] text-white/35">
                      {r.net > 0 ? '+' : '−'}{money(Math.abs(r.net))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => void window.atlis.mtg.evForget(r.uuid).then(load)}
                  title="Drop this row from the board"
                  className="shrink-0 rounded p-1 text-white/25 hover:bg-white/10 hover:text-white/60"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {zoom && <ImageZoom image={zoom.image} name={zoom.name} subtitle={zoom.subtitle} onClose={() => setZoom(null)} />}
    </div>
  )
}
