import { Check, Loader2, Package, Plus } from 'lucide-react'
import ProductThumb from '../mtg/ProductThumb'
import { cardImage, money, printingLabel, printingsOf } from './tcgUi'
import type { TcgPrinting, TcgProduct } from '../../types'

/**
 * One card or sealed product as a picture tile — the Magic grid's tile, for
 * any other game. Shared by name search and the set view so both look and
 * behave the same.
 */
export default function TcgTile({
  p,
  watched,
  adding,
  onPreview,
  onTrack,
  onOwn
}: {
  p: TcgProduct
  watched: Set<string>
  adding: string | null
  onPreview: () => void
  onTrack: (printing: TcgPrinting) => void
  /** Sealed only: add a copy to Owned. */
  onOwn?: () => void
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
      <button
        onClick={onPreview}
        title="Click to enlarge"
        className="mb-2 block w-full overflow-hidden rounded ring-1 ring-transparent transition hover:ring-violet-400/60"
      >
        <ProductThumb image={cardImage(p.productId, 'normal', p.sealed)} alt={p.name} size="lg" />
      </button>
      <div className="truncate text-xs font-medium" title={p.name}>
        {p.name}
      </div>
      <div className="truncate text-[11px] text-white/50" title={p.set ?? undefined}>
        {[p.number ? `#${p.number}` : null, p.rarity].filter(Boolean).join(' · ') || p.set || p.gameLabel}
      </div>
      <div className="mt-0.5 text-[11px] text-white/45">
        <span className="tabular-nums text-white/70">{money(p.market)}</span>
        {' · '}
        {p.listings ? `${p.listings} listed` : <span className="text-amber-300/80">not listed yet</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {printingsOf(p).map((pr) => {
          const key = `${p.productId}:${pr}`
          const have = watched.has(key)
          return (
            <button
              key={pr}
              onClick={() => onTrack(pr)}
              disabled={have || adding != null}
              title={have ? 'Already tracking' : `Track ${p.sealed ? 'this' : pr === 'Foil' ? 'the foil' : 'the regular printing'}`}
              className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] hover:bg-white/10 disabled:opacity-50"
            >
              {adding === key ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : have ? (
                <Check className="h-3 w-3 text-violet-300" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              {p.sealed ? (have ? 'Tracking' : 'Track') : printingLabel(pr, false)}
            </button>
          )
        })}
        {p.sealed && onOwn && (
          <button
            onClick={onOwn}
            disabled={adding != null}
            title="I own this — add a copy to Owned"
            className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] hover:bg-white/10 disabled:opacity-50"
          >
            {adding === `own:${p.productId}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Package className="h-3 w-3" />}
            Own
          </button>
        )}
      </div>
    </div>
  )
}
