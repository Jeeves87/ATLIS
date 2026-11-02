/**
 * Render a page in a real (hidden) Chromium window and hand back its HTML.
 *
 * Plain `fetch` is not enough for the big retailers: Amazon answers 503 with a
 * bot interstitial after a handful of requests, eBay returns 403 to every shape
 * of request, and Target's JSON API serves a CAPTCHA. All three are fine in an
 * actual browser, because a real Chromium supplies the full header set, runs
 * the page's JS, and — crucially — carries cookies across requests, which is
 * what those defences are really checking for.
 *
 * This is deliberately a SEPARATE hidden window, not the user-facing
 * WebContentsView from browser/manager.ts: background price checks must never
 * hijack whatever the user is looking at.
 *
 * It reads public pages only. It does not log in, fill carts, or buy.
 */
import { BrowserWindow } from 'electron'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

/** Session partition for background reads; never the user's default session. */
export const MONITOR_PARTITION = 'persist:atlis-monitor'

// One reused window: creating a fresh Chromium per fetch is slow and throws
// away the cookie jar, which is the main thing making these requests look real.
let win: BrowserWindow | null = null
let queue: Promise<unknown> = Promise.resolve()

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      // Its own cookie jar. Without a partition this window shared
      // session.defaultSession with the user's browser tabs, so every
      // background sweep hit Amazon and Best Buy as the user's SIGNED-IN
      // account — and a sweep that tripped a bot check tripped it against
      // that account. `persist:` keeps the jar across restarts, since the
      // cookies are part of what makes these reads look like a real visitor.
      partition: MONITOR_PARTITION,
      offscreen: true,
      images: false, // nothing here needs pixels; skipping them is much faster
      javascript: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.webContents.setUserAgent(UA)
  win.on('closed', () => { win = null })
  return win
}

export interface RenderOptions {
  /** Extra settle time after load for client-rendered pages. */
  settleMs?: number
  timeoutMs?: number
}

/**
 * Fetch a URL through Chromium and return the rendered HTML, or null on
 * failure. Calls are serialised — parallel loads in one window would clobber
 * each other, and pacing is what keeps these requests acceptable anyway.
 */
export function renderPage(url: string, opts: RenderOptions = {}): Promise<string | null> {
  const settleMs = opts.settleMs ?? 1_200
  const timeoutMs = opts.timeoutMs ?? 25_000

  const run = async (): Promise<string | null> => {
    let w: BrowserWindow
    try {
      w = ensureWindow()
    } catch {
      return null // app not ready / no display
    }
    try {
      const loaded = w.webContents.loadURL(url)
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('render timeout')), timeoutMs))
      await Promise.race([loaded, timeout])
      if (settleMs) await new Promise((r) => setTimeout(r, settleMs))
      const html = (await w.webContents.executeJavaScript(
        'document.documentElement ? document.documentElement.outerHTML : ""',
        true
      )) as string
      return typeof html === 'string' && html.length > 0 ? html : null
    } catch {
      return null
    }
  }

  queue = queue.then(run, run)
  return queue as Promise<string | null>
}

/** Drop the hidden window (called on quit). */
export function disposeRenderer(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}
