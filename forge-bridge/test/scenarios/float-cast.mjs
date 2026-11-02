// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Casting with mana already floating in your pool (Mana Geyser, tapped lands):
// a spell with a generic part ({3}{R}) must be castable from the pool alone,
// not just one whose cost is all colored ({R}).
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 110_000)
const pause = (ms = 700) => new Promise((r) => setTimeout(r, ms))
const pool = () => g.me.mana.R
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40',
    'humanhand=Siege-Gang Lieutenant; Goblin Dark-Dwellers; Gempalm Incinerator',
    `humanbattlefield=${Array(9).fill('Mountain').join('; ')}`, 'aibattlefield=',
    `humanlibrary=${Array(20).fill('Mountain').join('; ')}`, `ailibrary=${Array(20).fill('Plains').join('; ')}`
  ])
  await g.waitFor((s) => g.hasPriority(s) && s.phase === 'MAIN1' && s.activePlayer === s.you, 10_000, 'main')
  // Float the mana first, like Mana Geyser does.
  for (const m of g.cards('battlefield').filter((c) => c.name === 'Mountain')) { g.send({ cmd: 'card', id: m.id }); await pause(250) }
  await pause()
  g.check('9 red floating', pool() === 9, JSON.stringify(g.me.mana))
  const hand = Object.fromEntries(g.cards('hand').map((c) => [c.name, c]))
  g.check('Lieutenant glows as castable', !!hand['Siege-Gang Lieutenant']?.playable, JSON.stringify(hand['Siege-Gang Lieutenant']))

  const events = []
  const orig = g.onLine.bind(g)
  g.onLine = (line) => { if (/"type":"(invalid|request)"/.test(line)) events.push(line.slice(0, 300)); orig(line) }
  g.send({ cmd: 'card', id: hand['Siege-Gang Lieutenant'].id })
  await pause(1500)
  console.log('after click — prompt:', JSON.stringify(g.state.prompt), '\nevents:', events, '\npool:', JSON.stringify(g.me.mana), 'stack:', JSON.stringify(g.state.stack))
  g.check('Forge stops to ask for the cost (it won\'t take pool mana for {3} itself)', /Pay Mana Cost: \{3\}\{R\}/.test(g.state.prompt.message))
  // What ATLIS does with one color floating: one red per update until paid.
  for (let i = 0; i < 8 && /Pay Mana Cost/.test(g.state.prompt.message); i++) { g.send({ cmd: 'mana', color: 8 }); await pause(600) }
  g.check('Lieutenant is on the stack, paid from the pool (9 → 5)', g.state.stack.length > 0 && pool() === 5, JSON.stringify({ pool: g.me.mana, stack: g.state.stack.length, prompt: g.state.prompt.message }))
  await g.passUntil((s) => s.stack.length === 0, 10_000, 'resolves')
  g.check('Siege-Gang Lieutenant resolves onto the battlefield', !!g.find('Siege-Gang Lieutenant'))

  // Same for the 5-drop.
  g.send({ cmd: 'card', id: g.cards('hand').find((c) => c.name === 'Goblin Dark-Dwellers').id })
  await pause(1000)
  for (let i = 0; i < 8 && /Pay Mana Cost/.test(g.state.prompt.message); i++) { g.send({ cmd: 'mana', color: 8 }); await pause(600) }
  g.check('Goblin Dark-Dwellers cast from the last 5 red', g.state.stack.length > 0 && pool() === 0, JSON.stringify({ pool: g.me.mana, prompt: g.state.prompt.message }))
} catch (e) {
  g.check(`error: ${e.message}`, false)
  console.log('prompt:', JSON.stringify(g.state?.prompt), '\nlog:', JSON.stringify(g.recentLog(8)))
} finally {
  clearTimeout(t)
  const failed = g.results.filter((r) => !r.ok).length
  console.log(`${g.results.length - failed}/${g.results.length} checks passed`)
  g.quit()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}
