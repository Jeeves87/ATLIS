import { useMemo, useState } from 'react'
import { ChevronDown, Folder, Globe, Import, X } from 'lucide-react'
import { useAtlis } from '../../state/store'
import type { Bookmark } from '../../types'
import ImportBookmarksDialog from './ImportBookmarksDialog'

/**
 * Bookmarks bar. Loose bookmarks are chips; imported ones group into folder
 * chips by the first segment of their path.
 *
 * A folder opens a *native* Electron menu rather than an HTML dropdown, for the
 * same reason the tab rail pushes instead of overlaying: the page is a native
 * WebContentsView painted above all renderer HTML, so an HTML dropdown would
 * open behind it. An OS menu is its own window and floats over everything.
 */
export default function BookmarksBar() {
  const bookmarks = useAtlis((s) => s.bookmarks)
  const removeBookmark = useAtlis((s) => s.removeBookmark)
  const removeBookmarkFolder = useAtlis((s) => s.removeBookmarkFolder)
  const [importing, setImporting] = useState(false)

  const { loose, folders } = useMemo(() => split(bookmarks), [bookmarks])

  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-ink-600 bg-ink-850 px-2">
        {folders.map(([name, items]) => (
          <FolderChip key={name} name={name} items={items} onRemove={() => removeBookmarkFolder(name)} />
        ))}

        {folders.length > 0 && loose.length > 0 && <span className="mx-1 h-3.5 w-px shrink-0 bg-ink-600" />}

        {loose.map((b) => (
          <div key={b.url} className="group flex shrink-0 items-center gap-1 rounded px-1.5 py-1 hover:bg-ink-700">
            <button
              onClick={() => window.atlis.browser.navigate(b.url)}
              onAuxClick={(e) => {
                // Middle-click opens in a background tab, as it does on a page link.
                // preventDefault stops Chromium starting autoscroll on the bar,
                // which scrolls horizontally and would otherwise grab the click.
                if (e.button !== 1) return
                e.preventDefault()
                window.atlis.browser.newTab(b.url, true)
              }}
              title={b.url}
              className="flex max-w-44 items-center gap-1.5 text-[11px] text-mist-300 hover:text-mist-100"
            >
              <Globe size={10} className="shrink-0 text-mist-500" />
              <span className="truncate">{b.title}</span>
            </button>
            <button
              onClick={() => removeBookmark(b.url)}
              title="Remove bookmark"
              className="hidden shrink-0 text-mist-500 hover:text-danger-400 group-hover:block"
            >
              <X size={10} />
            </button>
          </div>
        ))}

        <button
          onClick={() => setImporting(true)}
          title="Import bookmarks from Zen, Firefox, or another Firefox-based browser"
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-mist-500 hover:bg-ink-700 hover:text-mist-200"
        >
          <Import size={11} className="shrink-0" />
          <span>Import</span>
        </button>
      </div>

      {importing && <ImportBookmarksDialog onClose={() => setImporting(false)} />}
    </>
  )
}

/** A folder chip; clicking it pops a native menu anchored under the chip. */
function FolderChip({ name, items, onRemove }: { name: string; items: Bookmark[]; onRemove: () => void }) {
  const open = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    // Renderer viewport coordinates are window content coordinates — the React
    // tree fills the content area — so these pass straight to Menu.popup.
    window.atlis.browser.folderMenu(
      items.map((b) => ({
        title: b.title,
        url: b.url,
        sub: (b.folder ?? '').split('/').slice(1).filter(Boolean)
      })),
      r.left,
      r.bottom
    )
  }

  return (
    <div className="group flex shrink-0 items-center gap-1 rounded px-1.5 py-1 hover:bg-ink-700">
      <button
        onClick={open}
        onAuxClick={(e) => {
          // Firefox's gesture: middle-click a folder opens everything in it.
          if (e.button !== 1) return
          e.preventDefault()
          items.forEach((b) => window.atlis.browser.newTab(b.url, true))
        }}
        title={`${items.length} bookmarks — middle-click to open all`}
        className="flex max-w-44 items-center gap-1.5 text-[11px] text-mist-300 hover:text-mist-100"
      >
        <Folder size={10} className="shrink-0 text-volt-400" />
        <span className="truncate">{name}</span>
        <ChevronDown size={9} className="shrink-0 text-mist-500" />
      </button>
      <button
        onClick={onRemove}
        title={`Remove the "${name}" folder and its ${items.length} bookmarks`}
        className="hidden shrink-0 text-mist-500 hover:text-danger-400 group-hover:block"
      >
        <X size={10} />
      </button>
    </div>
  )
}

/** Partition into loose bookmarks and folder groups keyed by first path segment. */
function split(bookmarks: Bookmark[]): { loose: Bookmark[]; folders: [string, Bookmark[]][] } {
  const loose: Bookmark[] = []
  const byFolder = new Map<string, Bookmark[]>()
  for (const b of bookmarks) {
    const top = (b.folder ?? '').split('/')[0]
    if (!top) {
      loose.push(b)
      continue
    }
    const list = byFolder.get(top)
    if (list) list.push(b)
    else byFolder.set(top, [b])
  }
  return { loose, folders: [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0])) }
}
