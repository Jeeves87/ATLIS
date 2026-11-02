/**
 * Discord community telemetry — from public invite metadata, nothing else.
 *
 * WHY THIS IS THE RIGHT LAYER: Discord's invite endpoint answers unauthenticated
 * with the guild's name, its total member count and how many members are online
 * right now (verified 2026-09-07 against several large public servers). Those
 * three numbers turn out to answer the question that actually matters without
 * reading a single message.
 *
 * TWO DIFFERENT SIGNALS LIVE IN THEM, on very different clocks:
 *   growth    members climbing over days is a community FORMING — the earliest
 *             warning available for something that has no search volume yet.
 *   surge     the share of members online jumping well above its own baseline
 *             means the room is filling up NOW. People pile into a server when
 *             something is being announced or has just gone live, so this is an
 *             event detector with minutes of resolution.
 * Growth gives lead time; surge gives the moment. Neither needs message access.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: read messages. That requires either a bot
 * invited by someone with Manage Server (rarely possible for a shop you do not
 * run) or driving a user account token like a bot, which violates Discord's
 * terms and gets the account terminated — trading away the very access it was
 * meant to buy. Public counts only, and a polite hourly cadence.
 */
import { BrowserWindow, Notification } from 'electron'
import * as db from './db'

const UA = 'ATLIS/1.0 (personal drop tracker)'
const API = 'https://discord.com/api/v10'
const FETCH_TIMEOUT_MS = 15_000
const GAP_MS = 900

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Hour bucket, local — the granularity samples are keyed at. */
function hourKey(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`
}

// ---------------------------------------------------------------- invites

/** Accepts a full invite URL, a discord.gg link, or a bare code. */
export function parseInviteCode(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  const m = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/i.exec(s)
  if (m) return m[1]
  return /^[A-Za-z0-9-]{2,32}$/.test(s) ? s : null
}

/** Every distinct invite code mentioned in a page — used to find a shop's server. */
export function extractInvites(html: string): string[] {
  const out = new Set<string>()
  const re = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) out.add(m[1])
  return [...out]
}

export interface InviteInfo {
  code: string
  guildId: string | null
  name: string
  members: number | null
  online: number | null
}

export async function resolveInvite(code: string): Promise<InviteInfo> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${API}/invites/${encodeURIComponent(code)}?with_counts=true&with_expiration=true`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctl.signal
    })
    if (res.status === 404) throw new Error('Invite not found or expired.')
    if (res.status === 429) throw new Error('Discord is rate-limiting; try again shortly.')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as {
      guild?: { id?: string; name?: string }
      approximate_member_count?: number
      approximate_presence_count?: number
    }
    return {
      code,
      guildId: j.guild?.id ?? null,
      name: j.guild?.name ?? code,
      members: typeof j.approximate_member_count === 'number' ? j.approximate_member_count : null,
      online: typeof j.approximate_presence_count === 'number' ? j.approximate_presence_count : null
    }
  } finally {
    clearTimeout(t)
  }
}

/** Add a server to watch. Resolves first so the row carries a real name. */
export async function trackInvite(input: string, watchId?: string | null): Promise<db.DiscordWatch> {
  const code = parseInviteCode(input)
  if (!code) throw new Error('That does not look like a Discord invite.')
  const existing = db.findDiscordWatchByCode(code)
  if (existing) throw new Error(`Already watching ${existing.label}.`)
  const info = await resolveInvite(code)
  const w = db.createDiscordWatch({
    invite_code: code,
    label: info.name,
    guild_id: info.guildId,
    watch_id: watchId ?? null
  })
  db.recordDiscordSample({ discord_id: w.id, members: info.members, online: info.online, observedHour: hourKey() })
  db.updateDiscordWatch(w.id, { last_checked_at: Date.now(), last_error: null })
  return w
}

// ---------------------------------------------------------------- readings

export interface DiscordReading {
  id: string
  label: string
  inviteCode: string
  members: number | null
  online: number | null
  /** online / members, as a percentage. */
  presencePct: number | null
  /** Median presence percentage over the baseline window. */
  baselinePct: number | null
  /** Current presence over baseline. 2.0 means twice as busy as usual. */
  surge: number | null
  growth24h: number | null
  growth7d: number | null
  growthPct7d: number | null
  samples: number
  lastCheckedAt: number | null
  lastError: string | null
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/**
 * Read one server's telemetry.
 *
 * The baseline deliberately EXCLUDES the newest few hours: if a surge is under
 * way, including it in its own baseline would flatten the very spike we are
 * trying to detect.
 */
export function reading(discordId: string): DiscordReading | null {
  const w = db.getDiscordWatch(discordId)
  if (!w) return null
  const samples = db.listDiscordSamples(discordId, 400)
  const latest = samples[0]

  const presencePct =
    latest?.members && latest.online != null && latest.members > 0
      ? Math.round((latest.online / latest.members) * 1000) / 10
      : null

  const baselineRatios = samples
    .slice(3)
    .filter((s) => s.members && s.online != null && s.members > 0)
    .map((s) => (s.online as number) / (s.members as number))
  const baseline = median(baselineRatios)
  const baselinePct = baseline == null ? null : Math.round(baseline * 1000) / 10

  const surge =
    baseline && presencePct != null && baseline > 0
      ? Math.round((presencePct / 100 / baseline) * 100) / 100
      : null

  const day = db.discordSampleAt(discordId, hourKey(new Date(Date.now() - 86_400_000)))
  const week = db.discordSampleAt(discordId, hourKey(new Date(Date.now() - 7 * 86_400_000)))
  const growth24h = latest?.members != null && day?.members != null ? latest.members - day.members : null
  const growth7d = latest?.members != null && week?.members != null ? latest.members - week.members : null
  const growthPct7d =
    growth7d != null && week?.members ? Math.round((growth7d / week.members) * 1000) / 10 : null

  return {
    id: w.id,
    label: w.label,
    inviteCode: w.invite_code,
    members: latest?.members ?? null,
    online: latest?.online ?? null,
    presencePct,
    baselinePct,
    surge,
    growth24h,
    growth7d,
    growthPct7d,
    samples: samples.length,
    lastCheckedAt: w.last_checked_at,
    lastError: w.last_error
  }
}

export function readAll(): DiscordReading[] {
  return db.listDiscordWatches().map((w) => reading(w.id)).filter((r): r is DiscordReading => r != null)
}

// ---------------------------------------------------------------- sweep

/** A surge needs history behind it; below this, ratios are just noise. */
const MIN_SAMPLES_FOR_SURGE = 12
const SURGE_ALERT = 1.8
const DAY_MS = 86_400_000

export interface DiscordSweep {
  watched: number
  sampled: number
  surges: Array<{ label: string; surge: number; online: number | null; members: number | null }>
  errors: string[]
}

export async function sweep(win?: BrowserWindow): Promise<DiscordSweep> {
  const watches = db.listDiscordWatches().filter((w) => w.enabled === 1)
  const out: DiscordSweep = { watched: watches.length, sampled: 0, surges: [], errors: [] }

  for (const w of watches) {
    try {
      const info = await resolveInvite(w.invite_code)
      // The guild can be renamed; keep the label honest.
      const patch: Partial<db.DiscordWatch> = { last_checked_at: Date.now(), last_error: null }
      if (info.name && info.name !== w.label) patch.label = info.name
      if (info.guildId && info.guildId !== w.guild_id) patch.guild_id = info.guildId
      db.updateDiscordWatch(w.id, patch)

      const before = reading(w.id)
      db.recordDiscordSample({
        discord_id: w.id,
        members: info.members,
        online: info.online,
        observedHour: hourKey()
      })
      out.sampled++

      const after = reading(w.id)
      if (
        after &&
        after.samples >= MIN_SAMPLES_FOR_SURGE &&
        after.surge != null &&
        after.surge >= SURGE_ALERT &&
        // Only fire on the transition into a surge, not every hour it lasts.
        (before?.surge == null || before.surge < SURGE_ALERT)
      ) {
        out.surges.push({ label: after.label, surge: after.surge, online: after.online, members: after.members })
        if (alertsEnabled()) notifySurge(after, win)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      db.updateDiscordWatch(w.id, { last_checked_at: Date.now(), last_error: msg })
      out.errors.push(`${w.label}: ${msg}`)
    }
    await sleep(GAP_MS)
  }

  db.pruneDiscordSamples()
  return out
}

const ALERTS_KEY = 'discord_alerts_enabled'

export function alertsEnabled(): boolean {
  return (db.getSetting(ALERTS_KEY) ?? '1') !== '0'
}
export function setAlertsEnabled(on: boolean): boolean {
  db.setSetting(ALERTS_KEY, on ? '1' : '0')
  return on
}

/**
 * A surge is worth interrupting for because it is time-critical in a way member
 * growth is not: people are in that server right now, and whatever pulled them
 * there is probably about to sell out.
 */
function notifySurge(r: DiscordReading, win?: BrowserWindow): void {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: `${r.label} — server is busy`,
    body: `${r.online ?? '?'} online, ${r.surge}x the usual for this server. Something is happening.`,
    silent: false,
    urgency: 'critical'
  })
  n.on('click', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.focus()
      win.webContents.send('drops:focus', { url: `https://discord.gg/${r.inviteCode}` })
    }
  })
  n.show()
}

/**
 * Find a store's Discord from its own pages and start watching it.
 *
 * Shops advertise their server in the footer or an about page, so this closes
 * the loop with the store watcher: a shop worth watching usually points at the
 * room where its drops get announced first.
 */
export async function discoverFromStore(watchId: string): Promise<{ found: string[]; added: string[] }> {
  const w = db.getDropWatch(watchId)
  if (!w) throw new Error('Unknown watch.')
  const found = new Set<string>()

  for (const path of ['', '/pages/about', '/pages/contact', '/pages/faq']) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
      try {
        const res = await fetch(`${w.url}${path}`, { headers: { 'User-Agent': UA }, signal: ctl.signal })
        if (res.ok) for (const c of extractInvites(await res.text())) found.add(c)
      } finally {
        clearTimeout(t)
      }
    } catch {
      /* a missing page is normal, not an error worth surfacing */
    }
    await sleep(GAP_MS)
  }

  const added: string[] = []
  for (const code of found) {
    if (db.findDiscordWatchByCode(code)) continue
    try {
      const dw = await trackInvite(code, watchId)
      added.push(dw.label)
    } catch {
      /* dead or expired invites are common in old footers */
    }
  }
  return { found: [...found], added }
}
