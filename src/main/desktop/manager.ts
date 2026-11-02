import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { app, desktopCapturer } from 'electron'
import { join } from 'path'

/**
 * Desktop Control: launch arbitrary existing applications (Discord, games,
 * anything already installed) and drive them like a human would - screenshot
 * what's on screen, click/type/key at real OS input level. Unlike the
 * embedded browser or App Host, there is no structured protocol the target
 * app speaks; perception is a screenshot of its real window, and actions are
 * real mouse/keyboard events (the window is brought to the foreground first -
 * Electron/Chromium apps like Discord ignore synthetic input sent to a
 * background window via PostMessage/SendMessage).
 *
 * The window-finding + input side is a persistent PowerShell process running
 * resources/desktop-control.ps1 (System.Windows.Automation for window lookup,
 * user32 P/Invoke for cursor/click, System.Windows.Forms.SendKeys for typing -
 * all built into Windows/.NET, no native npm deps). Screenshots go through
 * Electron's desktopCapturer directly in this process.
 */

export interface DesktopAppConfig {
  name: string
  command: string // launcher command, e.g. a shortcut target or exe path
  args?: string[]
  windowTitlePattern: string // regex matched against real window titles - required, since launched processes often hand off to a different window owner (validated live: Windows 11 Notepad's window belongs to a different, often pre-existing, process than the one just spawned)
  launchTimeoutSeconds?: number
  enabled: boolean
}

export interface DesktopStatus {
  name: string
  state: 'stopped' | 'tracked'
  enabled: boolean
  windowTitle?: string
  adopted?: boolean // true if we found an already-running window instead of spawning
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000
const ADOPT_PROBE_MS = 1_500
const SHOT_WIDTH = 1600
const SHOT_HEIGHT = 1200

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface TrackedApp {
  title: string
  spawnedPid?: number // only set if THIS manager spawned the process - stop() must not kill an adopted pre-existing app
  lastShot?: { rect: Rect; thumbW: number; thumbH: number }
}

function scriptPath(): string {
  // Packaged builds keep this out of the asar (see package.json asarUnpack) -
  // standard app.asar -> app.asar.unpacked rewrite for files Electron must exec.
  return join(app.getAppPath(), 'resources', 'desktop-control.ps1').replace('app.asar', 'app.asar.unpacked')
}

const STARTUP_TIMEOUT_MS = 20_000 // powershell.exe + Add-Type (UIAutomation, P/Invoke C# compile) can take several seconds cold
const READY_MARKER = 'ATLIS_DESKTOP_READY'

/** Persistent PowerShell process running the dot-sourced control library; one JSON-line call at a time. */
class DesktopShell {
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private busy = false

  // Spawns the process and waits for setup (assembly loads + dot-source) to
  // finish, isolated from any action's own timeout - otherwise a cold
  // PowerShell start silently ate into e.g. desktop_launch's 20s wait and
  // caused spurious "produced no result / TIMEOUT" errors even though the
  // action itself hadn't really started yet.
  private ensureReady(): Promise<void> {
    if (this.proc && this.proc.exitCode == null && this.ready) return this.ready
    const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      windowsHide: true,
      env: process.env
    })
    proc.stdin.setDefaultEncoding('utf8')
    proc.stdin.write('[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = "SilentlyContinue"\n')
    // Widen the console buffer so long JSON lines never get wrapped by the host.
    proc.stdin.write('$Host.UI.RawUI.BufferSize = New-Object Management.Automation.Host.Size(8192, 50)\n')
    proc.stdin.write(`. '${scriptPath().replace(/'/g, "''")}'\n`)
    proc.stdin.write(`Write-Output '${READY_MARKER}'\n`)
    this.proc = proc
    this.ready = new Promise<void>((resolvePromise, rejectPromise) => {
      let out = ''
      const onData = (chunk: Buffer) => {
        out += chunk.toString('utf8')
        if (out.includes(READY_MARKER)) {
          proc.stdout.off('data', onData)
          clearTimeout(timer)
          resolvePromise()
        }
      }
      const timer = setTimeout(() => {
        proc.stdout.off('data', onData)
        rejectPromise(new Error(`Desktop control PowerShell did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s (output so far: ${out.slice(0, 500)})`))
      }, STARTUP_TIMEOUT_MS)
      proc.stdout.on('data', onData)
    })
    return this.ready
  }

  async call(action: string, argsObj: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    if (this.busy) throw new Error('Desktop control is busy with another action - wait for it to finish.')
    this.busy = true
    try {
      await this.ensureReady()
      const proc = this.proc!
      const sentinel = `<<<ATLIS_DESKTOP_DONE_${randomUUID().slice(0, 8)}>>>`
      const argsJson = JSON.stringify(argsObj).replace(/'/g, "''")
      let out = ''
      const raw = await new Promise<string>((resolvePromise) => {
        let settled = false
        const finish = (text: string) => {
          if (settled) return
          settled = true
          proc.stdout.off('data', onData)
          proc.stderr.off('data', onData)
          clearTimeout(timer)
          resolvePromise(text)
        }
        const onData = (chunk: Buffer) => {
          out += chunk.toString('utf8')
          if (out.includes(sentinel)) finish(out)
        }
        const timer = setTimeout(() => finish(`${out}\n[TIMEOUT after ${Math.round(timeoutMs / 1000)}s]`), timeoutMs)
        proc.stdout.on('data', onData)
        proc.stderr.on('data', onData)
        proc.stdin.write(`Invoke-AtlisDesktop -Action '${action}' -ArgsJson '${argsJson}'; Write-Output "${sentinel}"\n`)
      })
      const m = raw.match(/ATLIS_JSON:(.+)/)
      if (!m) throw new Error(`Desktop control produced no result (raw output: ${raw.slice(0, 800)})`)
      return JSON.parse(m[1]) as Record<string, unknown>
    } finally {
      this.busy = false
    }
  }

  dispose(): void {
    this.proc?.kill()
    this.proc = null
    this.ready = null
  }
}

export class DesktopAppManager {
  private configs: DesktopAppConfig[] = []
  private tracked = new Map<string, TrackedApp>()
  private shell = new DesktopShell()

  setConfigs(configs: DesktopAppConfig[]): void {
    this.configs = configs.filter((c) => c && typeof c.name === 'string' && c.name.trim() && typeof c.command === 'string' && typeof c.windowTitlePattern === 'string' && c.windowTitlePattern.trim())
  }

  getConfigs(): DesktopAppConfig[] {
    return this.configs
  }

  async launch(name: string): Promise<string> {
    const cfg = this.configs.find((c) => c.name === name)
    if (!cfg) {
      const known = this.configs.map((c) => c.name).join(', ') || '(none configured - add apps in Settings -> Desktop)'
      return `Error: no desktop app named "${name}". Known: ${known}`
    }
    if (!cfg.enabled) return `Error: desktop app "${name}" is disabled in Settings.`

    // Prefer adopting an already-running window over spawning a duplicate -
    // validated live: Windows 11 Notepad is effectively single-instance and
    // many apps (including Discord) are commonly already running.
    // Node's own wait must always be longer than the PS-side timeoutSec it's
    // paired with (a fixed default here previously caused spurious timeouts:
    // both sides defaulted to ~20s, so any overhead made Node's timer fire
    // first, before PowerShell had a chance to return its own result).
    const probeSec = ADOPT_PROBE_MS / 1000
    const probe = await this.shell.call('find', { name, titlePattern: cfg.windowTitlePattern, timeoutSec: probeSec }, probeSec * 1000 + 5_000)
    if (probe.ok && probe.found) {
      this.tracked.set(name, { title: String(probe.title) })
      return `"${name}" was already running - adopted window "${String(probe.title)}". Use desktop_screenshot to see it.`
    }
    if (!probe.ok) return `Error probing for "${name}": ${String(probe.error)}`

    const args = cfg.args ?? []
    const child = spawn(cfg.command, args, { shell: true, windowsHide: false, detached: true })
    child.unref()
    const spawnedPid = child.pid

    const timeoutSec = Math.min(Math.max(cfg.launchTimeoutSeconds ?? DEFAULT_LAUNCH_TIMEOUT_MS / 1000, 1), 120)
    const found = await this.shell.call('find', { name, titlePattern: cfg.windowTitlePattern, timeoutSec }, timeoutSec * 1000 + 5_000)
    if (!found.ok) return `Error waiting for "${name}": ${String(found.error)}`
    if (!found.found) return `Launched "${name}" but no window matching /${cfg.windowTitlePattern}/ appeared within ${timeoutSec}s. It may still be starting - try desktop_launch again, or check the title pattern in Settings.`

    this.tracked.set(name, { title: String(found.title), spawnedPid })
    return `Launched "${name}" - window "${String(found.title)}" is up. Use desktop_screenshot to see it, then desktop_click/desktop_type/desktop_key to drive it.`
  }

  /** Screenshot the tracked window; caches the rect/thumbnail scale so click() can map coordinates back to real screen pixels. */
  async screenshot(name: string): Promise<{ text: string; imageMime: string; imageBase64: string }> {
    const tracked = this.tracked.get(name)
    if (!tracked) throw new Error(`"${name}" is not tracked - call desktop_launch first.`)
    const r = await this.shell.call('rect', { name })
    if (!r.ok) throw new Error(String(r.error))
    const rect = r.rect as Rect
    tracked.title = String(r.title)

    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: SHOT_WIDTH, height: SHOT_HEIGHT } })
    const source = sources.find((s) => s.name === tracked.title) ?? sources.find((s) => s.name.includes(tracked.title))
    if (!source) {
      const names = sources.map((s) => s.name).slice(0, 20).join(', ')
      throw new Error(`Could not find a capturable window titled "${tracked.title}" (visible windows: ${names || '(none)'}). It may be minimized.`)
    }
    const size = source.thumbnail.getSize()
    tracked.lastShot = { rect, thumbW: size.width, thumbH: size.height }
    const png = source.thumbnail.toPNG()
    return {
      text: `Screenshot of "${tracked.title}" (${size.width}x${size.height} image). Give desktop_click coordinates in THIS image's pixel space (0,0 = top-left) - they are mapped to the real window automatically.`,
      imageMime: 'image/png',
      imageBase64: png.toString('base64')
    }
  }

  async click(name: string, x: number, y: number, button: 'left' | 'right' = 'left', doubleClick = false): Promise<string> {
    const tracked = this.tracked.get(name)
    if (!tracked?.lastShot) return `Error: call desktop_screenshot for "${name}" first so coordinates can be mapped to the real window.`
    const { rect, thumbW, thumbH } = tracked.lastShot
    const realX = Math.round(rect.left + (x / thumbW) * rect.width)
    const realY = Math.round(rect.top + (y / thumbH) * rect.height)
    const r = await this.shell.call('click', { name, x: realX, y: realY, button, doubleClick })
    if (!r.ok) return `Error clicking "${name}": ${String(r.error)}`
    return `Clicked ${button} at image coords (${x}, ${y}) -> screen (${realX}, ${realY}). Take a new desktop_screenshot to see the result.`
  }

  async type(name: string, text: string, submit = false): Promise<string> {
    const r = await this.shell.call('type', { name, text, submit })
    if (!r.ok) return `Error typing into "${name}": ${String(r.error)}`
    return `Typed into "${name}"${submit ? ' and pressed Enter' : ''}. Take a new desktop_screenshot to confirm.`
  }

  async key(name: string, keys: string): Promise<string> {
    const r = await this.shell.call('key', { name, keys })
    if (!r.ok) return `Error sending keys to "${name}": ${String(r.error)}`
    return `Sent "${keys}" to "${name}".`
  }

  async stop(name: string): Promise<string> {
    const tracked = this.tracked.get(name)
    if (!tracked) return `"${name}" is not tracked.`
    await this.shell.call('stop', { name })
    this.tracked.delete(name)
    if (tracked.spawnedPid) {
      spawn('taskkill', ['/pid', String(tracked.spawnedPid), '/T', '/F'], { windowsHide: true })
      return `Stopped "${name}" (process killed).`
    }
    return `Untracked "${name}" - it was already running before ATLIS touched it, so the process was left alone.`
  }

  statusText(): string {
    if (!this.configs.length) return 'No desktop apps configured. Add them in Settings -> Desktop (name, launch command, and a window title pattern).'
    return this.configs
      .map((c) => {
        const t = this.tracked.get(c.name)
        const bits = [t ? `tracked: "${t.title}"` : 'not tracked', t?.spawnedPid ? `pid ${t.spawnedPid}` : t ? 'adopted (pre-existing)' : '']
        return `- ${c.name}${c.enabled ? '' : ' (disabled)'}: ${bits.filter(Boolean).join(' · ')}`
      })
      .join('\n')
  }

  statuses(): DesktopStatus[] {
    return this.configs.map((c) => {
      const t = this.tracked.get(c.name)
      return { name: c.name, state: t ? 'tracked' : 'stopped', enabled: c.enabled, windowTitle: t?.title, adopted: t ? !t.spawnedPid : undefined }
    })
  }

  disposeAll(): void {
    for (const [, t] of this.tracked) {
      if (t.spawnedPid) spawn('taskkill', ['/pid', String(t.spawnedPid), '/T', '/F'], { windowsHide: true })
    }
    this.tracked.clear()
    this.shell.dispose()
  }
}

/** Parse the settings-stored JSON config, tolerating hand-edited input. */
export function parseDesktopConfig(json: string | null): DesktopAppConfig[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json) as unknown
    if (!Array.isArray(arr)) return []
    return (arr as DesktopAppConfig[]).filter((c) => c && typeof c.name === 'string' && c.name.trim() && typeof c.command === 'string')
  } catch {
    return []
  }
}
