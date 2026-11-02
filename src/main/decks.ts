/**
 * Commander decks against the collection.
 *
 * Three ways in, one way of looking at them:
 *  - decks you OWN as product (a Secret Lair commander deck, a precon), whose
 *    list comes from MTGJSON/EDHREC exactly as the "Ripped" flow resolves it;
 *  - decks you BUILD, from the cards in Owned;
 *  - cEDH tournament lists from EDHTop16, ranked by how much of each you
 *    already have and priced for what is left.
 *
 * Ownership is matched by card NAME across every printing (cardNameKey), not
 * by printing: a deck needs "a Sol Ring", and the Sol Ring in the binder is
 * the one that goes in. Nothing is reserved per deck — a card in two decks
 * counts for both and the view says so ("also in …"), which is how people
 * actually move cards between decks.
 *
 * Basic lands are treated as always owned. Nobody logs forty Islands, and
 * counting them as "missing" would make every list look 30% short.
 */
import * as db from './db'
import * as edhrec from './edhrec'
import * as mtg from './mtg'

const UA = 'ATLIS/1.0 (personal collection tracker)'
const EDHTOP16 = 'https://edhtop16.com/api/graphql'
const WUBRG = ['W', 'U', 'B', 'R', 'G']
/** Scryfall facts for a non-owned card are re-asked after this long. */
const INFO_STALE_MS = 7 * 86_400_000

const BASICS = new Set(
  ['plains', 'island', 'swamp', 'mountain', 'forest', 'wastes'].flatMap((b) => [b, `snow covered ${b}`])
)
export const isBasicKey = (key: string): boolean => BASICS.has(key)

export type Board = 'commander' | 'main'

export interface DeckCardView {
  name: string
  name_key: string
  board: Board
  quantity: number
  /** Printing to picture: the owned copy when there is one, else the listed one. */
  ext_id: string | null
  type_line: string | null
  mana_cost: string | null
  cmc: number | null
  color_identity: string | null
  /** Per copy. The owned copy's last quote when owned, else a representative printing. */
  price: number | null
  /** Copies owned across all printings. */
  owned: number
  basic: boolean
  /** Other saved decks that also run this card. */
  other_decks: string[]
  /** False when the card's identity falls outside the commander's. */
  in_identity: boolean
}

export interface DeckSummary {
  id: string
  name: string
  kind: db.MtgDeck['kind']
  color_identity: string
  commanders: string[]
  /** Printing of the first commander, for a thumbnail. */
  commander_ext_id: string | null
  card_count: number
  owned_count: number
  /** Cost of the copies not owned, at representative prices. */
  missing_cost: number
  /** What the whole list is worth. */
  value: number
  source_url: string | null
  updated_at: number
}

export interface DeckDetail extends DeckSummary {
  notes: string | null
  cards: DeckCardView[]
  note: string | null
}

// ---------------------------------------------------------------- shared lookups

interface OwnedEntry {
  qty: number
  ext_id: string | null
  price: number | null
  type_line: string | null
  mana_cost: string | null
  cmc: number | null
  color_identity: string | null
}

/**
 * Owned singles grouped by folded name. The representative printing is the
 * cheapest priced copy — the one you would sleeve — and type facts come from
 * whichever copy has synced metadata.
 */
function ownedIndex(): Map<string, OwnedEntry> {
  const out = new Map<string, OwnedEntry>()
  for (const r of db.listMtgOwnedCardFacts()) {
    const key = db.cardNameKey(r.name)
    if (!key) continue
    const ext = r.ext_source === 'scryfall' ? r.ext_id : null
    const e = out.get(key)
    if (!e) {
      out.set(key, {
        qty: r.quantity, ext_id: ext, price: r.last_price, type_line: r.type_line,
        mana_cost: r.mana_cost, cmc: r.cmc, color_identity: r.color_identity
      })
      continue
    }
    e.qty += r.quantity
    if (r.last_price != null && (e.price == null || r.last_price < e.price)) {
      e.price = r.last_price
      if (ext) e.ext_id = ext
    }
    if (!e.ext_id && ext) e.ext_id = ext
    if (e.type_line == null && r.type_line != null) {
      e.type_line = r.type_line
      e.mana_cost = r.mana_cost
      e.cmc = r.cmc
      e.color_identity = r.color_identity
    }
  }
  return out
}

/** name_key → names of the saved decks running it. */
function deckUsage(): Map<string, Array<{ id: string; name: string }>> {
  const names = new Map(db.listMtgDecks().map((d) => [d.id, d.name]))
  const out = new Map<string, Array<{ id: string; name: string }>>()
  for (const c of db.listMtgDeckCards()) {
    const list = out.get(c.name_key) ?? []
    if (!list.some((x) => x.id === c.deck_id)) list.push({ id: c.deck_id, name: names.get(c.deck_id) ?? '?' })
    out.set(c.name_key, list)
  }
  return out
}

/**
 * Tag owned rows with the saved decks that run them, for the Owned tab's
 * "in a deck / loose" filter. Matched by name like everything else here, so
 * any printing of a card counts as the one in the deck. Sealed rows get none.
 */
export function attachDeckUsage<T extends { name: string; category: string }>(rows: T[]): Array<T & { decks: string[] }> {
  const usage = deckUsage()
  return rows.map((r) => ({
    ...r,
    decks: r.category === 'mtg_card' ? (usage.get(db.cardNameKey(r.name)) ?? []).map((d) => d.name) : []
  }))
}

/** EDHTop16 "UG" / Scryfall ['U','G'] → stored 'U,G'; colourless → ''. */
function identityFrom(letters: string | string[] | null | undefined): string {
  const set = new Set(Array.isArray(letters) ? letters : (letters ?? '').toUpperCase().split(''))
  return WUBRG.filter((c) => set.has(c)).join(',')
}

function unionIdentity(ids: Array<string | null | undefined>): string {
  const set = new Set(ids.flatMap((i) => (i ? i.split(',') : [])))
  return WUBRG.filter((c) => set.has(c)).join(',')
}

const fitsIdentity = (card: string | null, deck: string): boolean =>
  card == null || card === '' || card.split(',').every((c) => deck.split(',').includes(c))

function infoFromScryfall(c: mtg.ScryfallCard): Omit<db.MtgCardInfo, 'synced_at' | 'name_key'> {
  const faces = c.card_faces as Array<{ mana_cost?: string }> | undefined
  return {
    name: c.name,
    ext_id: c.id,
    type_line: c.type_line ?? null,
    mana_cost: c.mana_cost ?? faces?.map((f) => f.mana_cost ?? '').filter(Boolean).join(' // ') ?? null,
    cmc: c.cmc ?? null,
    color_identity: identityFrom(c.color_identity),
    price: mtg.priceOf(c, 'nonfoil') ?? mtg.priceOf(c, 'foil') ?? mtg.priceOf(c, 'etched'),
    source: 'scryfall'
  }
}

/**
 * Make sure every card in a list has type and price facts. Owned cards
 * already do; the rest are asked of Scryfall once and cached, by printing id
 * when the list carries one and by name otherwise. Failures are swallowed —
 * a deck still renders without a curve slot for a card Scryfall missed.
 */
async function ensureInfo(cards: Array<{ name: string; ext_id?: string | null }>, owned: Map<string, OwnedEntry>): Promise<void> {
  const keys = cards.map((c) => db.cardNameKey(c.name))
  const known = db.getMtgCardInfo(keys)
  const fresh = Date.now() - INFO_STALE_MS
  const need = cards.filter((c, i) => {
    const k = keys[i]
    if (isBasicKey(k)) return false
    if (owned.get(k)?.type_line) return false
    const info = known.get(k)
    // EDHTop16 rows carry type and price but no printing id, so no picture.
    return !info || (info.source === 'edhtop16' && !info.ext_id) || (info.source === 'scryfall' && info.synced_at < fresh)
  })
  if (!need.length) return
  try {
    const byId = need.filter((c) => c.ext_id)
    const byName = need.filter((c) => !c.ext_id).map((c) => c.name)
    const rows: Array<Omit<db.MtgCardInfo, 'synced_at' | 'name_key'>> = []
    if (byId.length) {
      const found = await mtg.cardsByIds(byId.map((c) => String(c.ext_id)))
      for (const c of found.values()) rows.push(infoFromScryfall(c))
    }
    if (byName.length) {
      const { found } = await mtg.cardsByNames(byName)
      for (const c of found) rows.push(infoFromScryfall(c))
    }
    db.upsertMtgCardInfo(rows)
  } catch {
    // offline / Scryfall down: render with what is cached
  }
}

/** Turn a stored list into the view rows, plus the summary numbers. */
function buildView(
  list: Array<{ name: string; quantity: number; board: Board; ext_id?: string | null }>,
  identity: string,
  owned: Map<string, OwnedEntry>,
  usage: Map<string, Array<{ id: string; name: string }>> | null,
  selfId: string | null,
  extraInfo?: Map<string, Partial<db.MtgCardInfo>>
): { cards: DeckCardView[]; card_count: number; owned_count: number; missing_cost: number; value: number } {
  const info = db.getMtgCardInfo(list.map((c) => db.cardNameKey(c.name)))
  const cards: DeckCardView[] = list.map((c) => {
    const key = db.cardNameKey(c.name)
    const o = owned.get(key)
    const i = info.get(key) ?? extraInfo?.get(key)
    const basic = isBasicKey(key)
    const colorIdentity = o?.color_identity ?? i?.color_identity ?? null
    return {
      name: c.name,
      name_key: key,
      board: c.board,
      quantity: c.quantity,
      ext_id: o?.ext_id ?? c.ext_id ?? i?.ext_id ?? null,
      type_line: o?.type_line ?? i?.type_line ?? null,
      mana_cost: o?.mana_cost ?? i?.mana_cost ?? null,
      cmc: o?.cmc ?? i?.cmc ?? null,
      color_identity: colorIdentity,
      price: o?.price ?? i?.price ?? null,
      owned: basic ? c.quantity : o?.qty ?? 0,
      basic,
      other_decks: (usage?.get(key) ?? []).filter((d) => d.id !== selfId).map((d) => d.name),
      in_identity: c.board === 'commander' || fitsIdentity(colorIdentity, identity)
    }
  })
  let card_count = 0
  let owned_count = 0
  let missing_cost = 0
  let value = 0
  for (const c of cards) {
    card_count += c.quantity
    const have = Math.min(c.owned, c.quantity)
    owned_count += have
    value += (c.price ?? 0) * c.quantity
    if (!c.basic) missing_cost += (c.price ?? 0) * (c.quantity - have)
  }
  return { cards, card_count, owned_count, missing_cost: Math.round(missing_cost * 100) / 100, value: Math.round(value * 100) / 100 }
}

function summarize(
  d: db.MtgDeck,
  rows: db.MtgDeckCard[],
  owned: Map<string, OwnedEntry>,
  usage: Map<string, Array<{ id: string; name: string }>> | null
): DeckSummary & { cards: DeckCardView[] } {
  const v = buildView(rows, d.color_identity, owned, usage, d.id)
  const commanders = v.cards.filter((c) => c.board === 'commander')
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    color_identity: d.color_identity,
    commanders: commanders.map((c) => c.name),
    commander_ext_id: commanders[0]?.ext_id ?? null,
    card_count: v.card_count,
    owned_count: v.owned_count,
    missing_cost: v.missing_cost,
    value: v.value,
    source_url: d.source_url,
    updated_at: d.updated_at,
    cards: v.cards
  }
}

/** Recompute a deck's identity from its command zone. */
function refreshIdentity(deckId: string): void {
  const owned = ownedIndex()
  const rows = db.listMtgDeckCards(deckId).filter((c) => c.board === 'commander')
  const info = db.getMtgCardInfo(rows.map((r) => r.name_key))
  const identity = unionIdentity(rows.map((r) => owned.get(r.name_key)?.color_identity ?? info.get(r.name_key)?.color_identity))
  db.updateMtgDeck(deckId, { color_identity: identity })
}

// ---------------------------------------------------------------- saved decks

export function listDecks(): DeckSummary[] {
  const owned = ownedIndex()
  const all = db.listMtgDeckCards()
  const byDeck = new Map<string, db.MtgDeckCard[]>()
  for (const c of all) {
    const arr = byDeck.get(c.deck_id) ?? []
    arr.push(c)
    byDeck.set(c.deck_id, arr)
  }
  return db.listMtgDecks().map((d) => {
    const { cards: _cards, ...s } = summarize(d, byDeck.get(d.id) ?? [], owned, null)
    return s
  })
}

export async function getDeck(id: string): Promise<DeckDetail | null> {
  const d = db.getMtgDeck(id)
  if (!d) return null
  const rows = db.listMtgDeckCards(id)
  const owned = ownedIndex()
  await ensureInfo(rows, owned)
  // Identity can only be known once the commander's facts are cached.
  if (!d.color_identity && rows.some((r) => r.board === 'commander')) {
    refreshIdentity(id)
    Object.assign(d, db.getMtgDeck(id))
  }
  const s = summarize(d, rows, owned, deckUsage())
  const commanders = s.cards.filter((c) => c.board === 'commander').length
  const note =
    commanders === 0 ? 'No commander set — use the crown on a card to put it in the command zone.' : null
  return { ...s, notes: d.notes, note }
}

export function createDeck(input: { name: string; commanders?: Array<{ name: string; ext_id?: string | null }> }): db.MtgDeck {
  const deck = db.createMtgDeck(
    { name: input.name, kind: 'custom' },
    (input.commanders ?? []).map((c) => ({ name: c.name, ext_id: c.ext_id ?? null, quantity: 1, board: 'commander' as const }))
  )
  if (input.commanders?.length) refreshIdentity(deck.id)
  return db.getMtgDeck(deck.id) ?? deck
}

export function setCard(deckId: string, c: { name: string; ext_id?: string | null; quantity: number; board: Board }): void {
  db.setMtgDeckCard(deckId, c)
  if (c.board === 'commander') refreshIdentity(deckId)
}

export function moveCard(deckId: string, name: string, to: Board): void {
  db.moveMtgDeckCard(deckId, name, to)
  refreshIdentity(deckId)
}

export function renameDeck(id: string, name: string): void {
  if (name.trim()) db.updateMtgDeck(id, { name: name.trim() })
}

export function deleteDeck(id: string): void {
  db.deleteMtgDeck(id)
}

// ---------------------------------------------------------------- owned products → decks

export interface DeckCandidate {
  kind: 'sealed' | 'ripped'
  /** Vault id (sealed) or product name (ripped). */
  ref: string
  name: string
  cards: number | null
  /** The saved deck already made from this, if any. */
  deck_id: string | null
}

const looksLikeDeck = (name: string, category: string | null | undefined, subtype: string | null | undefined): boolean =>
  /deck/i.test(category ?? '') || /commander|precon/i.test(subtype ?? '') || /commander deck|precon|deck\b/i.test(name)

const RIPPED = /^Ripped from (.+)$/

/**
 * Things in the collection that are, or were, a deck: sealed deck products
 * still in Owned, and groups of singles the Ripped flow tagged with the
 * product they came out of.
 */
export function deckCandidates(): DeckCandidate[] {
  const out: DeckCandidate[] = []
  for (const v of db.listVaultItems('mtg_sealed')) {
    // Rows added by hand have no TCGplayer link; their name still says "deck".
    const product = v.ext_source === 'tcgplayer' && v.ext_id ? db.findMtgSealedByTcgplayer(v.ext_id) : undefined
    if (!looksLikeDeck(v.name, product?.category, product?.subtype)) continue
    out.push({ kind: 'sealed', ref: v.id, name: v.name, cards: null, deck_id: db.findMtgDeckBySource(`sealed:${v.id}`)?.id ?? null })
  }
  const ripped = new Map<string, number>()
  for (const v of db.listVaultItems('mtg_card')) {
    const m = v.notes ? RIPPED.exec(v.notes.trim()) : null
    if (m) ripped.set(m[1], (ripped.get(m[1]) ?? 0) + v.quantity)
  }
  for (const [product, n] of ripped) {
    // A ripped booster box is not a deck; only keep products named like one
    // or big enough to be one.
    if (!/deck|precon|commander/i.test(product) && n < 60) continue
    out.push({ kind: 'ripped', ref: product, name: product, cards: n, deck_id: db.findMtgDeckBySource(`ripped:${product}`)?.id ?? null })
  }
  return out
}

/** Fill in names (EDHREC lists carry ids only) and cache facts for every printing. */
async function resolveDecklist(list: mtg.ProductDecklist): Promise<Array<{ name: string; ext_id: string; quantity: number; board: Board }>> {
  const found = await mtg.cardsByIds(list.cards.map((c) => c.scryfallId))
  db.upsertMtgCardInfo([...found.values()].map(infoFromScryfall))
  return list.cards
    .map((c) => ({
      name: c.name || found.get(c.scryfallId)?.name || '',
      ext_id: c.scryfallId,
      quantity: c.count,
      board: (c.commander ? 'commander' : 'main') as Board
    }))
    .filter((c) => c.name)
}

/** An owned sealed deck product → one saved precon deck per decklist inside it. */
export async function deckFromSealed(vaultId: string): Promise<{ decks: db.MtgDeck[]; note: string | null }> {
  const item = db.getVaultItem(vaultId)
  if (!item || item.category !== 'mtg_sealed') throw new Error('That sealed product is no longer in Owned.')
  const product = item.ext_source === 'tcgplayer' && item.ext_id ? db.findMtgSealedByTcgplayer(item.ext_id) : undefined
  if (!product) {
    // No catalogue link (typed in by hand, or its set's catalogue never
    // pulled): find the deck by the product's name instead.
    const file = await mtg.preconByProductName(item.name)
    if (!file) {
      throw new Error(`Couldn’t tell which precon “${item.name}” is — use “Add a precon” and search for it by deck, set or commander.`)
    }
    const deck = await deckFromPrecon(file, `sealed:${vaultId}`, item.name)
    return { decks: [deck], note: null }
  }
  const lists = await mtg.productDecklists(product.uuid)
  if (!lists.length) throw new Error(`MTGJSON and EDHREC have no decklist for “${item.name}” yet.`)
  const decks: db.MtgDeck[] = []
  for (const l of lists) {
    const cards = await resolveDecklist(l)
    const deck = db.createMtgDeck(
      {
        name: lists.length > 1 ? l.name : item.name,
        kind: 'precon',
        source_ref: lists.length > 1 ? `sealed:${vaultId}:${l.name}` : `sealed:${vaultId}`,
        source_url: l.url
      },
      cards
    )
    refreshIdentity(deck.id)
    decks.push(deck)
  }
  const fromEdhrec = lists.filter((l) => l.source === 'edhrec').length
  return {
    decks,
    note: fromEdhrec ? 'List from EDHREC — MTGJSON has not published it yet.' : null
  }
}

export const searchPrecons = mtg.searchPrecons

/**
 * Save a precon by its MTGJSON deck file — the manual way in, for decks the
 * collection doesn't record as a product. Adding the same precon twice
 * returns the first copy.
 */
export async function deckFromPrecon(fileName: string, sourceRef = `mtgjson:${fileName}`, name?: string): Promise<db.MtgDeck> {
  const existing = db.findMtgDeckBySource(sourceRef)
  if (existing) return existing
  const list = await mtg.preconDecklist(fileName)
  if (!list) throw new Error('MTGJSON has not published that decklist.')
  const cards = await resolveDecklist(list)
  const deck = db.createMtgDeck({ name: name ?? list.name, kind: 'precon', source_ref: sourceRef }, cards)
  refreshIdentity(deck.id)
  return db.getMtgDeck(deck.id) ?? deck
}

/**
 * Rebuild a deck from the singles a rip added. The rip kept no record of the
 * command zone, so the product's decklist is asked again just for that; if it
 * can't be found the deck saves without a commander and the user picks one.
 */
export async function deckFromRipped(productName: string): Promise<{ deck: db.MtgDeck; note: string | null }> {
  const rows = db.listMtgOwnedCardFacts().filter((r) => r.notes?.trim() === `Ripped from ${productName}`)
  if (!rows.length) throw new Error(`No cards in Owned are tagged as ripped from “${productName}”.`)

  let commanders = new Set<string>()
  let sourceUrl: string | null = null
  // Vault names for sealed come from the MTGJSON catalogue, so a folded
  // compare finds the product again even after the sealed copy is gone.
  const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const words = productName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)
  const product = db.searchMtgSealed(words).find((p) => fold(p.name) === fold(productName))
  if (product) {
    try {
      const lists = await mtg.productDecklists(product.uuid)
      for (const l of lists) {
        const resolved = await resolveDecklist(l)
        for (const c of resolved) if (c.board === 'commander') commanders.add(db.cardNameKey(c.name))
        sourceUrl ??= l.url
      }
    } catch {
      commanders = new Set()
    }
  }
  const deck = db.createMtgDeck(
    { name: productName, kind: 'precon', source_ref: `ripped:${productName}`, source_url: sourceUrl },
    rows.map((r) => ({
      name: r.name,
      ext_id: r.ext_source === 'scryfall' ? r.ext_id : null,
      quantity: r.quantity,
      board: commanders.has(db.cardNameKey(r.name)) ? ('commander' as const) : ('main' as const)
    }))
  )
  refreshIdentity(deck.id)
  return {
    deck,
    note: commanders.size ? null : 'Couldn’t find this product’s decklist to tell which card is the commander — pick it with the crown.'
  }
}

// ---------------------------------------------------------------- text import

/**
 * Parse a pasted decklist: Moxfield, Archidekt, MTGO and plain "1 Sol Ring"
 * all reduce to count + name, with set/collector suffixes and foil markers
 * dropped. The command zone is recognised from a "Commander" section header
 * or Archidekt's [Commander] / Moxfield's *CMDR* markers. Sideboard and
 * maybeboard sections are skipped.
 */
export function parseDecklist(text: string): Array<{ name: string; quantity: number; board: Board }> {
  const out: Array<{ name: string; quantity: number; board: Board }> = []
  let section: Board | 'skip' = 'main'
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('//') || line.startsWith('#')) continue
    const header = /^(commanders?|deck|main(board)?|sideboard|maybeboard|considering|companion|tokens?)\s*:?\s*(\(\d+\))?$/i.exec(line)
    if (header) {
      const h = header[1].toLowerCase()
      section = h.startsWith('commander') ? 'commander' : h === 'deck' || h.startsWith('main') ? 'main' : 'skip'
      continue
    }
    if (section === 'skip') continue
    const m = /^(\d+)\s*x?\s+(.+)$/i.exec(line)
    const quantity = m ? Math.max(1, Number(m[1])) : 1
    let name = (m ? m[2] : line).trim()
    const cmdr = /\*CMDR\*|\[commander/i.test(name)
    name = name
      .replace(/\s*\[[^\]]*\]/g, '')               // [Commander{top}] categories
      .replace(/\s*\^[^^]*\^/g, '')                // Archidekt ^tags^
      .replace(/\s*\*[A-Z]+\*/g, '')               // *F* *E* *CMDR*
      .replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+[\w★-]+)?\s*$/, '') // (SET) 123
      .trim()
    if (name) out.push({ name, quantity, board: cmdr || section === 'commander' ? 'commander' : 'main' })
  }
  return out
}

export async function importDeck(name: string, text: string): Promise<{ deck: db.MtgDeck; note: string | null }> {
  const parsed = parseDecklist(text)
  if (!parsed.length) throw new Error('No card lines found — paste one card per line, like “1 Sol Ring”.')
  // Canonicalise names through Scryfall, which also caches their facts.
  let notFound: string[] = []
  const canonical = new Map<string, string>()
  try {
    const r = await mtg.cardsByNames(parsed.map((p) => p.name))
    notFound = r.notFound
    db.upsertMtgCardInfo(r.found.map(infoFromScryfall))
    for (const c of r.found) canonical.set(db.cardNameKey(c.name), c.name)
  } catch {
    // offline: keep the names as typed
  }
  const deck = db.createMtgDeck(
    { name, kind: 'custom' },
    parsed.map((p) => ({ ...p, name: canonical.get(db.cardNameKey(p.name)) ?? p.name }))
  )
  refreshIdentity(deck.id)
  return {
    deck,
    note: notFound.length
      ? `Scryfall didn't recognise ${notFound.length} line(s): ${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? '…' : ''}. They were kept as typed.`
      : null
  }
}

// ---------------------------------------------------------------- cEDH lists

interface CedhCard {
  n: string
  t: string | null
  c: number | null
  m: string | null
  p: number | null
  i: string
  cmd?: true
}

interface GqlCard { name: string; type?: string | null; cmc?: number | null; manaCost?: string | null; priceUsd?: number | null; colorId?: string | null }

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const r = await fetch(EDHTOP16, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ query, variables })
  })
  if (!r.ok) throw new Error(`EDHTop16 answered HTTP ${r.status}`)
  const j = (await r.json()) as { data?: T | null; errors?: Array<{ message?: string }> }
  if (!j.data) throw new Error(j.errors?.[0]?.message ?? 'EDHTop16 returned no data')
  return j.data
}

const toCedhCard = (c: GqlCard, cmd = false): CedhCard => ({
  n: c.name,
  t: c.type ?? null,
  c: typeof c.cmc === 'number' ? c.cmc : null,
  m: c.manaCost || null,
  p: typeof c.priceUsd === 'number' ? Math.round(c.priceUsd * 100) / 100 : null,
  i: identityFrom(c.colorId === 'C' ? '' : c.colorId),
  ...(cmd ? { cmd: true as const } : {})
})

export interface CedhSyncResult {
  commanders: number
  lists: number
  failed: string[]
}

const CARD_FIELDS = 'name type cmc manaCost priceUsd colorId'

/**
 * Pull the most-played cEDH commanders of the last three months and, for each,
 * its best recent finishes (top 16 at events of 32+ players) with the full
 * list. Commanders are asked a few at a time — one request holding 150 full
 * decklists is several MB and EDHTop16 is a free community API.
 */
export async function syncCedhLists(opts: { commanders?: number; perCommander?: number } = {}): Promise<CedhSyncResult> {
  const nCommanders = Math.min(100, Math.max(5, opts.commanders ?? 40))
  const perCommander = Math.min(8, Math.max(1, opts.perCommander ?? 3))
  const top = await gql<{ commanders: { edges: Array<{ node: { name: string } }> } }>(
    `{ commanders(first: ${nCommanders}, sortBy: POPULARITY, timePeriod: THREE_MONTHS) { edges { node { name } } } }`
  )
  const names = top.commanders.edges.map((e) => e.node.name)

  type Entry = {
    id: string; standing: number | null; priceUsd: number | null; decklistUrl: string | null
    player: { name: string } | null
    tournament: { name: string; size: number; tournamentDate: string } | null
    maindeck: GqlCard[] | null
  }
  type Cmd = { name: string; colorId: string | null; cards: GqlCard[] | null; entries: { edges: Array<{ node: Entry }> } } | null

  const rows: Array<Omit<db.MtgCedhListRow, 'synced_at'>> = []
  const infos = new Map<string, Omit<db.MtgCardInfo, 'synced_at' | 'name_key'>>()
  const failed: string[] = []
  const BATCH = 5
  for (let i = 0; i < names.length; i += BATCH) {
    const slice = names.slice(i, i + BATCH)
    const defs = slice.map((_, k) => `$n${k}: String!`).join(', ')
    const sel = slice.map((_, k) => `c${k}: commander(name: $n${k}) { name colorId cards { ${CARD_FIELDS} }
        entries(first: ${perCommander}, sortBy: TOP, filters: { minEventSize: 32, maxStanding: 16, timePeriod: THREE_MONTHS }) {
          edges { node { id standing priceUsd decklistUrl player { name } tournament { name size tournamentDate } maindeck { ${CARD_FIELDS} } } } } }`).join('\n')
    try {
      const data = await gql<Record<string, Cmd>>(`query C(${defs}) { ${sel} }`, Object.fromEntries(slice.map((n, k) => [`n${k}`, n])))
      slice.forEach((_, k) => {
        const cmd = data[`c${k}`]
        if (!cmd) return
        const commanderCards = (cmd.cards ?? []).map((c) => toCedhCard(c, true))
        for (const e of cmd.entries.edges.map((x) => x.node)) {
          if (!e.maindeck?.length) continue
          const cards = [...commanderCards, ...e.maindeck.map((c) => toCedhCard(c))]
          for (const c of cards) {
            infos.set(c.n, { name: c.n, ext_id: null, type_line: c.t, mana_cost: c.m, cmc: c.c, color_identity: c.i, price: c.p, source: 'edhtop16' })
          }
          rows.push({
            entry_id: e.id,
            commander: cmd.name,
            color_identity: identityFrom(cmd.colorId === 'C' ? '' : cmd.colorId),
            standing: e.standing,
            player: e.player?.name ?? null,
            tournament: e.tournament?.name ?? null,
            tournament_size: e.tournament?.size ?? null,
            tournament_date: e.tournament?.tournamentDate?.slice(0, 10) ?? null,
            decklist_url: e.decklistUrl ? new URL(e.decklistUrl, 'https://edhtop16.com').toString() : null,
            deck_price: typeof e.priceUsd === 'number' ? Math.round(e.priceUsd * 100) / 100 : null,
            cards: JSON.stringify(cards)
          })
        }
      })
    } catch (err) {
      failed.push(`${slice.join(', ')}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!rows.length) throw new Error(failed[0] ?? 'EDHTop16 returned no decklists.')
  db.replaceMtgCedhLists(rows)
  db.upsertMtgCardInfo([...infos.values()])
  return { commanders: names.length, lists: rows.length, failed }
}

export interface CedhMatch {
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
  /** Every commander of the list is in the collection. */
  own_commander: boolean
  synced_at: number
}

/** Every cached cEDH list, scored against the collection. Local and instant. */
export function cedhMatches(): CedhMatch[] {
  const owned = ownedIndex()
  return db.listMtgCedhLists().map((r) => {
    const cards = JSON.parse(r.cards) as CedhCard[]
    let have = 0
    let missing = 0
    let ownCommander = true
    for (const c of cards) {
      const key = db.cardNameKey(c.n)
      const isOwned = isBasicKey(key) || (owned.get(key)?.qty ?? 0) > 0
      if (isOwned) have++
      else missing += c.p ?? 0
      if (c.cmd && !isOwned) ownCommander = false
    }
    return {
      entry_id: r.entry_id,
      commander: r.commander,
      color_identity: r.color_identity,
      standing: r.standing,
      player: r.player,
      tournament: r.tournament,
      tournament_size: r.tournament_size,
      tournament_date: r.tournament_date,
      decklist_url: r.decklist_url,
      deck_price: r.deck_price,
      card_count: cards.length,
      owned_count: have,
      owned_pct: cards.length ? Math.round((have / cards.length) * 1000) / 10 : 0,
      missing_cost: Math.round(missing * 100) / 100,
      own_commander: ownCommander,
      synced_at: r.synced_at
    }
  }).sort((a, b) => b.owned_pct - a.owned_pct || a.missing_cost - b.missing_cost)
}

function cedhRow(entryId: string): { row: db.MtgCedhListRow; cards: CedhCard[] } {
  const row = db.getMtgCedhList(entryId)
  if (!row) throw new Error('That cEDH list is no longer cached — sync again.')
  return { row, cards: JSON.parse(row.cards) as CedhCard[] }
}

/** One cEDH list in the same shape as a saved deck, so the same view renders it. */
export async function cedhList(entryId: string): Promise<DeckDetail> {
  const { row, cards } = cedhRow(entryId)
  const owned = ownedIndex()
  await ensureInfo(cards.map((c) => ({ name: c.n })), owned)
  const extra = new Map<string, Partial<db.MtgCardInfo>>(
    cards.map((c) => [db.cardNameKey(c.n), { type_line: c.t, mana_cost: c.m, cmc: c.c, color_identity: c.i, price: c.p }])
  )
  const v = buildView(
    cards.map((c) => ({ name: c.n, quantity: 1, board: c.cmd ? 'commander' : 'main' })),
    row.color_identity, owned, deckUsage(), null, extra
  )
  const commanders = v.cards.filter((c) => c.board === 'commander')
  return {
    id: `cedh:${row.entry_id}`,
    name: `${row.commander} — #${row.standing ?? '?'} ${row.tournament ?? ''}`.trim(),
    kind: 'cedh',
    color_identity: row.color_identity,
    commanders: commanders.map((c) => c.name),
    commander_ext_id: commanders[0]?.ext_id ?? null,
    card_count: v.card_count,
    owned_count: v.owned_count,
    missing_cost: v.missing_cost,
    value: v.value,
    source_url: row.decklist_url,
    updated_at: row.synced_at,
    notes: null,
    cards: v.cards,
    note: `Prices are EDHTop16's per-card quotes${row.player ? ` · piloted by ${row.player}` : ''}${row.tournament_size ? ` · ${row.tournament_size} players` : ''}${row.tournament_date ? ` · ${row.tournament_date}` : ''}.`
  }
}

export function saveCedhAsDeck(entryId: string): db.MtgDeck {
  const existing = db.findMtgDeckBySource(`edhtop16:${entryId}`)
  if (existing) return existing
  const { row, cards } = cedhRow(entryId)
  return db.createMtgDeck(
    {
      name: `${row.commander} (cEDH #${row.standing ?? '?'})`,
      kind: 'cedh',
      color_identity: row.color_identity,
      source_ref: `edhtop16:${entryId}`,
      source_url: row.decklist_url
    },
    cards.map((c) => ({ name: c.n, quantity: 1, board: c.cmd ? ('commander' as const) : ('main' as const) }))
  )
}

// ---------------------------------------------------------------- explore (EDHREC decks)

/** An EDHREC list to open: a commander's average deck for a filter, or one indexed user deck. */
export type ExploreRef =
  | { kind: 'average'; commanders: string[]; bracket?: number | null; theme?: string | null }
  | { kind: 'user'; hash: string }

export interface ExploreCommander {
  name: string
  num_decks: number
  color_slug: string
  rank_in_color: number
  owned: boolean
  /** Names of saved decks led by it. */
  in_decks: string[]
}

/**
 * Commanders to explore, most-built first, from the EDHREC popularity table
 * the Commanders tab syncs. Not limited to owned legends: the point is
 * finding decks you haven't played or played against.
 */
export function exploreCommanders(limit = 400): ExploreCommander[] {
  const owned = ownedIndex()
  const leading = new Map<string, string[]>()
  const decks = new Map(db.listMtgDecks().map((d) => [d.id, d.name]))
  for (const c of db.listMtgDeckCards()) {
    if (c.board !== 'commander') continue
    leading.set(c.name_key, [...(leading.get(c.name_key) ?? []), decks.get(c.deck_id) ?? ''])
  }
  return db.listTopCommanderStats(limit).map((r) => ({
    name: r.name,
    num_decks: r.num_decks,
    color_slug: r.color_slug,
    rank_in_color: r.rank_in_color,
    owned: (owned.get(r.name_key)?.qty ?? 0) > 0,
    in_decks: leading.get(r.name_key) ?? []
  }))
}

export async function exploreCommander(f: edhrec.ExploreFilter): Promise<edhrec.ExplorePage> {
  const names = f.commanders.map((n) => n.trim()).filter(Boolean)
  if (!names.length) throw new Error('Pick a commander first.')
  const page = await edhrec.exploreCommander({ ...f, commanders: names })
  if (!page) {
    throw new Error(f.bracket || f.theme
      ? `EDHREC has no ${names.join(' + ')} decks for that bracket/theme combination.`
      : `EDHREC has no deck page for “${names.join(' + ')}”. Check the spelling, or that it's a legal commander.`)
  }
  return page
}

async function exploreSource(ref: ExploreRef): Promise<{ list: edhrec.EdhrecDeckList; sourceRef: string; name: string }> {
  if (ref.kind === 'user') {
    const list = await edhrec.userDeck(ref.hash)
    if (!list) throw new Error('EDHREC no longer has that deck — it may have been deleted at its source.')
    return { list, sourceRef: `edhrec:${ref.hash}`, name: `${list.commanders.join(' + ')}${list.tags.length ? ` — ${list.tags.slice(0, 2).join(', ')}` : ''}` }
  }
  const list = await edhrec.averageDeck(ref)
  if (!list) throw new Error('EDHREC has no average deck for that commander and filter.')
  return { list, sourceRef: `edhrec-avg:${list.url.replace(/^.*\/average-decks\//, '')}`, name: list.header.replace(/^Average Deck for /, 'Average: ') }
}

/** An EDHREC list in the same shape as a saved deck, so DeckView renders it. */
export async function exploreDeck(ref: ExploreRef): Promise<DeckDetail> {
  const { list, sourceRef, name } = await exploreSource(ref)
  const owned = ownedIndex()
  await ensureInfo(list.cards, owned)
  const info = db.getMtgCardInfo(list.commanders.map((n) => db.cardNameKey(n)))
  const identity = unionIdentity(list.commanders.map((n) => {
    const k = db.cardNameKey(n)
    return owned.get(k)?.color_identity ?? info.get(k)?.color_identity
  }))
  const v = buildView(list.cards, identity, owned, deckUsage(), null)
  const commanders = v.cards.filter((c) => c.board === 'commander')
  const saved = db.findMtgDeckBySource(sourceRef)
  return {
    id: sourceRef,
    name,
    kind: 'edhrec',
    color_identity: identity,
    commanders: commanders.map((c) => c.name),
    commander_ext_id: commanders[0]?.ext_id ?? null,
    card_count: v.card_count,
    owned_count: v.owned_count,
    missing_cost: v.missing_cost,
    value: v.value,
    source_url: list.url,
    updated_at: Date.now(),
    notes: null,
    cards: v.cards,
    note: [
      ref.kind === 'average' ? 'EDHREC’s average of the matching decks — a typical build, not one person’s list.' : `A user deck indexed by EDHREC${list.saved ? `, updated ${list.saved}` : ''}.`,
      list.tags.length ? `Tagged ${list.tags.join(', ')}.` : null,
      saved ? `Already saved as “${saved.name}”.` : null
    ].filter(Boolean).join(' ')
  }
}

export async function saveExploreDeck(ref: ExploreRef): Promise<db.MtgDeck> {
  const { list, sourceRef, name } = await exploreSource(ref)
  const existing = db.findMtgDeckBySource(sourceRef)
  if (existing) return existing
  const deck = db.createMtgDeck({ name, kind: 'edhrec', source_ref: sourceRef, source_url: list.url }, list.cards)
  refreshIdentity(deck.id)
  return db.getMtgDeck(deck.id) ?? deck
}

// ---------------------------------------------------------------- combos + upgrades

export type ComboStatus = 'in_deck' | 'ready' | 'missing'

export interface ComboPiece {
  name: string
  ext_id: string | null
  in_deck: boolean
  owned: boolean
  price: number | null
}

export interface ComboView {
  id: string
  pieces: ComboPiece[]
  results: string[]
  decks: number
  url: string
  /** in_deck: every piece is in the list; ready: the rest are owned; missing: something must be bought. */
  status: ComboStatus
  missing_count: number
  missing_cost: number
}

export interface UpgradeView {
  name: string
  ext_id: string | null
  category: string
  inclusion: number
  synergy: number
  owned: boolean
  price: number | null
  /** Combos this card is still a missing piece of, and how many it would finish outright. */
  combos: number
  completes: number
  score: number
  /** Creature / Instant / Land / ... — swaps pair like with like. */
  type_group: string
}

export interface CutView {
  name: string
  ext_id: string | null
  type_group: string
  /** Share of this commander's decks running it; 0 when EDHREC doesn't list it. */
  inclusion: number
  synergy: number | null
  /** Not among EDHREC's top cards for this commander at all. */
  unlisted: boolean
  /** Part of a combo that is in the deck or one the collection can assemble. */
  combo_piece: boolean
  price: number | null
  score: number
}

export interface SwapView {
  cut: CutView
  add: UpgradeView
}

export interface DeckRecs {
  commanders: string[]
  edhrec_url: string | null
  edhrec_decks: number | null
  combos: ComboView[]
  /** Recommended cards already in the collection: free upgrades. */
  owned_adds: UpgradeView[]
  /** Recommended cards worth buying. */
  buys: UpgradeView[]
  /** The deck's weakest cards for this commander, weakest first. */
  cuts: CutView[]
  /** Free upgrades paired with the cut they should replace. */
  swaps: SwapView[]
  note: string | null
}

const TYPE_GROUPS = ['Land', 'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment'] as const

/** A card's role for swapping. Lands first, so an artifact land swaps with lands. */
function typeGroup(typeLine: string | null | undefined): string {
  const front = (typeLine ?? '').split(' // ')[0]
  return TYPE_GROUPS.find((t) => new RegExp(`\\b${t}\\b`).test(front)) ?? 'Other'
}

/**
 * How much a deck card earns its slot, on the same scale as upgradeScore so a
 * swap can compare the two directly. A card EDHREC doesn't list scores zero;
 * a combo piece the deck can assemble is protected, since its value is in
 * the combination rather than in how often it's played alone.
 */
function keepScore(inclusion: number, synergy: number | null, comboPiece: boolean): number {
  return Math.round((inclusion + Math.max(0, synergy ?? 0) + (comboPiece ? 1 : 0)) * 1000) / 1000
}

/** A swap is only suggested when the add is clearly better than the cut. */
const SWAP_MARGIN = 0.15

/**
 * How strongly to recommend a card. Inclusion (share of this commander's
 * decks running it) is the backbone; positive synergy lifts cards that are
 * good HERE rather than everywhere (Sol Ring sits near zero synergy); and each
 * combo it is a missing piece of adds weight, more when it is the last piece.
 */
function upgradeScore(inclusion: number, synergy: number, comboShares: number[]): number {
  const comboBonus = Math.min(0.6, comboShares.reduce((s, x) => s + 0.3 * x, 0))
  return Math.round((inclusion + Math.max(0, synergy) + comboBonus) * 1000) / 1000
}

async function computeRecs(deckId: string, owned: Map<string, OwnedEntry>): Promise<(DeckRecs & { deckName: string }) | null> {
  const deck = db.getMtgDeck(deckId)
  if (!deck) return null
  const rows = db.listMtgDeckCards(deckId)
  const commanders = rows.filter((r) => r.board === 'commander').map((r) => r.name)
  const empty = {
    deckName: deck.name, commanders, edhrec_url: null, edhrec_decks: null,
    combos: [] as ComboView[], owned_adds: [] as UpgradeView[], buys: [] as UpgradeView[],
    cuts: [] as CutView[], swaps: [] as SwapView[]
  }
  if (!commanders.length) return { ...empty, note: 'Set a commander first: recommendations are per commander.' }

  const page = await edhrec.commanderPage(commanders)
  if (!page) return { ...empty, note: `EDHREC has no page for ${commanders.join(' + ')}.` }

  const inDeck = new Set(rows.map((r) => r.name_key))
  const isOwned = (key: string): boolean => isBasicKey(key) || (owned.get(key)?.qty ?? 0) > 0

  // Facts (price, picture) for everything EDHREC mentions that is not in the deck.
  const mentioned = [
    ...page.recs.map((r) => ({ name: r.name, ext_id: r.scryfallId })),
    ...page.combos.flatMap((c) => c.cards.map((x) => ({ name: x.name, ext_id: x.scryfallId })))
  ]
  const unique = [...new Map(mentioned.map((m) => [db.cardNameKey(m.name), m])).values()]
  await ensureInfo([...unique.filter((m) => !inDeck.has(db.cardNameKey(m.name))), ...rows], owned)
  const info = db.getMtgCardInfo([...unique.map((m) => db.cardNameKey(m.name)), ...rows.map((r) => r.name_key)])
  const typeOf = (key: string): string => typeGroup(owned.get(key)?.type_line ?? info.get(key)?.type_line)
  const priceOf = (key: string): number | null => owned.get(key)?.price ?? info.get(key)?.price ?? null
  const extOf = (key: string, fallback: string | null): string | null =>
    owned.get(key)?.ext_id ?? info.get(key)?.ext_id ?? fallback

  const combos: ComboView[] = page.combos.map((c) => {
    const pieces: ComboPiece[] = c.cards.map((x) => {
      const key = db.cardNameKey(x.name)
      return { name: x.name, ext_id: extOf(key, x.scryfallId), in_deck: inDeck.has(key), owned: isOwned(key), price: priceOf(key) }
    })
    const missing = pieces.filter((p) => !p.in_deck && !p.owned)
    const status: ComboStatus = pieces.every((p) => p.in_deck) ? 'in_deck' : missing.length === 0 ? 'ready' : 'missing'
    return {
      id: c.id, pieces, results: c.results, decks: c.count, url: c.url, status,
      missing_count: missing.length,
      missing_cost: Math.round(missing.reduce((s, p) => s + (p.price ?? 0), 0) * 100) / 100
    }
  })

  // Per card: the combos it is still missing from, weighted 1/(pieces still needed).
  const comboShare = new Map<string, number[]>()
  const completes = new Map<string, number>()
  for (const c of combos) {
    if (c.status === 'in_deck') continue
    const need = c.pieces.filter((p) => !p.in_deck)
    for (const p of need) {
      const key = db.cardNameKey(p.name)
      comboShare.set(key, [...(comboShare.get(key) ?? []), 1 / need.length])
      // "Finishes" = every other outstanding piece is already owned.
      if (need.every((q) => q === p || q.owned)) completes.set(key, (completes.get(key) ?? 0) + 1)
    }
  }

  const ups: UpgradeView[] = []
  const seen = new Set<string>()
  const commanderKeys = new Set(commanders.map((n) => db.cardNameKey(n)))
  const push = (name: string, ext: string | null, category: string, inclusion: number, synergy: number): void => {
    const key = db.cardNameKey(name)
    if (seen.has(key) || inDeck.has(key) || commanderKeys.has(key) || isBasicKey(key)) return
    // Recommendations must be legal under the deck's identity.
    const ci = owned.get(key)?.color_identity ?? info.get(key)?.color_identity ?? null
    if (deck.color_identity && !fitsIdentity(ci, deck.color_identity)) return
    seen.add(key)
    const shares = comboShare.get(key) ?? []
    ups.push({
      name, ext_id: extOf(key, ext), category, inclusion, synergy,
      owned: isOwned(key), price: priceOf(key),
      combos: shares.length, completes: completes.get(key) ?? 0,
      score: upgradeScore(inclusion, synergy, shares),
      type_group: typeOf(key)
    })
  }
  for (const r of page.recs) push(r.name, r.scryfallId, r.category, r.inclusion, r.synergy)
  // Combo pieces EDHREC does not list among its top cards still deserve a slot.
  for (const c of combos) for (const p of c.pieces) if (!p.in_deck) push(p.name, p.ext_id, 'Combo piece', 0, 0)
  ups.sort((a, b) => b.score - a.score || (a.price ?? 0) - (b.price ?? 0))

  // Cuts: the 99 (never the commander, never basics) by how little EDHREC's
  // decks for this commander use them.
  const recByKey = new Map(page.recs.map((r) => [db.cardNameKey(r.name), r]))
  const protectedKeys = new Set(
    combos.filter((c) => c.status !== 'missing').flatMap((c) => c.pieces.map((p) => db.cardNameKey(p.name)))
  )
  const cuts: CutView[] = rows
    .filter((r) => r.board === 'main' && !isBasicKey(r.name_key))
    .map((r) => {
      const rec = recByKey.get(r.name_key)
      const comboPiece = protectedKeys.has(r.name_key)
      return {
        name: r.name,
        ext_id: extOf(r.name_key, r.ext_id),
        type_group: typeOf(r.name_key),
        inclusion: rec?.inclusion ?? 0,
        synergy: rec ? rec.synergy : null,
        unlisted: !rec,
        combo_piece: comboPiece,
        price: priceOf(r.name_key),
        score: keepScore(rec?.inclusion ?? 0, rec ? rec.synergy : null, comboPiece)
      }
    })
    .sort((a, b) => a.score - b.score || (a.synergy ?? -1) - (b.synergy ?? -1))

  // Swaps: each free upgrade takes the weakest unclaimed cut of the same
  // role. Lands only swap for lands so the mana base keeps its count.
  const claimed = new Set<string>()
  const swaps: SwapView[] = []
  for (const add of ups.filter((u) => u.owned)) {
    const cut = cuts.find((c) =>
      !claimed.has(c.name) && !c.combo_piece && c.type_group === add.type_group && add.score >= c.score + SWAP_MARGIN)
    if (!cut) continue
    claimed.add(cut.name)
    swaps.push({ cut, add })
    if (swaps.length >= 20) break
  }

  return {
    deckName: deck.name,
    commanders,
    edhrec_url: page.url,
    edhrec_decks: page.numDecks,
    combos,
    owned_adds: ups.filter((u) => u.owned).slice(0, 60),
    buys: ups.filter((u) => !u.owned).slice(0, 80),
    cuts: cuts.slice(0, 30),
    swaps,
    note: null
  }
}

export async function deckRecs(deckId: string): Promise<DeckRecs | null> {
  const r = await computeRecs(deckId, ownedIndex())
  if (!r) return null
  const { deckName: _name, ...rest } = r
  return rest
}

export interface ShoppingItem {
  name: string
  ext_id: string | null
  price: number | null
  /** Summed recommendation score across the decks it helps. */
  score: number
  completes: number
  decks: Array<{ id: string; name: string }>
}

/**
 * One buy list for the whole collection: every saved deck's purchase
 * recommendations, merged by card. A card several decks want rises above one
 * a single deck loves, and combo finishers keep their weight.
 */
export async function shoppingList(): Promise<{ items: ShoppingItem[]; decks: number; skipped: string[] }> {
  const owned = ownedIndex()
  const merged = new Map<string, ShoppingItem>()
  const skipped: string[] = []
  let used = 0
  for (const d of db.listMtgDecks()) {
    const r = await computeRecs(d.id, owned)
    if (!r || r.note) { skipped.push(d.name); continue }
    used++
    for (const b of r.buys.slice(0, 40)) {
      const key = db.cardNameKey(b.name)
      const e = merged.get(key) ?? { name: b.name, ext_id: b.ext_id, price: b.price, score: 0, completes: 0, decks: [] }
      e.score = Math.round((e.score + b.score) * 1000) / 1000
      e.completes += b.completes
      e.decks.push({ id: d.id, name: d.name })
      merged.set(key, e)
    }
  }
  const items = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 100)
  return { items, decks: used, skipped }
}
