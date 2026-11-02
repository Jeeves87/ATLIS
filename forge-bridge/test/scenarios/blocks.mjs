// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Declaring blocks against several attackers: each of your creatures can block
// a different attacker, and the snapshot's combat must show every block AS you
// assign it (it used to stay empty until blocks were final — the view's combat
// only refreshes when Forge's desktop client redraws). Click order matches
// what ATLIS sends: the attacker, then the creature blocking it.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 115_000)
const pause = (ms = 600) => new Promise((r) => setTimeout(r, ms))
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=ai', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=', 'aihand=',
    'humanbattlefield=Goblin Piker; Goblin Piker; Goblin Piker', 'aibattlefield=Hill Giant; Hill Giant; Hill Giant',
    `humanlibrary=${Array(20).fill('Mountain').join('; ')}`, `ailibrary=${Array(20).fill('Mountain').join('; ')}`, 'removesummoningsickness=true'
  ])
  await g.passUntil((s) => s.phase === 'COMBAT_DECLARE_BLOCKERS' && !/^Priority/m.test(s.prompt.message) && /block/i.test(s.prompt.message), 40_000, 'block prompt')
  const atMe = g.state.combat.filter((c) => c.defender === g.state.you)
  g.check('the AI attacks with more than one creature', atMe.length >= 2, JSON.stringify(atMe))
  const pikers = g.cards('battlefield').filter((c) => c.name === 'Goblin Piker')
  g.check('your creatures are marked as able to block', pikers.every((c) => c.canBlock))

  const [a, b] = atMe.map((c) => c.attacker)
  const blockersOf = (att) => g.state.combat.find((c) => c.attacker === att)?.blockers ?? []
  g.send({ cmd: 'card', id: a }); await pause(); g.send({ cmd: 'card', id: pikers[0].id }); await pause()
  g.check('block 1 shows in combat while declaring', blockersOf(a).includes(pikers[0].id), JSON.stringify(g.state.combat))
  g.send({ cmd: 'card', id: b }); await pause(); g.send({ cmd: 'card', id: pikers[1].id }); await pause()
  g.check('block 2 goes on a DIFFERENT attacker', blockersOf(b).includes(pikers[1].id) && blockersOf(a).includes(pikers[0].id), JSON.stringify(g.state.combat))
  g.check('blockers show BLK', !!g.state.cards[pikers[0].id]?.blocking && !!g.state.cards[pikers[1].id]?.blocking)

  // Undo block 1 (its attacker, then the blocker again), then put it back.
  g.send({ cmd: 'card', id: a }); await pause(); g.send({ cmd: 'card', id: pikers[0].id }); await pause()
  g.check('clicking a blocker again takes the block back', !blockersOf(a).includes(pikers[0].id) && blockersOf(b).includes(pikers[1].id), JSON.stringify(g.state.combat))
  g.send({ cmd: 'card', id: a }); await pause(); g.send({ cmd: 'card', id: pikers[0].id }); await pause()

  await g.ok()
  // Two Pikers blocked two Giants and died; only the third Giant's 3 got through.
  await g.passUntil((s) => s.players.find((p) => p.id === s.you).life < 40, 20_000, 'combat damage').catch(() => null)
  const left = g.cards('battlefield').filter((c) => c.name === 'Goblin Piker').map((c) => c.id)
  g.check('both blocks stood: the two blockers died, the third Piker lives', left.length === 1 && left[0] === pikers[2].id, JSON.stringify(left))
  g.check('only the unblocked Giant hit you (40 → 37)', g.me.life === 37, String(g.me.life))
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
