// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// A creature that must attack (goad, "attacks each combat if able"): Forge
// rejects any declaration without it ("Attack declaration invalid"), even
// "no attackers". The snapshot must flag it so ATLIS can say why.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 110_000)
const pause = (ms = 800) => new Promise((r) => setTimeout(r, ms))
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=', 'aibattlefield=',
    'humanbattlefield=Bloodrock Cyclops; Grizzly Bears',
    `humanlibrary=${Array(20).fill('Mountain').join('; ')}`, `ailibrary=${Array(20).fill('Plains').join('; ')}`
  ])
  await g.waitFor((s) => g.hasPriority(s) && s.phase === 'MAIN1' && s.activePlayer === s.you, 10_000, 'main')
  g.send({ cmd: 'ok' })
  await g.waitFor((s) => s.phase === 'COMBAT_DECLARE_ATTACKERS' && /attack/i.test(s.prompt.message), 10_000, 'declare attackers')
  const cyc = g.find('Bloodrock Cyclops'), bears = g.find('Grizzly Bears')
  g.check('Cyclops flagged mustAttack', cyc?.mustAttack === true, JSON.stringify({ can: cyc?.canAttack, must: cyc?.mustAttack }))
  g.check('Bears not flagged', !bears?.mustAttack, JSON.stringify({ can: bears?.canAttack, must: bears?.mustAttack }))

  const messages = []
  const orig = g.onLine.bind(g)
  g.onLine = (line) => { if (/"type":"message"/.test(line)) messages.push(JSON.parse(line).message); orig(line) }
  g.send({ cmd: 'ok' })
  await pause(1200)
  g.check('no attackers is rejected', messages.some((m) => /Attack declaration invalid/i.test(m)) && g.state.phase === 'COMBAT_DECLARE_ATTACKERS', JSON.stringify({ messages, phase: g.state.phase }))

  g.send({ cmd: 'card', id: cyc.id })
  await pause()
  g.check('flag clears once it attacks (stays mustAttack, now attacking)', !!g.find('Bloodrock Cyclops')?.attacking)
  messages.length = 0
  g.send({ cmd: 'ok' })
  // Accepted: Forge moves on to priority in the declare-attackers step.
  await g.waitFor((s) => g.hasPriority(s) || s.phase !== 'COMBAT_DECLARE_ATTACKERS', 10_000, 'attack accepted')
  g.check('attack with the Cyclops is accepted', !messages.length, JSON.stringify(messages))
} catch (e) {
  g.check(`error: ${e.message}`, false)
  console.log('prompt:', JSON.stringify(g.state?.prompt))
} finally {
  clearTimeout(t)
  const failed = g.results.filter((r) => !r.ok).length
  console.log(`${g.results.length - failed}/${g.results.length} checks passed`)
  g.quit()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}
