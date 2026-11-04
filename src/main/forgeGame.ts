/**
 * Hosts a Commander game: Forge's engine runs headless in the forge-bridge
 * Java process, ATLIS draws the table.
 *
 * The bridge speaks JSON lines (see forge-bridge/src/atlis/bridge/Protocol.java):
 * it sends "ready", "state" snapshots, "request"s it is blocked on, and
 * notices; ATLIS sends {"cmd": ...} actions and {"cmd":"answer"} replies.
 * This module spawns it, relays both directions, and adds one thing the
 * engine doesn't know: art. Each card in a snapshot gets `art` = a Scryfall
 * printing id — the exact printing from the ATLIS deck when the card came
 * from one, otherwise Forge's set + collector number resolved via Scryfall.
 *
 * One bridge per game: a fresh JVM can't carry state from the last match.
 * Electron-free; the caller supplies where events go.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import * as db from './db'
import * as forge from './forge'
import * as mtg from './mtg'

export type GameEvent = Record<string, unknown> & { type: string }

export interface DeckOption {
  path: string
  name: string
  kind: 'atlis' | 'precon'
  /** Saved-deck id for ATLIS decks (exact printings for art). */
  deckId?: string
  set?: string
  year?: string
}

export interface StartOptions {
  /** Your deck file path (from listDecks): a saved ATLIS deck or a Forge precon. */
  deck: string
  /** Opponent deck file paths (from listDecks), 1–3 of them. */
  opponents: string[]
}

let child: ChildProcessWithoutNullStreams | null = null
let emit: (e: GameEvent) => void = () => undefined
/** Card name (folded) → Scryfall printing id, from the ATLIS decks in this game. */
let nameArt = new Map<string, string>()
/** "set:cn" (Scryfall set, lowercase) → Scryfall printing id; persists across games. */
const printingArt = new Map<string, string | null>()
let forgeToSf = new Map<string, string>()
/** Token search ("Goblin|R|1/1") → every Scryfall art for it; [] = none. Persists across games. */
const tokenArts = new Map<string, string[]>()
/** Token card id → the art it drew, so a token keeps its picture while it lives. Per game. */
let tokenPick = new Map<number, string>()
let lastState: GameEvent | null = null
let resolving = false
/** Every message both ways for the current game, one JSON line each — for diagnosing "what happened?". */
let traffic: WriteStream | null = null

const KEEP_LOGS = 10

function openTrafficLog(appRoot: string): string | null {
  try {
    const dir = join(appRoot, 'forge-bridge', 'logs')
    mkdirSync(dir, { recursive: true })
    const old = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    for (const f of old.slice(0, Math.max(0, old.length - (KEEP_LOGS - 1)))) {
      try { unlinkSync(join(dir, f)) } catch { /* in use */ }
    }
    const file = join(dir, `game-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
    traffic = createWriteStream(file, { flags: 'a' })
    return file
  } catch {
    traffic = null
    return null
  }
}

function record(dir: 'in' | 'out', line: string): void {
  traffic?.write(`{"t":${Date.now()},"dir":"${dir}","msg":${line}}\n`)
}

// ---------------------------------------------------------------- setup

/**
 * The newest compiled bridge, next to the app in development. Builds are
 * timestamped (a running game keeps its jar locked), so pick the latest.
 */
export function bridgeJar(appRoot: string): string | null {
  const dir = join(appRoot, 'forge-bridge', 'build')
  if (!existsSync(dir)) return null
  const jars = readdirSync(dir).filter((f) => /^atlis-forge-bridge.*\.jar$/.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return jars[0] ? join(dir, jars[0].f) : null
}

function forgeJar(dir: string): string | null {
  const f = readdirSync(dir).find((x) => /^forge-gui-desktop-.*jar-with-dependencies\.jar$/.test(x))
  return f ? join(dir, f) : null
}

export function readiness(appRoot: string): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const { dir } = forge.installDir()
  if (!dir) problems.push('Forge isn’t installed (Play → Play in Forge, step 2).')
  else if (!forgeJar(dir)) problems.push('The Forge folder has no desktop jar.')
  if (forge.javaExe() === 'java') problems.push('Java 17+ wasn’t found.')
  if (!bridgeJar(appRoot)) problems.push('The ATLIS–Forge bridge isn’t built: run forge-bridge\\build.ps1 (needs the Temurin JDK).')
  return { ok: problems.length === 0, problems }
}

/**
 * Your saved decks and Forge's bundled Commander precons — names and file
 * paths only. Exporting your decks to Forge (Scryfall lookups for every card)
 * waits for a game to start, and then covers only the decks at the table.
 */
export async function listDecks(): Promise<DeckOption[]> {
  const out: DeckOption[] = []
  for (const d of forge.playableDecks()) out.push({ path: d.path, name: d.name, kind: 'atlis', deckId: d.deckId })
  const { dir } = forge.installDir()
  const preconDir = dir ? join(dir, 'res', 'quest', 'commanderprecons') : null
  if (preconDir && existsSync(preconDir)) {
    for (const f of readdirSync(preconDir)) {
      if (!f.endsWith('.dck')) continue
      // "Ahoy Mateys [LCC] [2023].dck"
      const m = /^(.*?) \[([A-Z0-9]+)\] \[(\d{4})\]\.dck$/.exec(f)
      out.push({ path: join(preconDir, f), name: m?.[1] ?? f.slice(0, -4), kind: 'precon', set: m?.[2], year: m?.[3] })
    }
  }
  return out
}

// ---------------------------------------------------------------- game lifecycle

export function running(): boolean {
  return child != null
}

export async function start(appRoot: string, opts: StartOptions, onEvent: (e: GameEvent) => void): Promise<void> {
  stop()
  const r = readiness(appRoot)
  if (!r.ok) throw new Error(r.problems.join(' '))
  const all = await listDecks()
  const you = all.find((d) => d.path === opts.deck)
  if (!you) throw new Error('That deck needs a commander before it can be played (Decks tab → crown a card).')
  const opps = opts.opponents.map((p) => all.find((d) => d.path === p)).filter((d): d is DeckOption => !!d)
  if (!opps.length) throw new Error('Pick at least one opponent.')
  // Write the saved decks at this table (and only those) so a deck edited a
  // minute ago plays as edited. Unchanged ones are left as they are.
  const atTable = [...new Set([you, ...opps].map((d) => d.deckId).filter((x): x is string => !!x))]
  if (atTable.length) {
    const r = await forge.exportDecks({ only: atTable })
    const missing = [you, ...opps].filter((d) => d.deckId && !r.files[d.deckId])
    if (missing.length) throw new Error(`Couldn't prepare ${missing.map((d) => d.name).join(', ')} for Forge: ${r.skipped.map((s) => s.reason).join('; ') || 'unknown reason'}.`)
  }

  emit = onEvent
  lastState = null
  forgeToSf = forge.forgeToScryfallSets()
  tokenPick = new Map()
  // Exact printings for every ATLIS deck at the table.
  nameArt = new Map()
  for (const d of [you, ...opps]) {
    if (!d.deckId) continue
    for (const c of db.listMtgDeckCards(d.deckId)) if (c.ext_id) nameArt.set(c.name_key, c.ext_id)
  }

  const dir = forge.installDir().dir as string
  traffic?.end()
  const logFile = openTrafficLog(appRoot)
  const proc = spawn(forge.javaExe(), [
    '-Xmx4096m', '-Dio.netty.tryReflectionSetAccessible=true', '-Dfile.encoding=UTF-8',
    '-cp', `${bridgeJar(appRoot)};${forgeJar(dir)}`, 'atlis.bridge.Main'
  ], { cwd: dir, windowsHide: true })
  child = proc

  const players = [
    { deck: you.path, name: 'You', ai: false },
    ...opps.map((o, i) => ({ deck: o.path, name: opps.length > 1 ? `${o.name} (AI ${i + 1})` : `${o.name} (AI)`, ai: true }))
  ]
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg: GameEvent
    try { msg = JSON.parse(line) as GameEvent } catch { return }
    record('in', line)
    if (msg.type === 'ready') {
      send({ cmd: 'start', players })
      emit({ type: 'booted', bootMs: msg.bootMs })
      return
    }
    if (msg.type === 'state') {
      lastState = msg
      attachArt(msg)
      const tokens = tokensWanted
      emit(msg)
      void resolveMissingArt()
      void resolveTokenArt(tokens)
      return
    }
    if (msg.type === 'request' || msg.type === 'reveal') {
      // Options can be cards from hidden zones (a tutor lists your library),
      // which no snapshot has carried yet. Their art is looked up before the
      // question is shown, so the picker is pictures, not a list of names.
      void withOptionArt(msg).then(emit)
      return
    }
    emit(msg)
  })
  let errTail = ''
  proc.stderr.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-4000) })
  proc.on('exit', (code) => {
    if (child === proc) { child = null; traffic?.end(); traffic = null }
    emit({ type: 'exited', code, detail: code ? errTail.split('\n').filter((l) => /Exception|Error/.test(l)).slice(-3).join('\n') : null })
  })
  emit({ type: 'booting', logFile })
}

export function send(cmd: Record<string, unknown>): void {
  const line = JSON.stringify(cmd)
  record('out', line)
  child?.stdin.write(line + '\n')
}

export function stop(): void {
  const c = child
  child = null
  if (!c) return
  try { c.stdin.write('{"cmd":"quit"}\n') } catch { /* already gone */ }
  setTimeout(() => { try { c.kill() } catch { /* exited */ } }, 1500)
}

// ---------------------------------------------------------------- art

interface SnapCard {
  id: number; name?: string; set?: string; cn?: string; hidden?: boolean; token?: boolean; text?: string | null; art?: string | null
  colors?: string; power?: number | null; toughness?: number | null; creature?: boolean
}

function printingKey(c: SnapCard): string | null {
  if (!c.set || !c.cn) return null
  const sf = forgeToSf.get(c.set.toLowerCase()) ?? c.set.toLowerCase()
  return `${sf}:${c.cn}`
}

/**
 * What a token looks like for an art search: its name (Forge says "Goblin
 * Token"), colors, and base-ish P/T for creatures. Noncreature tokens (Food,
 * Treasure, Clue) go by name alone.
 */
function tokenKey(c: SnapCard): string | null {
  const name = c.name?.replace(/\s+Token$/i, '').trim()
  if (!name) return null
  return [name, c.colors ?? '', c.creature && c.power != null ? `${c.power}/${c.toughness}` : ''].join('|')
}

/** Scryfall searches for a token key, most specific first. */
function tokenQueries(key: string): string[] {
  const [name, colors, pt] = key.split('|')
  const exact = `!"${name.replace(/"/g, '')}"`
  const color = `c=${colors || 'c'}`
  const [p, t] = pt ? pt.split('/') : []
  return [...new Set([
    pt ? `${exact} ${color} pow=${p} tou=${t}` : `${exact} ${color}`,
    `${exact} ${color}`, // pumped / anthem'd: P/T won't match a printing
    exact
  ])]
}

/** Art for each token we already know art for; returns the token keys still to search. */
function attachTokenArt(c: SnapCard): string | null {
  const picked = tokenPick.get(c.id)
  if (picked) { c.art = picked; return null }
  const key = tokenKey(c)
  if (!key) return null
  const pool = tokenArts.get(key)
  if (pool === undefined) return key
  if (pool.length) {
    // A random printing each time a token is made — there's a lot of good token art.
    const art = pool[Math.floor(Math.random() * pool.length)]
    tokenPick.set(c.id, art)
    c.art = art
  }
  return null
}

let tokenSearching = false
/** Search Scryfall for token keys we haven't seen, then re-send the latest state with their art. */
async function resolveTokenArt(keys: string[]): Promise<void> {
  if (tokenSearching || !keys.length) return
  tokenSearching = true
  try {
    for (const key of new Set(keys)) {
      let ids: string[] = []
      for (const q of tokenQueries(key)) {
        ids = await mtg.tokenArtIds(q)
        if (ids.length) break
        await new Promise((r) => setTimeout(r, 120)) // Scryfall asks for ~10 requests/s at most
      }
      // A token copy of a real card (Spark Double-style, "token that's a copy of"):
      // no token printing exists, so use the card's own art.
      if (!ids.length) {
        const card = (await mtg.cardsByNames([key.split('|')[0]])).found[0]
        if (card) ids = [card.id]
      }
      tokenArts.set(key, ids)
    }
    if (lastState && child) {
      attachArt(lastState)
      emit(lastState)
    }
  } catch {
    // offline: tokens stay text frames; try again on a later state
  } finally {
    tokenSearching = false
  }
}

/** Fill `art` on every visible card we can already answer for. */
/** Copied card name → its art, remembered after the original leaves the table. */
const copyArt = new Map<string, string>()

/** Token keys the last attachArt() couldn't answer yet. */
let tokensWanted: string[] = []

function attachArt(state: GameEvent): string[] {
  const cards = (state.cards ?? {}) as Record<string, SnapCard>
  const missing: string[] = []
  tokensWanted = []
  // A copy (Imposter Mech as Thor, Clone, Spark Double) keeps the PRINTING of
  // the card it really is, so its printing art would be the wrong picture.
  // Forge marks copies with "Cloned by:" in their text; give them the art of
  // a non-copy with the same name on the table instead.
  const isCopy = (c: SnapCard): boolean => typeof c.text === 'string' && c.text.includes('Cloned by:')
  const copies: SnapCard[] = []
  for (const c of Object.values(cards)) {
    if (c.hidden || !c.name) continue
    if (isCopy(c)) copies.push(c)
    const own = nameArt.get(db.cardNameKey(c.name))
    if (own) { c.art = own; continue }
    if (c.token) {
      const want = attachTokenArt(c)
      if (want) tokensWanted.push(want)
      continue
    }
    const key = printingKey(c)
    if (!key) continue
    const hit = printingArt.get(key)
    if (hit !== undefined) c.art = hit
    else missing.push(key)
  }
  if (copies.length) {
    const byName = new Map<string, string>()
    for (const c of Object.values(cards)) if (c.name && c.art && !isCopy(c)) byName.set(c.name, c.art as string)
    for (const c of copies) {
      const art = byName.get(c.name as string) ?? copyArt.get(c.name as string)
      if (art) { c.art = art; copyArt.set(c.name as string, art) }
    }
  }
  return missing
}

/** Fill art on a request's option cards, fetching unknown printings first (one Scryfall call). */
async function withOptionArt(msg: GameEvent): Promise<GameEvent> {
  const opts = (msg.options ?? []) as Array<{ cardData?: SnapCard }>
  const holder: GameEvent = { type: 'x', cards: Object.fromEntries(opts.filter((o) => o.cardData).map((o, i) => [String(i), o.cardData])) }
  const missing = attachArt(holder)
  if (missing.length) {
    try {
      const keys = [...new Set(missing)]
      const found = await mtg.cardsBySetNumber(keys.map((k) => { const i = k.indexOf(':'); return { set: k.slice(0, i), cn: k.slice(i + 1) } }))
      for (const k of keys) printingArt.set(k, found.get(k)?.id ?? null)
      attachArt(holder)
    } catch {
      // offline: show names
    }
  }
  return msg
}

/** Look up printings we haven't seen, then re-send the latest state with their art. */
async function resolveMissingArt(): Promise<void> {
  if (resolving || !lastState) return
  const missing = attachArt(lastState)
  if (!missing.length) return
  resolving = true
  try {
    const items = [...new Set(missing)].map((k) => { const i = k.indexOf(':'); return { set: k.slice(0, i), cn: k.slice(i + 1) } })
    const found = await mtg.cardsBySetNumber(items)
    for (const k of new Set(missing)) printingArt.set(k, found.get(k)?.id ?? null)
    if (lastState && child) {
      attachArt(lastState)
      emit(lastState)
    }
  } catch {
    // offline: cards render as text frames
  } finally {
    resolving = false
  }
}
