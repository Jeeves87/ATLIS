/**
 * One card on the table. Art is the exact printing (Scryfall id resolved by
 * ATLIS); everything else — P/T, counters, damage, tapped, what you may do
 * with it — is Forge's live state, never recomputed here.
 *
 * Highlight language, used consistently across the table:
 *  - emerald ring   you can act on it now (cast / play / activate)
 *  - amber ring     the current prompt wants you to pick it
 *  - orange dashed  it can attack this step
 *  - sky dashed     it can block this step (sky = blocking, like the block arrows)
 *  - sky glow, thick  the attacker you're choosing blockers for
 *  - red ring       targeted or referenced by what's happening
 *  - sky glow       Forge's auto-pay would tap it for the cost you're paying
 */
import { useEffect, useState } from 'react'
import { scryfallImage } from '../../../lib/mtgImages'
import type { GameCard } from '../../../types'
import { useCardFx } from './fx'

export type CardSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export const CARD_W: Record<CardSize, number> = { xs: 46, sm: 66, md: 86, lg: 112, xl: 136 }
const W = CARD_W

/**
 * Card sizes are tuned for a ~900px-tall window; taller screens scale them
 * up (a 4K table shouldn't be postage stamps), smaller ones never below 1×.
 */
export function useTableScale(): number {
  const calc = (): number => Math.min(2.2, Math.max(1, window.innerHeight / 900))
  const [scale, setScale] = useState(calc)
  useEffect(() => {
    const on = (): void => setScale(calc())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return scale
}

/** Forge highlights the attacker it's collecting blockers for while you declare blocks. */
const blockFocus = (c: GameCard): boolean => !!c.highlighted && !!c.attacking

const ringOf = (c: GameCard): string => {
  if (c.armed) return 'ring-4 ring-sky-300 shadow-[0_0_26px_6px_rgba(125,211,252,0.8)]'
  if (blockFocus(c)) return 'ring-4 ring-sky-400 shadow-[0_0_22px_4px_rgba(56,189,248,0.7)]'
  if (c.highlighted) return 'ring-2 ring-red-400 shadow-[0_0_12px_rgba(248,113,113,0.6)]'
  if (c.selectable) return 'ring-2 ring-amber-300 shadow-[0_0_12px_rgba(252,211,77,0.55)]'
  if (c.canAttack) return 'outline outline-2 outline-dashed outline-orange-400'
  if (c.canBlock && !c.blocking) return 'outline outline-2 outline-dashed outline-sky-400'
  if (c.blocking) return 'ring-2 ring-sky-400'
  if (c.autoTap) return 'ring-2 ring-sky-400/80'
  if (c.playable && !c.cantCast?.length) return 'ring-2 ring-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]'
  return 'ring-1 ring-black/40'
}

const shortCost = (m?: string | null): string => (m ?? '').replace(/[{}]/g, '')

export default function GameCardView({
  card, size = 'md', onClick, onHover, dimmed, anchor = true
}: {
  card: GameCard
  size?: CardSize
  onClick?: (c: GameCard) => void
  onHover?: (c: GameCard | null) => void
  dimmed?: boolean
  /**
   * Whether this element is "where the card is" for arrows and motion. False
   * for reference copies — a commander shown in the command zone while the
   * real card is on the battlefield — so arrows attach to the real one.
   */
  anchor?: boolean
}): React.JSX.Element {
  const w = Math.round(W[size] * useTableScale())
  const h = Math.round(w * 1.4)
  const tapped = !!card.tapped
  // Just arrived on the battlefield / just drawn: play the arrival once.
  const fx = useCardFx(card.id)
  const img = card.art ? scryfallImage(card.art, size === 'xl' || size === 'lg' || size === 'md' ? 'normal' : 'small') : null
  const counters = Object.entries(card.counters ?? {}).filter(([, n]) => n > 0)
  const onField = card.zone === 'Battlefield'
  const vehicle = /\bVehicle\b/.test(card.type ?? '')
  const pt = (card.creature || vehicle) && onField && card.power != null ? `${card.power}/${card.toughness}` : null
  // An uncrewed Vehicle isn't a creature yet: say what it takes to crew it.
  const crew = vehicle && !card.creature && onField ? card.text?.match(/Crew (\d+)/)?.[1] ?? null : null
  // Forge appends "Cloned by:" to a copy's text (Imposter Mech as Thor, Clone…).
  const copy = onField && !!card.text?.includes('Cloned by:')

  return (
    // The slot reserves the rotated footprint so a tapped card doesn't overlap its neighbour.
    <div
      data-cid={anchor ? card.id : undefined}
      className="relative shrink-0 transition-all duration-200"
      style={{
        width: tapped ? h : w, height: tapped ? w : h, marginTop: card.attacking || card.armed ? -14 : 0,
        animation: fx === 'enter' ? 'atlis-enter 0.8s ease-out' : fx === 'draw' ? 'atlis-draw 0.5s ease-out' : undefined
      }}
      onMouseEnter={() => onHover?.(card)}
      onMouseLeave={() => onHover?.(null)}
    >
      <button
        type="button"
        onClick={() => onClick?.(card)}
        className={`absolute left-1/2 top-1/2 overflow-hidden rounded-[6px] bg-[#1b1b22] text-left transition-transform duration-200 ${ringOf(card)} ${dimmed ? 'opacity-50' : ''}`}
        style={{ width: w, height: h, transform: `translate(-50%, -50%) rotate(${tapped ? 90 : 0}deg)` }}
      >
        {card.hidden || card.faceDown ? (
          <div className="h-full w-full bg-[radial-gradient(circle_at_30%_20%,#4c3a7a,#1a1530_70%)]">
            <div className="m-[8%] h-[84%] rounded border border-violet-300/20" />
          </div>
        ) : img ? (
          <img src={img.src} alt={card.name} draggable={false} className="h-full w-full object-cover"
            onError={(e) => { if (img.fallback && e.currentTarget.src !== img.fallback) e.currentTarget.src = img.fallback }} />
        ) : (
          // No printing known (tokens, unmapped sets): a readable text frame.
          <div className="flex h-full w-full flex-col bg-gradient-to-b from-[#2a2a35] to-[#18181f] p-1 text-[9px] leading-tight text-white/85">
            <div className="flex justify-between gap-1 font-semibold">
              <span className="truncate">{card.name}</span>
              <span className="shrink-0 text-white/50">{shortCost(card.manaCost)}</span>
            </div>
            <div className="mt-0.5 truncate text-[8px] text-white/45">{card.type}</div>
            {size !== 'xs' && <div className="mt-1 line-clamp-6 text-[8px] text-white/60">{card.text}</div>}
          </div>
        )}
      </button>

      {/* Live state overlays, upright even when the card is tapped. */}
      {pt && (
        <span className={`pointer-events-none absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 text-[10px] font-bold tabular-nums ${
          card.damage ? 'text-red-300' : crew ? 'text-white/50' : 'text-white'
        }`}>
          {pt}{card.damage ? ` (−${card.damage})` : ''}
        </span>
      )}
      {card.loyalty && card.zone === 'Battlefield' && (
        <span className="pointer-events-none absolute bottom-0.5 right-0.5 rounded bg-violet-900/90 px-1 text-[10px] font-bold text-white">{card.loyalty}</span>
      )}
      {counters.length > 0 && (
        <div className="pointer-events-none absolute left-0.5 top-0.5 flex flex-col gap-0.5">
          {counters.slice(0, 3).map(([k, n]) => (
            <span key={k} title={k} className="rounded bg-amber-500/90 px-1 text-[9px] font-bold text-black">{n} {k.slice(0, 4)}</span>
          ))}
        </div>
      )}
      {card.sick && card.creature && card.zone === 'Battlefield' && (
        <span title="Summoning sick: can't attack or use {T} abilities this turn" className="pointer-events-none absolute right-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px]">💤</span>
      )}
      {crew && (
        <span title={`Vehicle: tap creatures with total power ${crew}+ (click it to crew) and it becomes an artifact creature until end of turn`}
          className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-amber-500/90 px-1 text-[9px] font-bold text-black">Crew {crew}</span>
      )}
      {copy && (
        <span title="A copy of another card" className="pointer-events-none absolute left-1/2 top-0.5 -translate-x-1/2 rounded bg-sky-500/90 px-1 text-[9px] font-bold text-black">Copy</span>
      )}
      {card.attacking && (blockFocus(card)
        ? <span className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-sky-400 px-1.5 text-[10px] font-bold text-black shadow-lg">BLOCKING THIS</span>
        : <span className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 rounded bg-orange-500 px-1 text-[9px] font-bold text-black">ATK</span>)}
      {card.mustAttack && !card.attacking && (
        <span title={card.goadedBy ? `Goaded by ${card.goadedBy}: must attack another player` : 'Must attack this combat'}
          className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-orange-400 px-1.5 text-[10px] font-bold text-black shadow-lg">MUST ATTACK</span>
      )}
      {card.armed && <span className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-sky-300 px-1.5 text-[10px] font-bold text-black shadow-lg">PICK ATTACKER ↗</span>}
      {card.blocking && <span className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 rounded bg-sky-500 px-1 text-[9px] font-bold text-black">BLK</span>}
    </div>
  )
}
