// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Imposter Mech entering as a copy of an opponent's creature: it must land on
// your battlefield as that creature's name, as a Vehicle (not a creature),
// marked as a copy, and crewing it must turn it into a creature.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 110_000)
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=Imposter Mech',
    `humanbattlefield=${Array(6).fill('Island').join('; ')}; Hill Giant`, 'aibattlefield=Serra Angel',
    `humanlibrary=${Array(20).fill('Island').join('; ')}`, `ailibrary=${Array(20).fill('Plains').join('; ')}`, 'removesummoningsickness=true'
  ])
  await g.waitFor((s) => g.hasPriority(s) && s.phase === 'MAIN1' && s.activePlayer === s.you, 10_000, 'main')
  // "You may have it enter as a copy": yes, and the creature to copy is Serra Angel.
  g.answerWith = (r) => {
    if (r.kind === 'confirm') return 0
    if (r.kind === 'choose' && r.options?.some((o) => /Serra Angel/.test(o.label))) return [r.options.find((o) => /Serra Angel/.test(o.label)).i]
    return undefined
  }
  await g.click('Imposter Mech', 'hand')
  await g.passUntil((s) => {
    const me = s.players.find((p) => p.id === s.you)
    return s.stack.length === 0 && me.zones.battlefield.some((id) => /Serra Angel/.test(s.cards[id]?.name ?? ''))
  }, 20_000, 'mech resolves as a copy')
  const me = g.state.players.find((p) => p.id === g.state.you)
  const mech = me.zones.battlefield.map((id) => g.state.cards[id]).find((c) => /Serra Angel/.test(c?.name ?? ''))
  g.check('it is on YOUR battlefield, named Serra Angel', !!mech, JSON.stringify(mech && { name: mech.name, type: mech.type }))
  g.check('it is a Vehicle, not a creature (needs crew)', /Vehicle/.test(mech?.type ?? '') && !mech?.creature)
  g.check('Forge marks it as a copy ("Cloned by:")', !!mech?.text?.includes('Cloned by:'))
  g.check('it shows crew 3', /Crew 3/.test(mech?.text ?? ''))
  g.check('crew is offered (it glows)', !!mech?.playable)

  // Crew it with Hill Giant (power 3).
  g.answerWith = (r) => (r.kind === 'choose' && r.options?.some((o) => /Hill Giant/.test(o.label)) ? [r.options.find((o) => /Hill Giant/.test(o.label)).i] : undefined)
  g.send({ cmd: 'card', id: mech.id })
  await g.waitFor(() => Object.values(g.state.cards).some((c) => c.selectable && /Hill Giant/.test(c.name ?? '')) || g.state.stack.length > 0, 6_000, 'crew choice').catch(() => null)
  const giant = Object.values(g.state.cards).find((c) => c.selectable && /Hill Giant/.test(c.name ?? ''))
  if (giant) { g.send({ cmd: 'card', id: giant.id }); await new Promise((r) => setTimeout(r, 500)); if (g.state.prompt.okEnabled && !/^Priority/.test(g.state.prompt.message)) await g.ok() }
  await g.passUntil((s) => s.stack.length === 0 && !!s.cards[String(mech.id)]?.creature, 15_000, 'crewed').catch(() => null)
  const after = g.state.cards[String(mech.id)]
  g.check('crewed: it is now a creature', !!after?.creature, JSON.stringify({ type: after?.type, creature: after?.creature, prompt: g.state.prompt.message.split('\n')[0] }))
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
