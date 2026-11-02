/**
 * cEDH tournament play rate for owned cards — "does this show up in a ton of
 * top-tier decks?"
 *
 * WHY EDHTOP16: it aggregates real decklists from competitive Commander
 * tournaments, and its public GraphQL API answers per card with
 * `playRateLastYear`. EDHREC (already used for commander popularity) counts
 * every casual deck anyone uploads, which measures how often a card is played
 * rather than how often it is played to WIN.
 *
 * WHAT THE NUMBER IS: the share of the last year's cEDH tournament decks that
 * ran the card. Probed 2026-10-11: Rhystic Study 0.88, Mental Misstep 0.87,
 * Swords to Plowshares 0.45, Sol Ring 0.42, Sensei's Divining Top 0.04,
 * Grizzly Bears 0.00007. Treat it as a ranking signal rather than an exact
 * share: the denominator is EDHTop16's, not ours (Sol Ring sitting below
 * Rhystic Study says the base isn't simply "every deck").
 *
 * COST: one request answers up to BATCH cards (GraphQL aliases), so a
 * collection of 1,500 distinct cards is ~38 requests. Rates move slowly, so a
 * card is re-asked weekly at most. A card EDHTop16 has never seen comes back
 * as an error for that alias alone; it is stored as null so it isn't re-asked.
 *
 * No key, no published rate limit — hence the courteous gap.
 *
 * OUTAGE (2026-11-01): every plain-text query now gets "Only persisted queries
 * are allowed in production". That is the default of Pastoria, the framework
 * EDHTop16 runs on (`persistedQueriesOnlyInProduction ?? true`), and the site
 * still advertises the API as public and keyless, so it looks like an upgrade
 * side effect rather than a policy. The only queries it accepts are the site's
 * own page queries, sent by hash (`extensions: { 'pastoria-id': … }`). Those
 * hashes change whenever a page's query changes and none of them asks about
 * one card, so they are not a route to build on. Until EDHTop16 re-opens the
 * API, playRates() falls back as described there. The documented alternative
 * is TopDeck.gg's v2 API (free key, attribution required), which would mean
 * computing play rates locally from raw decklists.
 */
import * as db from './db'

const API = 'https://edhtop16.com/api/graphql'
const UA = 'ATLIS/1.0 (personal collection tracker)'
const BATCH = 40
const GAP_MS = 400
const FRESH_MS = 7 * 24 * 60 * 60_000
const LAST_SYNC_KEY = 'cedh_last_sync_at'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface CedhSyncResult {
  asked: number
  /** Cards EDHTop16 has a play rate for. */
  played: number
  failed: string[]
}

async function askBatch(names: string[]): Promise<Array<number | null>> {
  const defs = names.map((_, i) => `$n${i}: String!`).join(', ')
  const sel = names.map((_, i) => `c${i}: card(name: $n${i}) { playRateLastYear }`).join(' ')
  const variables = Object.fromEntries(names.map((n, i) => [`n${i}`, n]))
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ query: `query Cards(${defs}) { ${sel} }`, variables })
  })
  if (!r.ok) throw new Error(`EDHTop16 answered HTTP ${r.status}`)
  const j = (await r.json()) as {
    data?: Record<string, { playRateLastYear?: number | null } | null> | null
    errors?: Array<{ message?: string; path?: unknown[] }>
  }
  // Per-alias "Query returned no rows" just means an unplayed card. Anything
  // else, with no data at all, is a real failure (a schema change, an outage).
  if (!j.data) throw new Error(j.errors?.[0]?.message ?? 'EDHTop16 returned no data')
  return names.map((_, i) => {
    const v = j.data?.[`c${i}`]?.playRateLastYear
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  })
}

/** Ask about every owned card that is missing a rate or older than a week. */
export async function syncOwned(force = false): Promise<CedhSyncResult> {
  const names = db.listCedhStaleNames(force ? Number.MAX_SAFE_INTEGER : Date.now() - FRESH_MS)
  const out: CedhSyncResult = { asked: 0, played: 0, failed: [] }
  for (let i = 0; i < names.length; i += BATCH) {
    const chunk = names.slice(i, i + BATCH)
    try {
      const rates = await askBatch(chunk)
      db.upsertCedhStats(chunk.map((name, k) => ({ name, play_rate: rates[k] })))
      out.asked += chunk.length
      out.played += rates.filter((x) => x != null && x > 0).length
    } catch (e) {
      out.failed.push(`${chunk[0]}…: ${e instanceof Error ? e.message : String(e)}`)
      // An outage fails every batch the same way; stop rather than hammer it.
      if (out.failed.length >= 2) break
    }
    if (i + BATCH < names.length) await sleep(GAP_MS)
  }
  if (!out.failed.length) db.setSetting(LAST_SYNC_KEY, String(Date.now()))
  return out
}

/**
 * Where a rate came from: 'edhtop16' = EDHTop16's own playRateLastYear (live
 * or stored); 'lists' = share of the cEDH top-16 lists mirrored locally by
 * decks.syncCedhLists — a smaller sample, but the same kind of signal;
 * 'none' = neither knows anything.
 */
export type CedhRateSource = 'edhtop16' | 'lists' | 'none'

export interface PlayRates {
  rates: Map<string, { rate: number | null; source: CedhRateSource }>
  note: string | null
}

/**
 * cEDH play rate for arbitrary card names — a set's card list, not just the
 * collection. Stored rates are used when under a week old; the rest are asked
 * live and stored, so a set looked at twice costs one round of requests.
 *
 * If EDHTop16 refuses (it has started rejecting plain-text GraphQL — "Only
 * persisted queries are allowed", seen 2026-11-01), the answer falls back to
 * stale stored rates and then to the locally mirrored tournament lists, and
 * `note` says so instead of the column silently going blank.
 */
export async function playRates(names: string[]): Promise<PlayRates> {
  const unique = [...new Set(names.filter(Boolean))]
  const stored = db.getCedhStats(unique)
  const rates: PlayRates['rates'] = new Map()
  const fresh = Date.now() - FRESH_MS
  const ask: string[] = []
  for (const n of unique) {
    const s = stored.get(n)
    if (s && s.synced_at >= fresh) rates.set(n, { rate: s.play_rate, source: 'edhtop16' })
    else ask.push(n)
  }

  let liveError: string | null = null
  for (let i = 0; i < ask.length && !liveError; i += BATCH) {
    const chunk = ask.slice(i, i + BATCH)
    try {
      const got = await askBatch(chunk)
      db.upsertCedhStats(chunk.map((name, k) => ({ name, play_rate: got[k] })))
      chunk.forEach((n, k) => rates.set(n, { rate: got[k], source: 'edhtop16' }))
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e)
    }
    if (!liveError && i + BATCH < ask.length) await sleep(GAP_MS)
  }

  const missing = unique.filter((n) => !rates.has(n))
  // Stale beats nothing: play rates move over months, not days.
  for (const n of missing) {
    const s = stored.get(n)
    if (s) rates.set(n, { rate: s.play_rate, source: 'edhtop16' })
  }
  const stillMissing = missing.filter((n) => !rates.has(n))
  let listCount = 0
  if (stillMissing.length) {
    const lists = db.listMtgCedhLists()
    listCount = lists.length
    if (listCount) {
      const hits = new Map<string, number>()
      const want = new Set(stillMissing)
      for (const l of lists) {
        let cards: Array<{ n?: string }> = []
        try { cards = JSON.parse(l.cards) } catch { /* corrupt row */ }
        for (const n of new Set(cards.map((c) => c.n ?? ''))) if (want.has(n)) hits.set(n, (hits.get(n) ?? 0) + 1)
      }
      for (const n of stillMissing) {
        const h = hits.get(n) ?? 0
        rates.set(n, { rate: h ? h / listCount : null, source: 'lists' })
      }
    }
  }

  let note: string | null = null
  if (liveError) {
    const viaLists = stillMissing.length && listCount
    note = `EDHTop16 live lookup failed (${liveError}). ` +
      (viaLists
        ? `${stillMissing.length} card(s) rated from ${listCount} cached top-16 lists instead.`
        : stillMissing.length
          ? `${stillMissing.length} card(s) have no cEDH data — no cached tournament lists to fall back on.`
          : 'Showing stored rates.')
  }
  return { rates, note }
}

export function lastSyncAt(): number | null {
  const v = Number(db.getSetting(LAST_SYNC_KEY) || 0)
  return v > 0 ? v : null
}
