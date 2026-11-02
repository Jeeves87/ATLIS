// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Vivi Ornitier's {0}: Add X mana in any combination of {U} and/or {R}.
// You must get to choose the split — here, all red — not an even split.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 100_000)
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=',
    'humanbattlefield=Vivi Ornitier|Counters:P1P1=3', 'aibattlefield=',
    `humanlibrary=${Array(20).fill('Island').join('; ')}`, `ailibrary=${Array(20).fill('Plains').join('; ')}`
  ])
  await g.waitFor((s) => g.hasPriority(s) && s.phase === 'MAIN1' && s.activePlayer === s.you, 10_000, 'main')
  const vivi = g.find('Vivi Ornitier')
  g.check('Vivi shows as usable (glows) on your main phase', !!vivi?.playable, JSON.stringify({ power: vivi?.power, playable: vivi?.playable }))

  let asked = null
  g.answerWith = (r) => {
    if (r.kind !== 'assign') return undefined
    asked = r
    return r.options.map((o) => (o.color === 'R' ? r.amount : 0))
  }
  g.send({ cmd: 'card', id: vivi.id })
  await g.waitFor((s) => Object.values(s.players.find((p) => p.id === s.you).mana).some((n) => n > 0), 8_000, 'mana').catch(() => null)
  const mana = g.state.players.find((p) => p.id === g.state.you).mana
  g.check('you were asked how to split the mana', !!asked, JSON.stringify(asked && { title: asked.title, amount: asked.amount, options: asked.options.map((o) => `${o.label}:${o.color}≤${o.max}`) }))
  g.check('all red, as chosen (3 R, 0 U)', mana.R === 3 && mana.U === 0, JSON.stringify(mana))
  await new Promise((r) => setTimeout(r, 600))
  g.check('once used, Vivi stops glowing (once each turn)', !g.find('Vivi Ornitier')?.playable)
} catch (e) {
  g.check(`error: ${e.message}`, false)
  console.log('prompt:', JSON.stringify(g.state?.prompt), '\nlog:', JSON.stringify(g.recentLog(6)))
} finally {
  clearTimeout(t)
  const failed = g.results.filter((r) => !r.ok).length
  console.log(`${g.results.length - failed}/${g.results.length} checks passed`)
  g.quit()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}
