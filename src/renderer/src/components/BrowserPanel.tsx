import { X } from 'lucide-react'
import { useAtlis } from '../state/store'
import { BrowserChrome, useBrowserHolder } from './browser/BrowserChrome'
import BookmarksBar from './browser/BookmarksBar'
import TabRail from './browser/TabRail'

/**
 * Side-panel browser. The actual page is a native Chromium WebContentsView
 * layered by the main process; this renders the chrome and keeps the native
 * view glued to the placeholder div. The full-screen variant is BrowserView.
 */
export default function BrowserPanel() {
  const setBrowserOpen = useAtlis((s) => s.setBrowserOpen)
  const holderRef = useBrowserHolder()

  return (
    <div className="flex w-[46%] min-w-[420px] shrink-0 flex-col border-l border-ink-600 bg-ink-850">
      <BrowserChrome
        trailing={
          <button onClick={() => setBrowserOpen(false)} className="rounded p-1.5 text-mist-400 hover:bg-ink-700 hover:text-danger-400" title="Close browser">
            <X size={14} />
          </button>
        }
      />
      <BookmarksBar />
      <div className="flex min-h-0 flex-1">
        <TabRail />
        {/* placeholder tracked by the native WebContentsView */}
        <div ref={holderRef} className="grid-texture min-h-0 min-w-0 flex-1" />
      </div>
    </div>
  )
}
