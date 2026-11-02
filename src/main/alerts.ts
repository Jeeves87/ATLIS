/**
 * Alert delivery — one transition, several places it can land.
 *
 * WHY THIS IS NOT IN drops.ts: the poller's job ends the moment it decides
 * something CHANGED. Who hears about that, where, and how often is a separate
 * question with a separate lifetime — a desktop notification dies with the app
 * and is useless at 3am, a Discord message reaches a phone in another room.
 * Splitting them is what lets a sink be added without touching the differ, and
 * what will let the poller move off the desktop later without dragging the
 * notification code along with it.
 *
 * THREE THINGS HAPPEN HERE, in this order, and the order is the design:
 *
 *   1. policy    which transition kinds are worth interrupting a person over.
 *                Per watch, because a store you are waiting on and a store you
 *                merely track do not deserve the same volume. A watch with
 *                notify = 0 is silent entirely.
 *
 *   2. cooldown  a product's availability bit FLAPS. An abandoned checkout
 *                releases its hold and the variant blinks back for a few
 *                seconds, so an uncooled monitor sends four identical
 *                "BACK IN STOCK" pings for one restock. The window is keyed
 *                per sink per product per kind and lives in SQLite, because a
 *                restart must not re-arm an alert the user already dismissed.
 *
 *   3. fan-out   every ready sink gets it, and one sink failing never stops
 *                another. A webhook URL that has been revoked must not also
 *                take out the desktop notification — that failure mode turns
 *                a degraded feature into no feature.
 *
 * Sinks are registered at startup rather than imported here, so this module
 * depends on nothing that knows about Discord, HTTP, or a window.
 */
import { BrowserWindow, Notification } from 'electron'
import * as db from './db'

/**
 * What a sink is handed. Deliberately not `DropTransition` — that type belongs
 * to the Shopify differ, and the next producer (a per-SKU retailer watch) will
 * not have the same shape. This is the narrow contract both can satisfy.
 */
export interface Alert {
  /** restock | new_product | sold_out | removed | price_change */
  kind: string
  watchId: string
  watchLabel: string
  /** Stable product id within the watch — the cooldown is keyed on it. */
  extId: string
  title: string
  detail: string | null
  url: string | null
  image: string | null
  price: number | null
  /**
   * Secondary-market price, when the producer knows one. Paired with `price`
   * it is the flip spread, and that spread is what makes a restock worth
   * interrupting someone for.
   */
  market?: number | null
  /** Extra places worth opening beside `url`, such as the market listing. */
  links?: Array<{ label: string; url: string }>
  /** Renderer channel a click on the desktop notification focuses. Defaults to Drops. */
  focus?: string
}

export interface AlertSink {
  readonly name: string
  /**
   * False when the user has not configured this sink. Unconfigured is not an
   * error and must not be logged as one — a fresh install has no webhook yet.
   */
  ready(): boolean
  send(a: Alert): Promise<void>
}

// ---------------------------------------------------------------- registry

const sinks = new Map<string, AlertSink>()

export function registerSink(sink: AlertSink): void {
  sinks.set(sink.name, sink)
}

export function sinkStatus(): Array<{ name: string; ready: boolean }> {
  return [...sinks.values()].map((s) => ({ name: s.name, ready: s.ready() }))
}

// ---------------------------------------------------------------- policy

/** Every kind the differ can produce, in the order a settings UI should list them. */
export const ALERT_KINDS = ['restock', 'new_product', 'price_change', 'sold_out', 'removed'] as const

/**
 * Only the two that mean "you can buy this now" are loud by default.
 * Being told you missed something is not worth waking a phone for, so
 * sold_out and removed are recorded to the timeline and stay quiet unless the
 * user opts in per watch.
 */
export const DEFAULT_KINDS = ['restock', 'new_product']

/** Long enough to swallow cart-release flapping, short enough for a real second drop. */
export const DEFAULT_COOLDOWN_MS = 30 * 60_000

const ALERTS_KEY = 'drops_alerts_enabled'

export function alertsEnabled(): boolean {
  return (db.getSetting(ALERTS_KEY) ?? '1') !== '0'
}

export function setAlertsEnabled(on: boolean): boolean {
  db.setSetting(ALERTS_KEY, on ? '1' : '0')
  return on
}

/** What a producer wants delivered, and how often. */
export interface AlertPolicy {
  kinds: Set<string>
  cooldownMs: number
}
type Policy = AlertPolicy

/**
 * How the dispatcher learns a producer's policy. Drops resolve against their
 * watch row. Defaults to drops, so every existing caller behaves exactly as
 * before.
 */
export type PolicyResolver = (watchId: string) => AlertPolicy | null

function policyFor(watch: db.DropWatch | undefined): Policy | null {
  if (!watch || watch.notify === 0) return null
  const raw = watch.alert_kinds?.trim()
  const kinds = raw ? raw.split(',').map((k) => k.trim()).filter(Boolean) : DEFAULT_KINDS
  const cd = watch.alert_cooldown_ms
  return {
    kinds: new Set(kinds),
    // A stored 0 is a deliberate "tell me every single time", so only null
    // falls back to the default.
    cooldownMs: cd == null ? DEFAULT_COOLDOWN_MS : Math.max(0, cd)
  }
}

// ---------------------------------------------------------------- dispatch

export interface DispatchResult {
  considered: number
  sent: number
  suppressed: number
  errors: string[]
}

const PRUNE_EVERY_MS = 6 * 60 * 60_000
let lastPrune = 0

const dropWatchPolicy: PolicyResolver = (watchId) => policyFor(db.getDropWatch(watchId))

/**
 * Run alerts through policy and cooldown, then fan out.
 *
 * Sends are awaited so a sink's own rate limiting actually applies backpressure
 * rather than being outrun by the next sweep.
 */
export async function dispatch(alerts: Alert[], resolvePolicy: PolicyResolver = dropWatchPolicy): Promise<DispatchResult> {
  const out: DispatchResult = { considered: alerts.length, sent: 0, suppressed: 0, errors: [] }
  if (!alerts.length || !alertsEnabled()) {
    out.suppressed = alerts.length
    return out
  }

  const ready = [...sinks.values()].filter((s) => {
    try {
      return s.ready()
    } catch {
      return false
    }
  })
  if (!ready.length) {
    out.suppressed = alerts.length
    return out
  }

  // One lookup per producer, not per alert — a busy sweep is mostly one store.
  const policies = new Map<string, AlertPolicy | null>()

  for (const a of alerts) {
    if (!policies.has(a.watchId)) policies.set(a.watchId, resolvePolicy(a.watchId))
    const policy = policies.get(a.watchId) ?? null
    if (!policy || !policy.kinds.has(a.kind)) {
      out.suppressed++
      continue
    }
    let deliveredToAny = false
    for (const sink of ready) {
      // Keyed per sink: adding Discord later must not be silenced by a desktop
      // notification the user saw an hour ago.
      const key = `${sink.name}:${a.watchId}:${a.extId}:${a.kind}`
      if (!db.claimAlert(key, policy.cooldownMs)) continue
      try {
        await sink.send(a)
        deliveredToAny = true
      } catch (err) {
        out.errors.push(`${sink.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (deliveredToAny) out.sent++
    else out.suppressed++
  }

  if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
    lastPrune = Date.now()
    try {
      db.pruneAlertSends()
    } catch {
      /* a full cooldown table is a nuisance, never a reason to lose an alert */
    }
  }
  return out
}

/**
 * Push one alert past policy and cooldown to every ready sink.
 *
 * Used by the "send a test alert" button, which has to prove the webhook works
 * end to end — a test that could be silently swallowed by a cooldown would be
 * worse than no test at all.
 */
export async function sendDirect(a: Alert): Promise<{ delivered: string[]; errors: string[] }> {
  const delivered: string[] = []
  const errors: string[] = []
  for (const sink of sinks.values()) {
    if (!sink.ready()) continue
    try {
      await sink.send(a)
      delivered.push(sink.name)
    } catch (err) {
      errors.push(`${sink.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { delivered, errors }
}

// ---------------------------------------------------------------- presentation

export const money = (n: number): string => `$${n.toFixed(2)}`

/** The one-line summary every sink leads with, so they read alike. */
export function headline(a: Alert): string {
  switch (a.kind) {
    case 'restock':
      return `${a.watchLabel} — BACK IN STOCK`
    case 'new_product':
      return `${a.watchLabel} — new listing`
    case 'price_change':
      return `${a.watchLabel} — price changed`
    case 'sold_out':
      return `${a.watchLabel} — sold out`
    case 'removed':
      return `${a.watchLabel} — pulled`
    case 'price_target':
      return `${a.watchLabel} — at your price`
    case 'preorder_live':
      return `${a.watchLabel} — PREORDER LIVE`
    case 'restock_signal':
      return `${a.watchLabel} — restock expected`
    case 'below_market':
      return `${a.watchLabel} — BELOW MARKET`
    default:
      return a.watchLabel
  }
}

// ---------------------------------------------------------------- desktop sink

/**
 * The original notification path, unchanged in behaviour — it just arrives here
 * through the registry now instead of being called from the poller.
 */
export function createDesktopSink(win: BrowserWindow): AlertSink {
  return {
    name: 'desktop',
    ready: () => Notification.isSupported() && !win.isDestroyed(),
    async send(a: Alert): Promise<void> {
      const n = new Notification({
        title: headline(a),
        body: [
          a.title,
          a.price != null ? money(a.price) : null,
          a.market != null ? `market ${money(a.market)}` : null,
          a.detail
        ]
          .filter(Boolean)
          .join(' · '),
        silent: false,
        urgency: 'critical'
      })
      n.on('click', () => {
        if (win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.focus()
        win.webContents.send(a.focus ?? 'drops:focus', { url: a.url })
      })
      n.show()
    }
  }
}
