// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Mortarion, Daemon Primarch: "At the beginning of your end step, you may pay
// {X}. If you do, create X 2/2 Astartes Warriors. X can't be greater than the
// amount of life you lost this turn." Records exactly what Forge asks at the
// end step, with and without life lost first.
//   LOSE=0 → lose no life this turn     LOSE=2 → Night's Whisper first (lose 2)
import { Game, deck } from '../harness.mjs'

const LOSE = Number(process.env.LOSE ?? 2)
const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 115_000)
const pause = (ms = 700) => new Promise((r) => setTimeout(r, ms))
const asked = []
g.answerWith = (r) => {
  asked.push({ kind: r.kind, title: r.title?.split('\n')[0], options: (r.options ?? []).slice(0, 6).map((o) => o.label ?? o), min: r.min, max: r.max, initial: r.initial })
  if (r.kind === 'confirm') return 0 // yes, pay
  if (r.kind === 'input') return String(LOSE) // X = everything allowed
  if (r.kind === 'choose' && /Choose X/i.test(r.title ?? '')) return [(r.options ?? []).length - 1] // the largest X
  return undefined
}
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN2', 'humanlife=40', 'ailife=40', 'aibattlefield=',
    `humanhand=${LOSE ? "Night's Whisper" : ''}`,
    `humanbattlefield=Mortarion, Daemon Primarch; ${Array(8).fill('Swamp').join('; ')}`,
    `humanlibrary=${Array(20).fill('Swamp').join('; ')}`, `ailibrary=${Array(20).fill('Mountain').join('; ')}`, 'removesummoningsickness=true'
  ])
  await pause()
  if (LOSE) {
    await g.click("Night's Whisper", 'hand'); await pause(1200)
    for (let i = 0; i < 4 && /Pay Mana Cost/i.test(g.state.prompt.message); i++) {
      const sw = g.cards('battlefield').find((c) => c.name === 'Swamp' && !c.tapped)
      g.send({ cmd: 'card', id: sw.id }); await pause()
    }
    await g.passUntil((s) => s.stack.length === 0 && g.hasPriority(s) && g.me.life < 40, 15_000, "Night's Whisper resolves")
  }
  g.check(`lost ${LOSE} life this turn`, g.me.life === 40 - LOSE, String(g.me.life))
  const prompts = []
  const pays = []
  const before = g.cards('battlefield').filter((c) => /Astartes/.test(c.name)).length
  await g.passUntil((s) => {
    if (/Pay Mana Cost/i.test(s.prompt.message) && s.phase === 'END_OF_TURN') {
      const sw = g.cards('battlefield').find((c) => c.name === 'Swamp' && !c.tapped)
      const key = s.prompt.message
      if (sw && pays.at(-1) !== key + sw.id) { pays.push(key + sw.id); g.send({ cmd: 'card', id: sw.id }) }
    }
    if (s.phase === 'END_OF_TURN' || s.stack.length) prompts.push(`${s.phase} | stack=${s.stack.map((x) => x.text?.slice(0, 50)).join('; ')} | ${s.prompt.message.split('\n')[0]}`)
    return s.activePlayer !== s.you
  }, 30_000, 'the next turn')
  const tokens = g.cards('battlefield').filter((c) => /Astartes/.test(c.name)).length - before
  console.log('end-step prompts:', JSON.stringify([...new Set(prompts)].slice(0, 8)))
  console.log('Forge asked:', JSON.stringify(asked))
  console.log('log:', JSON.stringify(g.recentLog(8)))
  g.check(LOSE ? `made ${LOSE} Astartes tokens` : 'made no tokens (X capped at 0)', tokens === LOSE, String(tokens))
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
