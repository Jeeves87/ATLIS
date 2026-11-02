/**
 * Geometry helpers for parcel polygons, in lon/lat degrees.
 *
 * Everything here uses an equirectangular approximation scaled by the local
 * cosine of latitude rather than a real projection. Parcels are small — a few
 * hundred metres across at most — so the error is far below the accuracy of the
 * county geometry itself, and it avoids pulling a projection library into the
 * main process for arithmetic this simple.
 *
 * Acreage is ALWAYS computed here rather than read from a source field. County
 * "acres" columns are inconsistent between jurisdictions (deeded vs calculated
 * vs blank), and a size filter that means different things in different
 * counties would quietly corrupt every candidate set.
 */

export type Ring = number[][] // [[lon, lat], ...]
export type Bbox = [number, number, number, number] // minLon, minLat, maxLon, maxLat

const EARTH_R_M = 6_378_137
const DEG = Math.PI / 180
const SQM_PER_ACRE = 4046.8564224

/** Metres per degree of longitude at a given latitude. */
export const mPerLon = (lat: number): number => EARTH_R_M * DEG * Math.cos(lat * DEG)
export const M_PER_LAT = EARTH_R_M * DEG

export const FT_PER_M = 3.280839895

/** Great-circle-ish distance in feet. Flat-earth is fine at parcel range. */
export function distanceFt(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const midLat = (aLat + bLat) / 2
  const dx = (bLon - aLon) * mPerLon(midLat)
  const dy = (bLat - aLat) * M_PER_LAT
  return Math.hypot(dx, dy) * FT_PER_M
}

/** Signed planar area of a ring in square metres (positive = counter-clockwise). */
function ringAreaSqm(ring: Ring): number {
  if (ring.length < 3) return 0
  let latSum = 0
  for (const [, lat] of ring) latSum += lat
  const scale = mPerLon(latSum / ring.length)
  let acc = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    acc += (xj * scale) * (yi * M_PER_LAT) - (xi * scale) * (yj * M_PER_LAT)
  }
  return acc / 2
}

/**
 * Area in acres for a GeoJSON Polygon/MultiPolygon coordinate array. Inner
 * rings are subtracted, so a donut parcel reports the land it actually owns.
 */
export function acresOf(geom: GeoJSONGeometry | null | undefined): number | null {
  const polys = toPolygons(geom)
  if (!polys.length) return null
  let sqm = 0
  for (const poly of polys) {
    poly.forEach((ring, i) => {
      const a = Math.abs(ringAreaSqm(ring))
      sqm += i === 0 ? a : -a
    })
  }
  if (!(sqm > 0)) return null
  return sqm / SQM_PER_ACRE
}

export interface GeoJSONGeometry {
  type: string
  coordinates: unknown
}

/** Normalise Polygon | MultiPolygon into a list of polygons (ring arrays). */
export function toPolygons(geom: GeoJSONGeometry | null | undefined): Ring[][] {
  if (!geom) return []
  if (geom.type === 'Polygon') return [geom.coordinates as Ring[]]
  if (geom.type === 'MultiPolygon') return geom.coordinates as Ring[][]
  return []
}

export function bboxOf(geom: GeoJSONGeometry | null | undefined): Bbox | null {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const poly of toPolygons(geom)) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
        if (lon < minLon) minLon = lon
        if (lat < minLat) minLat = lat
        if (lon > maxLon) maxLon = lon
        if (lat > maxLat) maxLat = lat
      }
    }
  }
  return Number.isFinite(minLon) ? [minLon, minLat, maxLon, maxLat] : null
}

/**
 * Area-weighted centroid of the outer rings. Falls back to the bbox centre for
 * degenerate geometry — a centroid is used as the parcel's query point for
 * point-in-polygon overlays, so it must always produce something usable.
 */
export function centroidOf(geom: GeoJSONGeometry | null | undefined): [number, number] | null {
  const polys = toPolygons(geom)
  let cx = 0, cy = 0, total = 0
  for (const poly of polys) {
    const ring = poly[0]
    if (!ring || ring.length < 3) continue
    const a = Math.abs(ringAreaSqm(ring))
    if (!(a > 0)) continue
    let sx = 0, sy = 0
    for (const [lon, lat] of ring) { sx += lon; sy += lat }
    cx += (sx / ring.length) * a
    cy += (sy / ring.length) * a
    total += a
  }
  if (total > 0) return [cx / total, cy / total]
  const box = bboxOf(geom)
  return box ? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] : null
}

/**
 * Outer rings as geopoly JSON strings, closed and clamped.
 *
 * geopoly stores one simple polygon per row with no hole support, so a
 * multipolygon becomes several rows and inner rings are dropped. For hazard
 * overlays that is the safe direction to be wrong in: a parcel sitting in the
 * hole of a flood polygon gets flagged for review rather than silently cleared.
 */
export function toGeopolyRings(geom: GeoJSONGeometry | null | undefined, maxVerts = 400): string[] {
  const out: string[] = []
  for (const poly of toPolygons(geom)) {
    const ring = poly[0]
    if (!ring || ring.length < 3) continue
    const simplified = decimate(ring, maxVerts)
    const closed = closeRing(simplified)
    if (closed.length >= 4) out.push(JSON.stringify(closed.map(([lon, lat]) => [round7(lon), round7(lat)])))
  }
  return out
}

const round7 = (n: number): number => Math.round(n * 1e7) / 1e7

function closeRing(ring: Ring): Ring {
  if (!ring.length) return ring
  const [f, l] = [ring[0], ring[ring.length - 1]]
  return f[0] === l[0] && f[1] === l[1] ? ring : [...ring, f]
}

/**
 * Even-stride vertex reduction. Flood and wetland polygons from FEMA/FWS run to
 * thousands of vertices; geopoly stores every one of them in the row, so an
 * unreduced statewide overlay bloats the database far more than it improves a
 * containment test at parcel scale.
 */
function decimate(ring: Ring, maxVerts: number): Ring {
  if (ring.length <= maxVerts) return ring
  const stride = Math.ceil(ring.length / maxVerts)
  const out: Ring = []
  for (let i = 0; i < ring.length; i += stride) out.push(ring[i])
  return out
}

/** Expand a bbox by a distance in feet, for nearest-neighbour windows. */
export function padBbox(box: Bbox, ft: number): Bbox {
  const m = ft / FT_PER_M
  const midLat = (box[1] + box[3]) / 2
  const dLon = m / Math.max(mPerLon(midLat), 1)
  const dLat = m / M_PER_LAT
  return [box[0] - dLon, box[1] - dLat, box[2] + dLon, box[3] + dLat]
}

/** Rough width of a bbox in feet, used to turn elevation relief into a slope. */
export function bboxSpanFt(box: Bbox): number {
  const midLat = (box[1] + box[3]) / 2
  const dx = (box[2] - box[0]) * mPerLon(midLat)
  const dy = (box[3] - box[1]) * M_PER_LAT
  return Math.max(Math.hypot(dx, dy), 1) * FT_PER_M
}
