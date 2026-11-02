/**
 * Magic: The Gathering tracking layer — release calendar, card prices, watchlist alerts.
 *
 * Mirrors the shape of vault.ts: an objective, API-fed price feed (Scryfall,
 * analogous to metal spot) plus agent-researched valuations for anything the
 * API cannot price (sealed boxes, analogous to collector premium).
 *
 * Scryfall is free and keyless but WILL block clients that omit a descriptive
 * User-Agent or Accept header, so every request goes through sfetch(). Prices
 * are a once-daily snapshot upstream — polling faster buys nothing, which is
 * why the scheduler ticks hourly and the day-keyed unique index collapses
 * repeat writes into one row per card/variant/day.
 */
import { BrowserWindow, Notification } from 'electron'
import * as db from './db'
import * as retail from './retail'
import * as alerts from './alerts'
import * as boosters from './boosters'
import * as secretlair from './secretlair'
import * as lifecycle from './lifecycle'
import * as edhrec from './edhrec'
import * as cedh from './cedh'

const UA = 'ATLIS/1.0 (personal collection tracker)'
const API = 'https://api.scryfall.com'

// Scryfall asks for <10 req/s sustained; /cards/collection is hard-capped at
// 2/s. 120ms left no headroom once EV scanning began walking set after set —
// a real 429 came back during testing — so the gap is well inside the limit.
const GAP_MS = 200
const COLLECTION_GAP_MS = 550
const COLLECTION_BATCH = 75

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type MtgVariant = 'nonfoil' | 'foil' | 'etched'

export interface ScryfallCard {
  id: string
  name: string
  set: string
  set_name: string
  collector_number: string
  rarity: string
  released_at?: string
  scryfall_uri?: string
  image_uris?: { normal?: string; small?: string; large?: string; art_crop?: string }
  card_faces?: Array<{ image_uris?: { normal?: string; small?: string; large?: string; art_crop?: string } }>
  finishes?: string[]
  promo_types?: string[]
  frame_effects?: string[]
  /** False when this printing is found in NO booster pack — promos, serialized. */
  booster?: boolean
  prices?: Record<string, string | null>
  oracle_id?: string
  mana_cost?: string
  cmc?: number
  type_line?: string
  oracle_text?: string
  color_identity?: string[]
  colors?: string[]
  keywords?: string[]
  legalities?: Record<string, string>
  edhrec_rank?: number
  reserved?: boolean
  /** True when this card was printed in some earlier set. */
  reprint?: boolean
  set_type?: string
}

interface ScryfallList<T> {
  data?: T[]
  not_found?: unknown[]
  object?: string
  details?: string
}

/**
 * GET/POST JSON from Scryfall with the headers it requires. Throws on !ok.
 *
 * A 429 is backed off and retried rather than thrown, because Scryfall's own
 * warning is that ignoring rate limits earns a NETWORK BLOCK — which would
 * take the whole Magic feature offline, not just one request. An EV scan walks
 * many sets in a row and each set is several paginated calls, so this is
 * reachable in normal use, not just in testing.
 */
async function sfetch<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {})
    }
  })
  if (res.status === 429 && attempt < 4) {
    const retryAfter = Number(res.headers.get('retry-after'))
    const waitMs = isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2_000 * Math.pow(2, attempt)
    await sleep(Math.min(waitMs, 60_000))
    return sfetch<T>(path, init, attempt + 1)
  }
  if (!res.ok) {
    let detail = ''
    try {
      detail = ((await res.json()) as { details?: string }).details ?? ''
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Scryfall ${res.status} on ${path}${detail ? `: ${detail}` : ''}`)
  }
  return (await res.json()) as T
}

/** Which prices key holds this variant's USD price. */
function priceKey(variant: string): string {
  return variant === 'foil' ? 'usd_foil' : variant === 'etched' ? 'usd_etched' : 'usd'
}

/** USD price for a variant, or null when Scryfall has no quote for that finish. */
export function priceOf(card: ScryfallCard, variant: string): number | null {
  const raw = card.prices?.[priceKey(variant)]
  const n = raw == null ? NaN : Number(raw)
  return isFinite(n) ? n : null
}

export function imageOf(card: ScryfallCard, size: 'normal' | 'large' | 'art_crop' = 'normal'): string | null {
  // Double-faced cards carry their images per face, not at the top level.
  const src = card.image_uris ?? card.card_faces?.[0]?.image_uris
  return src?.[size] ?? src?.normal ?? null
}

// ---------------------------------------------------------------- search

/** Free-text card search (Scryfall syntax works verbatim, e.g. `set:hoc rarity:mythic`). */
export async function searchCards(query: string, unique: 'prints' | 'cards' = 'prints'): Promise<ScryfallCard[]> {
  const q = query.trim()
  if (!q) return []
  const qs = new URLSearchParams({ q, unique, order: 'released', dir: 'desc' })
  try {
    const r = await sfetch<ScryfallList<ScryfallCard>>(`/cards/search?${qs}`)
    return r.data ?? []
  } catch (err) {
    // A no-match search is a 404 here, not an empty list — that is not an error.
    if (err instanceof Error && /\b404\b/.test(err.message)) return []
    throw err
  }
}

/**
 * Plain-English search.
 *
 * Scryfall ANDs bare words as CARD-NAME substrings, so "arcane signet hobbit"
 * returns nothing — "hobbit" isn't in the card's name, it's the set. Since we
 * already cache every set name, we can resolve that ourselves: pull the set
 * phrase out of the query, turn it into a set: filter, drop cosmetic words
 * that only describe a treatment, and retry.
 *
 * Anyone who types real Scryfall syntax gets it passed through untouched.
 */

// Words that describe a printing's treatment, not its name. Scryfall has no
// single filter covering all of these, and leaving them in guarantees zero
// hits — dropping them plus a set filter lands the user on the right grid.
const COSMETIC = new Set([
  'foil', 'nonfoil', 'non-foil', 'etched', 'surge', 'borderless', 'extended',
  'showcase', 'retro', 'serialized', 'gilded', 'textured', 'halo', 'confetti',
  'galaxy', 'oilslick', 'step-and-compleat', 'dwarvish', 'elvish', 'phyrexian',
  'gleaming', 'gold', 'fullart', 'full-art', 'alt', 'alternate', 'art', 'promo',
  'version', 'edition', 'variant', 'treatment', 'card', 'mtg', 'magic'
])

// Too generic to identify a set on their own.
const SET_STOPWORDS = new Set([
  'the', 'of', 'and', 'a', 'an', 'in', 'to', 'commander', 'edition', 'tokens',
  'token', 'promos', 'promo', 'art', 'series', 'magic', 'set', 'cards', 'card'
])

// Articles left behind after a set phrase is lifted out ("arcane signet THE
// hobbit"). Scryfall ANDs name words, so dropping these only ever loosens the
// match — "smaug magnificent" still finds "Smaug the Magnificent".
const ARTICLES = new Set(['the', 'a', 'an', 'of', 'and'])

// Set types that hold no cards a collector would track.
const NON_CARD_SET_TYPES = new Set(['token', 'memorabilia', 'minigame', 'art_series', 'vanguard'])

const normalize = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^the\s+/, '')

/**
 * Whole-word containment. Both sides are already normalized to lowercase,
 * single-spaced words, so padding with spaces beats escaping a regex.
 */
const containsWords = (haystack: string, needle: string): boolean =>
  ` ${haystack} `.includes(` ${needle} `)

/** Every string a set can be recognised by: full name plus each colon-separated half. */
function setAliases(s: db.MtgSet): string[] {
  const parts = s.name.split(':')
  return [...new Set([s.name, ...parts].map(normalize).filter(Boolean))]
}

interface SetMatch { phrase: string; codes: string[]; names: string[] }

// A card is very often in the sibling product rather than the headline set —
// LTR's Sol Rings are in the Commander deck (LTC), the Hobbit's Arcane Signet
// is in the Eternal sheet (HOC). Matching one code has to pull in the family.
const PRIMARY_SET_TYPES = ['expansion', 'core', 'commander', 'draft_innovation', 'masters']
const MAX_SET_CLAUSES = 8

/** Matched sets plus their parents and children, best-first and capped. */
function expandSetFamily(codes: string[], sets: db.MtgSet[]): db.MtgSet[] {
  const byCode = new Map(sets.map((s) => [s.code, s]))
  const chosen = new Set(codes)
  for (const c of codes) {
    const parent = byCode.get(c)?.parent_set_code
    if (parent && byCode.has(parent)) chosen.add(parent)
  }
  for (const s of sets) {
    if (s.parent_set_code && chosen.has(s.parent_set_code)) chosen.add(s.code)
  }
  return [...chosen]
    .map((c) => byCode.get(c))
    .filter((s): s is db.MtgSet => !!s)
    .sort((a, b) => {
      const rank = (s: db.MtgSet): number => {
        const i = PRIMARY_SET_TYPES.indexOf(s.set_type ?? '')
        return i === -1 ? PRIMARY_SET_TYPES.length : i
      }
      return rank(a) - rank(b) || (b.card_count ?? 0) - (a.card_count ?? 0)
    })
    .slice(0, MAX_SET_CLAUSES)
}

/** Longest contiguous run of query words that names a real set. */
function matchSetPhrase(words: string[]): SetMatch | null {
  const sets = db.listMtgSets().filter((s) => !s.digital && !NON_CARD_SET_TYPES.has(s.set_type ?? ''))
  if (!sets.length) return null
  const index = sets.map((s) => ({ set: s, aliases: setAliases(s) }))

  // Longest n-gram first so "lord of the rings" beats "rings".
  for (let len = Math.min(5, words.length); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const gram = words.slice(i, i + len).join(' ')
      if (gram.length < 4) continue
      if (len === 1 && SET_STOPWORDS.has(gram)) continue
      // A run of pure treatment words is never a set reference, even though
      // real sets are named things like "Unfinity Foil Edition".
      if (words.slice(i, i + len).every((w) => COSMETIC.has(w))) continue
      const hits = index.filter(({ aliases }) => aliases.some((a) => containsWords(a, gram)))
      if (!hits.length) continue
      const family = expandSetFamily(hits.map((h) => h.set.code), sets)
      return {
        phrase: gram,
        codes: family.map((s) => s.code),
        names: family.map((s) => s.name)
      }
    }
  }
  return null
}

export interface SmartSearch {
  cards: ScryfallCard[]
  sent: string
  rewritten: boolean
  note: string | null
}

/** True when the user typed actual Scryfall syntax and we should not touch it. */
const isExpertQuery = (q: string): boolean => /[:!<>="]/.test(q)

export async function smartSearch(query: string): Promise<SmartSearch> {
  const raw = query.trim()
  if (!raw) return { cards: [], sent: raw, rewritten: false, note: null }

  // Expert syntax, or a plain query that already works — send it as typed.
  if (isExpertQuery(raw)) {
    return { cards: await searchCards(raw), sent: raw, rewritten: false, note: null }
  }
  const direct = await searchCards(raw)
  if (direct.length) return { cards: direct, sent: raw, rewritten: false, note: null }

  // Nothing matched: try to read it as "<card name> <set name> <treatment>".
  const words = normalize(raw).split(' ').filter(Boolean)
  const setMatch = matchSetPhrase(words)
  const setWords = new Set(setMatch ? setMatch.phrase.split(' ') : [])
  const nameWords = words.filter((w) => !setWords.has(w) && !COSMETIC.has(w) && !ARTICLES.has(w))

  if (!setMatch && nameWords.length === words.length) {
    // Nothing to rewrite — it genuinely doesn't match anything.
    return { cards: [], sent: raw, rewritten: false, note: null }
  }

  const setFilter = setMatch
    ? setMatch.codes.length === 1
      ? `set:${setMatch.codes[0]}`
      : `(${setMatch.codes.map((c) => `set:${c}`).join(' or ')})`
    : ''
  const sent = [nameWords.join(' '), setFilter].filter(Boolean).join(' ').trim()
  if (!sent) return { cards: [], sent: raw, rewritten: false, note: null }

  const cards = await searchCards(sent)
  const bits: string[] = []
  if (setMatch) bits.push(`set “${setMatch.phrase}” → ${setMatch.names.slice(0, 3).join(', ')}`)
  const dropped = words.filter((w) => COSMETIC.has(w) && !setWords.has(w))
  if (dropped.length) bits.push(`ignored treatment word${dropped.length > 1 ? 's' : ''} ${dropped.map((d) => `“${d}”`).join(', ')}`)

  return {
    cards,
    sent,
    rewritten: true,
    note: bits.length ? `Searched \`${sent}\` — ${bits.join('; ')}.` : `Searched \`${sent}\`.`
  }
}

/** Batch card lookup by Scryfall id, respecting the 75-per-call / 2-per-second limits. */
export async function cardsByIds(ids: string[]): Promise<Map<string, ScryfallCard>> {
  const out = new Map<string, ScryfallCard>()
  const unique = [...new Set(ids.filter(Boolean))]
  for (let i = 0; i < unique.length; i += COLLECTION_BATCH) {
    const slice = unique.slice(i, i + COLLECTION_BATCH)
    const r = await sfetch<ScryfallList<ScryfallCard>>('/cards/collection', {
      method: 'POST',
      body: JSON.stringify({ identifiers: slice.map((id) => ({ id })) })
    })
    for (const c of r.data ?? []) out.set(c.id, c)
    if (i + COLLECTION_BATCH < unique.length) await sleep(COLLECTION_GAP_MS)
  }
  return out
}

/**
 * Look printings up by set code + collector number — what Forge reports for
 * a card in play. Keyed "set:number" (lowercase set). Misses are omitted.
 */
export async function cardsBySetNumber(items: Array<{ set: string; cn: string }>): Promise<Map<string, ScryfallCard>> {
  const out = new Map<string, ScryfallCard>()
  const unique = [...new Map(items.map((i) => [`${i.set.toLowerCase()}:${i.cn}`, i])).values()]
  for (let i = 0; i < unique.length; i += COLLECTION_BATCH) {
    const slice = unique.slice(i, i + COLLECTION_BATCH)
    const r = await sfetch<ScryfallList<ScryfallCard>>('/cards/collection', {
      method: 'POST',
      body: JSON.stringify({ identifiers: slice.map((x) => ({ set: x.set.toLowerCase(), collector_number: x.cn })) })
    })
    for (const c of r.data ?? []) out.set(`${c.set.toLowerCase()}:${c.collector_number}`, c)
    if (i + COLLECTION_BATCH < unique.length) await sleep(COLLECTION_GAP_MS)
  }
  return out
}

/**
 * Every distinct art Scryfall has for a token: single-faced token printings
 * (`layout:token` — a DFC token's front would be the wrong creature) matching
 * the query. Empty when nothing matches.
 */
export async function tokenArtIds(query: string): Promise<string[]> {
  try {
    const r = await sfetch<ScryfallList<ScryfallCard>>(`/cards/search?unique=art&q=${encodeURIComponent(`layout:token ${query}`)}`)
    return (r.data ?? []).map((c) => c.id)
  } catch (e) {
    if (/Scryfall 404/.test(String(e))) return [] // no matches
    throw e
  }
}

/**
 * Look cards up by exact name — what a pasted decklist gives you. Scryfall
 * returns one representative printing per name; names it cannot match come
 * back in `notFound` so the caller can say which lines were dropped.
 */
export async function cardsByNames(names: string[]): Promise<{ found: ScryfallCard[]; notFound: string[] }> {
  const found: ScryfallCard[] = []
  const notFound: string[] = []
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  for (let i = 0; i < unique.length; i += COLLECTION_BATCH) {
    const slice = unique.slice(i, i + COLLECTION_BATCH)
    const r = await sfetch<ScryfallList<ScryfallCard>>('/cards/collection', {
      method: 'POST',
      // Scryfall matches the front face only for double-faced cards.
      body: JSON.stringify({ identifiers: slice.map((name) => ({ name: name.split(' // ')[0] })) })
    })
    found.push(...(r.data ?? []))
    for (const nf of (r.not_found ?? []) as Array<{ name?: string }>) if (nf.name) notFound.push(nf.name)
    if (i + COLLECTION_BATCH < unique.length) await sleep(COLLECTION_GAP_MS)
  }
  return { found, notFound }
}

// ------------------------------------------------------------- card metadata

/**
 * Colour identity as sorted WUBRG letters — 'B,G' for Golgari, '' for colourless.
 *
 * Sorted in WUBRG order rather than alphabetically because that is the order
 * every Magic player and every other tool prints it in, and stored joined so
 * an "exactly these colours" filter is one string compare.
 */
const WUBRG = ['W', 'U', 'B', 'R', 'G']
export function identityKey(letters: string[] | undefined): string {
  if (!letters?.length) return ''
  return WUBRG.filter((c) => letters.includes(c)).join(',')
}

/**
 * Cache Scryfall facts for every owned card that lacks them.
 *
 * Incremental by design: the vault stores a scryfall id per card but nothing
 * about what the card *is*, and refetching the whole collection to answer a
 * colour filter would be both slow and rude to a free API. Only the gap is
 * pulled, so the steady state after the first run is zero or one batch.
 *
 * Double-faced cards carry mana cost and oracle text per face; the top-level
 * type_line still describes the whole card, so the faces are joined with the
 * same ' // ' separator Scryfall uses in the name.
 */
export async function syncOwnedCardMeta(): Promise<{ fetched: number; missing: number }> {
  const gaps = db.listMtgCardMetaGaps()
  if (!gaps.length) return { fetched: 0, missing: 0 }

  const found = await cardsByIds(gaps)
  for (const [id, c] of found) {
    const faces = c.card_faces as Array<{ mana_cost?: string; oracle_text?: string }> | undefined
    db.upsertMtgCardMeta({
      ext_id: id,
      oracle_id: c.oracle_id ?? null,
      name: c.name,
      set_code: c.set ?? null,
      set_name: c.set_name ?? null,
      collector_number: c.collector_number ?? null,
      rarity: c.rarity ?? null,
      mana_cost: c.mana_cost ?? faces?.map((f) => f.mana_cost ?? '').filter(Boolean).join(' // ') ?? null,
      cmc: c.cmc ?? null,
      type_line: c.type_line ?? null,
      oracle_text: c.oracle_text ?? faces?.map((f) => f.oracle_text ?? '').filter(Boolean).join('\n//\n') ?? null,
      color_identity: identityKey(c.color_identity),
      colors: identityKey(c.colors),
      keywords: c.keywords?.length ? JSON.stringify(c.keywords) : null,
      legal_commander: c.legalities?.commander === 'legal' ? 1 : 0,
      edhrec_rank: c.edhrec_rank ?? null,
      reserved: c.reserved ? 1 : 0
    })
  }
  // A gap Scryfall did not return is a dead id (deleted printing, or a
  // tcgplayer-sourced row). Reported rather than retried forever in silence.
  return { fetched: found.size, missing: gaps.length - found.size }
}

// ---------------------------------------------------------------- sets / calendar

interface ScryfallSet {
  code: string
  name: string
  set_type?: string
  released_at?: string
  card_count?: number
  digital?: boolean
  icon_svg_uri?: string
  scryfall_uri?: string
  parent_set_code?: string
}

/** Set types that represent a real product drop worth calendaring. */
const CALENDARABLE = new Set(['expansion', 'core', 'draft_innovation', 'commander', 'masters'])

/** Refresh the cached set list from Scryfall. Returns how many sets were stored. */
export async function syncSets(): Promise<{ count: number }> {
  const r = await sfetch<ScryfallList<ScryfallSet>>('/sets')
  const sets = (r.data ?? []).filter((s) => !s.digital)
  for (const s of sets) {
    db.upsertMtgSet({
      code: s.code,
      name: s.name,
      set_type: s.set_type ?? null,
      released_at: s.released_at ?? null,
      card_count: s.card_count ?? null,
      digital: s.digital ? 1 : 0,
      icon_svg_uri: s.icon_svg_uri ?? null,
      scryfall_uri: s.scryfall_uri ?? null,
      parent_set_code: s.parent_set_code ?? null
    })
  }
  await sleep(GAP_MS)
  return { count: sets.length }
}

/** 'YYYY-MM-DD' -> epoch ms at LOCAL midnight (these are all-day events, not instants). */
function localMidnight(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
}

const DAY_MS = 86_400_000

/**
 * Project upcoming set releases into the Planner calendar.
 *
 * Idempotent by (source='mtg', external_id): a set whose date slips is moved
 * rather than duplicated, which matters because WotC shifts dates routinely.
 * Prerelease weekend is street date minus 7 days — that is the standard cadence
 * and Scryfall does not publish it separately.
 */
export function syncCalendar(aheadDays = 540): { created: number; updated: number } {
  const now = Date.now()
  const horizon = now + aheadDays * DAY_MS
  let created = 0
  let updated = 0

  for (const s of db.listMtgSets()) {
    if (!s.released_at || !CALENDARABLE.has(s.set_type ?? '')) continue
    const street = localMidnight(s.released_at)
    // Only calendar things that have not happened yet; history belongs in the set list.
    if (street == null || street < now - DAY_MS) continue
    if (street > horizon) continue

    const entries: Array<{ suffix: string; title: string; at: number; notes: string }> = [
      {
        suffix: 'street',
        title: `MTG release — ${s.name}`,
        at: street,
        notes: `${s.name} (${s.code.toUpperCase()}) hits shelves today. ${s.card_count ?? '?'} cards.${s.scryfall_uri ? `\n${s.scryfall_uri}` : ''}`
      },
      {
        suffix: 'prerelease',
        title: `MTG prerelease — ${s.name}`,
        at: street - 7 * DAY_MS,
        notes: `Prerelease weekend for ${s.name} (${s.code.toUpperCase()}) — local stores run sealed events. Street date ${s.released_at}.`
      }
    ]

    for (const e of entries) {
      if (e.at < now - DAY_MS) continue
      const externalId = `mtg:set:${s.code}:${e.suffix}`
      const existing = db.findCalendarEventByExternalId('mtg', externalId)
      if (existing) {
        if (existing.start_at !== e.at || existing.title !== e.title) {
          db.updateCalendarEvent(existing.id, { title: e.title, start_at: e.at, notes: e.notes })
          updated++
        }
      } else {
        db.createCalendarEvent({
          title: e.title,
          start_at: e.at,
          all_day: true,
          notes: e.notes,
          source: 'mtg',
          external_id: externalId,
          tags: ['mtg', s.code]
        })
        created++
      }
    }
  }
  return { created, updated }
}

/** Sets releasing within the window, soonest first. */
export function upcomingSets(aheadDays = 540): db.MtgSet[] {
  const now = Date.now() - DAY_MS
  const horizon = now + aheadDays * DAY_MS
  return db
    .listMtgSets()
    .filter((s) => {
      if (!s.released_at) return false
      const t = localMidnight(s.released_at)
      return t != null && t >= now && t <= horizon
    })
    .sort((a, b) => (a.released_at ?? '').localeCompare(b.released_at ?? ''))
}

// ---------------------------------------------------------------- set valuation

export interface SetCardValue {
  id: string
  name: string
  setCode: string
  collectorNumber: string
  rarity: string
  /**
   * Printed in an earlier set (Scryfall's `reprint`). Null when unknown — a
   * pasted list's card that Scryfall has never heard of is new, not unknown,
   * so this is only null for data that predates the field.
   */
  reprint: boolean | null
  /** Highest price across the finishes this printing exists in. */
  bestPrice: number | null
  bestFinish: string | null
  /** Cheapest available finish — what "one of each" actually costs. */
  cheapestPrice: number | null
  prices: Record<string, number | null>
  promoTypes: string[]
  /**
   * A headliner / serialized chase card. These frequently carry NO Scryfall
   * price at all — too few change hands to establish a market — so ranking on
   * price alone buries the single rarest card in the set beneath the commons.
   */
  notable: boolean
  /**
   * Scryfall's raw `booster` flag, NOT a verdict.
   *
   * It cannot be trusted card-by-card: for Final Fantasy it is true for the 311
   * base printings and false for all 284 special treatments, including the
   * `boosterfun` cards collector boosters exist to sell — and for The Hobbit it
   * is false for all 321 printings, base cards included, because the field was
   * never populated for that set. Consumers decide what to do with it after
   * checking whether the set uses it at all.
   */
  boosterFlag: boolean | null
  imageUrl: string | null
  /** Higher-res full card, for the lightbox. */
  imageLarge: string | null
  /** Just the artwork, frame and text box cropped away. */
  artCrop: string | null
}

export interface SetValuation {
  /**
   * 'list' = a pasted or imported card list; 'product' = one Secret Lair
   * product, sliced out of its shared set (or read off its announcement).
   */
  source?: 'set' | 'list' | 'product'
  sets: Array<{ code: string; name: string }>
  cards: SetCardValue[]
  cardCount: number
  pricedCount: number
  /** Sum of each card's best finish — the "one premium copy of everything" number. */
  totalBest: number
  /** Sum of each card's cheapest finish — the standard "complete the set" number. */
  totalCheapest: number
  note: string | null
}

const SET_VALUE_TTL_MS = 6 * 60 * 60_000
const setValueCache = new Map<string, { at: number; value: SetValuation }>()

/** Every printing in a set, following Scryfall's pagination. */
async function allCardsInSets(codes: string[]): Promise<ScryfallCard[]> {
  const q = codes.length === 1 ? `set:${codes[0]}` : `(${codes.map((c) => `set:${c}`).join(' or ')})`
  const out: ScryfallCard[] = []
  let url = `/cards/search?${new URLSearchParams({ q, unique: 'prints', order: 'usd', dir: 'desc' })}`
  // A big set is a few hundred cards = 2-3 pages at 175/page. Cap the walk so a
  // pathological query can't spin forever.
  for (let page = 0; page < 12 && url; page++) {
    const r = await sfetch<ScryfallList<ScryfallCard> & { has_more?: boolean; next_page?: string }>(url)
    out.push(...(r.data ?? []))
    if (!r.has_more || !r.next_page) break
    url = r.next_page.replace(API, '')
    await sleep(GAP_MS)
  }
  return out
}

/**
 * Value every card in a set, ranked by what it's worth — i.e. the chase list.
 *
 * Ranking uses the BEST finish, not the nonfoil price Scryfall sorts by: the
 * Hobbit's Arcane Signet is $95 nonfoil but $291 foil, and sorting on nonfoil
 * buries exactly the cards a collector is looking for.
 *
 * Accepts a set code or a plain set name, resolved through the same matcher
 * the card search uses — so "hobbit" covers HOB and HOC together.
 */
export async function valueSet(query: string, force = false): Promise<SetValuation> {
  const raw = query.trim()
  if (!raw) return { sets: [], cards: [], cardCount: 0, pricedCount: 0, totalBest: 0, totalCheapest: 0, note: null }

  const known = db.listMtgSets()
  const eligible = known.filter((s) => !s.digital && !NON_CARD_SET_TYPES.has(s.set_type ?? ''))
  const direct = eligible.find((s) => s.code.toLowerCase() === raw.toLowerCase())
  // A bare set code expands to its family exactly like a set NAME does.
  // Without this, "hoc" returned only the Eternal sheet while "hobbit" returned
  // HOB+HOC — so the set's headliner (HOB #249) was missing purely because of
  // which spelling you happened to type.
  const words = normalize(raw).split(' ').filter(Boolean)
  const match = direct ? null : matchSetPhrase(words)
  // A product inside a shared set ("marvel countdown", "history of heroes")
  // wins over a set phrase that only explains PART of the query — otherwise
  // "marvel countdown" lands on every Marvel expansion. A query the set
  // phrase fully explains ("star trek", "hobbit") stays a set search.
  if (!direct) {
    const phraseWords = new Set(match?.phrase.split(' ') ?? [])
    const fullyExplained = match != null && words.every((w) => phraseWords.has(w) || ARTICLES.has(w))
    if (!fullyExplained) {
      const product = await valueProduct(raw)
      if (product) return product
    }
  }
  const chosen = direct
    ? expandSetFamily([direct.code], eligible)
    : known.filter((s) => match?.codes.includes(s.code))

  if (!chosen.length) {
    return {
      sets: [], cards: [], cardCount: 0, pricedCount: 0, totalBest: 0, totalCheapest: 0,
      note: `No set matched “${raw}”. Try the set name (e.g. “hobbit”, “reality fracture”) or its code.`
    }
  }

  const codes = chosen.map((s) => s.code)
  const key = codes.slice().sort().join(',')
  const hit = setValueCache.get(key)
  if (!force && hit && Date.now() - hit.at < SET_VALUE_TTL_MS) return hit.value

  const cards = await allCardsInSets(codes)
  const valued = rankCardValues(cards.map(toCardValue))
  const value: SetValuation = {
    source: 'set',
    sets: chosen.map((s) => ({ code: s.code, name: s.name })),
    cards: valued,
    cardCount: valued.length,
    pricedCount: valued.filter((c) => c.bestPrice != null).length,
    totalBest: Math.round(valued.reduce((sum, c) => sum + (c.bestPrice ?? 0), 0) * 100) / 100,
    totalCheapest: Math.round(valued.reduce((sum, c) => sum + (c.cheapestPrice ?? 0), 0) * 100) / 100,
    note: null
  }
  setValueCache.set(key, { at: Date.now(), value })
  return value
}

function toCardValue(c: ScryfallCard): SetCardValue {
  {
    const finishes = c.finishes?.length ? c.finishes : ['nonfoil']
    const prices: Record<string, number | null> = {}
    let bestPrice: number | null = null
    let bestFinish: string | null = null
    let cheapestPrice: number | null = null
    for (const f of finishes) {
      const p = priceOf(c, f)
      prices[f] = p
      if (p == null) continue
      if (bestPrice == null || p > bestPrice) { bestPrice = p; bestFinish = f }
      if (cheapestPrice == null || p < cheapestPrice) cheapestPrice = p
    }
    const promoTypes = c.promo_types ?? []
    return {
      id: c.id,
      name: c.name,
      setCode: c.set,
      collectorNumber: c.collector_number,
      rarity: c.rarity,
      reprint: typeof c.reprint === 'boolean' ? c.reprint : null,
      bestPrice,
      bestFinish,
      cheapestPrice,
      prices,
      promoTypes,
      notable: promoTypes.some((t) => t === 'headliner' || t === 'serialized'),
      boosterFlag: typeof c.booster === 'boolean' ? c.booster : null,
      imageUrl: imageOf(c),
      imageLarge: imageOf(c, 'large'),
      artCrop: imageOf(c, 'art_crop')
    }
  }
}

/**
 * Three bands, in order: unpriced headliners/serialized (rarest things in the
 * set, no market data), then everything priced, then ordinary unpriced cards.
 * Sorting purely on price put The Hobbit's Gleaming Gold Smaug headliner —
 * ~500 copies, no quote — dead last, below the $0.12 commons.
 */
function rankCardValues(valued: SetCardValue[]): SetCardValue[] {
  const band = (c: SetCardValue): number => (c.bestPrice == null ? (c.notable ? 0 : 2) : 1)
  return valued.sort(
    (a, b) =>
      band(a) - band(b) ||
      (b.bestPrice ?? 0) - (a.bestPrice ?? 0) ||
      a.name.localeCompare(b.name)
  )
}

// ---------------------------------------------------------------- reprint + cEDH insights

/**
 * A pasted card list valued like a set — for a product Scryfall has no set
 * for yet. Secret Lair Countdown Kits and freshly announced drops are
 * spoiled on news sites days before Scryfall files them; the list is the
 * only machine-usable thing there is.
 *
 * Accepts one card per line in any of the usual shapes ("1 Sol Ring",
 * "Sol Ring (SLD) 123", "#63 Doctor Strange, Master of Magic", "Sol Ring x2").
 * The product's own printings don't exist yet, so every row is unpriced;
 * what the list is FOR is the reprint question, which cardInsights answers.
 * A name Scryfall can't match is listed as a new card rather than dropped.
 */
export async function valueCardList(text: string, label?: string): Promise<SetValuation> {
  const names = [...new Set(
    String(text ?? '')
      .split(/\r?\n/)
      .map((l) =>
        l
          .replace(/^\s*(?:[-*•]|\d+\.)\s+/, '') // bullet / "1." list markers
          .replace(/^\s*#?\d+[a-z]?\s*[-–:.)]?\s+(?=\D)/i, '') // "#63 Name", "1 Name", "12 - Name"
          .replace(/\s+x\d+\s*$/i, '')
          .replace(/\s*\([A-Za-z0-9]{2,6}\)\s*[\w★-]*\s*$/, '') // "(SLD) 123"
          .replace(/\s*[—–]\s.*$/, '') // "Name — artist / notes"
          .trim()
      )
      .filter((l) => l.length > 1 && !/^(commander|deck|sideboard|main ?board|cards?)\s*:?$/i.test(l))
  )]
  const title = label?.trim() || 'Pasted card list'
  if (!names.length) {
    return { source: 'list', sets: [], cards: [], cardCount: 0, pricedCount: 0, totalBest: 0, totalCheapest: 0, note: 'Paste one card name per line.' }
  }
  const { found, notFound } = await cardsByNames(names)
  // A card first printed in the last month is this product's new card, even
  // once its printing is out — on release day Scryfall's own printing of
  // Doctor Strange, Master of Magic is dated today and is the only one.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10)
  const cards: SetCardValue[] = []
  const blank = (id: string, name: string): SetCardValue => ({
    id, name, setCode: 'new', collectorNumber: '', rarity: 'unknown', reprint: false,
    bestPrice: null, bestFinish: null, cheapestPrice: null, prices: {}, promoTypes: [], notable: false,
    boosterFlag: null, imageUrl: null, imageLarge: null, artCrop: null
  })
  for (const c of found) {
    // Scryfall answers with SOME printing. A reprint printing means the card
    // is old; an original printing only if it came out over a month ago.
    const existing = Boolean(c.reprint) || (c.released_at ?? '9999') < cutoff
    cards.push({
      ...blank(c.id, c.name),
      setCode: c.set,
      collectorNumber: c.collector_number,
      rarity: c.rarity,
      reprint: existing,
      imageUrl: imageOf(c),
      imageLarge: imageOf(c, 'large'),
      artCrop: imageOf(c, 'art_crop')
    })
  }
  for (const n of notFound) cards.push(blank(`new:${n}`, n))
  const newCount = cards.filter((c) => !c.reprint).length
  return {
    source: 'list',
    sets: [{ code: 'list', name: title }],
    cards,
    cardCount: cards.length,
    pricedCount: 0,
    totalBest: 0,
    totalCheapest: 0,
    note: `${title} — ${cards.length} cards, ${cards.length - newCount} existing (reprints), ${newCount} new` +
      (notFound.length ? ` (no Scryfall match: ${notFound.slice(0, 6).join(', ')}${notFound.length > 6 ? '…' : ''})` : '') + '.'
  }
}

// ---------------------------------------------------------------- products inside shared sets

/**
 * Secret Lair has no set per product: every drop is a run of collector
 * numbers in `sld`, and every Countdown Kit (2022, 2025, 2026…) shares `slc`.
 * So "show me the Marvel box" is answered by finding the PRODUCT, then its
 * slice of the shared set.
 *
 * The link is Lair Tracker's announcement feed (see secretlair.ts): its
 * picture for each lair is a Scryfall image URL, i.e. the Scryfall id of one
 * printing in the drop. That printing gives the set and release date; the
 * drop is the unbroken collector-number run around it on that date. Scryfall
 * files spoiled drops days before release (the Marvel kit was in `slc`
 * #54-83 the day before it went on sale), so this works for upcoming
 * products, not just released ones.
 *
 * When Scryfall has nothing yet, the official announcement page is tried:
 * Wizards tags every card it shows in a `<magic-card>` element.
 */
const SCRYFALL_ID_IN_URL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
const WIZARDS_NEWS = 'https://magic.wizards.com/en/news/announcements/'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const UPCOMING_STALE_MS = 12 * 60 * 60_000

const fold = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

/** Announced Secret Lair products whose name holds every word of the query; one per product (foil editions folded in). */
async function findUpcomingProducts(query: string): Promise<db.MtgSlUpcoming[]> {
  const words = fold(query).split(' ').filter((w) => w.length > 1 && !ARTICLES.has(w))
  if (!words.length) return []
  let rows = db.listUpcomingSecretLair()
  if (!rows.length || rows.every((r) => Date.now() - r.synced_at > UPCOMING_STALE_MS)) {
    await secretlair.syncUpcoming().catch(() => undefined)
    rows = db.listUpcomingSecretLair()
  }
  const hits = rows.filter((r) => {
    const hay = fold(`${r.name} ${r.drop_name ?? ''}`)
    return words.every((w) => hay.includes(w))
  })
  const byProduct = new Map<string, db.MtgSlUpcoming>()
  for (const r of hits.sort((a, b) => a.name.length - b.name.length)) {
    const key = fold(r.name.replace(/\bfoil edition\b/i, ''))
    if (!byProduct.has(key)) byProduct.set(key, r)
  }
  return [...byProduct.values()].sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''))
}

/** Every printing in `set` released on `date`. */
async function cardsReleasedOn(set: string, date: string): Promise<ScryfallCard[]> {
  const out: ScryfallCard[] = []
  let url: string | null = `/cards/search?${new URLSearchParams({ q: `set:${set} date=${date}`, unique: 'prints', order: 'set' })}`
  try {
    for (let page = 0; page < 12 && url; page++) {
      const r: ScryfallList<ScryfallCard> & { has_more?: boolean; next_page?: string } = await sfetch(url)
      out.push(...(r.data ?? []))
      url = r.has_more && r.next_page ? r.next_page.replace(API, '') : null
      if (url) await sleep(GAP_MS)
    }
  } catch (e) {
    if (!/Scryfall 404/.test(String(e))) throw e
  }
  return out
}

/**
 * The collector-number run holding `anchor`: consecutive numbers, a gap of
 * more than one ends it. Drops sold the same day sit side by side in `sld`
 * (Nov 9 2026: #2739-2743 one lair, #2748-2758 two more), so a run can still
 * swallow a neighbour; valueProduct checks the other lairs' anchors and says so.
 */
function runAround(cards: ScryfallCard[], anchor: string): ScryfallCard[] {
  const num = (c: ScryfallCard): number => collectorNumberValue(c.collector_number)
  const sorted = [...cards].sort((a, b) => num(a) - num(b))
  const at = sorted.findIndex((c) => c.collector_number === anchor)
  if (at < 0) return sorted
  let lo = at
  let hi = at
  while (lo > 0 && num(sorted[lo]) - num(sorted[lo - 1]) <= 1) lo--
  while (hi < sorted.length - 1 && num(sorted[hi + 1]) - num(sorted[hi]) <= 1) hi++
  return sorted.slice(lo, hi + 1)
}

function collectorNumberValue(n: string): number {
  const m = /(\d+)/.exec(n)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

export interface PageCard {
  name: string
  /** Card image the page itself shows — the only picture a not-yet-filed new card has. */
  image: string | null
}

/**
 * Cards a Wizards article shows, in page order. Each is a
 * `<magic-card face="…">Name</magic-card>`; the attributes carry HTML of
 * their own (a "Click to Reveal<br>" caption), so the name is read as the
 * text right before the closing tag rather than by parsing the open tag.
 */
function wizardsCards(html: string): PageCard[] {
  const out = new Map<string, PageCard>()
  const re = />([^<>]+)<\/magic-card>/g
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const name = decodeEntities(m[1]).trim()
    if (!name || name.length > 80 || out.has(name)) continue
    const open = html.lastIndexOf('<magic-card', m.index)
    const face = open >= 0 ? /\bface="([^"]+)"/.exec(html.slice(open, m.index)) : null
    out.set(name, { name, image: face ? decodeEntities(face[1]) : null })
  }
  return [...out.values()]
}

let cardNameCatalog: { at: number; byFirst: Map<string, string[]>; front: Map<string, string> } | null = null

/**
 * Scryfall's list of every card name, indexed by first word, so a page can be
 * scanned for names in one pass instead of 35k substring searches.
 */
async function nameCatalog(): Promise<NonNullable<typeof cardNameCatalog>> {
  if (cardNameCatalog && Date.now() - cardNameCatalog.at < 24 * 60 * 60_000) return cardNameCatalog
  const r = await sfetch<{ data?: string[] }>('/catalog/card-names')
  const byFirst = new Map<string, string[]>()
  const front = new Map<string, string>()
  const add = (shown: string, full: string): void => {
    const first = shown.split(' ')[0]
    const list = byFirst.get(first) ?? []
    list.push(shown)
    byFirst.set(first, list)
    if (shown !== full) front.set(shown, full)
  }
  for (const full of r.data ?? []) {
    add(full, full)
    // Articles name a double-faced card by its front face.
    if (full.includes(' // ')) add(full.split(' // ')[0], full)
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.length - a.length)
  cardNameCatalog = { at: Date.now(), byFirst, front }
  return cardNameCatalog
}

/**
 * Known card names mentioned in arbitrary page text — for spoiler articles
 * and threads that don't tag their cards. Case-sensitive (names are written
 * capitalised), longest name wins at each position. Finds reprints only: a
 * brand-new card's name isn't in the catalogue yet.
 */
async function namesInText(text: string): Promise<string[]> {
  const { byFirst, front } = await nameCatalog()
  const found: string[] = []
  const seen = new Set<string>()
  const counts = new Map<string, number>()
  const re = /[A-Z0-9][^\s,.;:!?()"“”]*/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const cands = byFirst.get(m[0]) ?? byFirst.get(m[0].replace(/[’]/g, "'"))
    if (!cands) continue
    const rest = text.slice(m.index, m.index + 160).replace(/’/g, "'")
    const hit = cands.find((n) => rest.startsWith(n) && !/[A-Za-z0-9]/.test(rest.charAt(n.length)))
    if (!hit) continue
    const full = front.get(hit) ?? hit
    counts.set(full, (counts.get(full) ?? 0) + 1)
    if (!seen.has(full)) { seen.add(full); found.push(full) }
    re.lastIndex = m.index + hit.length
  }
  // One-word names ("Damn", "Order", "Rarity") are also ordinary words; keep
  // them only when the page uses them more than once.
  return found.filter((n) => n.includes(' ') || (counts.get(n) ?? 0) > 1)
}

/**
 * The text of a page's list-shaped parts — list items, table cells, headings,
 * bold runs, captions, links. Spoiler articles put the card list there; the
 * prose around it mentions other cards in passing ("as strong as Rhystic
 * Study"), so this is scanned first and the full text only as a fallback.
 */
function structuredText(html: string): string {
  const parts: string[] = []
  const re = /<(li|td|th|h[1-6]|strong|b|figcaption|a)\b[^>]*>([\s\S]*?)<\/\1>/gi
  for (let m = re.exec(html); m; m = re.exec(html)) parts.push(m[2])
  return stripTags(parts.join(' \n '))
}

const stripTags = (html: string): string =>
  decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ')

async function fetchPage(url: string): Promise<{ html: string; title: string | null } | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' } })
    if (!r.ok) return null
    const html = await r.text()
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
    return { html, title: t ? decodeEntities(t[1]).replace(/\s*[|–-]\s*Magic: The Gathering.*$/i, '').trim() : null }
  } catch {
    return null
  }
}

/**
 * A pasted/imported list of names valued like a set, with page images filling
 * in for new cards Scryfall doesn't have.
 */
async function valueNames(names: string[], title: string, images?: Map<string, string | null>): Promise<SetValuation> {
  const v = await valueCardList(names.join('\n'), title)
  if (images) for (const c of v.cards) if (!c.imageUrl) c.imageUrl = c.imageLarge = images.get(c.name) ?? null
  return v
}

/**
 * The card list on any web page: an official Wizards article (tagged cards,
 * new ones included, with their images) or anything else (known card names
 * found in the text — reprints only, and worth a glance for strays).
 */
export async function valueFromUrl(url: string): Promise<SetValuation> {
  let u: URL
  try {
    u = new URL(String(url).trim())
    if (!/^https?:$/.test(u.protocol)) throw new Error('not http')
  } catch {
    return { source: 'list', sets: [], cards: [], cardCount: 0, pricedCount: 0, totalBest: 0, totalCheapest: 0, note: 'That is not a web address.' }
  }
  const page = await fetchPage(u.toString())
  const empty = (note: string): SetValuation => ({ source: 'list', sets: [], cards: [], cardCount: 0, pricedCount: 0, totalBest: 0, totalCheapest: 0, note })
  if (!page) return empty(`Couldn't load ${u.hostname} — the page refused or isn't there.`)
  const title = page.title || u.hostname
  const tagged = wizardsCards(page.html)
  if (tagged.length >= 3) {
    const v = await valueNames(tagged.map((c) => c.name), title, new Map(tagged.map((c) => [c.name, c.image])))
    return { ...v, note: `${v.note} Read from the cards tagged on ${u.hostname}.` }
  }
  const body = page.html.replace(/<(script|style|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
  let names = await namesInText(structuredText(body))
  if (names.length < 5) names = await namesInText(stripTags(body))
  if (!names.length) return empty(`No card names found on ${u.hostname}. Pages that load their content with script can't be read — paste the list instead.`)
  const v = await valueNames(names, title)
  return {
    ...v,
    note: `${v.note} Matched by card name on ${u.hostname} — a new card shows up only once Scryfall lists it, and cards the page merely mentions can slip in, so check the list.`
  }
}

/**
 * A Secret Lair product's card list, by product name. Null when no announced
 * product matches, so the caller can fall back to a set search.
 */
export async function valueProduct(query: string): Promise<SetValuation | null> {
  const products = await findUpcomingProducts(query)
  if (!products.length) return null
  const p = products[0]
  const others = products.slice(1).map((o) => o.name)
  const otherNote = others.length ? ` Also matched: ${others.slice(0, 4).join('; ')}${others.length > 4 ? '…' : ''}.` : ''
  const msrp = p.msrp != null ? ` · MSRP $${p.msrp.toFixed(2)}` : ''

  const anchorId = SCRYFALL_ID_IN_URL.exec(p.picture ?? '')?.[1]
  let anchor: ScryfallCard | null = null
  if (anchorId) {
    try { anchor = await sfetch<ScryfallCard>(`/cards/${anchorId}`) } catch { anchor = null }
  }
  if (anchor?.released_at) {
    const sameDay = await cardsReleasedOn(anchor.set, anchor.released_at)
    const run = runAround(sameDay, anchor.collector_number)
    if (run.length) {
      // Did the run swallow a neighbouring lair sold the same day?
      const runIds = new Set(run.map((c) => c.id))
      const neighbours = db.listUpcomingSecretLair().filter((o) => {
        const id = SCRYFALL_ID_IN_URL.exec(o.picture ?? '')?.[1]
        return id && id !== anchor?.id && runIds.has(id) && fold(o.name.replace(/\bfoil edition\b/i, '')) !== fold(p.name.replace(/\bfoil edition\b/i, ''))
      })
      const merged = neighbours.length
        ? ` This run of numbers also holds ${[...new Set(neighbours.map((n) => n.name))].join(', ')} — Scryfall doesn't mark where one drop ends, so some cards here may belong to it.`
        : ''
      const valued = rankCardValues(run.map(toCardValue))
      const first = run[0].collector_number
      const last = run[run.length - 1].collector_number
      return {
        source: 'product',
        sets: [{ code: anchor.set, name: p.name }],
        cards: valued,
        cardCount: valued.length,
        pricedCount: valued.filter((c) => c.bestPrice != null).length,
        totalBest: Math.round(valued.reduce((s, c) => s + (c.bestPrice ?? 0), 0) * 100) / 100,
        totalCheapest: Math.round(valued.reduce((s, c) => s + (c.cheapestPrice ?? 0), 0) * 100) / 100,
        note: `${p.name} — ${anchor.set.toUpperCase()} #${first}–${last}, ${valued.length} cards, releases ${p.release_date ?? anchor.released_at}${msrp}.${merged}${otherNote}`
      }
    }
  }

  // Not on Scryfall yet: the official announcement, if its address is the
  // product name (Wizards' usual slug: "secret-lair-countdown-kit-marvels-history-of-heroes").
  const slug = fold(p.name).replace(/ /g, '-')
  const page = await fetchPage(WIZARDS_NEWS + slug)
  const tagged = page ? wizardsCards(page.html) : []
  if (tagged.length >= 3) {
    const v = await valueNames(tagged.map((c) => c.name), p.name, new Map(tagged.map((c) => [c.name, c.image])))
    return { ...v, source: 'product', note: `${v.note} Card list from the Wizards announcement — Scryfall hasn't filed this drop yet${msrp}.${otherNote}` }
  }
  return {
    source: 'product',
    sets: [{ code: 'sl', name: p.name }],
    cards: [], cardCount: 0, pricedCount: 0, totalBest: 0, totalCheapest: 0,
    note: `${p.name} is announced (releases ${p.release_date ?? 'TBA'}${msrp}) but no card list is published where ATLIS can read it yet. Paste the list, or import it from the article's URL.${otherNote}`
  }
}

export interface CheapestPrinting {
  id: string
  price: number
  finish: string
  setCode: string
  setName: string
  collectorNumber: string
}

export interface CardInsight {
  /** Paper printings of this card OUTSIDE the product being looked at. */
  otherPrintings: number
  /** The cheapest of those, across every finish. Null when none is priced. */
  cheapest: CheapestPrinting | null
  /** cEDH tournament play rate 0..1; null = not seen in tournament decks (or unknown — see cedhSource). */
  cedhRate: number | null
  cedhSource: cedh.CedhRateSource
}

export interface CardInsights {
  cards: Record<string, CardInsight>
  /** Why some of the cEDH column is missing or approximate, when it is. */
  cedhNote: string | null
  priceNote: string | null
}

const BASIC_NAMES = new Set(
  ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'].flatMap((b) => [b, `Snow-Covered ${b}`])
)
// Not a "printing you could buy instead": art cards, tokens, oversized promos.
const NOT_A_PRINTING = new Set(['memorabilia', 'token', 'minigame', 'vanguard', 'planechase', 'archenemy'])
const ELSEWHERE_TTL_MS = 6 * 60 * 60_000
const elsewhereCache = new Map<string, { at: number; v: Omit<CardInsight, 'cedhRate' | 'cedhSource'> }>()

/**
 * For each name, the cheapest paper printing that is NOT in `excludeSets`.
 *
 * Excluding the product's own sets is the point: a spoiled reprint's new
 * printing has no price yet, and once it does it is the thing being judged —
 * the question is what the card costs if you skip this product.
 *
 * One exact-name search per batch of names (`!"A" or !"B" …`), every page
 * walked because the price minimum can sit on any finish of any printing.
 * Basic lands are skipped: hundreds of printings each, and never the reason
 * to buy anything.
 */
async function cheapestElsewhere(names: string[], excludeSets: string[], excludeIds: string[] = []): Promise<Map<string, Omit<CardInsight, 'cedhRate' | 'cedhSource'>>> {
  const exclude = [...new Set(excludeSets.map((s) => s.toLowerCase()).filter((s) => /^[a-z0-9]+$/.test(s)))].sort()
  const skipIds = new Set(excludeIds)
  const exKey = `${exclude.join(',')}|${[...skipIds].sort().join(',')}`
  const out = new Map<string, Omit<CardInsight, 'cedhRate' | 'cedhSource'>>()
  const todo: string[] = []
  for (const n of new Set(names)) {
    if (BASIC_NAMES.has(n) || n.includes('"')) continue
    const hit = elsewhereCache.get(`${n}|${exKey}`)
    if (hit && Date.now() - hit.at < ELSEWHERE_TTL_MS) out.set(n, hit.v)
    else todo.push(n)
  }
  const suffix = ['game:paper', ...exclude.map((c) => `-set:${c}`)].join(' ')
  const batches: string[][] = []
  for (const n of todo) {
    const last = batches[batches.length - 1]
    const len = last ? last.reduce((s, x) => s + x.length + 8, 0) : Infinity
    if (!last || last.length >= 20 || len + n.length > 700) batches.push([n])
    else last.push(n)
  }
  for (const batch of batches) {
    const acc = new Map<string, Omit<CardInsight, 'cedhRate' | 'cedhSource'>>(batch.map((n) => [n, { otherPrintings: 0, cheapest: null }]))
    const q = `(${batch.map((n) => `!"${n}"`).join(' or ')}) ${suffix}`
    let url: string | null = `/cards/search?${new URLSearchParams({ q, unique: 'prints', order: 'usd', dir: 'asc' })}`
    try {
      for (let page = 0; page < 15 && url; page++) {
        const r: ScryfallList<ScryfallCard> & { has_more?: boolean; next_page?: string } = await sfetch(url)
        for (const c of r.data ?? []) {
          const a = acc.get(c.name)
          if (!a || NOT_A_PRINTING.has(c.set_type ?? '') || skipIds.has(c.id)) continue
          a.otherPrintings++
          for (const f of c.finishes?.length ? c.finishes : ['nonfoil']) {
            const p = priceOf(c, f)
            if (p == null || (a.cheapest && a.cheapest.price <= p)) continue
            // A bad USD quote on a rare printing would win "cheapest" outright:
            // Summer Magic Lightning Bolt is quoted $0.10 beside €5,017. When
            // the EUR quote for the same finish disagrees 20x, skip it.
            const eur = Number(c.prices?.[f === 'foil' ? 'eur_foil' : f === 'etched' ? 'eur_etched' : 'eur'])
            if (isFinite(eur) && eur > 50 && eur > p * 20) continue
            a.cheapest = { id: c.id, price: p, finish: f, setCode: c.set, setName: c.set_name, collectorNumber: c.collector_number }
          }
        }
        url = r.has_more && r.next_page ? r.next_page.replace(API, '') : null
        await sleep(GAP_MS)
      }
    } catch (e) {
      // 404 = none of these names has a printing outside the product.
      if (!/Scryfall 404/.test(String(e))) throw e
    }
    for (const [n, v] of acc) {
      out.set(n, v)
      elsewhereCache.set(`${n}|${exKey}`, { at: Date.now(), v })
    }
  }
  return out
}

/**
 * Reprint price + cEDH play rate for the cards of a set or pasted list.
 * Separate from valueSet() because it costs a request per ~20 reprints and
 * the card list shouldn't wait on it.
 *
 * `reprintNames` are looked up for a cheapest-elsewhere price; `allNames`
 * get a cEDH rate (a new card can be a staple too, once it has been played).
 * A product inside a shared set passes its own printings as `excludeIds`
 * rather than excluding the set: leaving out all of `sld` would hide the
 * Secret Lair printings that are often the cheapest copy around.
 */
export async function cardInsights(
  allNames: string[],
  reprintNames: string[],
  excludeSets: string[],
  excludeIds: string[] = []
): Promise<CardInsights> {
  const names = [...new Set(allNames.map((n) => String(n)).filter(Boolean))]
  const [elsewhere, rates] = await Promise.all([
    cheapestElsewhere(reprintNames.map(String), excludeSets.map(String), excludeIds.map(String)),
    cedh.playRates(names.filter((n) => !BASIC_NAMES.has(n)))
  ])
  const cards: Record<string, CardInsight> = {}
  for (const n of names) {
    const e = elsewhere.get(n)
    const r = rates.rates.get(n)
    cards[n] = {
      otherPrintings: e?.otherPrintings ?? 0,
      cheapest: e?.cheapest ?? null,
      cedhRate: r?.rate ?? null,
      cedhSource: r?.source ?? 'none'
    }
  }
  const unpriced = reprintNames.filter((n) => elsewhere.has(n) && !elsewhere.get(n)?.cheapest).length
  return {
    cards,
    cedhNote: rates.note,
    priceNote: unpriced ? `${unpriced} reprint(s) have no priced printing outside this product.` : null
  }
}

// ---------------------------------------------------------------- pack EV

/**
 * Expected value of ripping a booster.
 *
 * Slot structures below are taken from the products' own published contents
 * (the Target listings for The Hobbit state them verbatim), not guessed. The
 * mythic rate in a rare-or-better slot is the long-standing 1-in-7.4.
 *
 * Reported as a DISTRIBUTION, not a single number, because the mean is a poor
 * description of pack opening: a handful of chase cards drag it far above what
 * a typical pack returns, so mean and median can differ by 3x or more.
 *
 * Known limits, all of which push the honest number DOWN:
 *  - Prices are retail asks. Selling into a buylist realises roughly half.
 *  - Bulk is counted at face value even though nobody buys $0.02 commons,
 *    which is why a liquid-only figure is reported alongside the raw one.
 *  - Serialized / headliner cards carry no price at all, so the biggest
 *    possible hit contributes ZERO here rather than inflating the average.
 *  - Special-treatment slots in Collector Boosters are approximated by
 *    drawing from the whole priced pool for that rarity.
 */
const MYTHIC_RATE = 1 / 7.4

export type BoosterType = 'play' | 'collector'

interface SlotModel {
  cards: number
  /** Guaranteed rare-or-better slots. */
  rares: number
  /** Extra rare slots, each with its own probability. */
  bonusRares: number[]
  uncommons: number
  commons: number
  /** Fraction of the pack that comes foil. */
  foilShare: number
  /**
   * Fraction of rare-or-better slots that come as a SPECIAL TREATMENT
   * (borderless, showcase, extended art) rather than the base printing.
   *
   * This exists because premium printings dominate the pool by COUNT while
   * being far rarer per pack: 61% of Final Fantasy's priced mythics and 56% of
   * its rares are premium treatments, so drawing uniformly hands out a $1,932
   * serialized mythic as readily as a $35 base one. Collector Boosters are
   * sold on their special treatments, so most of their rare slots are premium;
   * a Play Booster gets one at most, and usually none.
   */
  premiumShare: number
  label: string
}

const SLOTS: Record<BoosterType, SlotModel> = {
  // "1–3 cards of rarity Rare or higher (2: 26%; 3: 2%), 3–5 Uncommon,
  //  7–9 Common, 1 land, 1 card of any rarity is traditional foil"
  play: {
    cards: 14,
    rares: 1,
    bonusRares: [0.26, 0.02],
    uncommons: 4,
    commons: 8,
    foilShare: 1 / 14,
    premiumShare: 0.1,
    label: 'Play Booster — 14 cards'
  },
  // "5 cards of rarity Rare or higher, 4 Uncommon, 5 Common, 1 Land,
  //  0–2 Surge Foil and 11–13 Traditional Foil"
  collector: {
    cards: 15,
    rares: 5,
    bonusRares: [],
    uncommons: 4,
    commons: 5,
    foilShare: 12 / 15,
    premiumShare: 0.75,
    label: 'Collector Booster — 15 cards'
  }
}

export interface PackEvResult {
  sets: Array<{ code: string; name: string }>
  booster: string
  boosterType: BoosterType
  simulations: number
  poolSizes: Record<string, number>
  mean: number
  median: number
  p10: number
  p90: number
  /** Same simulation, counting only cards worth at least `liquidThreshold`. */
  meanLiquid: number
  medianLiquid: number
  liquidThreshold: number
  packPrice: number | null
  chanceOfProfit: number | null
  topHits: Array<{ name: string; setCode: string; collectorNumber: string; price: number; finish: string; chancePerPack: number }>
  unpricedChase: number
  /**
   * Where the pack structure came from. 'sheets' is MTGJSON's published print
   * sheets — exact card-level pull weights. 'model' is the slot-and-rarity
   * approximation used when a set hasn't published them (unreleased sets), and
   * is materially less trustworthy for anything with rare chase printings.
   */
  basis: 'sheets' | 'model'
  note: string | null
}

interface PoolCard { name: string; setCode: string; collectorNumber: string; nonfoil: number | null; foil: number | null; premium: boolean }

/**
 * One CARD, with its printings split by treatment.
 *
 * Sampling has to happen at the card level, not the printing level. A card with
 * one base and four premium printings would otherwise be drawn five times as
 * often as a card with a single printing — a pure artefact of how many ways
 * Wizards chose to print it, which has nothing to do with what a pack contains.
 */
interface PoolEntry { base: PoolCard[]; premium: PoolCard[] }

/**
 * Where a set's base run ends and its special treatments begin.
 *
 * MTGJSON publishes this as `baseSetSize` (Final Fantasy: 309 base of 598
 * total), which beats inferring it. An earlier attempt guessed the boundary
 * from gaps in the collector numbering and got it wrong, because modern sets
 * number their borderless and showcase printings CONTIGUOUSLY after the base
 * run — there is no gap to find. Returns Infinity when unknown, so nothing is
 * misclassified as premium on a bad guess.
 */
async function baseRunSize(mainCode: string | undefined): Promise<number> {
  if (!mainCode) return Infinity
  const data = await mtgjsonSet(mainCode)
  const n = data?.baseSetSize
  return typeof n === 'number' && n > 0 ? n : Infinity
}

const pickOne = <T,>(arr: T[]): T | null => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : null)

/** Pick a card, then which printing of it — premium at the slot's own rate. */
function pickPrinting(pool: PoolEntry[], premiumShare: number): PoolCard | null {
  const entry = pickOne(pool)
  if (!entry) return null
  const wantPremium = Math.random() < premiumShare
  const side = wantPremium ? entry.premium : entry.base
  return pickOne(side.length ? side : wantPremium ? entry.base : entry.premium)
}

/**
 * How many boosters of each type a unit contains. A single pack is `{play:1}`
 * or `{collector:1}`; a Collector Booster Box is `{collector:12}`; a case is
 * `{collector:72}`; a bundle is `{play:9}` plus a fixed deterministic value.
 */
export type PackComposition = Partial<Record<BoosterType, number>>

/**
 * A simulation is only as good as the pool it draws from, and Scryfall's
 * coverage of an UNRELEASED set is a handful of preorder asks on its chase
 * cards — nothing else has a market yet. Star Trek measured 9 of 177 printings
 * priced: a 2-card rare pool at ~$40 and a 2-card mythic pool at ~$100. Drawing
 * five rare-or-better slots out of that produced a "+1403% return" on a booster
 * box, with the median sitting on top of the mean because every simulated pack
 * was nearly identical.
 *
 * So a set has to be properly priced before its EV means anything. These
 * thresholds are deliberately blunt: a real, released set prices ~99% of its
 * printings and carries hundreds of rares.
 */
/**
 * Set types whose cards can actually come out of a booster.
 *
 * `valueSet` deliberately spans a whole set FAMILY — that is right for "what is
 * this set worth", and wrong for "what is in a pack". Final Fantasy's family
 * carries 486 Commander-set cards (Y'shtola at $1,152) and promo sheets
 * (Force of Negation at $1,501) that no booster has ever contained; leaving
 * them in the pool inflates every rare slot. Bonus sheets (masterpiece) DO ride
 * along in collector boosters, so they stay.
 */
const BOOSTER_SET_TYPES = new Set(['expansion', 'core', 'draft_innovation', 'masterpiece', 'funny'])

const MIN_PRICE_COVERAGE = 0.8
const MIN_RARE_POOL = 15
const MIN_TOTAL_POOL = 60

/**
 * Simulate opening a unit and report the value distribution.
 *
 * The unit is simulated WHOLE — every pack in a box is drawn inside the same
 * trial — because that is the only way the median and the percentiles mean
 * anything. Mean scales linearly with pack count, but nothing else does: a box
 * of twelve packs has a far tighter spread than twelve times one pack, and
 * "chance of profit" on a box is a completely different number from the
 * chance on a single pack.
 *
 * `unitPrice` (optional) turns the result into a chance-of-profit figure.
 * `fixedValue` is deterministic content riding along (a bundle's decklist),
 * added to every trial.
 */
export async function unitEv(
  query: string,
  composition: PackComposition,
  simulations = 20_000,
  unitPrice: number | null = null,
  fixedValue = 0
): Promise<PackEvResult> {
  const primary = (Object.keys(composition) as BoosterType[]).find((k) => (composition[k] ?? 0) > 0) ?? 'collector'
  const totalPacks = Object.values(composition).reduce<number>((n, v) => n + (v ?? 0), 0)
  const valuation = await valueSet(query)
  const label =
    totalPacks === 1
      ? SLOTS[primary].label
      : `${Object.entries(composition)
          .filter(([, n]) => (n ?? 0) > 0)
          .map(([k, n]) => `${n}× ${SLOTS[k as BoosterType].label}`)
          .join(' + ')}`
  const empty: PackEvResult = {
    sets: valuation.sets, booster: label, boosterType: primary, simulations: 0,
    poolSizes: {}, mean: 0, median: 0, p10: 0, p90: 0, meanLiquid: 0, medianLiquid: 0,
    liquidThreshold: 2, packPrice: unitPrice, chanceOfProfit: null, topHits: [], unpricedChase: 0,
    basis: 'model', note: valuation.note ?? 'No cards found for that set.'
  }
  if (!valuation.cardCount) return empty
  if (!totalPacks) return { ...empty, note: 'That product contains no booster packs.' }

  // Play Boosters carry only the main set; Collector Boosters also carry the
  // bonus sheet and the high-numbered premium treatments — so each booster
  // type draws from its own pool even inside one mixed unit.
  // The set the caller named, not whichever family member happens to sort
  // first: the play-booster pool and the sheet lookup both key off this, and a
  // promo child standing in for the main set empties both.
  const asked = query.trim().toLowerCase()
  const mainCode = valuation.sets.find((x) => x.code.toLowerCase() === asked)?.code ?? valuation.sets[0]?.code
  const knownSets = new Map(db.listMtgSets().map((x) => [x.code, x]))
  const boosterEligible = (code: string): boolean =>
    code === mainCode || BOOSTER_SET_TYPES.has(knownSets.get(code)?.set_type ?? '')
  let unpricedChase = 0
  const baseRun = await baseRunSize(mainCode)
  /**
   * Which printings the fallback model may draw.
   *
   * Scryfall's `booster` flag is only consulted when the set actually populates
   * it — The Hobbit marks all 321 of its printings false, so filtering on it
   * blindly left an empty pool and reported "0 of 0 printings priced" for the
   * whole set. Serialized and headliner inserts are always excluded: their pull
   * rates are unrepresentable without sheet data, and one of them at the wrong
   * frequency sets the entire mean.
   */
  const flagUsable = valuation.cards.some((c) => c.boosterFlag === true)
  const pullable = valuation.cards.filter((c) => {
    if (c.promoTypes.includes('serialized') || c.promoTypes.includes('headliner')) return false
    if (!flagUsable) return true
    return c.boosterFlag === true || c.promoTypes.includes('boosterfun')
  })
  const poolsFor = (type: BoosterType): Record<string, PoolEntry[]> => {
    const inScope =
      type === 'play'
        ? pullable.filter((c) => c.setCode === mainCode && Number(c.collectorNumber.replace(/\D/g, '')) <= baseRun)
        : pullable.filter((c) => boosterEligible(c.setCode))
    // No separate land slot: basic lands carry Scryfall rarity 'common' and are
    // worth ~$0, so folding them into commons changes the result by cents.
    const byName: Record<string, Map<string, PoolEntry>> = {
      mythic: new Map(), rare: new Map(), uncommon: new Map(), common: new Map()
    }
    for (const c of inScope) {
      const nonfoil = c.prices.nonfoil ?? null
      const foil = c.prices.foil ?? c.prices.etched ?? null
      if (nonfoil == null && foil == null) continue
      const bucket = byName[c.rarity] ? c.rarity : 'common'
      const num = Number(c.collectorNumber.replace(/\D/g, ''))
      const premium = c.setCode !== mainCode || !isFinite(num) || num > baseRun
      const card: PoolCard = {
        name: c.name, setCode: c.setCode, collectorNumber: c.collectorNumber, nonfoil, foil, premium
      }
      const entry = byName[bucket].get(c.name) ?? { base: [], premium: [] }
      ;(premium ? entry.premium : entry.base).push(card)
      byName[bucket].set(c.name, entry)
    }
    return {
      mythic: [...byName.mythic.values()],
      rare: [...byName.rare.values()],
      uncommon: [...byName.uncommon.values()],
      common: [...byName.common.values()]
    }
  }
  for (const c of valuation.cards) if (c.notable && c.bestPrice == null && boosterEligible(c.setCode)) unpricedChase++

  const active = (Object.keys(composition) as BoosterType[]).filter((t) => (composition[t] ?? 0) > 0)

  /**
   * Prefer MTGJSON's published print sheets. They give the real per-card pull
   * weights, so nothing about slot counts, mythic rates, foil share or how
   * often a chase printing appears has to be assumed — and they define the
   * pack's contents outright, which makes every pool heuristic below moot.
   */
  const sheetModels = new Map<BoosterType, boosters.BoosterModel>()
  for (const t of active) {
    const m = await boosters.loadBoosterModel(mainCode ?? '', t as boosters.SheetBoosterType)
    if (m) sheetModels.set(t, m)
  }
  const basis: 'sheets' | 'model' = sheetModels.size === active.length ? 'sheets' : 'model'

  // The approximation's pools are only built — and only gated — when the real
  // sheets aren't available. Applying pool heuristics to a sheet-driven
  // simulation is what silently blanked whole sets.
  const poolsByType = new Map(basis === 'model' ? active.map((t) => [t, poolsFor(t)]) : [])
  const pools = (poolsByType.get(primary) ?? { mythic: [], rare: [], uncommon: [], common: [] }) as Record<string, PoolEntry[]>

  if (basis === 'model') {
    // Coverage gate — refuse rather than produce a confident wrong number.
    // Measured over the cards a booster can actually contain.
    const eligible = pullable.filter((c) => boosterEligible(c.setCode))
    const pricedEligible = eligible.filter((c) => c.bestPrice != null).length
    const coverage = eligible.length ? pricedEligible / eligible.length : 0
    if (coverage < MIN_PRICE_COVERAGE) {
      return {
        ...empty,
        note: `Only ${Math.round(coverage * 100)}% of this set has a price (${pricedEligible} of ${eligible.length} printings), so there is no pool to simulate against. Sets price up over the weeks after release — before then the only quotes are preorder asks on the chase cards, which would make every pack look like a jackpot.`
      }
    }
    for (const t of active) {
      const p = poolsByType.get(t) as Record<string, PoolEntry[]>
      const rares = p.rare.length + p.mythic.length
      const total = Object.values(p).reduce((n, arr) => n + arr.length, 0)
      if (rares < MIN_RARE_POOL || total < MIN_TOTAL_POOL) {
        return {
          ...empty,
          note: `Not enough priced cards to simulate a ${SLOTS[t].label} for this set — ${rares} priced rare(s) and ${total} priced card(s) in total. A released set carries hundreds.`
        }
      }
    }
  }

  // Sheets reference cards by Scryfall id, including printings the family
  // valuation may not cover, so anything missing is fetched once.
  const priceById = new Map<string, { nonfoil: number | null; foil: number | null; card: PoolCard }>()
  if (basis === 'sheets') {
    for (const c of valuation.cards) {
      priceById.set(c.id, {
        nonfoil: c.prices.nonfoil ?? null,
        foil: c.prices.foil ?? c.prices.etched ?? null,
        card: {
          name: c.name, setCode: c.setCode, collectorNumber: c.collectorNumber,
          nonfoil: c.prices.nonfoil ?? null, foil: c.prices.foil ?? c.prices.etched ?? null, premium: false
        }
      })
    }
    const missing = [...new Set([...sheetModels.values()].flatMap((m) => m.allIds))].filter((id) => !priceById.has(id))
    if (missing.length) {
      const fetched = await cardsByIds(missing)
      for (const [id, c] of fetched) {
        const nonfoil = priceOf(c, 'nonfoil')
        const foil = priceOf(c, 'foil') ?? priceOf(c, 'etched')
        priceById.set(id, {
          nonfoil,
          foil,
          card: { name: c.name, setCode: c.set, collectorNumber: c.collector_number, nonfoil, foil, premium: false }
        })
      }
    }

    // Sheets say what's in the pack; prices still have to exist for it to mean
    // anything. Measured over the sheet cards themselves, which is the exact
    // universe being drawn from.
    const sheetIds = [...new Set([...sheetModels.values()].flatMap((m) => m.allIds))]
    const pricedSheet = sheetIds.filter((id) => {
      const e = priceById.get(id)
      return e && (e.nonfoil != null || e.foil != null)
    }).length
    const sheetCoverage = sheetIds.length ? pricedSheet / sheetIds.length : 0
    if (sheetCoverage < MIN_PRICE_COVERAGE) {
      return {
        ...empty,
        note: `Only ${Math.round(sheetCoverage * 100)}% of the cards on this set's print sheets have a price (${pricedSheet} of ${sheetIds.length}), so there is nothing solid to value a pack against yet. Sets price up over the weeks after release.`
      }
    }
  }

  const LIQUID = 2
  const totals: number[] = []
  const liquidTotals: number[] = []
  const hitCounts = new Map<string, { card: PoolCard; finish: string; price: number; hits: number }>()

  for (let i = 0; i < simulations; i++) {
    let sum = fixedValue
    let liquid = fixedValue
    const draw = (pool: PoolEntry[], foil: boolean, premiumShare: number): void => {
      const c = pickPrinting(pool, premiumShare)
      if (!c) return
      const price = (foil ? c.foil ?? c.nonfoil : c.nonfoil ?? c.foil) ?? 0
      sum += price
      if (price >= LIQUID) liquid += price
      // Track the cards that actually move the number.
      if (price >= 20) {
        const key = `${c.setCode}#${c.collectorNumber}:${foil ? 'foil' : 'nonfoil'}`
        const e = hitCounts.get(key) ?? { card: c, finish: foil ? 'foil' : 'nonfoil', price, hits: 0 }
        e.hits++
        hitCounts.set(key, e)
      }
    }

    for (const type of active) {
      const sheetModel = sheetModels.get(type)
      if (basis === 'sheets' && sheetModel) {
        const drawn: Array<{ id: string; foil: boolean }> = []
        for (let n = 0; n < (composition[type] ?? 0); n++) boosters.drawPack(sheetModel, drawn)
        for (const d of drawn) {
          const entry = priceById.get(d.id)
          if (!entry) continue
          const price = (d.foil ? entry.foil ?? entry.nonfoil : entry.nonfoil ?? entry.foil) ?? 0
          sum += price
          if (price >= LIQUID) liquid += price
          if (price >= 20) {
            const key = `${d.id}:${d.foil ? 'foil' : 'nonfoil'}`
            const e = hitCounts.get(key) ?? { card: entry.card, finish: d.foil ? 'foil' : 'nonfoil', price, hits: 0 }
            e.hits++
            hitCounts.set(key, e)
          }
        }
        continue
      }

      const model = SLOTS[type]
      const pool = poolsByType.get(type) as Record<string, PoolEntry[]>
      if (!pool.rare.length && !pool.mythic.length) continue
      for (let n = 0; n < (composition[type] ?? 0); n++) {
        let rareSlots = model.rares
        for (const p of model.bonusRares) if (Math.random() < p) rareSlots++

        // An empty pool contributes ZERO, never a substitute from a dearer
        // rarity: falling back from rares to mythics silently turned every
        // rare slot in a thinly-priced set into a mythic pull.
        for (let r = 0; r < rareSlots; r++) {
          const mythic = Math.random() < MYTHIC_RATE && pool.mythic.length > 0
          draw(mythic ? pool.mythic : pool.rare, Math.random() < model.foilShare, model.premiumShare)
        }
        // Special treatments are a rare-slot feature; the commons and uncommons
        // filling out a pack are overwhelmingly ordinary printings.
        for (let u = 0; u < model.uncommons; u++) draw(pool.uncommon, Math.random() < model.foilShare, model.premiumShare / 3)
        for (let c = 0; c < model.commons; c++) draw(pool.common, Math.random() < model.foilShare, model.premiumShare / 3)
      }
    }

    totals.push(sum)
    liquidTotals.push(liquid)
  }

  const sorted = [...totals].sort((a, b) => a - b)
  const sortedLiquid = [...liquidTotals].sort((a, b) => a - b)
  const at = (arr: number[], q: number): number => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] ?? 0
  const mean = totals.reduce((s, v) => s + v, 0) / totals.length
  const meanLiquid = liquidTotals.reduce((s, v) => s + v, 0) / liquidTotals.length

  const topHits = [...hitCounts.values()]
    .sort((a, b) => b.price * b.hits - a.price * a.hits)
    .slice(0, 10)
    .map((e) => ({
      name: e.card.name,
      setCode: e.card.setCode,
      collectorNumber: e.card.collectorNumber,
      price: e.price,
      finish: e.finish,
      // Per UNIT, not per pack: on a box this reads "chance this box has one".
      chancePerPack: Math.min(1, e.hits / simulations)
    }))

  return {
    sets: valuation.sets,
    booster: label,
    boosterType: primary,
    simulations,
    // Distinct CARDS per rarity, which is what the simulation samples over.
    poolSizes: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])),
    mean: Math.round(mean * 100) / 100,
    median: Math.round(at(sorted, 0.5) * 100) / 100,
    p10: Math.round(at(sorted, 0.1) * 100) / 100,
    p90: Math.round(at(sorted, 0.9) * 100) / 100,
    meanLiquid: Math.round(meanLiquid * 100) / 100,
    medianLiquid: Math.round(at(sortedLiquid, 0.5) * 100) / 100,
    liquidThreshold: LIQUID,
    packPrice: unitPrice,
    chanceOfProfit: unitPrice ? sorted.filter((v) => v >= unitPrice).length / sorted.length : null,
    topHits,
    unpricedChase,
    basis,
    note: null
  }
}

/** One booster of one type — the original entry point, unchanged for callers. */
export async function packEv(
  query: string,
  boosterType: BoosterType = 'collector',
  simulations = 20_000,
  packPrice: number | null = null
): Promise<PackEvResult> {
  return unitEv(query, { [boosterType]: 1 }, simulations, packPrice)
}

// ---------------------------------------------------------------- sealed products

/**
 * Sealed products (booster boxes, bundles, Secret Lair drops).
 *
 * Scryfall has no concept of sealed product at all, and MTGJSON — which does
 * have the catalogue — has no sealed PRICES (feature request #928, still open;
 * verified by scanning AllPricesToday end to end, sealed uuids are absent).
 * So the two halves come from different places: catalogue from MTGJSON per-set
 * files, price from the TCGplayer product id those files carry.
 *
 * The catalogue is pulled lazily per set rather than up front, because there is
 * no combined sealed download short of AllPrintings (~hundreds of MB).
 */
const MTGJSON = 'https://mtgjson.com/api/v5'

interface MtgjsonSealed {
  uuid: string
  name: string
  category?: string
  subtype?: string
  releaseDate?: string
  identifiers?: Record<string, string>
}

/**
 * How long a pulled sealed catalogue counts as current. MTGJSON keeps adding
 * products to a set after release (SLD gets new drops every few weeks; late
 * bundles and promo packs land on normal sets too), so a pull is not forever.
 */
function sealedMaxAge(setCode: string): number {
  return setCode.toLowerCase() === 'sld' ? DAY_MS : 7 * DAY_MS
}

/** Whether a set's sealed catalogue is present and recent enough to trust. */
function sealedCatalogueFresh(setCode: string): boolean {
  return db.mtgSealedSetSynced(setCode, sealedMaxAge(setCode))
}

/** Pull one set's sealed catalogue into the local table. Safe to call repeatedly. */
export async function syncSealedForSet(setCode: string): Promise<number> {
  const res = await fetch(`${MTGJSON}/${setCode.toUpperCase()}.json`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' }
  })
  // Scryfall and MTGJSON set codes mostly agree, but not always — a miss here
  // just means this set has no MTGJSON counterpart, not that anything broke.
  if (!res.ok) return 0
  const body = (await res.json()) as { data?: { sealedProduct?: MtgjsonSealed[] } }
  const products = body.data?.sealedProduct ?? []
  for (const p of products) {
    db.upsertMtgSealed({
      uuid: p.uuid,
      name: p.name,
      set_code: setCode.toLowerCase(),
      category: p.category ?? null,
      subtype: p.subtype ?? null,
      release_date: p.releaseDate ?? null,
      tcgplayer_product_id: p.identifiers?.tcgplayerProductId ?? null,
      card_kingdom_id: p.identifiers?.cardKingdomId ?? null
    })
  }
  return products.length
}

// ------------------------------------------------- sealed contents / crack value

/**
 * What is actually inside a sealed product, and what those cards are worth.
 *
 * MTGJSON's per-set `sealedProduct[].contents` describes a product as some mix
 * of four things, and only two of them are knowable:
 *  - `deck`    — a named decklist. Fully determined: every card, every finish.
 *  - `card`    — an explicit card list. Also fully determined.
 *  - `sealed`  — nested products (a "set of 4" holding four decks; a deck
 *                holding a sample booster). Recursed into.
 *  - `pack` / `variable` — random boosters. NOT knowable, and pretending
 *                otherwise would be the whole point of the exercise wrong.
 *                These are reported separately, and Pack EV is the right tool.
 *
 * The decklists themselves come from the per-DECK file, not the set file: a set
 * file's `decks[]` carries only `{count, isFoil, uuid}` stubs, and 9 of the 100
 * cards in a Final Fantasy commander deck live in a DIFFERENT set (the deck
 * pulls reprints from FIN), so resolving uuids against one set file silently
 * loses cards. The per-deck file is one 600KB fetch and carries a Scryfall id
 * for 100/100 of them.
 */
export interface SealedCardEntry {
  scryfallId: string
  name: string
  setCode: string
  collectorNumber: string
  rarity: string
  count: number
  /** The finish you actually get — Collector's Edition decks are all-foil. */
  foil: boolean
  unitPrice: number | null
  /**
   * Which finish the price actually came from. When this disagrees with
   * `foil`, no market quote exists for the finish the product contains and the
   * other one stood in — worth saying out loud, because all-foil Collector's
   * Edition decks lean on it heavily.
   */
  priceFinish: string | null
  lineTotal: number | null
  imageUrl: string | null
  imageLarge: string | null
  artCrop: string | null
  prices: Record<string, number | null>
}

export interface SealedContents {
  uuid: string
  name: string
  setCode: string
  category: string | null
  subtype: string | null
  /** Every determined card, most valuable first. */
  cards: SealedCardEntry[]
  cardCount: number
  pricedCount: number
  /** Sum of every priced card at the finish the product actually contains. */
  singlesTotal: number
  /** Market price of the sealed product itself, from TCGplayer. */
  sealedPrice: number | null
  /** singlesTotal − sealedPrice. Positive means the cards beat the box price. */
  netGain: number | null
  netGainPct: number | null
  /** Cards priced from the other finish because theirs has no quote. */
  estimatedFinishCount: number
  /**
   * Components MTGJSON names but never published the contents of. While this
   * is non-empty the itemisation is a FRAGMENT of the product, so no verdict
   * is offered — a net gain computed from part of a deck is worse than none.
   */
  missingComponents: string[]
  /** Card count the product itself declares, when it declares one. */
  expectedCardCount: number | null
  /** Everything the product contains was resolved. */
  complete: boolean
  /** Random components (boosters) whose contents can't be known. */
  randomComponents: string[]
  /** Nested sealed products that were expanded into this view. */
  expanded: string[]
  note: string | null
}

interface MtgjsonContents {
  deck?: Array<{ name?: string; set?: string }>
  card?: Array<{ uuid?: string; name?: string; number?: string; set?: string; foil?: boolean }>
  sealed?: Array<{ count?: number; name?: string; set?: string; uuid?: string }>
  pack?: Array<{ code?: string; set?: string }>
  variable?: Array<{ configs?: unknown[] }>
  other?: Array<{ name?: string }>
}

interface MtgjsonDeckCard {
  count?: number
  isFoil?: boolean
  /** Present on set-file deck entries, which are uuid stubs. */
  uuid?: string
  name?: string
  number?: string
  setCode?: string
  rarity?: string
  identifiers?: { scryfallId?: string }
  /** Set by deckCards/setFileDeckCards for the deck's command zone. */
  isCommander?: boolean
}

const SEALED_CONTENTS_TTL_MS = 6 * 60 * 60_000
const sealedContentsCache = new Map<string, { at: number; value: SealedContents }>()
/**
 * Set files and the deck index are big and rarely change, so they are held in
 * memory — but not for the whole run. MTGJSON publishes a new Secret Lair
 * commander decklist days or weeks after the product appears, and ATLIS stays
 * open for days; a per-run cache would keep answering "no list" until restart.
 * MTGJSON rebuilds daily, so half a day loses nothing.
 */
const MTGJSON_FILE_TTL_MS = 12 * 60 * 60_000
const setFileCache = new Map<string, { at: number; data: Record<string, unknown> | null }>()
let deckIndex: Array<{ code: string; fileName: string; name: string; type?: string; releaseDate?: string }> | null = null
let deckIndexAt = 0

async function mtgjsonSet(code: string): Promise<Record<string, unknown> | null> {
  const key = code.toUpperCase()
  const hit = setFileCache.get(key)
  if (hit && Date.now() - hit.at < MTGJSON_FILE_TTL_MS) return hit.data
  try {
    const r = await fetch(`${MTGJSON}/${key}.json`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    const data = r.ok ? ((await r.json()) as { data?: Record<string, unknown> }).data ?? null : null
    setFileCache.set(key, { at: Date.now(), data })
    return data
  } catch {
    // A network blip keeps the last good copy rather than caching a miss.
    if (hit) return hit.data
    return null
  }
}

/** MTGJSON names deck files by a squashed title, so the index is the only map. */
async function deckFileName(name: string, setCode: string): Promise<string | null> {
  await loadDeckIndex()
  const index = deckIndex ?? []
  const code = setCode.toUpperCase()
  const exact = index.find((d) => d.code === code && d.name === name)
  if (exact) return exact.fileName
  const loose = index.find((d) => d.code === code && d.name.toLowerCase() === name.toLowerCase())
  return loose?.fileName ?? null
}

async function loadDeckIndex(): Promise<void> {
  if (!deckIndex || Date.now() - deckIndexAt >= MTGJSON_FILE_TTL_MS) {
    try {
      const r = await fetch(`${MTGJSON}/DeckList.json`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
      if (r.ok) {
        deckIndex = ((await r.json()) as { data?: typeof deckIndex }).data ?? []
        deckIndexAt = Date.now()
      }
    } catch {
      /* keep the last good index; retried on the next lookup */
    }
    deckIndex ??= []
  }
}

export interface PreconHit {
  fileName: string
  name: string
  code: string
  setName: string | null
  releaseDate: string | null
  /** Why it matched: the deck's own name, its set's name, or a commander printed in its set. */
  matchedBy: 'name' | 'set' | 'commander'
}

/**
 * Find a preconstructed commander deck by deck name ("mutant menace"), set
 * name ("fallout"), or commander ("mothman"). The last is the one people
 * actually remember and MTGJSON's index doesn't carry, so it goes through
 * Scryfall: the sets a matching commander was printed in are the sets whose
 * decks are offered.
 */
export async function searchPrecons(query: string): Promise<PreconHit[]> {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (!words.length) return []
  await loadDeckIndex()
  const decks = (deckIndex ?? []).filter((d) => d.type === 'Commander Deck')
  // Set names come from the Scryfall set cache; fill it if it has never synced.
  if (!db.listMtgSets().length) await syncSets().catch(() => undefined)
  const setNames = new Map(db.listMtgSets().map((s) => [s.code.toUpperCase(), s.name]))
  const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  const hit = (d: (typeof decks)[number], matchedBy: PreconHit['matchedBy']): PreconHit => ({
    fileName: d.fileName, name: d.name, code: d.code,
    setName: setNames.get(d.code) ?? null, releaseDate: d.releaseDate ?? null, matchedBy
  })

  const out = new Map<string, PreconHit>()
  for (const d of decks) {
    if (words.every((w) => fold(d.name).includes(w))) out.set(d.fileName, hit(d, 'name'))
  }
  for (const d of decks) {
    if (out.has(d.fileName)) continue
    const hay = fold(`${d.name} ${setNames.get(d.code) ?? ''} ${d.code}`)
    if (words.every((w) => hay.includes(w))) out.set(d.fileName, hit(d, 'set'))
  }
  if (out.size < 40) {
    try {
      const printings = await searchCards(`${words.join(' ')} is:commander`, 'prints')
      const codes = new Set(printings.slice(0, 40).map((c) => c.set.toUpperCase()))
      for (const d of decks) {
        if (!out.has(d.fileName) && codes.has(d.code)) out.set(d.fileName, hit(d, 'commander'))
      }
    } catch {
      // Scryfall unreachable: name/set matches still stand
    }
  }
  const rank = { name: 0, commander: 1, set: 2 }
  // A commander reprinted in a catch-all set (Secret Lair holds dozens of
  // decks) is far less likely to be from there than from its own 4-deck
  // product, so smaller sets come first among commander matches.
  const perSet = new Map<string, number>()
  for (const d of decks) perSet.set(d.code, (perSet.get(d.code) ?? 0) + 1)
  return [...out.values()]
    .sort((a, b) =>
      rank[a.matchedBy] - rank[b.matchedBy] ||
      (a.matchedBy === 'commander' ? (perSet.get(a.code) ?? 0) - (perSet.get(b.code) ?? 0) : 0) ||
      (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
    .slice(0, 40)
}

/** One precon's list straight from its MTGJSON deck file, command zone marked. */
export async function preconDecklist(fileName: string): Promise<ProductDecklist | null> {
  await loadDeckIndex()
  const entry = (deckIndex ?? []).find((d) => d.fileName === fileName)
  try {
    const r = await fetch(`${MTGJSON}/decks/${encodeURIComponent(fileName)}.json`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    if (!r.ok) return null
    const d = (await r.json()) as { data?: { name?: string; commander?: MtgjsonDeckCard[]; mainBoard?: MtgjsonDeckCard[] } }
    const toCard = (c: MtgjsonDeckCard, commander: boolean): ProductDecklist['cards'][number] | null =>
      c.identifiers?.scryfallId ? { scryfallId: c.identifiers.scryfallId, name: c.name ?? '', count: c.count ?? 1, commander } : null
    const cards = [
      ...(d.data?.commander ?? []).map((c) => toCard(c, true)),
      ...(d.data?.mainBoard ?? []).map((c) => toCard(c, false))
    ].filter((c): c is ProductDecklist['cards'][number] => c != null)
    if (!cards.length) return null
    return { name: d.data?.name ?? entry?.name ?? fileName, source: 'mtgjson', url: null, cards }
  } catch {
    return null
  }
}

/**
 * The commander deck a free-text product name refers to — for an owned
 * sealed row that has no catalogue link ("Fallout Commander Deck Mutant
 * Menace" typed by hand). Longest deck name contained in the product name wins.
 */
export async function preconByProductName(productName: string): Promise<string | null> {
  await loadDeckIndex()
  const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const target = fold(productName)
  let best: { fileName: string; len: number } | null = null
  for (const d of deckIndex ?? []) {
    if (d.type !== 'Commander Deck') continue
    const k = fold(d.name)
    // Very short names ("Science!") must not match inside unrelated words.
    if (k.length < 5 || !target.includes(k)) continue
    if (!best || k.length > best.len) best = { fileName: d.fileName, len: k.length }
  }
  return best?.fileName ?? null
}

/** Punctuation and case vary between the product's deck reference and the index. */
const deckKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

interface MtgjsonSetDeck {
  name: string
  commander?: MtgjsonDeckCard[]
  mainBoard?: MtgjsonDeckCard[]
  sideBoard?: MtgjsonDeckCard[]
  sealedProductUuids?: string[]
  sourceSetCodes?: string[]
}

/**
 * A decklist published inside the SET file rather than as its own deck file.
 * These carry `{count, isFoil, uuid}` stubs only, so each uuid is resolved back
 * to a Scryfall id through the card lists of the sets the deck draws from.
 *
 * Matched by name, and failing that by the deck's own back-reference to the
 * product — `sealedProductUuids` is the one link that survives the two sides
 * naming the same deck differently.
 */
async function setFileDeckCards(
  setCode: string,
  name: string,
  productUuid?: string
): Promise<MtgjsonDeckCard[]> {
  const data = await mtgjsonSet(setCode)
  const decks = (data?.decks ?? []) as MtgjsonSetDeck[]
  if (!decks.length) return []
  const want = deckKey(name)
  const deck =
    decks.find((d) => d.name === name) ??
    decks.find((d) => deckKey(d.name) === want) ??
    (productUuid ? decks.find((d) => d.sealedProductUuids?.includes(productUuid)) : undefined)
  if (!deck) return []

  const entries = [
    ...(deck.commander ?? []).map((e) => ({ ...e, isCommander: true })),
    ...(deck.mainBoard ?? []),
    ...(deck.sideBoard ?? [])
  ]
  const byUuid = new Map<string, { identifiers?: { scryfallId?: string }; name?: string; number?: string; setCode?: string; rarity?: string }>()
  // The deck's own set first, then any set it borrows reprints from.
  for (const code of [setCode, ...(deck.sourceSetCodes ?? [])]) {
    const d = await mtgjsonSet(code)
    for (const c of (d?.cards ?? []) as Array<{ uuid: string; identifiers?: { scryfallId?: string }; name?: string; number?: string; setCode?: string; rarity?: string }>) {
      if (!byUuid.has(c.uuid)) byUuid.set(c.uuid, c)
    }
    if (entries.every((e) => e.uuid && byUuid.has(e.uuid))) break
  }

  const out: MtgjsonDeckCard[] = []
  for (const e of entries) {
    const c = e.uuid ? byUuid.get(e.uuid) : undefined
    if (!c?.identifiers?.scryfallId) continue
    out.push({
      count: e.count ?? 1,
      isFoil: e.isFoil,
      name: c.name,
      number: c.number,
      setCode: c.setCode,
      rarity: c.rarity,
      identifiers: c.identifiers,
      isCommander: e.isCommander
    })
  }
  return out
}

/**
 * A product's decklist. The per-deck file is preferred (it carries Scryfall ids
 * outright); the set file is the fallback for decks the index doesn't list.
 * Returns empty when MTGJSON simply has not published the list — which happens,
 * and must not be mistaken for "the deck is empty".
 */
async function deckCards(name: string, setCode: string, productUuid?: string): Promise<MtgjsonDeckCard[]> {
  const file = await deckFileName(name, setCode)
  if (file) {
    try {
      const r = await fetch(`${MTGJSON}/decks/${file}.json`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
      if (r.ok) {
        const d = (await r.json()) as {
          data?: { commander?: MtgjsonDeckCard[]; mainBoard?: MtgjsonDeckCard[]; sideBoard?: MtgjsonDeckCard[] }
        }
        const cards = [
          ...(d.data?.commander ?? []).map((c) => ({ ...c, isCommander: true })),
          ...(d.data?.mainBoard ?? []),
          ...(d.data?.sideBoard ?? [])
        ]
        if (cards.length) return cards
      }
    } catch {
      // fall through to the set file
    }
  }
  return setFileDeckCards(setCode, name, productUuid)
}

/** One product's raw MTGJSON record, by uuid, within a known set. */
async function sealedRecord(
  setCode: string,
  uuid: string
): Promise<{ name: string; category?: string; subtype?: string; cardCount?: number; contents?: MtgjsonContents; identifiers?: Record<string, string> } | null> {
  const data = await mtgjsonSet(setCode)
  const list = (data?.sealedProduct ?? []) as Array<{ uuid: string; name: string; category?: string; subtype?: string; cardCount?: number; contents?: MtgjsonContents; identifiers?: Record<string, string> }>
  return list.find((p) => p.uuid === uuid) ?? null
}

interface Wanted {
  scryfallId: string
  count: number
  foil: boolean
}

/**
 * Walk a product's contents into a flat want-list. Depth-limited because
 * nesting is legitimately recursive (a case holds boxes holds packs) and a
 * malformed upstream record shouldn't spin.
 */
async function collectContents(
  setCode: string,
  contents: MtgjsonContents | undefined,
  out: { wants: Wanted[]; random: string[]; expanded: string[]; missing: string[]; fromEdhrec: string[] },
  depth = 0,
  productUuid?: string
): Promise<void> {
  if (!contents || depth > 2) return

  for (const d of contents.deck ?? []) {
    if (!d.name) continue
    const cards = await deckCards(d.name, d.set ?? setCode, productUuid)
    // MTGJSON names decks it has no list for — Secret Lair Commander Deck
    // "Hatsune Miku" declared 100 cards and published none of them for weeks.
    // EDHREC usually has the list within days, so it is asked next.
    if (!cards.length) {
      const precon = await edhrec.preconDeck(d.name)
      // Deck names repeat across products ("Odds and Ends" could be anything),
      // so a Secret Lair deck only accepts an EDHREC page that says Secret Lair.
      const plausible =
        precon && ((d.set ?? setCode).toLowerCase() !== 'sld' || /secret lair/i.test(precon.header))
      if (precon && plausible) {
        // Finish is left to the printing: EDHREC's foil flag is always off.
        for (const c of precon.cards) out.wants.push({ scryfallId: c.scryfallId, count: c.count, foil: false })
        out.expanded.push(d.name)
        out.fromEdhrec.push(d.name)
        continue
      }
      // Still nothing: recording it as missing is what stops the panel
      // presenting the product's one separately-listed card as the whole deck.
      out.missing.push(d.name)
      continue
    }
    for (const c of cards) {
      const id = c.identifiers?.scryfallId
      if (id) out.wants.push({ scryfallId: id, count: c.count ?? 1, foil: !!c.isFoil })
    }
    out.expanded.push(d.name)
  }

  // An explicit card list references MTGJSON uuids, which only the set file maps.
  const explicit = contents.card ?? []
  if (explicit.length) {
    const bySet = new Map<string, typeof explicit>()
    for (const c of explicit) {
      const code = (c.set ?? setCode).toUpperCase()
      const arr = bySet.get(code) ?? []
      arr.push(c)
      bySet.set(code, arr)
    }
    for (const [code, list] of bySet) {
      const data = await mtgjsonSet(code)
      const cards = (data?.cards ?? []) as Array<{ uuid: string; identifiers?: { scryfallId?: string } }>
      const byUuid = new Map(cards.map((c) => [c.uuid, c]))
      for (const c of list) {
        const id = c.uuid ? byUuid.get(c.uuid)?.identifiers?.scryfallId : undefined
        if (id) out.wants.push({ scryfallId: id, count: 1, foil: !!c.foil })
      }
    }
  }

  for (const s of contents.sealed ?? []) {
    if (!s.uuid || !s.name) continue
    const child = await sealedRecord(s.set ?? setCode, s.uuid)
    if (!child) continue
    // A booster inside a deck box stays random; only determined children expand.
    const childHasRandom = !!(child.contents?.pack?.length || child.contents?.variable?.length)
    if (childHasRandom) {
      out.random.push(`${s.count && s.count > 1 ? `${s.count}× ` : ''}${s.name}`)
      continue
    }
    out.expanded.push(s.name)
    for (let i = 0; i < (s.count ?? 1); i++) {
      await collectContents(s.set ?? setCode, child.contents, out, depth + 1, s.uuid)
    }
  }

  if (contents.pack?.length || contents.variable?.length) {
    out.random.push('booster packs (contents are random)')
  }
}

/**
 * Which booster model a catalogued pack follows.
 *
 * Only two slot models exist (play and collector), so everything that isn't
 * explicitly a collector booster is simulated as a play booster. Draft and set
 * boosters are close enough to play boosters for an EV estimate; jumpstart and
 * the odd one-off are NOT, so they're refused rather than guessed at.
 */
function boosterTypeOf(name: string, subtype?: string | null): BoosterType | null {
  const s = `${subtype ?? ''} ${name}`.toLowerCase()
  if (/jumpstart|starter|welcome|sample/.test(s)) return null
  if (/collector/.test(s)) return 'collector'
  if (/play|draft|set booster/.test(s)) return 'play'
  return null
}

export interface SealedComposition {
  packs: PackComposition
  /** Packs the catalogue lists but that have no slot model (jumpstart, samples). */
  unmodelled: string[]
  totalPacks: number
}

/**
 * Walk a product down to its booster-pack leaves.
 *
 * MTGJSON nests these exactly the way the cardboard does — a case holds 6
 * boxes, a box holds 12 packs — so the pack count for anything is a recursive
 * walk rather than a table of magic numbers per product line. That matters
 * because the counts genuinely differ (12 collector vs 30 play per box) and a
 * hardcoded guess would be silently wrong for half the products.
 */
export async function sealedComposition(
  setCode: string,
  uuid: string,
  depth = 0
): Promise<SealedComposition> {
  const out: SealedComposition = { packs: {}, unmodelled: [], totalPacks: 0 }
  if (depth > 3) return out
  const record = await sealedRecord(setCode, uuid)
  if (!record) return out

  const add = (type: BoosterType, n: number): void => {
    out.packs[type] = (out.packs[type] ?? 0) + n
    out.totalPacks += n
  }

  // A leaf: the product IS a booster pack.
  if (record.contents?.pack?.length && !record.contents?.sealed?.length) {
    const type = boosterTypeOf(record.name, record.subtype)
    if (type) add(type, 1)
    else out.unmodelled.push(record.name)
    return out
  }

  for (const child of record.contents?.sealed ?? []) {
    if (!child.uuid || !child.name) continue
    const count = child.count ?? 1
    const inner = await sealedComposition(child.set ?? setCode, child.uuid, depth + 1)
    if (inner.totalPacks || inner.unmodelled.length) {
      for (const [t, n] of Object.entries(inner.packs)) add(t as BoosterType, (n ?? 0) * count)
      for (const u of inner.unmodelled) out.unmodelled.push(count > 1 ? `${count}× ${u}` : u)
    }
  }

  // A bundle lists its own boosters under `pack` alongside nested products.
  if (!out.totalPacks && record.contents?.pack?.length) {
    const type = boosterTypeOf(record.name, record.subtype)
    if (type) add(type, record.contents.pack.length)
  }
  return out
}

/**
 * Price what's inside a sealed product against what the product costs.
 *
 * This is the "are Commander decks a good investment" question, answered with
 * real numbers rather than vibes. Caveats that all push the honest figure DOWN
 * and are surfaced in the UI rather than buried here:
 *  - Card prices are retail asks; a buylist realises roughly half.
 *  - Bulk commons are counted at face value even though nobody buys them.
 *  - Random components (a sample booster) contribute ZERO, so a deck's real
 *    ceiling is a little higher than the number reported.
 */
export async function sealedContents(uuid: string, force = false): Promise<SealedContents | null> {
  const hit = sealedContentsCache.get(uuid)
  if (!force && hit && Date.now() - hit.at < SEALED_CONTENTS_TTL_MS) return hit.value

  const row = db.getMtgSealed(uuid)
  if (!row) return null

  const record = await sealedRecord(row.set_code, uuid)
  const collected = {
    wants: [] as Wanted[],
    random: [] as string[],
    expanded: [] as string[],
    missing: [] as string[],
    fromEdhrec: [] as string[]
  }
  await collectContents(row.set_code, record?.contents, collected, 0, uuid)

  // Same card, same finish, listed twice = one row with a higher count.
  const merged = new Map<string, Wanted>()
  for (const w of collected.wants) {
    const key = `${w.scryfallId}:${w.foil ? 'f' : 'n'}`
    const prev = merged.get(key)
    if (prev) prev.count += w.count
    else merged.set(key, { ...w })
  }

  const byId = merged.size ? await cardsByIds([...merged.values()].map((w) => w.scryfallId)) : new Map()
  const cards: SealedCardEntry[] = []
  for (const w of merged.values()) {
    const c = byId.get(w.scryfallId)
    if (!c) continue
    // A printing that only exists in foil IS foil, whatever the list said —
    // EDHREC's lists never flag foil, and Secret Lair art cards are foil-only.
    const foil = w.foil || (!!c.finishes?.length && !c.finishes.includes('nonfoil'))
    const finish = foil ? 'foil' : 'nonfoil'
    const other = foil ? 'nonfoil' : 'foil'
    // Plenty of printings exist in both finishes but only have a quote for one
    // (FIC #70 Sphere Grid: nonfoil $7.97, foil null). Falling back keeps the
    // card in the total instead of dropping it, and priceFinish records that
    // the number is an estimate.
    const own = priceOf(c, finish)
    const unitPrice = own ?? priceOf(c, other)
    const priceFinish = own != null ? finish : unitPrice != null ? other : null
    const prices: Record<string, number | null> = {}
    for (const f of c.finishes?.length ? c.finishes : ['nonfoil']) prices[f] = priceOf(c, f)
    cards.push({
      scryfallId: c.id,
      name: c.name,
      setCode: c.set,
      collectorNumber: c.collector_number,
      rarity: c.rarity,
      count: w.count,
      foil,
      unitPrice,
      priceFinish,
      lineTotal: unitPrice == null ? null : Math.round(unitPrice * w.count * 100) / 100,
      imageUrl: imageOf(c),
      imageLarge: imageOf(c, 'large'),
      artCrop: imageOf(c, 'art_crop'),
      prices
    })
  }
  cards.sort((a, b) => (b.lineTotal ?? 0) - (a.lineTotal ?? 0) || a.name.localeCompare(b.name))

  const singlesTotal = Math.round(cards.reduce((sum, c) => sum + (c.lineTotal ?? 0), 0) * 100) / 100
  const sealedPrice = row.tcgplayer_product_id ? await tcgSealedPrice(row.tcgplayer_product_id) : null

  const cardCount = cards.reduce((n, c) => n + c.count, 0)
  const expectedCardCount = typeof record?.cardCount === 'number' ? record.cardCount : null
  // Two ways to know the itemisation is partial: a component we couldn't
  // resolve, or fewer cards than the product itself says it holds. The count
  // check catches upstream gaps that don't announce themselves.
  const shortfall = expectedCardCount != null && cardCount < expectedCardCount
  const complete = collected.missing.length === 0 && !shortfall

  // A verdict computed from a fragment is worse than no verdict.
  const netGain = !complete || sealedPrice == null ? null : Math.round((singlesTotal - sealedPrice) * 100) / 100
  const netGainPct =
    !complete || sealedPrice == null || sealedPrice === 0
      ? null
      : Math.round(((singlesTotal - sealedPrice) / sealedPrice) * 1000) / 10

  const missingNote = collected.missing.length
    ? `MTGJSON names ${collected.missing.length === 1 ? 'a decklist' : `${collected.missing.length} decklists`} for this product (${collected.missing.join(', ')}) but has not published the contents, so this is only part of what's inside.`
    : shortfall
      ? `This product declares ${expectedCardCount} cards but only ${cardCount} could be identified, so this is only part of what's inside.`
      : null

  const edhrecNote = collected.fromEdhrec.length
    ? `Decklist for ${collected.fromEdhrec.join(', ')} is from EDHREC — MTGJSON hasn't published it yet. Reprints are priced at the printing EDHREC lists, which may not be the exact one in the box.`
    : null

  const note = cards.length
    ? [edhrecNote, missingNote].filter(Boolean).join(' ') || null
    : collected.random.length
      ? 'This product holds random boosters, so its contents are not knowable — run Pack EV for the set instead.'
      : missingNote ?? 'MTGJSON lists no determined contents for this product.'

  const value: SealedContents = {
    uuid,
    name: row.name,
    setCode: row.set_code,
    category: row.category,
    subtype: row.subtype,
    cards,
    cardCount,
    pricedCount: cards.filter((c) => c.unitPrice != null).length,
    estimatedFinishCount: cards.filter((c) => c.unitPrice != null && c.priceFinish !== (c.foil ? 'foil' : 'nonfoil')).length,
    missingComponents: [...new Set(collected.missing)],
    expectedCardCount,
    complete,
    singlesTotal,
    sealedPrice,
    netGain,
    netGainPct,
    randomComponents: [...new Set(collected.random)],
    expanded: [...new Set(collected.expanded)],
    note
  }
  sealedContentsCache.set(uuid, { at: Date.now(), value })
  return value
}

/** One named decklist inside a sealed product, with its command zone marked. */
export interface ProductDecklist {
  name: string
  source: 'mtgjson' | 'edhrec'
  url: string | null
  /** `name` is empty for EDHREC lists, which carry only printing ids. */
  cards: Array<{ scryfallId: string; name: string; count: number; commander: boolean }>
}

/**
 * The decklists a sealed product holds, kept apart rather than flattened the
 * way sealedContents does — a "set of four" commander product is four decks,
 * and a deck view needs to know which card is the commander. Same sources and
 * same EDHREC fallback as collectContents.
 */
export async function productDecklists(uuid: string): Promise<ProductDecklist[]> {
  const row = db.getMtgSealed(uuid)
  if (!row) return []
  const out: ProductDecklist[] = []
  const seen = new Set<string>()

  const walk = async (setCode: string, contents: MtgjsonContents | undefined, depth: number, productUuid: string): Promise<void> => {
    if (!contents || depth > 2) return
    for (const d of contents.deck ?? []) {
      if (!d.name || seen.has(d.name)) continue
      seen.add(d.name)
      const cards = await deckCards(d.name, d.set ?? setCode, productUuid)
      if (cards.length) {
        out.push({
          name: d.name,
          source: 'mtgjson',
          url: null,
          cards: cards
            .filter((c) => c.identifiers?.scryfallId)
            .map((c) => ({ scryfallId: String(c.identifiers?.scryfallId), name: c.name ?? '', count: c.count ?? 1, commander: !!c.isCommander }))
        })
        continue
      }
      const precon = await edhrec.preconDeck(d.name)
      const plausible = precon && ((d.set ?? setCode).toLowerCase() !== 'sld' || /secret lair/i.test(precon.header))
      if (precon && plausible) {
        out.push({
          name: d.name,
          source: 'edhrec',
          url: precon.url,
          cards: precon.cards.map((c) => ({ scryfallId: c.scryfallId, name: '', count: c.count, commander: c.commander }))
        })
      }
    }
    for (const s of contents.sealed ?? []) {
      if (!s.uuid) continue
      const child = await sealedRecord(s.set ?? setCode, s.uuid)
      if (child) await walk(s.set ?? setCode, child.contents, depth + 1, s.uuid)
    }
  }

  const record = await sealedRecord(row.set_code, uuid)
  await walk(row.set_code, record?.contents, 0, uuid)
  return out
}

export interface ProductContents {
  /** null when no MTGJSON catalogue entry could be found for the product. */
  contents: SealedContents | null
  /** The set to show instead when the product is random boosters (or unknown). */
  setCode: string | null
  note: string | null
}

/**
 * "What's inside" for an owned or watched sealed row, which carries only a
 * TCGplayer product id. Looks the MTGJSON product up by that id, pulling the
 * hinted set's catalogue first if it hasn't been synced (a watch made from the
 * Sets tab, or a catalogue that predates the product).
 */
export async function productContents(productId: string, setHint?: string | null): Promise<ProductContents> {
  const id = String(productId ?? '')
  if (!/^\d+$/.test(id)) throw new Error('Not a TCGplayer product id.')
  const hint = setHint?.trim().toLowerCase() || null

  let product = db.findMtgSealedByTcgplayer(id)
  if (!product && hint && db.listMtgSets().some((s) => s.code.toLowerCase() === hint)) {
    await syncSealedForSet(hint)
    product = db.findMtgSealedByTcgplayer(id)
  }
  if (!product) {
    return {
      contents: null,
      setCode: hint,
      note: 'MTGJSON has no catalogue entry for this product, so its contents are unknown.'
    }
  }
  const contents = await sealedContents(product.uuid)
  return { contents, setCode: product.set_code, note: contents?.note ?? null }
}

export interface RipResult {
  product: string
  /** Distinct printings added, and the physical cards they total. */
  added: number
  cards: number
  /** Sealed copies still held after this one was opened. */
  remaining: number
  /** Why some of what was inside could not be added — null when it all was. */
  note: string | null
}

/**
 * "I opened it": turn one owned sealed copy into the cards it held.
 *
 * Only the determined contents can be added — a decklist, a Secret Lair's
 * fixed cards. Random boosters inside a product are listed in the result's
 * note so the pulls can be logged by hand. A product with nothing determined
 * at all is refused outright rather than silently consuming the sealed copy.
 */
export async function ripSealed(vaultId: string): Promise<RipResult> {
  const item = db.getVaultItem(vaultId)
  if (!item) throw new Error('That item is no longer in the Vault.')
  if (item.category !== 'mtg_sealed' || item.ext_source !== 'tcgplayer' || !item.ext_id) {
    throw new Error(`“${item.name}” isn't a priced sealed product, so its contents can't be looked up.`)
  }
  const product = db.findMtgSealedByTcgplayer(item.ext_id)
  if (!product) {
    throw new Error(`No MTGJSON catalogue entry for “${item.name}” yet — search it in Sealed once so its set is pulled, then try again.`)
  }
  const contents = await sealedContents(product.uuid)
  if (!contents?.cards.length) {
    throw new Error(`Nothing to add from “${item.name}”: ${contents?.note ?? 'its contents are unknown.'} It is still in Owned.`)
  }

  // Spread this copy's cost over its cards by market value, so each card's
  // "paid" reflects its share of the box. Even split when nothing is priced.
  const unitCost = item.purchase_price == null ? null : item.purchase_price / Math.max(1, item.quantity)
  const valued = contents.singlesTotal > 0
  const cardCount = contents.cardCount || 1
  const rows = contents.cards.map((c) => ({
    name: c.name,
    maker: `${c.setCode.toUpperCase()} #${c.collectorNumber}`,
    quantity: c.count,
    ext_id: c.scryfallId,
    variant: c.foil ? 'foil' : 'nonfoil',
    purchase_price:
      unitCost == null
        ? null
        : Math.round(unitCost * (valued ? (c.lineTotal ?? 0) / contents.singlesTotal : c.count / cardCount) * 100) / 100,
    notes: `Ripped from ${item.name}`
  }))
  db.ripMtgSealed(vaultId, rows)

  const gaps: string[] = []
  if (contents.randomComponents.length) {
    gaps.push(`random boosters (${contents.randomComponents.join(', ')}) weren't added — log those pulls by hand`)
  }
  if (!contents.complete && contents.note) gaps.push(contents.note)
  return {
    product: item.name,
    added: rows.length,
    cards: contents.cardCount,
    remaining: item.quantity - 1,
    note: gaps.length ? gaps.join('; ') : null
  }
}

export interface SealedSearch {
  products: db.MtgSealed[]
  note: string | null
}

/**
 * Plain-English sealed search. Reuses the card searcher's set matcher, so
 * "secret lair orks" resolves "secret lair" to SLD, pulls that set's catalogue
 * on first use, then name-matches "orks" inside it.
 */
export async function searchSealed(query: string): Promise<SealedSearch> {
  const raw = query.trim()
  if (!raw) return { products: [], note: null }

  const words = normalize(raw).split(' ').filter(Boolean)
  const setMatch = matchSetPhrase(words)
  const setWords = new Set(setMatch ? setMatch.phrase.split(' ') : [])
  const terms = words.filter((w) => !setWords.has(w) && !ARTICLES.has(w))

  // Pull catalogues we haven't seen yet (or have only stale copies of), so the
  // first search for a set works and new drops show up.
  const codes = setMatch?.codes ?? []
  const fetched: string[] = []
  for (const code of codes) {
    if (sealedCatalogueFresh(code)) continue
    const n = await syncSealedForSet(code)
    if (n) fetched.push(`${code.toUpperCase()} (${n})`)
    await sleep(GAP_MS)
  }

  // Terms alone can still find things already catalogued (e.g. a second search).
  let products = db.searchMtgSealed(terms, codes.length ? codes : undefined)
  if (!products.length && terms.length) products = db.searchMtgSealed(terms)

  const bits: string[] = []
  if (setMatch) bits.push(`set “${setMatch.phrase}” → ${setMatch.names.slice(0, 2).join(', ')}`)
  if (fetched.length) bits.push(`pulled catalogue for ${fetched.join(', ')}`)
  if (!products.length) {
    bits.push('no sealed product matched — try the set name plus a word from the product')
  }
  return { products, note: bits.length ? bits.join('; ') : null }
}

// ---------------------------------------------------------------- followed sealed sets

/**
 * Sealed price tracking, per SET rather than per product.
 *
 * Individual sealed products already ride the normal daily refresh once they're
 * on the watchlist or in the Vault — but a set has ~16-25 sealed products
 * (Hobbit 19 with TCGplayer ids, Reality Fracture 16), and hand-adding each one
 * to watch a release curve is busywork. Following a set prices its whole
 * lineup daily instead.
 *
 * Stored as a plain setting rather than a table: it's a short list of set codes
 * and nothing joins against it.
 */
const FOLLOWED_SETS_KEY = 'mtg_sealed_sets'

export function listFollowedSealedSets(): string[] {
  try {
    const raw = JSON.parse(db.getSetting(FOLLOWED_SETS_KEY) || '[]') as unknown
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

export function setFollowedSealedSets(codes: string[]): string[] {
  const clean = [...new Set(codes.map((c) => c.trim().toLowerCase()).filter(Boolean))]
  db.setSetting(FOLLOWED_SETS_KEY, JSON.stringify(clean))
  return clean
}

export function followSealedSet(code: string, follow = true): string[] {
  const current = listFollowedSealedSets()
  const c = code.trim().toLowerCase()
  return setFollowedSealedSets(follow ? [...current, c] : current.filter((x) => x !== c))
}

export interface SealedSweepResult {
  sets: number
  products: number
  priced: number
  errors: string[]
}

/** Price every sealed product in every followed set. */
export async function refreshFollowedSealed(): Promise<SealedSweepResult> {
  const out: SealedSweepResult = { sets: 0, products: 0, priced: 0, errors: [] }
  const day = today()
  for (const code of listFollowedSealedSets()) {
    out.sets++
    if (!db.mtgSealedSetSynced(code)) {
      try {
        await syncSealedForSet(code)
      } catch (err) {
        out.errors.push(`${code.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
    }
    for (const p of db.listSealedForSet(code)) {
      out.products++
      const price = await tcgSealedPrice(p.tcgplayer_product_id!)
      if (price == null) continue
      db.recordMtgPrice({
        ext_id: p.tcgplayer_product_id!,
        variant: 'sealed',
        price,
        source: 'tcgplayer',
        observed_on: day
      })
      out.priced++
      await sleep(GAP_MS)
    }
  }
  return out
}

/**
 * Preorder sweep across upcoming sets. Primes each set's sealed catalogue
 * first, since retail.ts cannot reach the syncer without a circular import.
 */
export async function scanPreorders(
  aheadDays = 180,
  onProgress?: (msg: string) => void
): Promise<retail.PreorderScanResult> {
  const now = Date.now()
  const horizon = now + aheadDays * DAY_MS
  for (const s of db.listMtgSets()) {
    if (!s.released_at || s.digital) continue
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.released_at)
    if (!m) continue
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
    if (t < now - DAY_MS || t > horizon) continue
    if (db.mtgSealedSetSynced(s.code)) continue
    onProgress?.(`Pulling sealed catalogue for ${s.name}…`)
    try {
      await syncSealedForSet(s.code)
    } catch {
      /* reported by the sweep itself */
    }
    await sleep(GAP_MS)
  }
  return retail.scanPreorders(aheadDays, onProgress)
}

export const preorderBoard = retail.preorderBoard

export interface SecretLairDrop {
  name: string
  releaseDate: string
  /** Days since release — a rough proxy for how likely the window is still open. */
  ageDays: number
  hasFoil: boolean
  tcgplayerProductId: string | null
  foilTcgplayerProductId: string | null
}

/**
 * Recent Secret Lair drops.
 *
 * IMPORTANT: this is what RELEASED recently, not a live "on sale now" feed.
 * The Secret Lair store is entirely client-rendered — its HTML carries no
 * product names, no prices and no embedded state (verified 2026-08-22), and it
 * exposes no public product API — so nothing short of rendering the page can
 * say what is currently orderable. Drop windows run roughly two to four weeks,
 * so recent releases are a decent proxy; the UI shows the date and links to
 * the store rather than claiming a window is open.
 *
 * Foil and nonfoil ship as separate catalogue rows; they are collapsed here
 * into one drop, since the store sells them as one listing with a toggle.
 */
export async function recentSecretLair(days = 45): Promise<SecretLairDrop[]> {
  if (!sealedCatalogueFresh('sld')) await syncSealedForSet('sld')
  const since = new Date(Date.now() - days * DAY_MS)
  const p = (n: number): string => String(n).padStart(2, '0')
  const sinceYmd = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())}`

  const byBase = new Map<string, SecretLairDrop>()
  for (const row of db.listRecentSecretLair(sinceYmd)) {
    const isFoil = / Foil$/i.test(row.name)
    // 'Secret Lair Drop Secret Lair x Foo' and 'Secret Lair Commander Deck Foo'
    // both carry boilerplate the sidebar has no room for.
    const base = row.name
      .replace(/ Foil$/i, '')
      .replace(/^Secret Lair Drop\s+/i, '')
      .replace(/^Secret Lair x\s+/i, '')
      .trim()
    const existing = byBase.get(base)
    const ageDays = Math.max(0, Math.round((Date.now() - new Date(`${row.release_date}T12:00:00`).getTime()) / DAY_MS))
    if (existing) {
      if (isFoil) {
        existing.hasFoil = true
        existing.foilTcgplayerProductId = row.tcgplayer_product_id
      } else {
        existing.tcgplayerProductId = row.tcgplayer_product_id
      }
      continue
    }
    byBase.set(base, {
      name: base,
      releaseDate: row.release_date ?? '',
      ageDays,
      hasFoil: isFoil,
      tcgplayerProductId: isFoil ? null : row.tcgplayer_product_id,
      foilTcgplayerProductId: isFoil ? row.tcgplayer_product_id : null
    })
  }
  return [...byBase.values()].sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.name.localeCompare(b.name))
}

/**
 * Sealed price via TCGplayer's own price-points endpoint.
 *
 * NOTE: this is the undocumented endpoint tcgplayer.com itself calls. It needs
 * no key and answers reliably today, but it is NOT part of their published API
 * programme — no stability or ToS guarantee, and it can start requiring auth
 * without warning. Treated as best-effort: a failure degrades to "no quote"
 * and the agent-appraisal path stays available. The sanctioned replacement is
 * a TCGplayer partner API key, which slots in behind this same function.
 */
export async function tcgSealedPrice(productId: string): Promise<number | null> {
  try {
    const res = await fetch(`https://mpapi.tcgplayer.com/v2/product/${productId}/pricepoints`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' }
    })
    if (!res.ok) return null
    const rows = (await res.json()) as Array<{
      printingType?: string
      marketPrice?: number | null
      listedMedianPrice?: number | null
    }>
    if (!Array.isArray(rows)) return null
    // Sealed product has no foil/nonfoil split — "Normal" is the real row.
    const ordered = [...rows].sort((a, b) => (a.printingType === 'Normal' ? -1 : 0) - (b.printingType === 'Normal' ? -1 : 0))
    for (const r of ordered) {
      const v = r.marketPrice ?? r.listedMedianPrice
      if (typeof v === 'number' && isFinite(v) && v > 0) return v
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- history backfill

export interface BackfillProgress {
  phase: 'mapping' | 'streaming' | 'writing' | 'done'
  megabytes?: number
  found?: number
  message?: string
}

export interface BackfillResult {
  cards: number
  matched: number
  points: number
  megabytes: number
  seconds: number
  errors: string[]
}

/**
 * Backfill up to 90 days of price history from MTGJSON.
 *
 * This is deliberately an explicit, user-triggered job rather than something
 * that runs at startup, because there is no cheap way to do it:
 *
 *  - Scryfall has no history at all, only today's snapshot.
 *  - TCGplayer exposes no history endpoint (pricehistory / latestsales are
 *    404 / 403).
 *  - MTGJSON's AllPrices is the only source, and it is ~150 MB gzipped
 *    (~1.5 GB raw), keyed by MTGJSON uuid rather than Scryfall id.
 *
 * The uuid mapping comes from MTGJSON's PER-SET files, which are a few MB each
 * and carry `identifiers.scryfallId` for every card — far cheaper than pulling
 * AllIdentifiers. The big file is then streamed and only the handful of uuids
 * we actually track are extracted, so peak memory stays at one card's object
 * rather than the whole document.
 */
export async function backfillHistory(
  onProgress?: (p: BackfillProgress) => void
): Promise<BackfillResult> {
  const started = Date.now()
  const result: BackfillResult = { cards: 0, matched: 0, points: 0, megabytes: 0, seconds: 0, errors: [] }

  // 1. Everything we track that MTGJSON can price (cards; sealed has no prices there).
  const targets = new Map<string, Set<string>>() // scryfallId -> variants
  for (const w of db.listMtgWatchlist()) {
    if (w.ext_source === 'scryfall' && w.ext_id) {
      ;(targets.get(w.ext_id) ?? targets.set(w.ext_id, new Set()).get(w.ext_id)!).add(w.variant)
    }
  }
  for (const it of db.listVaultItems()) {
    if (it.ext_source === 'scryfall' && it.ext_id) {
      ;(targets.get(it.ext_id) ?? targets.set(it.ext_id, new Set()).get(it.ext_id)!).add(it.variant ?? 'nonfoil')
    }
  }
  result.cards = targets.size
  if (!targets.size) {
    result.seconds = (Date.now() - started) / 1000
    return result
  }

  // 2. Scryfall tells us which set each card is in; MTGJSON's per-set file then
  //    maps that Scryfall id to the uuid AllPrices is keyed by.
  onProgress?.({ phase: 'mapping', message: 'Resolving card identities…' })
  let cards: Map<string, ScryfallCard>
  try {
    cards = await cardsByIds([...targets.keys()])
  } catch (err) {
    result.errors.push(`Scryfall lookup failed: ${err instanceof Error ? err.message : String(err)}`)
    result.seconds = (Date.now() - started) / 1000
    return result
  }

  const setCodes = new Set<string>()
  for (const c of cards.values()) setCodes.add(c.set)

  const uuidToScryfall = new Map<string, string>()
  for (const code of setCodes) {
    try {
      const res = await fetch(`${MTGJSON}/${code.toUpperCase()}.json`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' }
      })
      if (!res.ok) { result.errors.push(`MTGJSON has no set file for ${code.toUpperCase()}`); continue }
      const body = (await res.json()) as {
        data?: { cards?: Array<{ uuid: string; identifiers?: { scryfallId?: string } }> }
      }
      for (const c of body.data?.cards ?? []) {
        const sid = c.identifiers?.scryfallId
        if (sid && targets.has(sid)) uuidToScryfall.set(c.uuid, sid)
      }
    } catch (err) {
      result.errors.push(`${code.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`)
    }
    await sleep(GAP_MS)
  }
  result.matched = uuidToScryfall.size
  if (!uuidToScryfall.size) {
    result.errors.push('No tracked card could be mapped to an MTGJSON uuid.')
    result.seconds = (Date.now() - started) / 1000
    return result
  }

  // 3. Stream AllPrices, plucking out only our uuids.
  onProgress?.({ phase: 'streaming', megabytes: 0, found: 0, message: 'Downloading price history…' })
  const extracted = await streamPriceObjects(uuidToScryfall, (mb, found) =>
    onProgress?.({ phase: 'streaming', megabytes: mb, found })
  )
  result.megabytes = extracted.megabytes
  if (extracted.error) result.errors.push(extracted.error)

  // 4. Write history rows.
  onProgress?.({ phase: 'writing', message: 'Storing history…' })
  const wantedVariants = targets
  for (const [uuid, obj] of extracted.byUuid) {
    const scryfallId = uuidToScryfall.get(uuid)
    if (!scryfallId) continue
    const variants = wantedVariants.get(scryfallId)
    if (!variants) continue
    for (const variant of variants) {
      for (const [day, price] of mtgjsonSeries(obj, variant)) {
        db.recordMtgPrice({ ext_id: scryfallId, variant, price, source: 'mtgjson', observed_on: day })
        result.points++
      }
    }
  }

  // Owned items chart from vault_valuations, so replay the new rows into it too.
  for (const o of db.listMtgOwned()) db.backfillVaultValuations(o.id)

  result.seconds = (Date.now() - started) / 1000
  onProgress?.({ phase: 'done' })
  return result
}

type PriceObject = Record<string, unknown>

interface Capture { uuid: string; buf: string; depth: number }

/** MTGJSON price shape: paper.<provider>.retail.<finish>.<YYYY-MM-DD> = number. */
function mtgjsonSeries(obj: PriceObject, variant: string): Array<[string, number]> {
  const finish = variant === 'foil' ? 'foil' : variant === 'etched' ? 'etched' : 'normal'
  const paper = (obj as { paper?: Record<string, unknown> }).paper
  if (!paper) return []
  // TCGplayer first — it's the same market Scryfall's USD reflects, so the
  // backfilled points line up with the forward-collected ones.
  for (const provider of ['tcgplayer', 'cardkingdom', 'cardmarket', 'cardsphere']) {
    const retail = (paper[provider] as { retail?: Record<string, Record<string, number>> } | undefined)?.retail
    const series = retail?.[finish]
    if (!series) continue
    const out: Array<[string, number]> = []
    for (const [day, price] of Object.entries(series)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof price === 'number' && isFinite(price) && price > 0) {
        out.push([day, price])
      }
    }
    if (out.length) return out
  }
  return []
}

/**
 * Stream AllPrices and extract just the objects for the given uuids.
 *
 * The document is one huge `{"data": {"<uuid>": {...}, ...}}`, so we scan for a
 * wanted uuid key and then brace-match its value. Only one card's object is
 * ever held in memory; the rest of the ~1.5 GB streams past in a small rolling
 * window. Stops early once every uuid has been found.
 */
async function streamPriceObjects(
  wanted: Map<string, string>,
  onTick?: (megabytes: number, found: number) => void
): Promise<{ byUuid: Map<string, PriceObject>; megabytes: number; error?: string }> {
  const byUuid = new Map<string, PriceObject>()
  const remaining = new Set(wanted.keys())
  let bytes = 0

  let res: Response
  try {
    res = await fetch(`${MTGJSON}/AllPrices.json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' }
    })
  } catch (err) {
    return { byUuid, megabytes: 0, error: err instanceof Error ? err.message : String(err) }
  }
  if (!res.ok || !res.body) return { byUuid, megabytes: 0, error: `MTGJSON AllPrices HTTP ${res.status}` }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  // Big enough to span a uuid key split across two chunks.
  const OVERLAP = 128
  let tail = ''
  // Held on an object rather than a bare `let`: TypeScript's control-flow
  // analysis narrows a closure-assigned `let` to `never` here, since the only
  // assignment it can see in this scope is the initial null.
  const state: { cap: Capture | null } = { cap: null }
  let lastTick = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      const text = decoder.decode(value, { stream: true })

      const active = state.cap
      if (active) {
        // Continue collecting this card's object until its braces balance.
        const finished = consumeBalanced(active, text)
        if (finished.done) {
          try {
            byUuid.set(active.uuid, JSON.parse(active.buf) as PriceObject)
          } catch {
            /* malformed slice; skip this card rather than abort the run */
          }
          remaining.delete(active.uuid)
          state.cap = null
          // The remainder of this chunk may hold another wanted uuid.
          tail = finished.rest.slice(-OVERLAP)
          scanChunk(finished.rest)
        }
      } else {
        scanChunk(tail + text)
      }

      const mb = bytes / 1e6
      if (mb - lastTick >= 25) {
        lastTick = mb
        onTick?.(Math.round(mb), byUuid.size)
      }
      if (!remaining.size) break
    }
  } catch (err) {
    return { byUuid, megabytes: bytes / 1e6, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await reader.cancel().catch(() => {})
  }

  return { byUuid, megabytes: Math.round(bytes / 1e6) }

  function scanChunk(chunk: string): void {
    for (const uuid of remaining) {
      const key = `"${uuid}":`
      const at = chunk.indexOf(key)
      if (at === -1) continue
      // Local binding: assigning the closure variable first defeats TS's
      // narrowing inside this nested function.
      const cap = { uuid, buf: '', depth: 0 }
      const finished = consumeBalanced(cap, chunk.slice(at + key.length))
      if (finished.done) {
        try {
          byUuid.set(uuid, JSON.parse(cap.buf) as PriceObject)
        } catch {
          /* malformed slice; skip this card rather than abort the run */
        }
        remaining.delete(uuid)
        state.cap = null
        scanChunk(finished.rest)
      } else {
        state.cap = cap
      }
      return
    }
    tail = chunk.slice(-OVERLAP)
  }
}

/**
 * Append text to a capture until its top-level object closes.
 * Price objects contain only dates and numbers as leaves, but strings are still
 * tracked so a brace inside one could never miscount.
 */
function consumeBalanced(cap: Capture, text: string): { done: boolean; rest: string } {
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    cap.buf += ch
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') cap.depth++
    else if (ch === '}') {
      cap.depth--
      if (cap.depth === 0) return { done: true, rest: text.slice(i + 1) }
    }
  }
  return { done: false, rest: '' }
}

// ---------------------------------------------------------------- prices

/** Local YYYY-MM-DD — the day key prices are bucketed under. */
function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface PriceRefreshResult {
  checked: number
  priced: number
  alerts: number
  errors: string[]
}

interface PriceTarget {
  source: 'scryfall' | 'tcgplayer'
  extId: string
  variant: string
  watchId?: string
  vaultId?: string
  qty: number
  name: string
}

/** Everything with a machine-readable price handle: watchlist rows plus tagged vault items. */
function pricedTargets(): PriceTarget[] {
  const out: PriceTarget[] = []
  const src = (s: string): 'scryfall' | 'tcgplayer' | null =>
    s === 'scryfall' ? 'scryfall' : s === 'tcgplayer' ? 'tcgplayer' : null

  for (const w of db.listMtgWatchlist()) {
    const source = src(w.ext_source)
    if (source && w.ext_id) {
      out.push({ source, extId: w.ext_id, variant: w.variant, watchId: w.id, qty: 1, name: w.name })
    }
  }
  for (const it of db.listVaultItems()) {
    const source = src(it.ext_source ?? '')
    if (source && it.ext_id) {
      out.push({
        source,
        extId: it.ext_id,
        variant: it.variant ?? (source === 'tcgplayer' ? 'sealed' : 'nonfoil'),
        vaultId: it.id,
        qty: it.quantity,
        name: it.name
      })
    }
  }
  return out
}

/**
 * Pull today's Scryfall prices for every tracked card, store one history point
 * per card/variant/day, mirror vault holdings into vault_valuations so the
 * existing Vault chart just works, and fire target-price alerts.
 */
export async function refreshPrices(win?: BrowserWindow): Promise<PriceRefreshResult> {
  const targets = pricedTargets()
  const result: PriceRefreshResult = { checked: targets.length, priced: 0, alerts: 0, errors: [] }
  if (!targets.length) return result

  const cardTargets = targets.filter((t) => t.source === 'scryfall')
  let cards = new Map<string, ScryfallCard>()
  if (cardTargets.length) {
    try {
      cards = await cardsByIds(cardTargets.map((t) => t.extId))
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  const day = today()
  const hits: Array<{ watchId: string; name: string; price: number; target: number }> = []

  for (const t of targets) {
    let price: number | null = null
    let label = ''

    if (t.source === 'scryfall') {
      const card = cards.get(t.extId)
      if (!card) {
        result.errors.push(`${t.name}: no Scryfall card for id ${t.extId}`)
        continue
      }
      price = priceOf(card, t.variant)
      label = `Scryfall ${t.variant} (${card.set.toUpperCase()} #${card.collector_number})`
      if (price == null) {
        result.errors.push(`${t.name}: no ${t.variant} price quoted`)
        continue
      }
    } else {
      price = await tcgSealedPrice(t.extId)
      label = `TCGplayer market (product ${t.extId})`
      if (price == null) {
        result.errors.push(`${t.name}: TCGplayer had no price for product ${t.extId}`)
        continue
      }
      await sleep(GAP_MS)
    }

    db.recordMtgPrice({ ext_id: t.extId, variant: t.variant, price, source: t.source, observed_on: day })
    result.priced++

    if (t.vaultId) {
      // Whole-quantity value, matching the vault_valuations contract.
      db.deleteVaultValuationsToday(t.vaultId, 'market')
      db.addVaultValuation({
        item_id: t.vaultId,
        kind: 'market',
        value_mid: Math.round(price * t.qty * 100) / 100,
        source: label
      })
    }

    if (t.watchId) {
      const w = db.getMtgWatch(t.watchId)
      db.updateMtgWatch(t.watchId, { last_price: price, last_checked_at: Date.now() })
      // Alert once per day at most, and only when the price is at or under target.
      const stale = !w?.last_alert_at || Date.now() - w.last_alert_at > DAY_MS
      if (w?.alert_enabled && w.target_price != null && price <= w.target_price && stale) {
        hits.push({ watchId: t.watchId, name: w.name, price, target: w.target_price })
      }
    }
  }

  for (const h of hits) {
    if (alertsEnabled()) notifyTarget(h.name, h.price, h.target, win)
    db.updateMtgWatch(h.watchId, { last_alert_at: Date.now() })
    result.alerts++
  }
  return result
}

function notifyTarget(name: string, price: number, target: number, win?: BrowserWindow): void {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: 'MTG price target hit',
    body: `${name} is $${price.toFixed(2)} (target $${target.toFixed(2)})`,
    silent: false
  })
  n.on('click', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
      win.webContents.send('mtg:focus', {})
    }
  })
  n.show()
}

// ---------------------------------------------------------------- scheduler

// Scryfall refreshes prices roughly daily, so hourly is already generous; it
// exists to catch the day rolling over while ATLIS stays open, not to chase ticks.
const REFRESH_EVERY_MS = 60 * 60_000
const SET_SYNC_EVERY_MS = 12 * 60 * 60_000
const STARTUP_GRACE_MS = 8_000
// Retail stock moves on its own clock — restocks land at odd hours and a
// preorder flipping live is worth knowing about sooner than a price tick.
const STOCK_EVERY_MS = 20 * 60_000
const STOCK_STARTUP_OFFSET_MS = 45_000
// Sealed prices come from TCGplayer's daily market number, and a followed set
// is 16-25 requests, so once a day is both sufficient and polite.
const SEALED_SWEEP_EVERY_MS = 24 * 60 * 60_000
// The announced-Secret-Lair list changes when Wizards announces a superdrop,
// i.e. every few weeks. Twice a day is plenty and costs one 6KB request.
const SL_SYNC_EVERY_MS = 12 * 60 * 60_000
// EV rows are re-PRICED daily (one cheap request each); the simulation behind
// them is only redone on demand, because that means rebuilding whole card pools.
const EV_REPRICE_EVERY_MS = 24 * 60 * 60_000

/**
 * The EV board reprices itself on this scheduler's clock, but ev.ts imports
 * mtg.ts — so the job is injected rather than imported back, the same way
 * retail.ts takes its Chromium renderer.
 */
type Repricer = () => Promise<unknown>
let evRepricer: Repricer | null = null
export function setEvRepricer(fn: Repricer | null): void {
  evRepricer = fn
}

// ---------------------------------------------------------------- set families

/**
 * Sets grouped the way a collector thinks of them: "The Hobbit" is HOB, its
 * Commander decks (HOC) and every token/promo child, under one header. Scryfall
 * already says which set is whose child via parent_set_code; a family is the
 * tree hanging off one root.
 *
 * Roots are the product-bearing set types. Secret Lair (SLD, type `box`) is
 * admitted by code: it is the one `box` set that is a product line in its own
 * right rather than a one-off gift box.
 */
const FAMILY_ROOT_TYPES = new Set(['expansion', 'core', 'draft_innovation', 'commander', 'masters'])
const FAMILY_ROOT_CODES = new Set(['sld'])
/** Children that never carry sealed product, so there is no MTGJSON catalogue to sync. */
const NO_SEALED_TYPES = new Set(['token', 'memorabilia', 'art_series', 'minigame', 'vanguard', 'promo'])

export type FamilyStage = 'upcoming' | 'in_print' | 'out_of_print'

export interface SetFamily {
  code: string
  name: string
  releasedAt: string | null
  iconSvgUri: string | null
  setType: string | null
  /** Every set code in the family, root first. */
  codes: string[]
  stage: FamilyStage
  /** Catalogue products already synced for the family (0 until it's opened once). */
  products: number
  watched: number
  /** Some member set is in the daily sealed price sweep. */
  followed: boolean
}

function familyRoots(sets: db.MtgSet[]): Map<string, db.MtgSet[]> {
  const byCode = new Map(sets.map((s) => [s.code.toLowerCase(), s]))
  const rootOf = (s: db.MtgSet): db.MtgSet => {
    let cur = s
    for (let i = 0; i < 6 && cur.parent_set_code; i++) {
      const up = byCode.get(cur.parent_set_code.toLowerCase())
      if (!up) break
      cur = up
    }
    return cur
  }
  const out = new Map<string, db.MtgSet[]>()
  for (const s of sets) {
    if (s.digital) continue
    const root = rootOf(s)
    const code = root.code.toLowerCase()
    if (!FAMILY_ROOT_TYPES.has(root.set_type ?? '') && !FAMILY_ROOT_CODES.has(code)) continue
    const list = out.get(code) ?? []
    // Root first, then children in table order.
    if (s === root) list.unshift(s)
    else list.push(s)
    out.set(code, list)
  }
  return out
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function stageOf(releasedAt: string | null, months: number): FamilyStage {
  const now = new Date()
  if (!releasedAt || releasedAt > ymd(now)) return 'upcoming'
  const cutoff = ymd(new Date(now.getFullYear(), now.getMonth() - months, now.getDate()))
  return releasedAt >= cutoff ? 'in_print' : 'out_of_print'
}

/** Every set family, newest first. Cheap: local tables only, nothing fetched. */
export function setFamilies(): SetFamily[] {
  const months = lifecycle.settings().inPrintMonths
  const followed = new Set(listFollowedSealedSets())
  const watchedBySet = new Map<string, number>()
  for (const w of db.listMtgWatchlist()) {
    if (w.kind !== 'sealed' || !w.set_code) continue
    const k = w.set_code.toLowerCase()
    watchedBySet.set(k, (watchedBySet.get(k) ?? 0) + 1)
  }
  const productsBySet = db.mtgSealedCountsBySet()
  const out: SetFamily[] = []
  for (const [code, members] of familyRoots(db.listMtgSets())) {
    const root = members[0]
    const codes = members.map((m) => m.code.toLowerCase())
    out.push({
      code,
      name: root.name,
      releasedAt: root.released_at,
      iconSvgUri: root.icon_svg_uri,
      setType: root.set_type,
      codes,
      stage: stageOf(root.released_at, months),
      products: codes.reduce((n, c) => n + (productsBySet.get(c) ?? 0), 0),
      watched: codes.reduce((n, c) => n + (watchedBySet.get(c) ?? 0), 0),
      followed: codes.some((c) => followed.has(c))
    })
  }
  return out.sort((a, b) => (b.releasedAt ?? '9999').localeCompare(a.releasedAt ?? '9999'))
}

/**
 * The buckets a family's products are shown in. Order is collector-first:
 * Collector Boosters lead because they are what sells out.
 */
export type ProductGroup = 'collector' | 'boosters' | 'commander' | 'bundles' | 'secret_lair' | 'other'

function productGroup(p: db.MtgSealed): ProductGroup {
  const name = p.name.toLowerCase()
  const cat = p.category ?? ''
  const sub = p.subtype ?? ''
  if (sub === 'secret_lair' || name.includes('secret lair')) return 'secret_lair'
  if (sub === 'collector' || name.includes('collector booster')) return 'collector'
  if (sub === 'commander' || /commander deck/.test(name)) return 'commander'
  if (cat.startsWith('booster') || /booster (pack|box|case|display)/.test(name)) return 'boosters'
  if (cat.startsWith('bundle') || name.includes('bundle') || name.includes('gift')) return 'bundles'
  return 'other'
}

export interface FamilyProduct {
  uuid: string
  name: string
  setCode: string
  category: string | null
  subtype: string | null
  group: ProductGroup
  releaseDate: string | null
  tcgplayerProductId: string | null
  price: number | null
  priceOn: string | null
  /** Price ~30 days before `priceOn`, or the oldest point (see db.attachPeriodPrices). */
  p30: number | null
  p30On: string | null
  /** From the EV board, when this product has been evaluated. */
  evMean: number | null
  evNetPct: number | null
  /** The watchlist row tracking this product, if any. */
  watchId: string | null
  watchMode: lifecycle.WatchMode | null
}

export interface FamilyProducts {
  family: SetFamily | null
  products: FamilyProduct[]
  /** Products with a TCGplayer id but no price from today. */
  unpricedToday: number
  synced: string[]
  errors: string[]
}

/**
 * Open one family: make sure each member's sealed catalogue is synced (one
 * MTGJSON file per set, re-fetched once it goes stale), then list every product
 * with its price, 30-day move, EV and watch state.
 *
 * `price: true` also quotes every product without a price from today and
 * records it, so opening a family once starts its history. It is a separate
 * pass because it costs one TCGplayer call per product; the UI shows the
 * catalogue first and prices it after.
 */
export async function familyProducts(code: string, opts: { price?: boolean } = {}): Promise<FamilyProducts> {
  const root = code.toLowerCase()
  const family = setFamilies().find((f) => f.code === root) ?? null
  const out: FamilyProducts = { family, products: [], unpricedToday: 0, synced: [], errors: [] }
  if (!family) return out
  const sets = new Map(db.listMtgSets().map((s) => [s.code.toLowerCase(), s]))

  for (const c of family.codes) {
    if (NO_SEALED_TYPES.has(sets.get(c)?.set_type ?? '')) continue
    if (sealedCatalogueFresh(c)) continue
    try {
      if ((await syncSealedForSet(c)) > 0) out.synced.push(c)
    } catch (err) {
      out.errors.push(`${c.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`)
    }
    await sleep(GAP_MS)
  }
  if (out.synced.length) out.family = setFamilies().find((f) => f.code === root) ?? family

  const catalogue = family.codes.flatMap((c) => db.listMtgSealedAll(c))
  const day = today()
  if (opts.price) {
    for (const p of catalogue) {
      if (!p.tcgplayer_product_id) continue
      const last = db.listMtgPrices(p.tcgplayer_product_id, 'sealed', 1)[0]
      if (last?.observed_on === day) continue
      const price = await tcgSealedPrice(p.tcgplayer_product_id)
      if (price != null) {
        db.recordMtgPrice({ ext_id: p.tcgplayer_product_id, variant: 'sealed', price, source: 'tcgplayer', observed_on: day })
      }
      await sleep(GAP_MS)
    }
  }

  const watches = new Map<string, lifecycle.AnnotatedWatch>()
  for (const w of lifecycle.annotateWatchlist()) {
    if (w.ext_source === 'tcgplayer' && w.ext_id) watches.set(w.ext_id, w)
  }
  const withPeriods = db.attachPeriodPrices(
    catalogue.map((p) => ({ p, ext_id: p.tcgplayer_product_id, variant: 'sealed' as string | null }))
  )
  for (const r of withPeriods) {
    const p = r.p
    const tcg = p.tcgplayer_product_id
    const last = tcg ? db.listMtgPrices(tcg, 'sealed', 1)[0] : undefined
    const ev = db.getMtgEv(p.uuid)
    const w = tcg ? watches.get(tcg) : undefined
    if (tcg && last?.observed_on !== day) out.unpricedToday++
    out.products.push({
      uuid: p.uuid,
      name: p.name,
      setCode: p.set_code,
      category: p.category,
      subtype: p.subtype,
      group: productGroup(p),
      releaseDate: p.release_date,
      tcgplayerProductId: tcg,
      price: last?.price ?? null,
      priceOn: last?.observed_on ?? null,
      p30: r.p30,
      p30On: r.p30_on,
      evMean: ev?.ev_mean ?? null,
      evNetPct: ev?.net_pct ?? null,
      watchId: w?.id ?? null,
      watchMode: w?.mode ?? null
    })
  }
  // Most valuable first inside each group; unpriced sink.
  out.products.sort((a, b) => (b.price ?? -1) - (a.price ?? -1) || a.name.localeCompare(b.name))
  return out
}

// ---------------------------------------------------------------- stock alerts

/**
 * What an MTG watch wants to hear about. `sold_out` is produced but not listed
 * here: it's recorded, not worth a ping.
 */
const MTG_ALERT_KINDS = new Set(['restock', 'preorder_live', 'restock_signal', 'below_market'])

const mtgWatchPolicy: alerts.PolicyResolver = (watchId) => {
  const w = db.getMtgWatch(watchId)
  if (!w?.alert_enabled) return null
  return { kinds: MTG_ALERT_KINDS, cooldownMs: alerts.DEFAULT_COOLDOWN_MS }
}

/** The market listing to open beside a buy link: the exact TCGplayer product when we hold its id. */
function marketLink(w: db.MtgWatch): { label: string; url: string } | null {
  if (w.ext_source === 'tcgplayer' && w.ext_id) {
    return { label: 'TCGplayer market', url: `https://www.tcgplayer.com/product/${w.ext_id}` }
  }
  const tcg = db.listMtgListings({ watchId: w.id }).find((l) => l.retailer === 'tcgplayer' && l.kind !== 'search')
  return tcg ? { label: 'TCGplayer market', url: tcg.url } : null
}

/**
 * Turn a status transition into the event it means, or null when it means
 * nothing worth recording.
 *
 * `unknown` on the FROM side is a listing that had never been read, so its
 * first good read is not a restock.
 */
function stockEventKind(from: string, to: string): string | null {
  if (from === 'unknown' || to === 'unknown') return null
  const wasBuyable = retail.BUYABLE.has(from)
  if (to === 'preorder' && !wasBuyable) return 'preorder_live'
  // In-store-only is "some store somewhere might have it": recorded, never a
  // ping. A drive is only worth it for an order a nearby store has confirmed,
  // which is the local-stock adapter's job, not a Best Buy CHECK_STORES flag.
  if (to === 'in_store_only' && !wasBuyable) return 'in_store_only'
  if (to === 'in_stock' && !wasBuyable) return 'restock'
  if (to === 'sold_out_restocking' && !wasBuyable) return 'restock_signal'
  if (wasBuyable && !retail.BUYABLE.has(to)) return 'sold_out'
  return null
}

/** Status names as a person would say them in an alert. */
const STATUS_WORDS: Record<string, string> = {
  in_stock: 'in stock',
  in_store_only: 'in store only',
  preorder: 'open for preorder',
  listed: 'listed, not orderable',
  sold_out_restocking: 'sold out, restock expected',
  out_of_stock: 'sold out'
}
const said = (status: string): string => STATUS_WORDS[status] ?? status.replace(/_/g, ' ')

function stockDetail(kind: string, t: retail.StockTransition): string {
  const wording = t.rawState ? `retailer says "${t.rawState}"` : null
  switch (kind) {
    case 'restock_signal':
      // Wording is evidence, not a promise, and the alert should read that way.
      return [wording, 'more expected — not yet buyable'].filter(Boolean).join(' · ')
    case 'restock':
      return [t.to === 'in_store_only' ? 'IN STORE ONLY — check nearby stores' : null, `was ${said(t.from)}`]
        .filter(Boolean)
        .join(' · ')
    default:
      return [wording, `was ${said(t.from)}`].filter(Boolean).join(' · ')
  }
}

function stockAlert(kind: string, t: retail.StockTransition, w: db.MtgWatch): alerts.Alert {
  const link = marketLink(w)
  return {
    kind,
    watchId: w.id,
    watchLabel: retail.RETAILER_LABELS[t.retailer] ?? t.retailer,
    extId: t.listingId,
    title: w.name,
    detail: stockDetail(kind, t),
    url: t.url,
    image: w.image_url,
    price: t.price,
    market: w.last_price,
    links: link ? [link] : undefined,
    focus: 'mtg:focus'
  }
}

const ALERTS_KEY = 'mtg_alerts_enabled'

/**
 * Master mute for every MTG desktop notification. Defaults to ON, so an
 * existing install behaves as before until the switch is thrown.
 */
export function alertsEnabled(): boolean {
  return (db.getSetting(ALERTS_KEY) ?? '1') !== '0'
}

export function setAlertsEnabled(on: boolean): boolean {
  db.setSetting(ALERTS_KEY, on ? '1' : '0')
  return on
}

const DAY_MS_DEAL = 24 * 60 * 60_000

/** "At MSRP · 72% under market" — the ladder rung first, then the spread. */
function dealBandWords(d: retail.RetailDeal): string {
  const spread = `${d.discount}% under market`
  switch (d.band) {
    case 'below_msrp':
      return `BELOW MSRP (${d.overMsrpPct}%) · ${spread}`
    case 'at_msrp':
      return `AT MSRP · ${spread}`
    case 'near_msrp':
      return `+${d.overMsrpPct}% over MSRP · ${spread}`
    default:
      return spread
  }
}

/**
 * "A shop has it well under market" — the alert this whole retail watcher
 * exists for. Distinct from the stock alert: a restock at the going rate is
 * noise, a restock at 40% under it is the thing worth interrupting someone for.
 */
function dealAlert(d: retail.RetailDeal, w: db.MtgWatch): alerts.Alert {
  const link = marketLink(w)
  return {
    kind: 'below_market',
    watchId: w.id,
    watchLabel: retail.RETAILER_LABELS[d.retailer] ?? d.retailer,
    extId: d.listingId,
    title: w.name,
    detail: [dealBandWords(d), d.kind === 'preorder' ? 'preorder' : null].filter(Boolean).join(' · '),
    url: d.url,
    image: w.image_url,
    price: d.price,
    market: d.market,
    links: link ? [link] : undefined,
    focus: 'mtg:focus'
  }
}

export interface StockSweepAlerts {
  refresh: retail.StockRefreshResult
  dispatched: alerts.DispatchResult | null
}

/**
 * One stock sweep: re-check watched listings, then send what changed and any
 * new below-market deals through the shared dispatcher, so they reach every
 * sink (desktop AND Discord) under the same cooldown rules as Drops.
 */
export async function sweepStockAndAlert(): Promise<StockSweepAlerts> {
  // watchedOnly: the periodic sweep exists to serve the watchlist. Rows with
  // the bell off, and preorder-board rows nobody watches, are not fetched at
  // all — no traffic, and no notification to suppress later.
  const refresh = await retail.refreshListings({ watchedOnly: true })
  if (!alertsEnabled()) return { refresh, dispatched: null }

  const out: alerts.Alert[] = []
  // A listing that just came back already carries price, market and spread,
  // so it must not ALSO send "below market" in the same sweep.
  const pingedListings = new Set<string>()
  for (const t of refresh.transitions) {
    if (!t.watchId) continue
    const kind = stockEventKind(t.from, t.to)
    const w = kind ? db.getMtgWatch(t.watchId) : undefined
    if (!kind || !w) continue
    out.push(stockAlert(kind, t, w))
    if (kind === 'restock' || kind === 'preorder_live') pingedListings.add(t.listingId)
  }

  // Deals are evaluated after the sweep, from the prices it just wrote.
  // Throttled per listing so a week-long sale doesn't nag daily.
  for (const d of retail.deals()) {
    const w = db.getMtgWatch(d.watchId)
    if (!w?.alert_enabled) continue
    if (d.alertedAt && Date.now() - d.alertedAt < DAY_MS_DEAL) continue
    db.markMtgListingDealAlert(d.listingId)
    if (!pingedListings.has(d.listingId)) out.push(dealAlert(d, w))
  }

  const dispatched = out.length ? await alerts.dispatch(out, mtgWatchPolicy) : null
  return { refresh, dispatched }
}

function mtgAppHidden(): boolean {
  try {
    return (JSON.parse(db.getSetting('disabled_apps') || '[]') as string[]).includes('mtg')
  } catch {
    return false
  }
}

/** Periodic price refresh + calendar sync while ATLIS runs; pushes `mtg:changed`. */
export function startMtgScheduler(win: BrowserWindow): () => void {
  let stopped = false
  let lastSetSync = 0
  let lastSealed = 0
  let lastSl = 0
  let lastEv = 0

  const tick = async (): Promise<void> => {
    if (stopped || win.isDestroyed()) return
    if (mtgAppHidden()) return
    try {
      if (Date.now() - lastSetSync > SET_SYNC_EVERY_MS) {
        await syncSets()
        syncCalendar()
        lastSetSync = Date.now()
      }
      await refreshPrices(win)
      if (evRepricer && Date.now() - lastEv > EV_REPRICE_EVERY_MS && db.listMtgEv().length) {
        lastEv = Date.now()
        await evRepricer()
      }
      if (Date.now() - lastSl > SL_SYNC_EVERY_MS) {
        lastSl = Date.now()
        // Never fatal: a bad sync keeps the last known list (see secretlair.ts).
        await secretlair.syncUpcoming()
      }
      if (Date.now() - lastSealed > SEALED_SWEEP_EVERY_MS && listFollowedSealedSets().length) {
        lastSealed = Date.now()
        await refreshFollowedSealed()
      }
    } catch {
      // Network blips are expected; the next tick retries.
    }
    if (!stopped && !win.isDestroyed()) {
      win.webContents.send('mtg:changed', {})
      // refreshPrices writes vault_valuations for owned items, so the Vault's
      // totals are stale until it hears about it too — without this an open
      // Vault shows yesterday's estimate until the view is remounted.
      win.webContents.send('vault:changed', {})
    }
  }

  // Stock runs on its OWN clock. It used to be gated inside the hourly tick,
  // which silently made the 20-minute cadence hourly.
  let stockRunning = false
  const stockTick = async (): Promise<void> => {
    if (stopped || win.isDestroyed() || stockRunning) return
    if (mtgAppHidden()) return
    stockRunning = true
    try {
      const r = await sweepStockAndAlert()
      if (r.refresh.changed && !win.isDestroyed()) win.webContents.send('mtg:changed', {})
    } catch {
      // Network blips are expected; the next tick retries.
    } finally {
      stockRunning = false
    }
  }

  const startup = setTimeout(() => void tick(), STARTUP_GRACE_MS)
  const interval = setInterval(() => void tick(), REFRESH_EVERY_MS)
  interval.unref?.()
  // Offset from the price tick so startup isn't one burst of both.
  const stockStartup = setTimeout(() => void stockTick(), STARTUP_GRACE_MS + STOCK_STARTUP_OFFSET_MS)
  const stockInterval = setInterval(() => void stockTick(), STOCK_EVERY_MS)
  stockInterval.unref?.()
  const stop = (): void => {
    stopped = true
    clearTimeout(startup)
    clearInterval(interval)
    clearTimeout(stockStartup)
    clearInterval(stockInterval)
  }
  win.on('closed', stop)
  return stop
}
