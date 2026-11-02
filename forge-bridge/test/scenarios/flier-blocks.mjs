// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Attacked by fliers with no flying/reach creature of your own: Forge skips your
// block declaration entirely. canBlock must say "no" (it used to ask "can this
// block at all?", so the table outlined creatures that couldn't block anything),
// and must say so already in the declare-attackers step, before damage.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 110_000)
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=ai', 'activephase=MAIN1', 'humanlife=40', 'ailife=40', 'humanhand=', 'aihand=',
    'humanbattlefield=Grizzly Bears', 'aibattlefield=Wind Drake; Wind Drake; Wind Drake',
    `humanlibrary=${Array(20).fill('Mountain').join('; ')}`, `ailibrary=${Array(20).fill('Mountain').join('; ')}`, 'removesummoningsickness=true'
  ])
  const seen = []
  const orig = g.onLine.bind(g)
  g.onLine = (line) => {
    if (/"type":"state"/.test(line)) {
      const s = JSON.parse(line)
      const bears = Object.values(s.cards).find((c) => c.name === 'Grizzly Bears')
      if (s.combat.some((c) => c.defender === s.you)) seen.push({ phase: s.phase, canBlock: bears?.canBlock, prompt: s.prompt.message.split('\n')[0] })
    }
    orig(line)
  }
  await g.passUntil((s) => s.players.find((p) => p.id === s.you).life < 40, 40_000, 'fliers hit you')
  if (!seen.length) console.log('DEBUG log:', JSON.stringify(g.recentLog(12)))
  g.check('the AI attacked you', seen.length > 0, String(seen.length))
  const early = seen.filter((x) => x.phase === 'COMBAT_DECLARE_ATTACKERS')
  g.check('Bears flagged as unable to block during declare attackers', early.length > 0 && early.every((x) => x.canBlock === false), JSON.stringify(early.slice(0, 2)))
  g.check('Bears never flagged as able to block', seen.every((x) => x.canBlock !== true), JSON.stringify(seen.filter((x) => x.canBlock)))
  g.check('Forge never asked you to block', !seen.some((x) => /Select creatures to block/i.test(x.prompt)))
  g.check('the fliers dealt damage', g.me.life <= 38, String(g.me.life))
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
