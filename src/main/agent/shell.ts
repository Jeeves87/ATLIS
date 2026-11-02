import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { workspaceRoot } from '../workspace'

const MAX_BUFFER = 200_000 // per-process retained output (chars)
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 300_000

function clip(s: string, max = MAX_BUFFER): string {
  return s.length > max ? `…[${(s.length - max).toLocaleString()} chars trimmed]\n${s.slice(-max)}` : s
}

/**
 * One long-lived PowerShell per session, so cd / env / variables persist
 * between shell_exec calls (Hermes `terminal` model). Commands are wrapped
 * with a sentinel echo so we know exactly when each one finishes.
 */
class PersistentShell {
  private proc: ChildProcessWithoutNullStreams | null = null
  private busy = false

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode == null) return this.proc
    this.proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
      cwd: workspaceRoot(),
      windowsHide: true,
      env: process.env
    })
    this.proc.stdin.setDefaultEncoding('utf8')
    // Emit UTF-8 so non-ASCII tool output survives the pipe.
    this.proc.stdin.write('[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = "SilentlyContinue"\n')
    return this.proc
  }

  async exec(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    if (this.busy) return 'Error: a shell command is already running in this session — wait for it to finish or use shell_bg_start for long-running work.'
    this.busy = true
    try {
      const proc = this.ensure()
      const sentinel = `<<<ATLIS_DONE_${randomUUID().slice(0, 8)}>>>`
      let out = ''
      const done = new Promise<string>((resolvePromise) => {
        let settled = false
        const finish = (text: string) => {
          if (settled) return
          settled = true
          proc.stdout.off('data', onData)
          proc.stderr.off('data', onData)
          proc.off('exit', onExit)
          clearTimeout(timer)
          resolvePromise(text)
        }
        const onData = (chunk: Buffer) => {
          out += chunk.toString('utf8')
          const idx = out.indexOf(sentinel)
          if (idx >= 0) {
            const after = out.slice(idx + sentinel.length)
            const exitMatch = after.match(/EXIT:(\S+)/)
            const body = clip(out.slice(0, idx).trim(), 40_000)
            finish(`${body || '(no output)'}${exitMatch && exitMatch[1] !== 'True' ? `\n[command reported failure: $? = ${exitMatch[1]}]` : ''}`)
          } else if (out.length > MAX_BUFFER * 2) {
            out = clip(out)
          }
        }
        const timer = setTimeout(() => {
          // Runaway command: kill the whole shell (a fresh one respawns lazily).
          this.proc?.kill()
          this.proc = null
          finish(`${clip(out.trim(), 20_000)}\n[timed out after ${Math.round(timeoutMs / 1000)}s — shell was reset; use shell_bg_start for long-running commands]`)
        }, Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS))
        const onExit = () => finish(`${clip(out.trim(), 20_000)}\n[shell process exited]`)
        proc.stdout.on('data', onData)
        proc.stderr.on('data', onData)
        proc.once('exit', onExit)
      })
      // & { } scopes the command; the sentinel always prints, success or error.
      proc.stdin.write(`& { ${command} } 2>&1 | Out-String -Stream; Write-Output "${sentinel}EXIT:$?"\n`)
      return await done
    } finally {
      this.busy = false
    }
  }

  dispose(): void {
    this.proc?.kill()
    this.proc = null
  }
}

interface BgProc {
  id: string
  sessionId: string
  command: string
  proc: ChildProcessWithoutNullStreams
  output: string
  running: boolean
  exitCode: number | null
  startedAt: number
  watchers: { pattern: RegExp; resolve: (line: string) => void }[]
}

export class ShellManager {
  private shells = new Map<string, PersistentShell>()
  private bg = new Map<string, BgProc>()

  private shellFor(sessionId: string): PersistentShell {
    let s = this.shells.get(sessionId)
    if (!s) {
      s = new PersistentShell()
      this.shells.set(sessionId, s)
    }
    return s
  }

  exec(sessionId: string, command: string, timeoutMs?: number): Promise<string> {
    return this.shellFor(sessionId).exec(command, timeoutMs)
  }

  /** Start a detached background command with a rolling output buffer + pattern watchers. */
  bgStart(sessionId: string, command: string): string {
    const id = randomUUID().slice(0, 8)
    const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      cwd: workspaceRoot(),
      windowsHide: true,
      env: process.env
    })
    const entry: BgProc = { id, sessionId, command, proc, output: '', running: true, exitCode: null, startedAt: Date.now(), watchers: [] }
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      entry.output = clip(entry.output + text)
      for (let i = entry.watchers.length - 1; i >= 0; i--) {
        const w = entry.watchers[i]
        const m = text.match(w.pattern)
        if (m) {
          entry.watchers.splice(i, 1)
          w.resolve(m[0])
        }
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', (code) => {
      entry.running = false
      entry.exitCode = code
      for (const w of entry.watchers.splice(0)) w.resolve('') // release waiters on exit
    })
    this.bg.set(id, entry)
    return id
  }

  bgOutput(id: string, tailChars = 6000): string {
    const p = this.bg.get(id)
    if (!p) return `Error: no background process "${id}".`
    const status = p.running ? 'running' : `exited (code ${p.exitCode})`
    const out = p.output.slice(-Math.min(Math.max(tailChars, 200), 40_000))
    return `[${id}] ${status} — ${p.command}\n${out || '(no output yet)'}`
  }

  /** Hermes watch_patterns: block until the process output matches, it exits, or timeout. */
  async bgWait(id: string, pattern: string, timeoutMs = 60_000): Promise<string> {
    const p = this.bg.get(id)
    if (!p) return `Error: no background process "${id}".`
    let re: RegExp
    try {
      re = new RegExp(pattern, 'i')
    } catch {
      return `Error: invalid regex pattern "${pattern}".`
    }
    const existing = p.output.match(re)
    if (existing) return `Pattern already matched: "${existing[0]}"\n${this.bgOutput(id, 2000)}`
    if (!p.running) return `Process already exited (code ${p.exitCode}) without matching.\n${this.bgOutput(id, 2000)}`
    const matched = await new Promise<string>((resolvePromise) => {
      const watcher = { pattern: re, resolve: resolvePromise }
      p.watchers.push(watcher)
      setTimeout(() => {
        const idx = p.watchers.indexOf(watcher)
        if (idx >= 0) {
          p.watchers.splice(idx, 1)
          resolvePromise('__TIMEOUT__')
        }
      }, Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS))
    })
    if (matched === '__TIMEOUT__') return `Timed out after ${Math.round(timeoutMs / 1000)}s without matching /${pattern}/.\n${this.bgOutput(id, 2000)}`
    if (matched === '') return `Process exited (code ${p.exitCode}) before matching.\n${this.bgOutput(id, 2000)}`
    return `Matched: "${matched}"\n${this.bgOutput(id, 2000)}`
  }

  bgKill(id: string): string {
    const p = this.bg.get(id)
    if (!p) return `Error: no background process "${id}".`
    if (p.running) {
      // Kill the whole tree — PowerShell children (node, dotnet…) outlive a plain kill.
      spawn('taskkill', ['/pid', String(p.proc.pid), '/T', '/F'], { windowsHide: true })
      p.running = false
    }
    return `Killed [${id}] ${p.command}`
  }

  bgList(sessionId: string): string {
    const rows = [...this.bg.values()].filter((p) => p.sessionId === sessionId)
    if (!rows.length) return 'No background processes in this session.'
    return rows
      .map((p) => `- [${p.id}] ${p.running ? 'running' : `exited (${p.exitCode})`} · ${Math.round((Date.now() - p.startedAt) / 1000)}s · ${p.command.slice(0, 120)}`)
      .join('\n')
  }

  disposeAll(): void {
    for (const s of this.shells.values()) s.dispose()
    this.shells.clear()
    for (const p of this.bg.values()) if (p.running) spawn('taskkill', ['/pid', String(p.proc.pid), '/T', '/F'], { windowsHide: true })
    this.bg.clear()
  }
}
