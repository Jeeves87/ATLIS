/**
 * Play and learn.
 *
 * Games themselves run in Forge, the open-source engine that enforces the
 * full rules (stack, priority, every card scripted, loops, Commander with AI
 * opponents). This tab gets Forge set up, hands it the saved decks, and
 * launches it — and teaches the parts an engine doesn't explain: how a turn
 * is built, how the stack works, what Commander changes, how to mulligan, and
 * what each of your decks is trying to do.
 *
 * Everything taught here is rules-text accurate and engine-free on purpose:
 * the opening-hand trainer only shuffles and draws, which has no rules to get
 * wrong, so practising here can't teach a bad habit.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BookOpen, Check, ChevronDown, ChevronRight, Download, FolderOpen, Gamepad2, Hand, Loader2, Play,
  RefreshCw, Shuffle, Sparkles, Swords, Upload, Volume2
} from 'lucide-react'
import ProductThumb, { ImageZoom } from './ProductThumb'
import PlayInAtlis from './game/GameTable'
import SoundSettings from './game/SoundSettings'
import { scryfallImage } from '../../lib/mtgImages'
import type { ForgeStatus, MtgDeckCardView, MtgDeckDetail, MtgDeckRecs, MtgDeckSummary } from '../../types'

const JAVA_URL = 'https://adoptium.net/temurin/releases/?version=21'
const FORGE_URL = 'https://github.com/Card-Forge/forge/releases/latest'

export default function PlayTab({ onStatus }: { onStatus: (s: string | null) => void }): React.JSX.Element {
  const [view, setView] = useState<'atlis' | 'sounds' | 'forge' | 'learn' | 'practice'>('atlis')
  return (
    <section>
      <div className="mb-4 flex items-center gap-1">
        {([['atlis', 'Play in ATLIS', Swords], ['sounds', 'Table & sounds', Volume2], ['forge', 'Forge setup', Gamepad2], ['learn', 'Learn the rules', BookOpen], ['practice', 'Practice my decks', Hand]] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
              view === id ? 'bg-violet-500/20 text-violet-200' : 'text-white/45 hover:bg-white/5 hover:text-white/80'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
      {view === 'atlis' && <PlayInAtlis onStatus={onStatus} />}
      {view === 'sounds' && <SoundSettings />}
      {view === 'forge' && <ForgePanel onStatus={onStatus} />}
      {view === 'learn' && <LearnPanel />}
      {view === 'practice' && <PracticePanel onStatus={onStatus} />}
    </section>
  )
}

// ---------------------------------------------------------------- Forge setup + launch

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`rounded-md border p-3 ${done ? 'border-emerald-400/20 bg-emerald-500/[0.04]' : 'border-white/10 bg-white/[0.03]'}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
          done ? 'bg-emerald-500/30 text-emerald-100' : 'bg-white/10 text-white/60'
        }`}>
          {done ? <Check className="h-3 w-3" /> : n}
        </span>
        <span className="text-sm font-medium">{title}</span>
      </div>
      <div className="pl-7 text-[12px] leading-relaxed text-white/60">{children}</div>
    </div>
  )
}

const btn = 'inline-flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-xs text-white/70 hover:bg-white/10 disabled:opacity-50'
const primary = 'inline-flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/20 px-2.5 py-1 text-xs text-violet-100 hover:bg-violet-500/30 disabled:opacity-50'

function ForgePanel({ onStatus }: { onStatus: (s: string | null) => void }): React.JSX.Element {
  const [st, setSt] = useState<ForgeStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => { setSt(await window.atlis.mtg.forgeStatus()) }, [])
  useEffect(() => { void load() }, [load])

  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key)
    try { await fn() } catch (e) { onStatus(e instanceof Error ? e.message : String(e)) } finally { setBusy(null); void load() }
  }

  if (!st) return <div className="flex items-center gap-2 text-sm text-white/50"><Loader2 className="h-4 w-4 animate-spin" /> Checking for Java and Forge…</div>

  const javaOk = st.javaMajor != null && st.javaMajor >= 17
  const forgeOk = !!st.installDir
  const exported = st.exported.length > 0

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-2">
        <p className="mb-3 text-[12px] leading-relaxed text-white/50">
          Games run in <span className="text-white/80">Forge</span>, a free, open-source Magic engine. It enforces the
          complete rules, including the stack, priority, triggered abilities, loops and infinite combos, and plays
          Commander against AI opponents with real card art. It won’t let you make an illegal play. ATLIS sets it up
          with your decks.
        </p>

        <Step n={1} done={javaOk} title="Java 17 or newer">
          {javaOk ? <>Found Java {st.javaVersion}.</> : (
            <>
              {st.javaVersion ? <>Found Java {st.javaVersion}, which is too old. </> : <>Java isn’t installed (or isn’t on your PATH). </>}
              Forge needs Java 17+. Install <b>Eclipse Temurin 21 (JRE or JDK, Windows x64 .msi)</b>, and leave “Add to PATH”
              ticked in the installer.
              <div className="mt-2 flex gap-2">
                <button className={primary} onClick={() => void window.atlis.mtg.forgeOpenUrl(JAVA_URL)}>
                  <Download className="h-3.5 w-3.5" /> Get Java
                </button>
                <button className={btn} onClick={() => void run('check', load)}>
                  {busy === 'check' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Check again
                </button>
              </div>
            </>
          )}
        </Step>

        <Step n={2} done={forgeOk} title="Install Forge">
          {forgeOk ? (
            <>
              Found at <code className="text-white/80">{st.installDir}</code>{st.detected ? ' (detected)' : ''}.
              <button className={`${btn} ml-2`} onClick={() => void run('dir', async () => {
                const r = await window.atlis.mtg.forgeChooseDir()
                if (r.message) onStatus(r.message)
              })}><FolderOpen className="h-3.5 w-3.5" /> Change</button>
            </>
          ) : (
            <>
              Download <b>forge-installer-&lt;version&gt;.jar</b> from Forge’s releases page and double-click it. (That needs
              step 1 done first.) Install to a simple folder such as <code>C:\Forge</code>. ATLIS looks there and in your
              Downloads and home folders automatically.
              <div className="mt-2 flex gap-2">
                <button className={primary} onClick={() => void window.atlis.mtg.forgeOpenUrl(FORGE_URL)}>
                  <Download className="h-3.5 w-3.5" /> Forge releases
                </button>
                <button className={btn} onClick={() => void run('check', load)}>
                  {busy === 'check' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Look again
                </button>
                <button className={btn} onClick={() => void run('dir', async () => {
                  const r = await window.atlis.mtg.forgeChooseDir()
                  if (r.message) onStatus(r.message)
                })}><FolderOpen className="h-3.5 w-3.5" /> Choose folder…</button>
              </div>
            </>
          )}
        </Step>

        <Step n={3} done={exported} title="Send your decks to Forge">
          Every saved deck with a commander is written to Forge’s Commander deck folder as <b>“ATLIS - deck name”</b>,
          using the same printings you have, so the art matches. Re-send after editing a deck; ATLIS only replaces its
          own files.
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button className={primary} disabled={busy != null} onClick={() => void run('export', async () => {
              const r = await window.atlis.mtg.forgeExport()
              onStatus(
                `Sent ${r.written.length} deck(s) to Forge.` +
                (r.skipped.length ? ` Skipped: ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}.` : '') +
                (r.unmatchedSets ? ` ${r.unmatchedSets} card(s) went without a set code, so Forge picks their art.` : '')
              )
            })}>
              {busy === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {exported ? 'Re-send decks' : 'Send decks'}
            </button>
            <span className="text-[11px] text-white/35">{st.decksDir}</span>
          </div>
          {exported && (
            <div className="mt-2 flex flex-wrap gap-1">
              {st.exported.map((d) => <span key={d} className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-white/60">{d}</span>)}
            </div>
          )}
          {!forgeOk && <p className="mt-1 text-[11px] text-amber-200/70">Install Forge first so ATLIS can match set codes to its card list. Without it, decks still export by card name.</p>}
        </Step>

        <Step n={4} done={false} title="Play">
          <button className={primary} disabled={!st.launchable || busy != null} onClick={() => void run('launch', async () => {
            const r = await window.atlis.mtg.forgeLaunch()
            onStatus(r.message)
          })}>
            <Play className="h-3.5 w-3.5" /> Launch Forge
          </button>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>The first launch downloads card data, and art downloads as cards appear. Give it a minute.</li>
            <li>Open <b>Constructed</b> from the left-hand menu, then under <b>Variants</b> turn on <b>Commander</b>.</li>
            <li>Player 1 (<b>Human</b>): click the deck box (<b>Select a Commander deck</b>) and pick
              <b> Custom User Decks → ATLIS - your deck</b>.</li>
            <li>Player 2 (<b>AI</b>): pick another of your decks under <b>Custom User Decks</b> to test a matchup, or a
              deck from <b>Precon Commander Decks</b>. Use <b>Add a Player</b> for a 4-player pod.</li>
            <li>Click <b>Start</b>, then choose <b>Keep</b> or <b>Mulligan</b>. Forge tells you what it’s waiting for
              (attackers, blockers, targets, responses) and only offers legal choices.</li>
          </ol>
          <p className="mt-2 text-[11px] text-white/35">Labels taken from Forge 2.0.15’s English interface.</p>
        </Step>
      </div>

      <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
        <div className="rounded-md border border-white/10 bg-white/[0.03] p-3 text-[12px] leading-relaxed text-white/55">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-white/40">
            <Sparkles className="h-3 w-3" /> First games
          </div>
          <ul className="list-disc space-y-1 pl-4">
            <li>Start 1-on-1 against a single AI, then move up to a 4-player pod.</li>
            <li>Read <b>Learn the rules</b> first. Turn structure and the stack cover most “wait, why?” moments.</li>
            <li>Use <b>Practice my decks</b> to get a feel for keepable hands before you play.</li>
          </ul>
        </div>
        <div className="rounded-md border border-white/10 bg-white/[0.03] p-3 text-[11px] leading-relaxed text-white/40">
          Forge is a separate, free GPL-3 project (github.com/Card-Forge/forge) and needs about 1 GB of disk for the app
          plus card art. ATLIS never changes Forge’s files, only its own exported decks.
        </div>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------- Learn

interface Lesson { title: string; body: React.ReactNode }

const LESSONS: Lesson[] = [
  {
    title: 'The shape of a turn',
    body: (
      <ol className="list-decimal space-y-1.5 pl-4">
        <li><b>Beginning phase.</b> <i>Untap</i> your permanents. In <i>upkeep</i>, “at the beginning of your upkeep”
          triggers happen. In <i>draw</i>, draw a card. In a two-player game the player who goes first skips that first
          draw; in multiplayer Commander nobody does.</li>
        <li><b>First main phase.</b> Play <b>one land per turn</b> (unless a card says otherwise). Cast creatures,
          sorceries, artifacts, enchantments and planeswalkers, but only while the stack is empty. That’s “sorcery speed”.</li>
        <li><b>Combat.</b> <i>Beginning of combat</i> comes first. In <i>declare attackers</i>, tap untapped creatures
          to attack a player or planeswalker; creatures that came under your control this turn can’t attack unless they
          have haste. In <i>declare blockers</i>, each defender assigns blockers. Then <i>combat damage</i> (first strike
          gets its own step first), and <i>end of combat</i>.</li>
        <li><b>Second main phase.</b> Same as the first, and a good time for spells you held back during combat. You
          can still play your land here if you haven’t yet.</li>
        <li><b>Ending phase.</b> “At the beginning of the end step” triggers happen. In <i>cleanup</i>, discard down to
          seven cards, and damage wears off creatures.</li>
      </ol>
    )
  },
  {
    title: 'Priority and the stack — how responses work',
    body: (
      <div className="space-y-1.5">
        <p>Casting a spell or activating an ability puts it on <b>the stack</b>; it doesn’t happen yet. Then every player,
          in turn order, gets <b>priority</b>, a chance to respond with an instant or an ability.</p>
        <p>Each response goes on top of the stack. When <b>all players pass in a row</b>, the <b>top</b> item resolves
          (last in, first out), and everyone gets priority again. So a counterspell cast in response resolves before
          the spell it targets.</p>
        <p><b>Triggered abilities</b> (“when…”, “whenever…”, “at…”) also use the stack, and can be responded to.
          <b> Mana abilities</b> and <b>static abilities</b> don’t. Playing a land doesn’t either.</p>
        <p>Instants and abilities can be used whenever you have priority, including on other players’ turns. That’s
          how combat tricks and end-of-turn plays work.</p>
      </div>
    )
  },
  {
    title: 'What Commander changes',
    body: (
      <ul className="list-disc space-y-1.5 pl-4">
        <li><b>100 cards, singleton:</b> one copy of each card except basic lands, including your commander.</li>
        <li><b>Color identity:</b> every card’s mana symbols, in its cost <i>and</i> rules text, must fit your
          commander’s colors.</li>
        <li><b>40 life</b>, and usually 3 opponents.</li>
        <li><b>The command zone:</b> your commander starts there, and you can cast it from there. Each time you cast it
          from the command zone, it costs <b>{'{2}'} more</b> for every previous time (“commander tax”).</li>
        <li>If your commander would go to your graveyard or exile, you may move it back to the command zone instead.
          The same goes for your hand or library.</li>
        <li><b>Commander damage:</b> a player dealt <b>21 combat damage</b> by the same commander over the game loses.</li>
        <li><b>Mulligans:</b> the London mulligan applies (draw seven, then put one card on the bottom per mulligan),
          and in multiplayer your first mulligan is free.</li>
      </ul>
    )
  },
  {
    title: 'Combos, loops and long turns',
    body: (
      <div className="space-y-1.5">
        <p>An <b>infinite combo</b> is a set of cards that can repeat an action as many times as you like, like Skirk
          Prospector + Goblin Warchief + Krenko. You still perform every step legally. In paper you show the loop once
          and name how many times you repeat it. Forge resolves each step for you.</p>
        <p>A loop that is <b>optional</b> must stop at a number you choose. A loop that is <b>mandatory</b> for everyone,
          with nothing that can break it, makes the game a draw. Your opponents can always respond in the middle of a
          loop, which is how combos get stopped.</p>
        <p>The <b>Combos</b> tab on each deck lists what your deck can assemble, with green for in the deck and amber
          for in your collection.</p>
      </div>
    )
  },
  {
    title: 'Common beginner mistakes',
    body: (
      <ul className="list-disc space-y-1.5 pl-4">
        <li>Casting creatures before combat when you meant to attack first and hold up a trick. Play spells after combat unless they help the attack.</li>
        <li>Forgetting that summoning sickness only stops attacking and <b>{'{T}'}</b> abilities. Mana creatures without haste can’t tap for mana on the turn they arrive either.</li>
        <li>Tapping out on your own turn, which leaves nothing to answer threats on opponents’ turns.</li>
        <li>Keeping a hand with 0–1 lands, or 6–7 lands. See <b>Practice my decks</b>.</li>
        <li>Ignoring who is winning. In multiplayer, attack and remove threats from the player closest to winning, not whoever hit you last.</li>
      </ul>
    )
  }
]

function LearnPanel(): React.JSX.Element {
  const [open, setOpen] = useState<number>(0)
  return (
    <div className="max-w-3xl space-y-2">
      {LESSONS.map((l, i) => (
        <div key={l.title} className="rounded-md border border-white/10 bg-white/[0.03]">
          <button onClick={() => setOpen(open === i ? -1 : i)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
            {open === i ? <ChevronDown className="h-4 w-4 text-white/40" /> : <ChevronRight className="h-4 w-4 text-white/40" />}
            {l.title}
          </button>
          {open === i && <div className="px-9 pb-3 text-[13px] leading-relaxed text-white/65">{l.body}</div>}
        </div>
      ))}
      <p className="pt-1 text-[11px] text-white/30">
        Summarised from the Comprehensive Rules (the turn structure, the stack, and Commander’s section 903). Forge
        applies the full rules in play, so if a play is allowed there, it’s legal.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- Practice

const isLand = (c: MtgDeckCardView): boolean => /\bLand\b/.test((c.type_line ?? '').split(' // ')[0])

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  const r = new Uint32Array(a.length)
  crypto.getRandomValues(r)
  for (let i = a.length - 1; i > 0; i--) {
    const j = r[i] % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Rough read of a seven-card hand. Advice, not rules — the rules allow keeping anything. */
function handVerdict(hand: MtgDeckCardView[]): { tone: 'good' | 'warn' | 'bad'; text: string } {
  const lands = hand.filter(isLand).length
  const cheap = hand.filter((c) => !isLand(c) && c.cmc != null && c.cmc <= 2).length
  if (lands <= 1) return { tone: 'bad', text: `${lands} land${lands === 1 ? '' : 's'}. You’ll likely miss land drops; most players mulligan this.` }
  if (lands >= 6) return { tone: 'bad', text: `${lands} lands and almost nothing to cast. A mulligan is usually right.` }
  if (lands === 2) return { tone: 'warn', text: `2 lands${cheap ? ` with ${cheap} cheap play${cheap > 1 ? 's' : ''}` : ''}. Keepable if your plays are cheap or you have ramp; risky otherwise.` }
  return { tone: 'good', text: `${lands} lands and ${7 - lands} spells${cheap ? `, ${cheap} castable early` : ''}. A solid keep.` }
}

function PracticePanel({ onStatus }: { onStatus: (s: string | null) => void }): React.JSX.Element {
  const [decks, setDecks] = useState<MtgDeckSummary[]>([])
  const [deckId, setDeckId] = useState<string>('')
  const [deck, setDeck] = useState<MtgDeckDetail | null>(null)
  const [recs, setRecs] = useState<MtgDeckRecs | null>(null)
  const [hand, setHand] = useState<MtgDeckCardView[]>([])
  const [mulligans, setMulligans] = useState(0)
  const [bottom, setBottom] = useState<Set<number>>(new Set())
  const [kept, setKept] = useState(false)
  const [zoom, setZoom] = useState<MtgDeckCardView | null>(null)
  const [stats, setStats] = useState<{ hands: number; keeps: number } | null>(null)

  useEffect(() => {
    void window.atlis.mtg.decks().then((d) => {
      const playable = d.filter((x) => x.commanders.length)
      setDecks(playable)
      if (playable[0]) setDeckId(playable[0].id)
    })
  }, [])

  useEffect(() => {
    if (!deckId) return
    setDeck(null); setRecs(null); setHand([]); setKept(false); setMulligans(0); setStats(null)
    void window.atlis.mtg.deck(deckId).then(setDeck)
    void window.atlis.mtg.deckRecs(deckId).then(setRecs).catch(() => setRecs(null))
  }, [deckId])

  const library = useMemo(
    () => (deck?.cards ?? []).filter((c) => c.board === 'main').flatMap((c) => Array.from({ length: c.quantity }, () => c)),
    [deck]
  )

  // In multiplayer the first mulligan is free; after that, one card to the bottom per mulligan.
  const toBottom = Math.max(0, mulligans - 1)

  const draw = (mull: number): void => {
    if (library.length < 7) { onStatus('This deck has fewer than 7 cards in the 99.'); return }
    setHand(shuffle(library).slice(0, 7))
    setMulligans(mull)
    setBottom(new Set())
    setKept(false)
  }

  const keep = (): void => {
    setHand((h) => h.filter((_, i) => !bottom.has(i)))
    setKept(true)
  }

  /** Sample many hands to show how often this deck opens with a keepable mix. */
  const simulate = (): void => {
    let keeps = 0
    const N = 2000
    for (let i = 0; i < N; i++) {
      const lands = shuffle(library).slice(0, 7).filter(isLand).length
      if (lands >= 2 && lands <= 5) keeps++
    }
    setStats({ hands: N, keeps })
  }

  const verdict = hand.length === 7 && !kept ? handVerdict(hand) : null
  const landCount = library.filter(isLand).length
  const plan = recs && !recs.note ? recs.combos.filter((c) => c.status === 'in_deck') : []
  const near = recs && !recs.note ? recs.combos.filter((c) => c.status === 'ready').slice(0, 3) : []

  if (!decks.length) {
    return <p className="text-sm text-white/40">Save a deck with a commander on the Decks tab first. Practice uses your own lists.</p>
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select value={deckId} onChange={(e) => setDeckId(e.target.value)}
            className="rounded-md border border-white/10 bg-[#16161d] px-2 py-1.5 text-sm focus:outline-none">
            {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className={primary} disabled={!deck} onClick={() => draw(0)}><Shuffle className="h-3.5 w-3.5" /> Draw opening hand</button>
          {hand.length > 0 && !kept && (
            <button className={btn} onClick={() => draw(mulligans + 1)}>Mulligan{mulligans === 0 ? ' (free)' : ''}</button>
          )}
          {hand.length > 0 && !kept && (
            <button className={btn} disabled={bottom.size !== toBottom} onClick={keep}>
              <Check className="h-3.5 w-3.5" /> Keep{toBottom ? ` (bottom ${bottom.size}/${toBottom})` : ''}
            </button>
          )}
        </div>

        {deck && (
          <p className="mb-3 text-[11px] text-white/40">
            {library.length} cards in the 99 · {landCount} lands ({Math.round((landCount / Math.max(1, library.length)) * 100)}%).
            Mulligans so far: {mulligans}{mulligans ? ` (${mulligans === 1 ? 'free' : `${toBottom} to the bottom`})` : ''}.
          </p>
        )}

        {hand.length > 0 ? (
          <>
            {toBottom > 0 && !kept && (
              <p className="mb-2 text-[12px] text-amber-200/80">
                London mulligan: choose {toBottom} card{toBottom > 1 ? 's' : ''} to put on the bottom of your library, then keep.
              </p>
            )}
            {/* Capped so seven cards stay a glanceable row on a wide window; click one to enlarge. */}
            <div className="grid max-w-4xl grid-cols-4 gap-2 sm:grid-cols-7">
              {hand.map((c, i) => {
                const picked = bottom.has(i)
                return (
                  <div key={`${c.name_key}:${i}`} className="space-y-1">
                    <div className={`relative rounded-md ${picked ? 'opacity-40 ring-2 ring-amber-400/70' : ''}`}>
                      <ProductThumb
                        image={c.ext_id ? scryfallImage(c.ext_id, 'normal') : null}
                        alt={c.name}
                        size="lg"
                        title={toBottom && !kept ? 'Click to choose for the bottom' : 'Click to enlarge'}
                        onClick={() => {
                          if (toBottom && !kept) {
                            setBottom((b) => {
                              const n = new Set(b)
                              if (n.has(i)) n.delete(i)
                              else if (n.size < toBottom) n.add(i)
                              return n
                            })
                          } else setZoom(c)
                        }}
                      />
                    </div>
                    <div className="truncate text-center text-[10px] text-white/45">{c.name}</div>
                  </div>
                )
              })}
            </div>
            {verdict && (
              <p className={`mt-3 rounded-md px-3 py-2 text-[12px] ${
                verdict.tone === 'good' ? 'bg-emerald-500/10 text-emerald-100' : verdict.tone === 'warn' ? 'bg-amber-500/10 text-amber-100' : 'bg-red-500/10 text-red-100'
              }`}>
                {verdict.text}
              </p>
            )}
            {kept && <p className="mt-3 text-[12px] text-white/50">Kept {hand.length} cards. Draw again to practise another opening.</p>}
          </>
        ) : (
          <div className="rounded-md border border-dashed border-white/10 p-6 text-center text-[12px] text-white/35">
            Draw a hand to practise mulligan decisions with your real list. Shuffling is random, the free first mulligan
            and London bottoming follow Commander’s rules, and the hand advice is a guideline. You can legally keep any hand.
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <button className={btn} disabled={!deck} onClick={simulate}><Swords className="h-3.5 w-3.5" /> Test 2,000 hands</button>
          {stats && (
            <span className="text-[12px] text-white/55">
              {Math.round((stats.keeps / stats.hands) * 100)}% of opening sevens have 2–5 lands
              {stats.keeps / stats.hands < 0.8 ? ' — consider adjusting your land count.' : '.'}
            </span>
          )}
        </div>
      </div>

      <aside className="space-y-3 lg:sticky lg:top-0 lg:max-h-[calc(100vh-9rem)] lg:self-start lg:overflow-y-auto">
        <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-white/40">How this deck wins</div>
          {deck?.cards.filter((c) => c.board === 'commander').map((c) => (
            <div key={c.name_key} className="mb-2 flex items-center gap-2">
              <ProductThumb image={c.ext_id ? scryfallImage(c.ext_id, 'small') : null} alt={c.name} size="sm" onClick={() => setZoom(c)} />
              <div className="min-w-0">
                <div className="truncate text-sm">{c.name}</div>
                <div className="truncate text-[11px] text-white/40">{c.type_line}</div>
              </div>
            </div>
          ))}
          {!recs ? (
            <div className="flex items-center gap-2 text-[12px] text-white/40"><Loader2 className="h-3 w-3 animate-spin" /> Reading EDHREC…</div>
          ) : plan.length ? (
            <div className="space-y-2">
              <div className="text-[11px] text-white/45">Combos already in the list. Watch for these pieces in your opening hands:</div>
              {plan.slice(0, 5).map((c) => (
                <div key={c.id} className="rounded bg-white/[0.03] p-2 text-[12px]">
                  <div className="text-emerald-200/90">{c.pieces.map((p) => p.name).join(' + ')}</div>
                  <div className="text-[11px] text-white/40">{c.results.slice(0, 3).join(' · ')}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-white/40">No known combo is fully in this list. It wins by board presence and value; see the Upgrades tab for ideas.</p>
          )}
          {near.length > 0 && (
            <div className="mt-3 space-y-1">
              <div className="text-[11px] text-amber-200/70">One edit away, using cards you own:</div>
              {near.map((c) => <div key={c.id} className="text-[11px] text-white/50">{c.pieces.map((p) => p.name).join(' + ')}</div>)}
            </div>
          )}
        </div>
      </aside>

      {zoom?.ext_id && (() => {
        const large = scryfallImage(zoom.ext_id, 'large')
        return large ? <ImageZoom image={large} name={zoom.name} subtitle={zoom.type_line} onClose={() => setZoom(null)} /> : null
      })()}
    </div>
  )
}
