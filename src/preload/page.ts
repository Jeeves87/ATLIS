import { ipcRenderer } from 'electron'

/**
 * Preload for the embedded browser's page views — NOT the ATLIS UI (that is
 * `index.ts`). It exposes nothing to the page; it only adds capture-phase
 * listeners in the isolated world so the site cannot see or cancel them.
 *
 * Its whole job is middle-click-opens-a-new-tab. In a normal browser that is
 * chrome behaviour, driven by Chromium asking its host to open a window with
 * disposition `background-tab`. Inside a WebContentsView that request does not
 * reliably reach setWindowOpenHandler, and on Windows the middle button starts
 * autoscroll instead — you get the scroll compass, not a tab. Cancelling the
 * events here kills the autoscroll and lets us open the tab ourselves.
 */

/** The nearest real link to an event, following shadow boundaries. */
function linkFor(e: MouseEvent): HTMLAnchorElement | null {
  for (const node of e.composedPath()) {
    const el = node as HTMLElement
    if (el?.tagName === 'A' && (el as HTMLAnchorElement).href) return el as HTMLAnchorElement
  }
  // composedPath misses the case where the target is a text node's parent chain
  // in light DOM only; closest() covers it.
  const target = e.target as Element | null
  return target?.closest?.('a[href]') ?? null
}

function openable(a: HTMLAnchorElement | null): string | null {
  if (!a) return null
  const href = a.href
  return /^https?:\/\//i.test(href) ? href : null
}

// Autoscroll begins on mousedown, so it has to be cancelled there — cancelling
// only the later auxclick is too late and leaves the compass on screen.
window.addEventListener(
  'mousedown',
  (e) => {
    if (e.button === 1 && openable(linkFor(e))) e.preventDefault()
  },
  true
)

window.addEventListener(
  'auxclick',
  (e) => {
    if (e.button !== 1) return
    const href = openable(linkFor(e))
    if (!href) return
    // Cancelling auxclick is what stops Chromium ALSO asking to open a window,
    // which would otherwise land a second, duplicate tab.
    e.preventDefault()
    e.stopPropagation()
    ipcRenderer.send('browser:link-newtab', href, false)
  },
  true
)
