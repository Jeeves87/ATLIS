import { BrowserWindow, WebContentsView } from 'electron'
import { onUiZoom, uiZoom } from '../uiZoom'

/**
 * Persistent media dock — a YouTube surface with its own on-disk cookie
 * partition ('persist:media'), so login survives restarts. The view keeps
 * playing while minimized: we only detach it from the layout, never destroy
 * it, and background throttling is off. Deliberately NOT exposed to agent
 * tools — this is the user's personal signed-in surface.
 */
export class MediaDock {
  private view: WebContentsView | null = null
  private bounds = { x: 0, y: 0, width: 0, height: 0 }
  /** As reported by the renderer, in CSS px — re-scaled when the UI zoom changes. */
  private cssBounds = { x: 0, y: 0, width: 0, height: 0 }
  private open = false

  constructor(private win: BrowserWindow) {
    onUiZoom(() => this.setBounds(this.cssBounds))
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view
    this.view = new WebContentsView({
      webPreferences: { partition: 'persist:media', sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    this.view.setBackgroundColor('#0e1118')
    const wc = this.view.webContents
    // Google risk-scores embedded browsers; a *mixed* identity (Firefox UA on
    // the login page, Chromium client hints everywhere else) trips stricter
    // accounts. Present one consistent Firefox identity for the whole media
    // session — UA on every request and no sec-ch-ua headers, which Firefox
    // never sends. YouTube fully supports Firefox.
    const firefoxUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0'
    wc.setUserAgent(firefoxUa)
    wc.session.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(details.requestHeaders)) {
        if (!/^sec-ch-ua/i.test(k)) headers[k] = v as string
      }
      headers['User-Agent'] = firefoxUa
      cb({ requestHeaders: headers })
    })
    wc.setBackgroundThrottling(false)
    wc.setWindowOpenHandler(({ url }) => {
      wc.loadURL(url)
      return { action: 'deny' }
    })
    const push = () => this.push()
    wc.on('page-title-updated', push)
    wc.on('audio-state-changed', push)
    wc.loadURL('https://www.youtube.com')
    return this.view
  }

  state(): { open: boolean; title: string; audible: boolean } {
    const wc = this.view?.webContents
    return { open: this.open, title: wc?.getTitle() ?? 'YouTube', audible: wc?.isCurrentlyAudible() ?? false }
  }

  private push(): void {
    if (!this.win.isDestroyed()) this.win.webContents.send('media:state', this.state())
  }

  setBounds(b: { x: number; y: number; width: number; height: number }): void {
    this.cssBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
    const z = uiZoom() // CSS px → window DIPs
    this.bounds = {
      x: Math.round(b.x * z),
      y: Math.round(b.y * z),
      width: Math.round(b.width * z),
      height: Math.round(b.height * z)
    }
    if (this.view && this.open) this.view.setBounds(this.bounds)
  }

  setOpen(open: boolean): void {
    const view = this.ensure()
    this.open = open
    if (open) {
      this.win.contentView.addChildView(view) // re-adding moves it to top
      view.setBounds(this.bounds)
    } else {
      this.win.contentView.removeChildView(view) // webContents stays alive → audio keeps playing
    }
    this.push()
  }
}
