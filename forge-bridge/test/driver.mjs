// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Headless driver for the ATLIS ⇄ Forge bridge — plays the role ATLIS will.
//
//   node test/driver.mjs ai        AI vs AI, watch the snapshot stream
//   node test/driver.mjs human     you (scripted) vs AI: keeps the hand, plays
//                                  lands and anything Forge marks playable,
//                                  attacks with everything, answers prompts
//
// Env: FORGE_DIR (default C:\Forge), DECK_DIR (Forge's commander deck folder).
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.argv[2] ?? 'ai'
const FORGE = process.env.FORGE_DIR ?? 'C:\\Forge'
const DECKS = process.env.DECK_DIR ?? join(process.env.APPDATA, 'Forge', 'decks', 'commander')
const MAX_MS = Number(process.env.MAX_MS ?? 120_000)

const jdk = readdirSync('C:\\Program Files\\Eclipse Adoptium').filter((d) => d.startsWith('jdk-') || d.startsWith('jre-')).sort().reverse()[0]
const java = join('C:\\Program Files\\Eclipse Adoptium', jdk, 'bin', 'java.exe')
const forgeJar = readdirSync(FORGE).find((f) => /^forge-gui-desktop-.*jar-with-dependencies\.jar$/.test(f))
const buildDir = join(import.meta.dirname, '..', 'build')
const newest = existsSync(buildDir) ? readdirSync(buildDir).filter((f) => /^atlis-forge-bridge.*\.jar$/.test(f)).sort().reverse()[0] : null
if (!newest) throw new Error('build the bridge first (build.ps1)')
const bridgeJar = join(buildDir, newest)

const decks = readdirSync(DECKS).filter((f) => f.startsWith('ATLIS - ') && f.endsWith('.dck'))
const pick = (re) => decks.find((d) => re.test(d)) ?? decks[0]
const mine = process.env.DECK_MINE ?? join(DECKS, pick(/Mutant Menace/))
const theirs = process.env.DECK_THEIRS ?? join(DECKS, pick(/Goblin Storm/))
console.log('decks:', mine, 'vs', theirs)

const t0 = Date.now()
const child = spawn(java, ['-Xmx4096m', '-Dio.netty.tryReflectionSetAccessible=true', '-Dfile.encoding=UTF-8',
  '-cp', `${bridgeJar};${join(FORGE, forgeJar)}`, 'atlis.bridge.Main'], { cwd: FORGE })
let stderrTail = []
child.stderr.on('data', (d) => { stderrTail = [...stderrTail, ...String(d).split('\n')].slice(-40) })
if (process.env.TRACE_PROMPTS) child.stderr.on('data', (d) => {
  for (const l of String(d).split(/\r?\n/)) if (/Exception|Error|^\s+at (forge|atlis)\./.test(l)) console.log('  [stderr]', l.slice(0, 200))
})
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')

let last = null
let snapshots = 0
let actions = 0
let lastPromptKey = ''
let you = null
const seen = { requests: {}, phases: new Set(), maxStack: 0 }
// Human-mode success criteria: stop as soon as each has been observed.
const goals = { playableSeen: false, landPlayed: false, spellResolved: false, attacked: false }
const name = (s, id) => s?.cards?.[id]?.name ?? `#${id}`

function summary(s) {
  const ps = s.players.map((p) => `${p.name}${p.id === s.activePlayer ? '*' : ''}: ${p.life}♥ hand ${p.zones.hand.length} bf ${p.zones.battlefield.length} gy ${p.zones.graveyard.length} lib ${p.library}`)
  return `T${s.turn} ${s.phase ?? '-'} | ${ps.join(' | ')}${s.stack.length ? ` | stack ${s.stack.length}` : ''}`
}

/** The scripted human: always act through Forge's own prompt/buttons/selectables. */
function act(s) {
  if (mode !== 'human' || s.gameOver) return
  const pr = s.prompt
  const meNow = s.players.find((p) => p.id === s.you)
  // Anything that changes what we'd do next must be in the key, or we wait forever.
  const key = `${s.turn}|${s.phase}|${pr.message}|${pr.okLabel}|${pr.okEnabled}|${s.stack.length}|${meNow?.zones.hand.length}|${meNow?.zones.battlefield.length}|${meNow?.landsPlayed}|${Object.values(s.cards).filter((c) => c.tapped).length}`
  if (key === lastPromptKey) return
  lastPromptKey = key
  const me = s.players.find((p) => p.id === s.you)
  const cards = Object.values(s.cards)
  const selectable = cards.filter((c) => c.selectable)
  const playable = cards.filter((c) => c.playable && c.controller === s.you)
  actions++
  const msg = (pr.message ?? '').toLowerCase()
  if (process.env.DEBUG_ATTACK && s.phase === 'COMBAT_DECLARE_ATTACKERS' && s.activePlayer === s.you && !dbg.has(s.turn)) {
    dbg.add(s.turn)
    const crs = cards.filter((c) => c.controller === s.you && c.creature && c.zone === 'Battlefield')
    console.log(`  [atk T${s.turn}] prompt="${pr.message}" ok=${pr.okEnabled}/${pr.okLabel} selectable=${selectable.map((c) => c.name).join(',')} myCreatures=${crs.map((c) => `${c.name}${c.sick ? '(sick)' : ''}${c.tapped ? '(T)' : ''}`).join(',')}`)
  }
  // Declaring attackers: Forge makes our creatures selectable; click each, then OK.
  const attackers = cards.filter((c) => c.canAttack)
  if (/creatures to attack|declare attackers/.test(msg) && attackers.length && !cards.some((c) => c.attacking)) {
    console.log(`  → attack with ${attackers.map((c) => c.name).join(', ')}`)
    for (const c of attackers) send({ cmd: 'card', id: c.id })
    setTimeout(() => send({ cmd: 'ok' }), 50)
    return
  }
  // Main phase with priority and nothing on the stack: play a land, then something castable.
  if (me?.priority && s.stack.length === 0 && /main/i.test(s.phase ?? '') && s.activePlayer === s.you) {
    const land = playable.find((c) => c.land && c.zone === 'Hand' && me.landsPlayed < Math.max(1, me.maxLands))
    if (land) { console.log(`  → play land ${land.name}`); send({ cmd: 'card', id: land.id }); return }
    const spell = playable.find((c) => c.zone === 'Hand' || c.zone === 'Command')
    if (spell && !tried.has(`${s.turn}:${spell.id}`)) {
      tried.add(`${s.turn}:${spell.id}`)
      console.log(`  → cast ${spell.name}`)
      send({ cmd: 'card', id: spell.id })
      return
    }
  }
  // A selection prompt (discard to hand size, sacrifice, choose cards): click
  // selectable cards one at a time until Forge enables OK.
  if (!pr.okEnabled && selectable.length) {
    const next = selectable.find((c) => !clicked.has(`${key}:${c.id}`)) ?? selectable[0]
    clicked.add(`${key}:${next.id}`)
    console.log(`  → select ${next.name ?? next.id} for "${pr.message}"`)
    send({ cmd: 'card', id: next.id })
    return
  }
  // Trace every prompt the human sees between a spell being cast and the stack emptying.
  if (process.env.TRACE_PROMPTS && traceLeft > 0 && tried.size) {
    traceLeft--
    console.log(`  [prompt] "${(pr.message ?? '').split(String.fromCharCode(10)).filter((l) => !/^(Turn|Phase):/.test(l)).join(' | ')}" ok=${pr.okEnabled ? pr.okLabel : '-'} cancel=${pr.cancelEnabled ? pr.cancelLabel : '-'} stack=${s.stack.length}`)
  }
  // Paying mana / anything else: Forge's OK is "auto-pay" while paying, "pass priority" otherwise.
  if (pr.okEnabled) send({ cmd: 'ok' })
  else if (pr.cancelEnabled) { if (process.env.TRACE_PROMPTS) console.log('  !! auto-CANCEL'); send({ cmd: 'cancel' }) }
}
let traceLeft = 25
const tried = new Set()
const clicked = new Set()
const dbg = new Set()

function answer(r) {
  seen.requests[r.kind] = (seen.requests[r.kind] ?? 0) + 1
  // Tutor check: a library search must arrive as a pick-from-cards question with full card data.
  if (process.env.EXPECT_TUTOR && /search|library|tutor/i.test(r.title ?? '')) {
    const withData = (r.options ?? []).filter((o) => o.cardData?.name)
    console.log(`  ★ tutor request: "${r.title}" — ${r.options?.length} options, ${withData.length} with card data; e.g. ${JSON.stringify(withData[0]?.cardData ? { name: withData[0].cardData.name, set: withData[0].cardData.set, cn: withData[0].cardData.cn, zone: withData[0].cardData.zone } : null)}`)
    if (withData.length) { send({ cmd: 'answer', rid: r.rid, value: [0] }); setTimeout(() => finish('tutor search arrived as a card picker'), 300); return }
  }
  const n = r.options?.length ?? 0
  let value
  if (r.kind === 'confirm' || r.kind === 'option') value = r.default ?? 0
  else if (r.kind === 'input') value = r.initial ?? '0'
  else value = Array.from({ length: Math.min(n, Math.max(r.min ?? 0, r.kind === 'order' ? n : 1)) }, (_, i) => i)
  if (seen.requests[r.kind] <= 3) console.log(`  ? ${r.kind}: ${r.title} [${(r.options ?? []).slice(0, 4).map((o) => o.label).join(' / ')}] → ${JSON.stringify(value)}`)
  send({ cmd: 'answer', rid: r.rid, value })
}

createInterface({ input: child.stdout }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { console.log('NON-JSON:', line.slice(0, 200)); return }
  switch (m.type) {
    case 'ready':
      console.log(`ready in ${m.bootMs}ms`)
      send({ cmd: 'start', players: [
        { deck: mine, name: mode === 'human' ? 'You' : 'AI Mothman', ai: mode !== 'human' },
        { deck: theirs, name: 'AI Zada', ai: true }
      ] })
      break
    case 'started': console.log('match started'); break
    case 'state': {
      snapshots++
      last = m
      you = m.you
      if (m.phase) seen.phases.add(m.phase)
      seen.maxStack = Math.max(seen.maxStack, m.stack.length)
      if (snapshots % 25 === 1) console.log(summary(m))
      act(m)
      clearTimeout(idle)
      // An action sent a moment before Forge starts waiting for input is
      // dropped; if nothing changes for 2s, act again on the latest state.
      if (mode === 'human') idle = setTimeout(() => { lastPromptKey = ''; act(last) }, 2000)
      if (mode === 'human') {
        const mine = Object.values(m.cards).filter((c) => c.controller === m.you)
        if (mine.some((c) => c.playable)) goals.playableSeen = true
        if (mine.some((c) => c.land && c.zone === 'Battlefield')) goals.landPlayed = true
        if (mine.some((c) => !c.land && c.zone === 'Battlefield')) goals.spellResolved = true
        if (mine.some((c) => c.attacking)) goals.attacked = true
        if (Object.values(goals).every(Boolean) && !process.env.EXPECT_TOKENS) finish('all goals met')
        // Token check: once a token spell has resolved (it's in the graveyard), tokens must be on our battlefield.
        if (process.env.EXPECT_TOKENS) {
          const me = m.players.find((p) => p.id === m.you)
          const gy = (me?.zones.graveyard ?? []).map((id) => m.cards[id]?.name)
          const bf = (me?.zones.battlefield ?? []).map((id) => m.cards[id])
          const tokens = bf.filter((c) => c?.token)
          // Permanent spells don't go to the graveyard; also check for the creature itself.
          const sieges = bf.filter((c) => c?.name === 'Siege-Gang Commander' && !c.token)
          if (sieges.length && !tokenReported && m.stack.length === 0) {
            tokenReported = true
            // Give the ETB trigger time to go on the stack and resolve, then judge the latest board.
            setTimeout(() => {
              const mm = last
              const me2 = mm.players.find((p) => p.id === mm.you)
              const bf2 = (me2?.zones.battlefield ?? []).map((id) => mm.cards[id])
              const tk = bf2.filter((c) => c?.token)
              console.log('  log (siege):', JSON.stringify((mm.log ?? []).filter((l) => /Siege|Goblin|token/i.test(l.text)).map((l) => `${l.type}: ${l.text}`)))
              console.log(`  ★ 3s after Siege-Gang: phase ${mm.phase}, stack ${mm.stack.length} ${JSON.stringify(mm.stack.map((x) => x.text))}, prompt "${mm.prompt.message?.split(String.fromCharCode(10))[0]}", ${tk.length} tokens`)
              finish(tk.length ? 'tokens are in the snapshot' : 'NO TOKENS in snapshot')
            }, 3000)
          }
          if (gy.length && !tokenReported && !process.env.SIEGE) {
            tokenReported = true
            console.log('  log (last 6):', JSON.stringify((m.log ?? []).slice(-6).map((l) => `${l.type}: ${l.text}`)))
            console.log(`  ★ after resolving ${gy.join(', ')}: battlefield ${bf.length} cards, ${tokens.length} tokens; e.g. ${JSON.stringify(tokens[0] ?? null)}`)
            setTimeout(() => finish(tokens.length ? 'tokens are in the snapshot' : 'NO TOKENS in snapshot'), 300)
          }
        }
      } else if (m.turn >= 8) finish('AI game reached turn 8')
      break
    }
    case 'request': answer(m); break
    case 'gameOver': finish('gameOver'); break
    case 'error': console.log('ERROR', m.message); break
    case 'invalid': break
    case 'message': console.log(`  i ${m.title}: ${String(m.message).slice(0, 120)}`); break
    default: console.log('event', m.type)
  }
})

let idle = null
let tokenReported = false
let finished = false
function finish(why) {
  if (finished) return
  finished = true
  console.log(`\n== ${why} after ${Math.round((Date.now() - t0) / 1000)}s`)
  if (last) {
    console.log(summary(last))
    console.log('winner:', last.winner, '| snapshots:', snapshots, '| scripted actions:', actions)
    console.log('phases seen:', [...seen.phases].join(','), '| max stack depth:', seen.maxStack)
    console.log('requests answered:', JSON.stringify(seen.requests))
    const withSet = Object.values(last.cards).filter((c) => c.set).length
    console.log('cards in final snapshot:', Object.keys(last.cards).length, 'with printing:', withSet)
    const sample = Object.values(last.cards).filter((c) => c.set).slice(0, 3)
    for (const c of sample) console.log('  sample', JSON.stringify({ name: c.name, set: c.set, cn: c.cn, zone: c.zone, playable: c.playable }))
  }
  if (mode === 'human') console.log('goals:', JSON.stringify(goals))
  send({ cmd: 'quit' })
  setTimeout(() => { child.kill(); process.exit(0) }, 1500)
}
setTimeout(() => { console.log('stderr tail:\n' + stderrTail.join('\n')); finish('timeout') }, MAX_MS)
child.on('exit', (code) => { console.log('bridge exited', code); if (!last) console.log(stderrTail.join('\n')); process.exit(code ?? 1) })
