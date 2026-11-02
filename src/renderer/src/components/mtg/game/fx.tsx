/**
 * Motion for the table, so a card is never just "suddenly somewhere else".
 *
 * Each snapshot is compared with the last one, card by card:
 *  - arrived on the battlefield  → the card itself plays "enter"
 *  - arrived in your hand        → the card itself plays "draw"
 *  - left the battlefield / your hand → a GHOST is left at the card's last
 *    on-screen position and plays what happened (died, destroyed, exiled,
 *    bounced, discarded), labelled, then fades.
 *
 * Positions come from the DOM ([data-cid]) measured after every render, so a
 * ghost appears exactly where the card was the frame before it vanished.
 */
import { createContext, useContext, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { GameCard, GameState } from '../../../types'

export type CardFx = 'enter' | 'draw'
export type GhostKind = 'died' | 'destroyed' | 'exiled' | 'bounced' | 'tucked' | 'discarded' | 'gone'

export interface Ghost {
  key: string
  card: GameCard
  rect: { x: number; y: number; w: number; h: number }
  kind: GhostKind
}

const FxContext = createContext<Map<number, CardFx>>(new Map())
export const FxProvider = FxContext.Provider
export const useCardFx = (id: number): CardFx | undefined => useContext(FxContext).get(id)

const LABEL: Record<GhostKind, string> = {
  died: 'Died', destroyed: 'Destroyed', exiled: 'Exiled', bounced: 'Returned to hand',
  tucked: 'Put into library', discarded: 'Discarded', gone: 'Ceased to exist'
}

/** Which zone each card is in, from the players' zone lists (library isn't listed). */
function zonesOf(s: GameState): Map<number, string> {
  const m = new Map<number, string>()
  for (const p of s.players) {
    for (const [z, ids] of Object.entries(p.zones)) for (const id of ids) m.set(id, `${z}:${p.id}`)
  }
  return m
}

export function useZoneFx(state: GameState | null, root: RefObject<HTMLDivElement | null>): { fx: Map<number, CardFx>; ghosts: Ghost[] } {
  const prevZones = useRef<Map<number, string> | null>(null)
  const prevCards = useRef<Record<string, GameCard>>({})
  const rects = useRef(new Map<number, Ghost['rect']>())
  const [fx, setFx] = useState(new Map<number, CardFx>())
  const [ghosts, setGhosts] = useState<Ghost[]>([])

  useLayoutEffect(() => {
    if (!state) return
    const now = zonesOf(state)
    const before = prevZones.current
    if (before) {
      const nextFx = new Map<number, CardFx>()
      const newGhosts: Ghost[] = []
      const zone = (z?: string): string => (z ? z.split(':')[0] : 'library')
      for (const [id, z] of now) {
        const was = before.get(id)
        if (zone(z) === 'battlefield' && zone(was) !== 'battlefield') nextFx.set(id, 'enter')
        else if (zone(z) === 'hand' && zone(was) !== 'hand' && z.endsWith(`:${state.you}`)) nextFx.set(id, 'draw')
      }
      for (const [id, was] of before) {
        const z = now.get(id)
        const from = zone(was)
        const to = z ? zone(z) : null
        const rect = rects.current.get(id)
        const card = prevCards.current[String(id)] ?? state.cards[String(id)]
        if (!rect || !card || card.hidden) continue
        let kind: GhostKind | null = null
        if (from === 'battlefield' && to !== 'battlefield') {
          kind = to === 'graveyard' ? (card.creature ? 'died' : 'destroyed')
            : to === 'exile' ? 'exiled'
            : to === 'hand' ? 'bounced'
            : to === null ? (card.token ? 'gone' : 'tucked')
            : null
        } else if (from === 'hand' && to === 'graveyard' && was.endsWith(`:${state.you}`)) {
          kind = 'discarded'
        }
        if (kind) newGhosts.push({ key: `${id}-${Date.now()}`, card: { ...card, highlighted: false, selectable: false, playable: false }, rect, kind })
      }
      if (nextFx.size) {
        setFx(nextFx)
        setTimeout(() => setFx((m) => (m === nextFx ? new Map() : m)), 900)
      }
      if (newGhosts.length) {
        setGhosts((g) => [...g, ...newGhosts])
        setTimeout(() => setGhosts((g) => g.filter((x) => !newGhosts.includes(x))), 1400)
      }
    }
    prevZones.current = now
    prevCards.current = state.cards
    // Measure where every card is now, for the NEXT diff's ghosts.
    const host = root.current
    if (host) {
      const base = host.getBoundingClientRect()
      const m = new Map<number, Ghost['rect']>()
      host.querySelectorAll<HTMLElement>('[data-cid]').forEach((el) => {
        const r = el.getBoundingClientRect()
        m.set(Number(el.dataset.cid), { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height })
      })
      rects.current = m
    }
  }, [state, root])

  return { fx, ghosts }
}

/** Keyframes for cards and ghosts; rendered once by the table. */
export const FX_CSS = `
@keyframes atlis-enter { 0% { transform: translateY(-26px) scale(0.7); opacity: 0; filter: drop-shadow(0 0 0 rgba(251,191,36,0)); }
  60% { transform: translateY(2px) scale(1.06); opacity: 1; filter: drop-shadow(0 0 14px rgba(251,191,36,0.9)); }
  100% { transform: none; filter: drop-shadow(0 0 0 rgba(251,191,36,0)); } }
@keyframes atlis-spotlight { 0% { transform: translateX(60px) scale(0.6) rotate(6deg); opacity: 0; } 100% { transform: none; opacity: 1; } }
@keyframes atlis-beam { to { stroke-dashoffset: -22; } }
@keyframes atlis-draw { 0% { transform: translateY(60px) rotate(-6deg); opacity: 0; } 100% { transform: none; opacity: 1; } }
@keyframes atlis-ghost-die { 0% { transform: none; filter: none; opacity: 1; }
  15% { transform: translateX(-5px); filter: sepia(1) saturate(4) hue-rotate(-40deg) brightness(0.9); }
  30% { transform: translateX(5px); }
  45% { transform: translateX(-3px); filter: sepia(1) saturate(5) hue-rotate(-40deg) brightness(0.7); opacity: 1; }
  100% { transform: translateY(34px) scale(0.75) rotate(-8deg); filter: grayscale(1) brightness(0.3) blur(2px); opacity: 0; } }
@keyframes atlis-ghost-exile { 0% { opacity: 1; filter: none; } 40% { filter: hue-rotate(220deg) saturate(2) brightness(1.3); }
  100% { transform: translateY(-40px) scale(0.85); filter: blur(6px) hue-rotate(260deg) brightness(1.8); opacity: 0; } }
@keyframes atlis-ghost-bounce { 0% { opacity: 1; } 30% { filter: hue-rotate(180deg) brightness(1.3); }
  100% { transform: translateY(160px) scale(0.6); opacity: 0; } }
@keyframes atlis-ghost-fade { 0% { opacity: 1; } 100% { transform: scale(0.8); opacity: 0; filter: blur(3px); } }
@keyframes atlis-ghost-label { 0% { transform: translate(-50%, 0) scale(0.6); opacity: 0; } 15% { transform: translate(-50%, 0) scale(1.1); opacity: 1; }
  75% { opacity: 1; } 100% { transform: translate(-50%, -14px); opacity: 0; } }
`

const GHOST_ANIM: Record<GhostKind, string> = {
  died: 'atlis-ghost-die', destroyed: 'atlis-ghost-die', discarded: 'atlis-ghost-die',
  exiled: 'atlis-ghost-exile', bounced: 'atlis-ghost-bounce', tucked: 'atlis-ghost-bounce', gone: 'atlis-ghost-fade'
}
const LABEL_TONE: Record<GhostKind, string> = {
  died: 'bg-red-600', destroyed: 'bg-red-600', discarded: 'bg-red-700',
  exiled: 'bg-violet-600', bounced: 'bg-sky-600', tucked: 'bg-sky-700', gone: 'bg-zinc-600'
}

/** The ghost layer: absolutely positioned over the table, pointer-transparent. */
export function GhostLayer({ ghosts, render }: { ghosts: Ghost[]; render: (c: GameCard, w: number) => React.ReactNode }): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      {ghosts.map((g) => (
        <div key={g.key} className="absolute" style={{ left: g.rect.x, top: g.rect.y, width: g.rect.w, height: g.rect.h }}>
          <div style={{ animation: `${GHOST_ANIM[g.kind]} 1.3s ease-in forwards` }}>{render(g.card, g.rect.w)}</div>
          <span className={`absolute left-1/2 top-1/3 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold text-white shadow-lg ${LABEL_TONE[g.kind]}`}
            style={{ animation: 'atlis-ghost-label 1.3s ease-out forwards' }}>
            {LABEL[g.kind]}
          </span>
        </div>
      ))}
    </div>
  )
}
