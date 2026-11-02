import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, Tag } from 'lucide-react'
import type { MtgRetailDeal } from '../../types'
import ProductThumb from './ProductThumb'
import { imageFor } from '../../lib/mtgImages'

const money = (v: number | null | undefined): string =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Watchlist products a big-box retailer currently has well under the secondary
 * market.
 *
 * The comparison needs no MSRP: Target, Best Buy and Amazon sell at list, so
 * their price IS list, and TCGplayer's market price is what the thing actually
 * trades for. A Commander deck that drifted to four times its list price and
 * then reappears at Target for $54.99 shows up here as "−74% under market",
 * which is the same signal a reprint rumour would eventually produce — except
 * it arrives as a fact rather than a rumour.
 *
 * Split by kind because they are different decisions: a preorder at list is
 * "buy before release", a restock is "the market just broke".
 */
export default function DealsPanel({ onChanged }: { onChanged?: () => void }): React.JSX.Element {
  const [deals, setDeals] = useState<MtgRetailDeal[]>([])
  const [threshold, setThreshold] = useState(0.4)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [d, t] = await Promise.all([window.atlis.mtg.deals(), window.atlis.mtg.dealThreshold()])
    setDeals(d)
    setThreshold(t)
  }, [])

  useEffect(() => {
    void load()
    return window.atlis.mtg.onChanged(() => void load())
  }, [load])

  async function recheck(): Promise<void> {
    setBusy(true)
    try {
      await window.atlis.mtg.refreshStock()
      await load()
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  const preorders = deals.filter((d) => d.kind === 'preorder')
  const restocks = deals.filter((d) => d.kind === 'restock')

  return (
    <section className="mb-4 rounded-md border border-emerald-400/20 bg-emerald-500/[0.05] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Tag className="h-3.5 w-3.5 text-emerald-300/80" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-200/80">Buyable now</h3>
        <span
          className="text-[11px] text-white/35"
          title="With an MSRP: below, at, or near list. Without one: this far under market."
        >
          {deals.length
            ? `${deals.length} hunted product${deals.length === 1 ? '' : 's'} at MSRP or better`
            : 'nothing you are hunting is orderable at MSRP or better right now'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={String(threshold)}
            onChange={(e) => void window.atlis.mtg.setDealThreshold(Number(e.target.value)).then(load)}
            title="For products with no MSRP yet: how far under market a retail price has to be before it counts"
            className="rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-[11px] outline-none focus:border-emerald-400/50"
          >
            {[0.25, 0.4, 0.5, 0.6].map((v) => (
              <option key={v} value={v} className="bg-neutral-900">
                {Math.round(v * 100)}%+ under
              </option>
            ))}
          </select>
          <button
            onClick={() => void recheck()}
            disabled={busy}
            title="Re-check every resolved retail listing now"
            className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Check stores
          </button>
        </div>
      </div>

      {deals.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-white/35">
          Big-box retailers sell at list, so their price stands in for MSRP — when Target or Amazon has a watchlist
          product far under what it trades for on TCGplayer, it lands here. Add the things you&apos;d buy at the right
          price to your watchlist and hit <strong className="text-white/50">Find retailers</strong> on the row so
          there are listings to check.
        </p>
      ) : (
        <div className="space-y-3">
          {[
            { rows: preorders, label: 'Preorder at list', hint: 'not released yet' },
            { rows: restocks, label: 'Below market', hint: 'available now' }
          ]
            .filter((g) => g.rows.length)
            .map((g) => (
              <div key={g.label}>
                <div className="mb-1 text-[9.5px] uppercase tracking-[0.12em] text-white/30">
                  {g.label} · {g.hint}
                </div>
                <div className="space-y-1">
                  {g.rows.map((d) => (
                    <a
                      key={d.listingId}
                      href={d.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-3 rounded border border-white/10 bg-black/20 px-2.5 py-1.5 hover:border-emerald-400/40 hover:bg-emerald-500/10"
                    >
                      <ProductThumb
                        image={imageFor({ extSource: d.extSource, extId: d.extId, imageUrl: d.imageUrl }, 'small')}
                        alt={d.name}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px]" title={d.name}>
                          {d.name}
                        </div>
                        <div className="truncate text-[11px] text-white/40">
                          {d.retailer}
                          {d.setCode ? ` · ${d.setCode.toUpperCase()}` : ''}
                          {d.status === 'preorder' ? ' · preorder' : ''}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[12px] tabular-nums text-emerald-300">{money(d.price)}</div>
                        <div className="text-[10px] tabular-nums text-white/35">market {money(d.market)}</div>
                      </div>
                      <div
                        className="w-24 shrink-0 text-right text-[12px] font-medium tabular-nums text-emerald-300"
                        title={`${d.discount}% under market`}
                      >
                        {d.band === 'below_msrp'
                          ? `${d.overMsrpPct}% MSRP`
                          : d.band === 'at_msrp'
                            ? 'At MSRP'
                            : d.band === 'near_msrp'
                              ? `+${d.overMsrpPct}% MSRP`
                              : `−${d.discount}% mkt`}
                      </div>
                      <ExternalLink className="h-3 w-3 shrink-0 text-white/25" />
                    </a>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </section>
  )
}
