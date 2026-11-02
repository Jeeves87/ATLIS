/**
 * Play Commander in ATLIS: Forge's engine (via forge-bridge), ATLIS's table.
 *
 * The table is Commander-first: every seat shows life, its commander in the
 * command zone with the current tax, and the commander damage it has taken —
 * the three numbers that decide Commander games and that Forge's own client
 * buries. Your seat sits bottom-left; in a 4-player pod the next player sits
 * to your right and the others across the top (see podLayout).
 *
 * Nothing here decides legality. Clicks go to Forge as the same actions its
 * desktop client sends, Forge's highlights say what's possible, and Forge's
 * prompt says what it's waiting for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Crown, Flag, Layers, Loader2, LogOut, Maximize2, Moon, Skull, Sparkles, Sunrise, Swords, Volume2, VolumeX, Wand2, X } from 'lucide-react'
import GameCardView, { CARD_W, type CardSize, useTableScale } from './GameCardView'
import RequestDialog from './RequestDialog'
import Arrows from './Arrows'
import { FX_CSS, FxProvider, GhostLayer, useZoneFx } from './fx'
import { playEvent, updateSounds, useSounds, useTableSounds } from './sounds'
import { Battlefield, HAND_CSS, Hand, HeadsUp, Portrait, type CardLookup } from './Board'
import { matBackground, matIsImage, useTableLook } from './tableLook'
import { scryfallImage } from '../../../lib/mtgImages'
import type { GameCard, GameDeckOption, GameEvent, GamePlayer, GameRequest, GameState } from '../../../types'

// ---------------------------------------------------------------- turn structure + teaching

const STEPS: Array<[string, string, string]> = [
  ['UNTAP', 'Untap', 'Your permanents untap. Nobody gets priority.'],
  ['UPKEEP', 'Upkeep', '“At the beginning of your upkeep” triggers go on the stack.'],
  ['DRAW', 'Draw', 'The active player draws a card.'],
  ['MAIN1', 'Main 1', 'Play a land (one per turn) and cast spells of any type while the stack is empty.'],
  ['COMBAT_BEGIN', 'Combat', 'Last chance to act before attackers are declared — e.g. tap a would-be attacker.'],
  ['COMBAT_DECLARE_ATTACKERS', 'Attack', 'Choose attackers and who each attacks. Attacking taps them (unless vigilance).'],
  ['COMBAT_DECLARE_BLOCKERS', 'Block', 'Defenders assign blockers. Each blocker blocks one attacker.'],
  ['COMBAT_FIRST_STRIKE_DAMAGE', '1st strike', 'Creatures with first or double strike deal damage first.'],
  ['COMBAT_DAMAGE', 'Damage', 'Combat damage is dealt. 21 from one commander knocks a player out.'],
  ['COMBAT_END', 'End combat', '“At end of combat” triggers.'],
  ['MAIN2', 'Main 2', 'Another main phase: cast what you held back during combat. Land still allowed if unused.'],
  ['END_OF_TURN', 'End', '“At the beginning of the end step” triggers. Classic time for instant-speed plays.'],
  ['CLEANUP', 'Cleanup', 'Discard to seven; damage wears off.']
]
const STEP_INDEX = new Map(STEPS.map(([k], i) => [k, i]))

const MANA: Array<{ k: keyof GamePlayer['mana']; byte: number; cls: string }> = [
  { k: 'W', byte: 1, cls: 'bg-amber-100 text-black' },
  { k: 'U', byte: 2, cls: 'bg-sky-500 text-white' },
  { k: 'B', byte: 4, cls: 'bg-zinc-700 text-white' },
  { k: 'R', byte: 8, cls: 'bg-red-500 text-white' },
  { k: 'G', byte: 16, cls: 'bg-emerald-600 text-white' },
  { k: 'C', byte: 0, cls: 'bg-zinc-400 text-black' }
]

// ---------------------------------------------------------------- entry: setup or table

export default function PlayInAtlis({ onStatus }: { onStatus: (s: string | null) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return open
    ? <GameTable onExit={() => setOpen(false)} onStatus={onStatus} />
    : <MatchSetup onStarted={() => setOpen(true)} onStatus={onStatus} />
}

function MatchSetup({ onStarted, onStatus }: { onStarted: () => void; onStatus: (s: string | null) => void }): React.JSX.Element {
  const [ready, setReady] = useState<{ ok: boolean; problems: string[] } | null>(null)
  const [decks, setDecks] = useState<GameDeckOption[] | null>(null)
  const [mine, setMine] = useState('')
  const [opps, setOpps] = useState<string[]>([''])
  const [filter, setFilter] = useState('')
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    void window.atlis.mtg.gameReadiness().then(setReady)
    void window.atlis.mtg.gameDecks().then((d) => {
      setDecks(d)
      const own = d.filter((x) => x.kind === 'atlis')
      if (own[0]?.deckId) setMine(own[0].deckId)
      const firstOpp = own[1] ?? d.find((x) => x.kind === 'precon')
      if (firstOpp) setOpps([firstOpp.path])
    }).catch((e) => onStatus(e instanceof Error ? e.message : String(e)))
  }, [onStatus])

  const own = (decks ?? []).filter((d) => d.kind === 'atlis')
  const precons = (decks ?? []).filter((d) => d.kind === 'precon')
    .filter((d) => !filter || `${d.name} ${d.set ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => (b.year ?? '').localeCompare(a.year ?? '') || a.name.localeCompare(b.name))

  const start = async (): Promise<void> => {
    setStarting(true)
    try {
      await window.atlis.mtg.gameStart({ deckId: mine, opponents: opps.filter(Boolean) })
      onStarted()
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  if (!ready || !decks) return <div className="flex items-center gap-2 text-sm text-white/50"><Loader2 className="h-4 w-4 animate-spin" /> Checking Forge and your decks…</div>
  if (!ready.ok) {
    return (
      <div className="max-w-xl rounded-md border border-amber-400/30 bg-amber-500/[0.06] p-4 text-sm text-amber-100/90">
        <div className="mb-2 font-medium">Almost there</div>
        <ul className="list-disc space-y-1 pl-5 text-[13px]">{ready.problems.map((p) => <li key={p}>{p}</li>)}</ul>
      </div>
    )
  }
  if (!own.length) return <p className="text-sm text-white/40">Save a deck with a commander on the Decks tab first.</p>

  const select = 'w-full rounded-md border border-white/10 bg-[#16161d] px-2 py-1.5 text-sm focus:border-violet-400/50 focus:outline-none'
  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/40">Your deck</div>
        <select value={mine} onChange={(e) => setMine(e.target.value)} className={select}>
          {own.map((d) => <option key={d.deckId} value={d.deckId}>{d.name}</option>)}
        </select>
      </div>
      <div>
        <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-white/40">
          Opponents (AI) <span className="normal-case text-white/30">— one for a duel, three for a full pod</span>
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${precons.length} Forge precons…`}
          className="mb-2 w-full rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5 text-sm placeholder:text-white/25" />
        <div className="space-y-2">
          {opps.map((o, i) => (
            <div key={i} className="flex gap-2">
              <select value={o} onChange={(e) => setOpps((p) => p.map((x, j) => (j === i ? e.target.value : x)))} className={select}>
                <option value="">— choose —</option>
                <optgroup label="Your decks">
                  {own.filter((d) => d.deckId !== mine).map((d) => <option key={d.path} value={d.path}>{d.name}</option>)}
                </optgroup>
                <optgroup label="Forge Commander precons">
                  {precons.map((d) => <option key={d.path} value={d.path}>{d.name} ({d.set} {d.year})</option>)}
                </optgroup>
              </select>
              {opps.length > 1 && (
                <button onClick={() => setOpps((p) => p.filter((_, j) => j !== i))} className="rounded border border-white/10 px-2 text-white/40 hover:bg-white/10"><X className="h-4 w-4" /></button>
              )}
            </div>
          ))}
          {opps.length < 3 && (
            <button onClick={() => setOpps((p) => [...p, ''])} className="text-[12px] text-violet-300 hover:text-violet-200">+ Add an opponent</button>
          )}
        </div>
      </div>
      <button onClick={() => void start()} disabled={starting || !mine || !opps.some(Boolean)}
        className="inline-flex items-center gap-2 rounded-md border border-violet-400/40 bg-violet-500/25 px-4 py-2 text-sm text-violet-100 hover:bg-violet-500/35 disabled:opacity-50">
        {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Swords className="h-4 w-4" />} Start game
      </button>
      <p className="text-[11px] text-white/35">
        Forge’s rules engine runs behind the table, so every rule, trigger and combo is handled exactly. Starting takes
        10–20 seconds while it loads its card database.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- the table

interface Toast { id: number; text: string; tone: 'info' | 'error' | 'rule' }

export function GameTable({ onExit, onStatus }: { onExit: () => void; onStatus: (s: string | null) => void }): React.JSX.Element {
  const [state, setState] = useState<GameState | null>(null)
  // The latest state, for event handlers registered once.
  const stateRef = useRef<GameState | null>(null)
  stateRef.current = state
  const [requests, setRequests] = useState<GameRequest[]>([])
  const [phase, setPhase] = useState<'booting' | 'live' | 'over' | 'crashed'>('booting')
  const [hover, setHover] = useState<GameCard | null>(null)
  const [zone, setZone] = useState<{ player: number; zone: 'graveyard' | 'exile' } | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [shake, setShake] = useState(false)
  const [crash, setCrash] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ title: string; cards: number[]; labels: string[] } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  // Zone changes between snapshots → card arrivals and leave-the-battlefield ghosts.
  const { fx, ghosts } = useZoneFx(state, root)
  // ...and the same changes as sound (Play → Sounds picks what plays).
  useTableSounds(state)
  const soundOn = useSounds().settings.enabled
  const { look, mats } = useTableLook()
  // Each AI seat gets one of your added playmats, dealt at random once per game:
  // different from each other and from yours while there are enough to go round.
  const seatMats = useRef(new Map<number, string>())
  const seatMat = (id: number): string | null => {
    const dealt = seatMats.current
    const had = dealt.get(id)
    if (had && mats.includes(had)) return had
    if (!mats.length) return null
    const taken = new Set([...dealt.values(), look.mat.startsWith('mat:') ? look.mat.slice(4) : ''])
    const fresh = mats.filter((m) => !taken.has(m))
    const pool = fresh.length ? fresh : mats
    const pick = pool[Math.floor(Math.random() * pool.length)]
    dealt.set(id, pick)
    return pick
  }
  // Which across-the-table board is shown large when none of them is acting.
  const [topFocus, setTopFocus] = useState<number | null>(null)

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-3), { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'info' ? 5000 : 9000)
  }, [])

  // A replacement effect can make a card skip the table entirely (a token copy
  // of Mox Diamond with no land to discard goes straight to the graveyard and
  // ceases to exist) — with nothing to animate, say what the rule did. Routine
  // ones (enters tapped, +1 damage, prevention) stay in the log.
  const seenLog = useRef<number | null>(null)
  const gyLands = useRef(0)
  const gyIds = useRef<Set<number>>(new Set())
  useEffect(() => {
    const log = (state?.log ?? []) as Array<{ n?: number; type: string; text: string; card?: number }>
    if (!log.length) return
    const newest = Math.max(...log.map((x) => x.n ?? 0))
    const from = seenLog.current
    seenLog.current = newest
    if (from == null) {
      const me0 = state?.players.find((p) => p.id === state.you)
      gyLands.current = me0 ? me0.zones.graveyard.filter((id) => state?.cards[String(id)]?.land).length : 0
      gyIds.current = new Set(me0?.zones.graveyard ?? [])
      return
    }
    const me = state?.players.find((p) => p.id === state.you)
    // "No land to discard" only if none went to your graveyard just now either.
    const landsInGy = me ? me.zones.graveyard.filter((id) => state?.cards[String(id)]?.land).length : 0
    const discardedLand = landsInGy > gyLands.current
    gyLands.current = landsInGy
    const newInGy = (me?.zones.graveyard ?? []).filter((id) => !gyIds.current.has(id)).map((id) => state?.cards[String(id)]?.name)
    gyIds.current = new Set(me?.zones.graveyard ?? [])
    const noLand = me ? !discardedLand && !me.zones.hand.some((id) => state?.cards[String(id)]?.land) : false
    for (const x of log) {
      if ((x.n ?? 0) <= from || x.type !== 'EFFECT_REPLACED') continue
      if (/enters? (the battlefield )?tapped|that much damage|prevent/i.test(x.text)) continue
      const name = x.card != null ? state?.cards[String(x.card)]?.name : null
      let text = x.text.replace(/ \(\d+\)/g, '')
      if (/discard a land/i.test(text) && noLand) {
        // A real card stays in the graveyard; a token copy ceases to exist there (rule 111.7).
        const who = text.match(/^If (.+?) would enter/)?.[1]
        const landed = who ? newInGy.includes(who) : true
        text += landed
          ? ' You had no land in hand, so it went to the graveyard.'
          : ' You had no land in hand, so it went to the graveyard — and because it was a token copy, it ceased to exist there (tokens can’t stay in a graveyard).'
      }
      toast(`${name ? `${name}: ` : ''}${text}`, 'rule')
    }
  }, [state, toast])

  useEffect(() => window.atlis.mtg.onGameEvent((e: GameEvent) => {
    switch (e.type) {
      case 'state': setState(e); setPhase((p) => (p === 'booting' ? 'live' : p)); if (e.gameOver) setPhase('over'); break
      case 'request': setRequests((r) => [...r, e]); playEvent('needsYou'); break
      case 'gameOver': setPhase('over'); break
      case 'invalid': setShake(true); setTimeout(() => setShake(false), 400); break
      case 'message': {
        // Forge's bare rejection, explained when a forced attacker is the reason.
        const forced = /Attack declaration invalid/i.test(e.message) && stateRef.current ? attackGuide(stateRef.current) : null
        toast(forced ? `Attack not allowed: ${forced.headline}. ${forced.detail}.` : `${e.title ? `${e.title}: ` : ''}${e.message}`, forced ? 'rule' : undefined)
        break
      }
      case 'reveal': setReveal({
        title: e.title,
        cards: e.options.filter((o) => o.card != null).map((o) => o.card as number),
        labels: e.options.filter((o) => o.card == null && !/^=+/.test(o.label)).map((o) => o.label)
      }); break
      case 'error': toast(e.message, 'error'); break
      case 'exited': if (e.code) { setCrash(e.detail ?? `exit ${e.code}`); setPhase('crashed') } break
      default: break
    }
  }), [toast])

  const send = useCallback((cmd: string, extra: Record<string, unknown> = {}) => { void window.atlis.mtg.gameSend({ cmd, ...extra }) }, [])
  const answer = useCallback((rid: number, value: unknown) => {
    send('answer', { rid, value })
    setRequests((r) => r.filter((x) => x.rid !== rid))
  }, [send])
  const leave = (): void => { void window.atlis.mtg.gameStop(); onStatus(null); onExit() }

  // Space or mouse button 5 (forward) = the prompt's primary button, so you can
  // keep the game moving without looking away from the board.
  useEffect(() => {
    const primary = (): void => { if (!requests.length && state?.prompt.okEnabled) send('ok') }
    const onKey = (e: KeyboardEvent): void => {
      // DEV ONLY (running from source): Ctrl+Shift+F9 loads a crowded stress
      // board through the bridge's test-only applyState, for checking layout.
      if (import.meta.env.DEV && e.ctrlKey && e.shiftKey && e.code === 'F9') {
        const n = (k: number, card: string): string => Array(k).fill(card).join('; ')
        send('applyState', { lines: [
          'activeplayer=human', 'activephase=MAIN1', 'removesummoningsickness=true',
          `aibattlefield=${[n(4, 'Grizzly Bears'), n(3, 'Serra Angel'), n(3, 'Llanowar Elves'), n(2, 'Colossal Dreadmaw'), n(12, 'Forest'), n(3, 'Sol Ring'), n(3, 'Pacifism')].join('; ')}`,
          `humanbattlefield=${[n(6, 'Grizzly Bears'), n(8, 'Mountain'), n(2, 'Sol Ring')].join('; ')}`,
          `ailibrary=${n(8, 'Forest')}`, `humanlibrary=${n(8, 'Mountain')}`
        ] })
        return
      }
      if (e.code !== 'Space' || (e.target as HTMLElement)?.tagName === 'INPUT') return
      e.preventDefault()
      primary()
    }
    // Buttons 3/4 are back/forward; swallow both so Chromium never treats them as navigation.
    const onDown = (e: MouseEvent): void => { if (e.button === 3 || e.button === 4) e.preventDefault() }
    const onUp = (e: MouseEvent): void => {
      if (e.button !== 4) return
      e.preventDefault()
      primary()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
    }
  }, [state, requests, send])

  // Blocking works in either order: your creature then the attacker, or the
  // attacker then your creatures. Forge only takes attacker-first, so a
  // creature clicked first waits here ("armed") until you pick its attacker.
  const [armed, setArmed] = useState<number | null>(null)
  const [blockTarget, setBlockTarget] = useState<number | null>(null)
  const blocking = state ? blockGuide(state) != null : false
  useEffect(() => { if (!blocking) { setArmed(null); setBlockTarget(null) } }, [blocking])
  const card = useCallback((id: number): GameCard | undefined => {
    const c = state?.cards[String(id)]
    if (!c || !blocking) return c
    if (id === armed) return { ...c, armed: true }
    // Forge always has a default attacker lit; only show yours once you've picked one.
    if (c.attacking && c.highlighted && blockTarget !== id) return { ...c, highlighted: false }
    return c
  }, [state, armed, blocking, blockTarget])
  const you = state?.players.find((p) => p.id === state.you) ?? null
  // The last across-the-table player to act stays large through other turns.
  const activeId = state?.activePlayer
  useEffect(() => {
    if (activeId == null || !state) return
    if (podLayout(state, null).topIds.includes(activeId)) setTopFocus(activeId)
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps
  // Paying a cost with mana floating (Mana Geyser, tapped lands): Forge only
  // takes pool mana by itself when the cost is all colored, and otherwise waits
  // for a gem click per mana. With one color floating there's nothing to
  // choose, so feed the pool in, one mana per update, until it's paid or the
  // pool stops helping. Two+ colors floating stays your call (click the gems).
  // Only for what you just clicked to cast/activate: an optional cost a trigger
  // asks for (Mana Vault's upkeep {4}) is yours to decline, never auto-paid.
  const lastFeed = useRef<string | null>(null)
  const lastClicked = useRef<number | null>(null)
  useEffect(() => {
    if (!state || !you || !/Pay Mana Cost/i.test(state.prompt.message || '')) { lastFeed.current = null; return }
    if (state.prompt.card == null || state.prompt.card !== lastClicked.current) return
    const colors = MANA.filter((m) => you.mana[m.k] > 0)
    if (colors.length !== 1) return
    const key = `${state.prompt.message}|${you.mana[colors[0].k]}`
    if (key === lastFeed.current) return // the last mana changed nothing: this pool can't pay what's left
    lastFeed.current = key
    send('mana', { color: colors[0].byte })
  }, [state, you, send])
  const onCard = useCallback((c: GameCard) => {
    lastClicked.current = c.id
    // Attacked, but blocks aren't declared yet (attack triggers on the stack): a click on
    // your creature would be read as using an ability, and Forge just refuses it.
    if (!blocking && state && attackedBeforeBlocks(state) && c.controller === state.you && c.creature && !c.playable) {
      toast(c.canBlock !== false
        ? 'Blocks come next — resolve what’s on the stack (the dock button) and you’ll choose blockers then. Summoning-sick creatures can block.'
        : `${(c.name ?? 'This creature').split(',')[0]} can’t block any of these attackers (flying needs flying or reach; menace needs two blockers).`, 'rule')
      return
    }
    if (!blocking || !state) { send('card', { id: c.id }); return }
    const fight = state.combat.find((f) => f.attacker === c.id)
    if (fight) {
      // An attacker: give it the waiting creature, or make it the one your next clicks block.
      send('card', { id: c.id })
      if (armed != null) { send('card', { id: armed }); setArmed(null); setBlockTarget(null) } else setBlockTarget(c.id)
      return
    }
    if (c.controller !== state.you) { send('card', { id: c.id }); return }
    const blocked = state.combat.find((f) => f.blockers.includes(c.id))
    if (blocked) {
      // Already blocking: clicking it again takes the block back.
      send('card', { id: blocked.attacker })
      send('card', { id: c.id })
      return
    }
    if (!c.canBlock) { send('card', { id: c.id }); return }
    if (blockTarget != null) { send('card', { id: blockTarget }); send('card', { id: c.id }) } else setArmed((a) => (a === c.id ? null : c.id))
  }, [send, blocking, state, armed, blockTarget, toast])
  const onPlayer = useCallback((p: GamePlayer) => send('player', { id: p.id }), [send])

  if (phase === 'booting' || !state) {
    return (
      <Fullscreen>
        <div className="flex h-full flex-col items-center justify-center gap-3 text-white/60">
          <Loader2 className="h-8 w-8 animate-spin text-violet-300" />
          <div className="text-sm">Shuffling up — Forge is loading its card database…</div>
          <button onClick={leave} className="mt-4 text-[12px] text-white/40 hover:text-white/70">Cancel</button>
        </div>
      </Fullscreen>
    )
  }

  const stepIdx = state.phase ? STEP_INDEX.get(state.phase) ?? -1 : -1
  const pod = podLayout(state, topFocus)
  const tip = stepIdx >= 0 ? STEPS[stepIdx][2] : ''
  const next = explainNext(state)
  const commanderArt = you?.commanders.map((id) => card(id)?.art).find(Boolean) ?? null

  return (
    <Fullscreen>
      <FxProvider value={fx}>
      <style>{FX_CSS + HAND_CSS}</style>
      <div ref={root} className="relative flex h-full flex-col overflow-hidden text-white">
        {/* The felt under everyone; your playmat sits on your area only. */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_40%,#1a1d24_0%,#0b0d11_75%)]" />

        {/* Top bar: just the way out — turn and phase live in the middle of the table. */}
        <div className="relative flex items-center gap-3 bg-black/35 px-3 py-1 backdrop-blur-sm">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/35">Commander</span>
          <span className="flex-1" />
          <button
            onClick={() => updateSounds((s) => ({ ...s, enabled: !s.enabled }))}
            title={soundOn ? 'Mute table sounds (sounds and playmats: Play → Table & sounds)' : 'Turn table sounds on'}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/50 hover:bg-white/10"
          >
            {soundOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />} {soundOn ? 'Sound' : 'Muted'}
          </button>
          <button onClick={() => send('concede')} title="Concede this game" className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/50 hover:bg-white/10"><Flag className="h-3.5 w-3.5" /> Concede</button>
          <button onClick={leave} title="Leave the table" className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/50 hover:bg-white/10"><LogOut className="h-3.5 w-3.5" /> Leave</button>
        </div>

        <div className="relative flex min-h-0 flex-1">
          {/* Play area: every seat is a box placed by podLayout, and the boxes
              glide to new sizes as the turn moves around the table. */}
          <div className="relative min-w-0 flex-1">
            {pod.seats.map(({ id, box, size }) => {
              const p = state.players.find((x) => x.id === id)!
              const acting = state.activePlayer === id
              const mat = seatMat(id)
              return (
                <div key={id} className="absolute p-1 transition-[left,top,width,height] duration-300 ease-out" style={boxStyle(box)}>
                  <div className={`relative h-full rounded-2xl border px-2 pb-1 pt-1 transition-colors ${
                    acting ? 'border-amber-300/60 bg-amber-200/[0.04] shadow-[0_0_30px_rgba(252,211,77,0.12)]' : 'border-white/12 bg-black/20'
                  }`}>
                    {mat && (
                      // One of your added playmats, dimmed more than yours so their board stays readable.
                      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
                        <div className="absolute inset-0" style={{ background: matBackground(`mat:${mat}`) }} />
                        <div className="absolute inset-0" style={{ background: `rgba(6,7,10,${Math.max(look.dim, 0.62)})` }} />
                      </div>
                    )}
                    <div className="relative h-full">
                      <Seat player={p} state={state} card={card} onCard={onCard} onPlayer={onPlayer} onHover={setHover}
                        onZone={(z) => setZone({ player: p.id, zone: z })} size={size} />
                    </div>
                    {size === 'small' && pod.topIds.includes(id) && (
                      <button onClick={() => setTopFocus(id)} title="Show this board large"
                        className="absolute right-1.5 top-1.5 z-20 rounded-md bg-black/60 p-1 text-white/50 hover:text-white"><Maximize2 className="h-3 w-3" /></button>
                    )}
                  </div>
                </div>
              )
            })}

            {/* Your area, on your chosen playmat (AI seats get random ones of your added mats). */}
            {you && (
              <div className="absolute flex flex-col transition-[left,top,width,height] duration-300 ease-out" style={boxStyle(pod.me)}>
                <div className="pointer-events-none absolute inset-1 overflow-hidden rounded-2xl ring-1 ring-white/10">
                  <div className="absolute inset-0"
                    style={{ background: matBackground(look.mat, commanderArt), filter: look.blur ? `blur(${look.blur}px)` : undefined, transform: look.blur ? 'scale(1.04)' : undefined }} />
                  {matIsImage(look.mat) && <div className="absolute inset-0" style={{ background: `rgba(6,7,10,${look.dim})` }} />}
                  <div className="absolute inset-0 shadow-[inset_0_0_120px_30px_rgba(0,0,0,0.6)]" />
                </div>

                <div className="relative min-h-0 flex-1 px-3 pt-2">
                  <Battlefield player={you} card={card} onCard={onCard} onHover={setHover} prefer="xl" />
                </div>

                {/* Vitals | portrait + what Forge is waiting for | (room) */}
                <div className="relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3">
                  <div className="flex min-w-0 items-end justify-start">
                    <PlayerHud player={you} card={card} onMana={(b) => send('mana', { color: b })} onZone={(z) => setZone({ player: you.id, zone: z })} />
                  </div>
                  <div className="flex items-center gap-3">
                    <Portrait player={you} state={state} card={card} onPlayer={onPlayer} size={84} />
                    <ActionDock state={state} shake={shake} tip={tip} next={next} onOk={() => send('ok')} onCancel={() => send('cancel')}
                      armed={armed} blockTarget={blockTarget} />
                  </div>
                  <div />
                </div>

                {/* Library + commander | the hand, fanned | heads-up notes */}
                <div className="relative grid grid-cols-[minmax(0,1fr)_minmax(0,3fr)_minmax(0,1fr)] items-end gap-3 px-3">
                  <div className="flex min-w-0 items-end gap-2 pb-2">
                    <LibraryPile player={you} card={card} onCard={onCard} onHover={setHover} />
                    <CommandZone player={you} card={card} onCard={onCard} onHover={setHover} />
                  </div>
                  <Hand ids={you.zones.hand} card={card} onCard={onCard} onHover={setHover} />
                  <div className="flex justify-end pb-3"><HeadsUp state={state} /></div>
                </div>
              </div>
            )}

            {/* What resolves next: big, beside the board, beaming at its targets. */}
            <StackSpotlight state={state} card={card} onHover={setHover}
              at={{ right: pod.me[0] + pod.me[2], top: pod.me[1] + pod.me[3] * 0.34, byRail: pod.me[0] + pod.me[2] >= 99 }} />
          </div>

          {/* Turn and phase, running down the right edge. */}
          <TurnRail state={state} stepIdx={stepIdx} card={card} nextStop={next?.stop ?? null}
            nextTurnName={next?.stop === 'NEXT_TURN' ? next.button.replace(/^Next: /, '') : null} />

          {/* Right column: the stack in full + the game log */}
          <div className="relative flex w-[280px] shrink-0 flex-col gap-2 border-l border-white/10 bg-black/45 p-2 backdrop-blur-sm">
            <Stack state={state} card={card} onHover={setHover} />
            <GameLog state={state} card={card} onHover={setHover} />
          </div>
        </div>

        <Arrows state={state} root={root} />
        <HoverCard card={hover} />
        <GhostLayer ghosts={ghosts} render={(c) => (
          c.art
            ? <img src={scryfallImage(c.art, 'normal')?.src} alt={c.name} className="h-full w-full rounded-[6px] object-cover shadow-xl" />
            : <div className="flex h-full w-full items-center justify-center rounded-[6px] bg-[#2a2a35] p-1 text-center text-[10px] text-white/80">{c.name}</div>
        )} />

        {/* Toasts */}
        {/* Left of the turn band: the board's quietest spot, clear of the dock and the hand. */}
        <div className="pointer-events-none absolute left-4 top-[42%] z-40 flex max-w-sm -translate-y-1/2 flex-col items-start gap-1">
          {toasts.map((t) => (
            <div key={t.id} className={`max-w-xl rounded-md px-3 py-1.5 text-[12px] shadow-lg ${
              t.tone === 'error' ? 'bg-red-900/90 text-red-100' : t.tone === 'rule' ? 'border border-violet-400/40 bg-[#1b1830]/95 text-violet-50' : 'bg-black/80 text-white/85'
            }`}>{t.tone === 'rule' && <span className="mr-1.5 font-semibold text-violet-300">Rule applied ·</span>}{t.text}</div>
          ))}
        </div>

        {reveal && (
          // Non-blocking: the game keeps going while you look.
          <div className="absolute left-1/2 top-12 z-40 w-[min(720px,90%)] -translate-x-1/2 rounded-xl border border-white/15 bg-[#17171f]/95 p-3 shadow-2xl">
            <div className="mb-2 flex items-start gap-2">
              <div className="flex-1 whitespace-pre-line text-[13px] font-medium">{reveal.title}</div>
              <button onClick={() => setReveal(null)} className="rounded p-1 text-white/50 hover:bg-white/10"><X className="h-4 w-4" /></button>
            </div>
            <div className="flex flex-wrap gap-2">
              {reveal.cards.map((id) => { const c = card(id); return c ? <GameCardView key={id} card={{ ...c, tapped: false }} size="md" onHover={setHover} /> : null })}
              {reveal.labels.map((l) => <span key={l} className="rounded bg-white/5 px-2 py-1 text-[12px] text-white/70">{l}</span>)}
            </div>
          </div>
        )}
        {zone && <ZoneViewer state={state} zone={zone} card={card} onCard={onCard} onHover={setHover} onClose={() => setZone(null)} />}
        {requests[0] && <RequestDialog key={requests[0].rid} req={requests[0]} state={state} onAnswer={answer} onHover={setHover} />}

        {(phase === 'over' || phase === 'crashed') && (
          <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/70">
            <div className="rounded-xl border border-white/15 bg-[#17171f] p-6 text-center shadow-2xl">
              {phase === 'crashed' ? (
                <>
                  <Skull className="mx-auto mb-2 h-8 w-8 text-red-300" />
                  <div className="mb-1 text-lg font-semibold">The rules engine stopped</div>
                  <pre className="mb-4 max-w-lg whitespace-pre-wrap text-left text-[11px] text-white/50">{crash}</pre>
                </>
              ) : (
                <>
                  <Crown className="mx-auto mb-2 h-8 w-8 text-amber-300" />
                  <div className="mb-1 text-lg font-semibold">{state.winner === you?.name ? 'You win!' : `${state.winner ?? 'Game'} wins`}</div>
                  <div className="mb-4 text-sm text-white/50">Turn {state.turn}</div>
                </>
              )}
              <button onClick={leave} className="rounded-md border border-violet-400/40 bg-violet-500/25 px-4 py-2 text-sm text-violet-100">Back to setup</button>
            </div>
          </div>
        )}
      </div>
      </FxProvider>
    </Fullscreen>
  )
}

function Fullscreen({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Below ATLIS's 40px title bar, so its window controls never cover the table's.
  return <div className="fixed inset-x-0 bottom-0 top-10 z-50 bg-[#0e1210]">{children}</div>
}

// ---------------------------------------------------------------- pieces


function CommandZone({ player, card, onCard, onHover, size = 'sm' }: {
  player: GamePlayer; card: CardLookup; onCard: (c: GameCard) => void; onHover: (c: GameCard | null) => void; size?: CardSize
}): React.JSX.Element {
  return (
    <div className="flex items-end gap-1">
      {player.commanders.map((id) => {
        const c = card(id)
        if (!c) return null
        const casts = player.commanderCast[String(id)] ?? 0
        const inZone = c.zone === 'Command'
        return (
          <div key={id} className="relative" title={`Commander tax: casting it from the command zone costs {${casts * 2}} more (cast ${casts}×).`}>
            {/* Only the copy actually IN the command zone anchors arrows; while the
                commander is in play, the battlefield card is the real one. */}
            <GameCardView card={{ ...c, tapped: false }} size={size} onClick={onCard} onHover={onHover} dimmed={!inZone} anchor={inZone} />
            {casts > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-violet-600 px-1.5 text-[10px] font-bold">+{casts * 2}</span>}
            {!inZone && <span className="absolute inset-x-0 bottom-1 text-center text-[9px] text-white/70">{c.zone === 'Battlefield' ? 'in play' : c.zone?.toLowerCase()}</span>}
          </div>
        )
      })}
    </div>
  )
}

/** Commander damage this player has taken, per enemy commander — shown as x/21. */
function CommanderDamage({ player, card }: { player: GamePlayer; card: CardLookup }): React.JSX.Element | null {
  const rows = Object.entries(player.commanderDamage).filter(([, d]) => d > 0)
  if (!rows.length) return null
  return (
    <div className="flex flex-wrap gap-1">
      {rows.map(([cid, d]) => (
        <span key={cid} title={`${d} combat damage from ${card(Number(cid))?.name ?? 'a commander'} — 21 from one commander and this player loses`}
          className={`rounded px-1.5 text-[10px] ${d >= 15 ? 'bg-red-600/70' : 'bg-white/10'} `}>
          ⚔ {card(Number(cid))?.name?.split(',')[0] ?? '?'} {d}/21
        </span>
      ))}
    </div>
  )
}

/** A seat's box in % of the play area: x, y, width, height. */
type Box = [number, number, number, number]
const boxStyle = ([x, y, w, h]: Box): React.CSSProperties => ({ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` })

/**
 * Where everyone sits. You're bottom-left; the next player in turn order sits
 * to your right (with 4+ players), the rest across the top. Whoever is acting
 * gets the big box: across the top that's the wide frame (the others shrink to
 * its side); the player to your right grows into a full-height column, costing
 * your area a little width but never its height. Between turns the last
 * across-the-table player to act (or the one you picked) stays large.
 */
function podLayout(state: GameState, topFocus: number | null): {
  me: Box; seats: Array<{ id: number; box: Box; size: 'big' | 'small' }>; topIds: number[]
} {
  const ids = state.players.map((p) => p.id)
  const at = ids.indexOf(state.you ?? -1)
  const opp = [...ids.slice(at + 1), ...ids.slice(0, Math.max(0, at))]
  // Being attacked: your creatures are the decision, so the top row gives up height.
  const defending = state.combat.some((c) => c.defenderIsPlayer && c.defender === state.you)
  if (opp.length <= 1) {
    const split = defending ? 40 : 46
    return { me: [0, split, 100, 100 - split], seats: opp.map((id) => ({ id, box: [0, 0, 100, split] as Box, size: 'big' as const })), topIds: opp }
  }
  const right = opp.length >= 3 ? opp[0] : null
  // Across the top, left to right: furthest in turn order first.
  const top = (right == null ? opp : opp.slice(1)).reverse()
  const active = state.activePlayer ?? -1
  const focus = top.includes(active) ? active : topFocus != null && top.includes(topFocus) ? topFocus : top[top.length - 1]
  const rightActs = right != null && active === right
  const topActs = top.includes(active)
  const topW = rightActs ? 63 : 100
  const topH = defending ? (topActs ? 38 : 30) : topActs ? 50 : 44
  const meY = topH + 1
  const seats: Array<{ id: number; box: Box; size: 'big' | 'small' }> = []
  const bigW = top.length > 1 ? topW * 0.6 : topW
  const smallW = top.length > 1 ? (topW - bigW) / (top.length - 1) : 0
  let x = 0
  for (const id of top) {
    const big = id === focus
    const w = big ? bigW : smallW
    seats.push({ id, box: [x, 0, w, big ? topH : Math.min(topH, 42)], size: big && !(defending && !topActs) ? 'big' : 'small' })
    x += w
  }
  if (right == null) return { me: [0, meY, 100, 100 - meY], seats, topIds: top }
  seats.push({ id: right, box: rightActs ? [63, 0, 37, 100] : [74, meY, 26, 100 - meY], size: rightActs ? 'big' : 'small' })
  return { me: [0, meY, rightActs ? 63 : 74, 100 - meY], seats, topIds: top }
}

function Seat({ player, state, card, onCard, onPlayer, onHover, onZone, size }: {
  player: GamePlayer; state: GameState; card: CardLookup; onCard: (c: GameCard) => void; onPlayer: (p: GamePlayer) => void
  onHover: (c: GameCard | null) => void; onZone: (z: 'graveyard' | 'exile') => void; size: 'big' | 'small'
}): React.JSX.Element {
  const zoom = useTableScale()
  const info = (
    <div className="flex flex-col items-end gap-1 pt-1" style={{ zoom }}>
      <span className="whitespace-nowrap rounded bg-black/50 px-1.5 text-[10px] text-white/60">✋ {player.zones.hand.length} · 📚 {player.library}</span>
      <ZoneButtons player={player} onZone={onZone} />
      <CommanderDamage player={player} card={card} />
    </div>
  )
  if (size === 'small') {
    // Shrunk: a header strip (portrait, commander, counts) over small cards.
    // The commander sits beside the portrait in every seat, big or small.
    return (
      <div className={`flex h-full min-h-0 flex-col gap-1 ${player.lost ? 'opacity-40' : ''}`}>
        <div className="flex shrink-0 items-start gap-2">
          <Portrait player={player} state={state} card={card} onPlayer={onPlayer} size={46} />
          <CommandZone player={player} card={card} onCard={onCard} onHover={onHover} size="xs" />
          {info}
        </div>
        <div className="min-h-0 flex-1">
          <Battlefield player={player} card={card} onCard={onCard} onHover={onHover} prefer="sm" mirrored />
        </div>
      </div>
    )
  }
  // Large: the portrait sits in the gap between their land piles and their
  // other piles, so the whole seat's height goes to the board.
  const center = (
    <div className="flex items-start gap-2">
      {info}
      <Portrait player={player} state={state} card={card} onPlayer={onPlayer} size={76} />
      <div className="flex items-start gap-1">
        <CommandZone player={player} card={card} onCard={onCard} onHover={onHover} />
        {player.libraryTop != null && <LibraryPile player={player} card={card} onCard={onCard} onHover={onHover} size="xs" />}
      </div>
    </div>
  )
  return (
    <div className={`h-full min-h-0 ${player.lost ? 'opacity-40' : ''}`}>
      <Battlefield player={player} card={card} onCard={onCard} onHover={onHover} prefer="lg" mirrored
        center={center} centerGap={Math.round(380 * zoom)} />
    </div>
  )
}

function ZoneButtons({ player, onZone }: { player: GamePlayer; onZone: (z: 'graveyard' | 'exile') => void }): React.JSX.Element {
  return (
    <div className="flex gap-1 text-[10px]">
      <button onClick={() => onZone('graveyard')} className="rounded bg-white/5 px-1.5 py-0.5 text-white/60 hover:bg-white/10">
        <Layers className="mr-0.5 inline h-3 w-3" />GY {player.zones.graveyard.length}
      </button>
      <button onClick={() => onZone('exile')} className="rounded bg-white/5 px-1.5 py-0.5 text-white/60 hover:bg-white/10">Exile {player.zones.exile.length}</button>
    </div>
  )
}

/** The turn's five sections, each holding its steps — the shape a player learns. */
const STEP_GROUPS: Array<{ name: string; steps: string[]; icon: typeof Sunrise }> = [
  { name: 'Beginning', steps: ['UNTAP', 'UPKEEP', 'DRAW'], icon: Sunrise },
  { name: 'Main 1', steps: ['MAIN1'], icon: Sparkles },
  { name: 'Combat', steps: ['COMBAT_BEGIN', 'COMBAT_DECLARE_ATTACKERS', 'COMBAT_DECLARE_BLOCKERS', 'COMBAT_FIRST_STRIKE_DAMAGE', 'COMBAT_DAMAGE', 'COMBAT_END'], icon: Swords },
  { name: 'Main 2', steps: ['MAIN2'], icon: Wand2 },
  { name: 'End', steps: ['END_OF_TURN', 'CLEANUP'], icon: Moon }
]

/**
 * Turn + phase as a slim rail down the right edge: one small icon per section
 * of the turn. The live one pulls out into a pill — the acting player's
 * commander, the section, and the exact step — so "whose turn, where in it"
 * is one glance without taking the middle of the table.
 */
function TurnRail({ state, stepIdx, card, nextStop, nextTurnName }: {
  state: GameState; stepIdx: number; card: CardLookup
  /** Where passing will stop next (marked with a dashed outline and ▸). */
  nextStop: string | null; nextTurnName: string | null
}): React.JSX.Element {
  const current = stepIdx >= 0 ? STEPS[stepIdx][0] : null
  const zoom = useTableScale()
  const actor = state.players.find((p) => p.id === state.activePlayer)
  const yours = actor?.id === state.you
  const art = actor?.commanders.map((id) => card(id)?.art).find(Boolean)
  const face = art ? scryfallImage(art, 'art_crop')?.src : null
  return (
    <div className="relative z-30 flex w-[58px] shrink-0 flex-col items-center gap-1 border-l border-white/10 bg-black/40 py-3 backdrop-blur-sm" style={{ zoom }}>
      <style>{'@keyframes atlis-pill{from{opacity:0;transform:translate(14px,-50%)}to{opacity:1;transform:translate(0,-50%)}}'}</style>
      <span className="text-[9px] uppercase tracking-widest text-white/35">Turn</span>
      <span className="text-lg font-bold leading-none tabular-nums text-white/85">{state.turn}</span>
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        {STEP_GROUPS.map((g) => {
          const live = current != null && g.steps.includes(current)
          const done = current != null && STEP_INDEX.get(g.steps[g.steps.length - 1])! < stepIdx
          const isNext = !live && nextStop != null && g.steps.includes(nextStop)
          const Icon = g.icon
          const step = live && current ? STEPS[STEP_INDEX.get(current)!] : null
          return (
            <div key={g.name} className="relative" title={`${g.name}${step ? ` — ${step[1]}: ${step[2]}` : ''}`}>
              <div className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                live ? (yours ? 'bg-emerald-500/35 text-white ring-2 ring-emerald-300/80' : 'bg-violet-500/40 text-white ring-2 ring-violet-300/80')
                  : isNext ? 'text-amber-100 outline outline-1 outline-dashed outline-amber-300/80'
                    : done ? 'text-white/25' : 'text-white/45 ring-1 ring-white/10'
              }`}>
                <Icon className="h-4 w-4" />
              </div>
              {isNext && <span className="absolute -left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-amber-200">▸</span>}
              {live && (
                // Pulled out of the rail onto the table.
                <div key={`${state.activePlayer}-${current}`}
                  className={`pointer-events-none absolute right-[calc(100%+8px)] top-1/2 flex items-center gap-2 whitespace-nowrap rounded-full py-1 pl-1 pr-3 shadow-xl ring-1 backdrop-blur ${
                    yours ? 'bg-[#10241c]/95 ring-emerald-400/50' : 'bg-[#1b1830]/95 ring-violet-400/50'
                  }`}
                  style={{ transform: 'translateY(-50%)', animation: 'atlis-pill 0.3s ease-out' }}>
                  <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-white/10 ring-1 ring-black/50">
                    {face && <img src={face} alt="" draggable={false} className="h-full w-full scale-125 object-cover" />}
                  </span>
                  <span className="flex flex-col leading-tight">
                    <span className="text-[12px] font-semibold text-white">{g.name}{step && g.steps.length > 1 ? ` · ${step[1]}` : ''}</span>
                    <span className="max-w-[180px] truncate text-[10px] text-white/55">{yours ? 'Your turn' : `${actor?.name ?? ''}’s turn`}</span>
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {nextStop === 'NEXT_TURN' && (
        <div title={nextTurnName ? `Next: ${nextTurnName}` : 'Next turn'}
          className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] text-amber-100 outline outline-1 outline-dashed outline-amber-300/80">▸</div>
      )}
    </div>
  )
}

/** Forge's prompt repeats turn/phase/stack, which the table already shows; keep what it's asking. */
/**
 * Turn Forge's prompt into "what to do" + "why". Forge leads choice prompts
 * with the source card's name and internal id ("Inniaz, the Gale Force (213)")
 * and buries the actual instruction on a later line; the instruction becomes
 * the headline and the card becomes the context.
 */
function promptLines(message: string, sourceName: string | null): { headline: string; detail: string; source: string | null } {
  const lines = message.replace(/ \(\d+\)/g, '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !/^(Turn|Phase|Stack):/i.test(l))
  let source: string | null = null
  if (lines.length > 1 && sourceName && lines[0] === sourceName) {
    source = lines.shift() ?? null
  }
  const first = lines[0] ?? ''
  const headline = /^Priority:\s*You$/i.test(first) ? 'You have priority — play something, or pass' : first
  return { headline, detail: lines.slice(1).join(' · '), source }
}

/**
 * Forge's "Use triggered ability of X (51)?" — a "may" trigger asking first.
 * Forge's wording never says what the trigger DOES (Chrome Mox: exile a card
 * from your hand), so pull the trigger's own text off the stack.
 */
function optionalTrigger(state: GameState): { name: string; text: string } | null {
  const m = (state.prompt.message || '').match(/^Use triggered ability of (.+?)(?: \((\d+)\))?\?/m)
  if (!m) return null
  const id = m[2] != null ? Number(m[2]) : null
  const item = state.stack.find((x) => x.trigger && x.source === id) ?? state.stack.find((x) => x.source === id) ?? state.stack[0]
  const text = (item?.text ?? '').replace(/\s*\[[^\]]*\]\s*$/, '').replace(/ \(\d+\)/g, '').trim()
  return { name: m[1], text }
}

/**
 * The one control that moves the game forward, centered just above your
 * hand. It glows when Forge is waiting on you, shakes when Forge rejects a
 * click, and answers to Space and mouse button 5.
 */
/**
 * Forge's block prompt ("Select creatures to block X or select another
 * attacker…") as plain steps: who you're blocking now, how to switch, and
 * what still gets through.
 */
export function blockGuide(s: GameState, ui: { armed?: number | null; target?: number | null } = {}): { headline: string; detail: string; ok: string } | null {
  if (s.phase !== 'COMBAT_DECLARE_BLOCKERS' || /^Priority:/m.test(s.prompt.message || '') || !/block/i.test(s.prompt.message || '')) return null
  const atMe = s.combat.filter((c) => c.defenderIsPlayer && c.defender === s.you)
  const cardOf = (id: number): GameCard | undefined => s.cards[String(id)]
  const label = (c?: GameCard): string => (c ? `${(c.name ?? 'Creature').split(',')[0]} ${c.power}/${c.toughness}` : '')
  const armed = ui.armed != null ? cardOf(ui.armed) : undefined
  const target = ui.target != null ? cardOf(ui.target) : undefined
  const through = atMe.filter((c) => !c.blockers.length).reduce((a, c) => a + (cardOf(c.attacker)?.power ?? 0), 0)
  const mine = s.players.find((p) => p.id === s.you)?.zones.battlefield ?? []
  const blocks = Math.max(atMe.reduce((a, c) => a + c.blockers.length, 0), mine.filter((id) => cardOf(id)?.blocking).length)
  const life = s.players.find((p) => p.id === s.you)?.life ?? 0
  return {
    headline: armed
      ? `${label(armed)} is ready — now click the attacker it should block`
      : target
        ? `Blocking ${label(target)}: click your blue-dashed creatures to add blockers, or another attacker`
        : 'Click one of your blue-dashed creatures, then the attacker it should block (click a blocker again to undo)',
    detail: `${atMe.length} attacking you · ${through} unblocked damage vs your ${life} life${through >= life ? ' — LETHAL' : ''}`,
    ok: blocks ? `Done blocking (${blocks})` : 'No blocks'
  }
}

/**
 * Goad and "attacks each combat if able" while you declare attackers: Forge
 * answers a declaration that leaves one out with a bare "Attack declaration
 * invalid", so say which creatures are forced and who they can't hit.
 */
export function attackGuide(s: GameState): { headline: string; detail: string } | null {
  if (s.phase !== 'COMBAT_DECLARE_ATTACKERS' || s.activePlayer !== s.you || /^Priority:/m.test(s.prompt.message || '') || !/attack/i.test(s.prompt.message || '')) return null
  const mine = (s.players.find((p) => p.id === s.you)?.zones.battlefield ?? []).map((id) => s.cards[String(id)]).filter((c): c is GameCard => !!c)
  const forced = mine.filter((c) => c.mustAttack)
  if (!forced.length) return null
  const short = (c: GameCard): string => (c.name ?? 'Creature').split(',')[0]
  const list = (cs: GameCard[]): string => cs.map(short).join(cs.length > 2 ? ', ' : ' and ')
  const goaders = [...new Set(forced.flatMap((c) => (c.goadedBy ? c.goadedBy.split(', ') : [])))]
  const nameOf = (id?: number): string | undefined => s.players.find((p) => p.id === id)?.name
  const intoGoader = forced.filter((c) => {
    const at = s.combat.find((x) => x.attacker === c.id)
    const who = at?.defenderIsPlayer ? nameOf(at.defender) : undefined
    return !!who && !!c.goadedBy?.split(', ').includes(who)
  })
  const missing = forced.filter((c) => !c.attacking)
  const headline = missing.length
    ? `${list(missing)} must attack this combat — Forge won’t accept attacks without ${missing.length > 1 ? 'them' : 'it'}`
    : intoGoader.length
      ? `${list(intoGoader)} can’t attack the player who goaded ${intoGoader.length > 1 ? 'them' : 'it'} — pick another player`
      : null
  if (!headline) return null
  return {
    headline,
    detail: goaders.length ? `Goaded by ${goaders.join(', ')}: attack any player except them` : 'An effect forces these creatures to attack if able'
  }
}

function ActionDock({ state, shake, tip, next, onOk, onCancel, armed, blockTarget }: {
  state: GameState; shake: boolean; tip: string; next: NextMove | null; onOk: () => void; onCancel: () => void
  armed?: number | null; blockTarget?: number | null
}): React.JSX.Element {
  const p = state.prompt
  const sourceName = p.card != null ? state.cards[String(p.card)]?.name ?? null : null
  const { headline, detail, source } = promptLines(p.message || '', sourceName)
  // An in-table choice: Forge wants a click on one of the yellow-glowing cards.
  const choosing = !/^Priority:/m.test(p.message || '') && Object.values(state.cards).some((c) => c.selectable)
  const waiting = p.okEnabled || p.cancelEnabled || choosing
  const pick = p.max > 1 ? (p.min === p.max ? `pick ${p.min}` : `pick ${p.min}–${p.max}`) : 'pick 1'
  const may = optionalTrigger(state)
  const blocking = blockGuide(state, { armed, target: blockTarget })
  const forced = blocking || may ? null : attackGuide(state)
  // 80% of table scale: present, not dominant.
  const zoom = useTableScale() * 0.8
  return (
    <div className="flex justify-center px-3 pb-1" style={{ zoom }}>
      <style>{'@keyframes atlis-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}@keyframes atlis-breathe{0%,100%{box-shadow:0 0 0 0 rgba(167,139,250,0.0)}50%{box-shadow:0 0 22px 2px rgba(167,139,250,0.35)}}'}</style>
      <div
        className={`flex w-[min(760px,100%)] items-center gap-3 rounded-2xl border px-3 py-2 backdrop-blur ${
          waiting ? 'border-violet-400/40 bg-[#1b1830]/90' : 'border-white/10 bg-black/50'
        }`}
        style={shake ? { animation: 'atlis-shake 0.35s' } : waiting ? { animation: 'atlis-breathe 2.4s ease-in-out infinite' } : undefined}
      >
        <div className="min-w-0 flex-1">
          {(may?.name ?? source) && <div className="truncate text-[10px] uppercase tracking-wider text-violet-200/60">{may?.name ?? source}</div>}
          <div className={`${blocking ? 'line-clamp-2 text-sky-100' : forced ? 'line-clamp-2 text-orange-100' : 'truncate'} text-[13px] font-medium leading-snug`} title={blocking?.headline ?? forced?.headline ?? headline}>
            {may ? 'Optional trigger — do you want to use it?' : blocking ? blocking.headline : forced ? forced.headline : next ? (next.resolves ? 'Something is waiting to resolve' : 'Your priority — play something, or move on') : headline || 'Waiting for opponents…'}
          </div>
          {blocking ? (
            <div className={`truncate text-[11px] font-medium ${/LETHAL/.test(blocking.detail) ? 'text-red-300' : 'text-sky-200'}`} title={blocking.detail}>{blocking.detail}</div>
          ) : forced ? (
            <div className="truncate text-[11px] font-medium text-orange-200" title={forced.detail}>{forced.detail}</div>
          ) : may ? (
            // What "Yes" actually does, in the card's own words.
            <div className="line-clamp-2 text-[11px] font-medium leading-snug text-amber-100/90" title={may.text}>
              {may.text || 'This trigger says “may”, so it’s your call.'}
            </div>
          ) : next ? (
            // Exactly what the big button does, before you press it.
            <div className={`flex items-center gap-1 truncate text-[11px] font-medium ${next.resolves ? 'text-violet-200' : 'text-amber-100/90'}`} title={next.says}>
              <span>▸</span> <span className="truncate">{next.says}</span>
            </div>
          ) : choosing ? (
            <div className="flex items-center gap-1 text-[11px] font-medium text-amber-200">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,0.9)]" />
              Click a highlighted card on the table to choose ({pick}){detail ? ` · ${detail}` : ''}
            </div>
          ) : (detail || tip) && (
            <div className="flex items-center gap-1 truncate text-[11px] text-white/40">
              <BookOpen className="h-3 w-3 shrink-0" /> <span className="truncate">{detail || tip}</span>
            </div>
          )}
        </div>
        <button onClick={onCancel} disabled={!p.cancelEnabled}
          className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/75 hover:bg-white/10 disabled:opacity-25">
          {/* Forge's "End Turn" at priority means: keep passing until this turn ends. */}
          {may ? 'No, skip it' : p.cancelLabel === 'End Turn' ? 'Pass to end of turn' : p.cancelLabel || 'Cancel'}
        </button>
        <button onClick={onOk} disabled={!p.okEnabled}
          className="min-w-[150px] rounded-xl bg-gradient-to-b from-emerald-400 to-emerald-600 px-4 py-2 text-sm font-semibold text-black shadow-lg shadow-emerald-900/40 hover:from-emerald-300 hover:to-emerald-500 disabled:from-white/10 disabled:to-white/5 disabled:text-white/30 disabled:shadow-none">
          {may ? 'Yes, use it' : blocking?.ok ?? next?.button ?? (p.okLabel || 'OK')}
          <span className="ml-2 text-[10px] font-normal opacity-60">Space · M5</span>
        </button>
      </div>
    </div>
  )
}

/** Mana gems: W U B R G C, glowing when there's mana of that color in the pool. */
const GEM: Record<keyof GamePlayer['mana'], { bg: string; glow: string }> = {
  W: { bg: 'from-amber-50 to-amber-200 text-amber-950', glow: 'shadow-[0_0_10px_rgba(253,230,138,0.8)]' },
  U: { bg: 'from-sky-300 to-sky-600 text-white', glow: 'shadow-[0_0_10px_rgba(56,189,248,0.8)]' },
  B: { bg: 'from-zinc-500 to-zinc-800 text-white', glow: 'shadow-[0_0_10px_rgba(161,161,170,0.7)]' },
  R: { bg: 'from-red-400 to-red-700 text-white', glow: 'shadow-[0_0_10px_rgba(248,113,113,0.8)]' },
  G: { bg: 'from-emerald-400 to-emerald-700 text-white', glow: 'shadow-[0_0_10px_rgba(52,211,153,0.8)]' },
  C: { bg: 'from-zinc-200 to-zinc-400 text-zinc-900', glow: 'shadow-[0_0_10px_rgba(228,228,231,0.7)]' }
}

/** Your seat's vitals, laid out in the space between your commander and your hand. */
/**
 * Your library as a pile. When Forge lets you see the top card (Vesuvan
 * Drifter, Conspicuous Snoop…) it sits face-up on the pile — glowing and
 * clickable when you can cast it from there.
 */
function LibraryPile({ player, card, onCard, onHover, size = 'sm' }: {
  player: GamePlayer; card: CardLookup; onCard: (c: GameCard) => void; onHover: (c: GameCard | null) => void; size?: CardSize
}): React.JSX.Element {
  const top = player.libraryTop != null ? card(player.libraryTop) : undefined
  return (
    <div className="relative flex flex-col items-center" title={top ? `Top of library: ${top.name}` : `${player.library} cards in library`}>
      {/* A couple of offset backs read as "a pile" */}
      <div className="relative">
        <div className="absolute left-1 top-1 h-full w-full rounded-[6px] bg-[#2a2140] ring-1 ring-black/40" />
        <div className="absolute left-0.5 top-0.5 h-full w-full rounded-[6px] bg-[#2f2547] ring-1 ring-black/40" />
        <GameCardView card={top ? { ...top, tapped: false } : { id: -player.id - 1, owner: player.id, hidden: true }} size={size}
          onClick={top ? onCard : undefined} onHover={top ? onHover : undefined} />
      </div>
      <span className="mt-1 text-[9px] uppercase tracking-wider text-white/45">{top ? 'Top · ' : ''}Library {player.library}</span>
    </div>
  )
}

function PlayerHud({ player, card, onMana, onZone }: {
  player: GamePlayer; card: CardLookup
  onMana: (byte: number) => void; onZone: (z: 'graveyard' | 'exile') => void
}): React.JSX.Element {
  const landMax = player.maxLands < 0 ? Math.max(1, player.landsPlayed) : player.maxLands
  const zoom = useTableScale()
  return (
    <div style={{ zoom }} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/45 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur">
      <div className="space-y-1.5">
        {/* Mana pool */}
        <div className="flex items-center gap-1" title="Mana pool — click a gem to spend it on the cost being paid">
          {MANA.map((m) => {
            const n = player.mana[m.k]
            return (
              <button key={m.k} disabled={!n} onClick={() => onMana(m.byte)}
                className={`flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-b text-[10px] font-bold transition-all ${
                  n ? `${GEM[m.k].bg} ${GEM[m.k].glow} scale-110` : 'from-white/10 to-white/5 text-white/25'
                }`}>
                {n || m.k}
              </button>
            )
          })}
        </div>
        {/* Land drop */}
        <div className="flex items-center gap-1.5 text-[10px] text-white/50" title="Land drops this turn">
          <span className="uppercase tracking-wider">Land</span>
          {Array.from({ length: landMax }, (_, i) => (
            <span key={i} className={`h-2 w-2 rotate-45 ${i < player.landsPlayed ? 'bg-emerald-400' : 'border border-white/30'}`} />
          ))}
          {player.maxLands < 0 && <span className="text-white/40">∞</span>}
        </div>
        {/* Zones */}
        <div className="flex gap-1 text-[10px]">
          <button onClick={() => onZone('graveyard')} className="rounded-md bg-white/5 px-1.5 py-0.5 text-white/60 hover:bg-white/10">🪦 {player.zones.graveyard.length}</button>
          <button onClick={() => onZone('exile')} className="rounded-md bg-white/5 px-1.5 py-0.5 text-white/60 hover:bg-white/10">⛔ {player.zones.exile.length}</button>
        </div>
        <CommanderDamage player={player} card={card} />
      </div>
    </div>
  )
}

/**
 * The hovered card, big, floating in the bottom-right corner — for reading
 * rules text and for enjoying the art. Scryfall's large scan keeps it sharp.
 * Pointer-transparent, and it hops to the top-right whenever the pointer is
 * itself in the bottom-right, so it never sits on top of what you're pointing at.
 */
function HoverCard({ card }: { card: GameCard | null }): React.JSX.Element | null {
  const [corner, setCorner] = useState<'bottom' | 'top'>('bottom')
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const inBottomRight = e.clientX > window.innerWidth * 0.62 && e.clientY > window.innerHeight * 0.4
      setCorner((c) => (inBottomRight ? (c === 'top' ? c : 'top') : (c === 'bottom' ? c : 'bottom')))
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])
  if (!card || card.hidden) return null
  const img = card.art ? scryfallImage(card.art, 'large') : null
  const counters = Object.entries(card.counters ?? {}).filter(([, n]) => n > 0)
  const live = card.zone === 'Battlefield' && (card.creature || counters.length || card.damage)
  return (
    <div className={`pointer-events-none absolute right-3 z-50 flex flex-col items-end gap-2 ${corner === 'bottom' ? 'bottom-3' : 'top-12'}`}>
      {img ? (
        <img src={img.src} alt={card.name} draggable={false}
          onError={(e) => { if (img.fallback && e.currentTarget.src !== img.fallback) e.currentTarget.src = img.fallback }}
          className="h-[min(80vh,1040px)] w-auto rounded-[18px] shadow-[0_20px_60px_rgba(0,0,0,0.75)] ring-1 ring-white/15" />
      ) : (
        // No printing (tokens, unmapped sets): the same size, as readable text.
        <div className="flex h-[min(80vh,1040px)] w-[min(57vh,743px)] flex-col rounded-[18px] bg-gradient-to-b from-[#2a2a35] to-[#15151b] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.75)] ring-1 ring-white/15">
          <div className="flex justify-between gap-2 text-xl font-semibold">
            <span>{card.name}</span>
            <span className="text-white/50">{(card.manaCost ?? '').replace(/[{}]/g, '')}</span>
          </div>
          <div className="mt-1 text-sm text-white/50">{card.type}</div>
          <div className="mt-4 whitespace-pre-line text-[15px] leading-relaxed text-white/80">{card.text}</div>
          {card.power != null && <div className="mt-auto self-end text-2xl font-bold">{card.power}/{card.toughness}</div>}
        </div>
      )}
      {live ? (
        // What the printed card can't show: its state right now.
        <div className="rounded-xl bg-black/85 px-3 py-1.5 text-[13px] font-medium text-white shadow-lg ring-1 ring-white/10">
          {card.creature && <span>Now {card.power}/{card.toughness}</span>}
          {card.damage ? <span className="ml-2 text-red-300">{card.damage} damage marked</span> : null}
          {counters.map(([k, n]) => <span key={k} className="ml-2 text-amber-200">{n} × {k}</span>)}
          {card.tapped && <span className="ml-2 text-white/50">tapped</span>}
          {card.sick && card.creature && <span className="ml-2 text-white/50">summoning sick</span>}
        </div>
      ) : null}
    </div>
  )
}

function Stack({ state, card, onHover }: { state: GameState; card: CardLookup; onHover: (c: GameCard | null) => void }): React.JSX.Element {
  return (
    // Sized to its contents (up to ~40%), so the game log below keeps room.
    <div className="max-h-[40%] shrink-0 overflow-y-auto">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-white/40">
        The stack {state.stack.length ? `(${state.stack.length}) — top resolves first` : '— empty'}
      </div>
      <div className="space-y-1">
        {state.stack.map((si, i) => {
          const src = si.source != null ? card(si.source) : undefined
          const who = state.players.find((p) => p.id === si.controller)?.name
          return (
            <div key={si.id} data-stack={si.id} onMouseEnter={() => onHover(src ?? null)} onMouseLeave={() => onHover(null)}
              className={`rounded-md border px-2 py-1 text-[11px] leading-snug ${i === 0 ? 'border-violet-400/50 bg-violet-500/10' : 'border-white/10 bg-white/[0.03]'}`}>
              <div className="font-medium text-white/85">{src?.name ?? 'Ability'}{si.trigger ? ' (trigger)' : si.ability ? ' (ability)' : ''}</div>
              <div className="text-white/55">{si.text}</div>
              {who && <div className="text-[10px] text-white/35">{who}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const LOG_TONE: Record<string, string> = {
  STACK_ADD: 'text-sky-200/80', STACK_RESOLVE: 'text-emerald-200/80', ZONE_CHANGE: 'text-white/70',
  DAMAGE: 'text-red-200/80', LIFE: 'text-amber-200/80', COMBAT: 'text-orange-200/80', LAND: 'text-white/55',
  TURN: 'text-violet-200 font-semibold', MULLIGAN: 'text-white/55', GAME_OUTCOME: 'text-amber-200 font-semibold'
}

/**
 * Forge's own record of the game, newest first — "what just happened?" always
 * has an answer: what resolved, what each effect did, where cards went.
 * Mana taps are hidden unless asked for; they drown everything else.
 */
function GameLog({ state, card, onHover }: { state: GameState; card: CardLookup; onHover: (c: GameCard | null) => void }): React.JSX.Element {
  const [mana, setMana] = useState(false)
  const entries = (state.log ?? []).filter((e) => mana || e.type !== 'MANA').slice().reverse()
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-white/10 pt-2">
      <div className="mb-1 flex items-center text-[10px] font-medium uppercase tracking-wide text-white/40">
        Game log
        <button onClick={() => setMana((v) => !v)} className={`ml-auto rounded px-1.5 normal-case tracking-normal ${mana ? 'bg-white/10 text-white/70' : 'text-white/35 hover:text-white/60'}`}>
          {mana ? 'hide mana' : 'show mana'}
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
        {entries.map((e, i) => (
          <div key={`${entries.length - i}`} className={`text-[11px] leading-snug ${LOG_TONE[e.type] ?? 'text-white/60'}`}
            onMouseEnter={() => onHover(e.card != null ? card(e.card) ?? null : null)} onMouseLeave={() => onHover(null)}>
            {e.text}
          </div>
        ))}
        {!entries.length && <div className="text-[11px] text-white/30">Nothing yet.</div>}
      </div>
    </div>
  )
}

function ZoneViewer({ state, zone, card, onCard, onHover, onClose }: {
  state: GameState; zone: { player: number; zone: 'graveyard' | 'exile' }; card: CardLookup
  onCard: (c: GameCard) => void; onHover: (c: GameCard | null) => void; onClose: () => void
}): React.JSX.Element {
  const p = state.players.find((x) => x.id === zone.player)
  const ids = p?.zones[zone.zone] ?? []
  const list = useMemo(() => ids.map(card).filter((c): c is GameCard => !!c), [ids, card])
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-8" onClick={onClose}>
      <div className="max-h-full w-full max-w-4xl overflow-y-auto rounded-xl border border-white/15 bg-[#17171f] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center">
          <h3 className="text-sm font-medium">{p?.name} — {zone.zone} ({list.length})</h3>
          <button onClick={onClose} className="ml-auto rounded p-1 text-white/50 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex flex-wrap gap-2">
          {list.map((c) => <GameCardView key={c.id} card={c} size="md" onClick={onCard} onHover={onHover} />)}
          {!list.length && <p className="text-sm text-white/40">Empty.</p>}
        </div>
        <p className="mt-3 text-[11px] text-white/35">Glowing cards can be used from here (flashback, escape, …) — click them.</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- "what will Next do?"

export interface NextMove {
  /** Big button text. */
  button: string
  /** One line under the headline: what passing actually does. */
  says: string
  /** The step you'll stop at next ('NEXT_TURN' for the following player's turn). */
  stop: string | null
  /** True when passing resolves the top of the stack. */
  resolves: boolean
}

/**
 * Forge's OK at priority always means "pass priority" — which resolves the top
 * of the stack when there is one, and otherwise moves the game to the next
 * step where someone stops. This spells out which, using your stops (main 1,
 * attackers, main 2 on your turn; end of turn on theirs) and the board.
 */
/** Someone is attacking you and the game hasn't reached the declare-blockers step yet. */
export function attackedBeforeBlocks(s: GameState): boolean {
  return s.phase === 'COMBAT_DECLARE_ATTACKERS' && s.activePlayer !== s.you && s.combat.some((c) => c.defenderIsPlayer && c.defender === s.you)
}

/** Whether any of your creatures can legally block one of the attackers (the bridge checks flying, menace…). Forge skips your block step when none can. */
export function youCanBlock(s: GameState): boolean {
  const mine = (s.players.find((p) => p.id === s.you)?.zones.battlefield ?? []).map((id) => s.cards[String(id)]).filter((c) => c?.creature)
  // No answer either way (an older bridge only says during the block step): assume blocks are coming.
  if (!mine.some((c) => c.canBlock != null)) return true
  return mine.some((c) => c.canBlock)
}

export function explainNext(s: GameState): NextMove | null {
  if (!/^Priority: You/m.test(s.prompt.message || '') || !s.prompt.okEnabled) return null
  const you = s.you
  const name = (id?: number): string => (id != null ? s.cards[String(id)]?.name : undefined) ?? 'the ability'
  const alive = s.players.filter((p) => !p.lost)
  const idx = alive.findIndex((p) => p.id === s.activePlayer)
  const nextPlayer = alive[(idx + 1) % Math.max(1, alive.length)]
  const nextTurn = nextPlayer?.id === you ? 'your turn' : `${nextPlayer?.name ?? 'the next player'}’s turn`

  if (s.stack.length) {
    const top = s.stack[0]
    const what = name(top.source)
    const mine = top.controller === you
    const short = what.split(',')[0]
    return {
      button: `Resolve: ${short.length > 18 ? `${short.slice(0, 17)}…` : short}`,
      says: mine
        ? `${what} resolves — unless an opponent responds first.${s.stack.length > 1 ? ` ${s.stack.length - 1} more wait${s.stack.length > 2 ? '' : 's'} below it.` : ''}`
        : attackedBeforeBlocks(s)
          ? youCanBlock(s)
            ? `Let ${what} resolve — then you choose blockers.`
            : `Let ${what} resolve. None of your creatures can block these attackers, so damage comes next.`
          : `Let ${what} resolve — or respond first with an instant or ability.`,
      stop: s.phase,
      resolves: true
    }
  }

  const yourTurn = s.activePlayer === you
  const me = s.players.find((p) => p.id === you)
  const mine = (me?.zones.battlefield ?? []).map((id) => s.cards[String(id)]).filter(Boolean)
  const canAttack = mine.some((c) => c.creature && !c.tapped && !c.sick)
  const attacking = Object.values(s.cards).some((c) => c.attacking)

  if (yourTurn) {
    switch (s.phase) {
      case 'UNTAP': case 'UPKEEP': case 'DRAW':
        return { button: 'Next: Main 1', says: 'Moves to your first main phase.', stop: 'MAIN1', resolves: false }
      case 'MAIN1':
        return canAttack
          ? { button: 'Next: Combat', says: 'Ends Main 1 and starts combat — you’ll choose attackers.', stop: 'COMBAT_DECLARE_ATTACKERS', resolves: false }
          : { button: 'Next: Main 2', says: 'Nothing can attack, so combat is skipped — on to Main 2.', stop: 'MAIN2', resolves: false }
      case 'COMBAT_BEGIN':
        return { button: 'Next: Attackers', says: 'Declare your attackers next.', stop: 'COMBAT_DECLARE_ATTACKERS', resolves: false }
      case 'COMBAT_DECLARE_ATTACKERS':
        return attacking
          ? { button: 'Next: Blocks', says: 'Defenders choose blocks, then combat damage is dealt.', stop: 'COMBAT_DAMAGE', resolves: false }
          : { button: 'Next: Main 2', says: 'No attackers — combat ends, on to Main 2.', stop: 'MAIN2', resolves: false }
      case 'COMBAT_DECLARE_BLOCKERS': case 'COMBAT_FIRST_STRIKE_DAMAGE':
        return { button: 'Next: Damage', says: 'Combat damage is dealt.', stop: 'COMBAT_DAMAGE', resolves: false }
      case 'COMBAT_DAMAGE': case 'COMBAT_END':
        return { button: 'Next: Main 2', says: 'Combat is over — on to your second main phase.', stop: 'MAIN2', resolves: false }
      case 'MAIN2': case 'END_OF_TURN': case 'CLEANUP':
        return { button: 'Pass the turn', says: `Ends your turn — ${nextTurn} begins.`, stop: 'NEXT_TURN', resolves: false }
      default:
        return null
    }
  }
  const active = s.players.find((p) => p.id === s.activePlayer)?.name ?? 'Their'
  if (attackedBeforeBlocks(s)) {
    const n = s.combat.filter((c) => c.defenderIsPlayer && c.defender === you).length
    const who = `${n} creature${n > 1 ? 's are' : ' is'} attacking you`
    return youCanBlock(s)
      ? { button: 'Next: Blocks', says: `${who} — next you choose blockers.`, stop: 'COMBAT_DECLARE_BLOCKERS', resolves: false }
      : { button: 'Next: Damage', says: `${who}, and none of yours can block them (flying, menace…) — damage comes next.`, stop: 'COMBAT_DAMAGE', resolves: false }
  }
  if (s.phase === 'END_OF_TURN' || s.phase === 'CLEANUP') {
    return { button: nextPlayer?.id === you ? 'Next: Your turn' : `Next: ${nextPlayer?.name?.split(' ')[0] ?? 'next'}’s turn`, says: `${active}’s turn ends — ${nextTurn} begins.`, stop: 'NEXT_TURN', resolves: false }
  }
  return {
    button: 'Let it continue',
    says: `It’s ${active}’s turn. Passing lets it go on; you’ll be asked again if they cast something, attack, or reach their end step.`,
    stop: null,
    resolves: false
  }
}

/**
 * What resolves next, shown big at the side of the board — the card itself,
 * glowing — with beams (Arrows) from it to whatever it targets. Answers "is
 * clicking Next going to resolve something?" before you click.
 */
function StackSpotlight({ state, card, onHover, at }: {
  state: GameState; card: CardLookup; onHover: (c: GameCard | null) => void
  /** Your area's right edge and the spotlight's vertical center (% of the play area); whether the turn rail's pill reaches over that edge. */
  at: { right: number; top: number; byRail: boolean }
}): React.JSX.Element | null {
  const top = state.stack[0]
  const zoom = useTableScale()
  if (!top) return null
  const src = top.source != null ? card(top.source) : undefined
  const who = state.players.find((p) => p.id === top.controller)
  const img = src?.art ? scryfallImage(src.art, 'normal') : null
  const mine = who?.id === state.you
  return (
    // Over the open mat on the right of your area, card over its caption: clear of your
    // creatures and hand, and of the turn rail's pill (≈240 units) reaching in from the right.
    <div className="pointer-events-none absolute z-30 -translate-y-1/2"
      style={{ left: `calc(${at.right}% - ${Math.round(((at.byRail ? 290 : 24) + 170) * zoom)}px)`, top: `${at.top}%` }}>
      <div style={{ zoom }}>
      <div key={top.id} onMouseEnter={() => onHover(src ?? null)} onMouseLeave={() => onHover(null)}
        className="pointer-events-auto flex flex-col items-center gap-2"
        style={{ animation: 'atlis-spotlight 0.45s cubic-bezier(.2,.9,.3,1.2)' }}>
        <div data-stack={top.id} className={`relative w-[150px] shrink-0 overflow-hidden rounded-[10px] ring-2 ${mine ? 'ring-violet-300/70 shadow-[0_0_40px_8px_rgba(167,139,250,0.45)]' : 'ring-red-300/70 shadow-[0_0_40px_8px_rgba(248,113,113,0.4)]'}`}>
          {img
            ? <img src={img.src} alt={src?.name} draggable={false} className="block aspect-[5/7] w-full object-cover" />
            : <div className="flex aspect-[5/7] w-full flex-col bg-gradient-to-b from-[#2a2a35] to-[#15151b] p-3 text-[12px] text-white/80"><b>{src?.name ?? 'Ability'}</b><span className="mt-2 text-white/60">{top.text.replace(/ \(\d+\)/g, '')}</span></div>}
          {(top.trigger || top.ability) && (
            <span className="absolute inset-x-0 bottom-0 bg-black/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-violet-200">
              {top.trigger ? 'Triggered ability' : 'Activated ability'}
            </span>
          )}
        </div>
        <div className="w-[170px] rounded-xl bg-black/75 px-2.5 py-1.5 text-center shadow-lg ring-1 ring-white/10 backdrop-blur">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-violet-300/90">Resolving next</div>
          <div className="line-clamp-3 text-[11px] leading-snug text-white/70">{top.text.replace(/ \(\d+\)/g, '').replace(/\s*\[[^\]]*\]\s*$/, '')}</div>
          <div className="mt-0.5 text-[10px] text-white/40">
            {mine ? 'Yours' : who?.name}{state.stack.length > 1 ? ` · ${state.stack.length - 1} more below` : ''}
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
