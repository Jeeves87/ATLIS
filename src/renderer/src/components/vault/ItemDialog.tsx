import { useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import type { VaultItem } from '../../types'

// Labels, because the stored values (mtg_card) aren't what you'd want to read.
const CATEGORIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'mtg_card', label: 'Magic — card' },
  { value: 'mtg_sealed', label: 'Magic — sealed' },
  { value: 'tcg_sealed', label: 'Other TCG — sealed (Pokémon etc.)' },
  { value: 'coin', label: 'coin' },
  { value: 'bullion', label: 'bullion' },
  { value: 'knife', label: 'knife' },
  { value: 'other', label: 'other' }
]
const METALS = ['', 'gold', 'silver', 'platinum', 'palladium', 'copper'] as const

/** Add/edit form for a Vault item. Photos are managed from the detail panel, not here. */
export default function ItemDialog({ item, onClose, onSaved }: { item: VaultItem | null; onClose: () => void; onSaved: (item: VaultItem) => void }) {
  const [name, setName] = useState(item?.name ?? '')
  const [category, setCategory] = useState(item?.category ?? 'coin')
  const [year, setYear] = useState(item?.year ?? '')
  const [maker, setMaker] = useState(item?.maker ?? '')
  const [grade, setGrade] = useState(item?.grade ?? '')
  const [quantity, setQuantity] = useState(String(item?.quantity ?? 1))
  const [metal, setMetal] = useState(item?.metal ?? '')
  const [weight, setWeight] = useState(item?.metal_weight_ozt == null ? '' : String(item.metal_weight_ozt))
  const [price, setPrice] = useState(item?.purchase_price == null ? '' : String(item.purchase_price))
  const [date, setDate] = useState(item?.purchase_date ?? '')
  const [notes, setNotes] = useState(item?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const numOrNull = (s: string) => {
    const t = s.trim()
    if (!t) return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }

  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    const payload = {
      name: name.trim(),
      category,
      year: year.trim() || null,
      maker: maker.trim() || null,
      grade: grade.trim() || null,
      quantity: Math.max(1, Math.round(numOrNull(quantity) ?? 1)),
      metal: metal || null,
      metal_weight_ozt: numOrNull(weight),
      purchase_price: numOrNull(price),
      purchase_date: date.trim() || null,
      notes: notes.trim() || null
    }
    try {
      const saved = item
        ? await window.atlis.vault.updateItem(item.id, payload)
        : await window.atlis.vault.createItem(payload)
      if (saved) onSaved(saved)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const field = 'w-full rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-[12.5px] text-mist-100 placeholder:text-mist-500 focus:border-volt-500 focus:outline-none'
  const label = 'mb-1 block text-[10px] font-medium uppercase tracking-wider text-mist-500'

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-ink-950/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[560px] rounded-lg border border-ink-600 bg-ink-850 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-ink-600 px-4 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-mist-400">
            {item ? 'Edit item' : 'Add item'}
          </span>
          <button onClick={onClose} className="rounded p-1 text-mist-500 hover:bg-ink-700 hover:text-mist-100">
            <X size={14} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          <div className="grid grid-cols-6 gap-3">
            <div className="col-span-4">
              <label className={label}>Name</label>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g. 1921 Morgan Silver Dollar' className={field} />
            </div>
            <div className="col-span-2">
              <label className={label}>Category</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>

            <div className="col-span-1">
              <label className={label}>Year</label>
              <input value={year} onChange={(e) => setYear(e.target.value)} placeholder="1921" className={field} />
            </div>
            <div className="col-span-3">
              <label className={label}>Mint / maker / brand</label>
              <input value={maker} onChange={(e) => setMaker(e.target.value)} placeholder="Philadelphia · Buck · Case…" className={field} />
            </div>
            <div className="col-span-2">
              <label className={label}>Grade / condition</label>
              <input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="MS-63, VF, excellent…" className={field} />
            </div>

            <div className="col-span-1">
              <label className={label}>Qty</label>
              <input value={quantity} onChange={(e) => setQuantity(e.target.value)} className={field} />
            </div>
            <div className="col-span-2">
              <label className={label}>Metal</label>
              <select value={metal} onChange={(e) => setMetal(e.target.value)} className={field}>
                {METALS.map((m) => <option key={m} value={m}>{m || 'none'}</option>)}
              </select>
            </div>
            <div className="col-span-3">
              <label className={label}>Metal weight (troy oz per item)</label>
              <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="0.7734 for a Morgan dollar" className={field} />
            </div>

            <div className="col-span-2">
              <label className={label}>Paid (USD total)</label>
              <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="45.00" className={field} />
            </div>
            <div className="col-span-2">
              <label className={label}>Purchase date</label>
              <input value={date} onChange={(e) => setDate(e.target.value)} placeholder="YYYY-MM-DD" className={field} />
            </div>
            <div className="col-span-6">
              <label className={label}>Notes</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Provenance, mint marks, box/papers, anything a buyer would ask…" className={`${field} resize-none`} />
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded border border-danger-400/40 bg-danger-400/10 px-3 py-2 text-[11.5px] text-danger-400">{error}</div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-md border border-ink-600 px-3 py-1.5 text-[12px] text-mist-300 hover:bg-ink-700">
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={busy || !name.trim()}
              className="flex items-center gap-1.5 rounded-md border border-volt-500/50 bg-volt-500/15 px-3 py-1.5 text-[12px] font-medium text-volt-400 hover:bg-volt-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              {item ? 'Save' : 'Add to Vault'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
