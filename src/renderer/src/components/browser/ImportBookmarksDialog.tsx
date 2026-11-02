import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, Globe, Loader2, X } from 'lucide-react'
import { useAtlis } from '../../state/store'
import type { Bookmark, BookmarkNode, BookmarkSource } from '../../types'

/**
 * Import bookmarks from Zen, Firefox, or another Firefox fork.
 *
 * The whole time this is open the native page is suspended out of the window —
 * a renderer modal drawn over the pane would otherwise be completely hidden
 * behind it.
 */
export default function ImportBookmarksDialog({ onClose }: { onClose: () => void }) {
  const importBookmarks = useAtlis((s) => s.importBookmarks)
  const [sources, setSources] = useState<BookmarkSource[] | null>(null)
  const [source, setSource] = useState<BookmarkSource | null>(null)
  const [tree, setTree] = useState<BookmarkNode[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ added: number; skipped: number } | null>(null)

  useEffect(() => {
    window.atlis.browser.suspend(true)
    return () => {
      window.atlis.browser.suspend(false)
    }
  }, [])

  useEffect(() => {
    window.atlis.browser
      .bookmarkSources()
      .then((s) => setSources(s))
      .catch((e: Error) => {
        setSources([])
        setError(e.message)
      })
  }, [])

  // Esc closes, like every other dismissable thing in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** Flatten a profile's tree into importable bookmarks, keyed by node id. */
  const flat = useMemo(() => {
    const out = new Map<string, Bookmark>()
    if (!tree) return out
    const walk = (nodes: BookmarkNode[], path: string[]) => {
      for (const n of nodes) {
        if (n.type === 'link' && n.url) {
          out.set(n.id, { title: n.title, url: n.url, ...(path.length ? { folder: path.join('/') } : {}) })
        } else if (n.children) {
          walk(n.children, [...path, n.title])
        }
      }
    }
    // Roots are containers, not folders — a link sitting loose on the Bookmarks
    // Toolbar should land loose on ATLIS's bar, not inside a "Bookmarks Toolbar"
    // folder chip. So each root starts its children at an empty path.
    for (const root of tree) walk(root.children ?? [], [])
    return out
  }, [tree])

  const pick = async (s: BookmarkSource) => {
    setSource(s)
    setTree(null)
    setError('')
    try {
      const t = await window.atlis.browser.bookmarkTree(s.path)
      setTree(t)
      setExpanded(new Set(t.map((r) => r.id)))
      // Sensible default: the toolbar is what people actually curate. Everything
      // else (the Mozilla welcome folders, stale imported copies) stays unticked
      // rather than being silently filtered out.
      const toolbar = t.find((r) => r.title === 'Bookmarks Toolbar')
      setChecked(new Set(toolbar ? linkIds(toolbar) : []))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggle = (node: BookmarkNode) => {
    const ids = linkIds(node)
    setChecked((prev) => {
      const next = new Set(prev)
      const allOn = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (allOn) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const doImport = () => {
    const items = [...checked].map((id) => flat.get(id)).filter((b): b is Bookmark => !!b)
    const added = importBookmarks(items)
    setResult({ added, skipped: items.length - added })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[640px] max-w-full flex-col rounded-lg border border-ink-600 bg-ink-850 shadow-2xl"
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-ink-600 px-3">
          <span className="text-[12.5px] font-medium text-mist-100">Import bookmarks</span>
          <button onClick={onClose} className="rounded p-1 text-mist-400 hover:bg-ink-700 hover:text-danger-400">
            <X size={14} />
          </button>
        </div>

        {result ? (
          <div className="flex flex-col gap-3 p-5 text-[12px] text-mist-300">
            <p>
              Added <span className="text-ok-400">{result.added}</span> bookmark{result.added === 1 ? '' : 's'}
              {result.skipped > 0 && <> — skipped {result.skipped} already on the bar.</>}
            </p>
            <button onClick={onClose} className="self-end rounded-md bg-volt-400/15 px-3 py-1.5 text-[11.5px] text-volt-400 hover:bg-volt-400/25">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {error && <p className="mb-3 rounded border border-danger-400/40 bg-danger-400/10 px-2.5 py-2 text-[11.5px] text-danger-400">{error}</p>}

              {sources === null && (
                <div className="flex items-center gap-2 p-4 text-[12px] text-mist-400">
                  <Loader2 size={14} className="animate-spin" /> Looking for browser profiles…
                </div>
              )}

              {sources?.length === 0 && (
                <p className="p-4 text-[12px] text-mist-400">
                  No Firefox-family profiles with bookmarks were found. ATLIS looks for Zen, Firefox, LibreWolf, Waterfox and Floorp profiles under your roaming app data.
                </p>
              )}

              {!!sources?.length && (
                <>
                  <p className="px-1 pb-2 text-[10.5px] uppercase tracking-wide text-mist-500">Profile</p>
                  <div className="mb-3 flex flex-col gap-1">
                    {sources.map((s) => (
                      <button
                        key={s.path}
                        onClick={() => pick(s)}
                        className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-[11.5px] ${
                          source?.path === s.path
                            ? 'border-volt-400/50 bg-volt-400/10 text-mist-100'
                            : 'border-ink-600 text-mist-300 hover:border-ink-500 hover:bg-ink-800'
                        }`}
                      >
                        <span className="font-medium">{s.browser}</span>
                        <span className="text-mist-500">{s.profile}</span>
                        {s.isDefault && <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-mist-400">default</span>}
                        <span className="ml-auto text-mist-500">{s.count} bookmarks</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {source && tree === null && !error && (
                <div className="flex items-center gap-2 p-4 text-[12px] text-mist-400">
                  <Loader2 size={14} className="animate-spin" /> Reading {source.browser}…
                </div>
              )}

              {tree && (
                <>
                  <p className="px-1 pb-2 text-[10.5px] uppercase tracking-wide text-mist-500">What to import</p>
                  <div className="rounded-md border border-ink-600 p-1.5">
                    {tree.map((n) => (
                      <TreeRow
                        key={n.id}
                        node={n}
                        depth={0}
                        checked={checked}
                        expanded={expanded}
                        onToggle={toggle}
                        onExpand={(id) =>
                          setExpanded((prev) => {
                            const next = new Set(prev)
                            if (next.has(id)) next.delete(id)
                            else next.add(id)
                            return next
                          })
                        }
                      />
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="flex h-12 shrink-0 items-center justify-between border-t border-ink-600 px-3">
              <span className="text-[11.5px] text-mist-500">{checked.size} selected</span>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="rounded-md px-3 py-1.5 text-[11.5px] text-mist-400 hover:bg-ink-700 hover:text-mist-200">
                  Cancel
                </button>
                <button
                  onClick={doImport}
                  disabled={!checked.size}
                  className="rounded-md bg-volt-400/15 px-3 py-1.5 text-[11.5px] text-volt-400 hover:bg-volt-400/25 disabled:opacity-30"
                >
                  Import
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function TreeRow({
  node,
  depth,
  checked,
  expanded,
  onToggle,
  onExpand
}: {
  node: BookmarkNode
  depth: number
  checked: Set<string>
  expanded: Set<string>
  onToggle: (n: BookmarkNode) => void
  onExpand: (id: string) => void
}) {
  const isFolder = node.type === 'folder'
  const ids = isFolder ? linkIds(node) : [node.id]
  const on = ids.length > 0 && ids.every((id) => checked.has(id))
  const partial = !on && ids.some((id) => checked.has(id))
  const isOpen = expanded.has(node.id)

  return (
    <>
      <div className="flex h-7 items-center gap-1.5 rounded px-1 hover:bg-ink-800" style={{ paddingLeft: 4 + depth * 14 }}>
        {isFolder ? (
          <button onClick={() => onExpand(node.id)} className="shrink-0 text-mist-500 hover:text-mist-300">
            {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span className="w-[11px] shrink-0" />
        )}

        <input
          type="checkbox"
          checked={on}
          ref={(el) => {
            if (el) el.indeterminate = partial
          }}
          onChange={() => onToggle(node)}
          className="h-3 w-3 shrink-0 accent-volt-400"
        />

        {isFolder ? <Folder size={11} className="shrink-0 text-volt-400" /> : <Globe size={10} className="shrink-0 text-mist-500" />}

        <span className="min-w-0 flex-1 truncate text-[11.5px] text-mist-300">{node.title}</span>
        {isFolder && <span className="shrink-0 text-[10.5px] text-mist-500">{node.count}</span>}
      </div>

      {isFolder &&
        isOpen &&
        node.children?.map((c) => (
          <TreeRow key={c.id} node={c} depth={depth + 1} checked={checked} expanded={expanded} onToggle={onToggle} onExpand={onExpand} />
        ))}
    </>
  )
}

/** Every link id in a subtree. */
function linkIds(node: BookmarkNode): string[] {
  if (node.type === 'link') return [node.id]
  const out: string[] = []
  for (const c of node.children ?? []) out.push(...linkIds(c))
  return out
}
