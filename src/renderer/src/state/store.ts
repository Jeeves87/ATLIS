import { create } from 'zustand'
import type { Bookmark, Message, PageCapture, Project, Session, StreamEvent, View, BrowserState } from '../types'

interface AtlisState {
  view: View
  sessions: Session[]
  projects: Project[]
  activeSessionId: string | null
  messages: Record<string, Message[]> // sessionId -> messages
  runningSessions: Set<string>
  browserOpen: boolean
  browserState: BrowserState | null
  // page staged from the browser's "send to agent" button; consumed by the Composer
  pendingPage: PageCapture | null
  bookmarks: Bookmark[]
  // Zen-style tab rail: pinned open, or collapsed to a hover-to-expand strip
  railPinned: boolean
  // IM-style chat dock (browser view): which session is expanded, and
  // whether the new-session menu is open — shared so the browser view can
  // reserve native-view-free space for the floating window
  dockSessionId: string | null
  dockCreating: boolean
  liveUsage: { tokens: number; cost: number; energy: number }
  // views hidden by the Settings app selector (persisted as JSON in `disabled_apps`)
  disabledApps: View[]

  setView: (v: View) => void
  loadDisabledApps: () => Promise<void>
  toggleApp: (v: View) => void
  setBrowserOpen: (open: boolean) => void
  stagePage: (p: PageCapture | null) => void
  loadBookmarks: () => Promise<void>
  toggleRailPinned: () => void
  importBookmarks: (items: Bookmark[]) => number
  removeBookmarkFolder: (folder: string) => void
  toggleBookmark: (b: Bookmark) => void
  removeBookmark: (url: string) => void
  setDockSession: (id: string | null) => void
  setDockCreating: (creating: boolean) => void
  syncBrowser: (s: BrowserState) => void
  setActiveSession: (id: string | null) => void
  refreshSessions: () => Promise<void>
  refreshProjects: () => Promise<void>
  loadMessages: (sessionId: string) => Promise<void>
  newSession: (provider: string, model: string) => Promise<Session>
  deleteSession: (id: string) => Promise<void>
  handleEvent: (ev: StreamEvent) => void
  bumpUsage: (tokens: number, cost: number, energy: number) => void
}

export const useAtlis = create<AtlisState>((set, get) => ({
  view: 'hub',
  sessions: [],
  projects: [],
  activeSessionId: null,
  messages: {},
  runningSessions: new Set(),
  browserOpen: false,
  browserState: null,
  pendingPage: null,
  bookmarks: [],
  railPinned: false,
  dockSessionId: null,
  dockCreating: false,
  liveUsage: { tokens: 0, cost: 0, energy: 0 },
  disabledApps: [],

  setView: (view) => set({ view }),
  loadDisabledApps: async () => {
    const all = await window.atlis.settings.getAll()
    try {
      set({ disabledApps: JSON.parse(all.disabled_apps || '[]') as View[] })
    } catch {
      set({ disabledApps: [] })
    }
  },
  toggleApp: (v) => {
    const cur = get().disabledApps
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
    // hiding the view you're standing on drops you back at the hub
    set((st) => ({ disabledApps: next, view: next.includes(st.view) ? 'hub' : st.view }))
    window.atlis.settings.set('disabled_apps', JSON.stringify(next))
  },
  setBrowserOpen: (browserOpen) => {
    window.atlis.browser.setVisible(browserOpen)
    set({ browserOpen })
  },
  // keep the panel in sync when the agent opens/navigates the browser from the main process;
  // in the full browser view the native view is always visible, so don't let that
  // clobber whether the user had the side panel open
  syncBrowser: (s) => set((st) => ({ browserState: s, browserOpen: st.view === 'browser' ? st.browserOpen : s.visible })),
  // staging a page jumps to chat so the composer (and its page chip) is visible;
  // in the browser view, pop the chat dock open instead and stay put
  stagePage: (pendingPage) =>
    set((st) => {
      if (!pendingPage) return { pendingPage }
      if (st.view !== 'browser') return { pendingPage, view: 'chat' }
      return { pendingPage, dockSessionId: st.dockSessionId ?? st.activeSessionId ?? st.sessions[0]?.id ?? null }
    }),

  setDockSession: (dockSessionId) => set({ dockSessionId }),
  setDockCreating: (dockCreating) => set({ dockCreating }),

  loadBookmarks: async () => {
    const all = await window.atlis.settings.getAll()
    try {
      set({ bookmarks: JSON.parse(all.browser_bookmarks || '[]') as Bookmark[] })
    } catch {
      set({ bookmarks: [] })
    }
    set({ railPinned: all.browser_rail_pinned === '1' })
  },
  toggleRailPinned: () => {
    const railPinned = !get().railPinned
    set({ railPinned })
    window.atlis.settings.set('browser_rail_pinned', railPinned ? '1' : '0')
  },
  toggleBookmark: (b) => {
    const list = get().bookmarks
    const next = list.some((x) => x.url === b.url) ? list.filter((x) => x.url !== b.url) : [...list, b]
    set({ bookmarks: next })
    window.atlis.settings.set('browser_bookmarks', JSON.stringify(next))
  },
  removeBookmark: (url) => {
    const next = get().bookmarks.filter((x) => x.url !== url)
    set({ bookmarks: next })
    window.atlis.settings.set('browser_bookmarks', JSON.stringify(next))
  },
  // Imports are additive and deduped by URL — re-importing the same profile,
  // or importing Zen after Firefox when the two share history, adds only what
  // is genuinely new instead of doubling the bar. Returns how many landed.
  importBookmarks: (items) => {
    const list = get().bookmarks
    const seen = new Set(list.map((b) => b.url))
    const added: Bookmark[] = []
    for (const b of items) {
      if (seen.has(b.url)) continue
      seen.add(b.url)
      added.push(b)
    }
    if (!added.length) return 0
    const next = [...list, ...added]
    set({ bookmarks: next })
    window.atlis.settings.set('browser_bookmarks', JSON.stringify(next))
    return added.length
  },
  removeBookmarkFolder: (folder) => {
    const next = get().bookmarks.filter((b) => {
      const top = (b.folder ?? '').split('/')[0]
      return top !== folder
    })
    set({ bookmarks: next })
    window.atlis.settings.set('browser_bookmarks', JSON.stringify(next))
  },

  setActiveSession: (activeSessionId) => {
    set({ activeSessionId })
    if (activeSessionId && !get().messages[activeSessionId]) get().loadMessages(activeSessionId)
  },

  refreshSessions: async () => {
    const sessions = await window.atlis.sessions.list()
    const running = new Set<string>(sessions.filter((s) => s.status === 'running').map((s) => s.id))
    set({ sessions, runningSessions: running })
  },
  refreshProjects: async () => set({ projects: await window.atlis.projects.list() }),

  loadMessages: async (sessionId) => {
    const msgs = await window.atlis.messages.list(sessionId)
    set((st) => ({ messages: { ...st.messages, [sessionId]: msgs } }))
  },

  newSession: async (provider, model) => {
    const s = await window.atlis.sessions.create({ provider: provider as Session['provider'], model })
    await get().refreshSessions()
    set((st) => ({ activeSessionId: s.id, view: 'chat', messages: { ...st.messages, [s.id]: [] } }))
    return s
  },

  deleteSession: async (id) => {
    await window.atlis.sessions.remove(id)
    const st = get()
    if (st.activeSessionId === id) set({ activeSessionId: null })
    await st.refreshSessions()
  },

  handleEvent: (ev) => {
    const st = get()
    const list = st.messages[ev.sessionId]

    if (ev.type === 'message' && ev.message) {
      if (list) {
        const idx = list.findIndex((m) => m.id === ev.message!.id)
        const next = idx >= 0 ? list.map((m, i) => (i === idx ? ev.message! : m)) : [...list, ev.message]
        set({ messages: { ...st.messages, [ev.sessionId]: next } })
      }
    } else if (ev.type === 'text-delta' && ev.messageId && list) {
      const next = list.map((m) => (m.id === ev.messageId ? { ...m, content_md: m.content_md + (ev.delta ?? '') } : m))
      set({ messages: { ...st.messages, [ev.sessionId]: next } })
    } else if (ev.type === 'status') {
      const running = new Set(st.runningSessions)
      if (ev.status === 'running') running.add(ev.sessionId)
      else running.delete(ev.sessionId)
      set({ runningSessions: running })
      st.refreshSessions()
    } else if (ev.type === 'usage' && ev.usage) {
      st.bumpUsage(ev.usage.inputTokens + ev.usage.outputTokens, ev.usage.costUsd, ev.usage.energyWh)
    }
  },

  bumpUsage: (tokens, cost, energy) =>
    set((st) => ({
      liveUsage: {
        tokens: st.liveUsage.tokens + tokens,
        cost: st.liveUsage.cost + cost,
        energy: st.liveUsage.energy + energy
      }
    }))
}))
