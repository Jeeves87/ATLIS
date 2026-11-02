/**
 * Card watches for every game that is not Magic.
 *
 * WHY THIS IS NOT IN mtg.ts: Magic's depth comes from Scryfall and MTGJSON —
 * printings, sealed contents, EV, Secret Lair, price backfill — and none of
 * that exists for Palworld, Cyberpunk or most other games, where TCGplayer is
 * the only catalogue. Rather than teach every Scryfall code path in mtg.ts to
 * skip rows it cannot handle, other games live here, in their own tcg_* tables.
 * Nothing in this module reads or writes an mtg_* table.
 *
 * A WATCH IS ONE PRINTING OF ONE PRODUCT. Normal and Foil are different
 * markets, so tracking both is two watches — and a Foil watch reads only the
 * Foil quote, never the Normal one.
 *
 * WHAT IS STORED: the watch row carries the latest quote for fast listing;
 * tcg_observations keeps history, written only when the quote CHANGES, so a
 * card that sits at $0.25 for a month costs one row.
 *
 * ALERTS: "listed" (the first copies appear — an upcoming set going live, or a
 * sold-out card coming back) and "at your price" (market reaches the target),
 * both on arrival only, through the shared alert sinks.
 */
import { BrowserWindow } from 'electron'
import * as db from './db'
import * as alerts from './alerts'
import {
  TCG_GAMES,
  assertPrintingTrades,
  quoteFor,
  tcgImage,
  tcgPricePoints,
  tcgSearch,
  tcgSetProducts,
  tcgSets,
  tcgUrl,
  type TcgPrinting,
  type TcgProduct,
  type TcgQuote,
  type TcgSet,
  type TcgSetProducts,
  type TcgType
} from './tcgplayer'

export { TCG_GAMES }

/** TCGplayer's market figures move daily at most. */
const SWEEP_EVERY_MS = 6 * 60 * 60_000
const TICK_MS = 10 * 60_000
const STARTUP_GRACE_MS = 45_000
const GAP_MS = 900
const ALERT_COOLDOWN_MS = 6 * 60 * 60_000
const LAST_SWEEP_KEY = 'tcg_last_sweep_at'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function assertGame(game: unknown): string {
  if (typeof game !== 'string' || !TCG_GAMES.some((g) => g.url === game)) throw new Error('Pick a game to search.')
  return game
}

export function search(input: { q: string; game: string; type?: TcgType }): Promise<TcgProduct[]> {
  assertGame(input?.game)
  return tcgSearch(input)
}

export function sets(game: string): Promise<TcgSet[]> {
  return tcgSets(assertGame(game))
}

export function setProducts(game: string, set: string): Promise<TcgSetProducts> {
  if (typeof set !== 'string' || !set.trim()) throw new Error('Pick a set.')
  return tcgSetProducts(assertGame(game), set)
}

// ---------------------------------------------------------------- recording

const fmt = (n: number | null): string => (n == null ? '—' : `$${n.toFixed(2)}`)

/** Store a quote if it differs from the last one; return the transitions worth an alert. */
function record(w: db.TcgWatch, q: TcgQuote, force = false): { changed: boolean; raised: alerts.Alert[] } {
  const prev = db.latestTcgObservation(w.id) ?? null
  const listed = q.listed ? 1 : 0
  const changed = force || !prev || prev.price !== q.market || prev.median !== q.median || prev.in_stock !== listed
  if (changed) db.addTcgObservation({ watch_id: w.id, price: q.market, median: q.median, in_stock: listed })
  db.updateTcgWatch(w.id, { last_price: q.market, last_median: q.median, last_in_stock: listed })
  if (!changed || !prev) return { changed, raised: [] }

  const raised: alerts.Alert[] = []
  const base = {
    watchId: w.id,
    watchLabel: w.printing === 'Foil' && !/\bfoil\b/i.test(w.name) ? `${w.name} (Foil)` : w.name,
    extId: `${w.product_id}:${w.printing}`,
    title: [w.game_label, w.set_name].filter(Boolean).join(' · '),
    detail: [q.market != null ? `${fmt(q.market)} market` : null, q.median != null ? `listed around ${fmt(q.median)}` : null]
      .filter(Boolean)
      .join(' · ') || null,
    url: tcgUrl(w.product_id, w.printing as TcgPrinting),
    image: w.image_url,
    price: q.market
  }
  const cameBack = prev.in_stock === 0 && listed === 1
  if (cameBack) raised.push({ ...base, kind: 'restock' })
  // One event, one ping: a "listed" alert already carries the price.
  const target = w.target_price
  if (!cameBack && target != null && q.market != null && q.market <= target + 1e-9 && listed === 1) {
    const already = prev.price != null && prev.price <= target + 1e-9 && prev.in_stock === 1
    if (!already) raised.push({ ...base, kind: 'price_target' })
  }
  return { changed, raised }
}

const policy: alerts.PolicyResolver = (watchId) => {
  const w = db.getTcgWatch(watchId)
  if (!w || w.notify === 0) return null
  return { kinds: new Set(['restock', 'price_target']), cooldownMs: ALERT_COOLDOWN_MS }
}

// ---------------------------------------------------------------- watches

export async function addWatch(input: {
  productId: string
  printing: TcgPrinting
  game: string
  gameLabel?: string | null
  kind: 'card' | 'sealed'
  name: string
  set?: string | null
  rarity?: string | null
  targetPrice?: number | null
}): Promise<db.TcgWatch> {
  const productId = String(input?.productId ?? '')
  if (!/^\d+$/.test(productId)) throw new Error('Unknown TCGplayer product.')
  const printing: TcgPrinting = input.printing === 'Foil' ? 'Foil' : 'Normal'
  const game = TCG_GAMES.find((g) => g.url === input.game)
  if (!game) throw new Error('Unknown game.')

  const dup = db.findTcgWatch(productId, printing)
  if (dup) throw new Error(`Already watching ${dup.name}${printing === 'Foil' ? ' (Foil)' : ''}.`)

  // Read BEFORE creating anything: an unpriceable choice is refused, not saved empty.
  const rows = await tcgPricePoints(productId)
  assertPrintingTrades(rows, printing)

  const w = db.createTcgWatch({
    game: game.url,
    game_label: input.gameLabel?.trim() || game.label,
    product_id: productId,
    printing,
    kind: input.kind === 'sealed' ? 'sealed' : 'card',
    name: String(input.name ?? '').trim() || `TCGplayer #${productId}`,
    set_name: input.set ?? null,
    rarity: input.rarity ?? null,
    image_url: tcgImage(productId),
    target_price: input.targetPrice ?? null
  })
  record(w, quoteFor(rows, printing), true)
  db.updateTcgWatch(w.id, { last_checked_at: Date.now(), last_ok_at: Date.now(), last_error: null })
  // No alert on add: you are looking at the price right now.
  return db.getTcgWatch(w.id) ?? w
}

// ---------------------------------------------------------------- owned sealed

/**
 * "I own this" for another game's sealed product (a Pokémon booster box, an
 * ETB). The one place this module touches Magic's tables, on purpose: the
 * Owned tab and the daily price sweep in mtg.ts key every sealed holding by
 * its TCGplayer product id, not by game, so a vault row with ext_source
 * 'tcgplayer' is listed, charted and re-priced exactly like a Magic box.
 * Building a parallel owned list here would duplicate all of that.
 *
 * Each call adds a new vault row; the Owned list stacks identical products.
 */
export async function ownSealed(input: {
  productId: string
  game: string
  gameLabel?: string | null
  name: string
  set?: string | null
  quantity?: number
  purchasePrice?: number | null
}): Promise<db.VaultItem & { price: number | null }> {
  const productId = String(input?.productId ?? '')
  if (!/^\d+$/.test(productId)) throw new Error('Unknown TCGplayer product.')
  const game = TCG_GAMES.find((g) => g.url === input.game)
  if (!game) throw new Error('Unknown game.')
  const label = input.gameLabel?.trim() || game.label
  const qty = Math.max(1, Math.floor(Number(input.quantity) || 1))

  const item = db.createVaultItem({
    category: 'tcg_sealed',
    name: String(input.name ?? '').trim() || `TCGplayer #${productId}`,
    maker: [label, input.set].filter(Boolean).join(' · '),
    quantity: qty,
    purchase_price: input.purchasePrice ?? null,
    ext_source: 'tcgplayer',
    ext_id: productId,
    variant: 'sealed'
  })

  // First quote now, so the row is priced the moment it appears rather than
  // after the next sweep. A miss is not fatal: the sweep retries daily.
  let price: number | null = null
  try {
    price = quoteFor(await tcgPricePoints(productId), 'Normal').market
  } catch {
    /* TCGplayer unreachable — left for the sweep */
  }
  if (price != null) {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    db.recordMtgPrice({
      ext_id: productId,
      variant: 'sealed',
      price,
      source: 'tcgplayer',
      observed_on: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    })
    db.addVaultValuation({
      item_id: item.id,
      kind: 'market',
      value_mid: Math.round(price * qty * 100) / 100,
      source: `TCGplayer market (product ${productId})`
    })
  }
  return { ...item, price }
}

export interface CheckResult {
  checked: number
  changed: number
  errors: string[]
}

async function checkOne(w: db.TcgWatch): Promise<{ changed: boolean; error: string | null }> {
  db.updateTcgWatch(w.id, { last_checked_at: Date.now() })
  try {
    const rows = await tcgPricePoints(w.product_id)
    const { changed, raised } = record(w, quoteFor(rows, w.printing as TcgPrinting))
    db.updateTcgWatch(w.id, { last_ok_at: Date.now(), last_error: null })
    if (raised.length) await alerts.dispatch(raised, policy)
    return { changed, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // The last good quote stays; the error sits beside it.
    db.updateTcgWatch(w.id, { last_error: msg })
    return { changed: false, error: msg }
  }
}

async function checkMany(watches: db.TcgWatch[]): Promise<CheckResult> {
  const out: CheckResult = { checked: 0, changed: 0, errors: [] }
  for (let i = 0; i < watches.length; i++) {
    const r = await checkOne(watches[i])
    out.checked++
    if (r.changed) out.changed++
    if (r.error) out.errors.push(`${watches[i].name}: ${r.error}`)
    if (i < watches.length - 1) await sleep(GAP_MS)
  }
  return out
}

export function check(target: { id?: string; game?: string } = {}): Promise<CheckResult> {
  if (target.id) {
    const w = db.getTcgWatch(String(target.id))
    if (!w) throw new Error('Unknown watch.')
    return checkMany([w])
  }
  return checkMany(db.listTcgWatches(target.game ? String(target.game) : undefined))
}

export async function sweep(): Promise<CheckResult> {
  const r = await checkMany(db.listTcgWatches())
  db.setSetting(LAST_SWEEP_KEY, String(Date.now()))
  return r
}

/**
 * Both printings' live quotes, for the card preview — the TCG counterpart of
 * the per-finish prices the Magic lightbox shows. Read fresh, never stored.
 */
export async function quote(productId: string): Promise<{ Normal: TcgQuote; Foil: TcgQuote }> {
  const rows = await tcgPricePoints(String(productId))
  return { Normal: quoteFor(rows, 'Normal'), Foil: quoteFor(rows, 'Foil') }
}

export function history(id: string): Array<{ t: number; price: number | null; median: number | null; listed: number | null }> {
  return db.listTcgObservations(String(id)).map((o) => ({ t: o.observed_at, price: o.price, median: o.median, listed: o.in_stock }))
}

/** Watch counts per game, for the tab strip. */
export function counts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const w of db.listTcgWatches()) out[w.game] = (out[w.game] ?? 0) + 1
  return out
}

// ---------------------------------------------------------------- scheduler

function magicPageHidden(): boolean {
  try {
    // The game tabs live on the Magic page; hiding that page pauses these too.
    return (JSON.parse(db.getSetting('disabled_apps') || '[]') as string[]).includes('mtg')
  } catch {
    return false
  }
}

export function startTcgScheduler(win: BrowserWindow): () => void {
  let stopped = false
  let running = false
  const tick = async (): Promise<void> => {
    if (stopped || running || win.isDestroyed() || magicPageHidden()) return
    if (Date.now() - Number(db.getSetting(LAST_SWEEP_KEY) || 0) < SWEEP_EVERY_MS) return
    running = true
    try {
      const r = await sweep()
      if (r.checked && !win.isDestroyed()) win.webContents.send('tcg:changed', {})
    } catch {
      /* the next tick retries */
    } finally {
      running = false
    }
  }
  const startup = setTimeout(() => void tick(), STARTUP_GRACE_MS)
  const interval = setInterval(() => void tick(), TICK_MS)
  interval.unref?.()
  const stop = (): void => {
    stopped = true
    clearTimeout(startup)
    clearInterval(interval)
  }
  win.on('closed', stop)
  return stop
}
