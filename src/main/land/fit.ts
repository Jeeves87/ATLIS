/**
 * Life fit — the second scoring axis.
 *
 * The land score answers "can you build here". This answers "could you live
 * here", and the two are kept deliberately separate because the interesting
 * result is when they disagree. A flat, dry, cheap forty acres ninety minutes
 * from both jobs is not a bad parcel and should not be scored as one — it is a
 * good parcel that costs a different life. Averaging the two axes into one
 * number would erase exactly that finding, so nothing here ever touches
 * land_scores.
 *
 * Travel time is estimated in two tiers, for the same reason enrichment is:
 *
 *   BULK   — straight-line distance scaled by a detour factor and a
 *            distance-dependent speed. Free, instant, runs over every candidate.
 *   EXACT  — a real road route, fetched only for a parcel you actually open.
 *
 * The bulk model is calibrated against real routes: Corydon to downtown
 * Louisville measures 41.5 km by road against 32.1 km straight, a 1.29 detour
 * factor at a 74 km/h average, which is what the constants below encode.
 */
import * as db from '../db'
import { distanceFt, FT_PER_M } from './geo'
import { Pacer } from './arcgis'
import { LAND_UA } from './sources'
import type { Progress } from './enrich'

const OVERPASS = 'https://overpass-api.de/api/interpreter'
const OSRM = 'https://router.project-osrm.org'
const CENSUS_GEOCODER = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'

// The public OSRM demo server is a shared courtesy, not an SLA. It is only ever
// called for a parcel the user has opened, one at a time, and paced.
const routePace = new Pacer(600)

/**
 * Rural road networks wander; this is the measured local ratio to straight line.
 * Interstates barely wander at all, hence the second, lower factor.
 */
const DETOUR = 1.29
const DETOUR_HIGHWAY = 1.15

/**
 * Average speed in km/h for a trip of a given road distance.
 *
 * Short rural trips are slow — gravel, stop signs, no through route. Longer ones
 * pick up highway and converge on the ~74 km/h measured Corydon→Louisville.
 */
function speedKph(roadKm: number): number {
  if (roadKm < 5) return 40
  if (roadKm < 20) return 58
  return 72
}

/**
 * Interstate blending. A trip from beside a ramp is not simply "highway or
 * not" — the highway's share of it grows with length, because the slow bits at
 * each end are roughly fixed. So both constants ramp in over distance rather
 * than switching on.
 */
const HIGHWAY_MAX_SPEED_KPH = 88
const HIGHWAY_ACCESS_MIN = 12
const HIGHWAY_RAMP_START_KM = 15
const HIGHWAY_RAMP_SPAN_KM = 45

/**
 * Estimated drive time in minutes between two points. No network needed.
 *
 * `highwayAccessMin` — how far the origin is from a motorway ramp — matters
 * more than it looks, and getting it wrong is not symmetric: without the
 * correction the model penalises precisely the parcels whose highway access
 * makes a long commute viable.
 *
 * Validated against real OSRM routes into downtown Louisville from six towns.
 * A first attempt switched to highway constants abruptly and fixed Scottsburg
 * (on I-65, 48 km out) while breaking Corydon (on I-64 but only 32 km out) by
 * 25% the other way. Blending the constants in over distance holds both, which
 * is why this ramps rather than switches.
 *
 * Measured accuracy after blending: ~7% mean absolute error, but with a real
 * tail — Palmyra came out 23% fast because its route is genuinely winding back
 * road, while English, half again as far, averages a higher speed. Distance
 * alone cannot separate those, and tuning further would just be overfitting to
 * a handful of towns. So this is a RANKING tool: good enough to sort thousands
 * of parcels, not good enough to promise a commute. `routeMinutes` gives the
 * real answer for a parcel worth asking about.
 */
export function estimateMinutes(
  aLon: number, aLat: number, bLon: number, bLat: number,
  highwayAccessMin?: number | null
): number {
  const straightKm = (distanceFt(aLon, aLat, bLon, bLat) / FT_PER_M) / 1000
  const hasRamp = highwayAccessMin != null && highwayAccessMin <= HIGHWAY_ACCESS_MIN
  // 0 for a short trip or no ramp, approaching 1 as the highway takes over.
  const share = hasRamp
    ? Math.max(0, Math.min(1, (straightKm - HIGHWAY_RAMP_START_KM) / HIGHWAY_RAMP_SPAN_KM))
    : 0

  const detour = DETOUR - (DETOUR - DETOUR_HIGHWAY) * share
  const roadKm = straightKm * detour
  const speed = speedKph(roadKm) + (HIGHWAY_MAX_SPEED_KPH - speedKph(roadKm)) * share
  return (roadKm / speed) * 60
}

/** Exact road distance and time from OSRM, for a single parcel on demand. */
export async function routeMinutes(
  from: { lon: number; lat: number },
  to: { lon: number; lat: number },
  signal?: AbortSignal
): Promise<{ minutes: number; km: number } | null> {
  await routePace.wait(signal)
  const url = `${OSRM}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`
  const res = await fetch(url, { headers: { 'User-Agent': LAND_UA }, signal })
  if (!res.ok) return null
  const j = (await res.json()) as { code?: string; routes?: Array<{ distance: number; duration: number }> }
  const r = j.code === 'Ok' ? j.routes?.[0] : null
  return r ? { minutes: r.duration / 60, km: r.distance / 1000 } : null
}

/** Turn a typed address into coordinates, so anchors need not be map-clicked. */
export async function geocode(address: string, signal?: AbortSignal): Promise<{ lat: number; lon: number; matched: string } | null> {
  const url = `${CENSUS_GEOCODER}?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': LAND_UA }, signal })
  if (!res.ok) return null
  const j = (await res.json()) as {
    result?: { addressMatches?: Array<{ coordinates: { x: number; y: number }; matchedAddress: string }> }
  }
  const m = j.result?.addressMatches?.[0]
  return m ? { lat: m.coordinates.y, lon: m.coordinates.x, matched: m.matchedAddress } : null
}

// ---------------------------------------------------------------- amenities

export interface AmenitySpec {
  kind: string
  label: string
  /** Overpass tag filters, OR'd together. */
  filters: string[]
  weight: number
  idealMin: number
  maxMin: number
  why: string
}

/**
 * Amenity classes and the tolerances that make sense for a rural homestead.
 *
 * Fire station carries real weight despite feeling minor: distance to a
 * responding station drives the ISO rating, which drives what insurance costs
 * (or whether it is offered at all) on a rural build.
 */
export const AMENITIES: AmenitySpec[] = [
  {
    kind: 'ramp', label: 'Highway access',
    filters: ['node["highway"="motorway_junction"]'],
    weight: 1.1, idealMin: 12, maxMin: 35,
    why: 'Getting on a highway is what makes a long commute survivable.'
  },
  {
    kind: 'fuel', label: 'Gas station',
    filters: ['node["amenity"="fuel"]'],
    weight: 0.8, idealMin: 10, maxMin: 25,
    why: 'Routine stop; being far from one taxes every trip.'
  },
  {
    kind: 'grocery', label: 'Groceries',
    filters: ['node["shop"~"^(supermarket|grocery)$"]', 'way["shop"~"^(supermarket|grocery)$"]'],
    weight: 1.0, idealMin: 15, maxMin: 40,
    why: 'A real supermarket, not a gas station cooler.'
  },
  {
    kind: 'fire', label: 'Fire station',
    filters: ['node["amenity"="fire_station"]', 'way["amenity"="fire_station"]'],
    weight: 0.7, idealMin: 8, maxMin: 20,
    why: 'Drives the ISO rating, and therefore rural insurance cost and availability.'
  },
  {
    kind: 'hospital', label: 'Hospital',
    filters: ['node["amenity"="hospital"]', 'way["amenity"="hospital"]'],
    weight: 0.8, idealMin: 20, maxMin: 50,
    why: 'Emergency response time, not routine care.'
  },
  {
    kind: 'school', label: 'School',
    filters: ['node["amenity"="school"]', 'way["amenity"="school"]'],
    weight: 0.5, idealMin: 15, maxMin: 40,
    why: 'Bus routes broadly follow this even if you do not drive it yourself.'
  },
  {
    kind: 'pharmacy', label: 'Pharmacy',
    filters: ['node["amenity"="pharmacy"]', 'way["amenity"="pharmacy"]'],
    weight: 0.4, idealMin: 15, maxMin: 40,
    why: 'Recurring errand.'
  }
]

/**
 * Load a region's amenities from OpenStreetMap.
 *
 * OSM rather than a commercial POI feed because it is open, free and good
 * enough for "is there a supermarket within twenty minutes". Its rural coverage
 * is genuinely thin though — a Harrison County query returns about fifty points
 * in total — so a missing amenity means "not mapped", not "not there", and the
 * scorer treats an empty category as unknown rather than as a penalty.
 */
export async function ingestPois(
  region: { fips: string; name: string; bounds: [number, number, number, number] },
  onProgress: Progress = () => {},
  signal?: AbortSignal
): Promise<Record<string, number>> {
  const [w, s, e, n] = region.bounds
  const bbox = `${s},${w},${n},${e}`
  const body = [
    '[out:json][timeout:90];(',
    ...AMENITIES.flatMap((a) => a.filters.map((f) => `${f}(${bbox});`)),
    ');out center;'
  ].join('')

  onProgress(`${region.name}: fetching amenities from OpenStreetMap…`, 0.2)
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': LAND_UA },
    body: new URLSearchParams({ data: body }),
    signal
  })
  if (!res.ok) {
    // 406 here means the request was rejected before the query was read —
    // almost always a missing User-Agent rather than anything wrong with it.
    throw new Error(res.status === 406
      ? 'Overpass rejected the request (406) — it requires an identifying User-Agent'
      : `Overpass returned ${res.status}`)
  }
  const j = (await res.json()) as {
    elements?: Array<{
      lat?: number; lon?: number
      center?: { lat: number; lon: number }
      tags?: Record<string, string>
    }>
  }

  const rows: Array<{ kind: string; name: string | null; lat: number; lon: number }> = []
  for (const el of j.elements ?? []) {
    // Ways come back with a `center` rather than their own lat/lon.
    const lat = el.lat ?? el.center?.lat
    const lon = el.lon ?? el.center?.lon
    if (lat == null || lon == null) continue
    const kind = classify(el.tags ?? {})
    if (!kind) continue
    rows.push({ kind, name: el.tags?.name ?? null, lat, lon })
  }

  db.replaceLandPois(region.fips, rows)
  onProgress(`${region.name}: ${rows.length} amenities`, 1)
  return db.countLandPois(region.fips)
}

function classify(t: Record<string, string>): string | null {
  if (t.highway === 'motorway_junction') return 'ramp'
  if (t.amenity === 'fuel') return 'fuel'
  if (t.shop === 'supermarket' || t.shop === 'grocery') return 'grocery'
  if (t.amenity === 'fire_station') return 'fire'
  if (t.amenity === 'hospital') return 'hospital'
  if (t.amenity === 'school') return 'school'
  if (t.amenity === 'pharmacy') return 'pharmacy'
  return null
}

// ------------------------------------------------------------------ scoring

export interface FitLeg {
  id: string
  label: string
  group: 'anchor' | 'amenity'
  minutes: number | null
  score: number | null
  weight: number
  detail: string
}

export interface FitResult {
  score: number
  verdict: 'easy' | 'workable' | 'shift' | 'remote' | 'unknown'
  commuteMinutes: number | null
  legs: FitLeg[]
  /** Set when the land is good but living there would not be. */
  lifestyleNote: string | null
}

/** 1 at or under `ideal`, falling linearly to 0 at `max`. */
function ramp(minutes: number, ideal: number, max: number): number {
  if (minutes <= ideal) return 1
  if (minutes >= max) return 0
  return 1 - (minutes - ideal) / (max - ideal)
}

const nearestMinutes = (
  parcel: { lon: number; lat: number },
  pois: Array<{ kind: string; lat: number; lon: number }>,
  kind: string
): number | null => {
  let best: number | null = null
  for (const p of pois) {
    if (p.kind !== kind) continue
    const m = estimateMinutes(parcel.lon, parcel.lat, p.lon, p.lat, null)
    if (best == null || m < best) best = m
  }
  return best
}

export function scoreFit(
  parcel: { lon: number; lat: number },
  anchors: db.LandAnchor[],
  pois: Array<{ kind: string; lat: number; lon: number }>
): FitResult {
  const legs: FitLeg[] = []
  let weighted = 0
  let totalWeight = 0
  let worstCommute: number | null = null

  // Highway access is computed before the anchors because it changes how every
  // long trip from this parcel is estimated, not just the ramp leg itself.
  const rampMin = nearestMinutes(parcel, pois, 'ramp')

  for (const a of anchors) {
    const minutes = estimateMinutes(parcel.lon, parcel.lat, a.lon, a.lat, rampMin)
    const score = ramp(minutes, a.ideal_minutes, a.max_minutes)
    weighted += score * a.weight
    totalWeight += a.weight
    // The binding constraint is the longest regular trip, not the average —
    // a household is limited by its worst commute, not its mean commute.
    if (a.kind === 'work' && (worstCommute == null || minutes > worstCommute)) worstCommute = minutes
    legs.push({
      id: a.id, label: a.label, group: 'anchor',
      minutes, score, weight: a.weight,
      detail: `${Math.round(minutes)} min · target ${a.ideal_minutes}, limit ${a.max_minutes}`
    })
  }

  for (const spec of AMENITIES) {
    const minutes = spec.kind === 'ramp' ? rampMin : nearestMinutes(parcel, pois, spec.kind)
    if (minutes == null) {
      // Nothing of this kind is mapped nearby. That is missing data, not a
      // penalty — OSM's rural coverage is too patchy to read absence as fact.
      legs.push({
        id: spec.kind, label: spec.label, group: 'amenity',
        minutes: null, score: null, weight: spec.weight,
        detail: 'none mapped in the loaded area — unknown, not scored'
      })
      continue
    }
    const score = ramp(minutes, spec.idealMin, spec.maxMin)
    weighted += score * spec.weight
    totalWeight += spec.weight
    legs.push({
      id: spec.kind, label: spec.label, group: 'amenity',
      minutes, score, weight: spec.weight,
      detail: `${Math.round(minutes)} min — ${spec.why}`
    })
  }

  if (totalWeight === 0) {
    return { score: 0, verdict: 'unknown', commuteMinutes: null, legs, lifestyleNote: null }
  }

  const score = weighted / totalWeight
  const verdict: FitResult['verdict'] =
    score >= 0.75 ? 'easy'
      : score >= 0.55 ? 'workable'
        : score >= 0.35 ? 'shift'
          : 'remote'

  return {
    score: Math.round(score * 1000) / 1000,
    verdict,
    commuteMinutes: worstCommute == null ? null : Math.round(worstCommute),
    legs,
    lifestyleNote: null
  }
}

export const FIT_LABELS: Record<string, string> = {
  easy: 'Fits your life',
  workable: 'Workable',
  shift: 'Lifestyle shift',
  remote: 'Remote living',
  unknown: 'No anchors set'
}

/**
 * The cross-axis reading — the thing this whole second score exists to say.
 *
 * Good ground that would demand a different life is not a rejection, so this
 * returns a note rather than a flag, and never alters either score.
 */
export function lifestyleNote(landScore: number | null, fit: FitResult): string | null {
  if (landScore == null || fit.verdict === 'unknown') return null
  if (landScore >= 0.7 && fit.score < 0.45) {
    return fit.commuteMinutes != null
      ? `Good land, wrong life — the ground scores well, but a ${fit.commuteMinutes}-minute commute and thin services mean living here is a fundamental change, not a move.`
      : 'Good land, wrong life — the ground scores well, but the distances mean living here is a fundamental change, not a move.'
  }
  if (landScore >= 0.7 && fit.score >= 0.75) {
    return 'Rare combination: the ground is good and it sits where your life already is.'
  }
  if (landScore < 0.45 && fit.score >= 0.75) {
    return 'Conveniently placed, but the ground itself is the problem — convenience will not fix slope, flooding or septic.'
  }
  return null
}

/** Score every candidate in a region against the current anchors. Local only. */
export function refitRegion(fips: string): number {
  const anchors = db.listLandAnchors(true)
  const pois = db.listLandPois(fips)
  const parcels = db.listLandCandidates(fips)
  for (const p of parcels) {
    const fit = scoreFit(p, anchors, pois)
    db.putLandFit({
      parcel_id: p.id,
      score: fit.score,
      verdict: fit.verdict,
      commute_minutes: fit.commuteMinutes,
      detail: JSON.stringify(fit.legs)
    })
  }
  return parcels.length
}
