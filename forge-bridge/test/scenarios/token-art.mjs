// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

// Tokens have no printing, so ATLIS finds their art by name + colors + P/T.
// The snapshot must carry those, and the same searches forgeGame.ts runs must
// find single-faced token art on Scryfall for common tokens.
import { Game, deck } from '../harness.mjs'

const g = await Game.start({ you: deck(/Vivi Ornitier/), opp: deck(/Odds and Ends/) })
const t = setTimeout(() => { console.log('FAIL  timed out'); g.quit(); process.exit(1) }, 110_000)
const search = async (q) => {
  const r = await fetch(`https://api.scryfall.com/cards/search?unique=art&q=${encodeURIComponent(`layout:token ${q}`)}`, { headers: { 'User-Agent': 'ATLIS/0.1', Accept: 'application/json' } })
  await new Promise((res) => setTimeout(res, 150))
  return r.ok ? (await r.json()).data.length : 0
}
// Mirrors tokenKey/tokenQueries in src/main/forgeGame.ts.
const queries = (c) => {
  const name = c.name.replace(/\s+Token$/i, '').trim()
  const exact = `!"${name}"`, color = `c=${c.colors || 'c'}`
  return [...new Set([c.creature ? `${exact} ${color} pow=${c.power} tou=${c.toughness}` : `${exact} ${color}`, `${exact} ${color}`, exact])]
}
try {
  await g.untilOurMain()
  await g.applyState([
    'activeplayer=human', 'activephase=MAIN1', 'humanhand=', 'aibattlefield=',
    'humanbattlefield=T:r_1_1_goblin; T:c_a_food_sac; T:c_a_treasure_sac; T:w_1_1_soldier; T:c_a_clue_draw',
    `humanlibrary=${Array(20).fill('Island').join('; ')}`, `ailibrary=${Array(20).fill('Plains').join('; ')}`
  ])
  await g.waitFor((s) => g.hasPriority(s) && s.phase === 'MAIN1', 10_000, 'main')
  const tokens = g.cards('battlefield').filter((c) => c.token)
  g.check('tokens came through', tokens.length >= 4, tokens.map((c) => c.name).join(', '))
  for (const c of tokens) {
    g.check(`${c.name}: colors sent`, typeof c.colors === 'string', JSON.stringify({ colors: c.colors, pt: c.creature ? `${c.power}/${c.toughness}` : null }))
    let found = 0, used = ''
    for (const q of queries(c)) { found = await search(q); used = q; if (found) break }
    g.check(`${c.name}: Scryfall has token art`, found > 0, `${found} arts for ${used}`)
  }
} catch (e) {
  g.check(`error: ${e.message}`, false)
} finally {
  clearTimeout(t)
  const failed = g.results.filter((r) => !r.ok).length
  console.log(`${g.results.length - failed}/${g.results.length} checks passed`)
  g.quit()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}
