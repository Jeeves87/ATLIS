// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// A swarm blocking a swarm: six attackers, six blockers. Every one of your
// creatures must be able to block, one per attacker, and the snapshot must
// keep showing each of them as blockable while you declare (a report had the
// fourth and later blocks refused). Click order matches what ATLIS sends: the
// attacker, then the creature blocking it.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 115_000)
const pause = (ms = 600) => new Promise((r) => setTimeout(r, ms))
const SIX = (name) => Array(6).fill(name).join('; ')
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=ai', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=', 'aihand=',
    `humanbattlefield=${SIX('Grizzly Bears')}`, `aibattlefield=${SIX('Hill Giant')}`,
    `humanlibrary=${Array(20).fill('Forest').join('; ')}`, `ailibrary=${Array(20).fill('Mountain').join('; ')}`, 'removesummoningsickness=true'
  ])
  await g.passUntil((s) => s.phase === 'COMBAT_DECLARE_BLOCKERS' && !/^Priority/m.test(s.prompt.message) && /block/i.test(s.prompt.message), 40_000, 'block prompt')
  const atMe = g.state.combat.filter((c) => c.defender === g.state.you).map((c) => c.attacker)
  g.check('the AI swings with at least four creatures', atMe.length >= 4, String(atMe.length))
  const bears = () => g.cards('battlefield').filter((c) => c.name === 'Grizzly Bears')
  const ids = bears().map((c) => c.id)
  const blockersOf = (att) => g.state.combat.find((c) => c.attacker === att)?.blockers ?? []

  for (let i = 0; i < atMe.length; i++) {
    const free = bears().filter((c) => !c.blocking)
    g.check(`before block ${i + 1}: the ${free.length} unassigned bears are all marked able to block`, free.every((c) => c.canBlock), JSON.stringify(free.map((c) => [c.id, c.canBlock])))
    g.send({ cmd: 'card', id: atMe[i] }); await pause()
    g.send({ cmd: 'card', id: ids[i] }); await pause()
    g.check(`block ${i + 1} lands on attacker ${i + 1}`, blockersOf(atMe[i]).includes(ids[i]), `prompt=${JSON.stringify(g.state.prompt.message)} combat=${JSON.stringify(g.state.combat)}`)
  }
  const total = g.state.combat.reduce((a, c) => a + c.blockers.length, 0)
  g.check(`all ${atMe.length} blocks are declared at once`, total === atMe.length, String(total))
  await g.ok()
  await pause(2000)
  g.check('every attacker was blocked, so no damage got through', g.me.life === 40, String(g.me.life))
} catch (e) {
  g.check(`error: ${e.message}`, false)
  console.log('prompt:', JSON.stringify(g.state?.prompt), '\ncombat:', JSON.stringify(g.state?.combat), '\nlog:', JSON.stringify(g.recentLog(8)))
} finally {
  clearTimeout(t)
  const failed = g.results.filter((r) => !r.ok).length
  console.log(`${g.results.length - failed}/${g.results.length} checks passed`)
  g.quit()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}
