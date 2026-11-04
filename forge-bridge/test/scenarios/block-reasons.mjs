// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Fliers and ground attackers together: the snapshot
// must say so per blocker, so ATLIS can explain the refusal instead of just
// shaking. Each of your creatures lists exactly the attackers it may block:
// the ground ones, never the fliers.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 115_000)
const pause = (ms = 600) => new Promise((r) => setTimeout(r, ms))
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=ai', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=', 'aihand=',
    'humanbattlefield=Grizzly Bears; Grizzly Bears; Giant Spider',
    'aibattlefield=Craw Wurm; Craw Wurm; Serra Angel; Serra Angel; Wind Drake',
    `humanlibrary=${Array(20).fill('Forest').join('; ')}`, `ailibrary=${Array(20).fill('Island').join('; ')}`, 'removesummoningsickness=true'
  ])
  await g.passUntil((s) => s.phase === 'COMBAT_DECLARE_BLOCKERS' && !/^Priority/m.test(s.prompt.message) && /block/i.test(s.prompt.message), 40_000, 'block prompt')
  const atMe = g.state.combat.filter((c) => c.defender === g.state.you).map((c) => g.state.cards[c.attacker])
  const fliers = atMe.filter((c) => /Wind Drake|Serra Angel/.test(c.name)).map((c) => c.id)
  const ground = atMe.filter((c) => !/Wind Drake|Serra Angel/.test(c.name)).map((c) => c.id)
  g.check('the AI attacks with at least one flier', fliers.length >= 1, JSON.stringify(atMe.map((c) => c.name)))

  const bears = g.cards('battlefield').filter((c) => c.name === 'Grizzly Bears')
  g.check('each blocker carries a list of attackers it may block', bears.every((c) => Array.isArray(c.blocks)), JSON.stringify(bears.map((c) => c.blocks)))
  g.check('a bear may block every ground attacker', bears.every((c) => ground.every((id) => c.blocks.includes(id))), JSON.stringify({ ground, blocks: bears[0]?.blocks }))
  g.check('a bear may block none of the fliers', bears.every((c) => fliers.every((id) => !c.blocks.includes(id))), JSON.stringify({ fliers, blocks: bears[0]?.blocks }))
  const spider = g.cards('battlefield').find((c) => c.name === 'Giant Spider')
  g.check('Giant Spider (reach) may block the fliers too', !!spider && fliers.every((id) => spider.blocks?.includes(id)), JSON.stringify(spider?.blocks))
  g.check('the flier carries "Flying" in its text, for the explanation', fliers.every((id) => /\bFlying\b/.test(g.state.cards[id].text ?? '')), g.state.cards[fliers[0]]?.text)
  await pause()
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
