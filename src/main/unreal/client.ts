import { getSetting, setSetting } from '../db'

/**
 * Bridge to a running Unreal Engine editor via its built-in Remote Control HTTP
 * API (the "Remote Control API" plugin, default 127.0.0.1:30010). The agent
 * drives the live editor through this client: it spawns/edits actors and builds
 * rooms by calling UObject functions or executing Editor Python, and the user
 * watches it happen in the UE viewport in real time.
 *
 * No WebSocket and no extra dependency: every operation is a typed HTTP call.
 * Arbitrary Python runs through PythonScriptLibrary.ExecutePythonCommandEx,
 * which requires the "Python Editor Script Plugin" to be enabled in UE.
 */

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 30010
const TIMEOUT_MS = 20_000

/** Static editor library whose CDO is directly callable over Remote Control. */
const EDITOR_LIB = '/Script/EditorScriptingUtilities.Default__EditorLevelLibrary'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Rot {
  roll: number
  pitch: number
  yaw: number
}

export interface UnrealStatus {
  connected: boolean
  host: string
  port: number
  /** Short human-readable detail: engine/build info when up, or the reason it's down. */
  detail: string
}

interface CallResult {
  ok: boolean
  status: number
  body: unknown
}

export class UnrealClient {
  private host = DEFAULT_HOST
  private port = DEFAULT_PORT

  constructor() {
    this.host = getSetting('unreal_host') || DEFAULT_HOST
    const p = Number(getSetting('unreal_port'))
    this.port = Number.isFinite(p) && p > 0 ? p : DEFAULT_PORT
  }

  config(): { host: string; port: number } {
    return { host: this.host, port: this.port }
  }

  setConfig(host?: string, port?: number): { host: string; port: number } {
    if (host && host.trim()) {
      this.host = host.trim()
      setSetting('unreal_host', this.host)
    }
    if (port && Number.isFinite(port) && port > 0) {
      this.port = Math.floor(port)
      setSetting('unreal_port', String(this.port))
    }
    return this.config()
  }

  private base(): string {
    return `http://${this.host}:${this.port}`
  }

  /** Translate fetch/connection failures into a one-line, actionable reason. */
  private reason(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err)
    if (/aborted|timeout|timed out/i.test(msg)) return `No response within ${TIMEOUT_MS / 1000}s — is the editor busy or the wrong port?`
    if (/ECONNREFUSED|fetch failed|Failed to fetch|refused/i.test(msg)) {
      return `Can't reach Unreal at ${this.host}:${this.port}. Open UE, then enable the Remote Control web server (Project Settings → Plugins → Remote Control, or run "WebControl.StartServer" in the console).`
    }
    return msg
  }

  private async request(path: string, method: string, body?: unknown): Promise<CallResult> {
    // Remote Control is serviced on UE's game thread, so while the editor is busy
    // (spawning, compiling, a modal) it briefly refuses connections. Agent builds
    // fire many calls in a row and routinely hit this, so retry connection-level
    // failures with a short backoff. HTTP error *responses* are returned as-is.
    let lastErr: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
      try {
        const res = await fetch(`${this.base()}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body == null ? undefined : JSON.stringify(body),
          signal: ctrl.signal
        })
        const text = await res.text()
        let parsed: unknown = text
        try {
          parsed = text ? JSON.parse(text) : null
        } catch {
          /* non-JSON body — keep raw text */
        }
        return { ok: res.ok, status: res.status, body: parsed }
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        // Only retry transient connection failures, not aborts/timeouts.
        if (!/ECONNREFUSED|fetch failed|Failed to fetch|ECONNRESET|socket hang up/i.test(msg)) throw err
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastErr
  }

  async status(): Promise<UnrealStatus> {
    try {
      const res = await this.request('/remote/info', 'GET')
      if (!res.ok) {
        return { connected: false, host: this.host, port: this.port, detail: `Remote Control responded HTTP ${res.status}.` }
      }
      let detail = 'Connected to Unreal Remote Control.'
      if (res.body && typeof res.body === 'object') {
        const info = res.body as Record<string, unknown>
        const parts = [info.EngineVersion, info.ProjectName].filter(Boolean)
        if (parts.length) detail = `Connected — ${parts.join(' · ')}`
      }
      return { connected: true, host: this.host, port: this.port, detail }
    } catch (err) {
      return { connected: false, host: this.host, port: this.port, detail: this.reason(err) }
    }
  }

  /**
   * Call a function on a UObject by path. This is the low-level primitive behind
   * every structured Unreal tool. Throws with an actionable message on failure.
   */
  async call(objectPath: string, functionName: string, parameters: Record<string, unknown> = {}, generateTransaction = true): Promise<unknown> {
    let res: CallResult
    try {
      res = await this.request('/remote/object/call', 'PUT', { objectPath, functionName, parameters, generateTransaction })
    } catch (err) {
      throw new Error(this.reason(err))
    }
    if (!res.ok) {
      const errMsg = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>).errorMessage : undefined
      const detail = errMsg ? String(errMsg) : typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
      if (/not allowed by remote control settings|Allow Any Remote Function Call/i.test(detail)) {
        throw new Error(`Unreal blocked the call: ${detail}\nFix: in UE, Project Settings → Plugins → Remote Control → enable "Allow Any Remote Function Call" (or add the function to "Custom Allowed Remote Function Calls"), then retry.`)
      }
      throw new Error(`Unreal call ${functionName} failed (HTTP ${res.status}): ${detail}`)
    }
    return res.body
  }

  // ---- Scene building via the Editor Actor library (no Python required) ----
  // Unreal blocks PythonScriptLibrary over Remote Control, but EditorLevelLibrary
  // and the actor functions are directly callable, so every build operation is a
  // typed Remote Control call. We keep a label→actor-path map so the agent can
  // refer to actors by friendly label across calls within a session.

  private actors = new Map<string, string>()

  private vec(v: Vec3): { X: number; Y: number; Z: number } {
    return { X: v.x ?? 0, Y: v.y ?? 0, Z: v.z ?? 0 }
  }

  private rot(r: Rot): { Roll: number; Pitch: number; Yaw: number } {
    return { Roll: r.roll ?? 0, Pitch: r.pitch ?? 0, Yaw: r.yaw ?? 0 }
  }

  /** Resolve the return value of a spawn call (an actor object path) and label it. */
  private async finishSpawn(ret: unknown, label: string | undefined, scale?: Vec3): Promise<string> {
    const path = typeof ret === 'object' && ret ? String((ret as Record<string, unknown>).ReturnValue ?? '') : String(ret ?? '')
    if (!path) throw new Error('Spawn returned no actor — check the asset/class path exists.')
    let finalLabel = label?.trim() || path.split('.').pop() || path
    if (label?.trim()) {
      await this.call(path, 'SetActorLabel', { NewActorLabel: label.trim(), bMarkDirty: true })
      finalLabel = label.trim()
    }
    if (scale) await this.call(path, 'SetActorScale3D', { NewScale3D: this.vec(scale) })
    this.actors.set(finalLabel.toLowerCase(), path)
    return finalLabel
  }

  async spawnFromObject(assetPath: string, location: Vec3, rotation: Rot, label?: string, scale?: Vec3): Promise<string> {
    const ret = await this.call(EDITOR_LIB, 'SpawnActorFromObject', { ObjectToUse: assetPath, Location: this.vec(location), Rotation: this.rot(rotation) })
    return this.finishSpawn(ret, label, scale)
  }

  async spawnFromClass(classPath: string, location: Vec3, rotation: Rot, label?: string, scale?: Vec3): Promise<string> {
    const full = classPath.includes('.') ? classPath : `/Script/Engine.${classPath}`
    const ret = await this.call(EDITOR_LIB, 'SpawnActorFromClass', { ActorClass: full, Location: this.vec(location), Rotation: this.rot(rotation) })
    return this.finishSpawn(ret, label, scale)
  }

  /** Find an actor path by the label the agent assigned (case-insensitive). */
  private resolveActor(label: string): string {
    const path = this.actors.get(label.trim().toLowerCase())
    if (!path) throw new Error(`No actor labeled "${label}" in this session. Use unreal_list_actors to see current labels, or spawn it first.`)
    return path
  }

  async setTransform(label: string, t: { location?: Vec3; rotation?: Rot; scale?: Vec3 }): Promise<void> {
    const path = this.resolveActor(label)
    if (t.location) await this.call(path, 'K2_SetActorLocation', { NewLocation: this.vec(t.location), bSweep: false, bTeleport: true })
    if (t.rotation) await this.call(path, 'K2_SetActorRotation', { NewRotation: this.rot(t.rotation), bTeleportPhysics: true })
    if (t.scale) await this.call(path, 'SetActorScale3D', { NewScale3D: this.vec(t.scale) })
  }

  async destroyActor(label: string): Promise<void> {
    const path = this.resolveActor(label)
    await this.call(EDITOR_LIB, 'DestroyActor', { ActorToDestroy: path })
    this.actors.delete(label.trim().toLowerCase())
  }

  /** Labels the agent has spawned this session, plus the live actor count in the level. */
  async listActors(): Promise<string> {
    const ret = await this.call(EDITOR_LIB, 'GetAllLevelActors', {})
    const all = ret && typeof ret === 'object' ? (ret as Record<string, unknown>).ReturnValue : null
    const total = Array.isArray(all) ? all.length : 0
    const tracked = [...this.actors.keys()]
    return `Level has ${total} actors. ATLIS-tracked labels (${tracked.length}): ${tracked.length ? tracked.join(', ') : '(none yet)'}`
  }

  /** Search assets under a content path via the Remote Control asset search route. */
  async searchAssets(path: string): Promise<string[]> {
    let res: CallResult
    try {
      res = await this.request('/remote/search/assets', 'PUT', { Query: '', Filter: { PackagePaths: [path], RecursivePaths: true, ClassNames: [] }, Limit: 200 })
    } catch (err) {
      throw new Error(this.reason(err))
    }
    if (!res.ok) throw new Error(`Asset search failed (HTTP ${res.status}).`)
    const body = res.body as { Assets?: Array<{ Path?: string }> } | null
    return (body?.Assets ?? []).map((a) => a.Path ?? '').filter(Boolean)
  }
}
