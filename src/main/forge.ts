/**
 * Play your decks in Forge.
 *
 * Forge (github.com/Card-Forge/forge, GPL-3, Java 17+) is the open-source
 * Magic engine with complete rules enforcement: the stack, priority, every
 * card scripted, loops and infinite combos, Commander with AI opponents and
 * card art. Writing a rules engine of our own that met "every rule must be
 * followed" would mean re-scripting hundreds of cards Forge already handles,
 * and a wrong rule taught is worse than none. So ATLIS does the parts Forge
 * doesn't: it finds the install, hands Forge the saved decks with their exact
 * printings, and launches it. Teaching lives in the renderer (PlayTab).
 *
 * Electron-free (paths, files and child processes only), so it can be
 * exercised headless like the rest of the MTG code.
 *
 * Facts this relies on, read from Forge's source (forge-2.0.15):
 *  - User data lives in %APPDATA%\Forge unless the install's
 *    res\forge.profile.properties overrides `userDir` / `decksDir`
 *    (ForgeProfileProperties.getDefaultDirs). Commander decks are read from
 *    <decksDir>\commander (ForgeConstants.DECK_COMMANDER_DIR).
 *  - A .dck file is INI-like: [metadata] Name=…, then [Commander] and [Main]
 *    sections of "N Card Name|SET" lines (DeckSection, DeckSerializer).
 *  - res\editions\*.txt carry Code= (Forge's set code) and ScryfallCode=.
 *  - The installer lays down forge.exe (launch4j, needs Java 17+), forge.cmd
 *    and forge-gui-desktop-*-jar-with-dependencies.jar.
 */
import { spawn, execFile } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import * as db from './db'
import * as mtg from './mtg'

const DIR_KEY = 'forge_install_dir'
/** Exported decks are prefixed so a re-export can replace exactly its own files. */
const PREFIX = 'ATLIS - '

export interface ForgeStatus {
  installDir: string | null
  /** True when installDir came from auto-detection rather than the user. */
  detected: boolean
  javaVersion: string | null
  /** Java major version, when it could be parsed. */
  javaMajor: number | null
  decksDir: string
  exported: string[]
  launchable: boolean
  latestRelease: string
}

const LATEST = 'https://github.com/Card-Forge/forge/releases/latest'

/** A folder is a Forge install if it has the launcher or the desktop jar, plus its card data. */
function isForgeDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
    const files = readdirSync(dir)
    const launcher = files.includes('forge.exe') || files.some((f) => /^forge-gui-desktop-.*jar-with-dependencies\.jar$/.test(f))
    return launcher && existsSync(join(dir, 'res', 'editions'))
  } catch {
    return false
  }
}

function candidates(): string[] {
  const home = homedir()
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const roots = ['C:\\Forge', 'C:\\Games\\Forge', join(home, 'Forge'), join(local, 'Programs', 'Forge'),
    'C:\\Program Files\\Forge', 'C:\\Program Files (x86)\\Forge', 'G:\\Forge', 'D:\\Forge']
  // The installer's default folder name carries the version ("forge-2.0.15").
  for (const parent of [home, join(home, 'Downloads'), join(home, 'Desktop'), 'C:\\', 'G:\\', 'G:\\Games']) {
    try {
      for (const f of readdirSync(parent)) if (/^forge/i.test(f)) roots.push(join(parent, f))
    } catch {
      // folder missing or unreadable
    }
  }
  return roots
}

export function installDir(): { dir: string | null; detected: boolean } {
  const saved = db.getSetting(DIR_KEY)
  if (saved && isForgeDir(saved)) return { dir: saved, detected: false }
  const found = candidates().find(isForgeDir) ?? null
  return { dir: found, detected: found != null }
}

/** Remember a folder the user picked; false if it isn't a Forge install. */
export function setInstallDir(dir: string): boolean {
  if (!isForgeDir(dir)) return false
  db.setSetting(DIR_KEY, dir)
  return true
}

/** forge.profile.properties may move the user/deck folders; honour it like Forge does. */
function decksBase(dir: string | null): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  let userDir = join(appData, 'Forge')
  let decksDir: string | null = null
  if (dir) {
    for (const p of [join(dir, 'res', 'forge.profile.properties'), join(dir, 'forge.profile.properties')]) {
      try {
        for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
          const m = /^\s*(userDir|decksDir)\s*=\s*(.+?)\s*$/.exec(line)
          // Java properties escape backslashes.
          if (m?.[1] === 'userDir') userDir = m[2].replace(/\\\\/g, '\\')
          if (m?.[1] === 'decksDir') decksDir = m[2].replace(/\\\\/g, '\\')
        }
      } catch {
        // no profile file: defaults apply
      }
    }
  }
  return join(decksDir ?? join(userDir, 'decks'), 'commander')
}

/**
 * The java.exe to use. PATH alone isn't enough: a Java installed while ATLIS
 * is running is invisible to it, because Windows hands the new PATH and
 * JAVA_HOME only to programs started afterwards. So the vendors' standard
 * install folders are searched too, newest version first.
 */
export function javaExe(): string {
  const javaHome = process.env.JAVA_HOME
  if (javaHome && existsSync(join(javaHome, 'bin', 'java.exe'))) return join(javaHome, 'bin', 'java.exe')
  const roots = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto']
    .flatMap((v) => [join('C:\\Program Files', v), join('C:\\Program Files (x86)', v)])
  const found: string[] = []
  for (const root of roots) {
    try {
      for (const d of readdirSync(root)) {
        const exe = join(root, d, 'bin', 'java.exe')
        if (existsSync(exe)) found.push(exe)
      }
    } catch {
      // vendor not installed
    }
  }
  // Folder names carry the version (jre-21.0.12…, jdk-17…); numeric sort puts the newest first.
  found.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return found[0] ?? 'java'
}

/** Where ATLIS writes and Forge reads Commander decks. */
export function commanderDecksDir(): string {
  return decksBase(installDir().dir)
}

function javaVersion(): Promise<string | null> {
  const exe = javaExe()
  return new Promise((resolve) => {
    // `java -version` prints to stderr.
    execFile(exe, ['-version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stderr) return resolve(null)
      const m = /version "([^"]+)"/.exec(`${stderr}${stdout}`)
      resolve(m ? m[1] : null)
    })
  })
}

const javaMajor = (v: string | null): number | null => {
  if (!v) return null
  const parts = v.split('.')
  const n = Number(parts[0] === '1' ? parts[1] : parts[0])
  return Number.isFinite(n) ? n : null
}

function exportedFiles(decksDir: string): string[] {
  try {
    return readdirSync(decksDir).filter((f) => f.startsWith(PREFIX) && f.endsWith('.dck')).map((f) => f.slice(PREFIX.length, -4))
  } catch {
    return []
  }
}

export async function status(): Promise<ForgeStatus> {
  const { dir, detected } = installDir()
  const v = await javaVersion()
  const major = javaMajor(v)
  const decksDir = decksBase(dir)
  // forge.exe finds Java itself (launch4j); without it we need java on PATH.
  const launchable = !!dir && (existsSync(join(dir, 'forge.exe')) || (major != null && major >= 17))
  return { installDir: dir, detected, javaVersion: v, javaMajor: major, decksDir, exported: exportedFiles(decksDir), launchable, latestRelease: LATEST }
}

/** Forge set code (lowercase) → Scryfall set code: the reverse of editionMap, for showing art. */
export function forgeToScryfallSets(): Map<string, string> {
  const out = new Map<string, string>()
  for (const [sf, forgeCode] of editionMap(installDir().dir)) out.set(forgeCode.toLowerCase(), sf)
  return out
}

/** Scryfall set code → Forge set code, from the install's own edition files. */
function editionMap(dir: string | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!dir) return out
  const edDir = join(dir, 'res', 'editions')
  let files: string[] = []
  try { files = readdirSync(edDir) } catch { return out }
  for (const f of files) {
    if (!f.endsWith('.txt')) continue
    try {
      // Only the [metadata] block matters; it sits at the top.
      const head = readFileSync(join(edDir, f), 'utf8').slice(0, 1500)
      const code = /^Code=(.+)$/m.exec(head)?.[1]?.trim()
      const sf = /^ScryfallCode=(.+)$/m.exec(head)?.[1]?.trim() ?? code
      if (code && sf) out.set(sf.toLowerCase(), code)
    } catch {
      // unreadable edition file: skip
    }
  }
  return out
}

/**
 * Forge names double-faced and adventure cards by their front face, and split
 * cards ("Fire // Ice") by both halves — the Scryfall layout says which.
 */
function forgeName(name: string, layout: string | undefined): string {
  if (!name.includes(' // ')) return name
  return layout === 'split' || layout === 'aftermath' ? name : name.split(' // ')[0]
}

const safeFile = (s: string): string => s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

export interface ExportResult {
  decksDir: string
  written: string[]
  /** Saved-deck id → the .dck file written for it. */
  files: Record<string, string>
  skipped: Array<{ name: string; reason: string }>
  /** Cards exported without a set because Forge's editions didn't know theirs. */
  unmatchedSets: number
  /**
   * Set when Scryfall couldn't be reached: decks kept their last export
   * instead of being rewritten, and ones never exported are in `skipped`.
   */
  offline?: string
}

/** The .dck file a saved deck is (or would be) exported as. */
export function deckFile(name: string): string {
  return join(decksBase(installDir().dir), `${PREFIX}${safeFile(name)}.dck`)
}

/**
 * Saved decks that can be played (they have a commander), with the file each
 * exports to — straight from the database, no Scryfall and no writing, so a
 * deck list costs nothing no matter how many decks there are.
 */
export function playableDecks(): Array<{ deckId: string; name: string; path: string }> {
  const crowned = new Set(db.listMtgDeckCards().filter((c) => c.board === 'commander').map((c) => c.deck_id))
  return db.listMtgDecks().filter((d) => crowned.has(d.id)).map((d) => ({ deckId: d.id, name: d.name, path: deckFile(d.name) }))
}

// What each deck's file was last written from, so an unchanged deck isn't
// looked up on Scryfall and rewritten again.
const EXPORT_SIG_KEY = 'forge_export_sigs'

function exportSignature(rows: db.MtgDeckCard[], editions: Map<string, string>, forgeDir: string | null): string {
  const lines = rows.map((r) => `${r.board}|${r.quantity}|${r.name}|${r.ext_id ?? ''}`).sort()
  return createHash('sha1').update(JSON.stringify([forgeDir, editions.size, lines])).digest('hex')
}

/**
 * Write saved decks that have a commander into Forge's commander deck folder.
 * `only` limits it to those deck ids — what a game start uses, so starting a
 * game costs the decks at the table, not the whole collection. A deck whose
 * cards haven't changed since its file was written is left as it is.
 *
 * A full export (no `only`) also removes files ATLIS wrote before that no
 * longer match a deck; files the user made in Forge are never touched.
 */
export async function exportDecks(opts: { only?: string[]; force?: boolean } = {}): Promise<ExportResult> {
  const { dir } = installDir()
  const decksDir = decksBase(dir)
  mkdirSync(decksDir, { recursive: true })
  const editions = editionMap(dir)

  const only = opts.only ? new Set(opts.only) : null
  const all = db.listMtgDecks().filter((d) => !only || only.has(d.id))
  const allRows = new Map<string, db.MtgDeckCard[]>()
  for (const c of db.listMtgDeckCards()) allRows.set(c.deck_id, [...(allRows.get(c.deck_id) ?? []), c])
  let sigs: Record<string, string> = {}
  try { sigs = JSON.parse(db.getSetting(EXPORT_SIG_KEY) || '{}') as Record<string, string> } catch { /* rebuild */ }
  const sigOf = new Map(all.map((d) => [d.id, exportSignature(allRows.get(d.id) ?? [], editions, dir)]))
  const fresh = (d: db.MtgDeck): boolean =>
    !opts.force && sigs[d.id] === sigOf.get(d.id) && existsSync(join(decksDir, `${PREFIX}${safeFile(d.name)}.dck`))
  // Only decks that actually need writing go to Scryfall.
  const rowsByDeck = new Map<string, db.MtgDeckCard[]>()
  for (const d of all) if (!fresh(d)) rowsByDeck.set(d.id, allRows.get(d.id) ?? [])

  // One Scryfall pass for every printing: set code and layout for each line,
  // and a printing for cards stored by name only.
  // Without it (offline, DNS down, Scryfall having a bad day) the names and
  // sets can't be written correctly, so each deck keeps the file it was last
  // exported as rather than taking the whole deck list down with it.
  const ids = [...new Set([...rowsByDeck.values()].flat().map((c) => c.ext_id).filter((x): x is string => !!x))]
  let byId = new Map<string, mtg.ScryfallCard>()
  const byName = new Map<string, mtg.ScryfallCard>()
  let offline: string | undefined
  try {
    if (ids.length) byId = await mtg.cardsByIds(ids)
    const nameOnly = [...new Set([...rowsByDeck.values()].flat().filter((c) => !c.ext_id || !byId.has(c.ext_id)).map((c) => c.name))]
    if (nameOnly.length) {
      const r = await mtg.cardsByNames(nameOnly)
      for (const c of r.found) byName.set(db.cardNameKey(c.name), c)
    }
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code
    offline = `Scryfall couldn't be reached${cause ? ` (${cause})` : ''}`
  }

  const written: string[] = []
  const files: Record<string, string> = {}
  const skipped: ExportResult['skipped'] = []
  let unmatchedSets = 0
  const line = (c: db.MtgDeckCard): string => {
    const card = (c.ext_id ? byId.get(c.ext_id) : undefined) ?? byName.get(c.name_key)
    const layout = (card as { layout?: string } | undefined)?.layout
    const name = forgeName(card?.name ?? c.name, layout)
    const set = card?.set ? editions.get(card.set.toLowerCase()) : undefined
    if (!set) unmatchedSets += c.quantity
    return `${c.quantity} ${name}${set ? `|${set}` : ''}`
  }

  for (const d of all) {
    const rows = allRows.get(d.id) ?? []
    const commanders = rows.filter((r) => r.board === 'commander')
    if (!commanders.length) { skipped.push({ name: d.name, reason: 'no commander set' }); continue }
    const fileBase = safeFile(d.name)
    const file = join(decksDir, `${PREFIX}${fileBase}.dck`)
    if (fresh(d)) {
      written.push(fileBase)
      files[d.id] = file
      continue
    }
    if (offline) {
      if (existsSync(file)) {
        written.push(fileBase)
        files[d.id] = file
      } else {
        skipped.push({ name: d.name, reason: `${offline}, and it hasn't been exported before` })
      }
      continue
    }
    const text = [
      '[metadata]',
      `Name=${PREFIX}${d.name}`,
      '[Commander]',
      ...commanders.map(line),
      '[Main]',
      ...rows.filter((r) => r.board === 'main').map(line),
      ''
    ].join('\r\n')
    writeFileSync(file, text, 'utf8')
    written.push(fileBase)
    files[d.id] = file
    sigs[d.id] = sigOf.get(d.id) as string
  }
  db.setSetting(EXPORT_SIG_KEY, JSON.stringify(sigs))

  // Remove ATLIS exports for decks that were renamed or deleted. Only on a
  // full export: a partial one doesn't know about the decks it left out.
  if (!only) {
    for (const old of exportedFiles(decksDir)) {
      if (!written.includes(old)) {
        try { unlinkSync(join(decksDir, `${PREFIX}${old}.dck`)) } catch { /* in use or gone */ }
      }
    }
  }
  return { decksDir, written, files, skipped, unmatchedSets, offline }
}

/** Start Forge detached, so closing ATLIS doesn't close the game. */
export function launch(): { ok: boolean; message: string } {
  const { dir } = installDir()
  if (!dir) return { ok: false, message: 'Forge isn’t installed yet — follow the setup steps first.' }
  const exe = join(dir, 'forge.exe')
  const jar = readdirSync(dir).find((f) => /^forge-gui-desktop-.*jar-with-dependencies\.jar$/.test(f))
  const java = javaExe()
  // forge.exe looks for Java with ATLIS's environment, which predates a Java
  // installed while ATLIS was running, and then reports "needs Java 17". So
  // when the Java we found is a real path, run the jar with it directly,
  // using the same JVM options as Forge's own forge.cmd.
  const javaHome = java === 'java' ? null : join(java, '..', '..')
  const env = javaHome
    ? { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')};${process.env.PATH ?? ''}` }
    : process.env
  try {
    const child = jar && javaHome
      ? spawn(java, ['-Xmx4096m', '-Dio.netty.tryReflectionSetAccessible=true', '-Dfile.encoding=UTF-8', '-jar', jar],
        { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true, env })
      : existsSync(exe)
        ? spawn(exe, [], { cwd: dir, detached: true, stdio: 'ignore', env })
        : jar
          ? spawn(java, ['-Xmx4096m', '-Dio.netty.tryReflectionSetAccessible=true', '-Dfile.encoding=UTF-8', '-jar', jar],
            { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true, env })
          : null
    if (!child) return { ok: false, message: 'Found the Forge folder but no forge.exe or desktop jar inside it.' }
    child.on('error', () => undefined)
    child.unref()
    return { ok: true, message: 'Forge is starting — it takes 20–40 seconds to load its card database.' }
  } catch (e) {
    return { ok: false, message: `Couldn’t start Forge: ${e instanceof Error ? e.message : String(e)}` }
  }
}
