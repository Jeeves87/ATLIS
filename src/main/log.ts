import { app, crashReporter, BrowserWindow } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Persistent diagnostics. Everything lands in %APPDATA%/atlis/logs/atlis.log;
 * native crashes additionally produce Crashpad dumps under
 * %APPDATA%/atlis/Crashpad/reports (kept local, never uploaded).
 */

let logDir = ''

export function logLine(tag: string, msg: string): void {
  try {
    appendFileSync(join(logDir, 'atlis.log'), `[${new Date().toISOString()}] ${tag}: ${msg}\n`)
  } catch {
    /* logging must never take the app down */
  }
}

export function initLogging(): void {
  logDir = join(app.getPath('userData'), 'logs')
  mkdirSync(logDir, { recursive: true })
  crashReporter.start({ uploadToServer: false })

  process.on('uncaughtException', (err) => {
    logLine('main.uncaughtException', err.stack ?? String(err))
  })
  process.on('unhandledRejection', (reason) => {
    logLine('main.unhandledRejection', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
  })
  app.on('child-process-gone', (_e, details) => {
    logLine('child-process-gone', JSON.stringify(details))
  })
  app.on('render-process-gone', (_e, _wc, details) => {
    logLine('render-process-gone', JSON.stringify(details))
  })
  app.on('before-quit', () => logLine('lifecycle', 'before-quit'))
  logLine('lifecycle', `startup pid=${process.pid} electron=${process.versions.electron} node=${process.versions.node}`)
}

/** Mirror renderer console errors into the log file. */
export function attachWindowLogging(win: BrowserWindow): void {
  win.webContents.on('console-message', (event: { level?: string; message?: string; sourceId?: string; lineNumber?: number }, ...legacy: unknown[]) => {
    const level = event?.level ?? legacy[0]
    const message = event?.message ?? legacy[1]
    if (level === 'error' || level === 3) {
      logLine('renderer.console.error', `${message} (${event?.sourceId ?? ''}:${event?.lineNumber ?? ''})`)
    }
  })
  win.webContents.on('unresponsive', () => logLine('renderer', 'unresponsive'))
  win.webContents.on('responsive', () => logLine('renderer', 'responsive again'))
  win.on('closed', () => logLine('lifecycle', 'window closed'))
}
