import { app, BrowserWindow, Menu, Tray, protocol, shell, nativeImage } from 'electron'
import { join } from 'path'
import { promises as fsp } from 'fs'
import { initDb } from './db'
import { registerIpc } from './ipc'
import { initLogging, attachWindowLogging } from './log'
import { startReminderScheduler } from './planner/reminders'
import { startFeedScheduler } from './feed'
import { startMtgScheduler, setEvRepricer } from './mtg'
import { startDropsScheduler, seedDefaults, setDropsMaintenance } from './drops'
import * as alerts from './alerts'
import { createDiscordSink } from './discordAlert'
import * as tcg from './tcg'
import * as discovery from './discovery'
import * as signals from './signals'
import * as discord from './discord'
import * as ev from './ev'
import * as retail from './retail'
import { renderPage, disposeRenderer } from './render'
import { mimeForFilename, pathForFilename } from './media/store'
import { installUiZoom, savedUiZoom } from './uiZoom'
import * as gameSounds from './gameSounds'

let tray: Tray | null = null
let isQuitting = false

function trayIconPath(): string {
  // Packaged: resources/icon.ico sits next to app.asar (see build.files).
  // Dev: resources/ lives at the project root, two levels above out/main.
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'icon.ico')
    : join(__dirname, '../../resources/icon.ico')
}

function createTray(win: BrowserWindow): Tray {
  const icon = nativeImage.createFromPath(trayIconPath())
  const t = new Tray(icon.isEmpty() ? icon : icon)
  t.setToolTip('ATLIS')

  const showWindow = (): void => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Show ATLIS', click: showWindow },
    { type: 'separator' },
    {
      label: 'Quit ATLIS',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  t.setContextMenu(menu)
  t.on('click', showWindow)
  t.on('double-click', showWindow)
  return t
}

// Must run before app 'ready'. Lets the renderer load chat images via
// <img src="atlis-media://<filename>"> served from the on-disk media store.
protocol.registerSchemesAsPrivileged([
  { scheme: 'atlis-media', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
  // Game table sound effects (Forge's bundled set + the user's own files).
  { scheme: 'atlis-sound', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } }
])

function registerMediaProtocol(): void {
  protocol.handle('atlis-media', async (request) => {
    // URL form: atlis-media://media/<filename>. pathForFilename basenames it,
    // so directory traversal in the name can't escape the media dir.
    const name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '')
    if (!name) return new Response('Not found', { status: 404 })
    const file = pathForFilename(name)
    try {
      const buf = await fsp.readFile(file)
      return new Response(buf, { status: 200, headers: { 'Content-Type': mimeForFilename(file) } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function createWindow(): BrowserWindow {
  // Open at the saved interface scale, not 100% then a visible jump.
  const zoom = savedUiZoom()
  const win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#8b93a7', height: Math.round(40 * zoom) },
    backgroundColor: '#0b0d12',
    webPreferences: {
      zoomFactor: zoom,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  win.on('close', (e) => {
    if (isQuitting) return
    // Close (X) minimizes to tray instead of quitting so background work
    // (feed polling, reminders, drop watches) keeps running.
    e.preventDefault()
    win.hide()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

// Dev escape hatch: run against an isolated profile (fresh DB, own logs)
// without touching the real %APPDATA%/atlis. Electron ignores the APPDATA
// env var (it resolves appData via the OS known-folder API), so an explicit
// override is the only reliable way to sandbox an instance.
if (process.env.ATLIS_USER_DATA) {
  app.setPath('userData', process.env.ATLIS_USER_DATA)
}

app.whenReady().then(() => {
  initLogging()
  initDb()
  registerMediaProtocol()
  gameSounds.registerProtocol()
  const win = createWindow()
  installUiZoom(win)
  attachWindowLogging(win)
  tray = createTray(win)
  const { shell: agentShell, mcp, apps, desktop, torrents, discordBot } = registerIpc(win)
  app.on('will-quit', () => {
    discordBot.stop()
    agentShell.disposeAll()
    apps.disposeAll()
    desktop.disposeAll()
    torrents.disposeAll()
    void mcp.disposeAll()
    disposeRenderer()
    tray?.destroy()
    tray = null
  })
  startReminderScheduler(win)
  startFeedScheduler(win)
  // Give retail lookups a real Chromium; Amazon/eBay/Target reject scripted fetches.
  retail.setRenderer(renderPage)
  setEvRepricer(() => ev.repriceAll())
  startMtgScheduler(win)
  // Score observed sell-out behaviour, re-tier polling from it, then sample
  // demand intent. Runs on the drops scheduler's slow clock.
  setDropsMaintenance(async () => {
    discovery.scoreWatches()
    discovery.retier()
    await signals.sweep()
    // Community telemetry rides the same slow clock; a surge alert is raised
    // from inside the sweep, so the window is passed through for the click.
    await discord.sweep(win)
  })
  // Alert sinks, registered before the poller can produce anything. Order is
  // irrelevant — the dispatcher fans out to all of them — but registration
  // must happen first, or the first sweep after launch has nowhere to deliver.
  alerts.registerSink(alerts.createDesktopSink(win))
  alerts.registerSink(createDiscordSink())
  startDropsScheduler(win)
  tcg.startTcgScheduler(win)
  // First run only: the Munko watch plus its announcement feed. Awaited by
  // nobody — a slow store must not hold up the window opening.
  void seedDefaults()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win.show()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

// Windows/Linux: closing the last window normally quits the app, but since
// the window's own 'close' handler hides it to the tray instead of letting
// it close, this only fires on an explicit app.quit() (tray "Quit" or
// before-quit already set isQuitting) — safe to quit for real here.
app.on('window-all-closed', () => {
  if (isQuitting) app.quit()
})

