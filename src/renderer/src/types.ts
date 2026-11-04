export type ProviderId = 'anthropic' | 'openai' | 'copilot' | 'lmstudio'

export interface Session {
  id: string
  title: string
  project_id: string | null
  provider: ProviderId
  model: string
  system_prompt: string
  agent_mode: number
  status: string
  participants: string | null // JSON Participant[] — 2+ entries turns the session into a roundtable
  created_at: number
  updated_at: number
}

/** One model seat in a roundtable session. */
export interface Participant {
  id: string
  name: string
  provider: string
  model: string
  persona?: string
  color?: string
}

/** Roundtable settings: stored as JSON on sessions.participants — either a
 *  bare Participant[] (legacy) or `{ seats, maxTurns }`. */
export interface RoundtableConfig {
  seats: Participant[]
  maxTurns: number // total speaking turns per user message / continue
}

const validSeats = (arr: unknown): Participant[] =>
  Array.isArray(arr) ? (arr as Participant[]).filter((p) => p && p.name && p.provider && p.model) : []

export function parseRoundtable(s: Session | null | undefined): RoundtableConfig {
  const empty: RoundtableConfig = { seats: [], maxTurns: 0 }
  if (!s?.participants) return empty
  try {
    const parsed = JSON.parse(s.participants) as unknown
    const seats = Array.isArray(parsed) ? validSeats(parsed) : validSeats((parsed as { seats?: unknown }).seats)
    if (!seats.length) return empty
    const raw = Array.isArray(parsed) ? NaN : Number((parsed as { maxTurns?: unknown }).maxTurns)
    const maxTurns = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.round(raw), 24) : Math.min(seats.length * 3, 24)
    return { seats, maxTurns }
  } catch {
    return empty
  }
}

export function parseParticipants(s: Session | null | undefined): Participant[] {
  return parseRoundtable(s).seats
}

export interface ImageAttachment {
  id: string
  kind: 'image'
  mime: string
  filename: string // also the atlis-media:// host for rendering
  name: string
}

export interface PendingAttachment {
  mime: string
  name?: string
  dataBase64: string
}

export interface Message {
  id: string
  session_id: string
  role: string
  kind: string // text | tool_call | tool_result | error | streaming
  content_md: string
  content_html: string
  tool_name: string | null
  tool_payload: string | null
  author: string | null // roundtable participant name; null for the single-model agent
  attachments: ImageAttachment[]
  created_at: number
}

export interface Project {
  id: string
  name: string
  color: string
  created_at: number
}

export interface ModelInfo {
  id: string
  label: string
  provider: ProviderId
}

/** One row in the browser's tab rail. */
export interface BrowserTab {
  id: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
  audible: boolean
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  visible: boolean
  tabs: BrowserTab[]
  activeTabId: string | null
}

/** Readable snapshot of the embedded browser's current page. */
export interface PageCapture {
  url: string
  title: string
  text: string
}

/** Bookmarks bar entry; the list is persisted as JSON in the settings table. */
export interface Bookmark {
  title: string
  url: string
  /**
   * Slash-separated folder path, from an import. Absent for bookmarks starred
   * in ATLIS, which sit loose on the bar; the bar groups the rest into folder
   * chips by the first path segment.
   */
  folder?: string
}

/** A Firefox-family profile ATLIS can import bookmarks from. */
export interface BookmarkSource {
  path: string
  browser: string
  profile: string
  isDefault: boolean
  count: number
  lastUsed: number
}

/** A node of an imported profile's bookmark tree. */
export interface BookmarkNode {
  id: string
  type: 'folder' | 'link'
  title: string
  url?: string
  count: number
  children?: BookmarkNode[]
}

export interface DocMeta {
  id: string
  title: string
  session_id: string | null
  created_at: number
  updated_at: number
}

export interface Doc extends DocMeta {
  html: string
}

export interface StreamEvent {
  sessionId: string
  type: 'text-delta' | 'message' | 'usage' | 'status' | 'error' | 'done'
  delta?: string
  messageId?: string
  message?: Message
  status?: string
  error?: string
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; energyWh: number }
}

export type View = 'hub' | 'chat' | 'browser' | 'planner' | 'docs' | 'settings' | 'finance' | 'agentZoo' | 'feed' | 'arena' | 'vault' | 'mtg' | 'torrents' | 'land' | 'drops'

// ---- arena (blind model comparison) ----
export interface Comparison {
  id: string
  prompt: string
  provider_a: string
  model_a: string
  provider_b: string
  model_b: string
  response_a: string
  response_b: string
  cost_a: number
  cost_b: number
  latency_a_ms: number | null
  latency_b_ms: number | null
  winner: 'a' | 'b' | 'tie' | 'both_bad' | null
  is_blind: number
  status: string
  error: string | null
  created_at: number
}

export interface ArenaEvent {
  compareId: string
  side: 'a' | 'b'
  type: 'delta' | 'done' | 'error'
  delta?: string
  error?: string
  latencyMs?: number
  costUsd?: number
}

// ---- MCP (Model Context Protocol) servers ----
export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled: boolean
}

export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  status: 'connected' | 'connecting' | 'error' | 'disabled'
  error?: string
  tools: { name: string; description: string }[]
}

// ---- App Host (launchable apps under test) ----
export interface AppConfig {
  name: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  sandbox: 'fresh' | 'persistent'
  readyPattern?: string
  healthUrl?: string
  mcpUrl?: string
  uiUrl?: string
  readyTimeoutSeconds?: number
  enabled: boolean
}

export interface AppStatus {
  name: string
  state: 'stopped' | 'starting' | 'running' | 'exited'
  enabled: boolean
  pid?: number
  port?: number
  runDir?: string
  uiUrl?: string
  mcpServer?: string
  startedAt?: number
  exitCode?: number | null
  note?: string
}

// ---- Desktop Control (drive existing installed apps) ----
export interface DesktopAppConfig {
  name: string
  command: string
  args?: string[]
  windowTitlePattern: string
  launchTimeoutSeconds?: number
  enabled: boolean
}

export interface DesktopStatus {
  name: string
  state: 'stopped' | 'tracked'
  enabled: boolean
  windowTitle?: string
  adopted?: boolean
}

export interface LeaderboardRow {
  provider: string
  model: string
  wins: number
  losses: number
  ties: number
  battles: number
  winRate: number
  avgCost: number
}

// ---- feed (news aggregator) ----
export type FeedKind = 'youtube' | 'reddit' | 'rss' | 'site'

export interface FeedSource {
  id: string
  kind: FeedKind
  title: string
  url: string
  handle: string | null
  icon: string | null
  category: string | null
  enabled: number
  last_fetched_at: number | null
  last_error: string | null
  created_at: number
}

export interface FeedItem {
  id: string
  source_id: string
  kind: FeedKind
  title: string
  url: string
  author: string | null
  summary: string | null
  thumbnail: string | null
  published_at: number | null
  score: number | null
  comments: number | null
  extra_json: string | null
  is_read: number
  is_saved: number
  is_hidden: number
  fetched_at: number
  created_at: number
  source_title: string
}

export type FeedFilter = 'all' | 'unread' | 'saved'
export interface FeedItemsQuery {
  filter?: FeedFilter
  kind?: FeedKind
  sourceId?: string
  limit?: number
  offset?: number
}
export interface FeedRefreshResult {
  ok?: boolean
  added: number
  sources?: number
  error?: string
}

// ---- finance ----
export interface Quote {
  symbol: string
  shortName: string | null
  price: number | null
  previousClose: number | null
  open: number | null
  dayHigh: number | null
  dayLow: number | null
  volume: number | null
  fiftyTwoWeekHigh: number | null
  fiftyTwoWeekLow: number | null
  marketCap: number | null
  trailingPE: number | null
  priceToBook: number | null
  eps: number | null
  currency: string | null
  exchange: string | null
  marketState: string | null
  dayChange: number | null
  dayChangePct: number | null
  weekChangePct: number | null
  yearChangePct: number | null
}
export interface ChartSeries {
  symbol: string
  timestamps: number[]
  open: (number | null)[]
  high: (number | null)[]
  low: (number | null)[]
  close: (number | null)[]
  volume: (number | null)[]
  meta: { price: number | null; previousClose: number | null; currency: string | null; exchange: string | null }
}
export interface Fundamentals {
  symbol: string
  shortName: string | null
  longName: string | null
  sector: string | null
  industry: string | null
  website: string | null
  summary: string | null
  marketCap: number | null
  trailingPE: number | null
  forwardPE: number | null
  priceToBook: number | null
  debtToEquity: number | null
  eps: number | null
  bookValue: number | null
  beta: number | null
  dividendYield: number | null
  earningsGrowth: number | null
  revenueGrowth: number | null
  profitMargins: number | null
  targetMeanPrice: number | null
  recommendationKey: string | null
  earningsTimestamp: number | null
}
export interface NewsItem {
  title: string
  publisher: string | null
  link: string
  publishedAt: number | null
}
export interface WatchlistTicker {
  symbol: string
  added: string
  is_favorite: boolean
  notes: string
  tags: string[]
  trade_plans: string[]
}
export interface Watchlist {
  tickers: WatchlistTicker[]
  last_synced: string | null
}
export interface Holding {
  symbol: string
  shares: number
  avg_cost: number
  added: string
  notes: string
}
export interface Portfolio {
  holdings: Holding[]
}
export interface FinanceSettings {
  account_size: number
  risk_pct: number
  show_ticker_tape: boolean
}
export interface FinanceState {
  watchlist: Watchlist
  portfolio: Portfolio
  settings: FinanceSettings
}

export interface CalendarEvent {
  id: string
  title: string
  start_at: number
  end_at: number | null
  all_day: number
  timezone: string | null
  location: string | null
  notes: string | null
  tags_json: string | null
  source: string
  external_id: string | null
  recurrence_rule: string | null
  created_at: number
  updated_at: number
}

export interface TodoItem {
  id: string
  title: string
  notes: string | null
  status: string
  priority: string
  due_at: number | null
  scheduled_at: number | null
  tags_json: string | null
  source: string
  external_id: string | null
  completed_at: number | null
  created_at: number
  updated_at: number
}

export interface ReminderItem {
  id: string
  title: string
  remind_at: number
  status: string
  linked_type: string | null
  linked_id: string | null
  notification_sent_at: number | null
  snoozed_until: number | null
  created_at: number
  updated_at: number
}

export type AgentZooKind = 'agent' | 'skill' | 'tool' | 'runtime' | 'config'

export interface AgentZooEntry {
  id: string
  name: string
  kind: AgentZooKind
  path: string
  origin: string
  description: string
  editable: boolean
}

// ---- vault (collectibles) ----
export type VaultCategory = 'coin' | 'bullion' | 'knife' | 'other' | 'mtg_card' | 'mtg_sealed' | 'tcg_sealed'
export interface VaultItem {
  id: string
  category: string
  name: string
  year: string | null
  maker: string | null
  grade: string | null
  quantity: number
  metal: string | null
  metal_weight_ozt: number | null
  purchase_price: number | null
  purchase_date: string | null
  notes: string | null
  photos: ImageAttachment[]
  /** Pricing-source reference; ('scryfall', card id, finish) drives the MTG feed. */
  ext_source: string | null
  ext_id: string | null
  variant: string | null
  created_at: number
  updated_at: number
}
export interface VaultValuation {
  id: string
  item_id: string
  kind: string // melt | market | manual
  value_mid: number
  value_low: number | null
  value_high: number | null
  spot_price: number | null
  source: string | null
  notes: string | null
  created_at: number
}
export interface SpotPrices {
  fetchedAt: number
  usdPerOzt: Partial<Record<string, number>>
  errors: string[]
}
/** item_id -> kind -> latest valuation */
export type VaultLatest = Record<string, Partial<Record<string, VaultValuation>>>

// ---- mtg (release calendar, prices, watchlist) ----
export type MtgVariant = 'nonfoil' | 'foil' | 'etched'
export interface ScryfallCard {
  id: string
  name: string
  set: string
  set_name: string
  collector_number: string
  rarity: string
  released_at?: string
  scryfall_uri?: string
  // Scryfall sends every size; the search IPC passes the row through untouched,
  // so the big ones are here whether or not the UI asks for them.
  image_uris?: { normal?: string; small?: string; large?: string; art_crop?: string }
  card_faces?: Array<{ image_uris?: { normal?: string; small?: string; large?: string; art_crop?: string } }>
  finishes?: string[]
  promo_types?: string[]
  prices?: Record<string, string | null>
  /** True when this card was printed in some earlier set. */
  reprint?: boolean
}
export interface MtgSet {
  code: string
  name: string
  set_type: string | null
  released_at: string | null
  card_count: number | null
  digital: number
  icon_svg_uri: string | null
  scryfall_uri: string | null
  parent_set_code: string | null
  synced_at: number
}
export interface MtgWatch {
  id: string
  kind: string // card | sealed
  name: string
  set_code: string | null
  collector_number: string | null
  image_url: string | null
  ext_source: string
  ext_id: string | null
  variant: string
  target_price: number | null
  alert_enabled: number
  last_price: number | null
  last_checked_at: number | null
  last_alert_at: number | null
  notes: string | null
  tags_json: string | null
  /** hunt | market, or null when the mode is derived. */
  mode_override: string | null
  msrp: number | null
  /** manual | inferred */
  msrp_source: string | null
  created_at: number
  updated_at: number
}

/** Price at each lookback, measured from the newest observed day (db.attachPeriodPrices). */
export interface MtgPeriodPrices {
  last_on: string | null
  p7: number | null
  p7_on: string | null
  p30: number | null
  p30_on: string | null
  p90: number | null
  p90_on: string | null
}

export type MtgWatchMode = 'hunt' | 'market'
export type MtgMsrpBand = 'below_msrp' | 'at_msrp' | 'near_msrp' | 'over_msrp'
export interface MtgBandVerdict {
  band: MtgMsrpBand
  overPct: number
  underMarketPct: number | null
}

/** A watchlist row as the watchlist IPC returns it — see lifecycle.annotateWatchlist. */
export interface MtgWatchRow extends MtgWatch, MtgPeriodPrices {
  mode: MtgWatchMode
  mode_auto: boolean
  mode_reason: string
  released_at: string | null
  retail_best: { retailer: string; price: number; status: string; url: string } | null
  retail_band: MtgBandVerdict | null
  market_band: MtgBandVerdict | null
}

/** A set plus its children (Commander decks, tokens, promos) under one header — mtg.setFamilies. */
export interface MtgSetFamily {
  code: string
  name: string
  releasedAt: string | null
  iconSvgUri: string | null
  setType: string | null
  codes: string[]
  stage: 'upcoming' | 'in_print' | 'out_of_print'
  products: number
  watched: number
  followed: boolean
}

export type MtgProductGroup = 'collector' | 'boosters' | 'commander' | 'bundles' | 'secret_lair' | 'other'

export interface MtgFamilyProduct {
  uuid: string
  name: string
  setCode: string
  category: string | null
  subtype: string | null
  group: MtgProductGroup
  releaseDate: string | null
  tcgplayerProductId: string | null
  price: number | null
  priceOn: string | null
  p30: number | null
  p30On: string | null
  evMean: number | null
  evNetPct: number | null
  watchId: string | null
  watchMode: MtgWatchMode | null
}

export interface MtgFamilyProducts {
  family: MtgSetFamily | null
  products: MtgFamilyProduct[]
  unpricedToday: number
  synced: string[]
  errors: string[]
}

export interface MtgLifecycleSettings {
  inPrintMonths: number
  maxPremium: number
  minUnderMarket: number
  zip: string | null
  radiusMi: number
}
export interface MtgPrice {
  id: string
  ext_id: string
  variant: string
  price: number
  currency: string
  source: string
  observed_on: string
  created_at: number
}
export interface MtgPriceRefreshResult {
  checked: number
  priced: number
  alerts: number
  errors: string[]
}
export interface MtgBackfillProgress {
  phase: 'mapping' | 'streaming' | 'writing' | 'done'
  megabytes?: number
  found?: number
  message?: string
}
export interface MtgBackfillResult {
  cards: number
  matched: number
  points: number
  megabytes: number
  seconds: number
  errors: string[]
}
export interface MtgSealedPriceRow {
  uuid: string
  name: string
  setCode: string
  category: string | null
  subtype: string | null
  tcgplayerProductId: string
  latest: number | null
  latestOn: string | null
  earliest: number | null
  earliestOn: string | null
  points: number
}
export interface MtgSealedSweep {
  sets: number
  products: number
  priced: number
  errors: string[]
}
export interface MtgPackEv {
  sets: Array<{ code: string; name: string }>
  booster: string
  boosterType: 'play' | 'collector'
  simulations: number
  poolSizes: Record<string, number>
  mean: number
  median: number
  p10: number
  p90: number
  /** Same sim, counting only cards worth at least liquidThreshold. */
  meanLiquid: number
  medianLiquid: number
  liquidThreshold: number
  packPrice: number | null
  chanceOfProfit: number | null
  topHits: Array<{ name: string; setCode: string; collectorNumber: string; price: number; finish: string; chancePerPack: number }>
  /** Chase cards with no market price — excluded from the maths entirely. */
  unpricedChase: number
  note: string | null
}
export interface MtgSetCardValue {
  id: string
  name: string
  setCode: string
  collectorNumber: string
  rarity: string
  /** Printed in an earlier set. Null when Scryfall didn't say. */
  reprint: boolean | null
  /** Highest price across the finishes this printing exists in. */
  bestPrice: number | null
  bestFinish: string | null
  /** Cheapest available finish — what "one of each" costs. */
  cheapestPrice: number | null
  prices: Record<string, number | null>
  promoTypes: string[]
  /** Headliner/serialized chase card — often unpriced because it barely trades. */
  notable: boolean
  imageUrl: string | null
  /** Higher-res full card, for the lightbox. */
  imageLarge: string | null
  /** Just the artwork, frame and text box cropped away. */
  artCrop: string | null
}
export interface MtgSetValuation {
  /** 'list' = pasted/imported card list; 'product' = one Secret Lair product sliced out of its shared set. */
  source?: 'set' | 'list' | 'product'
  sets: Array<{ code: string; name: string }>
  cards: MtgSetCardValue[]
  cardCount: number
  pricedCount: number
  totalBest: number
  totalCheapest: number
  note: string | null
}
/** Per card NAME: what it costs outside this product, and how much cEDH plays it. */
export interface MtgCardInsight {
  otherPrintings: number
  cheapest: {
    id: string
    price: number
    finish: string
    setCode: string
    setName: string
    collectorNumber: string
  } | null
  /** cEDH tournament play rate 0..1; null = not seen in tournament decks (or unknown — see cedhSource). */
  cedhRate: number | null
  /** edhtop16 = EDHTop16's own rate; lists = share of locally cached top-16 lists; none = no data. */
  cedhSource: 'edhtop16' | 'lists' | 'none'
}
export interface MtgCardInsights {
  cards: Record<string, MtgCardInsight>
  cedhNote: string | null
  priceNote: string | null
}

/** A recent Secret Lair drop. Release date, NOT a live on-sale feed. */
export interface MtgSecretLairDrop {
  name: string
  releaseDate: string
  /** Days since release — drop windows run roughly 2-4 weeks. */
  ageDays: number
  hasFoil: boolean
  tcgplayerProductId: string | null
  foilTcgplayerProductId: string | null
}

/** One announced-but-unreleased Secret Lair, as published ahead of the drop. */
export interface MtgSlUpcomingItem {
  id: string
  name: string
  picture: string | null
  release_date: string | null
  msrp: number | null
  foil: number
  etched: number
  randomized: number
}

/** A superdrop: the bundle of lairs that all go on sale the same day. */
export interface MtgSlUpcomingDrop {
  dropId: string
  dropName: string
  releaseDate: string | null
  /** Cost of buying one of everything in the drop at MSRP. */
  msrpTotal: number
  items: MtgSlUpcomingItem[]
}

export interface MtgSecretLairSync {
  count: number
  drops: number
  note: string | null
}

/** One card inside a sealed product, priced at the finish the product holds. */
export interface MtgSealedCard {
  scryfallId: string
  name: string
  setCode: string
  collectorNumber: string
  rarity: string
  count: number
  foil: boolean
  unitPrice: number | null
  /** Disagrees with `foil` when that finish has no market quote. */
  priceFinish: string | null
  lineTotal: number | null
  imageUrl: string | null
  imageLarge: string | null
  artCrop: string | null
  prices: Record<string, number | null>
}

/** A sealed product opened up: its determined contents, priced against it. */
export interface MtgSealedContents {
  uuid: string
  name: string
  setCode: string
  category: string | null
  subtype: string | null
  cards: MtgSealedCard[]
  cardCount: number
  pricedCount: number
  singlesTotal: number
  sealedPrice: number | null
  netGain: number | null
  netGainPct: number | null
  estimatedFinishCount: number
  /** Decklists MTGJSON names but never published — itemisation is partial. */
  missingComponents: string[]
  expectedCardCount: number | null
  /** False when the itemisation is a fragment; no verdict is offered then. */
  complete: boolean
  randomComponents: string[]
  expanded: string[]
  note: string | null
}

/** What opening one owned sealed copy added to the collection. */
export interface MtgRipResult {
  product: string
  added: number
  cards: number
  remaining: number
  note: string | null
}

/** One product on the standing expected-value board. */
export interface MtgEvRow {
  uuid: string
  set_code: string
  setName: string | null
  name: string
  /** pack | box | case | deck | bundle | other */
  kind: string
  tcgplayer_product_id: string | null
  price: number | null
  ev_mean: number | null
  /** Null for deterministic products — there is no distribution to take a median of. */
  ev_median: number | null
  ev_liquid: number | null
  /** deterministic (contents known exactly) | simulated (random contents) */
  method: string
  packs: number
  chance_of_profit: number | null
  net: number | null
  net_pct: number | null
  note: string | null
  priced_at: number | null
  computed_at: number
  /** Version of the EV model behind this row. */
  engine: number
  /** 'sheets' = real MTGJSON print sheets; 'model' = approximated pack structure. */
  basis: string
}

export interface MtgEvScanResult {
  sets: number
  products: number
  evaluated: number
  repriced: number
  skipped: number
  errors: string[]
}

/** A watchlist product a big-box retailer currently has well under market. */
export interface MtgRetailDeal {
  listingId: string
  watchId: string
  name: string
  setCode: string | null
  retailer: string
  url: string
  price: number
  /** Secondary-market price the discount is measured against. */
  market: number
  /** Percent under market, e.g. 74 for "74% below". */
  discount: number
  status: string
  /** preorder = not out yet; restock = already on the market, back at list. */
  kind: 'preorder' | 'restock'
  band: MtgMsrpBand | null
  overMsrpPct: number | null
  msrp: number | null
  checkedAt: number | null
  alertedAt: number | null
  /** The watch row's price handle + stored image, for the thumbnail. */
  extSource: string
  extId: string | null
  imageUrl: string | null
}

/** Where a tracked thing can be bought. `kind` says how much to trust the URL. */
export interface MtgListing {
  id: string
  watch_id: string | null
  vault_item_id: string | null
  retailer: string
  /** product = exact, from an id we hold · searched = name-matched, can be wrong · search = results page · manual = you pasted it */
  kind: 'product' | 'searched' | 'search' | 'manual'
  title: string | null
  url: string
  price: number | null
  status: 'in_stock' | 'in_store_only' | 'preorder' | 'listed' | 'sold_out_restocking' | 'out_of_stock' | 'unknown'
  /** The retailer's own words behind `status`, e.g. Best Buy's SOLD_OUT. */
  raw_state: string | null
  last_checked_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}
export interface MtgPreorderProduct {
  uuid: string
  name: string
  setCode: string
  setName: string
  releasedAt: string | null
  tcgplayerProductId: string | null
  listings: MtgListing[]
}
export interface MtgPreorderSet {
  setCode: string
  setName: string
  releasedAt: string | null
  products: MtgPreorderProduct[]
}
export interface MtgPreorderScan {
  sets: number
  products: number
  checked: number
  found: number
  errors: string[]
}
export interface MtgDiscoverResult {
  found: number
  productLinks: number
  needsManualLink: boolean
  note: string
}
export interface MtgStockRefreshResult {
  checked: number
  changed: number
  errors: string[]
  /** Listings the sweep deliberately did not fetch (muted or unwatched). */
  skipped: number
  transitions: Array<{
    name: string
    retailer: string
    from: string
    to: string
    rawState: string | null
    price: number | null
    url: string
    listingId: string
    watchId: string | null
  }>
}

/** A Vault item carrying a live price handle — an owned card or sealed product. */
export interface MtgOwnedItem extends MtgPeriodPrices {
  id: string
  name: string
  category: string
  quantity: number
  maker: string | null
  ext_source: string | null
  ext_id: string | null
  variant: string | null
  purchase_price: number | null
  last_price: number | null
  /** How many days of price history exist for it in mtg_prices. */
  points: number
  /** How many separate vault rows this line represents (1 unless stacked). */
  entries: number
  /** Newest observed day, YYYY-MM-DD. */
  last_on: string | null
  /** Price on the previous observed day — null until there are two points. */
  prev_price: number | null
  prev_on: string | null
  /** Sorted WUBRG letters ('B,G'), '' for colourless, null until synced. */
  color_identity: string | null
  type_line: string | null
  mana_cost: string | null
  cmc: number | null
  oracle_id: string | null
  set_code: string | null
  rarity: string | null
  /** EDHTop16 cEDH tournament play rate, 0..1 — null when unplayed or not yet synced. */
  cedh_play_rate: number | null
  /** 1 once EDHTop16 has been asked about this card. */
  cedh_synced: number
  /** Saved decks that run this card (by name, any printing). Empty = loose. */
  decks?: string[]
}
/** An owned card that could head a deck, plus how much the world plays it. */
export interface MtgOwnedCommander {
  id: string
  name: string
  ext_id: string | null
  ext_source: string | null
  quantity: number
  set_code: string | null
  rarity: string | null
  type_line: string | null
  oracle_text: string | null
  color_identity: string
  last_price: number | null
  /** Null when EDHREC does not rank it — outside the top 100 of its colours. */
  num_decks: number | null
  rank_in_color: number | null
  color_slug: string | null
  edhrec_slug: string | null
  edhrec_url: string
}
export type MtgDeckBoard = 'commander' | 'main'
export interface MtgDeckCardView {
  name: string
  name_key: string
  board: MtgDeckBoard
  quantity: number
  ext_id: string | null
  type_line: string | null
  mana_cost: string | null
  cmc: number | null
  color_identity: string | null
  price: number | null
  /** Copies owned across all printings. */
  owned: number
  basic: boolean
  other_decks: string[]
  in_identity: boolean
}
export interface MtgDeckSummary {
  id: string
  name: string
  kind: 'custom' | 'precon' | 'cedh' | 'edhrec'
  color_identity: string
  commanders: string[]
  commander_ext_id: string | null
  card_count: number
  owned_count: number
  missing_cost: number
  value: number
  source_url: string | null
  updated_at: number
}
export interface MtgDeckDetail extends MtgDeckSummary {
  notes: string | null
  cards: MtgDeckCardView[]
  note: string | null
}
export interface MtgDeckRow {
  id: string
  name: string
  kind: 'custom' | 'precon' | 'cedh' | 'edhrec'
  color_identity: string
}
export interface MtgDeckCandidate {
  kind: 'sealed' | 'ripped'
  ref: string
  name: string
  cards: number | null
  deck_id: string | null
}
// ---- Play in ATLIS: the Forge bridge's wire format (forge-bridge/…/Snapshot.java) ----
export interface GameCard {
  id: number
  hidden?: boolean
  owner: number | null
  name?: string
  controller?: number | null
  zone?: string | null
  tapped?: boolean
  sick?: boolean
  attacking?: boolean
  blocking?: boolean
  token?: boolean
  commander?: boolean
  faceDown?: boolean
  damage?: number
  type?: string | null
  manaCost?: string | null
  text?: string | null
  land?: boolean
  creature?: boolean
  power?: number
  toughness?: number
  loyalty?: string
  defense?: string
  counters?: Record<string, number>
  attachedTo?: number
  /** Forge's current input lets you click it. */
  selectable?: boolean
  /** You can act on it right now (cast, play, activate). */
  playable?: boolean
  /** Forge's auto-pay would tap it for the cost being paid. */
  autoTap?: boolean
  /** Targeted / referenced by the current prompt. */
  highlighted?: boolean
  canAttack?: boolean
  canBlock?: boolean
  /** During blocks: the attackers (coming at you) this creature may legally block. */
  blocks?: number[]
  /** Must attack this combat (goad, "attacks each combat if able"); Forge rejects declarations without it. */
  mustAttack?: boolean
  /** Players who goaded it: it must attack someone else if it can. */
  goadedBy?: string
  /** UI only: you clicked this creature to block with; it waits for you to pick the attacker. */
  armed?: boolean
  set?: string
  cn?: string
  /** Scryfall printing id, filled in by ATLIS. */
  art?: string | null
}
export interface GamePlayer {
  id: number
  name: string
  ai: boolean
  life: number
  lost: boolean
  priority: boolean
  landsPlayed: number
  maxLands: number
  counters: Record<string, number>
  highlighted: boolean
  mana: Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C', number>
  commanders: number[]
  /** Commander id → times cast from the command zone (tax = 2 × this). */
  commanderCast: Record<string, number>
  /** Commander id → combat damage THIS player has taken from it. */
  commanderDamage: Record<string, number>
  library: number
  /** Top card of the library, when Forge lets you see it (Vesuvan Drifter, Conspicuous Snoop, revealed tops). */
  libraryTop?: number
  zones: { hand: number[]; battlefield: number[]; graveyard: number[]; exile: number[]; command: number[] }
}
export interface GameStackItem {
  id: number
  text: string
  trigger: boolean
  ability: boolean
  source?: number
  controller: number | null
  targetCards: number[]
  targetPlayers: number[]
}
export interface GameState {
  type: 'state'
  turn: number
  phase: string | null
  activePlayer: number | null
  mulligan: boolean
  gameOver: boolean
  winner: string | null
  you: number | null
  players: GamePlayer[]
  stack: GameStackItem[]
  combat: Array<{ attacker: number; defender?: number; defenderIsPlayer?: boolean; blockers: number[] }>
  prompt: { message: string; card: number | null; okLabel: string; cancelLabel: string; okEnabled: boolean; cancelEnabled: boolean; min: number; max: number }
  /** Forge's game log, oldest first (phase changes omitted). */
  log?: Array<{ type: string; text: string; card?: number }>
  cards: Record<string, GameCard>
}
export interface GameRequest {
  type: 'request'
  kind: 'choose' | 'confirm' | 'option' | 'input' | 'ability' | 'order' | 'assign'
  rid: number
  title: string
  min: number
  max: number
  card?: number
  default?: number
  initial?: string
  numeric?: boolean
  top?: string
  /** cardData: the option's card in full, for cards not on the table (library during a search). */
  /** assign: the total to divide, whether each option needs at least 1, and the unit ("mana", "damage"…). */
  amount?: number
  atLeastOne?: boolean
  unit?: string
  options?: Array<{ i: number; label: string; card?: number; player?: number; canPlay?: boolean; cardData?: GameCard; max?: number; color?: string }>
}
export type GameEvent =
  | GameState
  | GameRequest
  | { type: 'booting' | 'started' | 'gameOver' | 'invalid' }
  | { type: 'booted'; bootMs: number }
  | { type: 'message'; title: string; message: string }
  | { type: 'reveal'; title: string; options: Array<{ i: number; label: string; card?: number; player?: number }> }
  | { type: 'error'; message: string }
  | { type: 'exited'; code: number | null; detail: string | null }
export interface GameDeckOption {
  path: string
  name: string
  kind: 'atlis' | 'precon'
  deckId?: string
  set?: string
  year?: string
}
export interface ForgeStatus {
  installDir: string | null
  detected: boolean
  javaVersion: string | null
  javaMajor: number | null
  decksDir: string
  exported: string[]
  launchable: boolean
  latestRelease: string
}
export interface MtgPreconHit {
  fileName: string
  name: string
  code: string
  setName: string | null
  releaseDate: string | null
  matchedBy: 'name' | 'set' | 'commander'
}
export interface MtgComboPiece {
  name: string
  ext_id: string | null
  in_deck: boolean
  owned: boolean
  price: number | null
}
export interface MtgCombo {
  id: string
  pieces: MtgComboPiece[]
  results: string[]
  decks: number
  url: string
  status: 'in_deck' | 'ready' | 'missing'
  missing_count: number
  missing_cost: number
}
export interface MtgUpgrade {
  name: string
  ext_id: string | null
  category: string
  inclusion: number
  synergy: number
  owned: boolean
  price: number | null
  combos: number
  completes: number
  score: number
  type_group: string
}
export interface MtgCut {
  name: string
  ext_id: string | null
  type_group: string
  inclusion: number
  synergy: number | null
  unlisted: boolean
  combo_piece: boolean
  price: number | null
  score: number
}
export interface MtgDeckRecs {
  commanders: string[]
  edhrec_url: string | null
  edhrec_decks: number | null
  combos: MtgCombo[]
  owned_adds: MtgUpgrade[]
  buys: MtgUpgrade[]
  cuts: MtgCut[]
  swaps: Array<{ cut: MtgCut; add: MtgUpgrade }>
  note: string | null
}
export interface MtgShoppingItem {
  name: string
  ext_id: string | null
  price: number | null
  score: number
  completes: number
  decks: Array<{ id: string; name: string }>
}
export interface MtgExploreCommander {
  name: string
  num_decks: number
  color_slug: string
  rank_in_color: number
  owned: boolean
  in_decks: string[]
}
export interface MtgExploreFilter {
  commanders: string[]
  bracket?: number | null
  theme?: string | null
}
export type MtgExploreRef =
  | ({ kind: 'average' } & MtgExploreFilter)
  | { kind: 'user'; hash: string }
export interface MtgExploreDeckRow {
  hash: string
  saved: string | null
  price: number | null
  salt: number | null
  bracket: number | null
  tags: string[]
}
export interface MtgExplorePage {
  commander: string
  slug: string
  url: string
  header: string
  num_decks: number | null
  matching: number
  bracket_counts: Record<string, number>
  themes: Array<{ slug: string; label: string; count: number }>
  similar: string[]
  decks: MtgExploreDeckRow[]
}
export interface MtgCedhMatch {
  entry_id: string
  commander: string
  color_identity: string
  standing: number | null
  player: string | null
  tournament: string | null
  tournament_size: number | null
  tournament_date: string | null
  decklist_url: string | null
  deck_price: number | null
  card_count: number
  owned_count: number
  owned_pct: number
  missing_cost: number
  own_commander: boolean
  synced_at: number
}
export interface MtgCommanderSync {
  colors: number
  commanders: number
  failed: string[]
}
export interface MtgSealed {
  uuid: string
  name: string
  set_code: string
  category: string | null
  subtype: string | null
  release_date: string | null
  /** The only usable price handle — MTGJSON has no sealed prices. */
  tcgplayer_product_id: string | null
  card_kingdom_id: string | null
  synced_at: number
}
export interface MtgSealedSearch {
  products: MtgSealed[]
  note: string | null
}
export interface MtgSmartSearch {
  cards: ScryfallCard[]
  /** The query actually sent to Scryfall — differs from your input when rewritten. */
  sent: string
  rewritten: boolean
  /** Plain-English explanation of the rewrite, for showing under the search box. */
  note: string | null
}

// ---- torrents ----
export interface TorrentInfo {
  id: string
  name: string
  status: 'downloading' | 'paused' | 'done' | 'error'
  infoHash: string | null
  savePath: string
  totalBytes: number | null
  downloadedBytes: number
  uploadedBytes: number
  progress: number // 0..1
  downloadSpeed: number // bytes/s
  uploadSpeed: number
  numPeers: number
  etaSec: number | null
  fileCount: number | null
  hasMetadata: boolean
  error: string | null
  addedAt: number
  completedAt: number | null
}
export interface AddTorrentInput {
  magnet?: string
  url?: string
  torrentBase64?: string
  fileName?: string
}

export interface MediaState {
  open: boolean
  title: string
  audible: boolean
}


// ---- land search ----
export type LandVerdict = 'strong' | 'workable' | 'marginal' | 'avoid' | 'unknown'

export interface LandRegionStatus {
  fips: string; state: string; name: string; enabled: number
  min_lon: number | null; min_lat: number | null; max_lon: number | null; max_lat: number | null
  parcel_count: number; candidate_count: number
  status: string; note: string | null
  ingested_at: number | null; overlays_at: number | null; scored_at: number | null
  overlays: Record<string, number>
  addresses: number
  enriched: Record<string, number>
  assessments: { total: number; absentee: number }
  pois: Record<string, number>
  fitted: number
}

export interface LandAnchor {
  id: string; label: string; kind: string
  lat: number; lon: number; address: string | null
  weight: number; ideal_minutes: number; max_minutes: number
  active: number; notes: string | null; created_at: number
}

export type LandFitVerdict = 'easy' | 'workable' | 'shift' | 'remote' | 'unknown'

export interface LandFitLeg {
  id: string; label: string; group: 'anchor' | 'amenity'
  minutes: number | null; score: number | null; weight: number; detail: string
}

export interface LandFit {
  score: number
  verdict: LandFitVerdict
  commuteMinutes: number | null
  legs: LandFitLeg[]
  lifestyleNote: string | null
}

export interface LandAssessment {
  parcel_id: string; fips: string
  av_land: number | null; av_improvement: number | null; av_total: number | null
  deeded_acres: number | null; class_code: string | null
  owner_name: string | null; owner_street: string | null
  owner_city: string | null; owner_state: string | null; owner_zip: string | null
  absentee: number; assessment_year: number | null; updated_at: number
}

export interface LandComparable {
  median: number | null; p25: number | null; p75: number | null; samples: number
}

export type LandAbsenteeRow = LandParcelRow & {
  owner_name: string | null; owner_city: string | null; owner_state: string | null
  av_land: number | null; av_total: number | null
}

export interface LandParcelRow {
  id: string; fips: string; pin: string
  address: string | null; city: string | null; owner: string | null
  acres: number | null; land_use: string | null; vacant: number; assessed: number | null
  lat: number; lon: number
  min_lon: number | null; min_lat: number | null; max_lon: number | null; max_lat: number | null
  candidate: number; ingested_at: number
  total: number | null; verdict: LandVerdict | null; flags: string | null
  hookup_low: number | null; hookup_high: number | null; coverage: number | null
}

export interface LandSubScore { score: number; weight: number; why: string }

export interface LandParcelDetail {
  parcel: LandParcelRow
  score: {
    parcel_id: string; total: number; verdict: LandVerdict
    subs: string; flags: string
    hookup_low: number | null; hookup_high: number | null
    coverage: number; scored_at: number
  } | null
  facts: Record<string, unknown>
  assessment: LandAssessment | null
  comparable: LandComparable | null
  fit: LandFit
  lifestyleNote: string | null
  region: { fips: string; name: string; state: string; note: string | null }
}

export interface LandWeights {
  flood: number; slope: number; septic: number; utility: number
  karst: number; wetland: number; toxic: number; cover: number; size: number
}

export interface LandJob {
  running: boolean; kind: string | null; fips: string | null
  message: string; pct: number | null
}

export interface LandSourceCheck {
  id: string; label: string; tier: string; ok: boolean; detail: string
}

export interface LandListing {
  id: string; parcel_id: string | null; fips: string | null
  source: string | null; url: string | null
  address: string | null; price: number | null; acres: number | null
  lat: number | null; lon: number | null
  status: string; notes: string | null
  created_at: number; updated_at: number
}

export interface LandUtility {
  id: string; fips: string; kind: string; name: string
  base_fee: number; free_feet: number; cost_per_foot: number
  source_url: string | null; note: string | null; updated_at: number
}

// ---- drops (limited-run availability) ----
export interface DropWatch {
  id: string
  label: string
  kind: string // shopify | wix | page
  url: string
  title_match: string | null
  priority: string // hot | normal
  enabled: number
  notify: number
  etag: string | null
  last_checked_at: number | null
  last_ok_at: number | null
  last_error: string | null
  heat: number | null
  sellout_rate: number | null
  median_uptime_ms: number | null
  scored_at: number | null
  pinned: number
  /** CSV of transition kinds worth alerting on; null uses the app default. */
  alert_kinds: string | null
  /** Per-product silence window after an alert; null uses the app default. */
  alert_cooldown_ms: number | null
  created_at: number
  updated_at: number
}

/** How a transition reaches a person, and whether that path is configured. */
export interface AlertSinkStatus {
  name: string
  ready: boolean
}

export interface DiscordAlertConfig {
  webhook: string
  mention: string
  valid: boolean
  /** Whether the saved mention will actually produce a ping. */
  pings: boolean
}

export interface DiscordBotStatus {
  state: 'off' | 'connecting' | 'online' | 'error'
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

export interface AlertsConfig {
  enabled: boolean
  sinks: AlertSinkStatus[]
  discord: DiscordAlertConfig
  kinds: readonly string[]
  defaultKinds: string[]
  defaultCooldownMs: number
}

export interface AlertTestResult {
  delivered: string[]
  errors: string[]
}

export interface TcgGame {
  url: string
  label: string
}

export type TcgPrinting = 'Normal' | 'Foil'

export interface TcgProduct {
  productId: string
  name: string
  gameLabel: string
  set: string | null
  /** Collector number as the game prints it, e.g. "EBP01-001SSP". */
  number: string | null
  rarity: string | null
  sealed: boolean
  foilOnly: boolean
  market: number | null
  low: number | null
  listings: number
  image: string
  url: string
}

export interface TcgWatch {
  id: string
  game: string
  game_label: string
  product_id: string
  printing: TcgPrinting
  kind: 'card' | 'sealed'
  name: string
  set_name: string | null
  rarity: string | null
  image_url: string | null
  target_price: number | null
  notify: number
  notes: string | null
  last_price: number | null
  last_median: number | null
  last_in_stock: number | null
  last_checked_at: number | null
  last_ok_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

export interface TcgHistoryPoint {
  t: number
  price: number | null
  median: number | null
  listed: number | null
}

export interface TcgCheckResult {
  checked: number
  changed: number
  errors: string[]
}

/** A set as TCGplayer lists it for a game. */
export interface TcgSet {
  url: string
  name: string
  count: number
}

export interface TcgSetProducts {
  cards: TcgProduct[]
  sealed: TcgProduct[]
  truncated: boolean
}

/** One printing's live TCGplayer quote. */
export interface TcgQuote {
  market: number | null
  median: number | null
  listed: boolean
}

export interface DropProduct {
  id: string
  watch_id: string
  ext_id: string
  handle: string | null
  title: string
  url: string | null
  image: string | null
  price: number | null
  available: number
  variants_total: number
  variants_available: number
  product_type: string | null
  published_at: number | null
  first_seen_at: number
  last_seen_at: number
  last_available_at: number | null
  gone: number
}

export type DropEventKind = 'restock' | 'sold_out' | 'new_product' | 'removed' | 'price_change'

export interface DropEvent {
  id: string
  watch_id: string
  product_id: string | null
  kind: DropEventKind
  title: string
  detail: string | null
  url: string | null
  price: number | null
  seen: number
  created_at: number
  watch_label: string
}

export interface DropTransition {
  watchId: string
  watchLabel: string
  kind: DropEventKind
  title: string
  detail: string | null
  url: string | null
  price: number | null
}

export interface DropPollResult {
  watches: number
  changed: number
  transitions: DropTransition[]
  errors: string[]
}

export interface DropProbeResult {
  ok: boolean
  products: number
  note: string | null
}

// ---- signals (demand intent) + coverage ----
export type SignalIntent = 'purchase' | 'scarcity' | 'release' | 'resale' | 'community' | 'other'

export interface SignalTerm {
  id: string
  term: string
  source: string
  watch_id: string | null
  enabled: number
  last_checked_at: number | null
  last_error: string | null
  created_at: number
}

export interface SuggestionMove {
  suggestion: string
  intent: SignalIntent
  rank: number
  /** Rank when the window opened; null when the completion is new. */
  wasRank: number | null
  /** Positive means it climbed toward the top since the window opened. */
  delta: number | null
}

export interface TermReading {
  id: string
  term: string
  score: number
  days: number
  suggestions: number
  byIntent: Record<SignalIntent, number>
  rising: SuggestionMove[]
  lastCheckedAt: number | null
  lastError: string | null
}

export interface SignalSampleResult {
  term: string
  suggestions: number
  byIntent: Record<SignalIntent, number>
  score: number
  note: string | null
}

export interface SignalSweepResult {
  terms: number
  sampled: number
  errors: string[]
}

export interface TrendingItem {
  title: string
  traffic: string | null
  link: string | null
}

export interface DropCandidate {
  domain: string
  source: string
  shopify: number | null
  products: number | null
  title_sample: string | null
  niche_score: number | null
  promoted: number
  probed_at: number | null
  error: string | null
  created_at: number
}

export interface DropCandidateCounts {
  total: number
  probed: number
  shopify: number
  promoted: number
}

export interface DropDiscoverResult {
  scanned: number
  domains: number
  added: number
  page: number
  note: string | null
}

export interface DropProbeCandidatesResult {
  probed: number
  shopify: number
  scored: number
  errors: number
}

export interface DropHeatResult {
  scored: number
  hottest: Array<{ label: string; heat: number; selloutRate: number; medianUptimeMs: number | null }>
  promoted: string[]
  demoted: string[]
}

export interface DiscordWatch {
  id: string
  invite_code: string
  guild_id: string | null
  label: string
  watch_id: string | null
  enabled: number
  last_checked_at: number | null
  last_error: string | null
  created_at: number
}

export interface DiscordReading {
  id: string
  label: string
  inviteCode: string
  members: number | null
  online: number | null
  /** online / members as a percentage */
  presencePct: number | null
  /** median presence percentage over the baseline window */
  baselinePct: number | null
  /** current presence over baseline; 2.0 means twice as busy as usual */
  surge: number | null
  growth24h: number | null
  growth7d: number | null
  growthPct7d: number | null
  samples: number
  lastCheckedAt: number | null
  lastError: string | null
}

export interface DiscordSweepResult {
  watched: number
  sampled: number
  surges: Array<{ label: string; surge: number; online: number | null; members: number | null }>
  errors: string[]
}

declare global {
  interface Window {
    atlis: {
      sessions: {
        list(): Promise<Session[]>
        create(opts: Partial<Session>): Promise<Session>
        update(id: string, patch: Partial<Session>): Promise<void>
        remove(id: string): Promise<void>
      }
      messages: { list(sessionId: string): Promise<Message[]> }
      chat: {
        send(sessionId: string, md: string, html: string, attachments?: PendingAttachment[]): Promise<void>
        stop(sessionId: string): Promise<void>
        running(sessionId: string): Promise<boolean>
        roundtableContinue(sessionId: string, rounds?: number): Promise<void>
        onEvent(cb: (ev: StreamEvent) => void): () => void
      }
      mcp: {
        status(): Promise<McpServerStatus[]>
        getConfig(): Promise<McpServerConfig[]>
        setConfig(servers: McpServerConfig[]): Promise<McpServerStatus[]>
        reload(): Promise<McpServerStatus[]>
        onChanged(cb: () => void): () => void
      }
      apps: {
        status(): Promise<AppStatus[]>
        getConfig(): Promise<AppConfig[]>
        setConfig(configs: AppConfig[]): Promise<AppStatus[]>
        launch(name: string): Promise<string>
        stop(name: string): Promise<string>
        logs(name: string, tailChars?: number): Promise<string>
        openUi(name: string): Promise<boolean>
        onChanged(cb: () => void): () => void
      }
      desktop: {
        status(): Promise<DesktopStatus[]>
        getConfig(): Promise<DesktopAppConfig[]>
        setConfig(configs: DesktopAppConfig[]): Promise<DesktopStatus[]>
        launch(name: string): Promise<string>
        stop(name: string): Promise<string>
        screenshot(name: string): Promise<{ text: string; imageMime: string; imageBase64: string }>
        click(name: string, x: number, y: number, button?: 'left' | 'right', doubleClick?: boolean): Promise<string>
        type(name: string, text: string, submit?: boolean): Promise<string>
        key(name: string, keys: string): Promise<string>
      }
      arena: {
        start(opts: { prompt: string; provider_a: string; model_a: string; provider_b: string; model_b: string; is_blind: boolean }): Promise<Comparison>
        stop(id: string): Promise<void>
        vote(id: string, winner: 'a' | 'b' | 'tie' | 'both_bad'): Promise<Comparison | undefined>
        list(limit?: number): Promise<Comparison[]>
        get(id: string): Promise<Comparison | undefined>
        remove(id: string): Promise<void>
        leaderboard(): Promise<LeaderboardRow[]>
        onEvent(cb: (ev: ArenaEvent) => void): () => void
      }
      providers: {
        list(): Promise<ProviderId[]>
        models(providerId: string): Promise<{ ok: boolean; models?: ModelInfo[]; error?: string }>
      }
      browser: {
        navigate(url: string): Promise<void>
        back(): Promise<void>
        forward(): Promise<void>
        reload(): Promise<void>
        devtools(): Promise<void>
        setBounds(b: { x: number; y: number; width: number; height: number }): Promise<void>
        setVisible(v: boolean): Promise<void>
        state(): Promise<BrowserState>
        newTab(url?: string, background?: boolean): Promise<string>
        closeTab(id: string): Promise<void>
        activateTab(id: string): Promise<void>
        suspend(on: boolean): Promise<void>
        folderMenu(items: { title: string; url: string; sub: string[] }[], x: number, y: number): Promise<void>
        bookmarkSources(): Promise<BookmarkSource[]>
        bookmarkTree(profilePath: string): Promise<BookmarkNode[]>
        capturePage(): Promise<PageCapture>
        saveAsDoc(): Promise<DocMeta>
        onState(cb: (s: BrowserState) => void): () => void
        onFocusAddress(cb: () => void): () => void
      }
      settings: {
        getAll(): Promise<Record<string, string>>
        set(key: string, value: string): Promise<void>
      }
      /** Whole-interface zoom (1 = 100%). Also driven by Ctrl +/−/0 and Ctrl+wheel. */
      ui: {
        getZoom(): Promise<number>
        setZoom(z: number): Promise<number>
        stepZoom(dir: 1 | -1): Promise<number>
        onZoom(cb: (z: unknown) => void): () => void
      }
      projects: {
        list(): Promise<Project[]>
        create(name: string, color: string): Promise<Project>
        remove(id: string): Promise<void>
      }
      media: {
        setOpen(open: boolean): Promise<void>
        setBounds(b: { x: number; y: number; width: number; height: number }): Promise<void>
        state(): Promise<MediaState>
        onState(cb: (s: MediaState) => void): () => void
      }
      planner: {
        events: {
          create(event: { title: string; start_at: number; end_at?: number | null; all_day?: boolean | number; timezone?: string | null; location?: string | null; notes?: string | null; tags?: unknown; recurrence_rule?: string | null }): Promise<CalendarEvent>
          list(startAt: number, endAt: number, query?: string): Promise<CalendarEvent[]>
          update(id: string, patch: Partial<CalendarEvent> & { tags?: unknown }): Promise<void>
          remove(id: string): Promise<void>
        }
        todos: {
          create(todo: { title: string; notes?: string | null; priority?: string; due_at?: number | null; scheduled_at?: number | null; tags?: unknown }): Promise<TodoItem>
          list(filter?: { status?: string; priority?: string; dueBefore?: number | null; tag?: string }): Promise<TodoItem[]>
          update(id: string, patch: Partial<TodoItem> & { tags?: unknown }): Promise<void>
          complete(id: string): Promise<void>
          remove(id: string): Promise<void>
        }
        reminders: {
          create(reminder: { title: string; remind_at: number; linked_type?: string | null; linked_id?: string | null }): Promise<ReminderItem>
          list(startAt?: number, endAt?: number, status?: string): Promise<ReminderItem[]>
          update(id: string, patch: Partial<ReminderItem>): Promise<void>
          remove(id: string): Promise<void>
        }
        onChanged(cb: () => void): () => void
      }
      agentZoo: {
        list(): Promise<AgentZooEntry[]>
        read(path: string): Promise<string>
        save(path: string, content: string): Promise<void>
        createAgent(input: { name: string; description?: string; instructions?: string; tools?: string[] }): Promise<AgentZooEntry>
      }
      docs: {
        list(): Promise<DocMeta[]>
        get(id: string): Promise<Doc | undefined>
        save(doc: { id?: string; title: string; html: string }): Promise<Doc>
        remove(id: string): Promise<void>
        toMarkdown(html: string): Promise<string>
        toHtml(md: string): Promise<string>
        onChanged(cb: () => void): () => void
      }
      feed: {
        sources(): Promise<FeedSource[]>
        addSource(input: string, category?: string | null): Promise<FeedSource>
        updateSource(id: string, patch: Partial<FeedSource>): Promise<void>
        removeSource(id: string): Promise<void>
        unreadCounts(): Promise<Record<string, number>>
        refresh(sourceId?: string): Promise<FeedRefreshResult>
        items(opt?: FeedItemsQuery): Promise<FeedItem[]>
        setItemState(id: string, patch: { is_read?: boolean; is_saved?: boolean; is_hidden?: boolean }): Promise<void>
        markRead(sourceId?: string): Promise<void>
        openItem(id: string): Promise<void>
        onChanged(cb: () => void): () => void
      }
      vault: {
        items(): Promise<VaultItem[]>
        createItem(input: Partial<VaultItem> & { name: string }): Promise<VaultItem>
        updateItem(id: string, patch: Partial<VaultItem>): Promise<VaultItem | undefined>
        removeItem(id: string): Promise<void>
        addPhoto(id: string, photo: { dataBase64: string; mime: string; name?: string }): Promise<ImageAttachment>
        removePhoto(id: string, attachmentId: string): Promise<void>
        addValuation(input: {
          item_id: string
          value_mid: number
          value_low?: number | null
          value_high?: number | null
          source?: string | null
          notes?: string | null
        }): Promise<VaultValuation>
        valuations(itemId: string, kind?: string): Promise<VaultValuation[]>
        latest(): Promise<VaultLatest>
        spot(force?: boolean): Promise<SpotPrices>
        refreshMelt(): Promise<{ updated: number; skipped: number; errors: string[] }>
        onChanged(cb: () => void): () => void
      }
      land: {
        regions(): Promise<LandRegionStatus[]>
        job(): Promise<LandJob>
        cancel(): Promise<boolean>
        verifySources(): Promise<LandSourceCheck[]>
        ingest(fips: string): Promise<{ parcels: number; addresses: number }>
        markCandidates(fips: string, filter?: { minAcres?: number; maxAcres?: number; vacantOnly?: boolean }): Promise<number>
        enrich(fips: string, opts?: { limit?: number; sources?: string[] }): Promise<Record<string, number>>
        rescore(fips: string): Promise<number>
        assess(fips: string, year?: number): Promise<{
          fips: string; year: number; parsed: number; matched: number
          unmatched: number; absentee: number; checked: number; mismatched: number
          vacantConfirmed: number
        }>
        absentee(query: { fips?: string[]; minAcres?: number; limit?: number; verdicts?: string[] }): Promise<LandAbsenteeRow[]>
        comparable(lon: number, lat: number): Promise<LandComparable>
        anchors(): Promise<LandAnchor[]>
        saveAnchor(a: Partial<LandAnchor> & { label: string; lat: number; lon: number }): Promise<LandAnchor[]>
        deleteAnchor(id: string): Promise<LandAnchor[]>
        geocode(address: string): Promise<{ lat: number; lon: number; matched: string } | null>
        fitRegion(fips: string): Promise<{ pois: Record<string, number>; scored: number }>
        route(from: { lon: number; lat: number }, to: { lon: number; lat: number }): Promise<{ minutes: number; km: number } | null>
        amenitySpecs(): Promise<Array<{ kind: string; label: string; weight: number; idealMin: number; maxMin: number; why: string }>>
        parcels(query: {
          minLon: number; minLat: number; maxLon: number; maxLat: number
          fips?: string[]; minAcres?: number; maxAcres?: number; verdicts?: string[]
          candidatesOnly?: boolean; limit?: number
        }): Promise<LandParcelRow[]>
        parcel(id: string): Promise<LandParcelDetail | null>
        weights(): Promise<LandWeights>
        setWeights(w: Partial<LandWeights>): Promise<LandWeights>
        listings(status?: string): Promise<LandListing[]>
        saveListing(l: Partial<LandListing>): Promise<LandListing>
        deleteListing(id: string): Promise<boolean>
        utilities(fips?: string): Promise<LandUtility[]>
        saveUtility(u: Omit<LandUtility, 'updated_at'>): Promise<LandUtility[]>
        onProgress(cb: (payload: unknown) => void): () => void
      }
      mtg: {
        search(query: string): Promise<MtgSmartSearch>
        searchSealed(query: string): Promise<MtgSealedSearch>
        sets(): Promise<MtgSet[]>
        families(): Promise<MtgSetFamily[]>
        familyProducts(code: string, opts?: { price?: boolean }): Promise<MtgFamilyProducts>
        upcoming(aheadDays?: number): Promise<MtgSet[]>
        syncSets(): Promise<{ count: number; created: number; updated: number }>
        watchlist(): Promise<MtgWatchRow[]>
        lifecycleSettings(): Promise<MtgLifecycleSettings>
        setLifecycleSettings(patch: Partial<MtgLifecycleSettings>): Promise<MtgLifecycleSettings>
        createWatch(input: {
          kind?: string
          name: string
          set_code?: string | null
          collector_number?: string | null
          image_url?: string | null
          ext_source?: string
          ext_id?: string | null
          variant?: string
          target_price?: number | null
          alert_enabled?: boolean
          notes?: string | null
        }): Promise<MtgWatch>
        updateWatch(id: string, patch: Partial<MtgWatch>): Promise<MtgWatch | undefined>
        removeWatch(id: string): Promise<void>
        acquireWatch(id: string, opts?: { purchase_price?: number | null; purchase_date?: string | null; quantity?: number }): Promise<VaultItem & { carriedPoints: number }>
        owned(): Promise<MtgOwnedItem[]>
        syncCardMeta(): Promise<{ fetched: number; missing: number }>
        syncCedh(force?: boolean): Promise<{ asked: number; played: number; failed: string[] }>
        commanders(): Promise<MtgOwnedCommander[]>
        commanderStats(): Promise<{ rows: number; synced_at: number | null }>
        syncCommanders(): Promise<MtgCommanderSync>
        decks(): Promise<MtgDeckSummary[]>
        deck(id: string): Promise<MtgDeckDetail | null>
        deckCreate(input: { name: string; commanders?: Array<{ name: string; ext_id?: string | null }> }): Promise<MtgDeckRow>
        deckImport(name: string, text: string): Promise<{ deck: MtgDeckRow; note: string | null }>
        deckSetCard(id: string, card: { name: string; ext_id?: string | null; quantity: number; board: MtgDeckBoard }): Promise<void>
        deckMoveCard(id: string, name: string, to: MtgDeckBoard): Promise<void>
        deckRename(id: string, name: string): Promise<void>
        deckDelete(id: string): Promise<void>
        deckCandidates(): Promise<MtgDeckCandidate[]>
        deckFromSealed(vaultId: string): Promise<{ decks: MtgDeckRow[]; note: string | null }>
        searchPrecons(query: string): Promise<MtgPreconHit[]>
        deckFromPrecon(fileName: string): Promise<MtgDeckRow>
        deckFromRipped(product: string): Promise<{ deck: MtgDeckRow; note: string | null }>
        gameReadiness(): Promise<{ ok: boolean; problems: string[] }>
        gameDecks(): Promise<GameDeckOption[]>
        gameStart(opts: { deck: string; opponents: string[] }): Promise<void>
        gameSend(cmd: { cmd: string; [k: string]: unknown }): Promise<void>
        gameStop(): Promise<void>
        onGameEvent(cb: (e: GameEvent) => void): () => void
        soundLibrary(): Promise<{ settings: unknown; forge: string[]; custom: string[] }>
        soundSave(settings: unknown): Promise<void>
        soundImport(): Promise<string[]>
        soundRemove(name: string): Promise<void>
        tableLook(): Promise<{ look: unknown; mats: string[] }>
        tableSaveLook(look: unknown): Promise<void>
        tableImportMat(): Promise<string[]>
        tableRemoveMat(name: string): Promise<void>
        forgeStatus(): Promise<ForgeStatus>
        forgeChooseDir(): Promise<{ ok: boolean; message: string | null }>
        forgeExport(): Promise<{ decksDir: string; written: string[]; skipped: Array<{ name: string; reason: string }>; unmatchedSets: number; offline?: string }>
        forgeLaunch(): Promise<{ ok: boolean; message: string }>
        forgeOpenUrl(url: string): Promise<void>
        deckRecs(id: string): Promise<MtgDeckRecs | null>
        shoppingList(): Promise<{ items: MtgShoppingItem[]; decks: number; skipped: string[] }>
        cedhMatches(): Promise<MtgCedhMatch[]>
        cedhList(entryId: string): Promise<MtgDeckDetail>
        cedhSaveDeck(entryId: string): Promise<MtgDeckRow>
        exploreCommanders(limit?: number): Promise<MtgExploreCommander[]>
        exploreCommander(f: MtgExploreFilter): Promise<MtgExplorePage>
        exploreDeck(ref: MtgExploreRef): Promise<MtgDeckDetail>
        exploreSaveDeck(ref: MtgExploreRef): Promise<MtgDeckRow>
        syncCedhLists(opts?: { commanders?: number; perCommander?: number }): Promise<{ commanders: number; lists: number; failed: string[] }>
        sealedFollowed(): Promise<string[]>
        followSealed(code: string, follow?: boolean): Promise<string[]>
        sealedPrices(setCode: string, days?: number): Promise<MtgSealedPriceRow[]>
        refreshSealed(): Promise<MtgSealedSweep>
        secretLair(days?: number): Promise<MtgSecretLairDrop[]>
        secretLairUpcoming(): Promise<MtgSlUpcomingDrop[]>
        syncSecretLair(): Promise<MtgSecretLairSync>
        valueSet(query: string, force?: boolean): Promise<MtgSetValuation>
        valueCardList(text: string, label?: string): Promise<MtgSetValuation>
        cardInsights(names: string[], reprintNames: string[], excludeSets: string[], excludeIds?: string[]): Promise<MtgCardInsights>
        valueFromUrl(url: string): Promise<MtgSetValuation>
        packEv(query: string, boosterType?: 'play' | 'collector', packPrice?: number): Promise<MtgPackEv>
        rebuildHistory(): Promise<{ items: number; points: number }>
        backfill(): Promise<MtgBackfillResult>
        onBackfillProgress(cb: (p: MtgBackfillProgress) => void): () => void
        listings(watchId?: string): Promise<MtgListing[]>
        discover(watchId: string): Promise<MtgDiscoverResult>
        addListing(watchId: string, url: string): Promise<MtgListing>
        removeListing(id: string): Promise<void>
        preorderBoard(aheadDays?: number): Promise<MtgPreorderSet[]>
        scanPreorders(aheadDays?: number): Promise<MtgPreorderScan>
        onPreorderProgress(cb: (p: { message: string }) => void): () => void
        sealedContents(uuid: string, force?: boolean): Promise<MtgSealedContents | null>
        productContents(
          productId: string,
          setHint?: string | null
        ): Promise<{ contents: MtgSealedContents | null; setCode: string | null; note: string | null }>
        ripSealed(vaultId: string): Promise<MtgRipResult>
        evBoard(): Promise<MtgEvRow[]>
        evScan(opts?: { sinceDays?: number; maxProducts?: number; recompute?: boolean; setCodes?: string[] }): Promise<MtgEvScanResult>
        evReprice(): Promise<{ checked: number; changed: number; healed: number }>
        evForget(uuid: string): Promise<void>
        onEvProgress(cb: (p: { message: string }) => void): () => void
        deals(): Promise<MtgRetailDeal[]>
        dealThreshold(): Promise<number>
        setDealThreshold(v: number): Promise<number>
        refreshStock(): Promise<MtgStockRefreshResult>
        alertsEnabled(): Promise<boolean>
        setAlertsEnabled(on: boolean): Promise<boolean>
        prices(extId: string, variant: string, limitDays?: number): Promise<MtgPrice[]>
        refreshPrices(): Promise<MtgPriceRefreshResult>
        onChanged(cb: () => void): () => void
        onFocus(cb: () => void): () => void
      }
      drops: {
        watches(): Promise<DropWatch[]>
        products(watchId?: string, includeGone?: boolean): Promise<DropProduct[]>
        events(opts?: { watchId?: string; limit?: number }): Promise<DropEvent[]>
        unseen(): Promise<number>
        markSeen(watchId?: string): Promise<void>
        add(input: { label?: string; url: string; title_match?: string | null; priority?: string }): Promise<DropWatch>
        update(id: string, patch: Partial<DropWatch>): Promise<void>
        remove(id: string): Promise<void>
        poll(watchId?: string): Promise<DropPollResult>
        probe(url: string): Promise<DropProbeResult>
        alertsEnabled(): Promise<boolean>
        setAlertsEnabled(on: boolean): Promise<boolean>
        onChanged(cb: () => void): () => void
        onFocus(cb: (p: { url: string | null }) => void): () => void
        candidateCounts(): Promise<DropCandidateCounts>
        topCandidates(limit?: number): Promise<DropCandidate[]>
        discover(opts?: { page?: number; limit?: number }): Promise<DropDiscoverResult>
        probeCandidates(limit?: number): Promise<DropProbeCandidatesResult>
        promote(count?: number, minScore?: number): Promise<{ promoted: string[]; skipped: number }>
        score(): Promise<DropHeatResult>
      }
      discordBot: {
        status(): Promise<DiscordBotStatus>
        config(): Promise<DiscordBotConfig>
        setConfig(patch: DiscordBotConfigPatch): Promise<DiscordBotConfig>
        restart(): Promise<DiscordBotStatus>
        onChanged(cb: (status: DiscordBotStatus) => void): () => void
      }
      alerts: {
        config(): Promise<AlertsConfig>
        setDiscord(patch: { webhook?: string; mention?: string }): Promise<DiscordAlertConfig>
        test(): Promise<AlertTestResult>
      }
      tcg: {
        games(): Promise<TcgGame[]>
        counts(): Promise<Record<string, number>>
        search(input: { q: string; game: string; type?: 'cards' | 'sealed' | 'all' }): Promise<TcgProduct[]>
        sets(game: string): Promise<TcgSet[]>
        set(game: string, set: string): Promise<TcgSetProducts>
        watches(game?: string): Promise<TcgWatch[]>
        add(input: { productId: string; printing: TcgPrinting; game: string; gameLabel?: string | null; kind: 'card' | 'sealed'; name: string; set?: string | null; rarity?: string | null; targetPrice?: number | null }): Promise<TcgWatch>
        ownSealed(input: { productId: string; game: string; gameLabel?: string | null; name: string; set?: string | null; quantity?: number; purchasePrice?: number | null }): Promise<VaultItem & { price: number | null }>
        update(id: string, patch: { target_price?: number | null; notify?: number; notes?: string | null }): Promise<void>
        remove(id: string): Promise<void>
        history(id: string): Promise<TcgHistoryPoint[]>
        quote(productId: string): Promise<{ Normal: TcgQuote; Foil: TcgQuote }>
        check(target?: { id?: string; game?: string }): Promise<TcgCheckResult>
        onChanged(cb: () => void): () => void
      }
      signals: {
        terms(): Promise<SignalTerm[]>
        read(termId: string, windowDays?: number): Promise<TermReading | null>
        readAll(windowDays?: number): Promise<TermReading[]>
        track(term: string): Promise<SignalTerm>
        untrack(id: string): Promise<void>
        sample(termId: string): Promise<SignalSampleResult>
        sweep(): Promise<SignalSweepResult>
        trending(geo?: string): Promise<TrendingItem[]>
        onChanged(cb: () => void): () => void
      }
      discord: {
        watches(): Promise<DiscordWatch[]>
        readAll(): Promise<DiscordReading[]>
        read(id: string): Promise<DiscordReading | null>
        track(input: string, watchId?: string): Promise<DiscordWatch>
        untrack(id: string): Promise<void>
        sweep(): Promise<DiscordSweepResult>
        fromStore(watchId: string): Promise<{ found: string[]; added: string[] }>
        alertsEnabled(): Promise<boolean>
        setAlertsEnabled(on: boolean): Promise<boolean>
        onChanged(cb: () => void): () => void
      }
      torrents: {
        list(): Promise<TorrentInfo[]>
        add(input: AddTorrentInput): Promise<{ ok: boolean; id?: string; error?: string }>
        pause(id: string): Promise<void>
        resume(id: string): Promise<void>
        remove(id: string, deleteFiles: boolean): Promise<void>
        openFolder(id: string): Promise<void>
        getDir(): Promise<string>
        chooseDir(): Promise<string>
        onChanged(cb: (list: TorrentInfo[]) => void): () => void
      }
      finance: {
        state(): Promise<FinanceState>
        setWatchlist(w: Watchlist): Promise<void>
        setPortfolio(p: Portfolio): Promise<void>
        setSettings(s: FinanceSettings): Promise<void>
        quotes(symbols: string[]): Promise<Quote[]>
        enrich(symbols: string[]): Promise<Record<string, { weekChangePct: number | null; yearChangePct: number | null }>>
        chart(symbol: string, range: string, interval: string): Promise<ChartSeries>
        fundamentals(symbol: string): Promise<Fundamentals>
        news(symbol: string): Promise<NewsItem[]>
        log(entry: Record<string, unknown>): Promise<void>
        activity(limit?: number): Promise<Record<string, unknown>[]>
        appendHistory(symbol: string, snap: Record<string, unknown>): Promise<void>
        history(symbol: string): Promise<Record<string, unknown>[]>
        analyze(opts: { provider: string; model: string; system: string; prompt: string }): Promise<{ ok: boolean; text?: string; error?: string }>
      }
    }
  }
}
