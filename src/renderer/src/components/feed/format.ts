import { Rss, PlaySquare, MessageSquare, Globe, type LucideIcon } from 'lucide-react'
import type { FeedKind } from '../../types'

export const KIND_ICON: Record<FeedKind, LucideIcon> = {
  youtube: PlaySquare,
  reddit: MessageSquare,
  rss: Rss,
  site: Globe
}

export const KIND_LABEL: Record<FeedKind, string> = {
  youtube: 'YouTube',
  reddit: 'Reddit',
  rss: 'RSS',
  site: 'Site'
}

/** Per-kind accent so the timeline is scannable by source type. */
export const KIND_COLOR: Record<FeedKind, string> = {
  youtube: '#ff5252',
  reddit: '#ff7a3c',
  rss: '#22d3ee',
  site: '#d97757'
}

/** Compact relative time, e.g. "3m", "5h", "2d", "Mar 4". */
export function fmtAgo(ms: number | null): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 0) return 'now'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** 12345 -> "12.3k". */
export function fmtCount(n: number | null): string {
  if (n == null) return ''
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}
