/**
 * Discord as a front door to the agent: message a bot, ATLIS answers.
 *
 * discordAlert.ts is the outbound half (a webhook, deliberately not a bot).
 * This is the inbound half, and inbound is exactly the case that file said a
 * bot would eventually earn its keep for: something has to hold a gateway
 * connection to RECEIVE messages. A webhook cannot.
 *
 * NO LIBRARY. Electron 42's Node has a global WebSocket and fetch, and the
 * slice of the gateway a single-owner bot needs is small: hello → heartbeat →
 * identify/resume → MESSAGE_CREATE. discord.js would add ~40 packages and
 * optional native modules for that, on a machine with no build tools.
 *
 * WHO IT ANSWERS. Only Discord user ids on an explicit allowlist, and nobody at
 * all while the list is empty. The agent behind this can read the whole
 * database, so an open bot in a shared server would hand anyone in it the
 * owner's collection, planner and chat history. Messages from anyone else are
 * ignored silently — replying "not allowed" would just confirm the bot is live.
 *
 * WHAT IT CAN DO. Runs go through AgentRunner with a tool ALLOWLIST (read-only
 * data tools, plus a few low-risk writes if the owner opts in) and a system
 * prompt written for chat, not for the desktop. Shell, filesystem, browser and
 * desktop control are never reachable from Discord — the runner enforces the
 * list at execution time, not just when offering tools.
 *
 * WHERE IT LISTENS. DMs, @mentions and replies to the bot always work, and none
 * of them need the privileged Message Content intent. Listening to every
 * message in a channel does; if the owner has not enabled that intent in the
 * Developer Portal, Discord closes the socket with 4014, and the bot reconnects
 * without it and says so in Settings instead of failing outright.
 *
 * EACH CHANNEL IS AN ORDINARY ATLIS SESSION, so a Discord conversation shows up
 * in the Chat view with its tool calls, can be continued from the desktop, and
 * meters usage like any other.
 */
import type { BrowserWindow } from 'electron'
import * as db from './db'
import type { AgentRunner } from './agent/runner'
import { getProvider } from './providers'
import { stripThinking } from './providers/lmstudio'
import { mdToHtml } from './docs/convert'

const API = 'https://discord.com/api/v10'
const UA = 'DiscordBot (https://github.com/atlis, 1.0) ATLIS'

const INTENT_GUILD_MESSAGES = 1 << 9
const INTENT_DIRECT_MESSAGES = 1 << 12
const INTENT_MESSAGE_CONTENT = 1 << 15

/** View Channel, Send Messages, Attach Files, Read Message History. */
const INVITE_PERMISSIONS = 1024 + 2048 + 32768 + 65536

/** Close codes after which reconnecting cannot help. */
const FATAL_CLOSE: Record<number, string> = {
  4004: 'Discord rejected the bot token.',
  4010: 'Invalid shard.',
  4011: 'Sharding required.',
  4012: 'Invalid gateway API version.',
  4013: 'Invalid intents.'
}

const DISCORD_LIMIT = 2000
const MAX_INLINE_CHUNKS = 4
const HISTORY_WINDOW = 40
/** ~4-5k tokens: room for a 50-row list, not a whole collection dump. */
const TOOL_RESULT_CAP = 16_000

const KEYS = {
  token: 'discord_bot_token',
  enabled: 'discord_bot_enabled',
  users: 'discord_bot_allowed_users',
  channels: 'discord_bot_channels',
  provider: 'discord_bot_provider',
  model: 'discord_bot_model',
  writes: 'discord_bot_allow_writes',
  sessions: 'discord_bot_sessions'
} as const

/** Data the owner might ask about. Nothing here can change state beyond refreshing a cached quote. */
export const READ_TOOLS = [
  'mtg_owned', 'mtg_watchlist', 'mtg_price_history', 'mtg_search', 'mtg_search_sealed', 'mtg_upcoming_sets',
  'mtg_upcoming_secret_lairs', 'mtg_set_value', 'mtg_sealed_prices', 'mtg_sealed_contents', 'mtg_pack_ev',
  'mtg_ev_board', 'mtg_retailers',
  'vault_list_items', 'vault_get_item', 'vault_spot_prices',
  'calendar_list_events', 'todo_list', 'reminder_list',
  'feed_list_items', 'feed_list_sources',
  'memory_search', 'memory_list',
  'db_schema', 'db_query'
]

/** Low-risk changes, only offered when the owner turns writes on. */
export const WRITE_TOOLS = [
  'mtg_watch_add', 'mtg_watch_update', 'todo_create', 'todo_complete', 'reminder_create', 'calendar_create_event', 'memory_save'
]

const SYSTEM = `You are ATLIS, the owner's personal assistant, replying to them in Discord. ATLIS runs on the owner's PC and stores their Magic: The Gathering collection and watchlist with daily prices, a Vault of collectibles, a planner (calendar, to-dos, reminders), a news feed, and more.

How to answer:
- Answer from real data. Call a tool to look things up; never guess prices, counts or holdings.
- Prefer the purpose-built tools — e.g. mtg_owned with summary: true for "what is my collection worth", mtg_owned with min_price for "my cards over $2", vault_list_items, todo_list. When none fits — rankings, trends, comparisons over time — call db_schema, then db_query with one SELECT that does the sorting and arithmetic in SQL.
- Your context is small. Never pull a whole collection to scan it yourself: use filters and limits, or let SQL aggregate, and do not call the same tool twice with the same arguments.
- If a tool call errors, fix the arguments and retry once; if it still fails, say what failed.
- Discord formatting: short paragraphs and bullet lists, **bold** for names, money as $12.34. Never use markdown tables — Discord does not render them.
- Be concise. For long lists lead with the count and total, then the items. Leave out internal ids (uuids, Scryfall/TCGplayer ids) unless asked.
- When you list entries from a tool result, copy them faithfully: one line per entry, with the name, set and price exactly as the tool gave them. Never merge entries that share a name — they are different printings — and never work out per-item numbers yourself. Counts and totals stated by the tool are authoritative; repeat them rather than recomputing.
{writes}
Today is {date}.`

const WRITES_ON = '- You may make changes (watchlist entries, to-dos, reminders, calendar events, memories) — but only when the owner clearly asks for one.'
const WRITES_OFF = '- You are read-only here. If asked to change something, say it has to be done from the ATLIS desktop app (or by enabling changes in Settings → Discord bot).'

export type BotState = 'off' | 'connecting' | 'online' | 'error'

export interface DiscordBotStatus {
  state: BotState
  botUser: string | null
  inviteUrl: string | null
  error: string | null
  note: string | null
  lastMessageAt: number | null
}

export interface DiscordBotConfig {
  enabled: boolean
  hasToken: boolean
  allowedUsers: string[]
  channels: string[]
  provider: string
  model: string
  allowWrites: boolean
}

export interface DiscordBotConfigPatch {
  enabled?: boolean
  token?: string
  clearToken?: boolean
  allowedUsers?: string
  channels?: string
  provider?: string
  model?: string
  allowWrites?: boolean
}

/** Pull snowflake ids out of whatever was pasted: commas, spaces, <@mentions>, <#channels>. */
function snowflakes(input: string | null | undefined): string[] {
  return [...new Set((input ?? '').match(/\d{15,21}/g) ?? [])]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface DiscordUser {
  id: string
  username: string
  bot?: boolean
}

interface DiscordMessage {
  id: string
  channel_id: string
  guild_id?: string
  author: DiscordUser
  content: string
  mentions?: DiscordUser[]
  referenced_message?: { author?: DiscordUser } | null
}

interface GatewayPayload {
  op: number
  d: unknown
  s: number | null
  t: string | null
}

export class DiscordBot {
  private ws: WebSocket | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private firstBeat: ReturnType<typeof setTimeout> | null = null
  private acked = true
  private seq: number | null = null
  private sessionId: string | null = null
  private resumeUrl: string | null = null
  private botId: string | null = null
  private withContentIntent = true
  private stopped = true
  private backoff = 1000
  private generation = 0
  private queues = new Map<string, Promise<void>>()
  private channelNames = new Map<string, string>()
  private st: DiscordBotStatus = { state: 'off', botUser: null, inviteUrl: null, error: null, note: null, lastMessageAt: null }

  constructor(
    private win: BrowserWindow,
    private runner: AgentRunner
  ) {}

  // ------------------------------------------------------------ config

  config(): DiscordBotConfig {
    return {
      enabled: db.getSetting(KEYS.enabled) === '1',
      hasToken: !!db.getSetting(KEYS.token),
      allowedUsers: snowflakes(db.getSetting(KEYS.users)),
      channels: snowflakes(db.getSetting(KEYS.channels)),
      provider: db.getSetting(KEYS.provider) || 'lmstudio',
      model: db.getSetting(KEYS.model) || '',
      allowWrites: db.getSetting(KEYS.writes) === '1'
    }
  }

  async setConfig(patch: DiscordBotConfigPatch): Promise<DiscordBotConfig> {
    if (patch.clearToken) db.deleteSetting(KEYS.token)
    else if (patch.token !== undefined && patch.token.trim()) db.setSetting(KEYS.token, patch.token.trim())
    if (patch.allowedUsers !== undefined) db.setSetting(KEYS.users, snowflakes(patch.allowedUsers).join(','))
    if (patch.channels !== undefined) db.setSetting(KEYS.channels, snowflakes(patch.channels).join(','))
    if (patch.provider !== undefined) db.setSetting(KEYS.provider, patch.provider)
    if (patch.model !== undefined) db.setSetting(KEYS.model, patch.model.trim())
    if (patch.allowWrites !== undefined) db.setSetting(KEYS.writes, patch.allowWrites ? '1' : '0')
    if (patch.enabled !== undefined) db.setSetting(KEYS.enabled, patch.enabled ? '1' : '0')

    // The connection only depends on the token, the switch and the intents;
    // everything else is read per message and applies immediately.
    if (patch.enabled !== undefined || patch.token !== undefined || patch.clearToken) await this.restart()
    else this.refreshNote()
    return this.config()
  }

  status(): DiscordBotStatus {
    return { ...this.st }
  }

  private setStatus(patch: Partial<DiscordBotStatus>): void {
    this.st = { ...this.st, ...patch }
    if (!this.win.isDestroyed()) this.win.webContents.send('discordBot:changed', this.status())
  }

  private refreshNote(): void {
    const cfg = this.config()
    const notes: string[] = []
    if (!cfg.allowedUsers.length) notes.push('No allowed users yet — the bot ignores everyone until you add your Discord user id.')
    if (cfg.channels.length && !this.withContentIntent && this.st.state === 'online') {
      notes.push('Message Content intent is off in the Developer Portal, so listen channels only see @mentions. DMs and mentions work.')
    }
    this.setStatus({ note: notes.join(' ') || null })
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    const cfg = this.config()
    if (!cfg.enabled) return this.setStatus({ state: 'off', error: null })
    const token = db.getSetting(KEYS.token)
    if (!token) return this.setStatus({ state: 'error', error: 'Paste a bot token first.' })
    this.stopped = false
    this.withContentIntent = true
    this.backoff = 1000
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    this.generation++
    this.clearHeartbeat()
    try {
      this.ws?.close(1000)
    } catch {
      /* already closed */
    }
    this.ws = null
    this.sessionId = null
    this.seq = null
    this.setStatus({ state: 'off', error: null, botUser: null })
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.firstBeat) clearTimeout(this.firstBeat)
    this.heartbeat = null
    this.firstBeat = null
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    const gen = ++this.generation
    this.setStatus({ state: 'connecting', error: null })

    let url = this.resumeUrl
    if (!this.sessionId || !url) {
      try {
        const g = (await this.rest('GET', '/gateway/bot')) as { url?: string }
        url = g.url ?? 'wss://gateway.discord.gg'
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/401/.test(msg)) {
          this.stopped = true
          return this.setStatus({ state: 'error', error: 'Discord rejected the bot token (401). Reset it in the Developer Portal and paste the new one.' })
        }
        return this.scheduleReconnect(gen, `Could not reach Discord: ${msg}`)
      }
    }
    if (gen !== this.generation) return

    const ws = new WebSocket(`${url}/?v=10&encoding=json`)
    this.ws = ws
    ws.addEventListener('message', (e) => {
      if (gen !== this.generation) return
      try {
        this.onPayload(JSON.parse(String(e.data)) as GatewayPayload)
      } catch (err) {
        console.error('[discordBot] bad payload', err)
      }
    })
    ws.addEventListener('close', (e) => {
      if (gen !== this.generation) return
      this.onClose(e.code, gen)
    })
    ws.addEventListener('error', () => {
      /* a close event always follows; handled there */
    })
  }

  private send(op: number, d: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }))
  }

  private onPayload(p: GatewayPayload): void {
    if (p.s != null) this.seq = p.s
    switch (p.op) {
      case 10: {
        // Hello: begin heartbeating, then identify or resume.
        const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval
        this.clearHeartbeat()
        this.acked = true
        this.firstBeat = setTimeout(() => this.beat(), Math.floor(interval * Math.random()))
        this.heartbeat = setInterval(() => this.beat(), interval)
        const token = db.getSetting(KEYS.token) ?? ''
        if (this.sessionId && this.seq != null) {
          this.send(6, { token, session_id: this.sessionId, seq: this.seq })
        } else {
          const intents =
            INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGES | (this.withContentIntent ? INTENT_MESSAGE_CONTENT : 0)
          this.send(2, { token, intents, properties: { os: 'windows', browser: 'atlis', device: 'atlis' } })
        }
        return
      }
      case 11:
        this.acked = true
        return
      case 1:
        this.send(1, this.seq)
        return
      case 7:
        // Reconnect requested: close with a non-1000 code so the session stays resumable.
        this.ws?.close(4000)
        return
      case 9: {
        const resumable = p.d === true
        if (!resumable) {
          this.sessionId = null
          this.seq = null
        }
        setTimeout(() => this.ws?.close(4000), 1000 + Math.random() * 4000)
        return
      }
      case 0:
        this.onDispatch(p.t ?? '', p.d)
    }
  }

  private beat(): void {
    if (!this.acked) {
      // Zombied connection: no ack since the last beat. Drop it and resume.
      this.ws?.close(4000)
      return
    }
    this.acked = false
    this.send(1, this.seq)
  }

  private onClose(code: number, gen: number): void {
    this.clearHeartbeat()
    this.ws = null
    if (this.stopped) return

    if (code === 4014 && this.withContentIntent) {
      // Privileged intent not enabled in the portal: run without it.
      this.withContentIntent = false
      this.sessionId = null
      this.seq = null
      void this.connect().then(() => this.refreshNote())
      return
    }
    if (FATAL_CLOSE[code] || code === 4014) {
      this.stopped = true
      this.setStatus({ state: 'error', error: `${FATAL_CLOSE[code] ?? 'Disallowed intents.'} (close ${code})` })
      return
    }
    if (code === 4007 || code === 4009) {
      this.sessionId = null
      this.seq = null
    }
    this.scheduleReconnect(gen, null)
  }

  private scheduleReconnect(gen: number, error: string | null): void {
    if (this.stopped || gen !== this.generation) return
    this.setStatus({ state: 'connecting', error })
    const wait = this.backoff
    this.backoff = Math.min(this.backoff * 2, 60_000)
    setTimeout(() => {
      if (gen === this.generation) void this.connect()
    }, wait)
  }

  private onDispatch(type: string, d: unknown): void {
    if (type === 'READY') {
      const r = d as { user: DiscordUser; session_id: string; resume_gateway_url: string; application?: { id: string } }
      this.sessionId = r.session_id
      this.resumeUrl = r.resume_gateway_url
      this.botId = r.user.id
      this.backoff = 1000
      const appId = r.application?.id ?? r.user.id
      this.setStatus({
        state: 'online',
        error: null,
        botUser: r.user.username,
        inviteUrl: `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${INVITE_PERMISSIONS}`
      })
      this.refreshNote()
    } else if (type === 'RESUMED') {
      this.backoff = 1000
      this.setStatus({ state: 'online', error: null })
    } else if (type === 'MESSAGE_CREATE') {
      this.onMessage(d as DiscordMessage)
    }
  }

  // ------------------------------------------------------------ messages

  private onMessage(m: DiscordMessage): void {
    if (!this.botId || m.author?.bot || m.author?.id === this.botId) return
    const cfg = this.config()
    if (!cfg.allowedUsers.includes(m.author.id)) return

    const isDm = !m.guild_id
    const mentioned = !!m.mentions?.some((u) => u.id === this.botId)
    const repliedToBot = m.referenced_message?.author?.id === this.botId
    const listening = cfg.channels.includes(m.channel_id)
    if (!isDm && !mentioned && !repliedToBot && !listening) return

    const text = m.content.replace(new RegExp(`<@!?${this.botId}>`, 'g'), '').trim()
    if (!text) return
    this.setStatus({ lastMessageAt: Date.now() })

    // One run at a time per channel; later messages wait their turn.
    const prev = this.queues.get(m.channel_id) ?? Promise.resolve()
    const next = prev
      .then(() => this.handle(m, text, isDm))
      .catch((err) => console.error('[discordBot] handler failed', err))
    this.queues.set(m.channel_id, next)
    void next.finally(() => {
      if (this.queues.get(m.channel_id) === next) this.queues.delete(m.channel_id)
    })
  }

  private sessionMap(): Record<string, string> {
    try {
      return JSON.parse(db.getSetting(KEYS.sessions) ?? '{}') as Record<string, string>
    } catch {
      return {}
    }
  }

  private async resolveModel(provider: string, configured: string): Promise<string> {
    if (configured) return configured
    // No model chosen: take the first the provider lists (LM Studio lists loaded models first).
    const models = await getProvider(provider).listModels()
    if (!models.length) throw new Error(`${provider} lists no models. Pick one in Settings → Discord bot.`)
    return models[0].id
  }

  private async sessionFor(m: DiscordMessage, isDm: boolean, fresh: boolean): Promise<db.Session> {
    const cfg = this.config()
    const model = await this.resolveModel(cfg.provider, cfg.model)
    const map = this.sessionMap()
    const existing = !fresh && map[m.channel_id] ? db.getSession(map[m.channel_id]) : undefined
    if (existing) {
      // Follow the configured model, so changing it in Settings applies to ongoing channels.
      if (existing.provider !== cfg.provider || existing.model !== model) {
        db.updateSession(existing.id, { provider: cfg.provider, model })
      }
      return db.getSession(existing.id)!
    }
    const where = isDm ? `DM @${m.author.username}` : `#${await this.channelName(m.channel_id)}`
    const s = db.createSession({ title: `Discord · ${where}`, provider: cfg.provider, model })
    map[m.channel_id] = s.id
    db.setSetting(KEYS.sessions, JSON.stringify(map))
    return s
  }

  private async channelName(id: string): Promise<string> {
    const cached = this.channelNames.get(id)
    if (cached) return cached
    try {
      const c = (await this.rest('GET', `/channels/${id}`)) as { name?: string }
      const name = c.name ?? id
      this.channelNames.set(id, name)
      return name
    } catch {
      return id
    }
  }

  private async handle(m: DiscordMessage, text: string, isDm: boolean): Promise<void> {
    const cmd = text.toLowerCase()
    if (cmd === '!help') {
      return this.reply(m, [
        '**ATLIS over Discord**',
        '- Just ask: *"list my Magic cards worth over $2"*, *"what\'s on my todo list"*, *"how has Arcane Signet moved this week"*.',
        '- `!new` — start a fresh conversation (forget earlier context in this channel)',
        '- `!stop` — cancel the answer in progress',
        '- `!status` — which model is answering'
      ].join('\n'))
    }
    if (cmd === '!stop') {
      const id = this.sessionMap()[m.channel_id]
      if (id) this.runner.stop(id)
      return this.reply(m, id && this.runner.isRunning(id) ? 'Stopping.' : 'Nothing is running.')
    }
    if (cmd === '!status') {
      const cfg = this.config()
      const model = await this.resolveModel(cfg.provider, cfg.model).catch((e: Error) => `unavailable — ${e.message}`)
      return this.reply(m, `Model: **${cfg.provider}** / \`${model}\` · changes ${cfg.allowWrites ? 'allowed' : 'off (read-only)'}`)
    }
    if (cmd === '!new' || cmd === '!reset') {
      const s = await this.sessionFor(m, isDm, true)
      return this.reply(m, `Fresh conversation started (${s.title}).`)
    }

    let session: db.Session
    try {
      session = await this.sessionFor(m, isDm, false)
    } catch (err) {
      return this.reply(m, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
    }
    if (this.runner.isRunning(session.id)) {
      return this.reply(m, 'That conversation is busy in the ATLIS app right now — try again in a moment, or `!new`.')
    }

    const cfg = this.config()
    const typing = setInterval(() => void this.rest('POST', `/channels/${m.channel_id}/typing`).catch(() => {}), 8000)
    void this.rest('POST', `/channels/${m.channel_id}/typing`).catch(() => {})
    const before = db.listMessages(session.id).length
    try {
      await this.runner.send(session.id, text, mdToHtml(text), [], {
        toolAllowlist: cfg.allowWrites ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS,
        system: SYSTEM.replace('{writes}', cfg.allowWrites ? WRITES_ON : WRITES_OFF),
        maxHistory: HISTORY_WINDOW,
        maxToolResultChars: TOOL_RESULT_CAP
      })
    } catch (err) {
      clearInterval(typing)
      return this.reply(m, `⚠️ ${err instanceof Error ? err.message : String(err)}`)
    }
    clearInterval(typing)

    const produced = db.listMessages(session.id).slice(before)
    const final = [...produced].reverse().find((x) => x.role === 'assistant' && (x.kind === 'text' || x.kind === 'error'))
    const used = [...new Set(produced.filter((x) => x.kind === 'tool_call' && x.tool_name).map((x) => x.tool_name as string))]
    let body = final ? stripThinking(final.content_md) : ''
    if (final?.kind === 'error') body = `⚠️ ${body || 'The run failed.'}`
    if (!body) body = '_(the model returned an empty reply — if this keeps happening, send `!new` to start a fresh conversation)_'
    const footer = used.length ? `\n-# ${used.join(' · ')}` : ''
    await this.reply(m, body + footer)
  }

  // ------------------------------------------------------------ output

  /** Split on line boundaries under Discord's 2000-char cap. */
  private chunks(text: string): string[] {
    const out: string[] = []
    let cur = ''
    for (const line of text.split('\n')) {
      const pieces = line.length > DISCORD_LIMIT - 10 ? line.match(new RegExp(`.{1,${DISCORD_LIMIT - 10}}`, 'g')) ?? [] : [line]
      for (const piece of pieces) {
        if (cur.length + piece.length + 1 > DISCORD_LIMIT - 10) {
          out.push(cur)
          cur = piece
        } else {
          cur = cur ? `${cur}\n${piece}` : piece
        }
      }
    }
    if (cur) out.push(cur)
    return out
  }

  private async reply(m: DiscordMessage, text: string): Promise<void> {
    // Model output must never ping @everyone, roles or users.
    const base = { allowed_mentions: { parse: [] as string[], replied_user: false } }
    const reference = { message_reference: { message_id: m.id, fail_if_not_exists: false } }
    const parts = this.chunks(text)
    try {
      if (parts.length <= MAX_INLINE_CHUNKS) {
        for (const [i, part] of parts.entries()) {
          await this.rest('POST', `/channels/${m.channel_id}/messages`, { ...base, ...(i === 0 ? reference : {}), content: part })
        }
        return
      }
      // Too long to post inline: the opening as a message, the whole reply as a file.
      const form = new FormData()
      form.append(
        'payload_json',
        JSON.stringify({
          ...base,
          ...reference,
          content: `${parts[0].slice(0, DISCORD_LIMIT - 80)}\n\n_…full reply attached (${text.length.toLocaleString()} chars)_`,
          attachments: [{ id: 0, filename: 'atlis-reply.md' }]
        })
      )
      form.append('files[0]', new Blob([text], { type: 'text/markdown' }), 'atlis-reply.md')
      await this.rest('POST', `/channels/${m.channel_id}/messages`, form)
    } catch (err) {
      console.error('[discordBot] reply failed', err)
    }
  }

  /** Discord REST with its token and 429 handling. */
  private async rest(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = db.getSetting(KEYS.token)
    if (!token) throw new Error('No bot token.')
    for (let attempt = 0; attempt < 4; attempt++) {
      const isForm = body instanceof FormData
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': UA,
          ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {})
        },
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000)
      })
      if (res.status === 429) {
        const j = (await res.json().catch(() => ({}))) as { retry_after?: number }
        await sleep(Math.ceil((j.retry_after ?? 1) * 1000) + 50)
        continue
      }
      if (res.status === 204) return null
      if (!res.ok) throw new Error(`Discord ${method} ${path} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
      return res.json()
    }
    throw new Error(`Discord ${method} ${path} kept rate-limiting.`)
  }
}
