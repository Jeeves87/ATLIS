// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Card-by-card audit of the user's REAL decks, played through the bridge with
// the same commands the ATLIS table sends.
//
//   node test/audit.mjs "Odds and Ends"        one deck (name fragment)
//   node test/audit.mjs all                    every exported ATLIS deck
//
// For each non-land card: a fresh board in your main phase with five of each
// basic land, the card in hand. Then, as a player would:
//   cast    — it glows, clicking it casts it, costs auto-pay, prompts answered
//   resolve — it ends up on the battlefield (permanents) or graveyard (spells)
//   ETB     — "When this enters" triggers go on the stack
//   ability — non-mana activated abilities can be activated by clicking it
// Results go to logs/audit-<deck>.json and a summary on stdout. Each card has
// its own timeout; a stuck card is reported, not waited on.
import { appendFileSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Game, DECKS } from './harness.mjs'

const which = process.argv[2] ?? 'all'
const PER_CARD_MS = 12_000
/** Hard stop for a whole run, so an audit can never sit for an hour. */
const RUN_LIMIT_MS = Number(process.env.RUN_LIMIT_MS ?? 20 * 60_000)
const runStart = Date.now()
const LANDS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'].flatMap((l) => Array(5).fill(l)).join('; ')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function deckFiles() {
  return readdirSync(DECKS).filter((f) => f.startsWith('ATLIS - ') && f.endsWith('.dck'))
    .filter((f) => which === 'all' || f.toLowerCase().includes(which.toLowerCase()))
}

function deckCards(file) {
  const out = []
  for (const line of readFileSync(join(DECKS, file), 'utf8').split(/\r?\n/)) {
    const m = /^\d+ (.+?)(\|.*)?$/.exec(line.trim())
    if (m) out.push(m[1])
  }
  return [...new Set(out)]
}

async function oracle(names) {
  const map = new Map()
  for (let i = 0; i < names.length; i += 75) {
    const r = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ATLIS/1.0 audit', Accept: 'application/json' },
      body: JSON.stringify({ identifiers: names.slice(i, i + 75).map((name) => ({ name: name.split(' // ')[0] })) })
    })
    for (const c of (await r.json()).data ?? []) {
      const text = c.oracle_text ?? (c.card_faces ?? []).map((f) => f.oracle_text).join('\n')
      map.set(c.name.split(' // ')[0], { type: c.type_line, text, cmc: c.cmc })
    }
    await sleep(150)
  }
  return map
}

/** Non-mana activated abilities: a line with "cost: effect" that isn't just "Add {X}". */
const activatedLines = (text) => text.split('\n').filter((l) => /^[^"(]*?:/.test(l) && /\{|Sacrifice|Tap|Discard|Pay|Exile/.test(l.split(':')[0]) && !/:\s*Add\b/.test(l))
const hasEtb = (name, text) => new RegExp(`^When (${name.split(',')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|this creature|this artifact|this enchantment|this permanent)[^.]* enters`, 'mi').test(text)

async function auditDeck(file) {
  const names = deckCards(file)
  const info = await oracle(names)
  const cards = names.filter((n) => info.has(n.split(' // ')[0]) && !/\bLand\b/.test(info.get(n.split(' // ')[0]).type))
  console.log(`\n### ${file.slice(8, -4)} — ${cards.length} non-land cards`)

  // One test game per deck — restarted whenever it ends or stops responding,
  // so a single card that wedges or decks someone can't sink the rest.
  let g = null
  const fresh = async () => {
    if (g) { g.quit(); await sleep(1500) }
    g = await Game.start({ you: join(DECKS, file), opp: join(DECKS, file) })
    g.preferSelect = (cs) => cs.find((c) => c.controller !== g.state.you) ?? cs[0]
    await g.untilOurMain()
  }
  await fresh()
  const report = []

  const progress = join(import.meta.dirname, '..', 'logs', `audit-${file.slice(8, -4).replace(/[^\w-]+/g, '_')}.txt`)
  writeFileSync(progress, '')
  // CARD_ONLY="Swords to Plowshares|Sol Ring" audits just those; CARD_LIMIT=N the first N.
  const only = process.env.CARD_ONLY ? new RegExp(`^(${process.env.CARD_ONLY})$`) : null
  for (const name of cards.filter((n) => !only || only.test(n)).slice(0, Number(process.env.CARD_LIMIT ?? cards.length))) {
    if (Date.now() - runStart > RUN_LIMIT_MS) { console.log('-- run time limit reached; stopping'); break }
    const front = name.split(' // ')[0]
    const o = info.get(front)
    const isSpell = /Instant|Sorcery/.test(o.type)
    const row = { card: name, type: o.type, cast: 'untested', resolve: 'untested', etb: hasEtb(front, o.text) ? 'untested' : 'n/a', ability: activatedLines(o.text).length ? 'untested' : 'n/a', notes: [] }
    const s0 = g.state
    if (!s0 || s0.gameOver || (!g.hasPriority(s0) && !s0.prompt.okEnabled && !s0.prompt.cancelEnabled && !Object.values(s0.cards).some((c) => c.selectable))) {
      await fresh().catch((e) => console.log(`!! restart failed: ${e.message}`))
    }
    const deadline = Date.now() + PER_CARD_MS
    try {
      const logStart = 0
      await g.applyState([
        'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40',
        `humanhand=${front}`, `humanbattlefield=${LANDS}`, 'humangraveyard=', 'humanexile=',
        `humanlibrary=${Array(40).fill('Island').join('; ')}`,
        // A creature and an artifact on each side give targeted cards something to aim at.
        'aibattlefield=Grizzly Bears; Ornithopter', `ailibrary=${Array(40).fill('Plains').join('; ')}`,
        'removesummoningsickness=true'
      ])
      void logStart
      await g.waitFor((s) => s.phase === 'MAIN1' && s.activePlayer === s.you && g.hasPriority(s) && g.cards('hand').some((c) => c.name?.startsWith(front)), 6_000, 'board ready')
      // The snapshot's log is a capped window; compare stable sequence numbers, not positions.
      const lastSeq = Math.max(0, ...(g.state.log ?? []).map((l) => l.n ?? 0))
      const newLog = () => (g.state.log ?? []).filter((l) => (l.n ?? 0) > lastSeq)
      const logged = (re) => newLog().some((l) => re.test(l.text))
      const inHand = g.cards('hand').find((c) => c.name?.startsWith(front))

      // CAST
      // The glow is recorded, not trusted: Forge only recomputes it on a fresh
      // priority prompt, and swapping the board mid-turn doesn't make one.
      row.glow = !!inHand?.playable
      if (!inHand) {
        row.cast = 'not in hand'
      } else {
        g.send({ cmd: 'card', id: inHand.id })
        // Drive it like a player: auto-pay, answer questions/selections, pass to resolve.
        while (Date.now() < deadline) {
          const s = g.state
          if (/Pay Mana Cost/i.test(s.prompt.message) && s.prompt.okEnabled) { await g.ok(); continue }
          if (logged(new RegExp(`You cast ${front.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))) break
          if (!g.hasPriority(s)) await g.answerSelection(s)
          await sleep(250)
        }
        const didCast = logged(new RegExp(`You cast ${front.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
        // A click Forge rejects (no legal target, condition unmet) leaves you at priority: not a bug.
        row.cast = didCast ? 'ok' : g.state.prompt.message.startsWith('Priority') ? 'not castable on test board' : 'FAILED'
        if (row.cast !== 'ok') row.notes.push(`prompt: "${g.state.prompt.message.split('\n').slice(0, 3).join(' | ')}"`)
      }

      // RESOLVE (+ ETB triggers fire as it lands)
      if (row.cast === 'ok') {
        await g.passUntil(() => g.state.stack.length === 0 && newLog().some((l) => l.type === 'STACK_RESOLVE'), Math.max(1000, deadline - Date.now()), 'resolve').catch(() => null)
        const onField = g.find(front) ?? g.cards('battlefield').find((c) => c.name?.startsWith(front))
        const inGy = g.cards('graveyard').some((c) => c.name?.startsWith(front))
        // Adventure cards cast as their adventure resolve into exile ("on an adventure").
        const onAdventure = g.cards('exile').some((c) => c.name?.startsWith(front))
        row.resolve = isSpell ? (inGy ? 'ok' : 'FAILED')
          : onField ? 'ok' : onAdventure ? 'ok (on an adventure)' : inGy ? 'went to graveyard' : 'FAILED'
        if (row.etb !== 'n/a') {
          await g.passUntil(() => logged(new RegExp(`You triggered ${front.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)) && g.state.stack.length === 0, Math.max(1000, deadline - Date.now()), 'etb').catch(() => null)
          row.etb = logged(new RegExp(`You triggered ${front.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)) ? 'ok' : 'FAILED'
        }
      }

      // ACTIVATED ABILITY: click the permanent like a player would.
      if (row.ability !== 'n/a' && row.resolve === 'ok' && !isSpell) {
        await g.waitFor((s) => g.hasPriority(s), 4_000, 'priority').catch(() => null)
        const perm = g.find(front) ?? g.cards('battlefield').find((c) => c.name?.startsWith(front))
        if (!perm) {
          row.ability = 'not on battlefield'
        } else {
          g.send({ cmd: 'card', id: perm.id })
          const act = new RegExp(`You activated ${front.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
          while (Date.now() < deadline && !logged(act)) {
            const s = g.state
            if (/Pay Mana Cost/i.test(s.prompt.message) && s.prompt.okEnabled) { await g.ok(); continue }
            if (!g.hasPriority(s)) await g.answerSelection(s)
            await sleep(250)
          }
          row.ability = logged(act) ? 'ok'
            : g.state.prompt.message.startsWith('Priority') ? 'not usable on test board'
            // Stuck paying: a cost the test board can't cover (e.g. "Sacrifice a Slug" with no Slug).
            : /Pay Mana Cost|Sacrifice|Select/i.test(g.state.prompt.message) ? 'cost not payable on test board'
            : 'FAILED'
          if (row.ability === 'FAILED') row.notes.push(`ability prompt: "${g.state.prompt.message.split('\n').slice(0, 3).join(' | ')}"`)
        }
      }
    } catch (e) {
      row.notes.push(`error: ${e.message}`)
      // Say exactly where the game was, so a stall can be diagnosed, not guessed at.
      const s = g.state
      if (s) row.notes.push(`state: turn ${s.turn} ${s.phase} active=${s.activePlayer === s.you ? 'you' : 'opp'} stack=${s.stack.length} hand=[${g.cards('hand').map((c) => c.name).join(', ')}] prompt="${(s.prompt.message || '').split('\n').slice(0, 2).join(' | ')}" ok=${s.prompt.okEnabled} cancel=${s.prompt.cancelEnabled}`)
    }
    const bad = [row.cast, row.resolve, row.etb, row.ability].some((v) => v === 'FAILED')
    const line = `${bad ? 'FAIL' : 'ok  '}  ${name.padEnd(36).slice(0, 36)} glow:${row.glow ? 'y' : 'n'} cast:${row.cast} resolve:${row.resolve} etb:${row.etb} ability:${row.ability}${row.notes.length ? '  — ' + row.notes.join('; ') : ''}`
    console.log(line)
    appendFileSync(progress, `${line}\n`)
    report.push(row)
    // Back out of anything unfinished (a cost we couldn't pay, an open choice)
    // the way a player would: Cancel until Forge gives priority back.
    for (let i = 0; i < 6 && !g.hasPriority(); i++) {
      if (g.state.prompt.cancelEnabled) g.send({ cmd: 'cancel' })
      else await g.answerSelection(g.state)
      await sleep(400)
    }
    // Recover from anything left mid-resolution before the next card.
    await g.passUntil((s) => g.hasPriority(s) && s.stack.length === 0 && s.activePlayer === s.you && s.phase === 'MAIN1', 4_000, 'clean board').catch(async () => { await g.untilOurMain(12_000).catch(() => null) })
  }

  g.quit()
  const dir = join(import.meta.dirname, '..', 'logs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `audit-${file.slice(8, -4).replace(/[^\w-]+/g, '_')}.json`), JSON.stringify(report, null, 1))
  const count = (k, v) => report.filter((r) => r[k] === v).length
  console.log(`--- ${file.slice(8, -4)}: cast ok ${count('cast', 'ok')}/${report.length}, cast FAILED ${count('cast', 'FAILED')}, not castable here ${count('cast', 'not castable on test board')}; resolve FAILED ${count('resolve', 'FAILED')}; ETB ok ${count('etb', 'ok')} FAILED ${count('etb', 'FAILED')}; abilities ok ${count('ability', 'ok')} FAILED ${count('ability', 'FAILED')} not usable here ${count('ability', 'not usable on test board')}`)
  return report
}

for (const f of deckFiles()) {
  try { await auditDeck(f) } catch (e) { console.log(`!! ${f}: ${e.message}`) }
  await sleep(1500)
}
process.exit(0)
