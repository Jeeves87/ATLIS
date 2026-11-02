/**
 * EDHREC commander popularity — "does anybody actually build this?"
 *
 * A collection knows which Legendary Creatures are in the box. It cannot know
 * which of them are real commanders, because nothing on the card says so: a
 * mythic legend from a draft set and a format-defining commander look
 * identical in a vault row. EDHREC aggregates real decklists, so its deck
 * count per commander is the closest thing to an objective answer.
 *
 * Deliberately NOT Archidekt, which was the obvious candidate: its
 * `commanderName` search is fuzzy and returns decks where the card is merely
 * present, so "Sol Ring" came back with a thousand "commander" decks. Counting
 * those would call every card in the collection a popular commander.
 *
 * The sync walks EDHREC's per-colour-identity top lists rather than asking
 * about each owned card one at a time — 32 requests covering ~2,700
 * commanders, instead of one 100KB page per legend in the vault. The tradeoff
 * is that coverage stops at the top ~100 per colour, which is not a gap so
 * much as the answer: a legend missing from these lists is one almost nobody
 * builds, and that is exactly what the user is trying to find out.
 */
import * as db from './db'

const UA = 'ATLIS/1.0 (personal collection tracker)'
const API = 'https://json.edhrec.com/pages'

// EDHREC is a free community site with no published rate limit. A full sync is
// 32 requests, so a courteous gap costs ~13s total and keeps this well below
// anything that could look like scraping.
const GAP_MS = 400

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Every colour identity EDHREC files commanders under.
 *
 * The four-colour guild names are EDHREC's own ("glint-eye" for UBRG, not
 * "glint"), and the mono/colourless pages live at their spelled-out slugs
 * rather than single letters — /commanders/w redirects to /commanders/mono-white.
 */
const COLOR_SLUGS = [
  'colorless',
  'mono-white', 'mono-blue', 'mono-black', 'mono-red', 'mono-green',
  'azorius', 'dimir', 'rakdos', 'gruul', 'selesnya',
  'orzhov', 'izzet', 'golgari', 'boros', 'simic',
  'esper', 'grixis', 'jund', 'naya', 'bant',
  'abzan', 'jeskai', 'sultai', 'mardu', 'temur',
  'glint-eye', 'dune-brood', 'ink-treader', 'witch-maw', 'yore-tiller',
  'five-color'
] as const

interface EdhrecCardView {
  name: string
  sanitized?: string
  slug?: string
  num_decks?: number
  potential_decks?: number
}

interface EdhrecPage {
  redirect?: string
  container?: {
    json_dict?: {
      cardlists?: Array<{ header?: string; cardviews?: EdhrecCardView[] }>
    }
  }
}

async function efetch(slug: string): Promise<EdhrecPage> {
  const res = await fetch(`${API}/commanders/${slug}.json`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`EDHREC ${res.status} on ${slug}`)
  return (await res.json()) as EdhrecPage
}

export interface CommanderSyncResult {
  colors: number
  commanders: number
  failed: string[]
}

/**
 * Refresh the commander popularity table from EDHREC's colour pages.
 *
 * A colour that fails is recorded and skipped rather than aborting the run:
 * 31 colours of data is far more useful than none, and the previous sync's
 * rows for the failed colour stay in place because replaceCommanderStats is
 * only called on success.
 */
export async function syncCommanderStats(): Promise<CommanderSyncResult> {
  let colors = 0
  let commanders = 0
  const failed: string[] = []

  for (const slug of COLOR_SLUGS) {
    try {
      const page = await efetch(slug)
      // A redirect body means the slug moved; the list is elsewhere, and
      // guessing the new one in a loop is worse than reporting it.
      if (page.redirect) throw new Error(`redirects to ${page.redirect}`)

      const views = (page.container?.json_dict?.cardlists ?? []).flatMap((l) => l.cardviews ?? [])
      if (!views.length) throw new Error('no commanders in payload')

      db.replaceCommanderStats(
        slug,
        views.map((v, i) => ({
          name_key: db.cardNameKey(v.name),
          name: v.name,
          slug: v.sanitized ?? v.slug ?? null,
          num_decks: Number(v.num_decks) || 0,
          potential_decks: v.potential_decks == null ? null : Number(v.potential_decks),
          // Position in the page IS the rank — EDHREC serves these sorted by
          // deck count, and it has no rank field of its own.
          rank_in_color: i + 1
        }))
      )
      colors++
      commanders += views.length
    } catch (e) {
      failed.push(`${slug}: ${e instanceof Error ? e.message : String(e)}`)
    }
    await sleep(GAP_MS)
  }

  return { colors, commanders, failed }
}

/** Where a human can go read about this commander. */
export function commanderUrl(slug: string | null, name: string): string {
  return `https://edhrec.com/commanders/${slug ?? db.cardNameKey(name).replace(/ /g, '-')}`
}

// ---------------------------------------------------------------- precon decklists

export interface PreconDeck {
  /** EDHREC's page title, e.g. "Odds and Ends Precon - Secret Lair Drop". */
  header: string
  url: string
  /** One row per printing; scryfallId is the exact printing EDHREC lists. */
  cards: Array<{ scryfallId: string; count: number; commander: boolean }>
}

/** EDHREC's precon slug: "Odds and Ends" → "odds-and-ends". */
export function preconSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * A preconstructed deck's full list from EDHREC — the fallback for decks
 * MTGJSON names but has not published yet (Secret Lair commander decks land
 * there days to weeks late; EDHREC has them within days of release).
 *
 * The page's `archidekt` array is the useful part: `{c, q, u}` = category
 * ('c' commander, 'm' main), quantity, and the Scryfall PRINTING id — so it
 * prices exactly like an MTGJSON list. Its `f` foil flag is always 0 even for
 * foil-only printings; callers decide finish from the printing itself.
 *
 * Returns null on any miss: unknown slug (EDHREC answers 403, not 404), a
 * changed payload, or a network failure. Never throws.
 */
export async function preconDeck(name: string): Promise<PreconDeck | null> {
  const slug = preconSlug(name)
  if (!slug) return null
  try {
    const r = await fetch(`${API}/precon/${slug}.json`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    if (!r.ok) return null
    const j = (await r.json()) as { header?: string; archidekt?: Array<{ c?: string; q?: number; u?: string }> }
    const cards = (j.archidekt ?? [])
      .filter((x) => typeof x.u === 'string' && x.u)
      .map((x) => ({ scryfallId: String(x.u), count: Math.max(1, Number(x.q) || 1), commander: x.c === 'c' }))
    if (!cards.length) return null
    return { header: j.header ?? name, url: `https://edhrec.com/precon/${slug}`, cards }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- commander recs + combos

export interface EdhrecCombo {
  id: string
  /** Decks EDHREC counts running this combo. */
  count: number
  /** EDHREC's popularity rank across all combos (1 = most played). */
  rank: number | null
  cards: Array<{ name: string; scryfallId: string | null }>
  results: string[]
  url: string
}

export interface EdhrecRec {
  name: string
  scryfallId: string | null
  /** Share of this commander's decks running the card, 0..1. */
  inclusion: number
  synergy: number
  /** EDHREC's section, e.g. "Creatures", "Mana Artifacts". */
  category: string
}

export interface CommanderPage {
  slug: string
  url: string
  numDecks: number | null
  recs: EdhrecRec[]
  combos: EdhrecCombo[]
}

/** Weekly is plenty: recommendations drift slowly, and each refresh is two fetches. */
const PAGE_TTL_MS = 7 * 86_400_000
/** Showcase sections whose cards also appear under their real type heading. */
const META_SECTIONS = new Set(['New Cards', 'Top Cards', 'High Lift Cards', 'High Synergy Cards', 'Game Changers'])

interface RawCardview {
  id?: string
  name?: string
  synergy?: number
  num_decks?: number
  potential_decks?: number
  url?: string
}
interface RawPage {
  container?: { json_dict?: {
    card?: { num_decks?: number }
    cardlists?: Array<{
      header?: string
      cardviews?: RawCardview[]
      combo?: { comboId?: string; count?: number; rank?: number; results?: string[] }
    }>
  } }
}

async function pageJson(path: string): Promise<RawPage | null> {
  const r = await fetch(`${API}/${path}.json`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  // EDHREC answers 403 (not 404) for a slug it doesn't know.
  if (r.status === 403 || r.status === 404) return null
  if (!r.ok) throw new Error(`EDHREC ${r.status} on ${path}`)
  return (await r.json()) as RawPage
}

/**
 * A commander's recommended cards and its combos. Partner pairs are one page
 * on EDHREC, slugged as both names joined; the alphabetical order is tried
 * first because that is how EDHREC files them. Cached in the DB for a week;
 * a failed refresh falls back to the stale copy rather than to nothing.
 */
export async function commanderPage(names: string[], force = false): Promise<CommanderPage | null> {
  if (!names.length) return null
  const slugs = [...new Set([
    [...names].sort().map(preconSlug).join('-'),
    names.map(preconSlug).join('-')
  ])]
  for (const slug of slugs) {
    const cached = db.getMtgEdhrecPage(slug)
    if (cached && !force && Date.now() - cached.fetched_at < PAGE_TTL_MS) return JSON.parse(cached.data) as CommanderPage
  }

  for (const slug of slugs) {
    try {
      const page = await pageJson(`commanders/${slug}`)
      if (!page) continue
      await sleep(GAP_MS)
      const combosPage = await pageJson(`combos/${slug}`)

      const byName = new Map<string, EdhrecRec>()
      for (const list of page.container?.json_dict?.cardlists ?? []) {
        const header = list.header ?? ''
        for (const v of list.cardviews ?? []) {
          if (!v.name || !v.potential_decks) continue
          const rec: EdhrecRec = {
            name: v.name,
            scryfallId: v.id ?? null,
            inclusion: (v.num_decks ?? 0) / v.potential_decks,
            synergy: v.synergy ?? 0,
            category: META_SECTIONS.has(header) ? '' : header
          }
          const prev = byName.get(v.name)
          if (!prev) byName.set(v.name, rec)
          else if (!prev.category && rec.category) prev.category = rec.category
        }
      }
      const combos: EdhrecCombo[] = []
      for (const list of combosPage?.container?.json_dict?.cardlists ?? []) {
        if (!list.combo?.comboId || !list.cardviews?.length) continue
        combos.push({
          id: list.combo.comboId,
          count: list.combo.count ?? 0,
          rank: list.combo.rank ?? null,
          cards: list.cardviews.filter((c) => c.name).map((c) => ({ name: String(c.name), scryfallId: c.id ?? null })),
          results: list.combo.results ?? [],
          url: `https://edhrec.com${list.cardviews[0].url ?? `/combos/${slug}`}`
        })
      }
      const out: CommanderPage = {
        slug,
        url: `https://edhrec.com/commanders/${slug}`,
        numDecks: page.container?.json_dict?.card?.num_decks ?? null,
        recs: [...byName.values()],
        combos
      }
      db.putMtgEdhrecPage(slug, JSON.stringify(out))
      return out
    } catch {
      const stale = db.getMtgEdhrecPage(slug)
      if (stale) return JSON.parse(stale.data) as CommanderPage
    }
  }
  return null
}

// ---------------------------------------------------------------- deck explorer

/**
 * EDHREC's bracket pages, by the slug its URLs use. The Commander brackets
 * are WotC's 1–5 power scale; a deck's own bracket is what its builder
 * tagged, so most rows have none and only show up under "any".
 */
export const BRACKETS = [
  { n: 1, slug: 'exhibition', label: 'Exhibition' },
  { n: 2, slug: 'core', label: 'Core' },
  { n: 3, slug: 'upgraded', label: 'Upgraded' },
  { n: 4, slug: 'optimized', label: 'Optimized' },
  { n: 5, slug: 'cedh', label: 'cEDH' }
] as const

export interface ExploreFilter {
  /** Commander names; two for a partner pair. */
  commanders: string[]
  bracket?: number | null
  /** EDHREC theme slug, e.g. 'group-hug'. */
  theme?: string | null
}

export interface ExploreDeckRow {
  hash: string
  saved: string | null
  price: number | null
  salt: number | null
  bracket: number | null
  tags: string[]
}

export interface ExplorePage {
  commander: string
  slug: string
  url: string
  header: string
  /** All decks EDHREC has for the commander, regardless of filter. */
  num_decks: number | null
  /** Decks matching the current bracket/theme. */
  matching: number
  bracket_counts: Record<string, number>
  themes: Array<{ slug: string; label: string; count: number }>
  similar: string[]
  decks: ExploreDeckRow[]
}

export interface EdhrecDeckList {
  header: string
  commanders: string[]
  cards: Array<{ name: string; quantity: number; board: 'commander' | 'main' }>
  /** Where the list really lives (Moxfield/Archidekt) for a user deck; EDHREC's page for an average one. */
  url: string
  saved: string | null
  price: number | null
  tags: string[]
}

interface RawDeckTable {
  header?: string
  similar?: string[]
  bracket_counts?: Record<string, number>
  tag_counts?: Array<{ count?: number; slug?: string; value?: string }>
  table?: Array<{ urlhash?: string; savedate?: string; price?: number; salt?: number; bracket?: number | null; tags?: string[] }>
  container?: { json_dict?: { card?: { name?: string; num_decks?: number } } }
}

interface RawDeck {
  header?: string
  url?: string
  savedate?: string
  price?: number
  tags?: string[]
  deck?: { commander?: string[]; commander_v2?: Array<[string, number]>; cards?: Record<string, Array<[string, number]>> }
}

/** A deck table page is 0.03–12 MB, so it's kept in memory, not re-fetched per click. */
const EXPLORE_TTL_MS = 6 * 60 * 60_000
const EXPLORE_ROWS = 200
const exploreCache = new Map<string, { at: number; page: ExplorePage }>()

/** Slugs to try for a commander or pair; a DFC is slugged by its front face. */
function commanderSlugs(names: string[]): string[] {
  const fronts = names.map((n) => n.split(' // ')[0])
  return [...new Set([[...fronts].sort().map(preconSlug).join('-'), fronts.map(preconSlug).join('-')])].filter(Boolean)
}

/** EDHREC's path suffix for a filter: bracket first, then theme (the other order 403s). */
function filterPath(f: ExploreFilter): string {
  const b = BRACKETS.find((x) => x.n === f.bracket)
  return [b?.slug, f.theme ? preconSlug(f.theme) : null].filter(Boolean).map((s) => `/${s}`).join('')
}

async function rawJson<T>(url: string): Promise<T | null> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  // EDHREC answers 403 (not 404) for a slug or filter it doesn't know.
  if (r.status === 403 || r.status === 404) return null
  if (!r.ok) throw new Error(`EDHREC answered HTTP ${r.status}`)
  return (await r.json()) as T
}

/**
 * The real decks EDHREC has indexed for a commander, newest first, with its
 * theme and bracket breakdown — the "what are people doing with this" view.
 * Rows are trimmed to the newest EXPLORE_ROWS; `matching` is the full count.
 */
export async function exploreCommander(f: ExploreFilter): Promise<ExplorePage | null> {
  const suffix = filterPath(f)
  for (const slug of commanderSlugs(f.commanders)) {
    const key = `${slug}${suffix}`
    const hit = exploreCache.get(key)
    if (hit && Date.now() - hit.at < EXPLORE_TTL_MS) return hit.page
    const raw = await rawJson<RawDeckTable>(`${API}/decks/${key}.json`)
    if (!raw) continue
    const table = raw.table ?? []
    const page: ExplorePage = {
      commander: raw.container?.json_dict?.card?.name ?? f.commanders.join(' + '),
      slug,
      url: `https://edhrec.com/decks/${key}`,
      header: raw.header ?? `Decks with ${f.commanders.join(' + ')}`,
      num_decks: raw.container?.json_dict?.card?.num_decks ?? null,
      matching: table.length,
      bracket_counts: raw.bracket_counts ?? {},
      themes: (raw.tag_counts ?? [])
        .filter((t) => t.slug && t.value)
        .slice(0, 30)
        .map((t) => ({ slug: String(t.slug), label: String(t.value), count: Number(t.count) || 0 })),
      similar: raw.similar ?? [],
      decks: table.slice(0, EXPLORE_ROWS).filter((r) => r.urlhash).map((r) => ({
        hash: String(r.urlhash),
        saved: r.savedate ?? null,
        price: typeof r.price === 'number' ? r.price : null,
        salt: typeof r.salt === 'number' ? Math.round(r.salt * 10) / 10 : null,
        bracket: typeof r.bracket === 'number' ? r.bracket : null,
        tags: r.tags ?? []
      }))
    }
    exploreCache.set(key, { at: Date.now(), page })
    return page
  }
  return null
}

function deckFrom(raw: RawDeck, fallbackUrl: string): EdhrecDeckList | null {
  const d = raw.deck
  if (!d?.cards) return null
  const commanders = (d.commander_v2?.map((c) => c[0]) ?? d.commander ?? []).filter(Boolean)
  const cards: EdhrecDeckList['cards'] = [
    ...commanders.map((name) => ({ name, quantity: 1, board: 'commander' as const })),
    ...Object.values(d.cards).flat()
      .filter((c) => Array.isArray(c) && c[0])
      .map(([name, q]) => ({ name, quantity: Math.max(1, Number(q) || 1), board: 'main' as const }))
  ]
  if (cards.length <= commanders.length) return null
  return {
    header: raw.header ?? commanders.join(' + '),
    commanders,
    cards,
    url: raw.url || fallbackUrl,
    saved: raw.savedate ?? null,
    price: typeof raw.price === 'number' ? Math.round(raw.price * 100) / 100 : null,
    tags: raw.tags ?? []
  }
}

/** One user deck from EDHREC's index, by its urlhash. Null when EDHREC has dropped it. */
export async function userDeck(hash: string): Promise<EdhrecDeckList | null> {
  const safe = encodeURIComponent(hash)
  const raw = await rawJson<RawDeck>(`https://edhrec.com/api/deckpreview/${safe}`)
  return raw ? deckFrom(raw, `https://edhrec.com/deckpreview/${safe}`) : null
}

/** EDHREC's average deck for a commander, optionally narrowed to a bracket and/or theme. */
export async function averageDeck(f: ExploreFilter): Promise<EdhrecDeckList | null> {
  const suffix = filterPath(f)
  for (const slug of commanderSlugs(f.commanders)) {
    const raw = await rawJson<RawDeck>(`${API}/average-decks/${slug}${suffix}.json`)
    const deck = raw && deckFrom(raw, `https://edhrec.com/average-decks/${slug}${suffix}`)
    if (deck) return { ...deck, url: `https://edhrec.com/average-decks/${slug}${suffix}` }
  }
  return null
}
