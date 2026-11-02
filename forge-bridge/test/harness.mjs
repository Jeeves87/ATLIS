// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Scenario harness: play the user's REAL decks through the bridge the way the
// ATLIS table does — same commands (click a card, OK, answer a question) —
// starting from a board set up with Forge's puzzle-format state.
//
//   const g = await Game.start({ you: deckPath, opp: deckPath })
//   await g.untilPriority()
//   await g.applyState([...])
//   await g.click('Inniaz, the Gale Force')
//   g.check('trigger fired', g.logHas(/You triggered Inniaz/))
//
// Every wait has a timeout, so a broken interaction fails fast instead of hanging.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const FORGE = process.env.FORGE_DIR ?? 'C:\\Forge'
export const DECKS = process.env.DECK_DIR ?? join(process.env.APPDATA, 'Forge', 'decks', 'commander')
export const deck = (re) => {
  const f = readdirSync(DECKS).find((d) => d.startsWith('ATLIS - ') && re.test(d))
  if (!f) throw new Error(`no exported deck matching ${re}`)
  return join(DECKS, f)
}

function javaPath() {
  const root = 'C:\\Program Files\\Eclipse Adoptium'
  const jdk = readdirSync(root).filter((d) => /^(jdk|jre)-/.test(d)).sort().reverse()[0]
  return join(root, jdk, 'bin', 'java.exe')
}

export class Game {
  static async start({ you, opp, quiet = true }) {
    const g = new Game(quiet)
    await g.boot(you, opp)
    return g
  }

  constructor(quiet) {
    this.quiet = quiet
    this.state = null
    this.waiters = []
    this.results = []
    this.requests = []
    this.selections = []
    /** How to answer engine questions; return the answer value, or undefined for the default. */
    this.answerWith = null
  }

  async boot(you, opp) {
    const build = join(import.meta.dirname, '..', 'build')
    const jar = readdirSync(build).filter((f) => /^atlis-forge-bridge.*\.jar$/.test(f)).sort().reverse()[0]
    const forgeJar = readdirSync(FORGE).find((f) => /^forge-gui-desktop-.*jar-with-dependencies\.jar$/.test(f))
    if (!jar || !existsSync(join(FORGE, forgeJar))) throw new Error('bridge or Forge missing')
    this.child = spawn(javaPath(), ['-Xmx4096m', '-Dio.netty.tryReflectionSetAccessible=true', '-Dfile.encoding=UTF-8',
      '-cp', `${join(build, jar)};${join(FORGE, forgeJar)}`, 'atlis.bridge.Main'], { cwd: FORGE })
    this.child.stderr.on('data', (d) => {
      for (const l of String(d).split(/\r?\n/)) if (/Exception|^\s+at (forge|atlis)\./.test(l)) this.note(`[stderr] ${l.slice(0, 180)}`)
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line))
    await this.waitEvent('ready', 60_000)
    this.send({ cmd: 'start', players: [{ deck: you, name: 'You', ai: false }, { deck: opp, name: 'Opponent', ai: true }] })
    await this.waitFor((s) => s.players?.length > 0, 30_000, 'first snapshot')
  }

  onLine(line) {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (m.type === 'state') this.state = m
    if (m.type === 'request') this.onRequest(m)
    if (m.type === 'error') this.note(`[bridge error] ${m.message}`)
    for (const w of [...this.waiters]) w(m)
  }

  onRequest(r) {
    this.requests.push(r)
    const custom = this.answerWith?.(r)
    let value = custom
    if (value === undefined) {
      const n = r.options?.length ?? 0
      if (r.kind === 'confirm' || r.kind === 'option') value = r.default ?? 0
      else if (r.kind === 'input') value = r.initial ?? '0'
      // assign: everything to the first option that can take it (a valid, if dull, split).
      else if (r.kind === 'assign') { let left = r.amount ?? 0; value = (r.options ?? []).map((o) => { const v = Math.min(o.max ?? left, left); left -= v; return v }) }
      else value = Array.from({ length: Math.min(n, Math.max(r.min ?? 0, r.kind === 'order' ? n : 1)) }, (_, i) => i)
    }
    this.note(`  ? ${r.kind}: ${r.title?.split('\n')[0]} → ${JSON.stringify(value)}`)
    this.send({ cmd: 'answer', rid: r.rid, value })
  }

  note(s) { if (!this.quiet || s.startsWith('[')) console.log(s) }
  send(o) { this.child.stdin.write(JSON.stringify(o) + '\n') }

  waitEvent(type, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`timeout waiting for ${type}`)) }, ms)
      const w = (m) => { if (m.type === type) { clearTimeout(t); this.waiters = this.waiters.filter((x) => x !== w); resolve(m) } }
      this.waiters.push(w)
    })
  }

  /** Resolve with the first snapshot (current or future) satisfying pred. */
  waitFor(pred, ms = 15_000, what = 'condition') {
    return new Promise((resolve, reject) => {
      if (this.state && pred(this.state)) return resolve(this.state)
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`timeout waiting for ${what}`)) }, ms)
      const w = (m) => { if (m.type === 'state' && pred(m)) { clearTimeout(t); this.waiters = this.waiters.filter((x) => x !== w); resolve(m) } }
      this.waiters.push(w)
    })
  }

  get me() { return this.state.players.find((p) => p.id === this.state.you) }
  cards(zone, mine = true) {
    const p = mine ? this.me : this.state.players.find((x) => x.id !== this.state.you)
    return (p.zones[zone] ?? []).map((id) => this.state.cards[id]).filter(Boolean)
  }
  find(name, zone = 'battlefield') { return this.cards(zone).find((c) => c.name === name) }
  promptIs(re) { return re.test(this.state?.prompt?.message ?? '') }
  hasPriority(s = this.state) { return /^Priority: You/m.test(s?.prompt?.message ?? '') && s.prompt.okEnabled }
  logHas(re) { return (this.state?.log ?? []).some((l) => re.test(l.text)) }

  /** Keep the opening hand and pass until we have priority. */
  async untilPriority(ms = 45_000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const s = this.state
      if (this.hasPriority(s)) return s
      // Pre-game prompts (play or draw, keep or mulligan) take the default: Play / Keep.
      if (s?.prompt?.okEnabled && s.prompt.message !== this.lastPregame) {
        this.lastPregame = s.prompt.message
        this.send({ cmd: 'ok' })
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error('never got priority')
  }

  /**
   * Get to OUR first main phase with priority before touching the board, so
   * a turn change can't draw away the card a scenario put on top.
   */
  async untilOurMain(ms = 60_000) {
    await this.untilPriority(ms)
    return this.passUntil((s) => s.activePlayer === s.you && s.phase === 'MAIN1' && this.hasPriority(s), ms, 'our main phase')
  }

  async applyState(lines) {
    const done = this.waitEvent('stateApplied', 15_000)
    this.send({ cmd: 'applyState', lines })
    await done
    await new Promise((r) => setTimeout(r, 300))
  }

  async click(name, zone = 'battlefield') {
    const c = this.find(name, zone)
    if (!c) throw new Error(`${name} not in your ${zone}`)
    this.send({ cmd: 'card', id: c.id })
    await new Promise((r) => setTimeout(r, 400))
  }

  async ok() { this.send({ cmd: 'ok' }); await new Promise((r) => setTimeout(r, 400)) }

  /**
   * Pass priority until pred holds (e.g. the attack prompt), max `ms`. Along
   * the way, answer in-table selection prompts the way a player would: click a
   * highlighted (selectable) card, then OK once Forge enables it. Every such
   * prompt is recorded in `this.selections` with the exact text the dock shows.
   */
  async passUntil(pred, ms = 20_000, what = 'condition') {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const s = this.state
      if (s && pred(s)) return s
      // Press OK once per distinct priority window, like a person — a repeated
      // press lands on whatever prompt comes next and passes it unseen.
      if (s && this.hasPriority(s)) {
        const key = `${s.turn}|${s.phase}|${s.stack.length}|${(s.log ?? []).length}`
        if (key !== this.lastPassKey) { this.lastPassKey = key; this.send({ cmd: 'ok' }) }
      }
      else if (s) await this.answerSelection(s)
      await new Promise((r) => setTimeout(r, 350))
    }
    throw new Error(`timeout passing until ${what}`)
  }

  async answerSelection(s) {
    const selectable = Object.values(s.cards).filter((c) => c.selectable)
    const key = `${s.prompt.message}|${selectable.map((c) => c.id).join(',')}`
    if (!selectable.length || this.lastSelectionKey === key) {
      if (selectable.length === 0 && s.prompt.okEnabled && !this.hasPriority(s) && this.lastOkKey !== s.prompt.message) {
        this.lastOkKey = s.prompt.message
        this.send({ cmd: 'ok' })
      }
      return
    }
    this.lastSelectionKey = key
    this.selections.push({ message: s.prompt.message, promptCard: s.prompt.card != null ? s.cards[s.prompt.card]?.name : null, selectable: selectable.map((c) => c.name), min: s.prompt.min, max: s.prompt.max })
    const pick = this.preferSelect?.(selectable) ?? selectable[0]
    this.send({ cmd: 'card', id: pick.id })
    await new Promise((r) => setTimeout(r, 400))
    // Forge finishes a pick-exactly-one choice on the click itself. Only confirm
    // if the SAME choice is still on screen — otherwise this OK would land on
    // the next prompt (e.g. the combat priority window) and pass it.
    const now = this.state
    if (now?.prompt?.okEnabled && now.prompt.message === s.prompt.message && !this.hasPriority(now)) this.send({ cmd: 'ok' })
  }

  check(label, ok, detail = '') {
    this.results.push({ label, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    return ok
  }

  recentLog(n = 12, filter = (l) => l.type !== 'MANA') {
    return (this.state?.log ?? []).filter(filter).slice(-n).map((l) => `${l.type}: ${l.text}`)
  }

  quit() {
    try { this.send({ cmd: 'quit' }) } catch { /* gone */ }
    setTimeout(() => { try { this.child.kill() } catch { /* gone */ } }, 1000)
  }
}
