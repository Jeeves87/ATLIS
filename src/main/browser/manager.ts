import { app, BrowserWindow, Menu, WebContentsView, clipboard, ipcMain, session, shell } from 'electron'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { logLine } from '../log'
import { onUiZoom, uiZoom } from '../uiZoom'

// Browser identity. The default is our honest Electron UA: sites that care
// generally *support* Electron and branch on it — some login SDKs send
// `browser_name=electron` and serve a working flow, whereas claiming to be
// plain Chrome puts them on a Chrome-only path whose login never resolves (the
// QR code and every other route just spin forever). Lying globally traded one
// broken site for many.
//
// Google is the exception that forced the lie in the first place: it refuses
// OAuth in anything whose UA says Electron ("this browser or app may not be
// secure"). So spoof Chrome per-host, for that short list only. Extend
// CHROME_UA_HOSTS when a site is confirmed to reject Electron outright — not
// merely because a page misbehaves.
const CHROME_UA = app.userAgentFallback.replace(/\s(atlis|electron)\/\S+/gi, '')
const CHROME_UA_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'login.microsoftonline.com',
  'login.live.com'
]

/** Where a fresh tab lands. */
const HOME_URL = 'https://duckduckgo.com'

function needsChromeUa(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return CHROME_UA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

/** UA to present for a target URL — honest by default, Chrome for the exceptions. */
function uaFor(url: string): string {
  return needsChromeUa(url) ? CHROME_UA : app.userAgentFallback
}

// The webContents UA covers navigator.userAgent and same-document requests, but
// popups issue their first request before we can touch them (did-create-window
// fires too late). Enforce the same policy at the session layer so headers and
// JS never disagree — a mismatched pair is itself a login-blocking signal.
let uaHookInstalled = false
function installUaHook(): void {
  if (uaHookInstalled) return
  uaHookInstalled = true
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    if (!needsChromeUa(details.url)) return cb({})
    cb({ requestHeaders: { ...details.requestHeaders, 'User-Agent': CHROME_UA } })
  })
}

/**
 * Embedded browser pane. Real Chromium WebContentsViews are layered into the
 * main window; the renderer reports the bounds of its placeholder div and we
 * keep the active view glued to it. The user drives it from the address bar and
 * the tab rail; the agent drives it through the same manager via its browser_*
 * tools, so both see the exact same live page.
 *
 * Tabs: every tab is its own WebContentsView. Only the active one is a child of
 * the window — the native views paint above all renderer HTML, so two attached
 * at once would simply stack. The rest stay alive but detached, holding their
 * scroll position, media, and login state until they are activated again.
 */

/** One row in the tab rail. */
export interface TabInfo {
  id: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
  audible: boolean
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  visible: boolean
  tabs: TabInfo[]
  activeTabId: string | null
}

interface Tab {
  id: string
  view: WebContentsView
  favicon: string | null
  /**
   * Whether this tab has ever been pointed at a URL. Tracked as intent rather
   * than probed off the webContents: right after loadURL() the page has neither
   * a URL nor an isLoading() flag yet, so asking Chromium "are you empty?" races
   * the navigation and can stomp a link the user just opened with the homepage.
   */
  targeted: boolean
}

/** One entry in a bookmark folder's popup menu. */
export interface FolderMenuItem {
  title: string
  url: string
  /** Path segments below the chip, for folders nested deeper than one level. */
  sub: string[]
}

export class BrowserManager {
  private tabs: Tab[] = []
  private activeId: string | null = null
  private win: BrowserWindow
  /** Pane bounds in window DIPs — what the native view is actually given. */
  private bounds = { x: 0, y: 0, width: 0, height: 0 }
  /** The same pane as the renderer reported it, in CSS px (pre-zoom). */
  private cssBounds = { x: 0, y: 0, width: 0, height: 0 }
  private visible = false
  private fullscreen = false
  private suspended = false

  constructor(win: BrowserWindow) {
    this.win = win
    // Interface zoom changes the CSS-px → DIP factor under an unchanged pane,
    // so re-derive the view's bounds instead of waiting for a re-report.
    onUiZoom(() => this.setBounds(this.cssBounds))
    // While a page is HTML-fullscreen (e.g. a YouTube video), Electron makes the
    // window fullscreen but leaves the view pinned to its pane; keep it filling
    // the window across any resulting resize.
    this.win.on('resize', () => {
      if (this.fullscreen) this.fillWindow()
    })
    // Middle-click on a link, reported by the page preload. Only our own tab
    // views are trusted senders, and only http(s) is honoured — this channel is
    // reachable from any page ATLIS loads, so it must not become a way for a
    // site to make ATLIS open arbitrary schemes.
    ipcMain.on('browser:link-newtab', (e, href: unknown, foreground: unknown) => {
      if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) return
      const owned = this.tabs.some((t) => {
        const wc = t.view.webContents
        return !wc.isDestroyed() && wc.id === e.sender.id
      })
      if (!owned) return
      this.createTab(href, foreground === true)
    })
  }

  // ----- tab plumbing -----

  private tab(id: string | null): Tab | undefined {
    return id ? this.tabs.find((t) => t.id === id) : undefined
  }

  private activeTab(): Tab | undefined {
    return this.tab(this.activeId)
  }

  /** The active view, creating the first tab if the browser has never been used. */
  private ensureView(): WebContentsView {
    const live = this.activeTab()
    if (live && !live.view.webContents.isDestroyed()) return live.view
    return this.createTab(null, true).view
  }

  private createTab(url: string | null, activate: boolean): Tab {
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(__dirname, '../preload/page.js')
      }
    })
    view.setBackgroundColor('#0b0d12')
    const tab: Tab = { id: randomUUID(), view, favicon: null, targeted: !!url }
    this.tabs.push(tab)
    this.wire(tab)
    if (url) {
      view.webContents.setUserAgent(uaFor(url))
      view.webContents.loadURL(url).catch(() => {})
    }
    if (activate) this.activate(tab.id)
    else this.pushState()
    return tab
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents
    installUaHook()
    // Keep navigator.userAgent in step with the headers as the user moves
    // between sites; redirects into a sign-in host count too.
    wc.on('will-navigate', (_e, url) => wc.setUserAgent(uaFor(url)))
    wc.on('will-redirect', (_e, url) => wc.setUserAgent(uaFor(url)))
    // Login flows fail silently far more often than they error visibly — mirror
    // the pane's failures into atlis.log so there is something to read when a
    // page "just spins". Open DevTools (toolbar) for the live detail.
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (code !== -3 && isMainFrame) logLine('browser.load', `${code} ${desc} ${url}`)
    })
    // Electron moved this event from positional args to a details object; accept
    // either, the same way attachWindowLogging does.
    wc.on('console-message', (event: { level?: string | number; message?: string; sourceId?: string }, ...legacy: unknown[]) => {
      const level = event?.level ?? legacy[0]
      if (level !== 'error' && level !== 3) return
      logLine('browser.console.error', `${event?.message ?? legacy[1] ?? ''} (${event?.sourceId ?? ''})`)
    })
    const push = () => this.pushState()
    wc.on('did-navigate', push)
    wc.on('did-navigate-in-page', push)
    wc.on('did-start-loading', push)
    wc.on('did-stop-loading', push)
    wc.on('page-title-updated', push)
    wc.on('media-started-playing', push)
    wc.on('media-paused', push)
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons?.[0] ?? tab.favicon
      this.pushState()
    })
    // HTML5 fullscreen (the YouTube fullscreen button) — fill the window, then
    // snap back to the pane when the page leaves fullscreen.
    wc.on('enter-html-full-screen', () => this.setFullscreen(true))
    wc.on('leave-html-full-screen', () => this.setFullscreen(false))
    this.installContextMenu(tab)
    this.installShortcuts(tab)
    // Pages can close themselves (OAuth flows call window.close() when done),
    // which destroys the webContents out from under us — drop the dead tab so
    // the rail never shows a corpse.
    wc.once('destroyed', () => this.forget(tab.id))
    wc.setWindowOpenHandler(({ url, disposition }) => {
      // Real popups (OAuth login windows) must exist as windows so they can
      // reach window.opener to report back; everything else — _blank links,
      // ctrl-click, middle-click — becomes a tab, like any other browser.
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            width: 560,
            height: 720,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
          }
        }
      }
      this.createTab(url, disposition !== 'background-tab')
      return { action: 'deny' }
    })
    wc.on('did-create-window', (child, { url }) => {
      const cwc = child.webContents
      cwc.setUserAgent(uaFor(url))
      cwc.on('will-navigate', (_e, next) => cwc.setUserAgent(uaFor(next)))
      cwc.on('will-redirect', (_e, next) => cwc.setUserAgent(uaFor(next)))
    })
  }

  /** Drop a tab we no longer own (a page that closed itself, or a user close). */
  private forget(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const [tab] = this.tabs.splice(idx, 1)
    this.win.contentView.removeChildView(tab.view)
    if (this.activeId !== id) {
      this.pushState()
      return
    }
    // Chrome's rule: focus whichever tab slid into the closed one's slot, else
    // the new last tab. A browser with no tabs at all is a dead end, so refill
    // with a blank one when the pane is on screen.
    const next = this.tabs[idx] ?? this.tabs[idx - 1]
    this.activeId = null
    if (next) this.activate(next.id)
    else if (this.visible) this.createTab(HOME_URL, true)
    else this.pushState()
  }

  // ----- native context menu -----

  /**
   * Right-click menu for a page. Every item drives the page's own webContents
   * explicitly rather than leaning on menu roles: a role targets whatever
   * Chromium considers focused, which for a native child view layered into
   * someone else's window is not reliably the view that was clicked.
   */
  private installContextMenu(tab: Tab): void {
    const wc = tab.view.webContents
    wc.on('context-menu', (_e, p) => {
      const items: Electron.MenuItemConstructorOptions[] = []
      const sep = (): void => {
        if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' })
      }

      if (p.linkURL) {
        items.push(
          { label: 'Open link in new tab', click: () => this.createTab(p.linkURL, true) },
          { label: 'Open link in background tab', click: () => this.createTab(p.linkURL, false) },
          { label: 'Open link in system browser', click: () => { shell.openExternal(p.linkURL).catch(() => {}) } },
          { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) }
        )
        sep()
      }

      if (p.mediaType === 'image' && p.srcURL) {
        items.push(
          { label: 'Open image in new tab', click: () => this.createTab(p.srcURL, true) },
          { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
          { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
          { label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) }
        )
        sep()
      }

      if (p.isEditable) {
        items.push(
          { label: 'Undo', accelerator: 'Ctrl+Z', enabled: p.editFlags.canUndo, click: () => wc.undo() },
          { label: 'Redo', accelerator: 'Ctrl+Y', enabled: p.editFlags.canRedo, click: () => wc.redo() },
          { type: 'separator' },
          { label: 'Cut', accelerator: 'Ctrl+X', enabled: p.editFlags.canCut, click: () => wc.cut() },
          { label: 'Copy', accelerator: 'Ctrl+C', enabled: p.editFlags.canCopy, click: () => wc.copy() },
          { label: 'Paste', accelerator: 'Ctrl+V', enabled: p.editFlags.canPaste, click: () => wc.paste() },
          { label: 'Paste as plain text', accelerator: 'Ctrl+Shift+V', enabled: p.editFlags.canPaste, click: () => wc.pasteAndMatchStyle() },
          { label: 'Select all', accelerator: 'Ctrl+A', enabled: p.editFlags.canSelectAll, click: () => wc.selectAll() }
        )
        sep()
      } else if (p.selectionText) {
        const trimmed = p.selectionText.trim().replace(/\s+/g, ' ')
        const excerpt = trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed
        items.push(
          { label: 'Copy', accelerator: 'Ctrl+C', click: () => wc.copy() },
          { label: `Search for "${excerpt}"`, click: () => this.createTab(`${HOME_URL}/?q=${encodeURIComponent(trimmed)}`, true) },
          { label: 'Select all', accelerator: 'Ctrl+A', click: () => wc.selectAll() }
        )
        sep()
      }

      // Page-level actions are always worth having — right-clicking empty space
      // is how most people reach back and reload.
      items.push(
        { label: 'Back', accelerator: 'Alt+Left', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'Alt+Right', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', accelerator: 'Ctrl+R', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Copy page address', click: () => clipboard.writeText(wc.getURL()) },
        { label: 'Duplicate tab', click: () => this.createTab(wc.getURL() || HOME_URL, true) },
        { label: 'Close tab', accelerator: 'Ctrl+W', click: () => this.closeTab(tab.id) },
        { type: 'separator' },
        {
          label: 'Inspect element',
          click: () => {
            if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' })
            wc.inspectElement(p.x, p.y)
          }
        }
      )

      Menu.buildFromTemplate(items).popup({ window: this.win })
    })
  }

  /**
   * Tab keybindings. Chromium already handles the clipboard, find, and zoom
   * shortcuts inside the page; these are the ones that belong to the browser
   * around it, which in our case is us.
   */
  private installShortcuts(tab: Tab): void {
    const wc = tab.view.webContents
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return
      if (!(input.control || input.meta)) return
      const key = input.key.toLowerCase()

      if (key === 't') return this.handled(e, () => this.newTab())
      if (key === 'w') return this.handled(e, () => this.closeTab(tab.id))
      if (key === 'l') return this.handled(e, () => this.win.webContents.send('browser:focus-address'))
      if (key === 'tab' || key === 'pagedown') return this.handled(e, () => this.cycle(input.shift && key === 'tab' ? -1 : 1))
      if (key === 'pageup') return this.handled(e, () => this.cycle(-1))
      if (/^[1-9]$/.test(key)) {
        const n = Number(key)
        // Ctrl+9 is "last tab" everywhere else; the rest are positional.
        const target = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1]
        return this.handled(e, () => target && this.activate(target.id))
      }
    })
  }

  private handled(e: Electron.Event, run: () => void): void {
    e.preventDefault()
    run()
  }

  private cycle(delta: number): void {
    if (this.tabs.length < 2) return
    const idx = this.tabs.findIndex((t) => t.id === this.activeId)
    const next = this.tabs[(idx + delta + this.tabs.length) % this.tabs.length]
    this.activate(next.id)
  }

  // ----- public tab API -----

  /**
   * Deliberate "new tab" — the toolbar button, the rail's +, Ctrl+T. Unlike a
   * tab spawned by a link, this one lands with the address bar focused, since
   * the point of asking for it is usually to type somewhere new.
   */
  newTab(url?: string, background = false): string {
    const id = this.createTab(url ?? HOME_URL, !background).id
    if (!url && !background && !this.win.isDestroyed()) this.win.webContents.send('browser:focus-address')
    return id
  }

  activate(id: string): void {
    const tab = this.tab(id)
    if (!tab) return
    const prev = this.activeTab()
    if (prev && prev.id !== id) this.win.contentView.removeChildView(prev.view)
    this.activeId = id
    if (this.visible && !this.suspended) {
      this.win.contentView.addChildView(tab.view)
      tab.view.setBounds(this.fullscreen ? this.windowBounds() : this.bounds)
      this.seed(tab)
      tab.view.webContents.focus()
    }
    this.pushState()
  }

  closeTab(id: string): void {
    const tab = this.tab(id)
    if (!tab) return
    const wc = tab.view.webContents
    // forget() also runs off 'destroyed'; calling it up front lets the
    // replacement tab be chosen before teardown races us, and it is a no-op
    // the second time around.
    this.forget(id)
    if (!wc.isDestroyed()) wc.close()
  }

  /** Give a never-navigated tab something to show. */
  private seed(tab: Tab): void {
    if (tab.targeted) return
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    tab.targeted = true
    wc.setUserAgent(uaFor(HOME_URL))
    wc.loadURL(HOME_URL).catch(() => {})
  }

  // ----- geometry -----

  private windowBounds(): { x: number; y: number; width: number; height: number } {
    const [width, height] = this.win.getContentSize()
    return { x: 0, y: 0, width, height }
  }

  /** Stretch the active view over the entire window content area. */
  private fillWindow(): void {
    this.activeTab()?.view.setBounds(this.windowBounds())
  }

  private setFullscreen(on: boolean): void {
    this.fullscreen = on
    const tab = this.activeTab()
    if (!tab) return
    tab.view.setBounds(on ? this.windowBounds() : this.bounds)
  }

  /** The active page's webContents, or null if there is no live page. */
  private liveWc(): WebContents | null {
    const wc = this.activeTab()?.view.webContents
    return wc && !wc.isDestroyed() ? wc : null
  }

  private tabInfo(tab: Tab): TabInfo {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) {
      return { id: tab.id, url: '', title: '', favicon: tab.favicon, loading: false, audible: false }
    }
    return {
      id: tab.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      favicon: tab.favicon,
      loading: wc.isLoading(),
      audible: wc.isCurrentlyAudible()
    }
  }

  state(): BrowserState {
    const wc = this.liveWc()
    return {
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      visible: this.visible,
      tabs: this.tabs.map((t) => this.tabInfo(t)),
      activeTabId: this.activeId
    }
  }

  private pushState(): void {
    if (!this.win.isDestroyed()) this.win.webContents.send('browser:state', this.state())
  }

  setBounds(b: { x: number; y: number; width: number; height: number }): void {
    // Keep tracking the pane bounds, but don't move the view while it's
    // covering the window for HTML fullscreen — restore to these on exit.
    // The renderer measures in CSS px; at interface zoom z each is z DIPs.
    this.cssBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
    const z = uiZoom()
    const next = {
      x: Math.round(b.x * z),
      y: Math.round(b.y * z),
      width: Math.round(b.width * z),
      height: Math.round(b.height * z)
    }
    const c = this.bounds
    if (next.x === c.x && next.y === c.y && next.width === c.width && next.height === c.height) return
    this.bounds = next
    if (this.visible && !this.fullscreen) this.activeTab()?.view.setBounds(this.bounds)
  }

  /**
   * Temporarily lift the page out of the window without changing whether the
   * browser is "open".
   *
   * The native view paints above every pixel of renderer HTML, so a modal drawn
   * by the renderer over the pane would simply be invisible. Suspending is how a
   * dialog gets the screen — unlike setVisible it leaves `visible` alone, so the
   * side panel's open/closed state can't be corrupted by a dialog opening.
   */
  setSuspended(on: boolean): void {
    if (this.suspended === on) return
    this.suspended = on
    const tab = this.activeTab()
    if (!tab) return
    if (on) {
      this.win.contentView.removeChildView(tab.view)
    } else if (this.visible) {
      this.win.contentView.addChildView(tab.view)
      tab.view.setBounds(this.fullscreen ? this.windowBounds() : this.bounds)
    }
  }

  /**
   * Native popup menu for a bookmarks-bar folder. It has to be a real OS menu
   * for the same reason as above: an HTML dropdown would open behind the page.
   */
  popupBookmarkFolder(items: FolderMenuItem[], x: number, y: number): void {
    // Rebuild the folder hierarchy from each entry's remaining path segments,
    // so a nested folder becomes a nested submenu rather than a flat dump.
    const root: Electron.MenuItemConstructorOptions[] = []
    const dirs = new Map<string, Electron.MenuItemConstructorOptions[]>([['', root]])

    const dirFor = (path: string[]): Electron.MenuItemConstructorOptions[] => {
      let key = ''
      let list = root
      for (const seg of path) {
        const parent = list
        key = key ? `${key}/${seg}` : seg
        let next = dirs.get(key)
        if (!next) {
          next = []
          dirs.set(key, next)
          parent.push({ label: seg, submenu: next })
        }
        list = next
      }
      return list
    }

    for (const it of items) {
      dirFor(it.sub).push({
        label: it.title.length > 60 ? `${it.title.slice(0, 60)}…` : it.title,
        toolTip: it.url,
        click: () => this.navigate(it.url)
      })
    }

    if (!root.length) root.push({ label: '(empty)', enabled: false })
    root.push(
      { type: 'separator' },
      {
        label: `Open all ${items.length} in tabs`,
        click: () => items.forEach((it, i) => this.createTab(it.url, i === 0))
      }
    )

    // x/y come from the renderer in CSS px; the menu wants window DIPs.
    const z = uiZoom()
    Menu.buildFromTemplate(root).popup({ window: this.win, x: Math.round(x * z), y: Math.round(y * z) })
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    const view = this.ensureView()
    if (visible && !this.suspended) {
      this.win.contentView.addChildView(view)
      view.setBounds(this.fullscreen ? this.windowBounds() : this.bounds)
      const tab = this.activeTab()
      if (tab) this.seed(tab)
    } else {
      this.win.contentView.removeChildView(view)
    }
    this.pushState()
  }

  async navigate(url: string): Promise<void> {
    const target = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`
    const wc = this.ensureView().webContents
    // loadURL bypasses will-navigate, so pick the identity up front.
    wc.setUserAgent(uaFor(target))
    await wc.loadURL(target).catch(() => {})
    this.pushState()
  }

  goBack(): void { this.liveWc()?.navigationHistory.goBack() }
  goForward(): void { this.liveWc()?.navigationHistory.goForward() }
  reload(): void { this.liveWc()?.reload() }

  /**
   * DevTools for the pane itself, detached — the view is a native child of the
   * window with no room to dock a panel inside it. This is the only way to see
   * why a login page stalls, so it is a first-class toolbar action.
   */
  toggleDevTools(): void {
    const wc = this.liveWc()
    if (!wc) return
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  }

  private wc(): WebContents {
    const wc = this.liveWc()
    if (!wc || !wc.getURL()) throw new Error('Browser has no page loaded yet — navigate first.')
    return wc
  }

  /** Readable extraction of the current page for the agent. */
  async readPage(): Promise<{ url: string; title: string; text: string }> {
    const wc = this.wc()
    const text = (await wc.executeJavaScript(`(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,svg,iframe').forEach(e => e.remove());
      return clone.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 40000);
    })()`)) as string
    return { url: wc.getURL(), title: wc.getTitle(), text }
  }

  /**
   * Capture the page's main content as cleaned HTML for a knowledge base
   * article: prefer <article>/<main>, strip chrome and scripts, keep only
   * structural attributes, and absolutize links/images so they survive
   * outside the page.
   */
  async captureArticle(): Promise<{ url: string; title: string; html: string; text: string }> {
    const wc = this.wc()
    const { html, text } = (await wc.executeJavaScript(`(() => {
      const root = document.querySelector('article') || document.querySelector('main') || document.body;
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,svg,iframe,canvas,video,audio,nav,header,footer,aside,form,button,[role="navigation"],[role="banner"],[aria-hidden="true"]').forEach(e => e.remove());
      const keep = ['href', 'src', 'alt', 'title', 'colspan', 'rowspan'];
      clone.querySelectorAll('*').forEach(e => {
        [...e.attributes].forEach(a => { if (!keep.includes(a.name)) e.removeAttribute(a.name); });
      });
      clone.querySelectorAll('a[href]').forEach(a => { try { a.setAttribute('href', new URL(a.getAttribute('href'), location.href).href); } catch {} });
      clone.querySelectorAll('img[src]').forEach(i => { try { i.setAttribute('src', new URL(i.getAttribute('src'), location.href).href); } catch {} });
      return {
        html: clone.innerHTML.slice(0, 400000),
        text: (clone.innerText || clone.textContent || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 40000)
      };
    })()`)) as { html: string; text: string }
    return { url: wc.getURL(), title: wc.getTitle(), html, text }
  }

  /** Enumerate interactive elements with stable agent ids. */
  async snapshot(): Promise<string> {
    const wc = this.wc()
    return (await wc.executeJavaScript(`(() => {
      const els = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[onclick]')]
        .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .slice(0, 200);
      return els.map((e, i) => {
        e.setAttribute('data-atlis-id', String(i));
        const tag = e.tagName.toLowerCase();
        const label = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        const extra = tag === 'a' ? ' href=' + JSON.stringify((e.getAttribute('href') || '').slice(0, 100)) :
                      tag === 'input' ? ' type=' + (e.type || 'text') : '';
        return '[' + i + '] <' + tag + extra + '> ' + label;
      }).join('\\n');
    })()`)) as string
  }

  async click(elementId: number): Promise<string> {
    const wc = this.wc()
    return (await wc.executeJavaScript(`(() => {
      const el = document.querySelector('[data-atlis-id="${elementId}"]');
      if (!el) return 'Element ${elementId} not found — call browser_snapshot again (ids reset on navigation).';
      el.scrollIntoView({ block: 'center' });
      el.click();
      return 'Clicked element ${elementId}.';
    })()`)) as string
  }

  async type(elementId: number, text: string, submit: boolean): Promise<string> {
    const wc = this.wc()
    return (await wc.executeJavaScript(`(() => {
      const el = document.querySelector('[data-atlis-id="${elementId}"]');
      if (!el) return 'Element ${elementId} not found — call browser_snapshot again.';
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (${submit}) {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
      }
      return 'Typed into element ${elementId}' + (${submit} ? ' and submitted.' : '.');
    })()`)) as string
  }

  async scroll(direction: 'up' | 'down'): Promise<void> {
    await this.wc().executeJavaScript(`window.scrollBy(0, ${direction === 'down' ? '' : '-'}window.innerHeight * 0.8)`)
  }
}
