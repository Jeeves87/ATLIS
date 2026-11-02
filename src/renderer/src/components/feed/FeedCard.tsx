import { useState } from 'react'
import { ArrowUp, MessageCircle, Bookmark, ExternalLink, EyeOff, Check } from 'lucide-react'
import type { FeedItem } from '../../types'
import { KIND_ICON, KIND_COLOR, fmtAgo, fmtCount } from './format'

/**
 * One timeline card — reddit-style: optional thumbnail, source chip + meta,
 * clickable title (opens in the integrated browser), and a hover action bar
 * (save / mark read / hide / open externally).
 */
export default function FeedCard({
  item,
  onOpen,
  onSetState
}: {
  item: FeedItem
  onOpen: (item: FeedItem) => void
  onSetState: (id: string, patch: { is_read?: boolean; is_saved?: boolean; is_hidden?: boolean }) => void
}) {
  const [thumbErr, setThumbErr] = useState(false)
  const KindIcon = KIND_ICON[item.kind]
  const accent = KIND_COLOR[item.kind]
  const read = !!item.is_read
  const showThumb = !!item.thumbnail && !thumbErr

  return (
    <article
      className={`group relative flex gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
        read ? 'border-ink-700/60 bg-ink-850/40' : 'border-ink-600 bg-ink-850 hover:border-ink-500'
      }`}
    >
      {/* score rail for reddit / scored items */}
      {item.score != null && (
        <div className="flex w-9 shrink-0 flex-col items-center pt-0.5 text-mist-400">
          <ArrowUp size={13} className="text-ember-400" />
          <span className="font-mono text-[12px] font-semibold text-mist-200">{fmtCount(item.score)}</span>
        </div>
      )}

      {showThumb && (
        <button
          onClick={() => onOpen(item)}
          className="relative h-[58px] w-[100px] shrink-0 overflow-hidden rounded-md border border-ink-600 bg-ink-900"
          title="Open"
        >
          <img
            src={item.thumbnail!}
            onError={() => setThumbErr(true)}
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
          />
        </button>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[10.5px] text-mist-500">
          <span className="flex items-center gap-1 font-medium" style={{ color: accent }}>
            <KindIcon size={11} />
            {item.source_title}
          </span>
          {item.author && <span className="truncate text-mist-500">· {item.author}</span>}
          <span className="ml-auto shrink-0 font-mono">{fmtAgo(item.published_at)}</span>
        </div>

        <button
          onClick={() => onOpen(item)}
          className={`mt-1 block text-left text-[13.5px] font-medium leading-snug transition-colors hover:text-volt-300 ${
            read ? 'text-mist-400' : 'text-mist-100'
          }`}
        >
          {item.title}
        </button>

        {item.summary && (
          <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-mist-500">{item.summary}</p>
        )}

        <div className="mt-1.5 flex items-center gap-1">
          {item.comments != null && (
            <span className="flex items-center gap-1 text-[10.5px] text-mist-500">
              <MessageCircle size={11} /> {fmtCount(item.comments)}
            </span>
          )}

          <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Action
              active={!!item.is_saved}
              activeColor="text-volt-400"
              title={item.is_saved ? 'Unsave' : 'Save'}
              onClick={() => onSetState(item.id, { is_saved: !item.is_saved })}
            >
              <Bookmark size={13} fill={item.is_saved ? 'currentColor' : 'none'} />
            </Action>
            <Action
              active={read}
              activeColor="text-ok-400"
              title={read ? 'Mark unread' : 'Mark read'}
              onClick={() => onSetState(item.id, { is_read: !read })}
            >
              <Check size={13} />
            </Action>
            <Action title="Hide" onClick={() => onSetState(item.id, { is_hidden: true })}>
              <EyeOff size={13} />
            </Action>
            <Action title="Open in browser" onClick={() => onOpen(item)}>
              <ExternalLink size={13} />
            </Action>
          </div>
        </div>
      </div>
    </article>
  )
}

function Action({
  children,
  onClick,
  title,
  active,
  activeColor
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  active?: boolean
  activeColor?: string
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`rounded p-1.5 transition-colors hover:bg-ink-700 ${
        active ? activeColor ?? 'text-volt-400' : 'text-mist-500 hover:text-mist-200'
      }`}
    >
      {children}
    </button>
  )
}
