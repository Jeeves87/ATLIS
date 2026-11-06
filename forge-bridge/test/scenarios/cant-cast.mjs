// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Rule of Law (on the AI's side): "Each player can't cast more than one spell
// each turn." Before your first spell nothing in hand is stopped; after it,
// every card in hand reports Rule of Law in `cantCast`, so the table can say
// why it won't cast instead of just refusing.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Mutant Menace/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 100_000)
const pause = (ms = 800) => new Promise((r) => setTimeout(r, ms))
const why = (c) => (c?.cantCast ?? []).map((b) => b.name)
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'aihand=',
    'aibattlefield=Rule of Law', 'humanhand=Grizzly Bears; Llanowar Elves',
    `humanbattlefield=${Array(6).fill('Forest').join('; ')}`,
    `humanlibrary=${Array(20).fill('Forest').join('; ')}`, `ailibrary=${Array(20).fill('Island').join('; ')}`
  ])
  await pause()
  g.check('before any spell, nothing in hand is stopped', g.cards('hand').every((c) => !c.cantCast), JSON.stringify(g.cards('hand').map((c) => [c.name, why(c)])))
  await g.click('Grizzly Bears', 'hand'); await pause()
  if (/Pay Mana Cost/i.test(g.state.prompt.message)) { await g.ok(); await pause() }
  await g.passUntil(() => !!g.find('Grizzly Bears'), 10_000, 'Bears resolve')
  await pause()
  const elves = g.cards('hand').find((c) => c.name === 'Llanowar Elves')
  console.log('elves:', JSON.stringify({ playable: elves?.playable, cantCast: elves?.cantCast }))
  g.check('after one spell, Elves is stopped by Rule of Law', why(elves).includes('Rule of Law'), JSON.stringify(elves?.cantCast))
  g.check('the reason carries the rule text', /one spell each turn/i.test(elves?.cantCast?.[0]?.text ?? ''), elves?.cantCast?.[0]?.text)
  // Forge still flags it playable (its highlight scan ignores this rule), so the table trusts cantCast.
  g.check('Elves sits in the Hand zone, where the table checks cantCast', elves?.zone === 'Hand', String(elves?.zone))
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
