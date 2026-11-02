/**
 * Table sound effects: which events exist, what the user picked for each,
 * and the snapshot diff that decides an event just happened.
 *
 * A sound is named by a source string:
 *   forge:<file>   one of the mp3s bundled with the user's Forge install
 *   custom:<file>  a file the user added (copied into ATLIS's own folder)
 *   land-color     Forge's own trick for lands: the sound of the land's colour
 *   null           off
 * Settings are one JSON blob in the main-process settings table; this module
 * keeps a single in-memory copy that the table and the settings page share.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { GameCard, GameState } from '../../../types'

export type SoundEvent =
  | 'openingHand' | 'draw' | 'yourTurn' | 'needsYou' | 'spellCast' | 'cardOnTable' | 'creatureEnters'
  | 'tokenCreated' | 'artifactEnters' | 'landEnters' | 'attack' | 'block' | 'lifeLoss' | 'creatureDies'
  | 'destroyed' | 'exiled' | 'discard' | 'counter' | 'win' | 'lose'

export interface SoundEventInfo { key: SoundEvent; label: string; hint: string; group: string; def: string | null }

export const SOUND_EVENTS: SoundEventInfo[] = [
  { key: 'openingHand', group: 'Turn flow', label: 'Opening hand', hint: 'Your seven are dealt (and after each mulligan).', def: 'forge:shuffle.mp3' },
  { key: 'draw', group: 'Turn flow', label: 'Draw a card', hint: 'A card goes from your library to your hand.', def: 'forge:draw.mp3' },
  { key: 'yourTurn', group: 'Turn flow', label: 'You take control', hint: 'Your turn starts.', def: 'forge:untap.mp3' },
  { key: 'needsYou', group: 'Turn flow', label: 'A choice needs you', hint: 'A pick-a-card / yes-no / target question pops up.', def: null },
  { key: 'spellCast', group: 'Casting', label: 'Spell cast', hint: 'Any spell goes on the stack — yours or an opponent’s.', def: 'forge:sorcery.mp3' },
  { key: 'cardOnTable', group: 'Entering', label: 'Card hits the table', hint: 'Enchantments, planeswalkers and any other permanent without its own sound below.', def: 'forge:enchant.mp3' },
  { key: 'creatureEnters', group: 'Entering', label: 'Creature enters', hint: 'A creature card lands on the battlefield.', def: 'forge:creature.mp3' },
  { key: 'tokenCreated', group: 'Entering', label: 'Token created', hint: 'Goblins, Treasures, copies — any token.', def: 'forge:token.mp3' },
  { key: 'artifactEnters', group: 'Entering', label: 'Artifact enters', hint: 'A non-creature artifact lands.', def: 'forge:artifact.mp3' },
  { key: 'landEnters', group: 'Entering', label: 'Land enters', hint: '“Land colour” picks Forge’s Plains / Island / Swamp / Mountain / Forest sound.', def: 'land-color' },
  { key: 'attack', group: 'Combat', label: 'Creatures attack', hint: 'Attackers are declared.', def: 'forge:block.mp3' },
  { key: 'block', group: 'Combat', label: 'Creatures block', hint: 'Blockers are declared.', def: 'forge:block.mp3' },
  { key: 'lifeLoss', group: 'Combat', label: 'Life lost', hint: 'Any player’s life goes down.', def: 'forge:life_loss.mp3' },
  { key: 'creatureDies', group: 'Leaving', label: 'Creature dies', hint: 'A creature goes to the graveyard.', def: 'forge:destroy.mp3' },
  { key: 'destroyed', group: 'Leaving', label: 'Artifact / enchantment destroyed', hint: 'A non-creature permanent goes to the graveyard.', def: 'forge:destroy.mp3' },
  { key: 'exiled', group: 'Leaving', label: 'Exiled', hint: 'A permanent is exiled.', def: 'forge:flip_card.mp3' },
  { key: 'discard', group: 'Leaving', label: 'Discard', hint: 'A card goes from your hand to the graveyard.', def: 'forge:discard.mp3' },
  { key: 'counter', group: 'Other', label: 'Counter added', hint: '+1/+1, loyalty, any counter goes up.', def: 'forge:add_counter.mp3' },
  { key: 'win', group: 'Other', label: 'You win', hint: '', def: 'forge:win_duel.mp3' },
  { key: 'lose', group: 'Other', label: 'You lose', hint: '', def: 'forge:lose_duel.mp3' }
]

export interface SoundSettings {
  enabled: boolean
  volume: number
  events: Partial<Record<SoundEvent, { sound: string | null; volume: number }>>
}

const DEFAULTS: SoundSettings = { enabled: true, volume: 0.6, events: {} }

// ------------------------------------------------------------------ store

let settings: SoundSettings = DEFAULTS
let forgeFiles: string[] = []
let customFiles: string[] = []
let loaded: Promise<void> | null = null
const listeners = new Set<() => void>()
let snapshot = { settings, forgeFiles, customFiles }
const emit = (): void => { snapshot = { settings, forgeFiles, customFiles }; listeners.forEach((l) => l()) }

export function loadSounds(force = false): Promise<void> {
  if (loaded && !force) return loaded
  loaded = window.atlis.mtg.soundLibrary().then((lib) => {
    const s = lib.settings as Partial<SoundSettings> | null
    settings = { ...DEFAULTS, ...(s ?? {}), events: { ...(s?.events ?? {}) } }
    forgeFiles = lib.forge
    customFiles = lib.custom
    emit()
  }).catch(() => { /* no sounds is fine */ })
  return loaded
}

export function useSounds(): typeof snapshot {
  useEffect(() => { void loadSounds() }, [])
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => snapshot)
}

export function updateSounds(patch: (s: SoundSettings) => SoundSettings): void {
  settings = patch(settings)
  emit()
  void window.atlis.mtg.soundSave(settings)
}

export async function importSounds(): Promise<string[]> {
  const added = await window.atlis.mtg.soundImport()
  await loadSounds(true)
  return added
}

export async function removeSound(name: string): Promise<void> {
  await window.atlis.mtg.soundRemove(name)
  // Anything that used it falls back to off rather than a dead file.
  updateSounds((s) => ({
    ...s,
    events: Object.fromEntries(Object.entries(s.events).map(([k, v]) => [k, v && v.sound === `custom:${name}` ? { ...v, sound: null } : v]))
  }))
  await loadSounds(true)
}

/** What an event plays right now (the user's pick, else the default). */
export function eventChoice(key: SoundEvent, s: SoundSettings = settings): { sound: string | null; volume: number } {
  const info = SOUND_EVENTS.find((e) => e.key === key)
  const own = s.events[key]
  return { sound: own ? own.sound : info?.def ?? null, volume: own?.volume ?? 1 }
}

// ------------------------------------------------------------------ playback

export function soundUrl(source: string): string | null {
  const i = source.indexOf(':')
  if (i < 0) return null
  const where = source.slice(0, i)
  if (where !== 'forge' && where !== 'custom') return null
  return `atlis-sound://${where}/${encodeURIComponent(source.slice(i + 1))}`
}

const LAND_SOUND: Record<string, string> = { W: 'white_land', U: 'blue_land', B: 'black_land', R: 'red_land', G: 'green_land' }
const BASIC: Record<string, string> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' }

/** A land's colour, the way Forge picks its sound: basic types first, then what it taps for. */
function landColor(card?: GameCard): string {
  for (const [t, c] of Object.entries(BASIC)) if (card?.type?.includes(t)) return c
  const m = card?.text?.match(/\{([WUBRG])\}/)
  return m ? m[1] : 'G'
}

const lastPlayed = new Map<string, number>()

export function playSource(source: string | null, volume = 1, card?: GameCard): void {
  if (!source) return
  if (source === 'land-color') source = `forge:${LAND_SOUND[landColor(card)]}.mp3`
  const url = soundUrl(source)
  if (!url) return
  // Ten goblins at once is one goblin sound, not ten stacked.
  const now = performance.now()
  if (now - (lastPlayed.get(url) ?? 0) < 120) return
  lastPlayed.set(url, now)
  const a = new Audio(url)
  a.volume = Math.max(0, Math.min(1, volume))
  void a.play().catch(() => { /* missing file or autoplay block: stay quiet */ })
}

export function playEvent(key: SoundEvent, card?: GameCard): void {
  if (!settings.enabled) return
  const c = eventChoice(key)
  playSource(c.sound, c.volume * settings.volume, card)
}

// ------------------------------------------------------------------ what happened

function zoneMap(s: GameState): Map<number, { zone: string; player: number }> {
  const m = new Map<number, { zone: string; player: number }>()
  for (const p of s.players) for (const [z, ids] of Object.entries(p.zones)) for (const id of ids) m.set(id, { zone: z, player: p.id })
  return m
}

const counterTotal = (c?: GameCard): number => Object.values(c?.counters ?? {}).reduce((a, b) => a + b, 0)

/** Diff two snapshots into the sound events they imply (one card per event, for land colour). */
export function soundEventsBetween(prev: GameState, next: GameState): Array<{ key: SoundEvent; card?: GameCard }> {
  const out: Array<{ key: SoundEvent; card?: GameCard }> = []
  const fire = (key: SoundEvent, card?: GameCard): void => { if (!out.some((e) => e.key === key)) out.push({ key, card }) }
  const before = zoneMap(prev)
  const now = zoneMap(next)
  const card = (id: number): GameCard | undefined => next.cards[String(id)] ?? prev.cards[String(id)]
  const me = next.you

  // Opening hand: five-plus cards arrive in your hand at once (the deal, or a mulligan's new seven).
  const myHand = next.players.find((p) => p.id === me)?.zones.hand ?? []
  const dealt = myHand.filter((id) => !before.has(id)).length >= 5
  if (dealt) fire('openingHand')

  for (const [id, z] of now) {
    const was = before.get(id)
    const c = card(id)
    if (z.zone === 'battlefield' && was?.zone !== 'battlefield') {
      if (c?.token) fire('tokenCreated', c)
      else if (c?.land) fire('landEnters', c)
      else if (c?.creature) fire('creatureEnters', c)
      else if (/Artifact/.test(c?.type ?? '')) fire('artifactEnters', c)
      else fire('cardOnTable', c)
    } else if (z.zone === 'hand' && z.player === me && !was && !dealt) {
      fire('draw', c)
    }
    if (z.zone === 'battlefield' && was?.zone === 'battlefield' && counterTotal(c) > counterTotal(prev.cards[String(id)])) fire('counter', c)
  }
  for (const [id, was] of before) {
    const z = now.get(id)
    const c = prev.cards[String(id)] ?? card(id)
    if (was.zone === 'battlefield' && z?.zone !== 'battlefield') {
      if (z?.zone === 'graveyard') fire(c?.creature ? 'creatureDies' : 'destroyed', c)
      else if (z?.zone === 'exile') fire('exiled', c)
    } else if (was.zone === 'hand' && was.player === me && z?.zone === 'graveyard') {
      fire('discard', c)
    }
  }

  const oldStack = new Set(prev.stack.map((s) => s.id))
  if (next.stack.some((s) => !oldStack.has(s.id) && !s.ability && !s.trigger)) fire('spellCast')

  if (next.activePlayer === me && prev.activePlayer !== me && me != null) fire('yourTurn')
  if (next.combat.length > 0 && prev.combat.length === 0) fire('attack')
  const blockers = (s: GameState): number => s.combat.reduce((a, c) => a + c.blockers.length, 0)
  if (blockers(next) > blockers(prev)) fire('block')
  if (next.players.some((p) => p.life < (prev.players.find((q) => q.id === p.id)?.life ?? p.life))) fire('lifeLoss')

  if (next.gameOver && !prev.gameOver) {
    const myName = next.players.find((p) => p.id === me)?.name
    fire(next.winner && next.winner === myName ? 'win' : 'lose')
  }
  return out
}

/** Play the table's sounds as snapshots arrive. */
export function useTableSounds(state: GameState | null): void {
  useSounds()
  const prev = useRef<GameState | null>(null)
  useEffect(() => {
    if (!state) return
    if (prev.current && prev.current !== state) for (const e of soundEventsBetween(prev.current, state)) playEvent(e.key, e.card)
    // The deal can already be in the very first snapshot.
    else if (!prev.current && (state.players.find((p) => p.id === state.you)?.zones.hand.length ?? 0) >= 5) playEvent('openingHand')
    prev.current = state
  }, [state])
}
