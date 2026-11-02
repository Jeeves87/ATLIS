import { app } from 'electron'
import { promises as fsp } from 'fs'
import { join, basename, extname } from 'path'
import { randomUUID } from 'crypto'

/**
 * On-disk store for chat image attachments. Files live under
 * %APPDATA%/atlis/media/<uuid>.<ext> and are served to the renderer via the
 * `atlis-media://` protocol (registered in main/index.ts). Keeping the bytes on
 * disk keeps the SQLite DB and message rows small.
 */

export interface ImageAttachment {
  id: string
  kind: 'image'
  mime: string
  filename: string // basename on disk, also the atlis-media:// host
  name: string // original/display name
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg'
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}

export function mediaDir(): string {
  return join(app.getPath('userData'), 'media')
}

export function mimeForFilename(filename: string): string {
  const ext = extname(filename).slice(1).toLowerCase()
  return EXT_MIME[ext] ?? 'application/octet-stream'
}

/** Absolute path for a stored file, confined to the media dir (no traversal). */
export function pathForFilename(filename: string): string {
  const safe = basename(filename)
  return join(mediaDir(), safe)
}

/** Persist a base64-encoded image to disk and return its descriptor. */
export async function saveImage(input: { dataBase64: string; mime: string; name?: string }): Promise<ImageAttachment> {
  const dir = mediaDir()
  await fsp.mkdir(dir, { recursive: true })
  const ext = MIME_EXT[input.mime] ?? 'bin'
  const id = randomUUID()
  const filename = `${id}.${ext}`
  await fsp.writeFile(join(dir, filename), Buffer.from(input.dataBase64, 'base64'))
  return { id, kind: 'image', mime: input.mime, filename, name: input.name?.trim() || `image.${ext}` }
}

/** Read a stored image back as base64 (for sending to provider APIs). */
export async function readImageBase64(filename: string): Promise<{ mime: string; dataBase64: string }> {
  const buf = await fsp.readFile(pathForFilename(filename))
  return { mime: mimeForFilename(filename), dataBase64: buf.toString('base64') }
}

/** Best-effort delete of stored files (used when a message/session is removed). */
export async function deleteImages(filenames: string[]): Promise<void> {
  await Promise.all(filenames.map((f) => fsp.rm(pathForFilename(f), { force: true }).catch(() => {})))
}
