import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, RotateCw, Lock, BookmarkPlus, Check, MessageSquarePlus, Star, Bug, Plus } from 'lucide-react'
import { useAtlis } from '../../state/store'

/**
 * Shared browser toolbar: navigation, address bar with bookmark star, and the
 * save-as-article / send-to-agent actions. Used by both the side panel and the
 * full browser view; `trailing` lets the host append its own buttons (the side
 * panel's close button).
 *
 * State comes from the store, which App keeps fed from the main process, so the
 * toolbar and the tab rail always agree about which page is in front.
 */
export function BrowserChrome({ trailing }: { trailing?: React.ReactNode }) {
  const stagePage = useAtlis((s) => s.stagePage)
  const bookmarks = useAtlis((s) => s.bookmarks)
  const toggleBookmark = useAtlis((s) => s.toggleBookmark)
  const state = useAtlis((s) => s.browserState)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [staging, setStaging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Follow the live page unless the user is mid-edit — retyping their address
  // out from under them on every navigation event would be maddening. Switching
  // tabs counts as a page change, so this tracks the active tab too.
  useEffect(() => {
    if (!editing) setAddress(state?.url ?? '')
  }, [state?.url, state?.activeTabId, editing])

  // Ctrl+L arrives from two places: the main process forwards it when the
  // native page had focus (it has its own keyboard and we can't see its
  // events), and BrowserView raises a DOM event when the ATLIS chrome did.
  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    const off = window.atlis.browser.onFocusAddress(focus)
    window.addEventListener('atlis:focus-address', focus)
    return () => {
      off()
      window.removeEventListener('atlis:focus-address', focus)
    }
  }, [])

  const go = () => {
    if (address.trim()) window.atlis.browser.navigate(address.trim())
    setEditing(false)
    inputRef.current?.blur()
  }

  const hasPage = !!state?.url
  const bookmarked = hasPage && bookmarks.some((b) => b.url === state!.url)

  const saveAsArticle = async () => {
    if (!hasPage || saveState !== 'idle') return
    setSaveState('busy')
    try {
      await window.atlis.browser.saveAsDoc()
      setSaveState('done')
      setTimeout(() => setSaveState('idle'), 1800)
    } catch {
      setSaveState('idle')
    }
  }

  const sendToAgent = async () => {
    if (!hasPage || staging) return
    setStaging(true)
    try {
      stagePage(await window.atlis.browser.capturePage())
    } finally {
      setStaging(false)
    }
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-ink-600 px-2">
      <button onClick={() => window.atlis.browser.back()} disabled={!state?.canGoBack} className="rounded p-1.5 text-mist-400 hover:bg-ink-700 disabled:opacity-30">
        <ArrowLeft size={14} />
      </button>
      <button onClick={() => window.atlis.browser.forward()} disabled={!state?.canGoForward} className="rounded p-1.5 text-mist-400 hover:bg-ink-700 disabled:opacity-30">
        <ArrowRight size={14} />
      </button>
      <button onClick={() => window.atlis.browser.reload()} className={`rounded p-1.5 text-mist-400 hover:bg-ink-700 ${state?.loading ? 'animate-spin' : ''}`}>
        <RotateCw size={13} />
      </button>
      <button onClick={() => window.atlis.browser.newTab()} className="rounded p-1.5 text-mist-400 hover:bg-ink-700 hover:text-volt-400" title="New tab (Ctrl+T)">
        <Plus size={14} />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5">
        {address.startsWith('https://') && <Lock size={10} className="shrink-0 text-ok-400" />}
        <input
          ref={inputRef}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => {
            setEditing(true)
            e.target.select()
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
            if (e.key === 'Escape') {
              setAddress(state?.url ?? '')
              inputRef.current?.blur()
            }
          }}
          placeholder="Enter URL or search…"
          className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-mist-300 outline-none placeholder:text-mist-500"
        />
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => hasPage && toggleBookmark({ url: state!.url, title: state!.title || state!.url })}
          disabled={!hasPage}
          className={`shrink-0 disabled:opacity-30 ${bookmarked ? 'text-volt-400' : 'text-mist-500 hover:text-mist-300'}`}
          title={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
        >
          <Star size={12} fill={bookmarked ? 'currentColor' : 'none'} />
        </button>
      </div>
      <button
        onClick={saveAsArticle}
        disabled={!hasPage || saveState === 'busy'}
        className={`rounded p-1.5 hover:bg-ink-700 disabled:opacity-30 ${saveState === 'done' ? 'text-ok-400' : 'text-mist-400 hover:text-volt-400'}`}
        title="Save page as knowledge base article"
      >
        {saveState === 'done' ? <Check size={14} /> : <BookmarkPlus size={14} />}
      </button>
      <button
        onClick={sendToAgent}
        disabled={!hasPage || staging}
        className="rounded p-1.5 text-mist-400 hover:bg-ink-700 hover:text-volt-400 disabled:opacity-30"
        title="Send page to agent — attaches the page text to your next message"
      >
        <MessageSquarePlus size={14} />
      </button>
      <button
        onClick={() => window.atlis.browser.devtools()}
        disabled={!hasPage}
        className="rounded p-1.5 text-mist-400 hover:bg-ink-700 hover:text-volt-400 disabled:opacity-30"
        title="Open DevTools for this page — use when a site stalls or a login won't complete"
      >
        <Bug size={14} />
      </button>
      {trailing && (
        <>
          <span className="mx-0.5 h-3.5 w-px bg-ink-600" />
          {trailing}
        </>
      )}
    </div>
  )
}

/**
 * Keeps the native WebContentsView glued to the returned holder element by
 * reporting its bounds to the main process on mount and every resize. The tab
 * rail's expand animation resizes the holder frame by frame, so this doubles as
 * the mechanism that makes the page slide with it.
 */
export function useBrowserHolder() {
  const holderRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = holderRef.current
    if (!el) return
    const report = () => {
      const r = el.getBoundingClientRect()
      window.atlis.browser.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [])
  return holderRef
}
