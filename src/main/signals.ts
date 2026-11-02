/**
 * Demand-intent signals — what people are actually trying to buy.
 *
 * WHY AUTOCOMPLETE RATHER THAN SENTIMENT: a search completion only exists
 * because enough people typed it. "pokemon 151 booster box where to buy" is
 * not somebody's opinion, it is an aggregate of real purchase intent that
 * Google has already counted for us. That makes it a measurement, where
 * scraping social posts for excitement is an inference — and a far more
 * expensive, far less reliable one.
 *
 * WHAT WAS TRIED AND REJECTED (probed 2026-09-07, so nobody re-litigates it):
 *   X / Twitter          no free API; syndication endpoint answers 429.
 *   Bluesky public API   403 from a plain client.
 *   Reddit phrase search rate-limited after ~2 calls AND the relevance is
 *                        useless — "sold out in minutes" returned posts about
 *                        memecoins and the MCU.
 *   Trends rising queries the /api/explore token flow answers 429 unauthed.
 *   eBay HTML            403; needs their official API and a key.
 * Google's daily-trends RSS and the autocomplete endpoint both answer 200
 * without a key, so those are what this is built on.
 *
 * THE SIGNAL IS MOVEMENT, NOT PRESENCE. A single snapshot says almost nothing;
 * "labubu restock" existing as a completion is unremarkable. That completion
 * CLIMBING, or appearing where it did not exist last week, is the thing worth
 * acting on — which is why observations are stored per day and read as deltas.
 */
import * as db from './db'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 12_000
/** Autocomplete tolerates bursts, but there is no reason to be rude about it. */
const GAP_MS = 250

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------------- intent

export type Intent = 'purchase' | 'scarcity' | 'release' | 'resale' | 'community' | 'other'

/**
 * Ordered most-specific first: "where to buy" is scarcity-flavoured purchase
 * intent, but "back in stock" is unambiguously scarcity, so scarcity is tested
 * before the broader purchase patterns.
 */
const INTENT_PATTERNS: Array<[Intent, RegExp]> = [
  ['scarcity', /\b(restock|back in stock|in stock|sold out|out of stock|how to get|when will|drop time|hard to find|where to find)\b/],
  ['release', /\b(release date|release time|drop date|launch|preorder|pre-order|coming soon|announcement)\b/],
  ['resale', /\b(resale|resell|ebay|stockx|goat|worth|how much|value|price guide|secondary)\b/],
  ['purchase', /\b(where to buy|buy|for sale|near me|in store|store|website|order|shop|cheap|discount)\b/],
  ['community', /\b(reddit|discord|twitter|forum|subreddit|fan)\b/]
]

export function classifyIntent(suggestion: string): Intent {
  const s = suggestion.toLowerCase()
  for (const [intent, re] of INTENT_PATTERNS) if (re.test(s)) return intent
  return 'other'
}

/**
 * Weights for the scarcity score. Scarcity language is what we are hunting;
 * purchase intent corroborates it; resale chatter means the window has already
 * closed, so it is scored LOW on purpose rather than treated as a positive.
 */
const INTENT_WEIGHT: Record<Intent, number> = {
  scarcity: 3,
  purchase: 2,
  release: 1.5,
  community: 0.5,
  resale: 0.25,
  other: 0
}

// ---------------------------------------------------------------- autocomplete

/**
 * Prefixes probed per term.
 *
 * Deliberately intent-shaped rather than the alphabet: 26 letter-probes cost 26
 * requests to mostly surface irrelevant completions ("labubu stitch"), while
 * these ten go straight at the question of whether people are struggling to buy
 * the thing. The bare prefix is kept because it shows what dominates overall.
 */
const PREFIXES = ['', ' w', ' where', ' how to', ' in ', ' r', ' restock', ' buy', ' release', ' price']

async function suggest(query: string): Promise<string[]> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': UA }, signal: ctl.signal }
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.text()
    const parsed = JSON.parse(body) as [string, string[]]
    return Array.isArray(parsed?.[1]) ? parsed[1] : []
  } finally {
    clearTimeout(t)
  }
}

export interface SampleResult {
  term: string
  suggestions: number
  byIntent: Record<Intent, number>
  score: number
  note: string | null
}

/**
 * Sample one term across every prefix and store today's completions.
 *
 * Rank is kept per prefix and the LOWEST wins on conflict (see the DB upsert):
 * a completion that appears at position 0 under one prefix and position 8 under
 * another is best described by the position it actually leads.
 */
export async function sampleTerm(termId: string): Promise<SampleResult> {
  const term = db.listSignalTerms().find((t) => t.id === termId)
  if (!term) throw new Error('Unknown signal term.')

  const rows: Array<{ suggestion: string; intent: string; rank: number }> = []
  const seen = new Set<string>()
  const errors: string[] = []

  for (const prefix of PREFIXES) {
    try {
      const list = await suggest(`${term.term}${prefix}`)
      list.forEach((s, i) => {
        const clean = s.trim().toLowerCase()
        // Completions that do not mention the term are Google drifting to a
        // different topic entirely; they say nothing about this thing.
        if (!clean || !clean.includes(term.term) || seen.has(clean)) return
        seen.add(clean)
        rows.push({ suggestion: clean, intent: classifyIntent(clean), rank: i })
      })
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
    await sleep(GAP_MS)
  }

  if (rows.length) db.recordSuggestions(term.id, rows, today())
  db.updateSignalTerm(term.id, {
    last_checked_at: Date.now(),
    last_error: rows.length ? null : errors[0] ?? 'No completions returned.'
  })

  const byIntent = { purchase: 0, scarcity: 0, release: 0, resale: 0, community: 0, other: 0 } as Record<Intent, number>
  for (const r of rows) byIntent[r.intent as Intent]++

  return {
    term: term.term,
    suggestions: rows.length,
    byIntent,
    score: scoreRows(rows),
    note: errors.length ? `${errors.length} prefix(es) failed: ${errors[0]}` : null
  }
}

/**
 * Weighted intent density, normalised to 0-100.
 *
 * Density rather than raw count, so a term with many completions is not
 * automatically hotter than a niche one — what matters is the SHARE of what
 * people type that is about getting hold of the thing.
 */
function scoreRows(rows: Array<{ intent: string }>): number {
  if (!rows.length) return 0
  const total = rows.reduce((n, r) => n + (INTENT_WEIGHT[r.intent as Intent] ?? 0), 0)
  return Math.round(Math.min(100, (total / (rows.length * INTENT_WEIGHT.scarcity)) * 100))
}

export interface TermReading {
  id: string
  term: string
  score: number
  days: number
  suggestions: number
  byIntent: Record<Intent, number>
  /** Completions that climbed or newly appeared — the actionable part. */
  rising: db.SuggestionMove[]
  lastCheckedAt: number | null
  lastError: string | null
}

/** Everything the UI needs about one term, read from stored observations. */
export function readTerm(termId: string, windowDays = 7): TermReading | null {
  const term = db.listSignalTerms().find((t) => t.id === termId)
  if (!term) return null
  const latest = db.listSuggestions(term.id)
  const byIntent = { purchase: 0, scarcity: 0, release: 0, resale: 0, community: 0, other: 0 } as Record<Intent, number>
  for (const s of latest) byIntent[s.intent as Intent]++
  const moves = db.suggestionMoves(term.id, windowDays)
  return {
    id: term.id,
    term: term.term,
    score: scoreRows(latest),
    days: db.signalDayCount(term.id),
    suggestions: latest.length,
    byIntent,
    // New completions first (wasRank null), then genuine climbers.
    rising: moves.filter((m) => m.wasRank == null || (m.delta ?? 0) > 0).slice(0, 12),
    lastCheckedAt: term.last_checked_at,
    lastError: term.last_error
  }
}

/** Add a term to track, idempotently. */
export function trackTerm(term: string, source = 'manual', watchId?: string | null): db.SignalTerm {
  const clean = term.trim().toLowerCase()
  if (!clean) throw new Error('Enter something to track.')
  return db.findSignalTerm(clean) ?? db.createSignalTerm({ term: clean, source, watch_id: watchId ?? null })
}

// ---------------------------------------------------------------- trends

export interface TrendingItem {
  title: string
  traffic: string | null
  link: string | null
}

/**
 * Google's daily trending searches.
 *
 * Kept at arm's length: it is dominated by news and sport, so it is offered as
 * a place to NOTICE something rather than as an automatic term source. A toy
 * craze does surface here, but so does every football result, and auto-tracking
 * the feed would bury the signal in fixtures.
 */
export async function trendingSearches(geo = 'US'): Promise<TrendingItem[]> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`, {
      headers: { 'User-Agent': UA },
      signal: ctl.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const xml = await res.text()
    const out: TrendingItem[] = []
    for (const block of xml.split(/<item>/i).slice(1)) {
      const pick = (tag: string): string | null => {
        const m = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'i').exec(block)
        return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : null
      }
      const title = pick('title')
      if (title) out.push({ title, traffic: pick('approx_traffic'), link: pick('link') })
    }
    return out
  } finally {
    clearTimeout(t)
  }
}

// ---------------------------------------------------------------- sweep

export interface SignalSweep {
  terms: number
  sampled: number
  errors: string[]
}

/** Sample every enabled term. Once a day is plenty — the data is daily. */
export async function sweep(): Promise<SignalSweep> {
  const terms = db.listSignalTerms().filter((t) => t.enabled === 1)
  const out: SignalSweep = { terms: terms.length, sampled: 0, errors: [] }
  for (const t of terms) {
    try {
      await sampleTerm(t.id)
      out.sampled++
    } catch (err) {
      out.errors.push(`${t.term}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  db.pruneSignalSuggestions()
  return out
}
