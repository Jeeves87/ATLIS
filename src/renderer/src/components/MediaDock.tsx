import { useEffect, useRef, useState } from 'react'
import { ChevronDown, MonitorPlay } from 'lucide-react'
import type { MediaState } from '../types'

/**
 * Media tab on the far right edge. Click to slide open a YouTube panel (a
 * persistent, signed-in WebContentsView). Minimize and the video keeps
 * playing as audio; the tab pulses while audible.
 */
export default function MediaDock() {
  const [state, setState] = useState<MediaState>({ open: false, title: 'YouTube', audible: false })
  const holderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.atlis.media.state().then(setState)
    return window.atlis.media.onState(setState)
  }, [])

  // keep the native view glued to the placeholder while open
  useEffect(() => {
    if (!state.open) return
    const el = holderRef.current
    if (!el) return
    const report = () => {
      const r = el.getBoundingClientRect()
      window.atlis.media.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [state.open])

  if (!state.open) {
    return (
      <button
        onClick={() => window.atlis.media.setOpen(true)}
        title={state.audible ? `Playing: ${state.title}` : 'Open media dock (YouTube)'}
        className="fixed right-0 bottom-28 z-40 flex flex-col items-center gap-1.5 rounded-l-md border border-r-0 border-ink-600 bg-ink-850/95 px-1.5 py-2.5 text-mist-400 shadow-xl backdrop-blur transition-colors hover:border-volt-500/60 hover:text-mist-200"
      >
        <MonitorPlay size={15} className={state.audible ? 'text-danger-400' : ''} />
        {state.audible && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-danger-400" />}
      </button>
    )
  }

  return (
    <div className="fixed right-3 bottom-3 z-40 flex h-[400px] w-[480px] flex-col overflow-hidden rounded-lg border border-ink-600 bg-ink-900 shadow-2xl">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-ink-600 bg-ink-850 px-3">
        <MonitorPlay size={13} className="shrink-0 text-danger-400" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-mist-300" title={state.title}>
          {state.title}
        </span>
        {state.audible && <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-danger-400" />}
        <button
          onClick={() => window.atlis.media.setOpen(false)}
          title="Minimize — keeps playing"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-mist-500 hover:bg-ink-700 hover:text-mist-200"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      <div ref={holderRef} className="min-h-0 flex-1" />
    </div>
  )
}

