import { Plus, RefreshCw, Trash2, Layers, AlertTriangle } from 'lucide-react'
import type { FeedSource } from '../../types'
import { KIND_ICON, KIND_COLOR, fmtAgo } from './format'

/**
 * Left rail: "All sources" plus one row per configured source, each with its
 * kind accent, unread badge, and a remove affordance. Selecting a row filters
 * the timeline to that source.
 */
export default function SourceRail({
  sources,
  unread,
  activeSourceId,
  refreshing,
  onSelect,
  onAdd,
  onRefreshAll,
  onRemove
}: {
  sources: FeedSource[]
  unread: Record<string, number>
  activeSourceId: string | null
  refreshing: boolean
  onSelect: (id: string | null) => void
  onAdd: () => void
  onRefreshAll: () => void
  onRemove: (id: string) => void
}) {
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0)

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-ink-600 bg-ink-850">
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-mist-500">Sources</span>
        <div className="flex items-center gap-1">
          <button
            onClick={onRefreshAll}
            title="Refresh all"
            className="flex h-6 w-6 items-center justify-center rounded border border-ink-600 text-mist-400 transition-colors hover:border-pulse-400 hover:text-pulse-400"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={onAdd}
            title="Add source"
            className="flex h-6 w-6 items-center justify-center rounded border border-ink-600 text-mist-400 transition-colors hover:border-volt-500 hover:text-volt-400"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <RailRow
          active={activeSourceId === null}
          onSelect={() => onSelect(null)}
          icon={<Layers size={13} className="text-mist-300" />}
          title="All sources"
          badge={totalUnread}
        />

        {sources.length === 0 && (
          <p className="mt-8 px-3 text-center text-[11.5px] leading-relaxed text-mist-500">
            No sources yet. Add a YouTube channel, a subreddit, or any blog / RSS feed with <Plus size={11} className="inline" />.
          </p>
        )}

        {sources.map((s) => {
          const Icon = KIND_ICON[s.kind]
          return (
            <RailRow
              key={s.id}
              active={activeSourceId === s.id}
              onSelect={() => onSelect(s.id)}
              icon={<Icon size={13} style={{ color: KIND_COLOR[s.kind] }} />}
              title={s.title}
              subtitle={s.last_error ? 'fetch failed' : s.handle ?? undefined}
              error={!!s.last_error}
              badge={unread[s.id] ?? 0}
              onRemove={() => onRemove(s.id)}
              tooltip={s.last_error ?? `${s.handle ?? s.url}\nupdated ${fmtAgo(s.last_fetched_at)}`}
            />
          )
        })}
      </div>
    </aside>
  )
}

function RailRow({
  active,
  onSelect,
  icon,
  title,
  subtitle,
  badge,
  error,
  onRemove,
  tooltip
}: {
  active: boolean
  onSelect: () => void
  icon: React.ReactNode
  title: string
  subtitle?: string
  badge?: number
  error?: boolean
  onRemove?: () => void
  tooltip?: string
}) {
  return (
    <div
      onClick={onSelect}
      title={tooltip}
      className={`group mb-1 flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors ${
        active ? 'border-volt-500/50 bg-volt-500/10' : 'border-transparent hover:border-ink-600 hover:bg-ink-800'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 truncate text-[12.5px] font-medium text-mist-100">
          {error && <AlertTriangle size={11} className="shrink-0 text-danger-400" />}
          <span className="truncate">{title}</span>
        </div>
        {subtitle && <div className={`truncate font-mono text-[9.5px] ${error ? 'text-danger-400' : 'text-mist-500'}`}>{subtitle}</div>}
      </div>
      {!!badge && (
        <span className="shrink-0 rounded-full bg-volt-500/20 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-volt-300 group-hover:hidden">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="hidden shrink-0 text-mist-500 hover:text-danger-400 group-hover:block"
          title="Remove source"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}
