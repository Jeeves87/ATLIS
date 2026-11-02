import { createHash, randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import { join } from 'path'

/**
 * TorrentManager — a minimal "download and get out" torrent client.
 *
 * Design goals (in order): point it at a .torrent/magnet, download like any
 * client, and STOP SHARING the instant the download hits 100% — the torrent
 * instance is destroyed on 'done' so no post-completion seeding ever happens.
 * (Uploading WHILE downloading stays on: bittorrent's tit-for-tat means peers
 * won't send you much if you send them nothing.)
 *
 * Electron-free by design (like mcp.ts / apphost.ts): persistence and change
 * notification are injected, so the engine can be integration-tested from
 * plain Node with a Map-backed store.
 *
 * Engine is webtorrent (pure JS, no native build) — ESM-only, so it's pulled
 * in with a dynamic import() that survives the CJS main bundle.
 */

export interface TorrentRow {
  id: string
  info_hash: string | null
  name: string
  magnet: string | null
  torrent_file: string | null // absolute path of our stored .torrent copy
  save_path: string
  status: string // downloading | paused | done | error
  error: string | null
  total_bytes: number | null
  downloaded_bytes: number
  uploaded_bytes: number
  files_json: string | null // JSON {path,length}[] once metadata is known
  added_at: number
  completed_at: number | null
}

export interface TorrentStore {
  list(): TorrentRow[]
  get(id: string): TorrentRow | undefined
  insert(row: TorrentRow): void
  update(id: string, patch: Partial<TorrentRow>): void
  remove(id: string): void
}

/** DB row merged with live transfer stats — what the renderer renders. */
export interface TorrentInfo {
  id: string
  name: string
  status: 'downloading' | 'paused' | 'done' | 'error'
  infoHash: string | null
  savePath: string
  totalBytes: number | null
  downloadedBytes: number
  uploadedBytes: number
  progress: number // 0..1
  downloadSpeed: number // bytes/s
  uploadSpeed: number
  numPeers: number
  etaSec: number | null
  fileCount: number | null
  hasMetadata: boolean
  error: string | null
  addedAt: number
  completedAt: number | null
}

export interface AddTorrentInput {
  magnet?: string // magnet: URI
  url?: string // http(s) URL to a .torrent file
  torrentBase64?: string // raw .torrent bytes (renderer file pick / drag-drop)
  fileName?: string
}

// webtorrent ships no types; these are the slices of its API we actually use.
interface WtFile {
  name: string
  path: string
  length: number
}
interface WtTorrent {
  infoHash: string
  name: string
  length: number
  downloaded: number
  uploaded: number
  downloadSpeed: number
  uploadSpeed: number
  progress: number
  numPeers: number
  timeRemaining: number
  files: WtFile[]
  on(event: string, cb: (arg?: unknown) => void): void
  destroy(cb?: () => void): void
}
interface WtClient {
  add(source: string | Buffer, opts: { path: string }): WtTorrent
  remove(torrent: WtTorrent, opts: { destroyStore: boolean }, cb?: (err?: Error) => void): void
  destroy(cb?: (err?: Error) => void): void
  on(event: string, cb: (err: Error) => void): void
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class TorrentManager {
  private clientP: Promise<WtClient> | null = null
  private live = new Map<string, WtTorrent>() // row id -> active webtorrent instance
  private ticker: ReturnType<typeof setInterval> | null = null
  private tick = 0

  constructor(
    private torrentDir: string, // where .torrent copies live (userData/torrents)
    private store: TorrentStore,
    private notify: (list: TorrentInfo[]) => void
  ) {}

  private client(): Promise<WtClient> {
    if (!this.clientP) {
      this.clientP = import('webtorrent').then(({ default: WebTorrent }) => {
        const c = new WebTorrent() as WtClient
        // a client-level error is fatal in webtorrent (the client self-destroys),
        // so orphan every live transfer and let the next add() build a fresh client
        c.on('error', (err) => {
          console.error('webtorrent client error:', msg(err))
          for (const id of this.live.keys()) {
            this.store.update(id, { status: 'error', error: `torrent engine failed: ${msg(err)}` })
          }
          this.live.clear()
          this.clientP = null
          this.stopTickerIfIdle()
          this.notifyNow()
        })
        return c
      })
    }
    return this.clientP
  }

  /** Re-attach every torrent that was mid-download when the app last quit. */
  async resumeAll(): Promise<void> {
    for (const row of this.store.list()) {
      if (row.status !== 'downloading') continue
      try {
        await this.attach(row)
      } catch (err) {
        this.store.update(row.id, { status: 'error', error: msg(err) })
      }
    }
    this.notifyNow()
  }

  async add(input: AddTorrentInput, savePath: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    try {
      let magnet: string | null = null
      let torrentBuf: Buffer | null = null
      let name = ''
      if (input.magnet) {
        const m = input.magnet.trim()
        if (!m.startsWith('magnet:')) return { ok: false, error: 'Not a magnet link' }
        magnet = m
        name = new URLSearchParams(m.slice(m.indexOf('?') + 1)).get('dn') ?? ''
      } else if (input.url) {
        const res = await fetch(input.url.trim(), { redirect: 'follow' })
        if (!res.ok) return { ok: false, error: `Fetching .torrent failed: HTTP ${res.status}` }
        torrentBuf = Buffer.from(await res.arrayBuffer())
      } else if (input.torrentBase64) {
        torrentBuf = Buffer.from(input.torrentBase64, 'base64')
      } else {
        return { ok: false, error: 'Nothing to add' }
      }

      // dedupe up front — adding a duplicate infohash to webtorrent is a FATAL
      // client error, so it must never reach client.add()
      const infoHash = magnet ? magnetInfoHash(magnet) : torrentInfoHash(torrentBuf!)
      if (torrentBuf && !infoHash) return { ok: false, error: 'Not a valid .torrent file' }
      if (infoHash) {
        const dupe = this.store.list().find((r) => r.info_hash === infoHash)
        if (dupe) return { ok: false, error: `Already in the list: ${dupe.name || infoHash}` }
      }

      const id = randomUUID()
      let torrentFile: string | null = null
      if (torrentBuf) {
        await fsp.mkdir(this.torrentDir, { recursive: true })
        torrentFile = join(this.torrentDir, `${id}.torrent`)
        await fsp.writeFile(torrentFile, torrentBuf)
        if (!name && input.fileName) name = input.fileName.replace(/\.torrent$/i, '')
      }
      await fsp.mkdir(savePath, { recursive: true })

      const row: TorrentRow = {
        id,
        info_hash: infoHash,
        name,
        magnet,
        torrent_file: torrentFile,
        save_path: savePath,
        status: 'downloading',
        error: null,
        total_bytes: null,
        downloaded_bytes: 0,
        uploaded_bytes: 0,
        files_json: null,
        added_at: Date.now(),
        completed_at: null
      }
      this.store.insert(row)
      await this.attach(row)
      this.notifyNow()
      return { ok: true, id }
    } catch (err) {
      return { ok: false, error: msg(err) }
    }
  }

  private async attach(row: TorrentRow): Promise<void> {
    const c = await this.client()
    const source = row.magnet ?? (await fsp.readFile(row.torrent_file!))
    const t = c.add(source, { path: row.save_path })
    this.live.set(row.id, t)

    t.on('infoHash', () => this.store.update(row.id, { info_hash: t.infoHash }))
    t.on('metadata', () => {
      this.store.update(row.id, {
        name: t.name,
        total_bytes: t.length,
        files_json: JSON.stringify(t.files.map((f) => ({ path: f.path, length: f.length })))
      })
      this.notifyNow()
    })
    t.on('done', () => {
      // 100% — persist the finished state, then kill the instance so we never
      // seed a completed torrent. Files stay on disk; the swarm loses us.
      this.store.update(row.id, {
        status: 'done',
        completed_at: Date.now(),
        name: t.name,
        total_bytes: t.length,
        downloaded_bytes: t.length,
        uploaded_bytes: Math.round(t.uploaded)
      })
      this.detach(row.id)
      this.notifyNow()
    })
    t.on('error', (err) => {
      this.store.update(row.id, { status: 'error', error: msg(err) })
      this.detach(row.id)
      this.notifyNow()
    })
    this.startTicker()
  }

  /** Drop the live instance (stops all transfer + closes files); row stays. */
  private detach(id: string): void {
    const t = this.live.get(id)
    if (!t) return
    this.live.delete(id)
    try {
      t.destroy()
    } catch {
      /* already destroyed */
    }
    this.stopTickerIfIdle()
  }

  async pause(id: string): Promise<void> {
    const row = this.store.get(id)
    if (!row || !this.live.has(id)) return
    this.persistLive(id)
    this.detach(id)
    this.store.update(id, { status: 'paused' })
    this.notifyNow()
  }

  async resume(id: string): Promise<void> {
    const row = this.store.get(id)
    if (!row || this.live.has(id) || row.status === 'done') return
    this.store.update(id, { status: 'downloading', error: null })
    try {
      await this.attach(this.store.get(id)!)
    } catch (err) {
      this.store.update(id, { status: 'error', error: msg(err) })
    }
    this.notifyNow()
  }

  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const row = this.store.get(id)
    if (!row) return
    const t = this.live.get(id)
    if (t) {
      this.live.delete(id)
      this.stopTickerIfIdle()
      const c = await this.client()
      await new Promise<void>((res) => c.remove(t, { destroyStore: deleteFiles }, () => res()))
    }
    if (deleteFiles && row.name) {
      // single-file torrents save as <dir>/<name>, multi-file as a <name>/ folder.
      // Runs even after destroyStore: webtorrent deletes the files but leaves
      // the empty content directory behind.
      await fsp.rm(join(row.save_path, row.name), { recursive: true, force: true }).catch(() => {})
    }
    if (row.torrent_file) await fsp.rm(row.torrent_file, { force: true }).catch(() => {})
    this.store.remove(id)
    this.notifyNow()
  }

  /** On-disk path of the torrent's content (for "open folder"). */
  contentPath(id: string): string | null {
    const row = this.store.get(id)
    if (!row) return null
    return row.name ? join(row.save_path, row.name) : row.save_path
  }

  list(): TorrentInfo[] {
    return this.store.list().map((r) => {
      const t = this.live.get(r.id)
      const total = t?.length || r.total_bytes || null
      const files = t?.files?.length ?? (r.files_json ? (JSON.parse(r.files_json) as unknown[]).length : null)
      return {
        id: r.id,
        name: t?.name || r.name || 'fetching metadata…',
        status: r.status as TorrentInfo['status'],
        infoHash: t?.infoHash || r.info_hash,
        savePath: r.save_path,
        totalBytes: total,
        downloadedBytes: t ? Math.round(t.downloaded) : r.downloaded_bytes,
        uploadedBytes: t ? Math.round(t.uploaded) : r.uploaded_bytes,
        progress: r.status === 'done' ? 1 : t ? t.progress : total ? r.downloaded_bytes / total : 0,
        downloadSpeed: t?.downloadSpeed ?? 0,
        uploadSpeed: t?.uploadSpeed ?? 0,
        numPeers: t?.numPeers ?? 0,
        etaSec: t && t.downloadSpeed > 0 && Number.isFinite(t.timeRemaining) ? Math.round(t.timeRemaining / 1000) : null,
        fileCount: files,
        hasMetadata: Boolean(t?.files?.length || r.files_json),
        error: r.error,
        addedAt: r.added_at,
        completedAt: r.completed_at
      }
    })
  }

  /** Snapshot a live torrent's counters into its row (survives restart/pause). */
  private persistLive(id: string): void {
    const t = this.live.get(id)
    if (!t) return
    this.store.update(id, {
      downloaded_bytes: Math.round(t.downloaded),
      uploaded_bytes: Math.round(t.uploaded),
      ...(t.name ? { name: t.name } : {}),
      ...(t.length ? { total_bytes: t.length } : {})
    })
  }

  private startTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => {
      this.tick++
      // persist counters every 5s so a crash loses at most a few seconds of accounting
      if (this.tick % 5 === 0) for (const id of this.live.keys()) this.persistLive(id)
      this.notifyNow()
    }, 1000)
  }

  private stopTickerIfIdle(): void {
    if (this.live.size === 0 && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  private notifyNow(): void {
    try {
      this.notify(this.list())
    } catch {
      /* window may be gone during shutdown */
    }
  }

  disposeAll(): void {
    for (const id of this.live.keys()) this.persistLive(id)
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.live.clear()
    if (this.clientP) {
      void this.clientP.then((c) => c.destroy()).catch(() => {})
      this.clientP = null
    }
  }
}

/** infohash out of a magnet URI (hex or base32 btih form). */
export function magnetInfoHash(magnet: string): string | null {
  const m = /urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})/.exec(magnet)
  if (!m) return null
  return m[1].length === 40 ? m[1].toLowerCase() : base32ToHex(m[1])
}

function base32ToHex(s: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s.toUpperCase()) {
    const idx = alphabet.indexOf(ch)
    if (idx < 0) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out).toString('hex')
}

/**
 * infohash of a .torrent buffer = sha1 of the bencoded `info` dict. A ~30-line
 * bencode walker keeps parse-torrent out of our direct dependencies; used only
 * for pre-add dedupe (webtorrent treats duplicate adds as a fatal client error).
 */
export function torrentInfoHash(buf: Buffer): string | null {
  try {
    // returns the end offset of the bencoded value starting at `pos`
    const end = (pos: number): number => {
      if (pos >= buf.length) throw new Error('truncated')
      const c = buf[pos]
      if (c === 0x64 /* d */ || c === 0x6c /* l */) {
        // dict entries are alternating string keys and values, so walking a
        // dict as a flat list of values is equivalent
        pos++
        while (buf[pos] !== 0x65 /* e */) pos = end(pos)
        return pos + 1
      }
      if (c === 0x69 /* i */) {
        const e = buf.indexOf(0x65, pos)
        if (e < 0) throw new Error('bad int')
        return e + 1
      }
      const colon = buf.indexOf(0x3a /* : */, pos)
      const len = Number(buf.toString('latin1', pos, colon))
      if (colon < 0 || !Number.isInteger(len) || len < 0) throw new Error('bad string')
      return colon + 1 + len
    }
    if (buf[0] !== 0x64) return null
    let pos = 1
    while (pos < buf.length && buf[pos] !== 0x65) {
      const colon = buf.indexOf(0x3a, pos)
      const klen = Number(buf.toString('latin1', pos, colon))
      if (colon < 0 || !Number.isInteger(klen) || klen < 0) return null
      const key = buf.toString('latin1', colon + 1, colon + 1 + klen)
      const vStart = colon + 1 + klen
      const vEnd = end(vStart)
      if (key === 'info') return createHash('sha1').update(buf.subarray(vStart, vEnd)).digest('hex')
      pos = vEnd
    }
    return null
  } catch {
    return null
  }
}
