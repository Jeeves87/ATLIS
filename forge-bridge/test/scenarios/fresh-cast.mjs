// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Debug: in a FRESH game at turn 1, can we cast Swords to Plowshares from hand?
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Odds and Ends/), opp: deck(/Odds and Ends/) })
const timer = setTimeout(() => { console.log('timed out'); g.quit(); process.exit(1) }, 90_000)
await g.untilOurMain()
console.log('before apply: turn', g.state.turn, g.state.phase, 'active you?', g.state.activePlayer === g.state.you)
await g.applyState([
  'activeplayer=human', 'activephase=MAIN1', 'humanhand=Swords to Plowshares',
  `humanbattlefield=${Array(5).fill('Plains').join('; ')}`, `humanlibrary=${Array(20).fill('Island').join('; ')}`,
  'aibattlefield=Grizzly Bears', `ailibrary=${Array(20).fill('Plains').join('; ')}`, 'removesummoningsickness=true'
])
await new Promise((r) => setTimeout(r, 800))
const sw = g.cards('hand').find((c) => c.name === 'Swords to Plowshares')
const lands = g.cards('battlefield')
console.log('after apply: turn', g.state.turn, g.state.phase, 'priority', g.hasPriority(), 'hand', g.cards('hand').map((c) => c.name).join(','),
  '| my battlefield', lands.map((c) => `${c.name}${c.tapped ? '(T)' : ''}`).join(','), '| swords playable flag', sw?.playable)
g.send({ cmd: 'card', id: sw.id })
await new Promise((r) => setTimeout(r, 1500))
console.log('after click: prompt =', JSON.stringify(g.state.prompt.message.split('\n').slice(0, 3)), 'ok', g.state.prompt.okEnabled, 'cancel', g.state.prompt.cancelEnabled)
console.log('selectable:', Object.values(g.state.cards).filter((c) => c.selectable).map((c) => c.name).join(', '))
console.log('log tail:', JSON.stringify(g.recentLog(5)))
clearTimeout(timer)
g.quit()
setTimeout(() => process.exit(0), 1500)
