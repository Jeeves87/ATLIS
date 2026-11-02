import { useEffect, useRef, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { Pencil, Trash2, ImagePlus, X, Sparkles, Loader2, Flame, TrendingUp, PenLine } from 'lucide-react'
import type { VaultItem, VaultValuation, ImageAttachment } from '../../types'
import ProductThumb, { ImageZoom } from '../mtg/ProductThumb'
import { imageFor, type ImageRef } from '../../lib/mtgImages'

const mediaUrl = (a: ImageAttachment) => `atlis-media://media/${a.filename}`
const money = (v: number | null | undefined) =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const logField =
  'w-full min-w-0 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-[11.5px] text-mist-100 placeholder:text-mist-500 focus:border-pulse-400 focus:outline-none'

/**
 * Right-hand detail panel: photos, attributes, the item's valuation history
 * (melt + market lines over time), and the Appraise action that hands the item
 * to the agent for comp research.
 */
export default function ItemDetail({
  item, onEdit, onDelete, onAppraise, appraising, onChanged
}: {
  item: VaultItem
  onEdit: () => void
  onDelete: () => void
  onAppraise: () => void
  appraising: boolean
  onChanged: () => void
}) {
  const [valuations, setValuations] = useState<VaultValuation[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [lightbox, setLightbox] = useState<ImageAttachment | null>(null)
  const [zoom, setZoom] = useState<ImageRef | null>(null)
  const catalog = imageFor({ extSource: item.ext_source, extId: item.ext_id }, 'normal')
  const fileRef = useRef<HTMLInputElement>(null)
  // manual value entry — skip the agent and just write a number down
  const [logOpen, setLogOpen] = useState(false)
  const [logMid, setLogMid] = useState('')
  const [logLow, setLogLow] = useState('')
  const [logHigh, setLogHigh] = useState('')
  const [logNotes, setLogNotes] = useState('')
  const [logSaving, setLogSaving] = useState(false)

  useEffect(() => {
    setConfirmDelete(false)
    setLightbox(null)
    setZoom(null)
    setLogOpen(false)
    window.atlis.vault.valuations(item.id).then(setValuations)
    // valuations are appended by agent runs + melt refreshes, not item edits —
    // listen for vault changes directly so the log updates live
    const off = window.atlis.vault.onChanged(() => window.atlis.vault.valuations(item.id).then(setValuations))
    return off
  }, [item.id, item.updated_at])

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      const buf = await file.arrayBuffer()
      let binary = ''
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      await window.atlis.vault.addPhoto(item.id, { dataBase64: btoa(binary), mime: file.type, name: file.name })
    }
    onChanged()
  }

  const logMidNum = parseFloat(logMid)
  const saveManualValue = async () => {
    if (!Number.isFinite(logMidNum) || logSaving) return
    const low = parseFloat(logLow)
    const high = parseFloat(logHigh)
    setLogSaving(true)
    try {
      await window.atlis.vault.addValuation({
        item_id: item.id,
        value_mid: logMidNum,
        value_low: Number.isFinite(low) ? low : null,
        value_high: Number.isFinite(high) ? high : null,
        notes: logNotes.trim() || null
      })
      setLogOpen(false)
      setLogMid(''); setLogLow(''); setLogHigh(''); setLogNotes('')
      onChanged()
    } finally {
      setLogSaving(false)
    }
  }

  const removePhoto = async (att: ImageAttachment) => {
    setLightbox(null)
    await window.atlis.vault.removePhoto(item.id, att.id)
    onChanged()
  }

  // one point per valuation, melt and market as separate connectNulls series
  const chartData = valuations.map((v) => ({
    t: v.created_at,
    date: new Date(v.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    melt: v.kind === 'melt' ? v.value_mid : null,
    market: v.kind !== 'melt' ? v.value_mid : null
  }))
  const marketHistory = valuations.filter((v) => v.kind !== 'melt').slice().reverse()
  const latestMelt = [...valuations].reverse().find((v) => v.kind === 'melt')

  return (
    <div className="flex w-[380px] shrink-0 flex-col overflow-y-auto border-l border-ink-600 bg-ink-850/60">
      {/* header + actions */}
      <div className="border-b border-ink-600 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-mist-100">{item.name}</div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-mist-500">
              {[item.category, item.year, item.maker, item.grade, item.quantity > 1 ? `×${item.quantity}` : '']
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button onClick={onEdit} title="Edit" className="rounded p-1.5 text-mist-500 hover:bg-ink-700 hover:text-mist-100">
              <Pencil size={13} />
            </button>
            <button
              onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
              title="Delete"
              className={`rounded p-1.5 ${confirmDelete ? 'bg-danger-400/15 text-danger-400' : 'text-mist-500 hover:bg-ink-700 hover:text-danger-400'}`}
            >
              {confirmDelete ? <span className="px-0.5 text-[10px] font-semibold">Sure?</span> : <Trash2 size={13} />}
            </button>
          </div>
        </div>

        <div className="mt-3 flex gap-1.5">
          <button
            onClick={onAppraise}
            disabled={appraising}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-volt-500/50 bg-volt-500/15 px-3 py-1.5 text-[12px] font-medium text-volt-400 hover:bg-volt-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {appraising ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {appraising ? 'Starting appraisal…' : 'Appraise — research market value'}
          </button>
          <button
            onClick={() => setLogOpen((o) => !o)}
            title="Log a value yourself — no agent"
            className={`flex items-center justify-center rounded-md border px-2.5 py-1.5 ${
              logOpen ? 'border-pulse-400/50 bg-pulse-400/15 text-pulse-400' : 'border-ink-600 text-mist-400 hover:border-pulse-400 hover:text-pulse-400'
            }`}
          >
            <PenLine size={13} />
          </button>
        </div>

        {logOpen && (
          <div
            className="mt-2 rounded-md border border-ink-600 bg-ink-900/60 p-2.5"
            onKeyDown={(e) => { if (e.key === 'Enter') saveManualValue() }}
          >
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-mist-500">
              Log market value manually (USD, whole quantity)
            </div>
            <div className="flex gap-1.5">
              <input autoFocus inputMode="decimal" value={logMid} onChange={(e) => setLogMid(e.target.value)} placeholder="Value" className={logField} />
              <input inputMode="decimal" value={logLow} onChange={(e) => setLogLow(e.target.value)} placeholder="Low" className={logField} />
              <input inputMode="decimal" value={logHigh} onChange={(e) => setLogHigh(e.target.value)} placeholder="High" className={logField} />
            </div>
            <input
              value={logNotes}
              onChange={(e) => setLogNotes(e.target.value)}
              placeholder="Where this number came from (optional)"
              className={`mt-1.5 ${logField}`}
            />
            <div className="mt-2 flex justify-end gap-1.5">
              <button onClick={() => setLogOpen(false)} className="rounded-md border border-ink-600 px-2.5 py-1 text-[11px] text-mist-400 hover:bg-ink-700">
                Cancel
              </button>
              <button
                onClick={saveManualValue}
                disabled={!Number.isFinite(logMidNum) || logSaving}
                className="flex items-center gap-1 rounded-md border border-pulse-400/50 bg-pulse-400/15 px-2.5 py-1 text-[11px] font-medium text-pulse-400 hover:bg-pulse-400/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {logSaving && <Loader2 size={11} className="animate-spin" />} Save
              </button>
            </div>
          </div>
        )}
      </div>

      {/* catalog image — only for items with a price feed (Magic singles and
          sealed). It is the product's picture, not a photo of your copy, so it
          sits apart from Photos and is labelled that way. */}
      {catalog && (
        <div className="border-b border-ink-600 px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-mist-500">Catalog image</span>
            <span className="font-mono text-[9.5px] text-mist-500">
              {item.ext_source === 'tcgplayer' ? 'TCGplayer' : 'Scryfall'}
            </span>
          </div>
          <div className={`mx-auto ${catalog.shape === 'card' ? 'max-w-[170px]' : 'max-w-[200px]'}`}>
            <ProductThumb
              image={catalog}
              alt={item.name}
              size="lg"
              className="rounded-md"
              onClick={() => {
                const large = imageFor({ extSource: item.ext_source, extId: item.ext_id }, 'large')
                if (large) setZoom(large)
              }}
            />
          </div>
        </div>
      )}

      {/* photos */}
      <div className="border-b border-ink-600 px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-mist-500">Photos</span>
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-mist-400 hover:bg-ink-700 hover:text-mist-100"
          >
            <ImagePlus size={12} /> Add
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addPhotos(e.target.files); e.target.value = '' }} />
        </div>
        {item.photos.length ? (
          <div className="grid grid-cols-4 gap-1.5">
            {item.photos.map((p) => (
              <button key={p.id} onClick={() => setLightbox(p)} className="group relative aspect-square overflow-hidden rounded border border-ink-600">
                <img src={mediaUrl(p)} alt={p.name} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded border border-dashed border-ink-600 py-4 text-center text-[11px] text-mist-500">
            No photos yet — add some for identification.
          </div>
        )}
      </div>

      {/* value summary */}
      <div className="grid grid-cols-3 divide-x divide-ink-600 border-b border-ink-600 text-center">
        <Stat label="Paid" value={money(item.purchase_price)} />
        <Stat
          label="Melt"
          value={money(latestMelt?.value_mid)}
          sub={latestMelt?.spot_price ? `@ $${latestMelt.spot_price.toFixed(2)}/ozt` : undefined}
          accent="text-pulse-400"
        />
        <Stat label="Market" value={money(marketHistory[0]?.value_mid)} sub={marketHistory[0] ? new Date(marketHistory[0].created_at).toLocaleDateString() : undefined} accent="text-volt-400" />
      </div>

      {/* history chart */}
      {chartData.length > 1 && (
        <div className="border-b border-ink-600 px-2 py-3">
          <div className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-mist-500">Value over time</div>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#232735" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#7d8598', fontSize: 9 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#7d8598', fontSize: 9 }} axisLine={false} tickLine={false} width={44} tickFormatter={(v: number) => `$${v}`} />
              <Tooltip
                contentStyle={{ background: '#141722', border: '1px solid #2e3345', borderRadius: 6, fontSize: 11 }}
                labelStyle={{ color: '#aab2c5' }}
                formatter={(v, name) => [typeof v === 'number' ? money(v) : String(v ?? ''), String(name ?? '')]}
              />
              <Line type="monotone" dataKey="melt" name="melt" stroke="#22d3ee" strokeWidth={1.5} dot={false} connectNulls />
              <Line type="monotone" dataKey="market" name="market" stroke="#7c5cff" strokeWidth={1.5} dot={{ r: 2.5 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* appraisal log */}
      <div className="flex-1 px-4 py-3">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-mist-500">Appraisal log</div>
        {marketHistory.length ? (
          <div className="flex flex-col gap-2">
            {marketHistory.map((v) => (
              <div key={v.id} className="rounded-md border border-ink-600 bg-ink-900/60 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-mist-100">
                    {v.kind === 'manual' ? <PenLine size={12} className="text-pulse-400" /> : <TrendingUp size={12} className="text-volt-400" />}
                    {money(v.value_mid)}
                    {v.value_low != null && v.value_high != null && (
                      <span className="text-[10.5px] font-normal text-mist-500">({money(v.value_low)} – {money(v.value_high)})</span>
                    )}
                  </span>
                  <span className="font-mono text-[9.5px] text-mist-500">{new Date(v.created_at).toLocaleDateString()}</span>
                </div>
                {v.source && <div className="mt-1 text-[10.5px] text-pulse-400">{v.source}</div>}
                {v.notes && <div className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-mist-400">{v.notes}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded border border-dashed border-ink-600 px-3 py-4 text-center text-[11px] leading-relaxed text-mist-500">
            <Flame size={14} className="mx-auto mb-1.5 text-ink-500" />
            No market appraisals yet. Hit <span className="text-volt-400">Appraise</span> and the agent will research
            comparable sales and log an estimate here.
          </div>
        )}
        {item.notes && (
          <div className="mt-3">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-mist-500">Notes</div>
            <div className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-mist-400">{item.notes}</div>
          </div>
        )}
      </div>

      {zoom && <ImageZoom image={zoom} name={item.name} subtitle={item.maker} onClose={() => setZoom(null)} />}

      {/* lightbox */}
      {lightbox && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-ink-950/85 backdrop-blur-sm" onClick={() => setLightbox(null)}>
          <div className="relative max-h-[85%] max-w-[85%]" onClick={(e) => e.stopPropagation()}>
            <img src={mediaUrl(lightbox)} alt={lightbox.name} className="max-h-[80vh] rounded-lg border border-ink-600 object-contain" />
            <div className="mt-2 flex items-center justify-between">
              <span className="truncate font-mono text-[10.5px] text-mist-500">{lightbox.name}</span>
              <div className="flex gap-2">
                <button onClick={() => removePhoto(lightbox)} className="flex items-center gap-1 rounded border border-danger-400/40 px-2 py-1 text-[11px] text-danger-400 hover:bg-danger-400/10">
                  <Trash2 size={12} /> Remove
                </button>
                <button onClick={() => setLightbox(null)} className="flex items-center gap-1 rounded border border-ink-600 px-2 py-1 text-[11px] text-mist-300 hover:bg-ink-700">
                  <X size={12} /> Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="px-2 py-2.5">
      <div className="text-[9px] font-medium uppercase tracking-[0.15em] text-mist-500">{label}</div>
      <div className={`mt-0.5 font-mono text-[13px] font-semibold ${accent ?? 'text-mist-100'}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate font-mono text-[8.5px] text-mist-500">{sub}</div>}
    </div>
  )
}
