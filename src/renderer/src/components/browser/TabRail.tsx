import { useState } from 'react'
import { Globe, Loader2, Pin, PinOff, Plus, Volume2, X } from 'lucide-react'
import { useAtlis } from '../../state/store'
import type { BrowserTab } from '../../types'

const COLLAPSED = 44
const EXPANDED = 216
// zustand v5 snapshots must be reference-stable between store updates, so the
// "no tabs yet" fallback has to be one shared array, not a fresh literal.
const NO_TABS: BrowserTab[] = []

/**
 * Zen-style vertical tab strip: a narrow favicon rail that widens into a full
 * tab list on hover, or stays open when pinned.
 *
 * It *pushes* rather than overlays. The page is a native WebContentsView layered
 * above every pixel of renderer HTML, so a rail floating over it would simply be
 * covered; instead the rail takes real layout width and the holder next to it
 * shrinks, which its ResizeObserver reports so the native view slides along with
 * the animation.
 */
export default function TabRail() {
  const tabs = useAtlis((s) => s.browserState?.tabs ?? NO_TABS)
  const activeId = useAtlis((s) => s.browserState?.activeTabId ?? null)
  const pinned = useAtlis((s) => s.railPinned)
  const togglePinned = useAtlis((s) => s.toggleRailPinned)
  const [hovering, setHovering] = useState(false)
  const open = pinned || hovering

  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{ width: open ? EXPANDED : COLLAPSED }}
      className="flex shrink-0 flex-col border-r border-ink-600 bg-ink-900 transition-[width] duration-150 ease-out"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden p-1.5">
        {tabs.map((t) => (
          <TabRow key={t.id} tab={t} active={t.id === activeId} open={open} closable={tabs.length > 1} />
        ))}
      </div>

      <div className="shrink-0 border-t border-ink-600 p-1.5">
        <button
          onClick={() => window.atlis.browser.newTab()}
          title="New tab (Ctrl+T)"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-mist-400 hover:bg-ink-700 hover:text-mist-100"
        >
          <Plus size={14} className="shrink-0" />
          {open && <span className="truncate text-[11px]">New tab</span>}
        </button>
        {open && (
          <button
            onClick={togglePinned}
            title={pinned ? 'Unpin the tab rail' : 'Keep the tab rail open'}
            className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-mist-500 hover:bg-ink-700 hover:text-mist-200"
          >
            {pinned ? <PinOff size={13} className="shrink-0" /> : <Pin size={13} className="shrink-0" />}
            <span className="truncate text-[11px]">{pinned ? 'Unpin rail' : 'Pin rail'}</span>
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * One tab. Collapsed it is just the favicon; expanded it gains the title and a
 * close button. Middle-click closes it, the way it does in every other browser.
 */
function TabRow({ tab, active, open, closable }: { tab: BrowserTab; active: boolean; open: boolean; closable: boolean }) {
  const [iconFailed, setIconFailed] = useState(false)
  const label = tab.title || hostOf(tab.url) || 'New tab'

  return (
    <div
      onClick={() => !active && window.atlis.browser.activateTab(tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1 && closable) window.atlis.browser.closeTab(tab.id)
      }}
      title={open ? tab.url : label}
      className={`group flex h-8 shrink-0 cursor-default items-center gap-2 rounded-md px-2 ${
        active ? 'bg-ink-700 text-mist-100' : 'text-mist-400 hover:bg-ink-800 hover:text-mist-200'
      }`}
    >
      <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
        {tab.loading ? (
          <Loader2 size={13} className="animate-spin text-volt-400" />
        ) : tab.favicon && !iconFailed ? (
          <img src={tab.favicon} alt="" className="h-4 w-4 rounded-sm" onError={() => setIconFailed(true)} />
        ) : (
          <Globe size={13} className="text-mist-500" />
        )}
        {/* collapsed, the rail has no room for a title — mark the playing tab on
            the favicon itself so it is still findable by ear-then-eye */}
        {!open && tab.audible && <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-volt-400" />}
      </span>

      {open && (
        <>
          <span className="min-w-0 flex-1 truncate text-[11.5px]">{label}</span>
          {tab.audible && <Volume2 size={11} className="shrink-0 text-volt-400" />}
          {closable && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                window.atlis.browser.closeTab(tab.id)
              }}
              title="Close tab (Ctrl+W)"
              className={`shrink-0 rounded p-0.5 text-mist-500 hover:bg-ink-600 hover:text-danger-400 ${active ? '' : 'invisible group-hover:visible'}`}
            >
              <X size={11} />
            </button>
          )}
        </>
      )}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
