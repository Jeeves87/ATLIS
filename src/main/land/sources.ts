/**
 * Data source registry — the file that decides how expensive expansion is.
 *
 * Sources fall into three tiers, and the cost of adding a new search area
 * depends entirely on which tier it needs:
 *
 *   NATIONAL — flood, terrain, soil, land cover, wetlands, toxic sites.
 *     Already cover every county in the US. A new region costs nothing here.
 *   STATE    — karst is the live example: published per state geological
 *     survey, so a new state is one entry, a new county in a covered state is
 *     free.
 *   COUNTY   — parcels and address points. The only per-county work, and even
 *     that is usually a URL plus a field map because nearly every county portal
 *     speaks ArcGIS REST.
 *
 * Every endpoint below was verified live before being committed. `verifyAll()`
 * re-checks them on demand, because public GIS URLs move: FEMA's NFHL lived at
 * /gis/nfhl/rest for years and now answers only at /arcgis/rest, and the FWS
 * wetlands service now redirects to a USGS host.
 */

/**
 * How this app identifies itself to every public data source it calls.
 *
 * Not cosmetic. Overpass rejects an unidentified request outright with a 406,
 * and it is the only one of our sources that does today — but they are all free
 * infrastructure run by someone else, and a request that says who it is can be
 * rate-limited or contacted rather than simply blocked. Node's fetch sends no
 * User-Agent at all unless told to, which is what made this bite.
 */
export const LAND_UA = 'ATLIS/1.0 (personal land research; single-user desktop app)'

export type Tier = 'national' | 'state' | 'county'

export interface SourceDef {
  id: string
  tier: Tier
  label: string
  /** ArcGIS layer/service root, or a WMS base URL. */
  url: string
  kind: 'arcgis-layer' | 'arcgis-image' | 'wms'
  /** Which state this covers, for tier 'state'. */
  state?: string
  attribution: string
  note?: string
}

// ---------------------------------------------------------------- national

export const NATIONAL: Record<string, SourceDef> = {
  flood: {
    id: 'flood',
    tier: 'national',
    label: 'FEMA flood hazard zones',
    // Layer 28 is "Flood Hazard Zones" — the polygons carrying FLD_ZONE and the
    // ZONE_SUBTY that separates a floodway from ordinary AE. Layer 27 is only
    // the boundary lines and cannot be used for containment tests.
    url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28',
    kind: 'arcgis-layer',
    attribution: 'FEMA National Flood Hazard Layer'
  },
  terrain: {
    id: 'terrain',
    tier: 'national',
    label: 'USGS 3DEP elevation & slope',
    url: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
    kind: 'arcgis-image',
    attribution: 'USGS 3D Elevation Program',
    note: 'Serves 1m LiDAR across the Louisville area; slope comes back as raster statistics over the parcel polygon.'
  },
  wetland: {
    id: 'wetland',
    tier: 'national',
    label: 'USFWS National Wetlands Inventory',
    url: 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0',
    kind: 'arcgis-layer',
    attribution: 'US Fish & Wildlife Service NWI'
  },
  toxic: {
    id: 'toxic',
    tier: 'national',
    label: 'EPA regulated facilities (FRS)',
    url: 'https://geopub.epa.gov/arcgis/rest/services/EMEF/frs/MapServer/0',
    kind: 'arcgis-layer',
    attribution: 'EPA Facility Registry Service',
    note: 'Presence of a regulated facility nearby, not a contamination finding. Treat as a prompt to look, not a verdict.'
  },
  landcover: {
    id: 'landcover',
    tier: 'national',
    label: 'NLCD 2021 land cover',
    url: 'https://www.mrlc.gov/geoserver/mrlc_display/wms',
    kind: 'wms',
    attribution: 'MRLC / USGS NLCD 2021',
    note: 'CONUS tree-canopy percentage is not published on this service, so woodedness is read from the land cover class at the parcel centroid (30m pixel).'
  },
  jurisdiction: {
    id: 'jurisdiction',
    tier: 'national',
    label: 'Census incorporated places',
    url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/0',
    kind: 'arcgis-layer',
    attribution: 'US Census Bureau TIGERweb'
  }
}

/** NLCD 2021 class codes, keyed by the PALETTE_INDEX that GetFeatureInfo returns. */
export const NLCD_CLASSES: Record<number, { label: string; wooded: boolean; buildable: boolean }> = {
  11: { label: 'Open water', wooded: false, buildable: false },
  12: { label: 'Perennial ice/snow', wooded: false, buildable: false },
  21: { label: 'Developed, open space', wooded: false, buildable: true },
  22: { label: 'Developed, low intensity', wooded: false, buildable: true },
  23: { label: 'Developed, medium intensity', wooded: false, buildable: true },
  24: { label: 'Developed, high intensity', wooded: false, buildable: true },
  31: { label: 'Barren land', wooded: false, buildable: true },
  41: { label: 'Deciduous forest', wooded: true, buildable: true },
  42: { label: 'Evergreen forest', wooded: true, buildable: true },
  43: { label: 'Mixed forest', wooded: true, buildable: true },
  52: { label: 'Shrub/scrub', wooded: false, buildable: true },
  71: { label: 'Grassland/herbaceous', wooded: false, buildable: true },
  81: { label: 'Pasture/hay', wooded: false, buildable: true },
  82: { label: 'Cultivated crops', wooded: false, buildable: true },
  90: { label: 'Woody wetlands', wooded: true, buildable: false },
  95: { label: 'Emergent herbaceous wetlands', wooded: false, buildable: false }
}

export const NLCD_LAYER = 'NLCD_2021_Land_Cover_L48'

// ------------------------------------------------------------------- state

export const STATE_SOURCES: SourceDef[] = [
  {
    id: 'karst',
    tier: 'state',
    state: 'IN',
    label: 'Indiana karst & sinkhole areas',
    url: 'https://maps.indiana.edu/arcgis/rest/services/Hydrology/Karst_Sinkhole_Areas/MapServer/0',
    kind: 'arcgis-layer',
    attribution: 'Indiana Geological & Water Survey',
    note: 'Southern Indiana — Harrison County especially — is heavily karst. Sinkhole-prone ground affects foundations and septic.'
  }
  // Kentucky karst is published by the Kentucky Geological Survey but is not
  // wired up yet; Jefferson County parcels will score with karst unknown, which
  // the coverage figure reports rather than hides.
]

// ------------------------------------------------------------------ county

export interface FieldMap {
  pin: string
  address?: string
  city?: string
  owner?: string
  landUse?: string
  assessed?: string
}

export interface ParcelSourceDef {
  kind: 'arcgis'
  url: string
  /** Server-side filter — how one statewide layer serves many counties. */
  where?: string
  fields: FieldMap
  /**
   * How to tell a parcel has no house on it.
   *  'class'   — the source publishes a land-use/class code we can read.
   *  'address' — it does not, so a parcel containing no address point is
   *              treated as vacant. Cruder, but it needs no extra source and
   *              works for any county that publishes address points.
   */
  vacancy: 'class' | 'address'
  /** Exact class codes meaning "no structure", for vacancy: 'class'. */
  vacantClasses?: string[]
}

export interface RegionDef {
  fips: string
  state: string
  name: string
  bounds: [number, number, number, number]
  parcels: ParcelSourceDef
  addressPoints?: { kind: 'arcgis'; url: string; where?: string }
  note?: string
}

const INDIANA_PARCELS = 'https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0'
const INDIANA_ADDRESSES = 'https://gisdata.in.gov/server/rest/services/Hosted/Address_Points_of_Indiana_Current/FeatureServer/0'

/**
 * Indiana DLGF class codes that mean "no building on it".
 *
 * Derived empirically rather than from the code book: cross-tabulating Floyd
 * County's 2024 assessment file (class code against improvement value) shows
 * exactly which classes are actually unbuilt.
 *
 *   100  vacant agricultural   997 parcels, 100% unbuilt, median 8.25 ac
 *   500  vacant residential  2,265 parcels,  99.9% unbuilt, median 0.24 ac
 *   501  vacant residential  2,145 parcels,  99.8% unbuilt, median 1.00 ac
 *   400  vacant commercial     457 parcels, 100% unbuilt, median 0.20 ac
 *   300  vacant industrial
 *
 * Two findings from that cross-tab are baked in here. First, matching on a
 * '500' PREFIX misses 501 entirely — over two thousand parcels in Floyd alone,
 * and the larger of the two residential vacant classes. Exact codes, not
 * prefixes. Second, classes 610-650 are also ~100% unbuilt but have a median
 * around a fifth of an acre: they are exempt parcels (government, church,
 * common area) and are not land anyone can buy, so they stay out.
 *
 * Note 101 is NOT here. It is agricultural land at a 12-acre median but 99.6%
 * of it has a dwelling — a working farm, not an empty field.
 */
const IN_VACANT_CLASSES = ['100', '300', '400', '500', '501']

const indianaCounty = (fips: string, name: string, bounds: [number, number, number, number], note?: string): RegionDef => ({
  fips,
  state: 'IN',
  name,
  bounds,
  parcels: {
    kind: 'arcgis',
    url: INDIANA_PARCELS,
    where: `county_fips='${fips}'`,
    fields: {
      pin: 'parcel_id',
      address: 'prop_add',
      city: 'prop_city',
      landUse: 'dlgf_prop_class_code'
    },
    vacancy: 'class',
    vacantClasses: IN_VACANT_CLASSES
  },
  addressPoints: { kind: 'arcgis', url: INDIANA_ADDRESSES, where: `county_fips='${fips}'` },
  note
})

/**
 * Seed regions.
 *
 * Indiana counties are one `indianaCounty()` line each because the state
 * publishes every county through a single endpoint — bounds below came from
 * that service's own reported extent rather than being eyeballed.
 *
 * Kentucky is not so lucky. There is no statewide parcel layer (only Webster
 * County is published on kygisserver), LOJIC's open parcel data covers
 * Jefferson alone, and its neighbouring-county services are imagery, not
 * parcels. Bullitt, Oldham, Spencer and the rest each live on their own PVA
 * portal and need individual wiring — which is also why the assessment-derived
 * features (land $/acre, absentee owners) are Indiana-only for now.
 *
 * Clark County (18019) is deliberately absent: excluded by request.
 */
export const SEED_REGIONS: RegionDef[] = [
  {
    fips: '21111',
    state: 'KY',
    name: 'Jefferson',
    bounds: [-85.95, 37.99, -85.39, 38.38],
    parcels: {
      kind: 'arcgis',
      url: 'https://gis.lojic.org/maps/rest/services/LojicSolutions/OpenDataPVA/MapServer/1',
      fields: { pin: 'PARCELID' },
      // LOJIC's open parcel layer publishes geometry and an id and nothing else
      // — no address, no land use, no assessed value. So vacancy here is
      // inferred from the address-point layer instead of read from a field.
      vacancy: 'address'
    },
    addressPoints: {
      kind: 'arcgis',
      url: 'https://gis.lojic.org/maps/rest/services/LojicSolutions/OpenDataAddresses/MapServer/0'
    },
    note: 'LOJIC publishes parcel geometry without attributes; vacancy is inferred from address points, so treat it as a hint rather than a fact.'
  },
  indianaCounty('18043', 'Floyd', [-86.033, 38.181, -85.761, 38.419]),
  indianaCounty('18061', 'Harrison', [-86.328, 37.959, -85.899, 38.423],
    'Corydon sits here. Heavily karst — the Indiana sinkhole layer matters more in this county than anywhere else in the search area.'),
  indianaCounty('18175', 'Washington', [-86.310, 38.418, -85.848, 38.784],
    'Salem. Rural, cheap, and still commutable to New Albany.'),
  indianaCounty('18143', 'Scott', [-85.888, 38.561, -85.570, 38.832],
    'Scottsburg. Flatter than the karst counties to the south.'),
  indianaCounty('18025', 'Crawford', [-86.681, 38.106, -86.246, 38.423],
    'Cheapest land in the search area and the most rugged — expect steep grades and heavy karst.')
  // Orange (18117) and Jackson (18071) are one line each if the search widens;
  // both are an hour-plus out, so they are left off rather than wired blind.
]

/**
 * Utility line-extension pricing.
 *
 * There is no public dataset of electric or water DISTRIBUTION lines anywhere in
 * the US — HIFLD publishes transmission only, which tells you nothing about
 * whether a meter can be set. So cost is modelled from the provider's published
 * extension tariff against a distance proxy, and these numbers are placeholders
 * to be replaced with figures read off the real tariff.
 */
export const SEED_UTILITIES: Array<{
  id: string; fips: string; kind: string; name: string
  base_fee: number; free_feet: number; cost_per_foot: number; source_url: string | null; note: string | null
}> = [
  { id: 'lge-electric-21111', fips: '21111', kind: 'electric', name: 'LG&E', base_fee: 0, free_feet: 300, cost_per_foot: 12, source_url: null, note: 'PLACEHOLDER RATE — replace with the LG&E line extension tariff.' },
  { id: 'duke-electric-18043', fips: '18043', kind: 'electric', name: 'Duke Energy Indiana', base_fee: 0, free_feet: 300, cost_per_foot: 14, source_url: null, note: 'PLACEHOLDER RATE — replace with the Duke Indiana extension policy.' },
  { id: 'harrison-remc-18061', fips: '18061', kind: 'electric', name: 'Harrison REMC', base_fee: 0, free_feet: 400, cost_per_foot: 10, source_url: null, note: 'PLACEHOLDER RATE — replace with the Harrison REMC extension policy.' },
  // Provider territory for these three is unconfirmed — rural counties are
  // usually split between an investor-owned utility and one or more RECs, and
  // the split does not follow county lines. Named generically on purpose rather
  // than guessing a provider and having the estimate look authoritative.
  { id: 'unknown-electric-18175', fips: '18175', kind: 'electric', name: 'Provider unconfirmed', base_fee: 0, free_feet: 300, cost_per_foot: 13, source_url: null, note: 'PLACEHOLDER — confirm which utility/REC serves the parcel before trusting any figure.' },
  { id: 'unknown-electric-18143', fips: '18143', kind: 'electric', name: 'Provider unconfirmed', base_fee: 0, free_feet: 300, cost_per_foot: 13, source_url: null, note: 'PLACEHOLDER — confirm which utility/REC serves the parcel before trusting any figure.' },
  { id: 'unknown-electric-18025', fips: '18025', kind: 'electric', name: 'Provider unconfirmed', base_fee: 0, free_feet: 400, cost_per_foot: 13, source_url: null, note: 'PLACEHOLDER — confirm which utility/REC serves the parcel before trusting any figure.' }
]

/** Every declared source, flattened, for the status panel. */
export function allSources(): SourceDef[] {
  return [...Object.values(NATIONAL), ...STATE_SOURCES]
}

export function karstSourceFor(state: string): SourceDef | undefined {
  return STATE_SOURCES.find((s) => s.id === 'karst' && s.state === state)
}
