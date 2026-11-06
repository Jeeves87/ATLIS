/**
 * The board's big pieces, laid out the way the eye wants to read a game:
 *  - creatures front and center, as big as the space allows;
 *  - lands and other permanents shrunk into piles off to the sides (five
 *    Mountains are one pile marked ×5, not five cards);
 *  - each player as a portrait (their commander's art) wearing their life
 *    total — the thing you click when a spell targets a player;
 *  - your hand fanned in an arc along the bottom edge;
 *  - quiet heads-up notes for things that are about to matter.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import GameCardView, { CARD_W, type CardSize, useTableScale } from './GameCardView'
import { scryfallImage } from '../../../lib/mtgImages'
import type { GameCard, GamePlayer, GameState } from '../../../types'

export type CardLookup = (id: number) => GameCard | undefined
type OnCard = (c: GameCard) => void
type OnHover = (c: GameCard | null) => void

// ---------------------------------------------------------------- piles

/**
 * Identical permanents share a pile. Anything that makes two copies play
 * differently (tapped, attacking, counters, damage, sickness, something
 * attached) keeps them apart, so a pile's cards are interchangeable.
 */
function pileKey(c: GameCard, hasAttachments: boolean): string {
  if (hasAttachments || c.commander) return `#${c.id}`
  // Non-token creatures (and vehicles) are individuals — you care which Grizzly Bears it is.
  if ((c.creature || /\bVehicle\b/.test(c.type ?? '')) && !c.token) return `#${c.id}`
  // In combat each token is its own decision (which goblin blocks which attacker), so unpile them.
  if (c.canAttack || c.canBlock || c.attacking || c.blocking) return `#${c.id}`
  return [c.name, c.tapped, c.attacking, c.blocking, c.sick, c.power, c.toughness, c.damage, JSON.stringify(c.counters ?? {}), c.token, c.faceDown].join('|')
}

/** What the pile shows on top: whatever the game wants you to look at. */
const attention = (c: GameCard): number =>
  (c.highlighted ? 16 : 0) + (c.selectable ? 8 : 0) + (c.canAttack || c.canBlock ? 4 : 0) + (c.autoTap ? 2 : 0) + (c.playable ? 1 : 0)

export function piles(cards: GameCard[], attachedTo: (c: GameCard) => GameCard[]): GameCard[][] {
  const groups = new Map<string, GameCard[]>()
  for (const c of cards) {
    const k = pileKey(c, attachedTo(c).length > 0)
    const g = groups.get(k)
    if (g) g.push(c)
    else groups.set(k, [c])
  }
  return [...groups.values()].map((g) => [...g].sort((a, b) => attention(a) - attention(b)))
}

const slot = (size: CardSize, scale: number, tapped: boolean): { w: number; h: number } => {
  const w = Math.round(CARD_W[size] * scale)
  const h = Math.round(w * 1.4)
  return tapped ? { w: h, h: w } : { w, h }
}
const PILE_STEP = 5
const PILE_DEPTH = 3

/** A stack of identical cards, fanned a few pixels so it reads as "several". Every card keeps its data-cid for arrows. */
export function Pile({ cards, size, onCard, onHover, extras }: {
  cards: GameCard[]; size: CardSize; onCard: OnCard; onHover: OnHover; extras?: (c: GameCard) => React.ReactNode
}): React.JSX.Element {
  const scale = useTableScale()
  const top = cards[cards.length - 1]
  const s = slot(size, scale, !!top.tapped)
  const depth = Math.min(cards.length - 1, PILE_DEPTH)
  const step = Math.round(PILE_STEP * scale)
  return (
    <div className="relative shrink-0" style={{ width: s.w + depth * step, height: s.h }}>
      {cards.map((c, i) => {
        const at = Math.max(0, depth - (cards.length - 1 - i))
        return (
          <div key={c.id} className="absolute bottom-0" style={{ left: at * step }}>
            {extras?.(c)}
            <GameCardView card={c} size={size} onClick={onCard} onHover={onHover} />
          </div>
        )
      })}
      {cards.length > 1 && (
        <span className="pointer-events-none absolute -right-1.5 -top-1.5 z-10 rounded-full bg-black/85 px-1.5 text-[10px] font-bold tabular-nums text-white ring-1 ring-white/25">
          ×{cards.length}
        </span>
      )}
    </div>
  )
}

/** Width a row of piles needs at a size — for picking the biggest size that fits. */
function rowFits(groups: GameCard[][], size: CardSize, scale: number, width: number, height: number, gap: number): boolean {
  return !width || rowsHeight(groups, size, scale, width, gap) <= height
}

/** Height piles wrapped into `width` take at a size, attacker lift included. */
function rowsHeight(groups: GameCard[][], size: CardSize, scale: number, width: number, gap: number): number {
  if (!groups.length) return 0
  let x = 0
  let rowH = 0
  let total = 0
  for (const g of groups) {
    const s = slot(size, scale, !!g[g.length - 1].tapped)
    const w = s.w + Math.min(g.length - 1, PILE_DEPTH) * Math.round(PILE_STEP * scale) + gap
    if (x + w > width && x > 0) { x = 0; total += rowH + gap; rowH = 0 }
    x += w
    rowH = Math.max(rowH, s.h)
  }
  return total + rowH + 16 // attackers lift
}

function bestSize(groups: GameCard[][], prefer: CardSize, scale: number, width: number, height: number, gap: number): { size: CardSize; fits: boolean } {
  const order: CardSize[] = ['xl', 'lg', 'md', 'sm', 'xs']
  for (const sz of order.slice(order.indexOf(prefer))) if (rowFits(groups, sz, scale, width, height, gap)) return { size: sz, fits: true }
  return { size: 'xs', fits: false }
}

// ---------------------------------------------------------------- battlefield

/**
 * One seat's permanents. Creatures get the middle and the size; lands pile up
 * small on the left, artifacts / enchantments / planeswalkers on the right.
 * `mirrored` (opponents across the table) puts the piles behind the creatures
 * — at the top — so creatures always face each other across the middle.
 */
export function Battlefield({ player, card, onCard, onHover, prefer, mirrored = false, centerGap = 0, center }: {
  player: GamePlayer; card: CardLookup; onCard: OnCard; onHover: OnHover; prefer: CardSize; mirrored?: boolean
  /** Width kept clear in the middle of the pile row, and what sits there (an opponent's portrait). */
  centerGap?: number; center?: React.ReactNode
}): React.JSX.Element {
  const all = player.zones.battlefield.map(card).filter((c): c is GameCard => !!c)
  const attachedIds = new Set(all.filter((c) => c.attachedTo != null).map((c) => c.id))
  const onTop = (host: GameCard): GameCard[] => all.filter((c) => c.attachedTo === host.id)
  const loose = all.filter((c) => !attachedIds.has(c.id))
  // Vehicles fight like creatures once crewed, so they line up with them.
  const fighter = (c: GameCard): boolean => !!c.creature || /\bVehicle\b/.test(c.type ?? '')
  const creatures = piles(loose.filter(fighter), onTop)
  const lands = piles(loose.filter((c) => c.land && !fighter(c)), onTop)
  const others = piles(loose.filter((c) => !c.land && !fighter(c)), onTop)

  const box = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setDims({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const scale = useTableScale()
  const hasBack = lands.length + others.length > 0 || !!center
  // Piles stay small so creatures get the height; on a short seat they shrink further.
  const backSize: CardSize = dims.h > 340 ? 'sm' : 'xs'
  const backBase = hasBack ? Math.max(Math.round(CARD_W[backSize] * scale * 1.4) + 8, center ? Math.round(86 * scale) : 0) : 0
  const sideW = (n: number): number => {
    if (!n) return 0
    const share = dims.w * Math.min(0.62, Math.max(0.3, n / Math.max(1, lands.length + others.length)))
    return centerGap ? Math.min(share, (dims.w - centerGap) / 2) : share
  }
  // Too many lands for one row at the smallest size (a narrow side seat): the
  // pile row grows to hold the extra rows, as far as the creatures can spare.
  const backNeed = Math.max(rowsHeight(lands, 'xs', scale, sideW(lands.length), 6), rowsHeight(others, 'xs', scale, sideW(others.length), 6))
  const creatureFloor = creatures.length ? rowsHeight(creatures, 'xs', scale, Math.max(0, dims.w - 16), 10) + 24 : 0
  const backH = backNeed > backBase ? Math.max(backBase, Math.min(backNeed, dims.h - 8 - creatureFloor)) : backBase
  // Your back row sits half a card below your creatures, so the two read as separate rows.
  const gapWanted = !mirrored && hasBack ? Math.round(CARD_W[backSize] * scale * 0.7) : 0
  const roomFor = (gap: number): number => Math.max(0, dims.h - backH - 8 - gap)
  // …but only while there's room for it: creatures never shrink to make the gap.
  // The row's px-2 / pt-4 padding comes out of the room, or a "fitting" row wraps a line short.
  const rowWidth = Math.max(0, dims.w - 16)
  const spaced = bestSize(creatures, prefer, scale, rowWidth, roomFor(gapWanted) - 16, 10)
  const tight = bestSize(creatures, prefer, scale, rowWidth, roomFor(0) - 16, 10)
  const offset = spaced.size === tight.size && spaced.fits ? gapWanted : 0
  const front = offset ? spaced : tight
  const landFit = bestSize(lands, backSize, scale, sideW(lands.length), backH, 6)
  const otherFit = bestSize(others, backSize, scale, sideW(others.length), backH, 6)

  const attachments = (c: GameCard): React.ReactNode => onTop(c).map((a, i) => (
    <div key={a.id} className="absolute -top-3 z-0" style={{ left: 6 + i * 8 }}>
      <GameCardView card={a} size="xs" onClick={onCard} onHover={onHover} />
    </div>
  ))

  const frontRow = (
    // "safe center": a row too tall for its box starts at the top and scrolls, instead of losing its top edge.
    <div className={`flex min-h-0 flex-1 flex-wrap items-end justify-center gap-2.5 px-2 pt-4 ${front.fits ? 'overflow-hidden' : 'overflow-y-auto'}`}
      style={{ alignContent: 'safe center' }}>
      {creatures.map((g) => <Pile key={g[0].id} cards={g} size={front.size} onCard={onCard} onHover={onHover} extras={attachments} />)}
    </div>
  )
  // Your own artifacts/enchantments sit in from the edge: 2–3 cards past your
  // lands, toward the middle, rather than pinned to the far right.
  const rowW = (groups: GameCard[][], size: CardSize): number => groups.reduce((w, g) =>
    w + slot(size, scale, !!g[g.length - 1].tapped).w + Math.min(g.length - 1, PILE_DEPTH) * Math.round(PILE_STEP * scale) + 6, 0)
  const inset = !mirrored && others.length
    ? Math.max(Math.round(CARD_W[otherFit.size] * scale * 2.5), dims.w * 0.4 - Math.min(rowW(lands, landFit.size), sideW(lands.length)))
    : 0
  const backRow = hasBack ? (
    <div className={`relative flex shrink-0 items-end gap-6 px-1 ${inset ? 'justify-start' : 'justify-between'}`} style={{ height: backH }}>
      {center && <div className="absolute left-1/2 top-0 z-10 -translate-x-1/2">{center}</div>}
      <div className={`flex min-w-0 flex-wrap items-end gap-1.5 ${landFit.fits ? '' : 'overflow-y-auto'}`} style={{ maxWidth: sideW(lands.length) || undefined, maxHeight: backH }}>
        {lands.map((g) => <Pile key={g[0].id} cards={g} size={landFit.size} onCard={onCard} onHover={onHover} extras={attachments} />)}
      </div>
      <div className={`flex min-w-0 flex-wrap items-end gap-1.5 ${inset ? '' : 'justify-end'} ${otherFit.fits ? '' : 'overflow-y-auto'}`}
        style={{ maxWidth: sideW(others.length) || undefined, maxHeight: backH, marginLeft: inset ? Math.max(0, inset - 24) : undefined }}>
        {others.map((g) => <Pile key={g[0].id} cards={g} size={otherFit.size} onCard={onCard} onHover={onHover} extras={attachments} />)}
      </div>
    </div>
  ) : null
  return (
    <div ref={box} className="flex h-full flex-col gap-2 overflow-hidden" style={offset ? { rowGap: offset } : undefined}>
      {mirrored ? <>{backRow}{frontRow}</> : <>{frontRow}{backRow}</>}
    </div>
  )
}

// ---------------------------------------------------------------- portraits

/**
 * A player: their commander's art in a medallion, life total on it, a ring
 * that drains as life drops. Click it when a spell asks you to pick a player.
 */
export function Portrait({ player, state, card, onPlayer, size = 92, payLife = null }: {
  player: GamePlayer; state: GameState; card: CardLookup; onPlayer: (p: GamePlayer) => void; size?: number
  /** Life a click here would pay for Phyrexian mana right now, or null. */
  payLife?: number | null
}): React.JSX.Element {
  const zoom = useTableScale()
  const prev = useRef(player.life)
  const [flash, setFlash] = useState<'hit' | 'heal' | null>(null)
  useEffect(() => {
    if (player.life === prev.current) return undefined
    setFlash(player.life < prev.current ? 'hit' : 'heal')
    prev.current = player.life
    const t = setTimeout(() => setFlash(null), 800)
    return () => clearTimeout(t)
  }, [player.life])
  const cmd = player.commanders.map(card).find(Boolean)
  const art = cmd?.art ? scryfallImage(cmd.art, 'art_crop') : null
  const frac = Math.max(0, Math.min(1, player.life / 40))
  const ring = player.life <= 10 ? '#f87171' : player.life <= 20 ? '#fbbf24' : '#c4b5fd'
  const active = state.activePlayer === player.id
  const you = player.id === state.you
  return (
    <div className="flex flex-col items-center" style={{ zoom }}>
      <button
        data-pid={player.id}
        onClick={() => onPlayer(player)}
        title={payLife ? `Click to pay ${payLife} life instead of the Phyrexian mana` : `${you ? 'You' : player.name} — ${player.life} life${'\n'}Click when a spell or ability asks you to choose a player.`}
        className={`group relative rounded-full transition-transform hover:scale-105 ${player.lost ? 'opacity-40 grayscale' : ''}`}
        style={{ width: size, height: size }}
      >
        {/* Life ring */}
        <span className="absolute inset-0 rounded-full" style={{ background: `conic-gradient(${ring} ${frac * 360}deg, rgba(255,255,255,0.1) 0)` }} />
        {/* Turn / target glow */}
        <span className={`absolute -inset-1.5 rounded-full transition-shadow ${
          payLife ? 'animate-pulse shadow-[0_0_24px_6px_rgba(52,211,153,0.7)]' : player.highlighted ? 'shadow-[0_0_24px_6px_rgba(248,113,113,0.75)]' : active ? 'shadow-[0_0_22px_4px_rgba(252,211,77,0.45)]' : ''
        }`} />
        <span className="absolute inset-[4px] overflow-hidden rounded-full bg-[#1c1a26] ring-1 ring-black/60">
          {art
            ? <img src={art.src} alt="" draggable={false} className="h-full w-full scale-125 object-cover" />
            : <span className="flex h-full w-full items-center justify-center text-3xl font-bold text-white/30">{player.name.slice(0, 1)}</span>}
          <span className={`absolute inset-0 transition-colors duration-300 ${flash === 'hit' ? 'bg-red-600/55' : flash === 'heal' ? 'bg-emerald-500/45' : 'bg-gradient-to-t from-black/70 via-transparent to-transparent'}`} />
        </span>
        <span className="absolute -bottom-2 left-1/2 min-w-[46px] -translate-x-1/2 rounded-full border border-white/20 bg-[#141218] px-2 text-center text-[19px] font-bold leading-6 tabular-nums text-white shadow-lg">
          {player.life}
        </span>
        {player.priority && <span title="Has priority" className="absolute -right-1 top-0 rounded-full bg-amber-400 px-1 text-[10px] text-black">⏳</span>}
      </button>
      <span className="mt-3 max-w-[140px] truncate text-[11px] font-medium text-white/70">{you ? 'You' : player.name}</span>
      <PlayerCounters counters={player.counters} />
    </div>
  )
}

/** Counters on players — rad, poison, energy… — with what each one does on hover. */
const PLAYER_COUNTERS: Record<string, { icon: string; label: string; cls: string; hint: string }> = {
  RAD: { icon: '☢', label: 'Rad', cls: 'bg-lime-400/20 text-lime-200 ring-lime-300/50', hint: 'At the start of your first main phase, mill that many cards. For each nonland card milled, lose 1 life and remove a rad counter.' },
  POISON: { icon: '☠', label: 'Poison', cls: 'bg-emerald-600/25 text-emerald-200 ring-emerald-400/50', hint: 'A player with 10 or more poison counters loses the game.' },
  ENERGY: { icon: '⚡', label: 'Energy', cls: 'bg-amber-400/20 text-amber-200 ring-amber-300/50', hint: 'Spent to pay {E} costs.' },
  EXPERIENCE: { icon: '★', label: 'Experience', cls: 'bg-sky-400/20 text-sky-200 ring-sky-300/50', hint: 'Counts up for cards that care about experience.' },
  TICKET: { icon: '🎟', label: 'Ticket', cls: 'bg-fuchsia-400/20 text-fuchsia-200 ring-fuchsia-300/50', hint: 'Spent to pay ticket costs.' }
}

function PlayerCounters({ counters }: { counters: Record<string, number> | undefined }): React.JSX.Element | null {
  const list = Object.entries(counters ?? {}).filter(([, n]) => n > 0)
  if (!list.length) return null
  return (
    <div className="mt-1 flex max-w-[160px] flex-wrap justify-center gap-1">
      {list.map(([k, n]) => {
        const d = PLAYER_COUNTERS[k] ?? { icon: '●', label: k.charAt(0) + k.slice(1).toLowerCase(), cls: 'bg-white/10 text-white/80 ring-white/30', hint: '' }
        const danger = k === 'POISON' && n >= 7
        return (
          <span key={k} title={`${n} ${d.label} counter${n === 1 ? '' : 's'}${d.hint ? `\n${d.hint}` : ''}`}
            className={`flex items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums ring-1 ${d.cls} ${danger ? 'animate-pulse' : ''}`}>
            <span aria-hidden>{d.icon}</span>{n}{k === 'POISON' ? '/10' : ''}
          </span>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- hand

/**
 * Your hand, fanned along an arc at the bottom edge. The card under the
 * pointer lifts out of the fan, straightens, and its neighbours slide apart.
 *
 * Which card that is comes from where the pointer sits ALONG the fan (each
 * card owns an equal slice), not from per-card hover: with a big hand the
 * cards overlap and tilt, and a lifted card covers its neighbours, so
 * hit-testing the cards themselves made the pick jump and flicker.
 */
export function Hand({ ids, card, onCard, onHover }: { ids: number[]; card: CardLookup; onCard: OnCard; onHover: OnHover }): React.JSX.Element {
  const scale = useTableScale()
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const cards = ids.map(card).filter((c): c is GameCard => !!c)
  const n = cards.length
  const w = Math.round(CARD_W.lg * scale)
  const h = Math.round(w * 1.4)
  // Spacing: full width apart when there's room, overlapping as the hand grows.
  const step = n > 1 ? Math.min(w * 0.82, (width - w) / (n - 1)) : 0
  const tilt = Math.min(6, 44 / Math.max(1, n))
  // The bottom of each card sits off the table edge; hovering lifts it out.
  const sink = Math.round(h * 0.28)
  const [focus, setFocus] = useState<number | null>(null)
  const focused = focus != null && focus < n ? cards[focus] : null
  useEffect(() => { onHover(focused) }, [focused?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Make room around the lifted card so its neighbours stay readable and clickable.
  const room = Math.max(0, w * 0.62 - step)
  const pick = (e: React.MouseEvent): void => {
    if (!n || !box.current) return
    const r = box.current.getBoundingClientRect()
    const x = (e.clientX - r.left) / ((r.width || 1) / width) - width / 2
    const span = (n - 1) * step
    // Outside the fan (a short hand in a wide row) picks nothing.
    if (Math.abs(x) > span / 2 + w / 2) { setFocus(null); return }
    setFocus(n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(x / step + (n - 1) / 2))))
  }
  return (
    <div ref={box} className="relative w-full" style={{ height: h - sink + 8 }}
      onMouseMove={pick} onMouseLeave={() => setFocus(null)}
      onClick={() => focused && onCard(focused)}>
      {cards.map((c, i) => {
        const off = i - (n - 1) / 2
        const d = focus == null ? 0 : i - focus
        const push = d === 0 ? 0 : Math.sign(d) * room * Math.max(0.35, 1 / Math.abs(d))
        const style = {
          left: `calc(50% + ${off * step - w / 2 + push}px)`,
          bottom: -sink - Math.abs(off) ** 2 * tilt * 0.55,
          '--rot': `${off * tilt}deg`,
          zIndex: d === 0 && focus != null ? 60 : i
        } as React.CSSProperties
        return (
          // Only the lifted card takes the pointer: it reaches above this row, and
          // being over it must still count as being over the hand.
          <div key={c.id} className={`atlis-hand-card absolute ${d === 0 && focus != null ? 'atlis-hand-up cursor-pointer' : 'pointer-events-none'}`} style={style}>
            <GameCardView card={c} size="lg" />
          </div>
        )
      })}
      {!n && <div className="absolute inset-x-0 bottom-3 text-center text-[11px] text-white/25">No cards in hand</div>}
    </div>
  )
}

export const HAND_CSS = `
.atlis-hand-card{transform-origin:50% 120%;transform:rotate(var(--rot));transition:transform .16s ease-out, bottom .16s ease-out, left .16s ease-out}
.atlis-hand-card.atlis-hand-up{transform:translateY(-34%) rotate(0deg) scale(1.12)}
`

// ---------------------------------------------------------------- heads-up

/**
 * Small notes about what's coming, derived from the board — never rules
 * decisions (Forge makes those), just "this is about to matter".
 */
export function useHeadsUp(state: GameState): string[] {
  return useMemo(() => {
    const out: string[] = []
    const me = state.players.find((p) => p.id === state.you)
    if (!me) return out
    const yourTurn = state.activePlayer === state.you
    const hand = me.zones.hand.map((id) => state.cards[String(id)]).filter(Boolean)
    const phase = state.phase ?? ''

    if (yourTurn && hand.length > 7 && ['MAIN2', 'COMBAT_END', 'END_OF_TURN', 'MAIN1', 'COMBAT_DAMAGE'].includes(phase)) {
      out.push(`You’ll need to discard down to 7 at the end of your turn (${hand.length} in hand).`)
    }
    if (yourTurn && (phase === 'MAIN1' || phase === 'MAIN2') && me.landsPlayed < me.maxLands && hand.some((c) => c.land)) {
      out.push('You haven’t played a land this turn.')
    }
    const pool = Object.values(me.mana).reduce((a, b) => a + b, 0)
    if (pool > 0) out.push(`${pool} unspent mana in your pool — it empties when this step ends.`)

    // Incoming: attackers at you vs your life.
    const atYou = state.combat.filter((c) => c.defenderIsPlayer && c.defender === state.you)
    if (atYou.length) {
      const unblocked = atYou.filter((c) => !c.blockers.length).reduce((a, c) => a + (state.cards[String(c.attacker)]?.power ?? 0), 0)
      if (unblocked >= me.life) out.push(`Lethal incoming: ${unblocked} unblocked damage vs your ${me.life} life.`)
    }
    for (const [cid, d] of Object.entries(me.commanderDamage)) {
      if (d >= 14) out.push(`${state.cards[cid]?.name?.split(',')[0] ?? 'A commander'} has dealt you ${d} commander damage — 21 and you lose.`)
    }
    if (me.life <= 10 && me.life > 0) out.push(`You’re at ${me.life} life.`)
    if (me.library <= 5) out.push(me.library === 0 ? 'Your library is empty — your next draw loses the game.' : `Only ${me.library} card${me.library === 1 ? '' : 's'} left in your library.`)
    return out
  }, [state])
}

export function HeadsUp({ state }: { state: GameState }): React.JSX.Element | null {
  const notes = useHeadsUp(state)
  const zoom = useTableScale()
  if (!notes.length) return null
  return (
    <div className="pointer-events-none flex flex-col items-end gap-1.5" style={{ zoom }}>
      {notes.slice(0, 3).map((n) => (
        <div key={n} className="flex max-w-[300px] items-start gap-2 rounded-lg border border-amber-300/15 bg-black/65 px-3 py-1.5 text-[12px] leading-snug text-white/85 shadow-lg backdrop-blur"
          style={{ animation: 'atlis-enter 0.4s ease-out' }}>
          <span className="mt-px font-bold text-amber-300">!</span>
          <span>{n}</span>
        </div>
      ))}
    </div>
  )
}
