/**
 * Enrichment — turning a bare parcel polygon into the facts a build decision
 * actually turns on.
 *
 * The whole design rests on one split:
 *
 *   BULK (once per region)  — flood, wetlands, karst, toxic sites, jurisdiction.
 *     These are polygon layers, so they are fetched once for the county's
 *     bounding box, stored in geopoly, and intersected locally. One request per
 *     layer per county, then every parcel is answered from disk.
 *
 *   PER PARCEL              — terrain and land cover only.
 *     Slope cannot be bulk-fetched, but 3DEP will reduce a whole polygon
 *     server-side, so a parcel's min/max/mean slope over hundreds of thousands
 *     of 1m samples costs exactly one request.
 *
 * That is why enrichment runs against *candidates* rather than all ~430k
 * parcels: the bulk half is free, but the per-parcel half is one HTTP round
 * trip each, and only a few thousand parcels are ever worth spending it on.
 * Every result is cached in land_facts permanently — flood maps and soil
 * surveys change on a multi-year cadence, so refetching buys nothing.
 */
import * as db from '../db'
import { queryPaged, queryAll, imageStats, Pacer, type ArcFeature } from './arcgis'
import {
  NATIONAL, NLCD_CLASSES, NLCD_LAYER, karstSourceFor, LAND_UA, type RegionDef
} from './sources'
import {
  bboxOf, centroidOf, toGeopolyRings, toPolygons, distanceFt, padBbox, type Bbox
} from './geo'

export type Progress = (msg: string, pct?: number) => void

/** Public GIS servers are shared infrastructure; keep a polite steady gap. */
const terrainPace = new Pacer(220)
const coverPace = new Pacer(180)
const soilPace = new Pacer(250)

// ------------------------------------------------------------ bulk overlays

interface OverlaySpec {
  kind: string
  url: string
  outFields: string[]
  /** Reduce a source feature to the attributes worth keeping locally. */
  pick: (p: Record<string, unknown>) => Record<string, unknown>
}

function overlaySpecs(region: RegionDef): OverlaySpec[] {
  const specs: OverlaySpec[] = [
    {
      kind: 'flood',
      url: NATIONAL.flood.url,
      outFields: ['FLD_ZONE', 'ZONE_SUBTY', 'SFHA_TF'],
      pick: (p) => ({
        zone: String(p.FLD_ZONE ?? '').trim() || null,
        subtype: String(p.ZONE_SUBTY ?? '').trim() || null,
        sfha: String(p.SFHA_TF ?? '').trim().toUpperCase() === 'T'
      })
    },
    {
      kind: 'wetland',
      url: NATIONAL.wetland.url,
      outFields: ['WETLAND_TYPE'],
      pick: (p) => ({ type: String(p.WETLAND_TYPE ?? '').trim() || null })
    },
    {
      kind: 'jurisdiction',
      url: NATIONAL.jurisdiction.url,
      outFields: ['NAME', 'LSADC'],
      pick: (p) => ({ name: String(p.NAME ?? '').trim() || null })
    }
  ]
  const karst = karstSourceFor(region.state)
  if (karst) {
    specs.push({
      kind: 'karst',
      url: karst.url,
      outFields: ['*'],
      pick: (p) => ({ type: String(p.SINKHOLE_AREA_TYPE ?? p.TYPE ?? p.NAME ?? 'karst').trim() })
    })
  }
  return specs
}

/**
 * Fetch every polygon overlay for a region and store it locally.
 *
 * Multipolygons are split to one outer ring per row and vertices are decimated,
 * because a raw FEMA county pull is tens of thousands of high-vertex polygons
 * and geopoly keeps every vertex in the row.
 */
export async function ingestOverlays(
  region: RegionDef,
  onProgress: Progress = () => {},
  signal?: AbortSignal
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const specs = overlaySpecs(region)

  for (const [i, spec] of specs.entries()) {
    onProgress(`${region.name}: fetching ${spec.kind}…`, i / specs.length)
    const rings: Array<{ ring: string; attrs: unknown }> = []
    try {
      for await (const batch of queryPaged({
        url: spec.url,
        bbox: region.bounds,
        outFields: spec.outFields,
        geometry: true,
        signal,
        onPage: (n) => onProgress(`${region.name}: ${spec.kind} — ${n.toLocaleString()} polygons`)
      })) {
        for (const f of batch) {
          const attrs = spec.pick(f.properties)
          for (const ring of toGeopolyRings(f.geometry)) rings.push({ ring, attrs })
        }
      }
      out[spec.kind] = db.replaceLandOverlay(region.fips, spec.kind, rings)
    } catch (err) {
      // One unreachable overlay must not abort the rest — the score's coverage
      // figure will report the gap instead of the run failing outright.
      out[spec.kind] = -1
      onProgress(`${region.name}: ${spec.kind} failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Toxic sites are points, not polygons, so they ride in their own table shape:
  // stored as tiny boxes around each facility for the same overlap query.
  try {
    onProgress(`${region.name}: fetching EPA facilities…`)
    const feats = await queryAll({
      url: NATIONAL.toxic.url,
      bbox: region.bounds,
      outFields: ['*'],
      geometry: true,
      maxFeatures: 20000,
      signal
    })
    const rings = feats.flatMap((f) => pointToRing(f, 500))
    out.toxic = db.replaceLandOverlay(region.fips, 'toxic', rings)
  } catch (err) {
    out.toxic = -1
    onProgress(`${region.name}: EPA lookup failed — ${err instanceof Error ? err.message : String(err)}`)
  }

  db.patchLandRegion(region.fips, { overlays_at: Date.now() })
  return out
}

/** A point feature becomes a small square so one geopoly query serves both shapes. */
function pointToRing(f: ArcFeature, radiusFt: number): Array<{ ring: string; attrs: unknown }> {
  const g = f.geometry as { type?: string; coordinates?: unknown } | null
  if (!g || g.type !== 'Point') return []
  const [lon, lat] = (g.coordinates as number[]) ?? []
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return []
  const [w, s, e, n] = padBbox([lon, lat, lon, lat], radiusFt)
  const p = f.properties
  return [{
    ring: JSON.stringify([[w, s], [e, s], [e, n], [w, n], [w, s]]),
    attrs: {
      name: String(p.PRIMARY_NAME ?? p.FAC_NAME ?? p.NAME ?? 'facility').trim(),
      programs: String(p.PGM_SYS_ACRNMS ?? p.INTEREST_TYPES ?? '').trim() || null,
      lon, lat
    }
  }]
}

/** Load a region's address points — the utility-distance and vacancy proxy. */
export async function ingestAddressPoints(
  region: RegionDef,
  onProgress: Progress = () => {},
  signal?: AbortSignal
): Promise<number> {
  if (!region.addressPoints) return 0
  const pts: Array<{ lat: number; lon: number }> = []
  for await (const batch of queryPaged({
    url: region.addressPoints.url,
    where: region.addressPoints.where,
    // Geometry only: nothing downstream reads an address point's attributes,
    // and asking for a field by the wrong name is how this broke before.
    outFields: [],
    geometry: true,
    signal,
    onPage: (n) => onProgress(`${region.name}: ${n.toLocaleString()} address points`)
  })) {
    for (const f of batch) {
      const g = f.geometry as { type?: string; coordinates?: number[] } | null
      if (g?.type !== 'Point') continue
      const [lon, lat] = g.coordinates ?? []
      if (Number.isFinite(lon) && Number.isFinite(lat)) pts.push({ lon, lat })
    }
  }
  return db.replaceLandAddresses(region.fips, pts)
}

// ---------------------------------------------------- local (free) facts

export interface FloodFact {
  worst: string | null
  inFloodway: boolean
  inSfha: boolean
  zones: string[]
  touching: string[]
}

/**
 * Flood classification from the locally stored overlay.
 *
 * The centroid gives the parcel's primary zone; the bounding box gives what it
 * merely touches. That distinction matters for real decisions — a 12-acre
 * parcel clipping an AE zone at one corner is still buildable, and a scoring
 * pass that only tested the centroid would call it clean.
 */
export function floodFact(fips: string, lon: number, lat: number, box: Bbox): FloodFact {
  const at = db.overlayAt(fips, 'flood', lon, lat) as Array<{ zone: string; subtype: string | null; sfha: boolean }>
  const near = db.overlayNear(fips, 'flood', box) as Array<{ zone: string; subtype: string | null; sfha: boolean }>
  const zones = at.filter(Boolean).map((z) => z.zone).filter(Boolean)
  const touching = [...new Set(near.filter(Boolean).map((z) => z.zone).filter(Boolean))]
  const isFloodway = (z: { subtype: string | null }): boolean => /FLOODWAY/i.test(z.subtype ?? '')
  return {
    worst: worstZone([...at, ...near].filter(Boolean)),
    inFloodway: at.some(isFloodway) || near.some(isFloodway),
    inSfha: at.some((z) => z.sfha),
    zones: [...new Set(zones)],
    touching
  }
}

/** FEMA zone severity, worst first. A/AE/AO/AH are the 1% annual chance floodplain. */
const ZONE_RANK = ['V', 'VE', 'AE', 'AO', 'AH', 'A', 'A99', 'AR', 'D', 'X']
function worstZone(zones: Array<{ zone: string; subtype: string | null }>): string | null {
  let best: string | null = null
  let bestRank = Infinity
  for (const z of zones) {
    if (!z?.zone) continue
    const r = ZONE_RANK.indexOf(z.zone.toUpperCase())
    const rank = r === -1 ? ZONE_RANK.length : r
    if (rank < bestRank) { bestRank = rank; best = z.zone }
  }
  return best
}

export interface UtilityFact {
  nearestAddressFt: number | null
  provider: string | null
  estLow: number | null
  estHigh: number | null
  basis: string
}

/**
 * Distance to the nearest address point, priced against the provider's
 * extension tariff.
 *
 * This is a proxy and is labelled as one everywhere it surfaces: an existing
 * house means an existing service drop, so the distance to the nearest one is a
 * usable stand-in for distance to the nearest distribution line. It will
 * overestimate where a line runs past undeveloped frontage and underestimate
 * where the neighbouring house is fed from the far side.
 */
export function utilityFact(fips: string, lon: number, lat: number, box: Bbox): UtilityFact {
  let nearest: number | null = null
  // Widen the search ring until something turns up; anything past half a mile
  // is priced the same way (badly) so there is no point looking further.
  for (const ft of [300, 800, 1600, 2640]) {
    const [w, s, e, n] = padBbox(box, ft)
    const pts = db.addressesInBox(w, s, e, n, 256)
    if (!pts.length) continue
    nearest = Math.min(...pts.map((p) => distanceFt(lon, lat, p.lon, p.lat)))
    break
  }

  const providers = db.listLandUtilities(fips).filter((u) => u.kind === 'electric')
  const provider = providers[0] ?? null
  if (nearest == null || !provider) {
    return {
      nearestAddressFt: nearest,
      provider: provider?.name ?? null,
      estLow: null,
      estHigh: null,
      basis: nearest == null ? 'no address point within half a mile' : 'no provider tariff configured'
    }
  }
  const billable = Math.max(nearest - provider.free_feet, 0)
  const mid = provider.base_fee + billable * provider.cost_per_foot
  return {
    nearestAddressFt: Math.round(nearest),
    provider: provider.name,
    // The tariff rate is the anchor and the spread is deliberately wide: terrain,
    // road crossings and easements move real quotes far more than distance does.
    estLow: Math.round(mid * 0.6),
    estHigh: Math.round(mid * 1.8),
    basis: `${Math.round(nearest)} ft to nearest address point, ${provider.name} at $${provider.cost_per_foot}/ft beyond ${provider.free_feet} ft`
  }
}

export interface HazardFact {
  karst: boolean
  karstType: string | null
  wetlandTypes: string[]
  toxicNearby: Array<{ name: string; programs: string | null }>
  jurisdiction: string | null
}

export function hazardFact(fips: string, lon: number, lat: number, box: Bbox): HazardFact {
  const karst = db.overlayAt(fips, 'karst', lon, lat) as Array<{ type: string }>
  const karstNear = db.overlayNear(fips, 'karst', box) as Array<{ type: string }>
  const wet = db.overlayNear(fips, 'wetland', box) as Array<{ type: string | null }>
  const tox = db.overlayNear(fips, 'toxic', padBbox(box, 1320)) as Array<{ name: string; programs: string | null }>
  const juris = db.overlayAt(fips, 'jurisdiction', lon, lat) as Array<{ name: string | null }>
  return {
    karst: karst.length > 0 || karstNear.length > 0,
    karstType: karst[0]?.type ?? karstNear[0]?.type ?? null,
    wetlandTypes: [...new Set(wet.filter(Boolean).map((w) => w.type).filter((t): t is string => !!t))],
    toxicNearby: tox.filter(Boolean).slice(0, 8),
    // Outside any incorporated place means county jurisdiction — usually the
    // looser zoning, which is the point of checking.
    jurisdiction: juris.find((j) => j?.name)?.name ?? null
  }
}

// -------------------------------------------------- per-parcel (network) facts

export interface TerrainFact {
  meanSlopeDeg: number
  maxSlopeDeg: number
  medianSlopeDeg: number | null
  meanSlopePct: number
  /** Share of the parcel at or under 10% grade — the usable-pad proxy. */
  flatEnough: boolean
  samples: number
}

/** Slope statistics for one parcel: a single 3DEP request over its polygon. */
export async function fetchTerrain(
  parcel: { id: string; lat: number; lon: number },
  geom: unknown,
  signal?: AbortSignal
): Promise<TerrainFact | null> {
  const polys = toPolygons(geom as never)
  const rings = polys.map((p) => p[0]).filter((r) => r && r.length >= 4)
  if (!rings.length) return null
  await terrainPace.wait(signal)
  const stats = await imageStats({
    url: NATIONAL.terrain.url,
    rings,
    rasterFunction: 'Slope Degrees',
    signal
  })
  if (!stats) return null
  const meanPct = Math.tan((stats.mean * Math.PI) / 180) * 100
  return {
    meanSlopeDeg: round2(stats.mean),
    maxSlopeDeg: round2(stats.max),
    medianSlopeDeg: stats.median,
    meanSlopePct: round2(meanPct),
    flatEnough: meanPct <= 10,
    samples: stats.count
  }
}

export interface CoverFact {
  code: number | null
  label: string | null
  wooded: boolean
  buildable: boolean
}

/**
 * Land cover class at the parcel centroid.
 *
 * MRLC does not publish CONUS tree-canopy percentage on this service, so this
 * is a class read from one 30m pixel rather than a canopy fraction — enough to
 * say "wooded / pasture / already developed", not enough to find the clearing
 * inside a wooded parcel. The aerial overlay is the tool for that.
 */
export async function fetchCover(
  parcel: { lat: number; lon: number },
  signal?: AbortSignal
): Promise<CoverFact | null> {
  await coverPace.wait(signal)
  const d = 0.001
  const params = new URLSearchParams({
    service: 'WMS', version: '1.1.1', request: 'GetFeatureInfo',
    layers: NLCD_LAYER, query_layers: NLCD_LAYER, srs: 'EPSG:4326',
    bbox: `${parcel.lon - d},${parcel.lat - d},${parcel.lon + d},${parcel.lat + d}`,
    width: '101', height: '101', x: '50', y: '50',
    info_format: 'application/json'
  })
  const res = await fetch(`${NATIONAL.landcover.url}?${params}`, { headers: { 'User-Agent': LAND_UA }, signal })
  if (!res.ok) return null
  const j = (await res.json()) as { features?: Array<{ properties?: Record<string, number> }> }
  const idx = j.features?.[0]?.properties?.PALETTE_INDEX
  if (idx == null) return null
  const cls = NLCD_CLASSES[idx]
  return { code: idx, label: cls?.label ?? `class ${idx}`, wooded: !!cls?.wooded, buildable: cls?.buildable !== false }
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Compute and cache every local fact for one parcel. Free — no network — so
 * this runs over the whole candidate set whenever overlays are refreshed.
 */
export function enrichLocal(parcel: db.LandParcel): void {
  const box: Bbox = [
    parcel.min_lon ?? parcel.lon, parcel.min_lat ?? parcel.lat,
    parcel.max_lon ?? parcel.lon, parcel.max_lat ?? parcel.lat
  ]
  db.putLandFact(parcel.id, 'flood', floodFact(parcel.fips, parcel.lon, parcel.lat, box))
  db.putLandFact(parcel.id, 'hazard', hazardFact(parcel.fips, parcel.lon, parcel.lat, box))
  db.putLandFact(parcel.id, 'utility', utilityFact(parcel.fips, parcel.lon, parcel.lat, box))
}

export interface SoilFact {
  mapUnit: string | null
  drainage: string | null
  hydrologicGroup: string | null
  floodFrequency: string | null
  hydric: boolean
  /** Septic suitability inferred from drainage class — see note below. */
  septic: 'good' | 'fair' | 'poor' | 'unknown'
  /** SSURGO names the soil series' landform; in karst country it says so. */
  karstNamed: boolean
}

/**
 * Soil facts at the parcel centroid from USDA Soil Data Access.
 *
 * Septic viability is the quiet dealbreaker for a homestead build — a "poor"
 * rating means an engineered system and a five-figure surprise — so it is worth
 * a request per parcel. This reads drainage class from `muaggatt` rather than
 * the formal "Septic Tank Absorption Fields" interpretation in `cointerp`:
 * drainage is one cheap join, present for every map unit, and it drives the
 * formal rating anyway. A parcel that scores badly here deserves a real perc
 * test, which is the actual answer regardless of what any dataset says.
 *
 * The map unit NAME is also read for the word "karst". Kentucky has no karst
 * polygon layer wired up, but SSURGO names the landform, so a Jefferson County
 * parcel on "Vertrees-Haggatt-Caneyville complex, karst, hilly" still gets a
 * karst signal.
 */
export async function fetchSoil(
  parcel: { lat: number; lon: number },
  signal?: AbortSignal
): Promise<SoilFact | null> {
  await soilPace.wait(signal)
  const query = [
    'SELECT TOP 1 mu.muname, mag.drclassdcd, mag.hydgrpdcd, mag.flodfreqdcd, mag.hydclprs',
    'FROM mapunit mu JOIN muaggatt mag ON mag.mukey = mu.mukey',
    `WHERE mu.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${parcel.lon} ${parcel.lat})'))`
  ].join(' ')

  const res = await fetch('https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': LAND_UA },
    body: JSON.stringify({ format: 'JSON', query }),
    signal
  })
  if (!res.ok) return null
  const j = (await res.json()) as { Table?: string[][] }
  const row = j.Table?.[0]
  if (!row) return null

  const [muname, drainage, hydgrp, flood, hydric] = row
  return {
    mapUnit: muname ?? null,
    drainage: drainage ?? null,
    hydrologicGroup: hydgrp ?? null,
    floodFrequency: flood ?? null,
    hydric: String(hydric ?? '').trim() === '1',
    septic: septicFromDrainage(drainage),
    karstNamed: /karst/i.test(muname ?? '')
  }
}

/**
 * Drainage class to septic suitability.
 *
 * Excessively drained soil fails the other way from poorly drained — effluent
 * moves through it too fast to be treated, which is why it is only 'fair'.
 */
function septicFromDrainage(d: string | null | undefined): SoilFact['septic'] {
  const s = (d ?? '').toLowerCase()
  if (!s) return 'unknown'
  if (s.includes('very poorly') || s.includes('poorly')) return 'poor'
  if (s.includes('somewhat poorly')) return 'poor'
  if (s.includes('excessively')) return 'fair'
  if (s.includes('moderately well')) return 'fair'
  if (s.includes('well drained')) return 'good'
  return 'unknown'
}
