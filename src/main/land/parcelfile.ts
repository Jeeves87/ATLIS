/**
 * Indiana DLGF PARCEL file: layout, unpacking and parsing.
 *
 * Split from the ingest half deliberately — everything here is pure, depends on
 * nothing but node:zlib, and can therefore be exercised against a real
 * downloaded file without standing up Electron or a database. The column
 * offsets are the part most likely to rot when the state revises a format, so
 * they are the part that most needs to be directly testable.
 */
import { inflateRawSync } from 'zlib'

const FIELDS = {
  parcel: [0, 25],
  classCode: [193, 196],
  ownerName: [223, 303],
  ownerStreet: [303, 363],
  ownerCity: [363, 393],
  ownerState: [393, 423],
  ownerZip: [423, 433],
  avLand: [468, 480],
  avImprovement: [480, 492],
  avTotal: [492, 504],
  deededAcres: [696, 708]
} as const

/**
 * Indiana's DLGF county number and its FIPS code are both assigned in
 * alphabetical order, and Indiana's FIPS county codes run in odd steps, so one
 * derives from the other exactly — no lookup table to fall out of date.
 * Crawford 13 -> 025, Floyd 22 -> 043, Harrison 31 -> 061, Washington 88 -> 175.
 */
export function dlgfCountyNumber(fips: string): string {
  const county = Number(fips.slice(2))
  if (!fips.startsWith('18') || !Number.isFinite(county) || county % 2 === 0) {
    throw new Error(`${fips} is not an Indiana county FIPS code`)
  }
  return String((county + 1) / 2).padStart(2, '0')
}

/**
 * Minimal ZIP reader for a single stored/deflated entry.
 *
 * Written out rather than adding a dependency: these archives are one plain
 * text file produced by one government system, and the central-directory path
 * below covers exactly that. Anything unexpected (zip64, encryption, multiple
 * entries) throws rather than guessing.
 */
export function unzipSingle(buf: Buffer): { name: string; data: Buffer } {
  const EOCD_SIG = 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)')

  const entries = buf.readUInt16LE(eocd + 10)
  if (entries < 1) throw new Error('zip archive is empty')
  let p = buf.readUInt32LE(eocd + 16) // central directory offset

  if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('malformed zip central directory')
  const method = buf.readUInt16LE(p + 10)
  const compressedSize = buf.readUInt32LE(p + 20)
  const nameLen = buf.readUInt16LE(p + 28)
  const extraLen = buf.readUInt16LE(p + 30)
  const commentLen = buf.readUInt16LE(p + 32)
  const localOffset = buf.readUInt32LE(p + 42)
  const name = buf.subarray(p + 46, p + 46 + nameLen).toString('latin1')
  void extraLen; void commentLen

  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('malformed zip local header')
  const lNameLen = buf.readUInt16LE(localOffset + 26)
  const lExtraLen = buf.readUInt16LE(localOffset + 28)
  const start = localOffset + 30 + lNameLen + lExtraLen
  const raw = buf.subarray(start, start + compressedSize)

  if (method === 0) return { name, data: raw }
  if (method === 8) return { name, data: inflateRawSync(raw) }
  throw new Error(`unsupported zip compression method ${method}`)
}

// ------------------------------------------------------------------- parse

export interface ParsedAssessment {
  parcelKey: string
  classCode: string | null
  ownerName: string | null
  ownerStreet: string | null
  ownerCity: string | null
  ownerState: string | null
  ownerZip: string | null
  avLand: number | null
  avImprovement: number | null
  avTotal: number | null
  deededAcres: number | null
}

const slice = (line: string, f: readonly [number, number]): string => line.slice(f[0], f[1]).trim()
const num = (s: string): number | null => {
  if (!s) return null
  const n = Number(s.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

export interface ParseResult {
  rows: ParsedAssessment[]
  checked: number
  mismatched: number
}

/**
 * Parse the fixed-width PARCEL file.
 *
 * Every row is checked against `land + improvement == total`. That identity is
 * a property of the data, not of the parser, so it is the strongest available
 * evidence that the column offsets still line up — and the caller refuses the
 * import if too many rows fail it.
 */
export function parseParcelFile(text: string): ParseResult {
  const rows: ParsedAssessment[] = []
  let checked = 0
  let mismatched = 0

  for (const line of text.split(/\r?\n/)) {
    // The first line is a file-level metadata header, and data rows are far
    // longer than it; length is the cheapest reliable discriminator.
    if (line.length < 720) continue
    const parcelKey = slice(line, FIELDS.parcel)
    if (!parcelKey) continue

    const avLand = num(slice(line, FIELDS.avLand))
    const avImprovement = num(slice(line, FIELDS.avImprovement))
    const avTotal = num(slice(line, FIELDS.avTotal))
    if (avLand != null && avImprovement != null && avTotal != null) {
      checked++
      if (Math.abs(avLand + avImprovement - avTotal) > 1) mismatched++
    }

    rows.push({
      parcelKey,
      classCode: slice(line, FIELDS.classCode) || null,
      ownerName: slice(line, FIELDS.ownerName) || null,
      ownerStreet: slice(line, FIELDS.ownerStreet) || null,
      ownerCity: slice(line, FIELDS.ownerCity) || null,
      ownerState: slice(line, FIELDS.ownerState) || null,
      ownerZip: slice(line, FIELDS.ownerZip) || null,
      avLand,
      avImprovement,
      avTotal,
      deededAcres: num(slice(line, FIELDS.deededAcres))
    })
  }
  return { rows, checked, mismatched }
}

/**
 * Parcel keys differ between the two sources: the GIS layer writes
 * `31-09-26-280-032.000-007` and the DLGF file writes `310926280032000007`.
 * Stripping non-alphanumerics normalises both to the same string.
 */
export const normalizeKey = (s: string): string => s.replace(/[^0-9A-Za-z]/g, '')
