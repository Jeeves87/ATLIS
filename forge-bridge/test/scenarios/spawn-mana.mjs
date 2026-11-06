// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Eldrazi Spawn tokens: "Sacrifice this creature: Add {C}." Clicking one in
// main 1 must sacrifice it and put {C} in your pool; paying a cost with one
// must work too.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Mutant Menace/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 100_000)
const pause = (ms = 800) => new Promise((r) => setTimeout(r, ms))
const spawns = () => g.cards('battlefield').filter((c) => /Spawn/i.test(c.name))
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'aihand=', 'aibattlefield=',
    'humanhand=Nest Invader; Grizzly Bears',
    'humanbattlefield=Forest; Forest; Forest',
    `humanlibrary=${Array(20).fill('Forest').join('; ')}`, `ailibrary=${Array(20).fill('Island').join('; ')}`, 'removesummoningsickness=true'
  ])
  await pause()
  await g.click('Nest Invader', 'hand'); await pause()
  if (/Pay Mana Cost/i.test(g.state.prompt.message)) { await g.ok(); await pause() }
  await g.passUntil(() => spawns().length > 0 && g.state.stack.length === 0, 15_000, 'Nest Invader makes a Spawn')
  await pause()
  const s0 = spawns()
  console.log('spawns:', JSON.stringify(s0.map((c) => ({ id: c.id, name: c.name, sick: c.sick, autoTap: c.autoTap, playable: c.playable, text: c.text?.slice(0, 60) }))))
  g.send({ cmd: 'card', id: s0[0].id }); await pause(1500)
  console.log('after click: prompt', JSON.stringify(g.state.prompt.message), '| pool', JSON.stringify(g.me.mana), '| spawns', spawns().length, '| requests', JSON.stringify(g.requests.map((r) => [r.kind, r.title?.split('\n')[0], (r.options ?? []).map((o) => o.label)])))
  console.log('confirm prompt:', JSON.stringify(g.state.prompt))
  g.check('Forge asks to confirm the sacrifice', /Sacrifice .*\?/.test(g.state.prompt.message), g.state.prompt.message)
  await g.ok(); await pause(1200)
  g.check('a Spawn was sacrificed', spawns().length === s0.length - 1, String(spawns().length))
  g.check('{C} went into the pool', (g.me.mana.C ?? 0) >= 1, JSON.stringify(g.me.mana))
  // Paying for Grizzly Bears ({1}{G}): Forest + a Spawn.
  await g.click('Grizzly Bears', 'hand'); await pause()
  console.log('bears prompt:', JSON.stringify(g.state.prompt.message))
  // Spend the {C} the way the table's pool chip does (ManaAtom colorless = 32), then a Forest.
  g.send({ cmd: 'mana', color: 32 }); await pause()
  g.check('the pooled {C} paid the {1}', !/\{1\}/.test(g.state.prompt.message) && (g.me.mana.C ?? 0) === 0, g.state.prompt.message + ' ' + JSON.stringify(g.me.mana))
  const f = g.cards('battlefield').find((c) => c.name === 'Forest' && !c.tapped)
  if (f && /Pay Mana Cost/i.test(g.state.prompt.message)) { g.send({ cmd: 'card', id: f.id }); await pause() }
  await g.passUntil(() => !!g.find('Grizzly Bears'), 10_000, 'Bears resolve').catch(() => null)
  g.check('Grizzly Bears cast with the Spawn mana', !!g.find('Grizzly Bears'))
} catch (e) {
  g.check(`error: ${e.message}`, false)
  console.log('prompt:', JSON.stringify(g.state?.prompt), '\nlog:', JSON.stringify(g.recentLog(8)))
} finally {
  clearTimeout(t)
  console.log('log:', JSON.stringify(g.recentLog(6)))
  const failed = g.results.filter((r) => !r.ok).length
  console.log(`${g.results.length - failed}/${g.results.length} checks passed`)
  g.quit()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}
