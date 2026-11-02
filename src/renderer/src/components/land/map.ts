/**
 * Leaflet layer definitions for the land map.
 *
 * Leaflet rather than a GL library on purpose: every overlay here is raster, and
 * Leaflet fetches raster tiles with plain <img> tags. The renderer's CSP is
 * `default-src 'self'` with `img-src ... https:`, so image tiles load as-is
 * while a GL library's XHR tile loads would be blocked — and none of the
 * overlays need vector rendering anyway. It also keeps an idle map to a few
 * cached bitmaps instead of a live WebGL context.
 */
import L from 'leaflet'

/**
 * ArcGIS MapServer as a tile layer.
 *
 * Most public hazard layers are ArcGIS MapServers with no tile cache, but every
 * one of them exposes `export`, which renders an arbitrary bbox to a PNG. Wiring
 * that to Leaflet's tile grid gives a tiled overlay for FEMA, NWI and the state
 * karst services from one 20-line class instead of a dependency.
 */
const ArcGISLayer = L.TileLayer.extend({
  options: { opacity: 0.55, maxZoom: 19, crossOrigin: true },

  getTileUrl(coords: L.Coords): string {
    const map = (this as unknown as { _map: L.Map })._map
    const size = (this as unknown as { getTileSize(): L.Point }).getTileSize()
    const nw = map.unproject(coords.scaleBy(size), coords.z)
    const se = map.unproject(coords.add([1, 1] as unknown as L.Point).scaleBy(size), coords.z)
    // ArcGIS wants Web Mercator metres; project the tile's corners rather than
    // passing lat/lon, so the image lines up with Leaflet's own grid exactly.
    const a = L.Projection.SphericalMercator.project(nw)
    const b = L.Projection.SphericalMercator.project(se)
    const o = (this as unknown as { options: { url: string; layers: string } }).options
    const params = new URLSearchParams({
      bbox: [a.x, b.y, b.x, a.y].join(','),
      bboxSR: '3857',
      imageSR: '3857',
      size: `${size.x},${size.y}`,
      format: 'png32',
      transparent: 'true',
      dpi: '96',
      f: 'image'
    })
    if (o.layers) params.set('layers', `show:${o.layers}`)
    return `${o.url}/export?${params}`
  }
}) as unknown as new (opts: Record<string, unknown>) => L.TileLayer

export interface OverlayDef {
  id: string
  label: string
  hint: string
  attribution: string
  make: () => L.Layer
  defaultOn?: boolean
}

export const BASE_LAYERS: Record<string, { label: string; make: () => L.TileLayer }> = {
  street: {
    label: 'Street',
    make: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors'
    })
  },
  aerial: {
    label: 'Aerial',
    make: () => L.tileLayer(
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'USGS National Map' }
    )
  },
  topo: {
    label: 'Topo',
    make: () => L.tileLayer(
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'USGS National Map' }
    )
  }
}

export const OVERLAYS: OverlayDef[] = [
  {
    id: 'flood',
    label: 'Flood zones',
    hint: 'FEMA NFHL — blue is the 1% annual chance floodplain; the floodway inside it is effectively unbuildable.',
    attribution: 'FEMA',
    defaultOn: true,
    make: () => new ArcGISLayer({
      url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer',
      layers: '28',
      opacity: 0.5
    })
  },
  {
    id: 'slope',
    label: 'Terrain shading',
    hint: 'USGS 3DEP hillshade. Reads the lay of the land; the per-parcel slope number is the one to trust.',
    attribution: 'USGS 3DEP',
    make: () => L.tileLayer(
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, opacity: 0.6, attribution: 'USGS 3DEP' }
    )
  },
  {
    id: 'landcover',
    label: 'Land cover',
    hint: 'NLCD 2021. Greens are forest, yellows pasture and crops, reds developed.',
    attribution: 'MRLC / USGS',
    make: () => L.tileLayer.wms('https://www.mrlc.gov/geoserver/mrlc_display/wms', {
      layers: 'NLCD_2021_Land_Cover_L48',
      format: 'image/png',
      transparent: true,
      opacity: 0.55,
      attribution: 'MRLC NLCD 2021'
    })
  },
  {
    id: 'wetland',
    label: 'Wetlands',
    hint: 'USFWS National Wetlands Inventory — a separate permitting regime from the flood zone.',
    attribution: 'USFWS',
    make: () => new ArcGISLayer({
      url: 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer',
      layers: '0',
      opacity: 0.55
    })
  },
  {
    id: 'karst',
    label: 'Karst (IN)',
    hint: 'Indiana sinkhole-prone areas. Kentucky has no equivalent layer wired up — Jefferson parcels fall back to the soil survey naming karst.',
    attribution: 'Indiana Geological & Water Survey',
    make: () => new ArcGISLayer({
      url: 'https://maps.indiana.edu/arcgis/rest/services/Hydrology/Karst_Sinkhole_Areas/MapServer',
      layers: '0',
      opacity: 0.5
    })
  },
  {
    id: 'jurisdiction',
    label: 'City limits',
    hint: 'Census incorporated places. Outside them is county jurisdiction — usually the looser zoning.',
    attribution: 'US Census TIGERweb',
    make: () => new ArcGISLayer({
      url: 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer',
      layers: '0',
      opacity: 0.35
    })
  }
]

export const VERDICT_COLORS: Record<string, string> = {
  strong: '#34d399',
  workable: '#22d3ee',
  marginal: '#fb923c',
  avoid: '#f87171',
  unknown: '#525b70'
}

export const VERDICT_LABELS: Record<string, string> = {
  strong: 'Strong',
  workable: 'Workable',
  marginal: 'Marginal',
  avoid: 'Avoid',
  unknown: 'Not yet enriched'
}
