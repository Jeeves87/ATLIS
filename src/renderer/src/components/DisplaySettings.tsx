import { useEffect, useState } from 'react'
import { Monitor } from 'lucide-react'
import { useUiZoom } from '../lib/useUiZoom'

const PRESETS = [1, 1.25, 1.5, 1.75, 2, 2.5]

/**
 * Interface scale. The same value the title-bar −/+ and Ctrl +/−/0 drive;
 * this is where to set it precisely, e.g. for a TV across the room.
 */
export default function DisplaySettings() {
  const { zoom, setZoom } = useUiZoom()
  // The slider previews locally while dragging and commits on release, so a
  // drag doesn't re-layout the whole window at every pixel of travel.
  const [draft, setDraft] = useState(zoom)
  useEffect(() => setDraft(zoom), [zoom])

  return (
    <section className="mb-4 rounded-lg border border-ink-600 bg-ink-800 p-5">
      <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mist-400">
        <Monitor size={13} className="text-pulse-400" /> Display
      </div>

      <label className="mb-2 block text-[12px] font-medium text-mist-300">
        Interface size <span className="ml-1 font-mono text-volt-400">{Math.round(draft * 100)}%</span>
      </label>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => setZoom(p)}
            className={`rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              Math.abs(zoom - p) < 0.001
                ? 'border-volt-500 bg-volt-500/15 text-volt-400'
                : 'border-ink-600 text-mist-300 hover:border-volt-500 hover:text-volt-400'
            }`}
          >
            {Math.round(p * 100)}%
          </button>
        ))}
      </div>
      <input
        type="range"
        min={0.8}
        max={2.5}
        step={0.05}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={() => setZoom(draft)}
        onKeyUp={() => setZoom(draft)}
        className="w-full accent-[#7c5cff]"
      />
      <p className="mt-2 text-[10.5px] leading-relaxed text-mist-500">
        Scales everything in ATLIS — text, icons, card art — together. Shortcuts work anywhere in the app:{' '}
        <span className="font-mono text-mist-400">Ctrl +</span>, <span className="font-mono text-mist-400">Ctrl −</span>,{' '}
        <span className="font-mono text-mist-400">Ctrl 0</span> to reset, or hold Ctrl and scroll. Remembered between launches.
      </p>
    </section>
  )
}
