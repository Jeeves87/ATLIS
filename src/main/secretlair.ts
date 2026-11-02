import * as db from './db'

/**
 * Announced-but-unreleased Secret Lair drops.
 *
 * WHY NOT THE STORE ITSELF: secretlair.wizards.com is fully client-rendered
 * and only ever shows what is on sale RIGHT NOW — by the time a drop appears
 * there, the window to plan around it has closed. Its "Upcoming Events" section
 * is an empty header. The useful signal (name, superdrop, release date, MSRP)
 * is published ahead of time and Lair Tracker collects it, exposing the list at
 * a keyless JSON endpoint that its own front page calls.
 *
 * THAT ENDPOINT IS UNDOCUMENTED, exactly like TCGplayer's pricepoints route:
 * no stability or auth guarantee. Everything here therefore degrades to "no
 * data" rather than throwing, the table keeps its last good contents on a
 * failed sync, and nothing else in the app depends on it. Their robots.txt
 * allows this path; the sync runs twice a day, which is far below what a person
 * refreshing the page would do.
 */
const API = 'https://www.lairtracker.com/api/upcoming-secret-lairs'
const UA = 'ATLIS/1.0 (personal MTG collection tracker)'

interface ApiLair {
  id?: number | string
  slKey?: string
  name?: string
  picture?: string | null
  releaseDate?: string | null
  /** Cents. */
  msrp?: number | null
  foil?: boolean
  etched?: boolean
  isRandomizedPack?: boolean
  dropId?: string | null
  Drop?: { id?: string; name?: string; releaseDate?: string | null } | null
}

/**
 * Upstream dates are midnight UTC stamps standing for a calendar day. Reading
 * them with the local clock would shift a release a day earlier for anyone west
 * of UTC, so the day is taken straight off the ISO string.
 */
function ymd(iso: string | null | undefined): string | null {
  if (!iso) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1] : null
}

export interface SecretLairSyncResult {
  count: number
  drops: number
  note: string | null
}

/** Pull the announced list and mirror it into the local table. */
export async function syncUpcoming(): Promise<SecretLairSyncResult> {
  let payload: { lairs?: ApiLair[] }
  try {
    const r = await fetch(API, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    payload = (await r.json()) as { lairs?: ApiLair[] }
  } catch (err) {
    // Keep whatever is already cached; a failed sync is not an empty list.
    return {
      count: db.listUpcomingSecretLair().length,
      drops: 0,
      note: `Could not reach the Secret Lair feed (${err instanceof Error ? err.message : String(err)}). Showing the last known list.`
    }
  }

  const lairs = Array.isArray(payload.lairs) ? payload.lairs : []
  if (!lairs.length) {
    return { count: 0, drops: 0, note: 'The Secret Lair feed returned nothing — no drops announced right now.' }
  }

  const rows = lairs
    .filter((l) => l.name)
    .map((l) => ({
      id: String(l.id ?? l.slKey ?? l.name),
      drop_id: l.dropId ?? l.Drop?.id ?? null,
      drop_name: l.Drop?.name ?? null,
      drop_release_date: ymd(l.Drop?.releaseDate),
      name: String(l.name),
      picture: l.picture ?? null,
      release_date: ymd(l.releaseDate) ?? ymd(l.Drop?.releaseDate),
      // MSRP arrives in cents; the rest of the app talks dollars.
      msrp: typeof l.msrp === 'number' ? Math.round(l.msrp) / 100 : null,
      foil: l.foil ? 1 : 0,
      etched: l.etched ? 1 : 0,
      randomized: l.isRandomizedPack ? 1 : 0
    }))

  db.replaceUpcomingSecretLair(rows)
  const drops = new Set(rows.map((r) => r.drop_id ?? r.name)).size
  return { count: rows.length, drops, note: null }
}

export interface SecretLairDropGroup {
  dropId: string
  dropName: string
  releaseDate: string | null
  msrpTotal: number
  items: db.MtgSlUpcoming[]
}

/**
 * Grouped by superdrop, which is how they are sold and announced — a superdrop
 * is a dozen lairs sharing one on-sale date, and listing them flat buries that.
 */
export function upcomingByDrop(): SecretLairDropGroup[] {
  const groups = new Map<string, SecretLairDropGroup>()
  for (const row of db.listUpcomingSecretLair()) {
    const key = row.drop_id ?? row.name
    let g = groups.get(key)
    if (!g) {
      g = {
        dropId: key,
        dropName: row.drop_name ?? row.name,
        releaseDate: row.drop_release_date ?? row.release_date,
        msrpTotal: 0,
        items: []
      }
      groups.set(key, g)
    }
    g.items.push(row)
    g.msrpTotal = Math.round((g.msrpTotal + (row.msrp ?? 0)) * 100) / 100
  }
  return [...groups.values()].sort((a, b) => (a.releaseDate ?? '').localeCompare(b.releaseDate ?? ''))
}
