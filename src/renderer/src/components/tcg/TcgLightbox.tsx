import { useEffect, useState } from 'react'
import { Check, ExternalLink, Loader2, Plus, X } from 'lucide-react'
import { cardImage, clean, money } from './tcgUi'
import type { TcgGame, TcgPrinting, TcgQuote } from '../../types'

/**
 * The full-size preview for a card or sealed product from any non-Magic game —
 * the same layout as the Magic lightbox: the big image, then what each finish
 * trades at, then Track.
 *
 * Prices are fetched live per printing when it opens, because search results
 * only carry one market figure for the whole product and a foil must never be
 * shown at the regular copy's price.
 */
export default function TcgLightbox({
  product,
  game,
  watched,
  onTrack,
  onClose
}: {
  product: { productId: string; name: string; set: string | null; rarity: string | null; sealed: boolean; foilOnly?: boolean }
  game: TcgGame
  watched: Set<string>
  onTrack?: (printing: TcgPrinting) => Promise<void>
  onClose: () => void
}) {
  const [quote, setQuote] = useState<{ Normal: TcgQuote; Foil: TcgQuote } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<TcgPrinting | null>(null)
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    let live = true
    setQuote(null)
    setErr(null)
    window.atlis.tcg.quote(product.productId).then(
      (q) => live && setQuote(q),
      (e) => live && setErr(clean(e))
    )
    return () => {
      live = false
    }
  }, [product.productId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const img = cardImage(product.productId, 'large', product.sealed)
  const src = img ? (fallback && img.fallback ? img.fallback : img.src) : null
  const rows: TcgPrinting[] = product.sealed ? ['Normal'] : ['Normal', 'Foil']
  const trades = (p: TcgPrinting): boolean => !!quote && (quote[p].market != null || quote[p].median != null)
  // Track the printings that actually trade. When none does yet — an upcoming
  // set — offer the default one, so it can alert when the first copies list.
  const trackable: TcgPrinting[] = !quote
    ? []
    : rows.some(trades)
      ? rows.filter(trades)
      : [product.foilOnly ? 'Foil' : 'Normal']

  async function track(p: TcgPrinting): Promise<void> {
    if (!onTrack) return
    setBusy(p)
    setErr(null)
    try {
      await onTrack(p)
    } catch (e) {
      setErr(clean(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={onClose} role="presentation">
      <div className="flex max-h-full max-w-full items-start gap-5" onClick={(e) => e.stopPropagation()} role="presentation">
        {src && (
          <img
            src={src}
            alt={product.name}
            onError={() => setFallback(true)}
            className={`max-h-[85vh] max-w-[52vw] rounded-xl object-contain shadow-2xl ring-1 ring-white/15 ${product.sealed ? 'bg-white' : ''}`}
          />
        )}
        <div className="w-64 shrink-0 pt-2">
          <h3 className="text-base font-semibold">{product.name}</h3>
          <p className="mt-0.5 text-xs text-white/50">{[game.label, product.set, product.rarity].filter(Boolean).join(' · ')}</p>

          <div className="mt-3 space-y-2">
            {rows.map((p) => (
              <div key={p}>
                <div className="flex justify-between text-sm">
                  <span className={trades(p) ? 'text-violet-300' : 'text-white/50'}>
                    {product.sealed ? 'market' : p === 'Foil' ? 'foil' : 'regular'}
                  </span>
                  <span className="tabular-nums">{quote ? money(quote[p].market) : '…'}</span>
                </div>
                {quote && (
                  <div className="text-right text-[11px] text-white/40">
                    {quote[p].listed ? `listed ~${money(quote[p].median)}` : 'not listed'}
                  </div>
                )}
              </div>
            ))}
            {err && <p className="text-[11px] text-rose-300">{err}</p>}
          </div>

          {onTrack &&
            trackable.map((p) => {
              const have = watched.has(`${product.productId}:${p}`)
              return (
                <button
                  key={p}
                  onClick={() => void track(p)}
                  disabled={have || busy != null}
                  className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md bg-violet-500/80 py-2 text-sm font-medium hover:bg-violet-500 disabled:opacity-50"
                >
                  {busy === p ? <Loader2 className="h-4 w-4 animate-spin" /> : have ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  {have ? 'Tracking' : 'Track'} {product.sealed ? '' : p === 'Foil' ? 'foil' : 'regular'}
                </button>
              )
            })}

          <a
            href={`https://www.tcgplayer.com/product/${product.productId}`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 flex items-center justify-center gap-1 text-[11px] text-white/45 hover:text-white/80"
          >
            <ExternalLink className="h-3 w-3" />
            Open on TCGplayer
          </a>
        </div>
      </div>
      <button
        onClick={onClose}
        className="absolute right-5 top-5 rounded-md p-2 text-white/60 hover:bg-white/10 hover:text-white"
        title="Close"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  )
}
