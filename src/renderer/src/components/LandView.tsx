import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  Mountain, Layers, RefreshCw, Download, Sparkles, X, Loader2,
  TriangleAlert, Info, Ruler, Droplets, Zap, CircleCheck, Landmark, MailQuestion,
  MapPin, Car, Compass, Route
} from 'lucide-react'
import type {
  LandParcelRow, LandParcelDetail, LandRegionStatus, LandJob, LandWeights, LandSourceCheck,
  LandAnchor, LandFitLeg
} from '../types'
import AnchorPanel from './land/AnchorPanel'
import { BASE_LAYERS, OVERLAYS, VERDICT_COLORS, VERDICT_LABELS } from './land/map'

/** Louisville / New Albany, centred on the river between the two states. */
const HOME: [number, number] = [38.28, -85.83]

const FIT_COLORS: Record<string, string> = {
  easy: '#34d399', workable: '#22d3ee', shift: '#fb923c', remote: '#f87171', unknown: '#525b70'
}
const FIT_LABELS: Record<string, string> = {
  easy: 'Fits your life', workable: 'Workable', shift: 'Lifestyle shift',
  remote: 'Remote living', unknown: 'No places set'
}
const mins = (n: number | null | undefined): string => (n == null ? '—' : `${Math.round(n)} min`)

const acres = (n: number | null | undefined): string => (n == null ? '—' : `${n.toFixed(2)} ac`)
const money = (n: number | null | undefined): string =>
  n == null ? '—' : `$${Math.round(n).toLocaleString()}`

export default function LandView(): React.JSX.Element {
  const mapEl = useRef<HTMLDivElement | null>(null)
  const map = useRef<L.Map | null>(null)
  const parcelLayer = useRef<L.LayerGroup | null>(null)
  const overlayRefs = useRef<Record<string, L.Layer>>({})

  const [regions, setRegions] = useState<LandRegionStatus[]>([])
  const [job, setJob] = useState<LandJob>({ running: false, kind: null, fips: null, message: '', pct: null })
  const [parcels, setParcels] = useState<LandParcelRow[]>([])
  const [selected, setSelected] = useState<LandParcelDetail | null>(null)
  const [weights, setWeights] = useState<LandWeights | null>(null)
  const [sources, setSources] = useState<LandSourceCheck[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [base, setBase] = useState<keyof typeof BASE_LAYERS>('street')
  const [activeOverlays, setActiveOverlays] = useState<string[]>(
    OVERLAYS.filter((o) => o.defaultOn).map((o) => o.id)
  )
  const [minAcres, setMinAcres] = useState(2)
  const [maxAcres, setMaxAcres] = useState(40)
  const [showPanel, setShowPanel] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [anchors, setAnchors] = useState<LandAnchor[]>([])
  const [picking, setPicking] = useState(false)
  const pickCb = useRef<((lat: number, lon: number) => void) | null>(null)
  const anchorLayer = useRef<L.LayerGroup | null>(null)

  const refreshRegions = useCallback(async () => {
    setRegions(await window.atlis.land.regions())
  }, [])

  // ---- parcels for the current viewport, refetched on move
  const loadParcels = useCallback(async () => {
    const m = map.current
    if (!m) return
    const b = m.getBounds()
    try {
      const rows = await window.atlis.land.parcels({
        minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth(),
        minAcres, maxAcres, limit: 2000
      })
      setParcels(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [minAcres, maxAcres])

  // ---- map bootstrap (once; the view unmounts when you navigate away)
  useEffect(() => {
    if (!mapEl.current || map.current) return
    const m = L.map(mapEl.current, {
      center: HOME,
      zoom: 11,
      zoomControl: true,
      // Canvas keeps a few thousand parcel dots to one element instead of one
      // SVG node each, which is the difference between a smooth pan and a stutter.
      preferCanvas: true,
      attributionControl: true
    })
    BASE_LAYERS[base].make().addTo(m)
    parcelLayer.current = L.layerGroup().addTo(m)
    anchorLayer.current = L.layerGroup().addTo(m)
    m.on('click', (e: L.LeafletMouseEvent) => {
      const cb = pickCb.current
      if (!cb) return
      pickCb.current = null
      setPicking(false)
      cb(e.latlng.lat, e.latlng.lng)
    })
    map.current = m

    let t: ReturnType<typeof setTimeout> | null = null
    const onMove = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void loadParcels(), 250)
    }
    m.on('moveend', onMove)
    void loadParcels()

    return () => {
      if (t) clearTimeout(t)
      m.off('moveend', onMove)
      m.remove()
      map.current = null
      parcelLayer.current = null
      anchorLayer.current = null
      overlayRefs.current = {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- base layer swap
  useEffect(() => {
    const m = map.current
    if (!m) return
    m.eachLayer((l) => { if (l instanceof L.TileLayer && !Object.values(overlayRefs.current).includes(l)) m.removeLayer(l) })
    BASE_LAYERS[base].make().addTo(m)
    // keep overlays above the freshly added base
    for (const l of Object.values(overlayRefs.current)) (l as L.TileLayer).bringToFront?.()
  }, [base])

  // ---- overlay toggles
  useEffect(() => {
    const m = map.current
    if (!m) return
    for (const def of OVERLAYS) {
      const on = activeOverlays.includes(def.id)
      const existing = overlayRefs.current[def.id]
      if (on && !existing) {
        const layer = def.make()
        layer.addTo(m)
        overlayRefs.current[def.id] = layer
      } else if (!on && existing) {
        m.removeLayer(existing)
        delete overlayRefs.current[def.id]
      }
    }
  }, [activeOverlays])

  // ---- draw parcels
  useEffect(() => {
    const group = parcelLayer.current
    if (!group) return
    group.clearLayers()
    for (const p of parcels) {
      const verdict = p.verdict ?? 'unknown'
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: p.acres && p.acres > 10 ? 7 : p.acres && p.acres > 4 ? 5.5 : 4,
        color: VERDICT_COLORS[verdict],
        weight: 1.5,
        fillColor: VERDICT_COLORS[verdict],
        fillOpacity: 0.55
      })
      marker.on('click', () => void openParcel(p.id))
      group.addLayer(marker)
    }
  }, [parcels])

  // ---- draw anchors
  useEffect(() => {
    const group = anchorLayer.current
    if (!group) return
    group.clearLayers()
    for (const a of anchors) {
      const marker = L.circleMarker([a.lat, a.lon], {
        radius: 8,
        color: a.active ? '#7c5cff' : '#525b70',
        weight: 3,
        fillColor: '#0b0d12',
        fillOpacity: 0.9
      })
      marker.bindTooltip(a.label, { direction: 'top' })
      group.addLayer(marker)
    }
  }, [anchors])

  const openParcel = useCallback(async (id: string) => {
    try {
      setSelected(await window.atlis.land.parcel(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // ---- initial load + progress subscription
  useEffect(() => {
    void refreshRegions()
    void window.atlis.land.weights().then(setWeights)
    void window.atlis.land.job().then(setJob)
    void window.atlis.land.anchors().then(setAnchors)
    const off = window.atlis.land.onProgress((p) => {
      const state = p as LandJob
      setJob(state)
      if (!state.running) { void refreshRegions(); void loadParcels() }
    })
    return off
  }, [refreshRegions, loadParcels])

  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      await refreshRegions()
      await loadParcels()
    } catch (err) {
      setError(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [refreshRegions, loadParcels])

  const verifySources = useCallback(async () => {
    setChecking(true)
    try { setSources(await window.atlis.land.verifySources()) } finally { setChecking(false) }
  }, [])

  const counts = useMemo(() => {
    const out: Record<string, number> = { strong: 0, workable: 0, marginal: 0, avoid: 0, unknown: 0 }
    for (const p of parcels) out[p.verdict ?? 'unknown'] = (out[p.verdict ?? 'unknown'] ?? 0) + 1
    return out
  }, [parcels])

  return (
    <div className="flex min-h-0 flex-1">
      {/* ---------------- control panel ---------------- */}
      {showPanel && (
        <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-ink-600 bg-ink-850 p-3">
          <header className="flex items-center gap-2">
            <Mountain size={16} className="text-volt-400" />
            <h2 className="text-sm font-semibold">Land</h2>
            <span className="ml-auto text-[11px] text-mist-500">{parcels.length} in view</span>
          </header>

          {job.running && (
            <div className="rounded-md border border-volt-500/30 bg-volt-500/10 p-2 text-[11px]">
              <div className="flex items-center gap-1.5 text-volt-400">
                <Loader2 size={12} className="animate-spin" />
                <span className="truncate">{job.message || 'working…'}</span>
              </div>
              {job.pct != null && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-700">
                  <div className="h-full bg-volt-500 transition-all" style={{ width: `${Math.round(job.pct * 100)}%` }} />
                </div>
              )}
              <button
                onClick={() => void window.atlis.land.cancel()}
                className="mt-1.5 text-[10px] text-mist-400 underline hover:text-mist-100"
              >cancel</button>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-danger-400/30 bg-danger-400/10 p-2 text-[11px] text-danger-400">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
              <button onClick={() => setError(null)} className="ml-auto shrink-0"><X size={12} /></button>
            </div>
          )}

          {/* regions */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-mist-500">Counties</h3>
            <div className="flex flex-col gap-1.5">
              {regions.map((r) => (
                <RegionCard
                  key={r.fips}
                  region={r}
                  busy={job.running}
                  onIngest={() => void run('ingest', () => window.atlis.land.ingest(r.fips))}
                  onCandidates={() => void run('filter', async () => {
                    await window.atlis.land.markCandidates(r.fips, { minAcres, maxAcres, vacantOnly: true })
                  })}
                  onEnrich={() => void run('enrich', () => window.atlis.land.enrich(r.fips, { limit: 250 }))}
                  onAssess={() => void run('assess', () => window.atlis.land.assess(r.fips, 2024))}
                  onFit={() => void run('fit', () => window.atlis.land.fitRegion(r.fips))}
                />
              ))}
            </div>
          </section>

          {/* size filter */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-mist-500">Size</h3>
            <div className="flex items-center gap-2 text-[11px]">
              <NumField label="min ac" value={minAcres} onChange={setMinAcres} />
              <NumField label="max ac" value={maxAcres} onChange={setMaxAcres} />
            </div>
            <p className="mt-1 text-[10px] leading-snug text-mist-500">
              Changing this filters the map immediately. Re-run “candidates” on a county to change what gets enriched.
            </p>
          </section>

          <AnchorPanel
            anchors={anchors}
            onChange={(next) => { setAnchors(next); void loadParcels() }}
            picking={picking}
            pickOnMap={(cb) => { pickCb.current = cb; setPicking(true) }}
          />

          {/* layers */}
          <section>
            <h3 className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-mist-500">
              <Layers size={11} /> Layers
            </h3>
            <div className="mb-2 flex gap-1">
              {Object.entries(BASE_LAYERS).map(([id, b]) => (
                <button
                  key={id}
                  onClick={() => setBase(id as keyof typeof BASE_LAYERS)}
                  className={`flex-1 rounded px-2 py-1 text-[11px] transition-colors ${
                    base === id ? 'bg-volt-500/20 text-volt-400' : 'bg-ink-700 text-mist-400 hover:text-mist-100'
                  }`}
                >{b.label}</button>
              ))}
            </div>
            <div className="flex flex-col gap-1">
              {OVERLAYS.map((o) => (
                <label key={o.id} title={o.hint} className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-ink-700">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-volt-500"
                    checked={activeOverlays.includes(o.id)}
                    onChange={(e) => setActiveOverlays((prev) =>
                      e.target.checked ? [...prev, o.id] : prev.filter((x) => x !== o.id))}
                  />
                  <span className="min-w-0">
                    <span className="block text-mist-300">{o.label}</span>
                    <span className="block text-[10px] leading-snug text-mist-500">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          {/* legend */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-mist-500">Verdict</h3>
            <div className="flex flex-col gap-0.5">
              {Object.entries(VERDICT_LABELS).map(([k, label]) => (
                <div key={k} className="flex items-center gap-2 text-[11px]">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: VERDICT_COLORS[k] }} />
                  <span className="text-mist-400">{label}</span>
                  <span className="ml-auto text-mist-500">{counts[k] ?? 0}</span>
                </div>
              ))}
            </div>
          </section>

          {weights && <WeightPanel weights={weights} onSave={async (w) => {
            setWeights(await window.atlis.land.setWeights(w))
            for (const r of regions) if (r.candidate_count > 0) await window.atlis.land.rescore(r.fips)
            await loadParcels()
          }} />}

          {/* source health */}
          <section className="mt-auto">
            <button
              onClick={() => void verifySources()}
              disabled={checking}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-ink-600 bg-ink-700 px-2 py-1.5 text-[11px] text-mist-300 hover:text-mist-100 disabled:opacity-50"
            >
              {checking ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              Check data sources
            </button>
            {sources && (
              <div className="mt-1.5 flex flex-col gap-0.5">
                {sources.map((s) => (
                  <div key={s.id} title={s.detail} className="flex items-center gap-1.5 text-[10px]">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.ok ? 'bg-ok-400' : 'bg-danger-400'}`} />
                    <span className="truncate text-mist-400">{s.label}</span>
                    <span className="ml-auto shrink-0 text-mist-500">{s.tier}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      )}

      {/* ---------------- map ---------------- */}
      <div className="relative min-w-0 flex-1">
        <div ref={mapEl} className="h-full w-full bg-ink-900" />
        <button
          onClick={() => setShowPanel((v) => !v)}
          className="absolute left-2 top-2 z-[500] rounded-md border border-ink-600 bg-ink-850/90 px-2 py-1 text-[11px] text-mist-300 backdrop-blur hover:text-mist-100"
        >{showPanel ? '‹ hide' : '› panel'}</button>
      </div>

      {/* ---------------- detail ---------------- */}
      {selected && <ParcelDetail detail={selected} anchors={anchors} onClose={() => setSelected(null)} />}
    </div>
  )
}

// ------------------------------------------------------------------ pieces

function NumField({ label, value, onChange }: {
  label: string; value: number; onChange: (n: number) => void
}): React.JSX.Element {
  return (
    <label className="flex flex-1 items-center gap-1 rounded border border-ink-600 bg-ink-800 px-1.5 py-1">
      <span className="text-[10px] text-mist-500">{label}</span>
      <input
        type="number"
        value={value}
        min={0}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="w-full min-w-0 bg-transparent text-right text-mist-100 outline-none"
      />
    </label>
  )
}

function RegionCard({ region, busy, onIngest, onCandidates, onEnrich, onAssess, onFit }: {
  region: LandRegionStatus
  busy: boolean
  onIngest: () => void
  onCandidates: () => void
  onEnrich: () => void
  onAssess: () => void
  onFit: () => void
}): React.JSX.Element {
  const enriched = Object.values(region.enriched).reduce((a, b) => a + b, 0)
  const target = region.candidate_count * 3 // terrain + soil + cover
  return (
    <div className="rounded-md border border-ink-600 bg-ink-800 p-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] font-medium text-mist-100">{region.name}</span>
        <span className="text-[10px] text-mist-500">{region.state}</span>
        {region.status === 'error' && <TriangleAlert size={11} className="text-danger-400" />}
        {region.status === 'ready' && region.parcel_count > 0 && <CircleCheck size={11} className="text-ok-400" />}
      </div>
      <div className="mt-1 text-[10px] leading-relaxed text-mist-500">
        {region.parcel_count.toLocaleString()} parcels · {region.candidate_count.toLocaleString()} candidates
        {enriched > 0 && ` · ${enriched.toLocaleString()}/${target.toLocaleString()} facts`}
        {region.assessments?.total > 0 && (
          <>
            <br />
            {region.assessments.total.toLocaleString()} assessed ·{' '}
            <span className="text-pulse-400">{region.assessments.absentee.toLocaleString()} absentee owners</span>
          </>
        )}
      </div>
      {region.note && <div className="mt-1 text-[10px] leading-snug text-ember-400">{region.note}</div>}
      <div className="mt-1.5 flex gap-1">
        <MiniBtn onClick={onIngest} disabled={busy} icon={Download} label="parcels" />
        <MiniBtn onClick={onCandidates} disabled={busy || !region.parcel_count} icon={Ruler} label="filter" />
        <MiniBtn onClick={onEnrich} disabled={busy || !region.candidate_count} icon={Sparkles} label="enrich" />
        {region.state === 'IN' && (
          <MiniBtn onClick={onAssess} disabled={busy || !region.parcel_count} icon={Landmark} label="values" />
        )}
        <MiniBtn onClick={onFit} disabled={busy || !region.candidate_count} icon={Compass} label="fit" />
      </div>
    </div>
  )
}

function MiniBtn({ onClick, disabled, icon: Icon, label }: {
  onClick: () => void; disabled?: boolean; icon: typeof Download; label: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex flex-1 items-center justify-center gap-1 rounded bg-ink-700 px-1.5 py-1 text-[10px] text-mist-400 transition-colors hover:bg-ink-600 hover:text-mist-100 disabled:opacity-40 disabled:hover:bg-ink-700"
    >
      <Icon size={10} />{label}
    </button>
  )
}

function WeightPanel({ weights, onSave }: {
  weights: LandWeights; onSave: (w: Partial<LandWeights>) => Promise<void>
}): React.JSX.Element {
  const [local, setLocal] = useState(weights)
  const [open, setOpen] = useState(false)
  useEffect(() => setLocal(weights), [weights])
  return (
    <section>
      <button
        onClick={() => setOpen((v) => !v)}
        className="mb-1 flex w-full items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-mist-500 hover:text-mist-300"
      >
        Priorities <span className="ml-auto text-[10px]">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1">
          {(Object.keys(local) as Array<keyof LandWeights>).map((k) => (
            <label key={k} className="flex items-center gap-2 text-[10px]">
              <span className="w-14 shrink-0 text-mist-400">{k}</span>
              <input
                type="range" min={0} max={2} step={0.1} value={local[k]}
                onChange={(e) => setLocal({ ...local, [k]: Number(e.target.value) })}
                className="min-w-0 flex-1 accent-volt-500"
              />
              <span className="w-6 shrink-0 text-right text-mist-500">{local[k].toFixed(1)}</span>
            </label>
          ))}
          <button
            onClick={() => void onSave(local)}
            className="mt-1 rounded bg-volt-500/20 px-2 py-1 text-[10px] text-volt-400 hover:bg-volt-500/30"
          >Apply & re-rank</button>
          <p className="text-[10px] leading-snug text-mist-500">
            Re-ranking is local arithmetic over cached facts — it refetches nothing.
          </p>
        </div>
      )}
    </section>
  )
}

function ParcelDetail({ detail, anchors, onClose }: {
  detail: LandParcelDetail; anchors: LandAnchor[]; onClose: () => void
}): React.JSX.Element {
  const { parcel, score, facts, region, assessment, comparable, fit, lifestyleNote } = detail
  const subs = useMemo(() => {
    if (!score?.subs) return [] as Array<[string, { score: number; weight: number; why: string }]>
    try { return Object.entries(JSON.parse(score.subs)) as Array<[string, { score: number; weight: number; why: string }]> }
    catch { return [] }
  }, [score])
  const flags = useMemo(() => {
    if (!score?.flags) return [] as string[]
    try { return JSON.parse(score.flags) as string[] } catch { return [] }
  }, [score])

  const terrain = facts.terrain as { meanSlopePct?: number; maxSlopeDeg?: number } | undefined
  const utility = facts.utility as { nearestAddressFt?: number | null; basis?: string } | undefined
  const soil = facts.soil as { mapUnit?: string; septic?: string } | undefined
  const verdict = score?.verdict ?? 'unknown'
  // Prefer the assessor's deeded acreage over our computed figure when pricing
  // per acre — it is the number the value was actually assessed against.
  const acresForValue = assessment?.deeded_acres ?? parcel.acres
  const perAcre = assessment?.av_land != null && acresForValue && acresForValue > 0
    ? assessment.av_land / acresForValue
    : null

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-ink-600 bg-ink-850 p-3">
      <header className="mb-2 flex items-start gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: VERDICT_COLORS[verdict] }} />
            <span className="text-sm font-semibold text-mist-100">{VERDICT_LABELS[verdict]}</span>
            {score && <span className="text-[11px] text-mist-500">{(score.total * 100).toFixed(0)}</span>}
            {fit.verdict !== 'unknown' && (
              <span className="ml-1 flex items-center gap-1 border-l border-ink-600 pl-1.5" title={`Life fit: ${FIT_LABELS[fit.verdict]}`}>
                <Car size={10} style={{ color: FIT_COLORS[fit.verdict] }} />
                <span className="text-[11px] text-mist-500">{(fit.score * 100).toFixed(0)}</span>
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-mist-400">
            {parcel.address || parcel.pin}
          </div>
          <div className="text-[10px] text-mist-500">{region.name} County, {region.state} · {acres(parcel.acres)}</div>
        </div>
        <button onClick={onClose} className="ml-auto shrink-0 text-mist-500 hover:text-mist-100"><X size={14} /></button>
      </header>

      {score && score.coverage < 0.6 && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md border border-ember-400/30 bg-ember-400/10 p-2 text-[10px] text-ember-400">
          <Info size={11} className="mt-0.5 shrink-0" />
          <span>
            Only {(score.coverage * 100).toFixed(0)}% of the weighted factors are known for this parcel.
            Run enrichment on {region.name} before trusting the ranking.
          </span>
        </div>
      )}

      {flags.length > 0 && (
        <section className="mb-2 flex flex-col gap-1">
          {flags.map((f, i) => (
            <div key={i} className="flex items-start gap-1.5 rounded border border-danger-400/25 bg-danger-400/5 p-1.5 text-[10px] leading-snug text-danger-400">
              <TriangleAlert size={10} className="mt-0.5 shrink-0" />
              <span>{f}</span>
            </div>
          ))}
        </section>
      )}

      <section className="mb-2 grid grid-cols-3 gap-1.5">
        <Stat icon={Ruler} label="Grade" value={terrain?.meanSlopePct != null ? `${terrain.meanSlopePct.toFixed(1)}%` : '—'} />
        <Stat icon={Droplets} label="Septic" value={soil?.septic ?? '—'} />
        <Stat icon={Zap} label="To power" value={utility?.nearestAddressFt != null ? `${utility.nearestAddressFt} ft` : '—'} />
      </section>

      {(score?.hookup_low != null || score?.hookup_high != null) && (
        <section className="mb-2 rounded-md border border-ink-600 bg-ink-800 p-2">
          <div className="text-[10px] uppercase tracking-wide text-mist-500">Electric hookup, rough</div>
          <div className="text-sm text-mist-100">{money(score.hookup_low)} – {money(score.hookup_high)}</div>
          <p className="mt-0.5 text-[10px] leading-snug text-mist-500">
            {utility?.basis ?? ''} Distance is proxied from the nearest address point, and the rate is a
            placeholder until the real tariff is entered — treat this as an order of magnitude, not a quote.
          </p>
        </section>
      )}

      {subs.length > 0 && (
        <section className="mb-2">
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-mist-500">Factors</h4>
          <div className="flex flex-col gap-1">
            {subs.sort((a, b) => a[1].score - b[1].score).map(([key, s]) => (
              <div key={key} className="text-[10px]">
                <div className="flex items-center gap-1.5">
                  <span className="w-12 shrink-0 capitalize text-mist-400">{key}</span>
                  <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ink-700">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.round(s.score * 100)}%`,
                        background: s.score > 0.7 ? '#34d399' : s.score > 0.4 ? '#fb923c' : '#f87171'
                      }}
                    />
                  </div>
                  <span className="w-5 shrink-0 text-right text-mist-500">×{s.weight.toFixed(1)}</span>
                </div>
                <div className="ml-[3.4rem] leading-snug text-mist-500">{s.why}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {fit.verdict !== 'unknown' && (
        <section className="mb-2 rounded-md border border-ink-600 bg-ink-800 p-2">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-mist-500">
            <Car size={9} /> Life fit
            <span className="ml-auto flex items-center gap-1 normal-case tracking-normal">
              <span className="h-2 w-2 rounded-full" style={{ background: FIT_COLORS[fit.verdict] }} />
              <span className="text-[11px] text-mist-200">{FIT_LABELS[fit.verdict]}</span>
              <span className="text-mist-500">{(fit.score * 100).toFixed(0)}</span>
            </span>
          </div>
          {fit.commuteMinutes != null && (
            <div className="mb-1 text-[11px] text-mist-300">
              Longest work commute <span className="text-mist-100">{mins(fit.commuteMinutes)}</span>
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {fit.legs
              .slice()
              .sort((a, b) => (a.score ?? 2) - (b.score ?? 2))
              .map((leg) => leg.group === 'anchor'
                ? <AnchorLeg key={leg.group + leg.id} leg={leg} parcel={parcel} anchor={anchors.find((a) => a.id === leg.id)} />
                : <FitRow key={leg.group + leg.id} leg={leg} />)}
          </div>
          <p className="mt-1 text-[10px] leading-snug text-mist-500">
            Times are estimated (~7% mean error, worse on winding back roads) — good for ranking,
            not for promising a commute. Click any of your places above to fetch the real driving
            route. Amenities come from OpenStreetMap, whose rural coverage is patchy, so
            “none mapped” means unknown rather than absent.
          </p>
        </section>
      )}

      {lifestyleNote && (
        <section className="mb-2 flex items-start gap-1.5 rounded-md border border-pulse-400/30 bg-pulse-400/10 p-2 text-[10px] leading-snug text-pulse-400">
          <Route size={11} className="mt-0.5 shrink-0" />
          <span>{lifestyleNote}</span>
        </section>
      )}

      {assessment && (
        <section className="mb-2 rounded-md border border-ink-600 bg-ink-800 p-2">
          <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-mist-500">
            <Landmark size={9} /> Assessed value {assessment.assessment_year ?? ''}
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
            <span className="text-mist-400">Land</span>
            <span className="text-right text-mist-100">{money(assessment.av_land)}</span>
            <span className="text-mist-400">Improvements</span>
            <span className="text-right text-mist-100">{money(assessment.av_improvement)}</span>
            {perAcre != null && (
              <>
                <span className="text-mist-400">Land $/acre</span>
                <span className="text-right font-medium text-mist-100">{money(perAcre)}</span>
              </>
            )}
          </div>
          {comparable?.median != null && perAcre != null && (
            <div className="mt-1.5 border-t border-ink-600 pt-1.5 text-[10px] leading-snug">
              <span className="text-mist-500">Within ~3 miles, median assessed land is </span>
              <span className="text-mist-300">{money(comparable.median)}/ac</span>
              <span className="text-mist-500"> ({money(comparable.p25)}–{money(comparable.p75)}, n={comparable.samples.toLocaleString()}).</span>{' '}
              <span className={perAcre < (comparable.median ?? 0) ? 'text-ok-400' : 'text-ember-400'}>
                This parcel is assessed {Math.abs(Math.round((perAcre / (comparable.median || 1) - 1) * 100))}%{' '}
                {perAcre < (comparable.median ?? 0) ? 'below' : 'above'} that.
              </span>
            </div>
          )}
          <p className="mt-1 text-[10px] leading-snug text-mist-500">
            Assessed value is not market value — it lags and runs conservative. Useful as a relative signal, not an appraisal.
          </p>
        </section>
      )}

      {assessment?.owner_name && (
        <section className="mb-2 rounded-md border border-ink-600 bg-ink-800 p-2 text-[10px] leading-snug">
          <div className="mb-0.5 flex items-center gap-1 uppercase tracking-wide text-mist-500">
            <MailQuestion size={9} /> Owner
            {assessment.absentee === 1 && (
              <span className="ml-auto rounded bg-pulse-400/15 px-1 text-[9px] text-pulse-400">absentee</span>
            )}
          </div>
          <div className="text-mist-300">{assessment.owner_name}</div>
          <div className="text-mist-500">
            {[assessment.owner_street, assessment.owner_city, assessment.owner_state, assessment.owner_zip]
              .filter(Boolean).join(', ')}
          </div>
          {assessment.absentee === 1 && (
            <p className="mt-1 text-mist-500">
              Mailing address is not the property's city — the owner may not be living on this land.
            </p>
          )}
        </section>
      )}

      {soil?.mapUnit && (
        <section className="mb-2 text-[10px] leading-snug text-mist-500">
          <span className="text-mist-400">Soil:</span> {soil.mapUnit}
        </section>
      )}

      {region.note && (
        <p className="mt-auto pt-2 text-[10px] leading-snug text-mist-500">{region.note}</p>
      )}
    </aside>
  )
}

/**
 * Anchor legs can be checked against a real road route on demand. The estimate
 * is for ranking; this is for deciding.
 */
function AnchorLeg({ leg, parcel, anchor }: {
  leg: LandFitLeg
  parcel: { lat: number; lon: number }
  anchor: LandAnchor | undefined
}): React.JSX.Element {
  const [exact, setExact] = useState<{ minutes: number; km: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const check = useCallback(async () => {
    if (!anchor) return
    setBusy(true)
    try {
      setExact(await window.atlis.land.route(
        { lon: parcel.lon, lat: parcel.lat },
        { lon: anchor.lon, lat: anchor.lat }
      ))
    } finally { setBusy(false) }
  }, [anchor, parcel])

  return (
    <div className="text-[10px]" title={leg.detail}>
      <div className="flex items-center gap-1.5">
        <span className="w-20 shrink-0 truncate text-mist-400">{leg.label}</span>
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ink-700">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.round((leg.score ?? 0) * 100)}%`,
              background: (leg.score ?? 0) > 0.7 ? '#34d399' : (leg.score ?? 0) > 0.4 ? '#fb923c' : '#f87171'
            }}
          />
        </div>
        <button
          onClick={() => void check()}
          disabled={busy || !anchor}
          title="Check the real driving route"
          className="w-14 shrink-0 text-right text-mist-300 hover:text-volt-400 disabled:hover:text-mist-300"
        >
          {busy ? '…' : exact ? `${Math.round(exact.minutes)} min` : `~${mins(leg.minutes)}`}
        </button>
      </div>
      {exact && (
        <div className="ml-[5.4rem] text-[9px] text-mist-500">
          actual route {(exact.km * 0.621).toFixed(0)} mi — estimate was {mins(leg.minutes)}
        </div>
      )}
    </div>
  )
}

function FitRow({ leg }: { leg: LandFitLeg }): React.JSX.Element {
  const unknown = leg.score == null
  return (
    <div className="text-[10px]" title={leg.detail}>
      <div className="flex items-center gap-1.5">
        <span className="w-20 shrink-0 truncate text-mist-400">{leg.label}</span>
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ink-700">
          {!unknown && (
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.round((leg.score ?? 0) * 100)}%`,
                background: (leg.score ?? 0) > 0.7 ? '#34d399' : (leg.score ?? 0) > 0.4 ? '#fb923c' : '#f87171'
              }}
            />
          )}
        </div>
        <span className={`w-12 shrink-0 text-right ${unknown ? 'text-mist-500' : 'text-mist-300'}`}>
          {unknown ? 'unknown' : mins(leg.minutes)}
        </span>
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, value }: {
  icon: typeof Ruler; label: string; value: string
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-ink-600 bg-ink-800 p-1.5">
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-mist-500">
        <Icon size={9} />{label}
      </div>
      <div className="mt-0.5 truncate text-[12px] capitalize text-mist-100">{value}</div>
    </div>
  )
}
