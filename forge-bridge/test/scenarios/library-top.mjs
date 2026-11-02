// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// "Look at / play from the top of your library" — the user's real cards.
//   Conspicuous Snoop (Goblin Storm): top card revealed; cast Goblin spells from the top.
//   Vesuvan Drifter (Odds and Ends): you may look at the top card any time.
import { Game, deck } from '../harness.mjs'

const results = []
async function run(title, you, setup, body) {
  console.log(`\n== ${title}`)
  const g = await Game.start({ you, opp: deck(/Mutant Menace/) })
  const timer = setTimeout(() => { console.log('FAIL  timed out'); g.quit() }, 60_000)
  try {
    await g.untilOurMain()
    await g.applyState(setup)
    await g.waitFor((s) => s.phase === 'MAIN1' && s.activePlayer === s.you && g.hasPriority(s), 15_000, 'our main phase')
    await body(g)
  } catch (e) {
    g.check(`error: ${e.message}`, false)
  } finally {
    clearTimeout(timer)
    results.push(...g.results)
    g.quit()
    await new Promise((r) => setTimeout(r, 1500))
  }
}

const base = (battlefield, library) => [
  'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=',
  `humanbattlefield=${battlefield}`, `humanlibrary=${library}`,
  'aibattlefield=Island', 'ailibrary=Island; Island; Island; Island; Island; Island',
  'removesummoningsickness=true'
]

await run('Conspicuous Snoop: cast a Goblin from the top', deck(/Goblin Storm/),
  base('Conspicuous Snoop; Mountain; Mountain; Mountain', 'Goblin Lackey; Mountain; Mountain; Mountain; Mountain; Mountain'),
  async (g) => {
    const topId = g.me.libraryTop
    const top = topId != null ? g.state.cards[topId] : null
    g.check('top card is shown to you', !!top?.name, top ? top.name : 'no libraryTop in snapshot')
    g.check('top card is the Goblin we put there', top?.name === 'Goblin Lackey')
    g.check('it glows as castable from the library', !!top?.playable)
    if (top) {
      g.send({ cmd: 'card', id: top.id })
      await g.waitFor((s) => /Pay Mana Cost/i.test(s.prompt.message) || (s.log ?? []).some((l) => /You cast Goblin Lackey/.test(l.text)), 8_000, 'cast').catch(() => null)
      if (/Pay Mana Cost/i.test(g.state.prompt.message)) await g.ok()
      await g.passUntil(() => !!g.find('Goblin Lackey'), 10_000, 'Lackey resolves').catch(() => null)
      g.check('Goblin Lackey cast from the top and on the battlefield', !!g.find('Goblin Lackey'), JSON.stringify(g.recentLog(4)))
    }
  })

await run('Vesuvan Drifter: look at the top any time', deck(/Odds and Ends/),
  base('Vesuvan Drifter; Island; Island', 'Enigma Sphinx; Island; Island; Island; Island; Island'),
  async (g) => {
    const topId = g.me.libraryTop
    const top = topId != null ? g.state.cards[topId] : null
    g.check('top card is shown to you', !!top?.name, top ? top.name : 'no libraryTop in snapshot')
    g.check('top card is the one we put there', top?.name === 'Enigma Sphinx')
    const opp = g.state.players.find((p) => p.id !== g.state.you)
    g.check("opponent's top card stays hidden", opp.libraryTop == null)
  })

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
