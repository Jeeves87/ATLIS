import { useEffect } from 'react'
import { useAtlis } from '../state/store'
import { BrowserChrome, useBrowserHolder } from './browser/BrowserChrome'
import BookmarksBar from './browser/BookmarksBar'
import TabRail from './browser/TabRail'
import FileChatDock from './FileChatDock'

/**
 * Full-page browser view: chrome + bookmarks on top, the Zen-style tab rail down
 * the left, native WebContentsView filling the rest, and the floating IM chat
 * dock.
 *
 * The page is a native view layered above ALL renderer HTML, so the dock can
 * never paint on top of it. Instead the holder leaves the dock's territory
 * uncovered: a thin bottom band for the minimized tab strip, plus a right-hand
 * column while a chat window (or the new-session menu) is open. The dock then
 * floats in that reserved space. The tab rail plays by the same rule — it takes layout width rather than floating.
 */
export default function BrowserView() {
  const holderRef = useBrowserHolder()
  const dockSessionId = useAtlis((s) => s.dockSessionId)
  const dockCreating = useAtlis((s) => s.dockCreating)

  // the view owns the native browser while mounted; on leave, hide it unless
  // the side panel wants it back
  useEffect(() => {
    window.atlis.browser.setVisible(true)
    return () => {
      if (!useAtlis.getState().browserOpen) window.atlis.browser.setVisible(false)
    }
  }, [])

  // The main process binds these inside the page, where it owns the keyboard;
  // this covers the other half — the ATLIS chrome around it (address bar, tab
  // rail, bookmarks), which Chromium never sees key events for.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const st = useAtlis.getState().browserState
      const key = e.key.toLowerCase()

      if (key === 't') {
        e.preventDefault()
        window.atlis.browser.newTab()
      } else if (key === 'w' && st?.activeTabId) {
        e.preventDefault()
        window.atlis.browser.closeTab(st.activeTabId)
      } else if (key === 'l') {
        e.preventDefault()
        window.dispatchEvent(new Event('atlis:focus-address'))
      } else if (key === 'tab' && st && st.tabs.length > 1) {
        e.preventDefault()
        const i = st.tabs.findIndex((t) => t.id === st.activeTabId)
        const next = st.tabs[(i + (e.shiftKey ? -1 : 1) + st.tabs.length) % st.tabs.length]
        window.atlis.browser.activateTab(next.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const dockOpen = !!dockSessionId || dockCreating

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-ink-850">
      <BrowserChrome />
      <BookmarksBar />

      <div className="relative flex min-h-0 flex-1">
        <TabRail />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* placeholder tracked by the native WebContentsView */}
          <div ref={holderRef} className="grid-texture min-h-0 flex-1" />
          {/* bottom band the minimized session strip floats over */}
          <div className="h-11 shrink-0" />
        </div>
        {/* column the expanded chat window / new-session menu floats over
            (window is w-[min(420px,32vw)] min-w-[320px] with 16px dock padding) */}
        {dockOpen && <div className="w-[calc(min(420px,32vw)+16px)] min-w-[336px] shrink-0" />}

        <FileChatDock />
      </div>
    </div>
  )
}
