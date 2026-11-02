// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Inniaz, the Gale Force (Odds and Ends) — both abilities, played the way the
// user plays them at the ATLIS table.
//   - Attack trigger: "Whenever three or more creatures you control with flying
//     attack, each player gains control of a nonland permanent of your choice
//     controlled by the player to their right."
//   - Pump: "{2}{W/U}: Attacking creatures with flying get +1/+1 until end of turn."
import { Game, deck } from '../harness.mjs'

const FLYERS = ['Inniaz, the Gale Force', 'Vega, the Watcher', 'Thief of Sanity', 'Breena, the Demagogue']

const g = await Game.start({ you: deck(/Odds and Ends/), opp: deck(/Goblin Storm/) })
const t0 = Date.now()
const timeout = setTimeout(() => { console.log('FAIL  scenario timed out'); g.quit(); process.exit(1) }, 110_000)
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human',
    'activephase=MAIN1',
    'humanlife=40',
    'ailife=40',
    'humanhand=',
    `humanbattlefield=${FLYERS.join('; ')}; Plains; Plains; Plains; Island; Island; Island`,
    'aibattlefield=Mountain; Mountain; Goblin Lackey',
    // Both libraries need cards, or the next draw ends the game.
    'humanlibrary=Island; Island; Island; Island; Island; Island; Island; Island; Island; Island',
    'ailibrary=Mountain; Mountain; Mountain; Mountain; Mountain; Mountain; Mountain; Mountain; Mountain; Mountain',
    'removesummoningsickness=true'
  ])
  // The control swap asks you to pick permanents; give away anything but Inniaz (the pump needs it).
  g.preferSelect = (cards) => cards.find((c) => c.name !== 'Inniaz, the Gale Force') ?? cards[0]
  await g.waitFor((s) => s.phase === 'MAIN1' && s.activePlayer === s.you, 10_000, 'our main phase')
  g.check('board set up with your real cards', FLYERS.every((n) => g.find(n)), FLYERS.filter((n) => !g.find(n)).join(', '))

  // To combat: pass priority until Forge asks for attackers.
  await g.passUntil((s) => /creatures to attack/i.test(s.prompt.message), 20_000, 'attack prompt')
  const canAttack = g.cards('battlefield').filter((c) => c.canAttack).map((c) => c.name)
  g.check('all four flyers offered as attackers', FLYERS.every((n) => canAttack.includes(n)), canAttack.join(', '))

  // Declare all four flyers, exactly as clicking them at the table does.
  for (const n of FLYERS) await g.click(n)
  await g.ok()
  await g.waitFor((s) => g.cards('battlefield').filter((c) => c.attacking).length >= 3, 10_000, 'attackers declared')
  g.check('four flyers attacking', g.cards('battlefield').filter((c) => c.attacking).length === 4)

  // The 3+ flyers trigger must go on the stack and resolve (it asks for choices; the harness answers).
  await g.waitFor(() => g.logHas(/You triggered Inniaz/), 10_000, 'Inniaz trigger').catch(() => null)
  g.check('attack trigger fired', g.logHas(/You triggered Inniaz/))
  // Resolve it — but stop the moment it has, so we keep the post-attack priority window for the pump.
  const resolved = () => g.logHas(/^Whenever three or more creatures you control with flying attack/) && !g.state.stack.length
  await g.passUntil(resolved, 15_000, 'trigger resolution').catch(() => null)
  g.check('attack trigger resolved (control swap)', resolved(), g.selections.map((x) => `asked "${x.message.split('\n')[0]}" → picked from ${x.selectable.length}`).join('; '))

  // Pump: while they're attacking, activate Inniaz and pay with Auto.
  await g.waitFor((s) => g.hasPriority(s) && /^COMBAT_/.test(s.phase ?? ''), 15_000, 'priority in combat').catch(() => null)
  g.check('you get priority during combat, after attacking (to use the pump)', g.hasPriority() && /^COMBAT_/.test(g.state.phase ?? ''), `phase ${g.state.phase}, prompt "${g.state.prompt.message.split('\n')[0]}"`)
  const before = Object.fromEntries(g.cards('battlefield').filter((c) => c.attacking).map((c) => [c.name, c.power]))
  const inniaz = g.find('Inniaz, the Gale Force')
  g.check('Inniaz shows as usable (green glow)', !!inniaz?.playable)
  await g.click('Inniaz, the Gale Force')
  await g.waitFor((s) => /Pay Mana Cost/i.test(s.prompt.message), 6_000, 'mana payment prompt').catch(() => null)
  g.check('clicking Inniaz asks to pay {2}{W/U}', g.promptIs(/Pay Mana Cost/i), `prompt "${g.state.prompt.message.split('\n')[0]}"`)
  await g.ok() // Auto-pay
  await g.waitFor(() => g.logHas(/You activated Inniaz/), 6_000, 'activation').catch(() => null)
  g.check('pump activated', g.logHas(/You activated Inniaz/))
  await g.passUntil(() => !g.state.stack.length && g.logHas(/Attacking creatures with flying get \+1\/\+1/), 10_000, 'pump resolves').catch(() => null)
  const after = Object.fromEntries(g.cards('battlefield').filter((c) => c.attacking).map((c) => [c.name, c.power]))
  const pumped = Object.keys(before).filter((n) => after[n] === before[n] + 1)
  g.check('every attacking flyer got +1/+1', Object.keys(before).length > 0 && pumped.length === Object.keys(before).length, `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`)

  console.log('\nselection prompts (as the dock shows them):', JSON.stringify(g.selections, null, 1))
  console.log('\nlog:', JSON.stringify(g.recentLog(14), null, 1))
} catch (e) {
  g.check(`scenario error: ${e.message}`, false)
  console.log('log:', JSON.stringify(g.recentLog(14), null, 1))
  console.log('prompt:', g.state?.prompt?.message)
} finally {
  clearTimeout(timeout)
  const failed = g.results.filter((r) => !r.ok).length
  console.log(`\n${g.results.length - failed}/${g.results.length} checks passed in ${Math.round((Date.now() - t0) / 1000)}s`)
  g.quit()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}
