/**
 * Read-only SQL over ATLIS's own database, for the agent.
 *
 * WHY RAW SQL AT ALL: the purpose-built tools (mtg_owned, vault_list_items, …)
 * answer the questions someone thought of in advance. "Which of my cards went
 * up more than 20% this week" or "how many land parcels score above 80" are
 * one query away, and writing a dedicated tool for each would never end. The
 * structured tools stay the first choice; this is the fallback that makes the
 * rest of the database askable.
 *
 * SAFETY IS ENFORCED BY SQLITE, NOT BY INSPECTING THE STRING:
 *   - every call opens its own connection with `readOnly: true`, so no
 *     statement can write, whatever it looks like;
 *   - an authorizer denies any read of the `settings` table (API keys, bot
 *     tokens, webhooks live there) and denies PRAGMA/ATTACH outright. Results
 *     from this tool can end up in a Discord channel, so secrets must be
 *     unreachable rather than merely discouraged in the prompt.
 * A string check on top only exists to give the model a readable error instead
 * of SQLite's generic "not authorized".
 */
import { DatabaseSync, constants } from 'node:sqlite'
import { dbFilePath } from '../db'

const MAX_ROWS = 200
const MAX_CELL = 240
const MAX_CHARS = 30_000

/** Tables no query may read. */
const DENIED_TABLES = new Set(['settings'])

function open(): DatabaseSync {
  return new DatabaseSync(dbFilePath(), { readOnly: true, timeout: 2000 })
}

// ---------------------------------------------------------------- schema

/**
 * How the tables relate for the questions people actually ask. Column lists
 * alone do not say that a Vault row's price lives in mtg_prices keyed by
 * (ext_id, variant) — and a local model will not guess it.
 */
const HINTS = `Relationships and conventions:
- Timestamps named *_at are epoch milliseconds (use datetime(x/1000,'unixepoch','localtime')). observed_on is 'YYYY-MM-DD'.
- Owned collectibles are vault_items. Magic cards/sealed there have ext_source 'scryfall' (card) or 'tcgplayer' (sealed) plus ext_id and variant (nonfoil|foil|etched|sealed).
- Daily Magic prices: mtg_prices(ext_id, variant, price, observed_on). Latest price for a holding = the row with max observed_on for its (ext_id, variant). Value of a holding = price * vault_items.quantity.
- cEDH tournament popularity: mtg_cedh_stats(name, play_rate 0..1 over the last year, from EDHTop16), joined via mtg_card_meta.name (vault_items.ext_id = mtg_card_meta.ext_id). play_rate NULL = never seen in a tournament deck. 0.25+ is a format staple.
- Owned sealed from other games (Pokémon etc.) are vault_items with category 'tcg_sealed', ext_source 'tcgplayer'.
- Things wanted but not owned: mtg_watchlist (last_price, target_price). Retail links/stock: mtg_listings.
- Non-Magic collectibles (coins, knives) value history: vault_valuations(item_id, kind melt|market|manual, value_mid, created_at).
- Chat history: sessions -> messages(session_id). Planner: calendar_events, todos, reminders.
- MIN(price)/MAX(price) are the price RANGE (spikes included), not the first and latest price. For change over time rank rows by observed_on, e.g. owned cards' gain from first to latest quote:
  WITH h AS (SELECT v.id, v.name, v.variant, v.quantity, p.price,
      ROW_NUMBER() OVER (PARTITION BY v.id ORDER BY p.observed_on) AS first_rank,
      ROW_NUMBER() OVER (PARTITION BY v.id ORDER BY p.observed_on DESC) AS last_rank
    FROM vault_items v JOIN mtg_prices p ON p.ext_id = v.ext_id AND p.variant = v.variant
    WHERE v.ext_source = 'scryfall')
  SELECT name, variant, MAX(CASE WHEN first_rank = 1 THEN price END) AS first_price,
    MAX(CASE WHEN last_rank = 1 THEN price END) AS latest_price,
    (MAX(CASE WHEN last_rank = 1 THEN price END) - MAX(CASE WHEN first_rank = 1 THEN price END)) * quantity AS gain
  FROM h GROUP BY id HAVING COUNT(*) > 1 ORDER BY gain DESC LIMIT 5
  (add AND p.observed_on >= date('now','-7 days') inside h for "this week").`

export function schemaText(filter?: string): string {
  const d = open()
  try {
    const rows = d
      .prepare(`SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string; type: string; sql: string | null }>
    // FTS5/rtree/geopoly keep shadow tables named <virtual>_<suffix>; they are noise.
    const virtuals = rows.filter((r) => /CREATE VIRTUAL TABLE/i.test(r.sql ?? '')).map((r) => r.name)
    const f = filter?.trim().toLowerCase()
    const visible = rows.filter(
      (r) =>
        !DENIED_TABLES.has(r.name) &&
        !virtuals.some((v) => r.name !== v && r.name.startsWith(`${v}_`)) &&
        (!f || r.name.toLowerCase().includes(f))
    )
    if (!visible.length) return f ? `No tables match "${filter}".` : 'The database has no readable tables.'
    const lines = visible.map((t) => {
      let cols: string
      try {
        const info = d.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(t.name) as Array<{ name: string; type: string }>
        cols = info.map((c) => `${c.name}${c.type ? ` ${c.type.toLowerCase()}` : ''}`).join(', ')
      } catch {
        cols = '(virtual)'
      }
      const count = (() => {
        try {
          return (d.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get() as { n: number }).n
        } catch {
          return null
        }
      })()
      return `- ${t.name}${t.type === 'view' ? ' (view)' : ''}${count != null ? ` [${count} rows]` : ''}: ${cols}`
    })
    return `${lines.join('\n')}\n\n${HINTS}`
  } finally {
    d.close()
  }
}

// ---------------------------------------------------------------- query

/** Blank out string literals and comments so keyword checks cannot be fooled by them. */
function codeOnly(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

function cell(v: unknown): string {
  if (v == null) return '∅'
  if (v instanceof Uint8Array) return `<blob ${v.byteLength}b>`
  const s = typeof v === 'number' && !Number.isInteger(v) ? String(Math.round(v * 10000) / 10000) : String(v)
  const flat = s.replace(/\s+/g, ' ')
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL)}…` : flat
}

export function runQuery(sqlIn: string): string {
  const sql = sqlIn.trim().replace(/;\s*$/, '')
  if (!sql) return 'Error: empty query.'
  const code = codeOnly(sql)
  if (!/^\s*(select|with)\b/i.test(code)) return 'Error: only a single SELECT (or WITH … SELECT) statement is allowed.'
  if (code.includes(';')) return 'Error: one statement per call.'
  if (/\bsettings\b/i.test(code)) return 'Error: the settings table holds credentials and cannot be queried.'

  const d = open()
  try {
    d.setAuthorizer((action, arg1) => {
      if (action === constants.SQLITE_READ && arg1 && DENIED_TABLES.has(arg1)) return constants.SQLITE_DENY
      if (action === constants.SQLITE_PRAGMA || action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH) {
        return constants.SQLITE_DENY
      }
      return constants.SQLITE_OK
    })
    let stmt
    try {
      stmt = d.prepare(sql)
    } catch (err) {
      return `SQL error: ${err instanceof Error ? err.message : String(err)}`
    }
    const rows: Array<Record<string, unknown>> = []
    let more = false
    // iterate() steps lazily, so a huge result stops at the cap instead of
    // being materialised first.
    for (const r of stmt.iterate() as Iterable<Record<string, unknown>>) {
      if (rows.length >= MAX_ROWS) {
        more = true
        break
      }
      rows.push(r)
    }
    if (!rows.length) return '0 rows.'
    const cols = Object.keys(rows[0])
    const out = [cols.join(' | ')]
    let chars = out[0].length
    let shown = 0
    for (const r of rows) {
      const line = cols.map((c) => cell(r[c])).join(' | ')
      if (chars + line.length > MAX_CHARS) {
        more = true
        break
      }
      out.push(line)
      chars += line.length + 1
      shown++
    }
    const tail = more ? `\n… stopped at ${shown} rows — add WHERE/LIMIT or aggregate to narrow it.` : `\n${shown} row(s).`
    return out.join('\n') + tail
  } catch (err) {
    return `SQL error: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    d.close()
  }
}
