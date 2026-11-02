import { ipcMain, type BrowserWindow } from 'electron'
import * as db from './db'

/**
 * Whole-interface scale for the ATLIS window — for big, far-away screens (a
 * 4K TV across the room) where 11px micro-labels are unreadable even at the
 * OS's display scaling.
 *
 * It is Chromium page zoom on the main webContents, which scales every view
 * uniformly without touching a single component. Two things sit OUTSIDE the
 * page and need telling:
 *
 *  - Native overlay views (the embedded browser, the media dock) are
 *    positioned from `getBoundingClientRect()`, which is in CSS pixels; the
 *    view API wants window DIPs. At zoom z those differ by a factor of z, so
 *    each manager multiplies incoming bounds by `uiZoom()` and re-applies its
 *    last bounds when the zoom changes (`onUiZoom`), rather than trusting the
 *    renderer to notice and re-report.
 *  - The native title-bar overlay (min/max/close) is a fixed 40 DIP; the
 *    renderer's title bar is 40 CSS px and grows with zoom, so the overlay is
 *    resized to match or the window controls float in the top of a taller bar.
 */

const KEY = 'ui_zoom'
/** Must match createWindow's titleBarOverlay height and TitleBar.tsx's h-10. */
const TITLEBAR_PX = 40
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75, 2, 2.25, 2.5] as const
const MIN = ZOOM_STEPS[0]
const MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]

let current = 1
const listeners = new Set<(z: number) => void>()

const clamp = (z: number): number => Math.min(MAX, Math.max(MIN, Math.round(z * 100) / 100))

/** The zoom saved from last time, or 1. Safe to call before any window exists. */
export function savedUiZoom(): number {
  const n = Number(db.getSetting(KEY))
  return Number.isFinite(n) && n > 0 ? clamp(n) : 1
}

/** Current interface zoom — the CSS-px → DIP factor for overlay geometry. */
export function uiZoom(): number {
  return current
}

/** Run `cb` after every zoom change. Returns an unsubscribe. */
export function onUiZoom(cb: (z: number) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function apply(win: BrowserWindow, z: number): void {
  if (win.isDestroyed()) return
  current = z
  win.webContents.setZoomFactor(z)
  try {
    win.setTitleBarOverlay({ height: Math.round(TITLEBAR_PX * z) })
  } catch {
    // Only exists on platforms/frames that have an overlay.
  }
  for (const cb of listeners) cb(z)
  win.webContents.send('ui:zoom', z)
}

export function setUiZoom(win: BrowserWindow, z: number): number {
  const next = clamp(z)
  db.setSetting(KEY, String(next))
  apply(win, next)
  return next
}

/** One notch in or out along ZOOM_STEPS, from wherever we are now. */
export function stepUiZoom(win: BrowserWindow, dir: 1 | -1): number {
  const next =
    dir > 0
      ? ZOOM_STEPS.find((s) => s > current + 0.001) ?? MAX
      : [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001) ?? MIN
  return setUiZoom(win, next)
}

/**
 * Wire zoom into the main window: restore the saved level, the standard
 * Ctrl +/−/0 shortcuts and Ctrl+wheel, and the renderer's IPC.
 */
export function installUiZoom(win: BrowserWindow): void {
  current = savedUiZoom()
  const wc = win.webContents

  // Chromium keeps zoom per-origin and a reload can drop it, so re-assert the
  // saved level on every load rather than only once at startup.
  wc.on('did-finish-load', () => apply(win, current))

  // Intercepted here, not in the renderer, so they work whatever has focus in
  // the ATLIS chrome. preventDefault also stops Electron's default-menu zoom
  // roles, which would change the zoom behind our back (overlays un-scaled).
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return
    const k = input.key
    const code = input.code
    if (k === '=' || k === '+' || code === 'NumpadAdd') {
      e.preventDefault()
      stepUiZoom(win, 1)
    } else if (k === '-' || k === '_' || code === 'NumpadSubtract') {
      e.preventDefault()
      stepUiZoom(win, -1)
    } else if (k === '0' || code === 'Numpad0') {
      e.preventDefault()
      setUiZoom(win, 1)
    }
  })

  // Ctrl+wheel. Electron reports the gesture but applies nothing by itself.
  wc.on('zoom-changed', (_e, direction) => stepUiZoom(win, direction === 'in' ? 1 : -1))

  ipcMain.handle('ui:getZoom', () => current)
  ipcMain.handle('ui:setZoom', (_e, z: number) => setUiZoom(win, Number(z)))
  ipcMain.handle('ui:stepZoom', (_e, dir: number) => stepUiZoom(win, dir > 0 ? 1 : -1))
}
