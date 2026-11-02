/**
 * Discord as an alert sink — a webhook post per transition.
 *
 * WHY A WEBHOOK AND NOT A BOT: delivery is the only thing wanted right now,
 * and a webhook needs no bot token, no gateway connection, no library and no
 * intents. Point it at a private channel in a server you own, set that channel
 * to All Messages on your phone, and a restock reaches your pocket whether or
 * not ATLIS is in the foreground. A bot only starts earning its complexity
 * when alerts need to be answered — a Snooze button, a /watch command — and
 * that arrives as a second sink, not as a rewrite of this one.
 *
 * THE URL IS TREATED AS A CREDENTIAL AND AS AN UNTRUSTED DESTINATION. It is
 * typed by a person, it carries a token, and this module POSTs to it — so the
 * host is checked against Discord's own domains before anything is sent. That
 * check is not paranoia about Discord; it is what stops a mistyped or pasted
 * URL from quietly shipping watch data to someone else's server.
 *
 * ON RATE LIMITS: Discord allows roughly 5 requests per 5 seconds per channel,
 * and — the part that surprises people — every webhook in one guild shares a
 * single rate-limit bucket, so splitting alerts across channels buys nothing.
 * Sends are therefore serialised through one queue that reads the response
 * headers and waits when told to, rather than sleeping a fixed amount and
 * hoping. A personal feed will never come close to the limit; a shared server
 * would, and the queue is the difference between that being a config change
 * and a rewrite.
 */
import * as db from './db'
import type { Alert, AlertSink } from './alerts'
import { headline, money } from './alerts'

const WEBHOOK_KEY = 'discord_alert_webhook'
const MENTION_KEY = 'discord_alert_mention'

/**
 * Discord's own hosts only, and the shape its webhook URLs actually take.
 * Anything else is refused at save time with a message, not silently dropped
 * at send time when nobody is watching.
 */
const WEBHOOK_RE =
  /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d{5,}\/[\w-]{20,}$/

export function isValidWebhook(url: string): boolean {
  return WEBHOOK_RE.test(url.trim())
}

export function getWebhook(): string {
  return db.getSetting(WEBHOOK_KEY) ?? ''
}

/**
 * Turn whatever was pasted into a mention Discord will actually ping.
 *
 * "Copy User ID" hands over a bare snowflake, and a bare snowflake in a message
 * is just a number — Discord only pings the <@id> form. "@name" typed by hand
 * is literal text to a webhook too; there is no name lookup. So a bare ID is
 * wrapped, the real mention forms pass through untouched, and anything else is
 * kept as typed (it posts, it just will not ping — the UI says so).
 */
export function normalizeMention(input: string): string {
  return input
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((tok) => (/^\d{15,21}$/.test(tok) ? `<@${tok}>` : tok))
    .join(' ')
}

/**
 * Exactly who this message may ping, listed by id rather than by category.
 * Naming the ids means a mention string can never reach further than what was
 * actually saved in the field.
 */
export function allowedMentionsFor(mention: string): { parse: string[]; users: string[]; roles: string[] } {
  const users = [...mention.matchAll(/<@!?(\d{15,21})>/g)].map((m) => m[1])
  const roles = [...mention.matchAll(/<@&(\d{15,21})>/g)].map((m) => m[1])
  const everyone = /@(?:everyone|here)\b/.test(mention)
  return { parse: everyone ? ['everyone'] : [], users, roles }
}

export function mentionPings(mention: string): boolean {
  const a = allowedMentionsFor(mention)
  return a.users.length > 0 || a.roles.length > 0 || a.parse.length > 0
}

export function getMention(): string {
  // Normalised on read as well as on save, so a bare ID saved before this
  // existed starts pinging without having to be re-entered.
  return normalizeMention(db.getSetting(MENTION_KEY) ?? '')
}

export interface DiscordAlertConfig {
  webhook: string
  mention: string
  valid: boolean
  /** Whether the saved mention will actually produce a ping. */
  pings: boolean
}

export function readConfig(): DiscordAlertConfig {
  const webhook = getWebhook()
  const mention = getMention()
  return { webhook, mention, valid: !!webhook && isValidWebhook(webhook), pings: mentionPings(mention) }
}

/**
 * Save, validating first. An empty webhook is a deliberate "turn this off" and
 * is allowed through as a clear; a non-empty one that is not a Discord webhook
 * is rejected so the user finds out now rather than at the next drop.
 */
export function writeConfig(patch: { webhook?: string; mention?: string }): DiscordAlertConfig {
  if (patch.webhook !== undefined) {
    const url = patch.webhook.trim()
    if (url && !isValidWebhook(url)) {
      throw new Error('That is not a Discord webhook URL. Copy it from Channel Settings → Integrations → Webhooks.')
    }
    // setSetting refuses to blank a secret, so an intentional clear needs the
    // row removed rather than overwritten with ''.
    if (url) db.setSetting(WEBHOOK_KEY, url)
    else db.deleteSetting(WEBHOOK_KEY)
  }
  // Saved in canonical form so the field shows <@id> after saving, which is
  // also how the user learns what Discord actually wanted.
  if (patch.mention !== undefined) db.setSetting(MENTION_KEY, normalizeMention(patch.mention))
  return readConfig()
}

// ---------------------------------------------------------------- send queue

/** Serialises sends so the rate-limit headers from one apply to the next. */
let chain: Promise<unknown> = Promise.resolve()
/** When the bucket is known to be empty, the epoch ms it refills at. */
let bucketOpensAt = 0

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  // The queue must survive a failed send, so its own tail swallows the error;
  // the caller still receives it through `run`.
  chain = run.catch(() => undefined)
  return run
}

const FETCH_TIMEOUT_MS = 15_000
const MAX_ATTEMPTS = 3

async function postOnce(url: string, payload: unknown): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal
    })
  } finally {
    clearTimeout(t)
  }
}

/**
 * POST, honouring whatever Discord says about pacing.
 *
 * A 429 carries `retry_after` in seconds and is retried; a 4xx that is not 429
 * is permanent (a deleted webhook, a malformed embed) and is thrown
 * immediately, because retrying it just delays the report of a real problem.
 */
async function post(url: string, payload: unknown): Promise<void> {
  return enqueue(async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const wait = bucketOpensAt - Date.now()
      if (wait > 0) await sleep(Math.min(wait, 10_000))

      const res = await postOnce(url, payload)

      const remaining = Number(res.headers.get('x-ratelimit-remaining'))
      const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'))
      if (remaining === 0 && Number.isFinite(resetAfter)) {
        bucketOpensAt = Date.now() + resetAfter * 1000
      }

      if (res.status === 429) {
        let retryAfter = Number(res.headers.get('retry-after'))
        try {
          const body = (await res.json()) as { retry_after?: number }
          if (Number.isFinite(body?.retry_after)) retryAfter = Number(body.retry_after)
        } catch {
          /* header value stands */
        }
        const ms = Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000, 30_000)
        bucketOpensAt = Date.now() + ms
        if (attempt === MAX_ATTEMPTS) throw new Error('Discord rate limited the webhook three times in a row.')
        continue
      }

      if (res.status === 404 || res.status === 401 || res.status === 403) {
        throw new Error(`Discord rejected the webhook (HTTP ${res.status}) — it may have been deleted.`)
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Discord answered HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`)
      }
      return
    }
  })
}

// ---------------------------------------------------------------- payload

/** Green means buyable, which is the only distinction that matters at a glance. */
const COLOURS: Record<string, number> = {
  restock: 0x22c55e,
  new_product: 0x38bdf8,
  price_change: 0xfacc15,
  sold_out: 0x64748b,
  removed: 0x475569,
  price_target: 0x22c55e,
  preorder_live: 0x22c55e,
  below_market: 0x22c55e,
  restock_signal: 0xf59e0b
}

/** Markdown link text can't contain brackets, and a URL can't contain a closing paren unescaped. */
const mdLink = (label: string, url: string): string =>
  `[${label.replace(/[[\]]/g, '')}](${url.replace(/\)/g, '%29')})`

export function buildPayload(a: Alert, mention: string): Record<string, unknown> {
  const fields: Array<{ name: string; value: string; inline: boolean }> = []
  if (a.price != null) fields.push({ name: 'Price', value: money(a.price), inline: true })
  if (a.market != null) {
    fields.push({ name: 'Market', value: money(a.market), inline: true })
    if (a.price != null && a.price > 0) {
      const spread = a.market - a.price
      const pct = Math.round((spread / a.price) * 100)
      fields.push({ name: 'Spread', value: `${spread >= 0 ? '+' : '−'}${money(Math.abs(spread))} (${pct}%)`, inline: true })
    }
  }
  if (a.detail) fields.push({ name: 'Detail', value: a.detail.slice(0, 1024), inline: false })
  // Webhooks can't carry link buttons (those need a bot), so the title links
  // to the buy page and anything else rides as markdown in a field.
  const links = [...(a.url ? [{ label: 'Buy page', url: a.url }] : []), ...(a.links ?? [])]
  if (links.length > 1) {
    fields.push({ name: 'Links', value: links.map((l) => mdLink(l.label, l.url)).join(' · ').slice(0, 1024), inline: false })
  }

  return {
    // The mention is what turns a message into a phone push. Only 'restock'
    // and 'new_product' are loud by default upstream, so anything arriving
    // here is already worth the buzz.
    content: mention || undefined,
    allowed_mentions: allowedMentionsFor(mention),
    username: 'ATLIS',
    embeds: [
      {
        title: headline(a).slice(0, 256),
        description: a.title.slice(0, 2048),
        url: a.url ?? undefined,
        color: COLOURS[a.kind] ?? 0x94a3b8,
        thumbnail: a.image ? { url: a.image } : undefined,
        fields: fields.length ? fields : undefined,
        footer: { text: a.watchLabel.slice(0, 2048) },
        timestamp: new Date().toISOString()
      }
    ]
  }
}

// ---------------------------------------------------------------- sink

export function createDiscordSink(): AlertSink {
  return {
    name: 'discord',
    // Unconfigured is the normal state on a fresh install, not a fault — the
    // dispatcher skips a sink that is not ready without logging anything.
    ready: () => {
      const url = getWebhook()
      return !!url && isValidWebhook(url)
    },
    async send(a: Alert): Promise<void> {
      const url = getWebhook()
      if (!url) return
      await post(url, buildPayload(a, getMention()))
    }
  }
}
