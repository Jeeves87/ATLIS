import { useCallback, useEffect, useRef, useState } from 'react'
import { Rss, CheckCheck, Loader2 } from 'lucide-react'
import type { FeedSource, FeedItem, FeedFilter, FeedKind } from '../types'
import SourceRail from './feed/SourceRail'
import FeedCard from './feed/FeedCard'
import AddSourceDialog from './feed/AddSourceDialog'
import { KIND_LABEL } from './feed/format'

const FILTERS: { id: FeedFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'saved', label: 'Saved' }
]
const KINDS: (FeedKind | 'all')[] = ['all', 'youtube', 'reddit', 'rss', 'site']

/**
 * The Feed: a single, source-agnostic timeline. Sources (YouTube channels,
 * subreddits, blogs/RSS) are configured in the left rail; items stream into the
 * center column newest-first and open in ATLIS' integrated browser on click.
 */
export default function FeedView() {
  const [sources, setSources] = useState<FeedSource[]>([])
  const [items, setItems] = useState<FeedItem[]>([])
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<FeedFilter>('all')
  const [kind, setKind] = useState<FeedKind | 'all'>('all')
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const reqRef = useRef(0)

  const loadSources = useCallback(async () => {
    const [srcs, counts] = await Promise.all([window.atlis.feed.sources(), window.atlis.feed.unreadCounts()])
    setSources(srcs)
    setUnread(counts)
  }, [])

  const loadItems = useCallback(async () => {
    const req = ++reqRef.current
    const rows = await window.atlis.feed.items({
      filter,
      kind: kind === 'all' ? undefined : kind,
      sourceId: sourceId ?? undefined,
      limit: 200
    })
    if (req === reqRef.current) setItems(rows)
    setLoading(false)
  }, [filter, kind, sourceId])

  // Reload the timeline whenever filters change.
  useEffect(() => {
    loadItems()
  }, [loadItems])

  // Initial load + live updates from refreshes / agent actions. (A background
  // refresh runs on the main-process scheduler; the toolbar button forces one.)
  useEffect(() => {
    loadSources()
    const off = window.atlis.feed.onChanged(() => {
      loadSources()
      loadItems()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshAll = async () => {
    setRefreshing(true)
    try {
      await window.atlis.feed.refresh(sourceId ?? undefined)
    } finally {
      setRefreshing(false)
    }
  }

  const openItem = async (item: FeedItem) => {
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, is_read: 1 } : it)))
    await window.atlis.feed.openItem(item.id)
  }

  const setItemState = async (id: string, patch: { is_read?: boolean; is_saved?: boolean; is_hidden?: boolean }) => {
    setItems((prev) =>
      prev
        .map((it) =>
          it.id === id
            ? {
                ...it,
                is_read: patch.is_read != null ? (patch.is_read ? 1 : 0) : it.is_read,
                is_saved: patch.is_saved != null ? (patch.is_saved ? 1 : 0) : it.is_saved,
                is_hidden: patch.is_hidden != null ? (patch.is_hidden ? 1 : 0) : it.is_hidden
              }
            : it
        )
        .filter((it) => !it.is_hidden && (filter !== 'saved' || it.is_saved))
    )
    await window.atlis.feed.setItemState(id, patch)
  }

  const removeSource = async (id: string) => {
    if (sourceId === id) setSourceId(null)
    await window.atlis.feed.removeSource(id)
  }

  const markAllRead = async () => {
    setItems((prev) => prev.map((it) => ({ ...it, is_read: 1 })))
    await window.atlis.feed.markRead(sourceId ?? undefined)
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <SourceRail
        sources={sources}
        unread={unread}
        activeSourceId={sourceId}
        refreshing={refreshing}
        onSelect={setSourceId}
        onAdd={() => setShowAdd(true)}
        onRefreshAll={refreshAll}
        onRemove={removeSource}
      />

      <div className="flex min-w-0 flex-1 flex-col bg-ink-900">
        {/* header */}
        <div className="flex items-center gap-3 border-b border-ink-600 px-4 py-2.5">
          <Rss size={15} className="text-volt-400" />
          <span className="text-[13px] font-semibold text-mist-100">Feed</span>

          <div className="ml-2 flex items-center gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  filter === f.id ? 'bg-volt-500/15 text-volt-300' : 'text-mist-400 hover:bg-ink-700 hover:text-mist-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-1">
              {KINDS.map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors ${
                    kind === k ? 'bg-ink-600 text-mist-100' : 'text-mist-500 hover:text-mist-300'
                  }`}
                >
                  {k === 'all' ? 'All' : KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <button
              onClick={markAllRead}
              title="Mark all read"
              className="flex items-center gap-1 rounded-md border border-ink-600 px-2.5 py-1 text-[11px] text-mist-400 hover:border-ok-400 hover:text-ok-400"
            >
              <CheckCheck size={13} /> Read
            </button>
          </div>
        </div>

        {/* timeline */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center text-mist-500">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState hasSources={sources.length > 0} filter={filter} onAdd={() => setShowAdd(true)} />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-4">
              {items.map((item) => (
                <FeedCard key={item.id} item={item} onOpen={openItem} onSetState={setItemState} />
              ))}
            </div>
          )}
        </div>
      </div>

      {showAdd && <AddSourceDialog onClose={() => setShowAdd(false)} onAdded={loadSources} />}
    </div>
  )
}

function EmptyState({ hasSources, filter, onAdd }: { hasSources: boolean; filter: FeedFilter; onAdd: () => void }) {
  return (
    <div className="grid-texture flex h-full flex-col items-center justify-center text-center">
      <Rss size={34} className="mb-3 text-ink-500" />
      {hasSources ? (
        <p className="text-[12.5px] text-mist-500">
          {filter === 'saved' ? 'Nothing saved yet — bookmark items to keep them here.' : filter === 'unread' ? "You're all caught up." : 'No items yet. Try refreshing.'}
        </p>
      ) : (
        <>
          <p className="text-[13px] font-medium text-mist-300">Your feed is empty</p>
          <p className="mt-1 max-w-sm text-[12px] leading-relaxed text-mist-500">
            Add a YouTube channel, a subreddit, or any blog / RSS feed and its newest posts land here.
          </p>
          <button
            onClick={onAdd}
            className="mt-4 rounded-md border border-volt-500/50 bg-volt-500/15 px-3.5 py-1.5 text-[12px] font-medium text-volt-300 hover:bg-volt-500/25"
          >
            Add your first source
          </button>
        </>
      )}
    </div>
  )
}
