/**
 * Land search — pipeline orchestration and the module's public surface.
 *
 * The pipeline is four stages, deliberately separated because they have wildly
 * different costs and want different cadences:
 *
 *   1. ingestParcels   bulk, cheap, ~1 request per 2000 parcels. Runs rarely.
 *   2. markCandidates  pure SQL, free, instant. Runs whenever filters change.
 *   3. enrichRegion    the expensive stage — one request per candidate per
 *                      network fact. Resumable, cached forever, cancellable.
 *   4. rescoreRegion   pure local arithmetic over cached facts. Runs whenever
 *                      the weights change, which is often.
 *
 * Keeping 4 independent of 3 is what makes the tool usable: retuning what you
 * care about re-ranks every parcel instantly instead of re-fetching anything.
 */
import { BrowserWindow } from 'electron'
import * as db from '../db'
import { queryPaged, describeLayer, countFeatures } from './arcgis'
import { acresOf, bboxOf, centroidOf, type Bbox } from './geo'
import {
  SEED_REGIONS, SEED_UTILITIES, allSources, type RegionDef, type ParcelSourceDef
} from './sources'
import {
  ingestOverlays, ingestAddressPoints, enrichLocal,
  fetchTerrain, fetchCover, fetchSoil, type Progress
} from './enrich'
import { rescoreRegion, loadWeights, saveWeights, type Weights } from './score'
import { ingestAssessments, type AssessmentResult } from './assessment'
import {
  ingestPois, refitRegion, scoreFit, lifestyleNote, routeMinutes, geocode,
  AMENITIES, FIT_LABELS, type FitResult
} from './fit'

export { loadWeights, saveWeights, rescoreRegion, type Weights }
export { dlgfCountyNumber } from './assessment'
export type { AssessmentResult }
export { refitRegion, routeMinutes, geocode, AMENITIES, FIT_LABELS }
export type { FitResult }

/**
 * Load a region's amenities and re-score fit. Separate from `enrichRegion`
 * because it depends on the household's anchors rather than on the land, and so
 * needs re-running when the anchors change rather than when the county does.
 */
export async function fitRegion(fips: string, win: BrowserWindow | null): Promise<{ pois: Record<string, number>; scored: number }> {
  if (job) throw new Error(`a ${job.kind} job is already running`)
  const region = regionDef(fips)
  const abort = new AbortController()
  job = { kind: 'fit', fips, abort }
  emit(win, { running: true, kind: 'fit', fips, message: `${region.name}: amenities…`, pct: 0 })
  try {
    const pois = await ingestPois(region, (msg, pct) => emit(win, { message: msg, pct: pct ?? null }), abort.signal)
    emit(win, { message: `${region.name}: scoring fit…`, pct: 0.9 })
    return { pois, scored: refitRegion(fips) }
  } finally {
    job = null
    emit(win, { running: false, kind: null, fips: null, message: '', pct: null })
  }
}

/** Re-score fit across every ingested region — what an anchor edit triggers. */
export function refitAll(): number {
  let n = 0
  for (const r of db.listLandRegions()) if (r.candidate_count > 0) n += refitRegion(r.fips)
  return n
}

/**
 * Pull one county-year of DLGF assessment data and re-score afterwards: land
 * value does not feed the score itself, but the absentee flag and the $/acre
 * comparables both read from it, and stale scores next to fresh values are
 * more confusing than a few seconds of recompute.
 */
export async function assessRegion(
  fips: string,
  year: number,
  win: BrowserWindow | null
): Promise<AssessmentResult> {
  if (job) throw new Error(`a ${job.kind} job is already running`)
  const abort = new AbortController()
  job = { kind: 'assess', fips, abort }
  emit(win, { running: true, kind: 'assess', fips, message: 'starting…', pct: 0 })
  try {
    const r = await ingestAssessments(fips, year, (msg, pct) => emit(win, { message: msg, pct: pct ?? null }), abort.signal)
    rescoreRegion(fips, loadWeights())
    return r
  } finally {
    job = null
    emit(win, { running: false, kind: null, fips: null, message: '', pct: null })
  }
}

// ------------------------------------------------------------------ status

let job: { kind: string; fips: string; abort: AbortController } | null = null

export interface JobState {
  running: boolean
  kind: string | null
  fips: string | null
  message: string
  pct: number | null
}

let lastState: JobState = { running: false, kind: null, fips: null, message: '', pct: null }

function emit(win: BrowserWindow | null, patch: Partial<JobState>): void {
  lastState = { ...lastState, ...patch }
  if (win && !win.isDestroyed()) win.webContents.send('land:progress', lastState)
}

export const jobState = (): JobState => lastState

export function cancelJob(): boolean {
  if (!job) return false
  job.abort.abort()
  job = null
  return true
}

/** Seed the registry on first run; existing progress counters are preserved. */
export function ensureSeeded(): void {
  for (const r of SEED_REGIONS) {
    db.upsertLandRegion({
      fips: r.fips,
      state: r.state,
      name: r.name,
      min_lon: r.bounds[0], min_lat: r.bounds[1],
      max_lon: r.bounds[2], max_lat: r.bounds[3],
      source: JSON.stringify(r.parcels),
      extras: JSON.stringify({ addressPoints: r.addressPoints ?? null, note: r.note ?? null })
    })
  }
  // Only seed utility placeholders that do not exist — these are meant to be
  // edited by hand with real tariff numbers, and a reseed must not clobber that.
  const existing = new Set(db.listLandUtilities().map((u) => u.id))
  for (const u of SEED_UTILITIES) if (!existing.has(u.id)) db.upsertLandUtility(u)
}

/** Rehydrate a RegionDef from its stored row, so custom regions work too. */
export function regionDef(fips: string): RegionDef {
  const row = db.getLandRegion(fips)
  if (!row) throw new Error(`unknown region ${fips}`)
  const seed = SEED_REGIONS.find((r) => r.fips === fips)
  const extras = safeParse<{ addressPoints?: RegionDef['addressPoints']; note?: string }>(row.extras) ?? {}
  return {
    fips: row.fips,
    state: row.state,
    name: row.name,
    bounds: [row.min_lon ?? -180, row.min_lat ?? -90, row.max_lon ?? 180, row.max_lat ?? 90],
    parcels: safeParse<ParcelSourceDef>(row.source) ?? seed!.parcels,
    addressPoints: extras.addressPoints ?? seed?.addressPoints,
    note: extras.note ?? seed?.note
  }
}

function safeParse<T>(s: string | null | undefined): T | null {
  if (!s) return null
  try { return JSON.parse(s) as T } catch { return null }
}

// ------------------------------------------------------------ stage 1: parcels

/**
 * Pull every parcel polygon for a region and reduce it to a row.
 *
 * Geometry is deliberately NOT persisted. A county's polygons are hundreds of
 * megabytes, and nothing downstream needs them once acreage, centroid and bbox
 * are computed — overlays are tested against the centroid and box, and the map
 * draws parcels as points. The only stage that wants real geometry is the
 * terrain fetch, which re-requests the single parcel it is working on.
 */
export async function ingestParcels(
  fips: string,
  win: BrowserWindow | null,
  onProgress: Progress = () => {}
): Promise<{ parcels: number; addresses: number }> {
  if (job) throw new Error(`a ${job.kind} job is already running`)
  const region = regionDef(fips)
  const abort = new AbortController()
  job = { kind: 'ingest', fips, abort }
  db.patchLandRegion(fips, { status: 'ingesting', note: null })
  emit(win, { running: true, kind: 'ingest', fips, message: `${region.name}: starting…`, pct: 0 })

  const report: Progress = (msg, pct) => { onProgress(msg, pct); emit(win, { message: msg, pct: pct ?? null }) }

  try {
    const src = region.parcels
    const outFields = [src.fields.pin, src.fields.address, src.fields.city, src.fields.owner, src.fields.landUse, src.fields.assessed]
      .filter((f): f is string => !!f)

    const expected = await countFeatures(src.url, src.where || '1=1', abort.signal).catch(() => 0)
    // Keyed by parcel id, not a flat list: one legal parcel is frequently
    // published as several polygon rows — a split lot, a road easement cutting
    // through, a river frontage strip. Harrison County alone returns 28,083
    // features for 27,993 distinct ids. Those are the SAME parcel and have to
    // be merged, not overwritten: taking the last row seen would report a
    // 40-acre farm as whichever fragment happened to page in last.
    const merged = new Map<string, MergedParcel>()
    let seen = 0
    let dupes = 0

    for await (const batch of queryPaged({
      url: src.url,
      where: src.where,
      outFields,
      geometry: true,
      signal: abort.signal
    })) {
      for (const f of batch) {
        const p = f.properties
        const pin = String(p[src.fields.pin] ?? '').trim()
        const box = bboxOf(f.geometry)
        const c = centroidOf(f.geometry)
        if (!pin || !box || !c) continue
        const id = `${fips}:${pin}`
        const pick = (field?: string): string | null => (field ? str(p[field]) : null)
        const acres = acresOf(f.geometry) ?? 0
        const existing = merged.get(id)

        if (existing) {
          dupes++
          existing.acres += acres
          existing.minLon = Math.min(existing.minLon, box[0])
          existing.minLat = Math.min(existing.minLat, box[1])
          existing.maxLon = Math.max(existing.maxLon, box[2])
          existing.maxLat = Math.max(existing.maxLat, box[3])
          // Area-weighted so the centroid lands on the bulk of the parcel
          // rather than drifting toward a sliver.
          existing.cx += c[0] * acres
          existing.cy += c[1] * acres
          existing.weight += acres
          existing.address ??= pick(src.fields.address)
          existing.city ??= pick(src.fields.city)
          existing.owner ??= pick(src.fields.owner)
          existing.landUse ??= pick(src.fields.landUse)
          existing.assessed ??= src.fields.assessed ? numOrNull(p[src.fields.assessed]) : null
          continue
        }

        merged.set(id, {
          pin,
          acres,
          minLon: box[0], minLat: box[1], maxLon: box[2], maxLat: box[3],
          cx: c[0] * acres, cy: c[1] * acres, weight: acres,
          fallbackLon: c[0], fallbackLat: c[1],
          address: pick(src.fields.address),
          city: pick(src.fields.city),
          owner: pick(src.fields.owner),
          landUse: pick(src.fields.landUse),
          assessed: src.fields.assessed ? numOrNull(p[src.fields.assessed]) : null
        })
      }
      seen += batch.length
      report(`${region.name}: ${seen.toLocaleString()}${expected ? ` / ${expected.toLocaleString()}` : ''} parcels`,
        expected ? seen / expected : undefined)
    }

    const rows: Array<Omit<db.LandParcel, 'ingested_at'>> = [...merged.entries()].map(([id, m]) => ({
      id,
      fips,
      pin: m.pin,
      address: m.address,
      city: m.city,
      owner: m.owner,
      acres: m.acres > 0 ? m.acres : null,
      land_use: m.landUse,
      vacant: src.vacancy === 'class' ? (isVacantClass(m.landUse, src) ? 1 : 0) : 0,
      assessed: m.assessed,
      // Zero-area geometry can't be weighted, so fall back to the first centroid.
      lat: m.weight > 0 ? m.cy / m.weight : m.fallbackLat,
      lon: m.weight > 0 ? m.cx / m.weight : m.fallbackLon,
      min_lon: m.minLon, min_lat: m.minLat, max_lon: m.maxLon, max_lat: m.maxLat,
      candidate: 0
    }))

    report(`${region.name}: writing ${rows.length.toLocaleString()} parcels${dupes ? ` (${dupes.toLocaleString()} multipart rows merged)` : ''}…`, 1)
    const parcels = db.replaceLandParcels(fips, rows)

    let addresses = 0
    if (region.addressPoints) {
      report(`${region.name}: address points…`)
      addresses = await ingestAddressPoints(region, report, abort.signal)
    }

    // Jefferson has no land-use field, so vacancy is only knowable once the
    // address points are loaded — resolve it here, after both are in.
    if (region.parcels.vacancy === 'address') {
      report(`${region.name}: inferring vacancy from address points…`)
      db.markVacantByNoAddress(fips)
    }

    db.patchLandRegion(fips, { status: 'ready', parcel_count: parcels, ingested_at: Date.now() })
    return { parcels, addresses }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    db.patchLandRegion(fips, { status: 'error', note: msg })
    throw err
  } finally {
    job = null
    emit(win, { running: false, kind: null, fips: null, message: '', pct: null })
  }
}

/** Accumulator for the polygon rows that make up one parcel. */
interface MergedParcel {
  pin: string
  acres: number
  minLon: number; minLat: number; maxLon: number; maxLat: number
  cx: number; cy: number; weight: number
  fallbackLon: number; fallbackLat: number
  address: string | null
  city: string | null
  owner: string | null
  landUse: string | null
  assessed: number | null
}

/** Trim to a value, or null — an absent field and a blank one mean the same here. */
function str(v: unknown): string | null {
  if (v == null) return null
  return String(v).trim() || null
}

function numOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function isVacantClass(code: string | null, src: ParcelSourceDef): boolean {
  if (!code || !src.vacantClasses?.length) return false
  return src.vacantClasses.includes(code.trim())
}

// -------------------------------------------------- stage 2: candidate filter

export interface CandidateFilter {
  minAcres?: number
  maxAcres?: number
  vacantOnly?: boolean
}

/**
 * Narrow a region to the parcels worth spending network calls on.
 *
 * This is the cost lever for the entire tool. Jefferson County alone is 293k
 * parcels; enriching all of them would be nearly a million HTTP requests. A
 * sane filter cuts that to a few thousand, and it is instant to re-run because
 * it never leaves SQLite.
 */
export function markCandidates(fips: string, filter: CandidateFilter = {}): number {
  const clauses: string[] = []
  const args: Record<string, string | number | null> = {}
  const minAcres = filter.minAcres ?? 1
  clauses.push('acres >= @minAcres')
  args.minAcres = minAcres
  if (filter.maxAcres != null) { clauses.push('acres <= @maxAcres'); args.maxAcres = filter.maxAcres }
  if (filter.vacantOnly !== false) clauses.push('vacant = 1')

  const n = db.markLandCandidates(fips, clauses.join(' AND '), args)
  db.patchLandRegion(fips, { candidate_count: n })
  return n
}

// ------------------------------------------------------- stage 3: enrichment

export interface EnrichOpts {
  /** Cap network calls per run so a first pass returns something usable fast. */
  limit?: number
  sources?: Array<'terrain' | 'cover' | 'soil'>
}

/**
 * Enrich a region's candidates. Resumable by construction: the work queue is
 * "candidates with no cached fact from this source", so an interrupted run
 * simply picks up where it stopped, and a completed one costs nothing to repeat.
 */
export async function enrichRegion(
  fips: string,
  win: BrowserWindow | null,
  opts: EnrichOpts = {}
): Promise<Record<string, number>> {
  if (job) throw new Error(`a ${job.kind} job is already running`)
  const region = regionDef(fips)
  const abort = new AbortController()
  job = { kind: 'enrich', fips, abort }
  emit(win, { running: true, kind: 'enrich', fips, message: `${region.name}: overlays…`, pct: 0 })

  const report: Progress = (msg, pct) => emit(win, { message: msg, pct: pct ?? null })
  const done: Record<string, number> = {}

  try {
    // Bulk overlays first — free per parcel, and every local fact depends on them.
    const overlays = await ingestOverlays(region, report, abort.signal)
    Object.assign(done, overlays)

    const candidates = db.listLandCandidates(fips)
    report(`${region.name}: local facts for ${candidates.length.toLocaleString()} candidates…`)
    for (const p of candidates) enrichLocal(p)
    done.local = candidates.length

    const limit = opts.limit ?? 400
    const sources = opts.sources ?? ['terrain', 'soil', 'cover']

    for (const source of sources) {
      const queue = db.listLandUnenriched(fips, source, limit)
      let n = 0
      for (const p of queue) {
        if (abort.signal.aborted) throw new Error('cancelled')
        try {
          const value = source === 'terrain'
            ? await fetchTerrainFor(p, region, abort.signal)
            : source === 'soil'
              ? await fetchSoil(p, abort.signal)
              : await fetchCover(p, abort.signal)
          // A null result is still cached: it means "asked, nothing there",
          // and without recording it the queue would retry forever.
          db.putLandFact(p.id, source, value)
        } catch (err) {
          if (abort.signal.aborted) throw err
          db.putLandFact(p.id, source, { error: err instanceof Error ? err.message : String(err) })
        }
        n++
        if (n % 5 === 0 || n === queue.length) {
          report(`${region.name}: ${source} ${n}/${queue.length}`, n / Math.max(queue.length, 1))
        }
      }
      done[source] = n
    }

    report(`${region.name}: scoring…`)
    done.scored = rescoreRegion(fips, loadWeights())
    return done
  } finally {
    job = null
    emit(win, { running: false, kind: null, fips: null, message: '', pct: null })
  }
}

/**
 * Terrain needs the parcel's real polygon, which ingest discarded. Re-fetching
 * the single feature is cheaper than having stored 300k polygons on disk, and
 * it rides the same paged client as everything else.
 */
async function fetchTerrainFor(
  p: db.LandParcel,
  region: RegionDef,
  signal: AbortSignal
): Promise<unknown> {
  const src = region.parcels
  const pin = p.pin.replace(/'/g, "''")
  const where = `${src.fields.pin}='${pin}'${src.where ? ` AND ${src.where}` : ''}`
  for await (const batch of queryPaged({ url: src.url, where, outFields: [src.fields.pin], geometry: true, signal, pageSize: 1 })) {
    const geom = batch[0]?.geometry
    if (geom) return fetchTerrain(p, geom, signal)
    break
  }
  return null
}

// --------------------------------------------------------------- read paths

export interface ParcelDetail {
  parcel: db.LandParcel
  score: db.LandScore | null
  facts: Record<string, unknown>
  assessment: db.LandAssessment | null
  comparable: { median: number | null; p25: number | null; p75: number | null; samples: number } | null
  fit: FitResult
  lifestyleNote: string | null
  region: { fips: string; name: string; state: string; note: string | null }
}

export function parcelDetail(id: string): ParcelDetail | null {
  const parcel = db.getLandParcel(id)
  if (!parcel) return null
  const row = db.getLandRegion(parcel.fips)
  const assessment = db.getLandAssessment(id) ?? null
  const score = db.getLandScore(id) ?? null
  // Recomputed live rather than read from land_fit: anchors change often and a
  // stale cached fit on the parcel you are actually reading would be misleading.
  const fit = scoreFit(parcel, db.listLandAnchors(true), db.listLandPois(parcel.fips))
  return {
    parcel,
    score,
    facts: db.getLandFacts(id),
    assessment,
    // Comparable is computed on demand rather than stored: it depends on what
    // is currently ingested nearby, so a cached figure would go stale silently.
    comparable: assessment ? db.landValuePerAcreNear({ lon: parcel.lon, lat: parcel.lat }) : null,
    fit,
    lifestyleNote: lifestyleNote(score?.total ?? null, fit),
    region: {
      fips: parcel.fips,
      name: row?.name ?? parcel.fips,
      state: row?.state ?? '',
      note: safeParse<{ note?: string }>(row?.extras)?.note ?? null
    }
  }
}

/** Live reachability of every declared source — public GIS URLs move. */
export async function verifySources(): Promise<Array<{
  id: string; label: string; tier: string; ok: boolean; detail: string
}>> {
  return Promise.all(allSources().map(async (s) => {
    try {
      if (s.kind === 'wms') {
        const res = await fetch(`${s.url}?service=WMS&request=GetCapabilities`, { method: 'HEAD' })
        return { id: s.id, label: s.label, tier: s.tier, ok: res.ok, detail: `HTTP ${res.status}` }
      }
      const meta = await describeLayer(s.url)
      return { id: s.id, label: s.label, tier: s.tier, ok: true, detail: `${meta.name} (${meta.fields.length} fields)` }
    } catch (err) {
      return { id: s.id, label: s.label, tier: s.tier, ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }))
}

export interface RegionStatus extends db.LandRegion {
  overlays: Record<string, number>
  addresses: number
  enriched: Record<string, number>
  assessments: { total: number; absentee: number }
  pois: Record<string, number>
  fitted: number
}

export function regionStatus(): RegionStatus[] {
  return db.listLandRegions().map((r) => ({
    ...r,
    overlays: Object.fromEntries(['flood', 'wetland', 'karst', 'toxic', 'jurisdiction']
      .map((k) => [k, db.countLandOverlay(r.fips, k)])),
    addresses: db.countLandAddresses(r.fips),
    enriched: Object.fromEntries(['terrain', 'soil', 'cover']
      .map((k) => [k, db.countLandFacts(r.fips, k)])),
    assessments: db.countLandAssessments(r.fips),
    pois: db.countLandPois(r.fips),
    fitted: db.countLandFit(r.fips)
  }))
}
