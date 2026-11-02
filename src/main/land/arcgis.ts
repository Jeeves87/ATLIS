/**
 * Generic ArcGIS REST client.
 *
 * Nearly every county, state and federal GIS portal in the US publishes through
 * ArcGIS Server, and they all speak the same query protocol regardless of who
 * runs them. One paged client against that protocol is what makes adding a new
 * county a config entry rather than a code change — LOJIC's MapServer and
 * Indiana's statewide FeatureServer are read by the exact same function here,
 * differing only in a URL and a field map.
 *
 * Servers cap a page at `maxRecordCount` (2000 on both of ours) and signal more
 * with `exceededTransferLimit`, so paging is driven by that flag rather than by
 * a count query — a county that quietly raises or lowers its cap keeps working.
 */
import type { GeoJSONGeometry } from './geo'
import { LAND_UA } from './sources'

export interface ArcFeature {
  properties: Record<string, unknown>
  geometry: GeoJSONGeometry | null
}

export interface QueryOpts {
  url: string                 // .../MapServer/1 or .../FeatureServer/0
  where?: string
  /**
   * Fields to return. Omit for all fields; pass an EMPTY array for geometry
   * only, which is not the same thing — see the note in `queryPaged`.
   */
  outFields?: string[]
  geometry?: boolean
  /** minLon, minLat, maxLon, maxLat — server-side spatial filter. */
  bbox?: [number, number, number, number]
  pageSize?: number
  maxFeatures?: number
  signal?: AbortSignal
  onPage?: (loaded: number) => void
}

/** ArcGIS rejects an unencoded `#` and treats `+` as a space in `where`. */
const q = (v: string): string => encodeURIComponent(v)

async function getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { 'User-Agent': LAND_UA, Accept: 'application/json' }, signal })
  if (!res.ok) {
    // A 500 on a /query is nearly always a field name the server does not
    // recognise — including one that differs only in case, which some servers
    // reject in their GeoJSON formatter while accepting it everywhere else.
    const hint = res.status === 500 && url.includes('outFields=')
      ? ' — check the outFields names and their exact casing against the layer'
      : ''
    throw new Error(`${res.status} ${res.statusText} from ${url.split('?')[0]}${hint}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  // ArcGIS reports failures as HTTP 200 with an `error` body, so a bad field
  // name or a dropped service looks like success unless this is checked.
  const err = json.error as { message?: string; details?: string[] } | undefined
  if (err) throw new Error(`ArcGIS: ${err.message ?? 'error'}${err.details?.length ? ` — ${err.details.join('; ')}` : ''}`)
  return json
}

/** Service/layer metadata — used to confirm a configured endpoint is alive. */
export async function describeLayer(url: string, signal?: AbortSignal): Promise<{
  name: string; geometryType: string | null; maxRecordCount: number; fields: string[]
}> {
  const j = await getJson(`${url}?f=json`, signal)
  return {
    name: String(j.name ?? 'unnamed'),
    geometryType: (j.geometryType as string) ?? null,
    maxRecordCount: Number(j.maxRecordCount ?? 1000),
    fields: ((j.fields as Array<{ name: string }>) ?? []).map((f) => f.name)
  }
}

export async function countFeatures(url: string, where = '1=1', signal?: AbortSignal): Promise<number> {
  const j = await getJson(`${url}/query?where=${q(where)}&returnCountOnly=true&f=json`, signal)
  return Number(j.count ?? 0)
}

/**
 * Page through a layer, yielding one batch at a time so a 300k-parcel county
 * never has to exist in memory as a single array.
 */
export async function* queryPaged(o: QueryOpts): AsyncGenerator<ArcFeature[]> {
  const page = Math.min(o.pageSize ?? 2000, 5000)
  // An empty array means "no attributes, just geometry", and it is expressed by
  // omitting outFields entirely rather than sending it empty. That distinction
  // matters: Indiana's address-point layer returns HTTP 500 for
  // `outFields=OBJECTID&f=geojson` while accepting the same request with
  // `objectid`, so its GeoJSON formatter is case-sensitive where the rest of
  // the API is not. Never asking for a field we do not use sidesteps the whole
  // class of problem.
  const fields = o.outFields === undefined ? '*' : o.outFields.join(',')
  let offset = 0
  let loaded = 0

  for (;;) {
    const parts = [
      `where=${q(o.where || '1=1')}`,
      ...(fields ? [`outFields=${q(fields)}`] : []),
      `returnGeometry=${o.geometry === false ? 'false' : 'true'}`,
      'outSR=4326',
      'f=geojson',
      `resultOffset=${offset}`,
      `resultRecordCount=${page}`
    ]
    if (o.bbox) {
      parts.push(
        `geometry=${o.bbox.join(',')}`,
        'geometryType=esriGeometryEnvelope',
        'inSR=4326',
        'spatialRel=esriSpatialRelIntersects'
      )
    }
    const j = await getJson(`${o.url}/query?${parts.join('&')}`, o.signal)
    const feats = (j.features as Array<{ properties?: Record<string, unknown>; geometry?: GeoJSONGeometry }>) ?? []
    if (!feats.length) return

    yield feats.map((f) => ({ properties: f.properties ?? {}, geometry: f.geometry ?? null }))
    loaded += feats.length
    offset += feats.length
    o.onPage?.(loaded)

    if (o.maxFeatures && loaded >= o.maxFeatures) return
    // `properties.exceededTransferLimit` is where the geojson formatter puts the
    // flag; older servers omit it entirely and just return a short final page.
    const more = Boolean((j.properties as { exceededTransferLimit?: boolean } | undefined)?.exceededTransferLimit
      ?? (j as { exceededTransferLimit?: boolean }).exceededTransferLimit
      ?? feats.length === page)
    if (!more) return
  }
}

/** Convenience wrapper for small result sets that comfortably fit in memory. */
export async function queryAll(o: QueryOpts): Promise<ArcFeature[]> {
  const out: ArcFeature[] = []
  for await (const batch of queryPaged(o)) {
    out.push(...batch)
    if (o.maxFeatures && out.length >= o.maxFeatures) break
  }
  return o.maxFeatures ? out.slice(0, o.maxFeatures) : out
}

/**
 * Raster statistics over a polygon from an ArcGIS ImageServer.
 *
 * This is the one enrichment that genuinely has to run per parcel, and it is
 * only affordable because the server does the reduction: asking 3DEP for slope
 * statistics over a parcel returns min/max/mean from hundreds of thousands of
 * 1m samples in a single request, where sampling point-by-point would be
 * thousands of round trips for the same answer.
 */
export async function imageStats(o: {
  url: string
  rings: number[][][]              // outer rings in lon/lat
  rasterFunction?: string
  signal?: AbortSignal
}): Promise<{ min: number; max: number; mean: number; median: number | null; stddev: number | null; count: number } | null> {
  const body = new URLSearchParams({
    geometry: JSON.stringify({ rings: o.rings, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPolygon',
    f: 'json'
  })
  if (o.rasterFunction) body.set('renderingRule', JSON.stringify({ rasterFunction: o.rasterFunction }))

  const res = await fetch(`${o.url}/computeStatisticsHistograms`, {
    method: 'POST',
    headers: { 'User-Agent': LAND_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: o.signal
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from computeStatisticsHistograms`)
  const j = (await res.json()) as { statistics?: Array<Record<string, number>>; error?: { message?: string } }
  if (j.error) throw new Error(`ImageServer: ${j.error.message ?? 'error'}`)
  const s = j.statistics?.[0]
  if (!s || !Number.isFinite(s.mean)) return null
  return {
    min: s.min, max: s.max, mean: s.mean,
    median: Number.isFinite(s.median) ? s.median : null,
    stddev: Number.isFinite(s.standardDeviation) ? s.standardDeviation : null,
    count: Number(s.count ?? 0)
  }
}

/** Simple fixed-gap rate limiter — public GIS servers are shared infrastructure. */
export class Pacer {
  private last = 0
  private gapMs: number
  constructor(gapMs: number) { this.gapMs = gapMs }
  async wait(signal?: AbortSignal): Promise<void> {
    const due = this.last + this.gapMs - Date.now()
    if (due > 0) await new Promise((r) => setTimeout(r, due))
    if (signal?.aborted) throw new Error('aborted')
    this.last = Date.now()
  }
}
