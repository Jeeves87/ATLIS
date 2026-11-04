// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Birthing Pod: {1}{G/P}, {T}, sacrifice a creature. The {G/P} is Phyrexian
// mana — payable with green OR 2 life. Walks both payments and records what
// Forge says at each step, so the table can follow along.
//   MODE=life  → pay the {G/P} with 2 life (click yourself), {1} with a Forest
//   MODE=green → pay everything with Forests
import { Game, deck } from '../harness.mjs'

const MODE = process.env.MODE ?? 'life'
const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 115_000)
const pause = (ms = 700) => new Promise((r) => setTimeout(r, ms))
const show = (label) => {
  const s = g.state
  const forests = g.cards('battlefield').filter((c) => c.name === 'Forest')
  console.log(`  [${label}] prompt=${JSON.stringify(s.prompt.message)} life=${g.me.life} pool=${JSON.stringify(g.me.mana)} untappedForests=${forests.filter((c) => !c.tapped).length} stack=${s.stack.length}`)
}
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=', 'aihand=', 'aibattlefield=',
    'humanbattlefield=Birthing Pod; Forest; Forest; Forest; Grizzly Bears',
    `humanlibrary=Centaur Courser; ${Array(20).fill('Forest').join('; ')}`, `ailibrary=${Array(20).fill('Mountain').join('; ')}`, 'removesummoningsickness=true'
  ])
  await pause()
  show('start')
  await g.click('Birthing Pod'); await pause()
  show('after clicking Pod')
  // Sacrifice choice: pick the Bears if Forge asks in-table.
  for (let i = 0; i < 3 && !/Pay Mana Cost/i.test(g.state.prompt.message); i++) {
    const bears = g.find('Grizzly Bears')
    if (bears?.selectable) { g.send({ cmd: 'card', id: bears.id }); await pause(); show('after picking Bears') }
    if (g.state.prompt.okEnabled && !/Pay Mana Cost/i.test(g.state.prompt.message) && !g.hasPriority()) { await g.ok(); await pause(); show('after OK') }
  }
  g.check('Forge asks for the mana', /Pay Mana Cost/i.test(g.state.prompt.message), g.state.prompt.message)

  if (MODE === 'life') {
    g.send({ cmd: 'player', id: g.state.you }); await pause()
    show('after clicking yourself')
  }
  for (let i = 0; i < 3 && /Pay Mana Cost/i.test(g.state.prompt.message); i++) {
    const f = g.cards('battlefield').find((c) => c.name === 'Forest' && !c.tapped)
    if (!f) break
    g.send({ cmd: 'card', id: f.id }); await pause()
    show(`after tapping Forest ${i + 1}`)
  }
  // Then Forge asks which creature to sacrifice.
  for (let i = 0; i < 3 && !g.state.stack.length; i++) {
    const bears = g.find('Grizzly Bears')
    if (bears?.selectable) { g.send({ cmd: 'card', id: bears.id }); await pause() }
    if (!g.state.stack.length && g.state.prompt.okEnabled && !g.hasPriority()) { await g.ok(); await pause() }
  }
  show('after sacrificing')
  const tapped = g.cards('battlefield').filter((c) => c.name === 'Forest' && c.tapped).length
  g.check('the ability is paid and on the stack', g.state.stack.length > 0 || g.logHas(/Birthing Pod/), JSON.stringify(g.state.stack.map((x) => x.text?.slice?.(0, 60))))
  if (MODE === 'life') {
    g.check('paid 2 life for {G/P}', g.me.life === 38, String(g.me.life))
    g.check('tapped exactly one Forest, for {1}', tapped === 1, String(tapped))
  } else {
    g.check('paid no life', g.me.life === 40, String(g.me.life))
    g.check('tapped two Forests', tapped === 2, String(tapped))
  }
  console.log('requests:', JSON.stringify(g.requests.map((r) => [r.kind, r.title?.split('\n')[0]])))
  console.log('log:', JSON.stringify(g.recentLog(6)))
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
