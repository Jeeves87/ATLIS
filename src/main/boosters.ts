/**
 * Real booster print sheets, from MTGJSON.
 *
 * This replaces guesswork with ground truth. MTGJSON publishes, per set and per
 * booster type, the actual sheet structure Wizards prints from: a set of pack
 * CONFIGURATIONS (each with a weight), and for each configuration how many
 * cards come off which SHEET — where every sheet lists its cards with an
 * individual weight. Final Fantasy's collector booster has 4 configurations
 * over 11 sheets, with weights summing to 2,000,000.
 *
 * Why this matters: the earlier model approximated packs as "5 rare-or-better
 * slots drawn uniformly from the priced rares", which cannot express the thing
 * that actually drives a pack's value — that a specific chase printing is far
 * rarer than its rarity suggests. The neon-ink Traveling Chocobos sit at
 * 1-in-1,667 of their sheet and the serialized one at 1-in-6,001; a uniform
 * draw over ~20 mythics handed them out roughly a hundred times too often, and
 * a $1,836 card at the wrong frequency sets the whole mean by itself.
 *
 * The same data answers "what are the odds of pulling X" directly and exactly,
 * which no amount of back-calculating from population estimates can match.
 *
 * Only RELEASED sets carry this (checked: FIN, HOB, TDM, DFT, BLB, LTR, MKM,
 * OTJ all have it; unreleased TRK and FRA do not), so callers keep the older
 * approximation as a fallback and say which one produced a number.
 */

const MTGJSON = 'https://mtgjson.com/api/v5'
const UA = 'ATLIS/1.0 (personal collection tracker)'

export type SheetBoosterType = 'collector' | 'play'

/**
 * MTGJSON booster keys in preference order. A set that never printed Play
 * Boosters (anything before mid-2024) used draft and set boosters instead;
 * those fill the same role and are close enough to stand in for one.
 */
const KEY_ALIASES: Record<SheetBoosterType, string[]> = {
  collector: ['collector', 'collector-special'],
  play: ['play', 'draft', 'set']
}

interface RawSheet {
  cards?: Record<string, number>
  totalWeight?: number
  foil?: boolean
  balanceColors?: boolean
}
interface RawBooster {
  boosters?: Array<{ weight?: number; contents?: Record<string, number> }>
  boostersTotalWeight?: number
  sheets?: Record<string, RawSheet>
}

export interface Sheet {
  name: string
  foil: boolean
  totalWeight: number
  ids: string[]
  /** Cumulative weights, for a binary-search draw. */
  cum: number[]
}

export interface BoosterModel {
  setCode: string
  /** The MTGJSON key actually used, which may be an alias. */
  key: string
  totalWeight: number
  configs: Array<{ weight: number; picks: Array<{ sheet: string; count: number }> }>
  sheets: Map<string, Sheet>
  /** Every Scryfall id reachable from any sheet. */
  allIds: string[]
}

const setCache = new Map<string, Record<string, unknown> | null>()

async function mtgjsonSet(code: string): Promise<Record<string, unknown> | null> {
  const key = code.toUpperCase()
  const hit = setCache.get(key)
  if (hit !== undefined) return hit
  try {
    const r = await fetch(`${MTGJSON}/${key}.json`, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    const data = r.ok ? ((await r.json()) as { data?: Record<string, unknown> }).data ?? null : null
    setCache.set(key, data)
    return data
  } catch {
    setCache.set(key, null)
    return null
  }
}

const modelCache = new Map<string, BoosterModel | null>()

/** Build a sampler for one set's booster of the given type, or null if unpublished. */
export async function loadBoosterModel(setCode: string, type: SheetBoosterType): Promise<BoosterModel | null> {
  const cacheKey = `${setCode.toLowerCase()}:${type}`
  const cached = modelCache.get(cacheKey)
  if (cached !== undefined) return cached

  const data = await mtgjsonSet(setCode)
  const boosters = data?.booster as Record<string, RawBooster> | undefined
  const key = boosters ? KEY_ALIASES[type].find((k) => boosters[k]?.sheets) : undefined
  if (!boosters || !key) {
    modelCache.set(cacheKey, null)
    return null
  }
  const raw = boosters[key]

  // uuid -> Scryfall id. Sheets reference cards by MTGJSON uuid; everything
  // downstream (prices, images) is keyed on Scryfall.
  const byUuid = new Map<string, string>()
  for (const c of (data?.cards ?? []) as Array<{ uuid: string; identifiers?: { scryfallId?: string } }>) {
    if (c.identifiers?.scryfallId) byUuid.set(c.uuid, c.identifiers.scryfallId)
  }

  const sheets = new Map<string, Sheet>()
  const allIds = new Set<string>()
  for (const [name, sh] of Object.entries(raw.sheets ?? {})) {
    const ids: string[] = []
    const cum: number[] = []
    let running = 0
    for (const [uuid, weight] of Object.entries(sh.cards ?? {})) {
      const id = byUuid.get(uuid)
      // A sheet card with no Scryfall mapping is dropped rather than guessed
      // at; its weight leaves the sheet with it so probabilities stay normal.
      if (!id || !(weight > 0)) continue
      running += weight
      ids.push(id)
      cum.push(running)
      allIds.add(id)
    }
    if (!ids.length) continue
    sheets.set(name, { name, foil: !!sh.foil, totalWeight: running, ids, cum })
  }

  const configs = (raw.boosters ?? [])
    .map((b) => ({
      weight: b.weight ?? 1,
      picks: Object.entries(b.contents ?? {})
        .filter(([sheet]) => sheets.has(sheet))
        .map(([sheet, count]) => ({ sheet, count }))
    }))
    .filter((c) => c.picks.length)
  if (!configs.length) {
    modelCache.set(cacheKey, null)
    return null
  }

  const totalWeight = configs.reduce((n, c) => n + c.weight, 0)
  const model: BoosterModel = { setCode: setCode.toLowerCase(), key, totalWeight, configs, sheets, allIds: [...allIds] }
  modelCache.set(cacheKey, model)
  return model
}

function drawFromSheet(sheet: Sheet): string {
  const target = Math.random() * sheet.totalWeight
  let lo = 0
  let hi = sheet.cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sheet.cum[mid] < target) lo = mid + 1
    else hi = mid
  }
  return sheet.ids[lo]
}

/**
 * Draw one pack, appending `{id, foil}` for every card. Picks from the same
 * sheet are distinct, matching how a real pack is collated — with a bounded
 * number of retries so a sheet shorter than its pick count can't spin.
 */
export function drawPack(model: BoosterModel, out: Array<{ id: string; foil: boolean }>): void {
  let roll = Math.random() * model.totalWeight
  let config = model.configs[model.configs.length - 1]
  for (const c of model.configs) {
    if (roll < c.weight) { config = c; break }
    roll -= c.weight
  }

  for (const pick of config.picks) {
    const sheet = model.sheets.get(pick.sheet)
    if (!sheet) continue
    const seen = new Set<string>()
    for (let i = 0; i < pick.count; i++) {
      let id = drawFromSheet(sheet)
      for (let attempt = 0; attempt < 8 && seen.has(id); attempt++) id = drawFromSheet(sheet)
      seen.add(id)
      out.push({ id, foil: sheet.foil })
    }
  }
}

/**
 * Exact per-card odds of appearing in a single pack, straight from the sheet
 * weights — no simulation involved. This is the number people go looking for
 * on Reddit and end up estimating from print-run guesses.
 */
export function packOdds(model: BoosterModel): Map<string, { chance: number; foil: boolean }> {
  const out = new Map<string, { chance: number; foil: boolean }>()
  for (const config of model.configs) {
    const configP = config.weight / model.totalWeight
    for (const pick of config.picks) {
      const sheet = model.sheets.get(pick.sheet)
      if (!sheet) continue
      let prev = 0
      for (let i = 0; i < sheet.ids.length; i++) {
        const w = sheet.cum[i] - prev
        prev = sheet.cum[i]
        const perPick = w / sheet.totalWeight
        // P(at least one across this config's picks from this sheet).
        const chance = configP * (1 - Math.pow(1 - perPick, pick.count))
        const id = sheet.ids[i]
        const cur = out.get(id)
        // Independent across configurations and sheets, so combine as such.
        if (cur) cur.chance = 1 - (1 - cur.chance) * (1 - chance)
        else out.set(id, { chance, foil: sheet.foil })
      }
    }
  }
  return out
}
