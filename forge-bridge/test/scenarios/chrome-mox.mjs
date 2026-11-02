// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Chrome Mox: the optional imprint trigger must ask, and "Yes" must let you
// pick the card from your hand (only nonartifact, nonland cards), then exile it.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Odds and Ends/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 100_000)
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=Chrome Mox; Swords to Plowshares; Island; Sol Ring',
    `humanlibrary=${Array(20).fill('Island').join('; ')}`, `ailibrary=${Array(20).fill('Plains').join('; ')}`, 'aibattlefield='
  ])
  await g.waitFor((s) => g.hasPriority(s) && s.phase === 'MAIN1' && s.activePlayer === s.you, 10_000, 'main')
  await g.click('Chrome Mox', 'hand')
  // OK until the "use triggered ability?" question shows up.
  await g.passUntil((s) => /Use triggered ability of Chrome Mox/i.test(s.prompt.message), 15_000, 'imprint question')
  g.check('asked whether to use the imprint trigger', true, JSON.stringify(g.state.prompt))
  const before = g.requests.length
  await g.ok()
  await g.waitFor(() => g.requests.length > before || Object.values(g.state.cards).some((c) => c.selectable), 8_000, 'choice').catch(() => null)
  const req = g.requests[before]
  const sel = Object.values(g.state.cards).filter((c) => c.selectable).map((c) => c.name)
  console.log('request:', JSON.stringify(req && { kind: req.kind, title: req.title, min: req.min, max: req.max, options: req.options?.map((o) => o.label) }), '\nselectable:', sel.join(', '), '\nprompt:', JSON.stringify(g.state.prompt.message))
  const offered = req?.options?.map((o) => o.cardData?.name ?? g.state.cards[o.card]?.name ?? o.label) ?? sel
  g.check('Swords is offered', offered.some((n) => /Swords/.test(n)), offered.join(', '))
  g.check('lands / artifacts are not offered', !offered.some((n) => /Island|Sol Ring/.test(n)))
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
