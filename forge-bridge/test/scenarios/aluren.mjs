// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Aluren: creature spells with mana value 3 or less may be cast without
// paying their mana cost. Clicking Grizzly Bears with Aluren out (and no
// lands) must offer the free cast, and taking it puts Bears on the stack.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Mutant Menace/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 100_000)
const pause = (ms = 800) => new Promise((r) => setTimeout(r, ms))
const asked = []
g.answerWith = (r) => {
  asked.push({ kind: r.kind, title: r.title?.split('\n')[0], options: (r.options ?? []).map((o) => o.label ?? o) })
  if (r.kind === 'choose' || r.kind === 'ability') { const i = (r.options ?? []).findIndex((o) => /without paying|Aluren/i.test(o.label ?? o)); return [i < 0 ? 0 : i] }
  return undefined
}
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=Grizzly Bears', 'aihand=', 'aibattlefield=',
    `humanbattlefield=Aluren${process.env.LANDS ? '; Forest; Forest' : ''}`,
    `humanlibrary=${Array(20).fill('Forest').join('; ')}`, `ailibrary=${Array(20).fill('Island').join('; ')}`
  ])
  await pause()
  const b = g.cards('hand').find((c) => c.name === 'Grizzly Bears')
  console.log('bears in hand:', JSON.stringify({ playable: b?.playable, selectable: b?.selectable }))
  await g.click('Grizzly Bears', 'hand'); await pause(1500)
  console.log('prompt after click:', JSON.stringify(g.state.prompt.message), 'stack:', g.state.stack.length)
  console.log('asked:', JSON.stringify(asked))
  if (/Pay Mana Cost/i.test(g.state.prompt.message)) { g.check('Bears cast for free', false, 'Forge asks for mana'); }
  else {
    await g.passUntil((s) => !!g.find('Grizzly Bears') || !s.stack.length, 10_000, 'resolve').catch(() => null)
    g.check('Bears cast for free', !!g.find('Grizzly Bears') || g.state.stack.length > 0)
  }
} catch (e) {
  g.check(`error: ${e.message}`, false)
  console.log('prompt:', JSON.stringify(g.state?.prompt), '\nasked:', JSON.stringify(asked), '\nlog:', JSON.stringify(g.recentLog(8)))
} finally {
  clearTimeout(t)
  const failed = g.results.filter((r) => !r.ok).length
  console.log(`${g.results.length - failed}/${g.results.length} checks passed`)
  g.quit()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}
