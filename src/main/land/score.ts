/**
 * Parcel scoring.
 *
 * Two rules shape this whole file:
 *
 * 1. Missing data is not a zero. A parcel that has never been enriched should
 *    read as "unknown", not as "bad" — otherwise the ranking is really just a
 *    ranking of what happened to get fetched first. So each factor may return
 *    null, nulls are dropped from both the numerator and the denominator, and
 *    the leftover `coverage` figure travels with the score and is shown in the
 *    UI. A 0.82 at 30% coverage is a guess and should look like one.
 *
 * 2. Some things are not scores at all. Being inside a regulatory floodway, or
 *    on open water, does not make a parcel merely worse — it makes it
 *    unbuildable. Those surface as flags and force the verdict to 'avoid'
 *    regardless of how well the parcel does elsewhere.
 *
 * Weights are deliberately editable: what matters for a trailer pad on a
 * shoestring is not what matters for a stick-built house, and the honest thing
 * is to expose the dial rather than bury a preference in the arithmetic.
 */
import * as db from '../db'
import type { FloodFact, HazardFact, TerrainFact, CoverFact, UtilityFact, SoilFact } from './enrich'

export interface Weights {
  flood: number
  slope: number
  septic: number
  utility: number
  karst: number
  wetland: number
  toxic: number
  cover: number
  size: number
}

/**
 * Defaults tuned for "can we put a trailer on this and grow into it".
 * Slope and septic lead because they are the two that cost real money to fix
 * and cannot be negotiated with; flood leads with them because it is the one
 * that can make a parcel uninsurable rather than merely expensive.
 */
export const DEFAULT_WEIGHTS: Weights = {
  flood: 1.4,
  slope: 1.3,
  septic: 1.2,
  utility: 1.0,
  karst: 0.9,
  wetland: 0.8,
  toxic: 0.6,
  cover: 0.5,
  size: 0.7
}

export interface SubScore {
  score: number       // 0..1, higher is better
  weight: number
  why: string
}

export interface ScoreResult {
  total: number
  verdict: 'strong' | 'workable' | 'marginal' | 'avoid' | 'unknown'
  subs: Record<string, SubScore>
  flags: string[]
  coverage: number
  hookupLow: number | null
  hookupHigh: number | null
}

interface Facts {
  flood?: FloodFact
  hazard?: HazardFact
  terrain?: TerrainFact
  cover?: CoverFact
  utility?: UtilityFact
  soil?: SoilFact
}

/** Linear falloff between a good value and a bad one, clamped to 0..1. */
function ramp(value: number, good: number, bad: number): number {
  if (good === bad) return value <= good ? 1 : 0
  const t = (value - good) / (bad - good)
  return Math.max(0, Math.min(1, 1 - t))
}

export function scoreParcel(
  parcel: db.LandParcel,
  facts: Facts,
  weights: Weights = DEFAULT_WEIGHTS
): ScoreResult {
  const subs: Record<string, SubScore> = {}
  const flags: string[] = []
  const add = (key: keyof Weights, score: number | null, why: string): void => {
    if (score == null) return
    subs[key] = { score: Math.max(0, Math.min(1, score)), weight: weights[key], why }
  }

  // ---- flood
  if (facts.flood) {
    const f = facts.flood
    if (f.inFloodway) flags.push('In or touching a FEMA regulatory floodway — building is effectively prohibited')
    if (f.inSfha) flags.push('Inside the 1% annual chance floodplain (SFHA) — flood insurance required')
    const zone = (f.worst ?? '').toUpperCase()
    let s = 1
    let why = 'Outside mapped flood hazard'
    if (f.inFloodway) { s = 0; why = 'Regulatory floodway' }
    else if (/^(A|AE|AO|AH|A99|AR|V|VE)$/.test(zone)) { s = 0.15; why = `Zone ${zone} — 1% annual chance floodplain` }
    else if (f.touching.some((z) => /^(A|AE|AO|AH|V|VE)$/i.test(z))) { s = 0.6; why = 'Clips a floodplain at the edge only' }
    else if (zone === 'X') { s = 1; why = 'Zone X — minimal flood hazard' }
    else if (!f.worst) { s = 0.85; why = 'No FEMA mapping found here' }
    add('flood', s, why)
  }

  // ---- slope
  if (facts.terrain) {
    const t = facts.terrain
    // 5% is comfortably flat for a pad; past 20% you are paying for excavation
    // and retaining before you pay for anything else.
    const s = ramp(t.meanSlopePct, 5, 20)
    add('slope', s, `Mean grade ${t.meanSlopePct.toFixed(1)}% (peak ${t.maxSlopeDeg.toFixed(0)}°)`)
    if (t.meanSlopePct > 25) flags.push(`Steep throughout — ${t.meanSlopePct.toFixed(0)}% mean grade`)
  }

  // ---- septic / soil
  if (facts.soil) {
    const so = facts.soil
    const map: Record<string, number> = { good: 1, fair: 0.55, poor: 0.15, unknown: 0.5 }
    add('septic', map[so.septic] ?? 0.5,
      `${so.drainage ?? 'drainage unknown'} — septic ${so.septic}${so.mapUnit ? ` (${so.mapUnit})` : ''}`)
    if (so.septic === 'poor') flags.push('Soil drains poorly — expect an engineered septic system, not a conventional field')
    if (so.hydric) flags.push('Hydric soil — wetland indicators present')
    if (so.floodFrequency && !/none/i.test(so.floodFrequency)) {
      flags.push(`Soil survey records flooding: ${so.floodFrequency}`)
    }
  }

  // ---- utility hookup
  if (facts.utility) {
    const u = facts.utility
    if (u.nearestAddressFt == null) {
      add('utility', 0.1, 'No address point within half a mile — assume a long service run')
      flags.push('Remote from any existing structure; utility extension may dominate the price of the land')
    } else {
      // 300 ft is usually inside a standard free allowance; 2000 ft is a
      // five-figure extension before anything is built.
      add('utility', ramp(u.nearestAddressFt, 300, 2000), u.basis)
    }
  }

  // ---- karst
  const hz = facts.hazard
  const karstNamed = facts.soil?.karstNamed ?? false
  if (hz || karstNamed) {
    const inKarst = (hz?.karst ?? false) || karstNamed
    add('karst', inKarst ? 0.3 : 1,
      inKarst
        ? `Karst terrain${hz?.karstType ? ` (${hz.karstType})` : ' named in the soil survey'}`
        : 'No mapped karst')
    if (inKarst) flags.push('Karst / sinkhole-prone ground — affects foundations and septic; worth a geotechnical look')
  }

  // ---- wetland
  if (hz) {
    const wet = hz.wetlandTypes.length > 0
    add('wetland', wet ? 0.35 : 1,
      wet ? `NWI wetlands nearby: ${hz.wetlandTypes.slice(0, 2).join(', ')}` : 'No mapped wetlands')
    if (wet) flags.push('Mapped wetlands on or adjacent — separate federal permitting from flood zone')

    // ---- toxic
    const tox = hz.toxicNearby.length
    add('toxic', tox === 0 ? 1 : ramp(tox, 1, 6),
      tox === 0 ? 'No EPA-regulated facility within a quarter mile' : `${tox} EPA-regulated site(s) within a quarter mile`)
    if (tox > 0) {
      flags.push(`${tox} EPA-regulated facility/facilities nearby: ${hz.toxicNearby.map((t) => t.name).slice(0, 3).join(', ')}`)
    }
  }

  // ---- land cover
  if (facts.cover) {
    const c = facts.cover
    if (!c.buildable) flags.push(`Land cover reads as ${c.label} — likely not buildable ground`)
    // Wooded is not a penalty. It is what most cheap rural land is, and trees
    // are cheaper to remove than a hillside is to flatten; only water and
    // permanent wetland actually cost you the parcel.
    add('cover', c.buildable ? (c.wooded ? 0.85 : 1) : 0.05, c.label ?? 'unknown cover')
  }

  // ---- size
  if (parcel.acres != null) {
    const a = parcel.acres
    // Under an acre rarely leaves room for a well and a septic field with the
    // separation distances health departments require.
    const s = a < 0.75 ? 0.2 : a < 2 ? 0.6 : a < 5 ? 0.9 : 1
    add('size', s, `${a.toFixed(2)} acres`)
    if (a < 0.75) flags.push('Small lot — well and septic separation may not fit')
  }

  // ---- roll up
  const entries = Object.values(subs)
  const totalWeight = entries.reduce((n, s) => n + s.weight, 0)
  const allWeight = Object.values(weights).reduce((n, w) => n + w, 0)
  const total = totalWeight > 0 ? entries.reduce((n, s) => n + s.score * s.weight, 0) / totalWeight : 0
  const coverage = allWeight > 0 ? totalWeight / allWeight : 0

  const hard = flags.some((f) => /floodway|not buildable ground/i.test(f))
  const verdict: ScoreResult['verdict'] =
    hard ? 'avoid'
      : coverage < 0.35 ? 'unknown'
        : total >= 0.78 ? 'strong'
          : total >= 0.6 ? 'workable'
            : total >= 0.4 ? 'marginal'
              : 'avoid'

  return {
    total: Math.round(total * 1000) / 1000,
    verdict,
    subs,
    // Hard blockers first — the list is read top-down in a cramped side panel.
    flags: [...flags].sort((a, b) => Number(/floodway|not buildable/i.test(b)) - Number(/floodway|not buildable/i.test(a))),
    coverage: Math.round(coverage * 1000) / 1000,
    hookupLow: facts.utility?.estLow ?? null,
    hookupHigh: facts.utility?.estHigh ?? null
  }
}

/** Score one parcel from its cached facts and persist the result. */
export function rescoreParcel(parcel: db.LandParcel, weights?: Weights): ScoreResult {
  const facts = db.getLandFacts(parcel.id) as Facts
  const r = scoreParcel(parcel, facts, weights)
  db.putLandScore({
    parcel_id: parcel.id,
    total: r.total,
    verdict: r.verdict,
    subs: JSON.stringify(r.subs),
    flags: JSON.stringify(r.flags),
    hookup_low: r.hookupLow,
    hookup_high: r.hookupHigh,
    coverage: r.coverage
  })
  return r
}

/** Re-score every candidate in a region. Pure local work — no network. */
export function rescoreRegion(fips: string, weights?: Weights): number {
  const parcels = db.listLandCandidates(fips)
  for (const p of parcels) rescoreParcel(p, weights)
  db.patchLandRegion(fips, { scored_at: Date.now() })
  return parcels.length
}

export function loadWeights(): Weights {
  const raw = db.getSetting('land_weights')
  if (!raw) return DEFAULT_WEIGHTS
  try {
    return { ...DEFAULT_WEIGHTS, ...(JSON.parse(raw) as Partial<Weights>) }
  } catch {
    return DEFAULT_WEIGHTS
  }
}

export function saveWeights(w: Partial<Weights>): Weights {
  const merged = { ...loadWeights(), ...w }
  db.setSetting('land_weights', JSON.stringify(merged))
  return merged
}
