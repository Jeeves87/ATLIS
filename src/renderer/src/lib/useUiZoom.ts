import { useEffect, useState } from 'react'

/**
 * The interface zoom, live. The main process owns the value (it persists it,
 * applies it, and handles Ctrl +/−/0 and Ctrl+wheel), so every control that
 * shows it subscribes rather than keeping its own copy.
 */
export function useUiZoom(): {
  zoom: number
  setZoom: (z: number) => void
  step: (dir: 1 | -1) => void
} {
  const [zoom, setLocal] = useState(1)

  useEffect(() => {
    void window.atlis.ui.getZoom().then(setLocal)
    return window.atlis.ui.onZoom((z) => setLocal(Number(z)))
  }, [])

  return {
    zoom,
    setZoom: (z) => void window.atlis.ui.setZoom(z),
    step: (dir) => void window.atlis.ui.stepZoom(dir)
  }
}
