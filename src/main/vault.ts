/**
 * Vault (collectibles) pricing layer.
 *
 * Melt/spot value is the objective floor for coins and bullion: metal content
 * is deterministic, so spot price × troy oz × quantity needs no judgment.
 * Spot quotes ride the same Yahoo chart endpoint finance.ts already uses —
 * metals trade as futures (GC=F etc.), no key needed. Collector-premium
 * ("market") valuations are NOT computed here; the agent researches those and
 * records them via the vault_record_valuation tool.
 */
import { chart } from './finance'
import * as db from './db'

export interface SpotPrices {
  fetchedAt: number
  usdPerOzt: Partial<Record<string, number>> // metal -> $/troy oz
  errors: string[]
}

// Yahoo futures symbols. Gold/silver/platinum/palladium quote in $/ozt already;
// copper quotes in $/lb and is converted (1 lb = 14.5833 ozt).
const SPOT_SYMBOLS: Record<string, { symbol: string; perLb?: boolean }> = {
  gold: { symbol: 'GC=F' },
  silver: { symbol: 'SI=F' },
  platinum: { symbol: 'PL=F' },
  palladium: { symbol: 'PA=F' },
  copper: { symbol: 'HG=F', perLb: true }
}
const OZT_PER_LB = 14.5833
const CACHE_MS = 10 * 60_000

let cache: SpotPrices | null = null

/** Current $/ozt for each metal, cached ~10 min. Only fetches metals that are requested (or all). */
export async function spotPrices(force = false): Promise<SpotPrices> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache
  const out: SpotPrices = { fetchedAt: Date.now(), usdPerOzt: {}, errors: [] }
  await Promise.all(
    Object.entries(SPOT_SYMBOLS).map(async ([metal, cfg]) => {
      try {
        const c = await chart(cfg.symbol, '5d', '1d')
        const price = c.meta.price
        if (price == null) throw new Error('no price in chart meta')
        out.usdPerOzt[metal] = cfg.perLb ? price / OZT_PER_LB : price
      } catch (err) {
        out.errors.push(`${metal}: ${err instanceof Error ? err.message : err}`)
      }
    })
  )
  // keep a stale cache over an empty result if Yahoo hiccups entirely
  if (Object.keys(out.usdPerOzt).length || !cache) cache = out
  return cache
}

/** Melt value in USD for the item's whole quantity, or null if it has no metal basis. */
export function meltValueUsd(item: db.VaultItem, spots: SpotPrices): { value: number; spot: number } | null {
  if (!item.metal || !item.metal_weight_ozt) return null
  const spot = spots.usdPerOzt[item.metal]
  if (spot == null) return null
  return { value: spot * item.metal_weight_ozt * item.quantity, spot }
}

/**
 * Record a fresh melt valuation for every metal-bearing item (one history
 * point per item per day — today's rows are replaced, older days are kept).
 */
export async function refreshMelt(): Promise<{ updated: number; skipped: number; errors: string[] }> {
  const spots = await spotPrices()
  let updated = 0
  let skipped = 0
  for (const item of db.listVaultItems()) {
    const melt = meltValueUsd(item, spots)
    if (!melt) { skipped++; continue }
    db.deleteVaultValuationsToday(item.id, 'melt')
    db.addVaultValuation({
      item_id: item.id,
      kind: 'melt',
      value_mid: Math.round(melt.value * 100) / 100,
      spot_price: Math.round(melt.spot * 100) / 100,
      source: `spot ${item.metal} via Yahoo (${SPOT_SYMBOLS[item.metal!]?.symbol ?? '?'})`
    })
    updated++
  }
  return { updated, skipped, errors: spots.errors }
}
