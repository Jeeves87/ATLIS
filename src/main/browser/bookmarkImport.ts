import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logLine } from '../log'

/**
 * Bookmark import from the Mozilla family — Firefox and its forks, Zen included.
 * They all keep bookmarks in the same `places.sqlite` under a profile directory,
 * so one reader covers the lot; only the app folder name differs.
 */

/** Roaming-appdata folder name -> display name. Windows layout; ATLIS ships --win. */
const FAMILY: { dir: string; browser: string }[] = [
  { dir: 'zen', browser: 'Zen' },
  { dir: join('Mozilla', 'Firefox'), browser: 'Firefox' },
  { dir: 'librewolf', browser: 'LibreWolf' },
  { dir: 'Waterfox', browser: 'Waterfox' },
  { dir: 'Floorp', browser: 'Floorp' }
]

/** The four user-visible bookmark roots, keyed by their fixed guids. */
const ROOT_NAMES: Record<string, string> = {
  toolbar_____: 'Bookmarks Toolbar',
  menu________: 'Bookmarks Menu',
  unfiled_____: 'Other Bookmarks',
  mobile______: 'Mobile Bookmarks'
}

export interface BookmarkSource {
  /** Absolute profile directory — the handle the tree read takes back. */
  path: string
  browser: string
  profile: string
  /** The profile that browser actually launches into. */
  isDefault: boolean
  count: number
  lastUsed: number
}

export interface BookmarkNode {
  id: string
  type: 'folder' | 'link'
  title: string
  url?: string
  count: number
  children?: BookmarkNode[]
}

interface Row {
  id: number
  parent: number
  type: number
  title: string | null
  guid: string
  url: string | null
}

/**
 * Open a throwaway copy of a profile's places.sqlite.
 *
 * Two reasons never to touch the original: the browser may be running and
 * holding it, and a WAL database can only be read after its journal is replayed
 * — which is a *write*. Copying all three files and opening the copy read-write
 * lets SQLite do that recovery against scratch data, so the user's real profile
 * is never opened, locked, or modified.
 */
function withPlaces<T>(profilePath: string, fn: (db: DatabaseSync) => T): T {
  const src = join(profilePath, 'places.sqlite')
  if (!existsSync(src)) throw new Error(`No places.sqlite in ${profilePath}`)
  const dir = mkdtempSync(join(tmpdir(), 'atlis-places-'))
  try {
    for (const ext of ['', '-wal', '-shm']) {
      if (existsSync(src + ext)) copyFileSync(src + ext, join(dir, `places.sqlite${ext}`))
    }
    const db = new DatabaseSync(join(dir, 'places.sqlite'))
    try {
      return fn(db)
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Minimal INI reader — profiles.ini is flat sections of key=value. */
function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1)
      out[section] = {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0 || !section) continue
    out[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/**
 * Which profile the browser actually opens. The `[InstallXXXX] Default=` key is
 * authoritative for modern Firefox; the legacy `Default=1` flag on a profile
 * section is only a fallback, and on a machine that has ever had two profiles it
 * routinely points at an empty one.
 */
function defaultProfilePath(ini: Record<string, Record<string, string>>): string | null {
  for (const [name, sec] of Object.entries(ini)) {
    if (name.startsWith('Install') && sec.Default) return sec.Default.replace(/\//g, '\\')
  }
  for (const [name, sec] of Object.entries(ini)) {
    if (name.startsWith('Profile') && sec.Default === '1' && sec.Path) return sec.Path.replace(/\//g, '\\')
  }
  return null
}

/** Every Mozilla-family profile on this machine that actually holds bookmarks. */
export function discoverBookmarkSources(): BookmarkSource[] {
  const appData = app.getPath('appData')
  const found: BookmarkSource[] = []

  for (const { dir, browser } of FAMILY) {
    const root = join(appData, dir)
    if (!existsSync(root)) continue

    const iniPath = join(root, 'profiles.ini')
    const ini = existsSync(iniPath) ? parseIni(readFileSync(iniPath, 'utf8')) : {}
    const wantDefault = defaultProfilePath(ini)

    // profiles.ini is the good path; fall back to scanning Profiles/ so a
    // hand-moved or portable install still turns up.
    const entries = Object.entries(ini)
      .filter(([name, sec]) => name.startsWith('Profile') && sec.Path)
      .map(([, sec]) => ({ name: sec.Name || sec.Path, rel: sec.Path.replace(/\//g, '\\') }))
    if (!entries.length && existsSync(join(root, 'Profiles'))) {
      for (const d of readdirSync(join(root, 'Profiles'))) entries.push({ name: d, rel: join('Profiles', d) })
    }

    for (const e of entries) {
      const path = join(root, e.rel)
      const places = join(path, 'places.sqlite')
      if (!existsSync(places)) continue
      let count = 0
      try {
        count = withPlaces(path, (db) => {
          const r = db
            .prepare(
              `SELECT COUNT(*) n FROM moz_bookmarks b
               JOIN moz_places p ON p.id = b.fk
               WHERE b.type = 1 AND p.url NOT LIKE 'place:%'`
            )
            .get() as { n: number }
          return r?.n ?? 0
        })
      } catch (err) {
        // A profile we can't read is worth a log line but must not sink the scan.
        logLine('bookmarks.import', `skipped ${path}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (!count) continue
      found.push({
        path,
        browser,
        profile: e.name,
        isDefault: !!wantDefault && e.rel.toLowerCase() === wantDefault.toLowerCase(),
        count,
        lastUsed: statSync(places).mtimeMs
      })
    }
  }

  // Most-recently-used first — that is almost always the one being imported.
  return found.sort((a, b) => b.lastUsed - a.lastUsed)
}

/**
 * The profile's bookmark tree, as the four roots with their folders nested
 * beneath. Tag containers and `place:` smart bookmarks (saved searches, "most
 * visited") are dropped — they are queries, not addresses ATLIS could open.
 */
export function readBookmarkTree(profilePath: string): BookmarkNode[] {
  return withPlaces(profilePath, (db) => {
    const rows = db
      .prepare(
        `SELECT b.id, b.parent, b.type, b.title, b.guid, p.url
         FROM moz_bookmarks b
         LEFT JOIN moz_places p ON p.id = b.fk
         WHERE b.type IN (1, 2)
         ORDER BY b.parent, b.position`
      )
      .all() as unknown as Row[]

    const byParent = new Map<number, Row[]>()
    const roots: Row[] = []
    for (const r of rows) {
      if (ROOT_NAMES[r.guid]) roots.push(r)
      const list = byParent.get(r.parent)
      if (list) list.push(r)
      else byParent.set(r.parent, [r])
    }

    const build = (row: Row): BookmarkNode | null => {
      if (row.type === 1) {
        if (!row.url || row.url.startsWith('place:')) return null
        return { id: String(row.id), type: 'link', title: row.title || row.url, url: row.url, count: 1 }
      }
      const children = (byParent.get(row.id) ?? []).map(build).filter((n): n is BookmarkNode => n !== null)
      const count = children.reduce((n, c) => n + c.count, 0)
      // An empty folder is noise in a picker — nothing to tick, nothing to import.
      if (!count) return null
      return {
        id: String(row.id),
        type: 'folder',
        title: row.title || '(untitled folder)',
        count,
        children
      }
    }

    return roots
      .map((r) => {
        const node = build(r)
        return node ? { ...node, title: ROOT_NAMES[r.guid] } : null
      })
      .filter((n): n is BookmarkNode => n !== null)
  })
}
