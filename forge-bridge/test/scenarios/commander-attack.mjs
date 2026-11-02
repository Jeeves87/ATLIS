// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Your commander, cast from the command zone and attacking, must show as
// tapped + attacking (it used to look untapped: a stale commander view won).
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Tramplesaurus/), opp: deck(/Mutant Menace/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 110_000)
try {
  await g.untilOurMain()
  const name = g.state.cards[g.me.commanders[0]]?.name
  // applyState wipes commanders, so re-declare ours in the command zone.
  await g.applyState([
    `humancommand=${name}|IsCommander`,
    'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=',
    `humanbattlefield=${Array(14).fill('Forest').join('; ')}`,
    `humanlibrary=${Array(30).fill('Forest').join('; ')}`, `ailibrary=${Array(30).fill('Island').join('; ')}`,
    'aibattlefield=', 'removesummoningsickness=true'
  ])
  await g.waitFor((s) => g.hasPriority(s) && s.activePlayer === s.you && s.phase === 'MAIN1', 10_000, 'main')
  const cmdId = g.me.commanders[0]
  g.send({ cmd: 'card', id: cmdId })
  await g.waitFor((s) => /Pay Mana Cost/i.test(s.prompt.message), 6_000, 'pay').catch(() => null)
  if (/Pay Mana Cost/i.test(g.state.prompt.message)) await g.ok()
  await g.passUntil((s) => g.find(name) && s.stack.length === 0, 15_000, 'commander resolves')
  g.check(`${name} cast from the command zone`, !!g.find(name))

  // Next turn of ours: it can attack.
  await g.passUntil((s) => s.activePlayer === s.you && /creatures to attack/i.test(s.prompt.message), 60_000, 'our next attack step')
  await g.click(name)
  await g.ok()
  await g.waitFor(() => !!g.find(name)?.attacking, 8_000, 'attacking').catch(() => null)
  const c = g.find(name)
  g.check('commander shows ATTACKING', !!c?.attacking)
  g.check('commander shows TAPPED', !!c?.tapped, JSON.stringify({ tapped: c?.tapped, attacking: c?.attacking }))
  const att = g.state.combat.find((x) => x.attacker === c?.id)
  g.check('combat lists the commander attacking the opponent', !!att && att.defenderIsPlayer)
} catch (e) {
  g.check(`error: ${e.message}`, false)
  console.log('prompt:', JSON.stringify(g.state?.prompt), '\ncommanders:', JSON.stringify(g.me?.commanders?.map((id) => g.state.cards[id])), '\nlog:', JSON.stringify(g.recentLog(6)))
} finally {
  clearTimeout(t)
  const failed = g.results.filter((r) => !r.ok).length
  console.log(`${g.results.length - failed}/${g.results.length} checks passed`)
  g.quit()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}
