import { BrowserWindow, Notification } from 'electron'
import { listReminders, updateReminder } from '../db'

const CHECK_EVERY_MS = 30_000
const STARTUP_GRACE_MS = 2_000

/**
 * Main-process reminder scheduler.
 *
 * MVP behavior:
 * - checks local pending reminders every 30 seconds while ATLIS is running
 * - immediately catches overdue pending reminders on startup
 * - shows native Electron desktop notifications when supported
 * - marks reminders sent after dispatch to avoid duplicate notifications
 */
export function startReminderScheduler(win: BrowserWindow): () => void {
  let stopped = false

  const focusWindow = () => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  const notifyChanged = () => {
    if (!win.isDestroyed()) win.webContents.send('planner:changed', {})
  }

  const dispatch = () => {
    if (stopped || win.isDestroyed()) return
    const due = listReminders(null, Date.now(), 'pending')
    if (!due.length) return

    const sentAt = Date.now()

    if (!Notification.isSupported()) {
      for (const r of due) updateReminder(r.id, { status: 'sent', notification_sent_at: sentAt })
      win.webContents.send('planner:reminderFallback', { reminders: due })
      notifyChanged()
      return
    }

    if (due.length > 3) {
      const n = new Notification({
        title: 'ATLIS reminders',
        body: `${due.length} reminders are due. Open ATLIS to review them.`,
        silent: false
      })
      n.on('click', focusWindow)
      n.show()
      for (const r of due) updateReminder(r.id, { status: 'sent', notification_sent_at: sentAt })
      notifyChanged()
      return
    }

    for (const r of due) {
      const n = new Notification({ title: 'ATLIS reminder', body: r.title, silent: false })
      n.on('click', focusWindow)
      n.show()
      updateReminder(r.id, { status: 'sent', notification_sent_at: sentAt })
    }
    notifyChanged()
  }

  const startupTimer = setTimeout(dispatch, STARTUP_GRACE_MS)
  const interval = setInterval(dispatch, CHECK_EVERY_MS)
  interval.unref?.()

  const stop = () => {
    stopped = true
    clearTimeout(startupTimer)
    clearInterval(interval)
  }

  win.on('closed', stop)
  return stop
}
