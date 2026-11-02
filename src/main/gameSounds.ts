/**
 * Sound effects for the ATLIS game table.
 *
 * Two libraries feed it: the sounds that ship with the user's Forge install
 * (res/sound/*.mp3, played in place, never copied) and the user's own files,
 * copied into userData/game-sounds so they survive the original moving.
 * Which sound plays for which table event is a JSON blob in settings; the
 * event catalogue itself lives in the renderer, which is the side that knows
 * what happened on the table.
 *
 * The table's look (playmat) lives here too: the same settings-blob pattern,
 * and playmat images the user adds are copied into userData/table-mats.
 *
 * Files reach the renderer through atlis-sound://forge/<file>,
 * atlis-sound://custom/<file> and atlis-sound://mat/<file>; all basename the
 * request so it can't leave its folder.
 */
import { app, protocol } from 'electron'
import { existsSync, mkdirSync, promises as fsp, readdirSync } from 'fs'
import { basename, extname, join } from 'path'
import * as db from './db'
import { installDir } from './forge'

const SETTINGS_KEY = 'game_sounds'
const LOOK_KEY = 'game_table_look'
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm'])
const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'audio/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif'
}

function customDir(): string {
  const dir = join(app.getPath('userData'), 'game-sounds')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function matDir(): string {
  const dir = join(app.getPath('userData'), 'table-mats')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function forgeDir(): string | null {
  const dir = installDir().dir
  return dir ? join(dir, 'res', 'sound') : null
}

function listFiles(dir: string | null, exts = AUDIO_EXT): string[] {
  if (!dir || !existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => exts.has(extname(f).toLowerCase())).sort()
  } catch {
    return []
  }
}

export interface SoundLibrary {
  /** Saved choices (opaque to main), or null for "never configured". */
  settings: unknown
  forge: string[]
  custom: string[]
}

export function library(): SoundLibrary {
  let settings: unknown = null
  try {
    const raw = db.getSetting(SETTINGS_KEY)
    settings = raw ? JSON.parse(raw) : null
  } catch {
    settings = null
  }
  return { settings, forge: listFiles(forgeDir()), custom: listFiles(customDir()) }
}

export function save(settings: unknown): void {
  db.setSetting(SETTINGS_KEY, JSON.stringify(settings ?? null))
}

export function lookGet(): { look: unknown; mats: string[] } {
  let look: unknown = null
  try {
    const raw = db.getSetting(LOOK_KEY)
    look = raw ? JSON.parse(raw) : null
  } catch {
    look = null
  }
  return { look, mats: listFiles(matDir(), IMAGE_EXT) }
}

export function lookSave(look: unknown): void {
  db.setSetting(LOOK_KEY, JSON.stringify(look ?? null))
}

export function importMats(paths: string[]): Promise<string[]> {
  return importFiles(paths, matDir(), IMAGE_EXT)
}

export async function removeMat(name: string): Promise<void> {
  await fsp.rm(join(matDir(), basename(name)), { force: true })
}

/** Copy the user's picked files in; returns the stored names (deduped by suffix). */
export async function importFiles(paths: string[], dir = customDir(), exts = AUDIO_EXT): Promise<string[]> {
  const out: string[] = []
  for (const src of paths) {
    const ext = extname(src).toLowerCase()
    if (!exts.has(ext)) continue
    const stem = basename(src, extname(src)).replace(/[^\w\- ]+/g, '').trim() || 'sound'
    let name = `${stem}${ext}`
    for (let i = 2; existsSync(join(dir, name)); i++) name = `${stem} ${i}${ext}`
    await fsp.copyFile(src, join(dir, name))
    out.push(name)
  }
  return out
}

export async function removeCustom(name: string): Promise<void> {
  await fsp.rm(join(customDir(), basename(name)), { force: true })
}

export const SCHEME = 'atlis-sound'

export function registerProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const name = basename(decodeURIComponent(url.pathname))
    const dir = url.hostname === 'forge' ? forgeDir() : url.hostname === 'custom' ? customDir() : url.hostname === 'mat' ? matDir() : null
    if (!dir || !name) return new Response('Not found', { status: 404 })
    try {
      const buf = await fsp.readFile(join(dir, name))
      return new Response(buf, { status: 200, headers: { 'Content-Type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream' } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
