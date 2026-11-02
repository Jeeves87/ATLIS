import { useCallback, useState } from 'react'
import { MapPin, Plus, Trash2, Loader2, Crosshair } from 'lucide-react'
import type { LandAnchor } from '../../types'

/**
 * The places a life is arranged around.
 *
 * Kept as an explicit, editable list rather than inferred from anything: only
 * the household knows which trips are non-negotiable and how long is too long,
 * and those tolerances are exactly what turn a generic distance into a verdict.
 */

const KINDS: Array<{ id: string; label: string; ideal: number; max: number; weight: number }> = [
  { id: 'work', label: 'Work', ideal: 25, max: 60, weight: 1.6 },
  { id: 'family', label: 'Family', ideal: 30, max: 90, weight: 0.8 },
  { id: 'school', label: 'School', ideal: 20, max: 45, weight: 1.0 },
  { id: 'other', label: 'Other', ideal: 20, max: 60, weight: 0.6 }
]

export default function AnchorPanel({ anchors, onChange, pickOnMap, picking }: {
  anchors: LandAnchor[]
  onChange: (anchors: LandAnchor[]) => void
  pickOnMap: (cb: (lat: number, lon: number) => void) => void
  picking: boolean
}): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState('work')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const preset = KINDS.find((k) => k.id === kind) ?? KINDS[0]

  const save = useCallback(async (lat: number, lon: number, matched?: string) => {
    const next = await window.atlis.land.saveAnchor({
      label: label.trim() || preset.label,
      kind, lat, lon,
      address: matched ?? address.trim() ?? null,
      weight: preset.weight,
      ideal_minutes: preset.ideal,
      max_minutes: preset.max
    })
    onChange(next)
    setAdding(false); setLabel(''); setAddress(''); setErr(null)
  }, [label, kind, address, preset, onChange])

  const addByAddress = useCallback(async () => {
    if (!address.trim()) return
    setBusy(true); setErr(null)
    try {
      const hit = await window.atlis.land.geocode(address.trim())
      if (!hit) { setErr('No match for that address'); return }
      await save(hit.lat, hit.lon, hit.matched)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [address, save])

  const remove = useCallback(async (id: string) => {
    onChange(await window.atlis.land.deleteAnchor(id))
  }, [onChange])

  const toggle = useCallback(async (a: LandAnchor) => {
    onChange(await window.atlis.land.saveAnchor({ ...a, active: a.active ? 0 : 1 }))
  }, [onChange])

  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-mist-500">
        <MapPin size={11} /> Your places
        <button
          onClick={() => setAdding((v) => !v)}
          className="ml-auto rounded p-0.5 text-mist-400 hover:bg-ink-700 hover:text-mist-100"
          title="Add a place"
        ><Plus size={12} /></button>
      </h3>

      {anchors.length === 0 && !adding && (
        <p className="mb-1.5 text-[10px] leading-snug text-mist-500">
          Add where you work, where your wife works, anywhere you go weekly. Until then, fit
          scoring has nothing to measure against and every parcel reads the same.
        </p>
      )}

      <div className="mb-1.5 flex flex-col gap-1">
        {anchors.map((a) => (
          <div key={a.id} className="group flex items-center gap-1.5 rounded border border-ink-600 bg-ink-800 px-1.5 py-1">
            <button
              onClick={() => void toggle(a)}
              title={a.active ? 'Counted in fit' : 'Ignored'}
              className={`h-2 w-2 shrink-0 rounded-full ${a.active ? 'bg-ok-400' : 'bg-ink-500'}`}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] text-mist-200">{a.label}</div>
              <div className="truncate text-[9px] text-mist-500">
                {a.kind} · ideal {a.ideal_minutes}m, limit {a.max_minutes}m
              </div>
            </div>
            <button
              onClick={() => void remove(a.id)}
              className="shrink-0 text-mist-500 opacity-0 transition-opacity hover:text-danger-400 group-hover:opacity-100"
            ><Trash2 size={11} /></button>
          </div>
        ))}
      </div>

      {adding && (
        <div className="flex flex-col gap-1 rounded border border-ink-600 bg-ink-800 p-1.5">
          <input
            value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. My work)"
            className="rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[11px] text-mist-100 outline-none placeholder:text-mist-500"
          />
          <div className="flex gap-1">
            {KINDS.map((k) => (
              <button
                key={k.id} onClick={() => setKind(k.id)}
                className={`flex-1 rounded px-1 py-0.5 text-[10px] ${
                  kind === k.id ? 'bg-volt-500/20 text-volt-400' : 'bg-ink-700 text-mist-400 hover:text-mist-100'
                }`}
              >{k.label}</button>
            ))}
          </div>
          <input
            value={address} onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addByAddress() }}
            placeholder="Street address…"
            className="rounded border border-ink-600 bg-ink-900 px-1.5 py-1 text-[11px] text-mist-100 outline-none placeholder:text-mist-500"
          />
          {err && <div className="text-[10px] text-danger-400">{err}</div>}
          <div className="flex gap-1">
            <button
              onClick={() => void addByAddress()} disabled={busy || !address.trim()}
              className="flex flex-1 items-center justify-center gap-1 rounded bg-volt-500/20 px-1.5 py-1 text-[10px] text-volt-400 hover:bg-volt-500/30 disabled:opacity-40"
            >
              {busy ? <Loader2 size={10} className="animate-spin" /> : <MapPin size={10} />} Find
            </button>
            <button
              onClick={() => pickOnMap((lat, lon) => void save(lat, lon))}
              className={`flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[10px] ${
                picking ? 'bg-pulse-400/25 text-pulse-400' : 'bg-ink-700 text-mist-400 hover:text-mist-100'
              }`}
            >
              <Crosshair size={10} /> {picking ? 'Click map…' : 'Pick on map'}
            </button>
          </div>
          <p className="text-[9px] leading-snug text-mist-500">
            Addresses are resolved by the US Census geocoder.
          </p>
        </div>
      )}
    </section>
  )
}
