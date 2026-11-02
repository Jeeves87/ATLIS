import {
  MessagesSquare, Flame, FileText, Settings, CalendarCheck,
  CandlestickChart, Bot, Rss, Swords, Globe, Sun, Gem, Magnet, Sparkles, Mountain, Crosshair
} from 'lucide-react'
import type { View } from '../types'

/**
 * Single source of truth for ATLIS's built-in apps. NavRail, HubView and the
 * Settings app selector all render from this list; the `disabled_apps`
 * setting (a JSON string[] of View ids) hides non-core entries everywhere.
 */
export interface AppEntry {
  view: View
  icon: typeof Flame
  label: string
  motto: string
  core?: boolean // core apps can't be hidden
}

export const APPS: AppEntry[] = [
  { view: 'hub', icon: Sun, label: 'Hub', motto: 'return', core: true },
  { view: 'chat', icon: MessagesSquare, label: 'Sessions', motto: 'converse', core: true },
  { view: 'browser', icon: Globe, label: 'Browser', motto: 'wander' },
  { view: 'arena', icon: Swords, label: 'Arena', motto: 'contend' },
  { view: 'torrents', icon: Magnet, label: 'Torrents', motto: 'siphon' },
  { view: 'planner', icon: CalendarCheck, label: 'Planner', motto: 'foresee' },
  { view: 'feed', icon: Rss, label: 'Feed', motto: 'observe' },
  { view: 'finance', icon: CandlestickChart, label: 'Finance', motto: 'weigh' },
  { view: 'vault', icon: Gem, label: 'Vault', motto: 'treasure' },
  { view: 'land', icon: Mountain, label: 'Land', motto: 'settle' },
  { view: 'mtg', icon: Sparkles, label: 'Magic', motto: 'covet' },
  { view: 'drops', icon: Crosshair, label: 'Drops', motto: 'pounce' },
  { view: 'agentZoo', icon: Bot, label: 'Agent Zoo', motto: 'summon' },
  { view: 'docs', icon: FileText, label: 'Documents', motto: 'inscribe' },
  { view: 'settings', icon: Settings, label: 'Settings', motto: 'attune', core: true }
]
