import * as db from './db'
import * as mtg from './mtg'
import { productLanguage } from './retail'

/**
 * Standing expected-value board for sealed product.
 *
 * The question this answers is "is anything worth opening right now", without
 * anyone having to remember to check a particular product. Everything needed
 * was already here — a deterministic itemiser for fixed contents, a Monte
 * Carlo simulator for boosters, and daily TCGplayer prices — so this module is
 * mostly routing: decide which machine each product belongs to, run it, store
 * the answer, and keep the price half fresh.
 *
 * TWO METHODS, and the difference matters when reading the board:
 *  - `deterministic` — the contents are known exactly (a Commander deck).
 *    The EV is a fact about today's card prices, not an average.
 *  - `simulated` — the contents are random (packs, boxes, cases, bundles).
 *    The mean is what you'd get across many units; the MEDIAN is what a
 *    typical single unit returns, and for boosters those two diverge wildly.
 *    Both are stored; the board leads with the mean but shows the median,
 *    because a product whose mean beats its price while its median does not is
 *    a lottery ticket, not an investment.
 *
 * Every caveat from the underlying machinery still applies and is repeated in
 * the UI: prices are retail asks (a buylist realises roughly half), bulk is
 * counted at face value, and unpriced chase cards contribute zero.
 */

/** Product lines worth evaluating. Singles-shaped and novelty items are skipped. */
const KIND_RULES: Array<{ kind: string; re: RegExp }> = [
  { kind: 'case', re: /\bcase\b/i },
  { kind: 'box', re: /booster box|booster display|\bdisplay\b/i },
  { kind: 'deck', re: /commander deck|precon|planeswalker deck|challenger deck|starter kit/i },
  { kind: 'bundle', re: /\bbundle\b|gift edition/i },
  { kind: 'pack', re: /booster pack|\bbooster$/i }
]

function kindOf(name: string, category?: string | null): string {
  for (const r of KIND_RULES) if (r.re.test(name)) return r.kind
  if (category === 'booster_box') return 'box'
  if (category === 'booster_case') return 'case'
  if (category === 'deck') return 'deck'
  if (category === 'bundle') return 'bundle'
  if (category === 'booster_pack') return 'pack'
  return 'other'
}

/** Anything that can't have a meaningful EV: promos, single cards, accessories. */
const SKIP_RE = /\bsample\b|\bpromo pack\b|\bland station\b|\bsleeve|\bplaymat|\bbox topper\b|\bart series\b|\btoken\b/i

export interface EvScanOptions {
  /** Only sets released within this many days, plus anything upcoming. */
  sinceDays?: number
  /** Hard cap on products evaluated in one run. */
  maxProducts?: number
  /** Re-simulate rows that already have an EV instead of only re-pricing them. */
  recompute?: boolean
  /** Restrict to these set codes. */
  setCodes?: string[]
}

export interface EvScanResult {
  sets: number
  products: number
  evaluated: number
  repriced: number
  skipped: number
  errors: string[]
}

/**
 * Bump when the model changes in a way that invalidates stored numbers. Rows
 * from an older engine are recomputed instead of being repriced, so a bad
 * figure cannot outlive the bug that produced it.
 *
 * 2 — added the price-coverage gate. Version 1 happily simulated unreleased
 *     sets whose only quotes were preorder asks on chase cards, and reported
 *     things like "+1403%" on a Star Trek booster box.
 * 3 — sampling fixed (draw a CARD, then a printing, instead of drawing
 *     printings uniformly — which made a card with five premium versions five
 *     times as likely as one with a single printing), pool restricted to
 *     printings a booster can actually contain, and the RETURN figure moved
 *     from the mean to the median for simulated products.
 * 4 — booster simulation now runs off MTGJSON's published PRINT SHEETS, with
 *     real per-card pull weights, instead of a slot-and-rarity approximation.
 *     Final Fantasy's collector booster went from a $162 mean to $59, because
 *     the model had been handing out 1-in-1,667 chase printings at roughly
 *     1-in-20 of a mythic slot.
 * 5 — stopped filtering the card pool on Scryfall's `booster` flag, which is
 *     not populated for every set: The Hobbit marks all 321 of its printings
 *     false, base cards included, so the filter emptied the pool and blanked
 *     the whole set. The flag is now consulted only when a set uses it, and
 *     not at all when real print sheets are available.
 */
const EV_ENGINE_VERSION = 5

/** A deck priced from a fraction of its cards understates by an unknown amount. */
const MIN_DETERMINISTIC_COVERAGE = 0.8

/**
 * Breadth beats depth on a first pass. Without a per-set cap one big
 * expansion's seventeen products swallow a third of the run, and the sets
 * behind it — including the Commander sets, which carry the clearest
 * arbitrage — never get looked at.
 */
const MAX_PRODUCTS_PER_SET = 8

const SIMULATIONS = 8_000
/** A case is 72 packs × 8k trials; simulating those is real work, so fewer. */
const BIG_UNIT_SIMULATIONS = 2_000
const BIG_UNIT_PACKS = 30

/**
 * Set types that never carry sealed product worth valuing. Tokens, art series
 * and memorabilia have catalogues but nothing to open.
 */
const BARREN_SET_TYPES = new Set(['token', 'memorabilia', 'minigame', 'vanguard', 'treasure_chest'])

/**
 * Sets worth spending scan budget on: RELEASED, non-digital, and capable of
 * holding sealed product.
 *
 * Unreleased sets are excluded outright. They can't be valued — nothing is
 * priced until a set has been out for weeks, and the coverage gate refuses
 * them — but they sort FIRST under "newest first" and were consuming the whole
 * product budget before the walk reached anything real. Star Trek, Reality
 * Fracture and their token/commander children alone accounted for ~7 of the
 * first 8 sets, which is why released Commander sets never got scanned.
 */
function candidateSets(sinceDays: number, only?: string[]): db.MtgSet[] {
  const now = Date.now()
  const floor = now - sinceDays * 86_400_000
  return db.listMtgSets().filter((s) => {
    if (s.digital || !s.released_at) return false
    if (only?.length) return only.includes(s.code)
    if (BARREN_SET_TYPES.has(s.set_type ?? '')) return false
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.released_at)
    if (!m) return false
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
    // Released already, and recent enough to still be worth watching.
    return t >= floor && t <= now
  })
}

/**
 * Evaluate one product. Returns null when it has no price (nothing to compare
 * against) or no valuable contents to model.
 */
export async function evaluate(uuid: string, recompute = false): Promise<db.MtgEvRow | null> {
  const row = db.getMtgSealed(uuid)
  if (!row || SKIP_RE.test(row.name)) return null

  const price = row.tcgplayer_product_id ? await mtg.tcgSealedPrice(row.tcgplayer_product_id) : null
  const existing = db.getMtgEv(uuid)
  const kind = kindOf(row.name, row.category)

  // Re-pricing is one cheap request; re-simulating means rebuilding a set's
  // whole card pool. When only the price moved, keep the EV and redo the maths
  // — but never for a row an older model produced.
  const stale = (existing?.engine ?? 0) < EV_ENGINE_VERSION
  if (!recompute && !stale && existing?.ev_mean != null) {
    const basis = existing.method === 'simulated' ? existing.ev_median : existing.ev_mean
    const net = basis == null || price == null ? null : Math.round((basis - price) * 100) / 100
    const updated: db.MtgEvRow = {
      ...existing,
      price,
      net,
      net_pct: basis == null || price == null || price === 0 ? null : Math.round(((basis - price) / price) * 1000) / 10,
      priced_at: price == null ? existing.priced_at : Date.now(),
      computed_at: existing.computed_at
    }
    db.upsertMtgEv(updated)
    return updated
  }

  const composition = await mtg.sealedComposition(row.set_code, uuid)
  let evMean: number | null = null
  let evMedian: number | null = null
  let evLiquid: number | null = null
  let chance: number | null = null
  let method = 'deterministic'
  let basisUsed = ''
  let note: string | null = null

  if (composition.totalPacks > 0) {
    method = 'simulated'
    // Fixed contents ride along inside every trial (a bundle's decklist).
    const fixed = await mtg.sealedContents(uuid)
    const fixedValue = fixed?.cards.length ? fixed.singlesTotal : 0
    const sims = composition.totalPacks >= BIG_UNIT_PACKS ? BIG_UNIT_SIMULATIONS : SIMULATIONS
    const r = await mtg.unitEv(row.set_code, composition.packs, sims, price, fixedValue)
    basisUsed = r.basis
    if (r.note) {
      note = r.note
    } else {
      evMean = r.mean
      evMedian = r.median
      evLiquid = r.meanLiquid
      chance = r.chanceOfProfit
      if (fixedValue > 0) note = `Includes ${fixed?.cardCount} fixed cards worth ${fixedValue.toFixed(2)}.`
      if (composition.unmodelled.length) {
        note = `${note ? `${note} ` : ''}Not modelled: ${composition.unmodelled.join(', ')} — excluded, so the real figure is a little higher.`
      }
      if (r.basis === 'model') {
        note = `${note ? `${note} ` : ''}This set has not published its print sheets, so pack structure is approximated — treat the figure as a rough estimate.`
      }
    }
  } else {
    const c = await mtg.sealedContents(uuid)
    if (!c || !c.cards.length) return null
    const coverage = c.cards.length ? c.pricedCount / c.cards.length : 0
    // A partial itemisation must not become an EV — same rule as the panel.
    if (!c.complete) {
      note = c.note
      evMean = null
    } else if (coverage < MIN_DETERMINISTIC_COVERAGE) {
      // Same trap as the simulated side: an unreleased set prices only its
      // chase cards, so a total built from those is not the deck's value.
      note = `Only ${c.pricedCount} of ${c.cards.length} cards in this product have a price (${Math.round(coverage * 100)}%), so a total would be guesswork. Sets price up over the weeks after release.`
      evMean = null
    } else {
      evMean = c.singlesTotal
      evLiquid = Math.round(c.cards.reduce((n, x) => n + (x.lineTotal != null && x.unitPrice! >= 2 ? x.lineTotal : 0), 0) * 100) / 100
      if (c.randomComponents.length) {
        note = `Excludes ${c.randomComponents.join(', ')} — random contents, so the real figure is a little higher.`
      }
    }
  }

  if (evMean == null && note == null) return null

  /**
   * The number the board ranks on.
   *
   * For a random product this is the MEDIAN, not the mean. The mean answers
   * "what would I average over many boxes", which is not the question anyone
   * is actually asking at a shop counter, and it is the figure most distorted
   * by the part of the model that is guesswork — how often a four-figure chase
   * printing turns up. The median is what a typical single unit returns and is
   * barely moved by that tail. Deterministic products have no distribution, so
   * their exact contents total is used.
   */
  const basis = method === 'simulated' ? evMedian : evMean
  const net = basis == null || price == null ? null : Math.round((basis - price) * 100) / 100
  const out: db.MtgEvRow = {
    uuid,
    set_code: row.set_code,
    name: row.name,
    kind,
    tcgplayer_product_id: row.tcgplayer_product_id,
    price,
    ev_mean: evMean,
    ev_median: evMedian,
    ev_liquid: evLiquid,
    method,
    packs: composition.totalPacks,
    chance_of_profit: chance,
    net,
    net_pct: basis == null || price == null || price === 0 ? null : Math.round(((basis - price) / price) * 1000) / 10,
    note,
    priced_at: price == null ? null : Date.now(),
    computed_at: Date.now(),
    engine: EV_ENGINE_VERSION,
    basis: basisUsed
  }
  db.upsertMtgEv(out)
  return out
}

/**
 * Sweep recent and upcoming sets, evaluating every product line worth knowing
 * about. Bounded by a product cap because each unfamiliar set costs a card-pool
 * build, and an unbounded first run would sit there for a very long time.
 */
export async function scan(opts: EvScanOptions = {}, onProgress?: (msg: string) => void): Promise<EvScanResult> {
  const sinceDays = opts.sinceDays ?? 365
  const maxProducts = opts.maxProducts ?? 60
  const out: EvScanResult = { sets: 0, products: 0, evaluated: 0, repriced: 0, skipped: 0, errors: [] }

  for (const set of candidateSets(sinceDays, opts.setCodes)) {
    if (out.products >= maxProducts) {
      out.errors.push(`stopped at the ${maxProducts}-product budget — run again to continue`)
      break
    }
    out.sets++
    try {
      // Catalogue is pulled lazily, exactly like the preorder sweep does it.
      if (!db.mtgSealedSetSynced(set.code)) await mtg.syncSealedForSet(set.code)
    } catch (err) {
      out.errors.push(`${set.code.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    // Products this run hasn't seen before come first, so successive scans
    // widen coverage instead of re-treading the same rows.
    const inSet = db
      .listSealedForSet(set.code)
      // Import printings are a separate market and their contents are priced
      // here from ENGLISH singles, so a Japanese box would be valued against
      // cards it doesn't contain. Skipped rather than valued wrongly.
      .filter((p) => p.tcgplayer_product_id && !SKIP_RE.test(p.name) && !productLanguage(p.name) && kindOf(p.name, p.category) !== 'other')
      .sort((a, b) => Number(!!db.getMtgEv(a.uuid)) - Number(!!db.getMtgEv(b.uuid)))
    out.skipped += db.listSealedForSet(set.code).length - inSet.length

    let inThisSet = 0
    for (const p of inSet) {
      if (out.products >= maxProducts) break
      if (inThisSet >= MAX_PRODUCTS_PER_SET) break
      inThisSet++
      out.products++
      onProgress?.(`${set.name} — ${p.name}`)
      try {
        const had = db.getMtgEv(p.uuid)?.ev_mean != null
        const r = await evaluate(p.uuid, opts.recompute)
        if (r) {
          if (had && !opts.recompute) out.repriced++
          else out.evaluated++
        } else {
          out.skipped++
        }
      } catch (err) {
        out.errors.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return out
}

/**
 * Refresh the prices of rows already on the board — one request each, so this
 * is the job that runs daily.
 *
 * Rows left behind by an older engine need a full re-simulation, which is not
 * a background-job cost, so only a few are healed per run and the rest wait
 * for the next one. The board converges without ever blocking for minutes.
 */
const MAX_HEALS_PER_RUN = 6

export async function repriceAll(): Promise<{ checked: number; changed: number; healed: number }> {
  let checked = 0
  let changed = 0
  let healed = 0
  for (const row of db.listMtgEv()) {
    if (!row.tcgplayer_product_id) continue
    const stale = (row.engine ?? 0) < EV_ENGINE_VERSION
    if (stale) {
      if (healed >= MAX_HEALS_PER_RUN) continue
      healed++
    }
    checked++
    const before = row.price
    const r = await evaluate(row.uuid, false)
    if (r && r.price !== before) changed++
  }
  return { checked, changed, healed }
}

export interface EvBoardRow extends db.MtgEvRow {
  setName: string | null
}

export function board(): EvBoardRow[] {
  const names = new Map(db.listMtgSets().map((s) => [s.code, s.name]))
  return db.listMtgEv().map((r) => ({ ...r, setName: names.get(r.set_code) ?? null }))
}
