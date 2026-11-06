// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// The legend rule: a second Isamaru enters and you choose one to keep. Forge
// asks for that on the board (selectable cards), which the table must keep
// clickable even when something is still on the stack.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Mutant Menace/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 100_000)
const pause = (ms = 800) => new Promise((r) => setTimeout(r, ms))
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=Isamaru, Hound of Konda', 'aihand=', 'aibattlefield=',
    'humanbattlefield=Isamaru, Hound of Konda; Plains; Plains',
    `humanlibrary=${Array(20).fill('Plains').join('; ')}`, `ailibrary=${Array(20).fill('Island').join('; ')}`
  ])
  await pause()
  await g.click('Isamaru, Hound of Konda', 'hand'); await pause()
  if (/Pay Mana Cost/i.test(g.state.prompt.message)) await g.ok()
  await g.passUntil((s) => s.stack.length === 0 || g.cards('battlefield').some((c) => c.selectable), 15_000, 'resolve').catch(() => null)
  await pause(1200)
  const sel = g.cards('battlefield').filter((c) => c.selectable)
  console.log('prompt:', JSON.stringify(g.state.prompt.message), '\nselectable:', JSON.stringify(sel.map((c) => [c.id, c.name, c.zone])), '\nrequests:', JSON.stringify(g.requests.map((r) => [r.kind, r.title?.split('\n')[0]])))
  g.check('Forge asks you to pick on the board, or in a dialog', sel.length >= 2 || g.requests.some((r) => /legend|keep/i.test(r.title ?? '')))
  if (sel.length) { g.send({ cmd: 'card', id: sel[0].id }); await pause(); if (g.state.prompt.okEnabled && !g.hasPriority()) await g.ok(); await pause(1200) }
  const left = g.cards('battlefield').filter((c) => /Isamaru/.test(c.name)).length
  g.check('one Isamaru stays', left === 1, String(left))
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
