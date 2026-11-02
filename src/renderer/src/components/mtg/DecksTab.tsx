/**
 * Commander decks against the collection.
 *
 * Two lists and one deck view:
 *  - My decks: decks you own as product (resolved from MTGJSON/EDHREC), decks
 *    built from Owned, pasted lists, and cEDH lists you chose to keep.
 *  - cEDH finder: recent top-16 tournament lists from EDHTop16, ranked by how
 *    much of each the collection already covers, priced for what is left.
 *  - Explore: any commander's decks on EDHREC, every bracket (DeckExplorer).
 *
 * Ownership is by card name across printings and nothing is reserved per deck
 * — a card shared by two decks counts for both and the row says "also in".
 * Basic lands always count as owned.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, Bookmark, Check, Compass, Copy, Crown, ExternalLink, Layers, Loader2, Minus, Pencil, Plus,
  RefreshCw, Search, Trash2, Trophy, Upload, X
} from 'lucide-react'
import ProductThumb, { ImageZoom } from './ProductThumb'
import DeckExplorer, { initialExplorerState, type ExplorerState } from './DeckExplorer'
import { CombosPanel, RecsState, ShoppingList, UpgradesPanel, useDeckRecs, type PreviewCard } from './DeckRecs'
import { imageFor, scryfallImage } from '../../lib/mtgImages'
import type {
  MtgCedhMatch, MtgDeckCandidate, MtgExploreRef, MtgPreconHit, MtgDeckCardView, MtgDeckDetail, MtgDeckSummary, MtgOwnedCommander, MtgOwnedItem
} from '../../types'

const money = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 1000 ? 0 : 2 })

const WUBRG = ['W', 'U', 'B', 'R', 'G']
const PIP_DOT: Record<string, string> = {
  W: 'bg-amber-100', U: 'bg-sky-400', B: 'bg-violet-400',
  R: 'bg-red-400', G: 'bg-emerald-400', C: 'bg-white/40'
}

function Pips({ identity }: { identity: string | null }): React.JSX.Element {
  const letters = identity ? identity.split(',') : ['C']
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {letters.map((l) => <span key={l} className={`inline-block h-2 w-2 rounded-full ${PIP_DOT[l] ?? 'bg-white/30'}`} />)}
    </span>
  )
}

/** "{2}{U}{U}" → "2UU"; split cards keep their " // ". */
const shortCost = (cost: string | null): string => (cost ?? '').replace(/[{}]/g, '')

/** Deck sections in the order a decklist is read. */
const SECTIONS = ['Commander', 'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'] as const
type Section = (typeof SECTIONS)[number]

function sectionOf(c: MtgDeckCardView): Section {
  if (c.board === 'commander') return 'Commander'
  const t = (c.type_line ?? '').split(' // ')[0]
  // Land last among the checks would file an artifact land under Artifact;
  // a deck reads lands as lands.
  if (/\bLand\b/.test(t)) return 'Land'
  for (const s of ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment'] as const) {
    if (new RegExp(`\\b${s}\\b`).test(t)) return s
  }
  return 'Other'
}

const fitsIdentity = (card: string | null, deck: string): boolean =>
  card == null || card === '' || card.split(',').every((c) => deck.split(',').includes(c))

type Open = { kind: 'deck'; id: string } | { kind: 'cedh'; entryId: string } | { kind: 'explore'; ref: MtgExploreRef }

/** What the side panel is showing; `add` is set for a card not in the deck yet. */
type Preview = { key: string; name: string; ext_id: string | null; add?: PreviewCard }

export default function DecksTab({ onStatus }: { onStatus: (s: string | null) => void }): React.JSX.Element {
  const [view, setView] = useState<'mine' | 'cedh' | 'explore'>('mine')
  const [open, setOpen] = useState<Open | null>(null)
  // Kept here so backing out of an explored deck returns to the same commander and filters.
  const [explorer, setExplorer] = useState<ExplorerState>(initialExplorerState)

  if (open) {
    return (
      <DeckView
        open={open}
        onBack={() => setOpen(null)}
        onOpenDeck={(id) => { setView('mine'); setOpen({ kind: 'deck', id }) }}
        onStatus={onStatus}
      />
    )
  }
  return (
    <section>
      <div className="mb-4 flex items-center gap-1">
        {([['mine', 'My decks', Layers], ['cedh', 'cEDH finder', Trophy], ['explore', 'Explore', Compass]] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
              view === id ? 'bg-violet-500/20 text-violet-200' : 'text-white/45 hover:bg-white/5 hover:text-white/80'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
      {view === 'mine'
        ? <MyDecks onOpen={(id) => setOpen({ kind: 'deck', id })} onStatus={onStatus} />
        : view === 'cedh'
          ? <CedhFinder onOpen={(entryId) => setOpen({ kind: 'cedh', entryId })} onStatus={onStatus} />
          : <DeckExplorer state={explorer} onState={setExplorer} onOpen={(ref) => setOpen({ kind: 'explore', ref })} />}
    </section>
  )
}

// ---------------------------------------------------------------- My decks

function MyDecks({ onOpen, onStatus }: { onOpen: (id: string) => void; onStatus: (s: string | null) => void }): React.JSX.Element {
  const [decks, setDecks] = useState<MtgDeckSummary[]>([])
  const [candidates, setCandidates] = useState<MtgDeckCandidate[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [form, setForm] = useState<'new' | 'import' | 'precon' | null>(null)

  const load = useCallback(async () => {
    const [d, c] = await Promise.all([window.atlis.mtg.decks(), window.atlis.mtg.deckCandidates()])
    setDecks(d)
    setCandidates(c)
  }, [])
  useEffect(() => { void load() }, [load])

  const loadCandidate = async (c: MtgDeckCandidate): Promise<void> => {
    setBusy(c.ref)
    onStatus(`Looking up the decklist for ${c.name}…`)
    try {
      if (c.kind === 'sealed') {
        const r = await window.atlis.mtg.deckFromSealed(c.ref)
        onStatus(`Added ${r.decks.map((d) => d.name).join(', ')} to My decks.${r.note ? ` ${r.note}` : ''}`)
        await load()
        if (r.decks.length === 1) onOpen(r.decks[0].id)
      } else {
        const r = await window.atlis.mtg.deckFromRipped(c.ref)
        onStatus(`Rebuilt ${r.deck.name} from its ripped cards.${r.note ? ` ${r.note}` : ''}`)
        await load()
        onOpen(r.deck.id)
      }
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const pending = candidates.filter((c) => !c.deck_id)

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">My decks</h2>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => setForm(form === 'new' ? null : 'new')}
            className="flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/20 px-2.5 py-1 text-xs text-violet-100 hover:bg-violet-500/30"
          >
            <Plus className="h-3.5 w-3.5" /> New deck
          </button>
          <button
            onClick={() => setForm(form === 'precon' ? null : 'precon')}
            className="flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-xs text-white/60 hover:bg-white/10"
          >
            <Layers className="h-3.5 w-3.5" /> Add a precon
          </button>
          <button
            onClick={() => setForm(form === 'import' ? null : 'import')}
            className="flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-xs text-white/60 hover:bg-white/10"
          >
            <Upload className="h-3.5 w-3.5" /> Import list
          </button>
        </div>
      </div>

      {form === 'new' && (
        <NewDeckForm
          onCancel={() => setForm(null)}
          onCreated={(id) => { setForm(null); void load(); onOpen(id) }}
          onStatus={onStatus}
        />
      )}
      {form === 'precon' && (
        <PreconForm
          onCancel={() => setForm(null)}
          onCreated={(id) => { setForm(null); void load(); onOpen(id) }}
          onStatus={onStatus}
        />
      )}
      {form === 'import' && (
        <ImportForm
          onCancel={() => setForm(null)}
          onCreated={(id) => { setForm(null); void load(); onOpen(id) }}
          onStatus={onStatus}
        />
      )}

      {pending.length > 0 && (
        <div className="mb-4 rounded-md border border-amber-400/20 bg-amber-500/[0.06] p-3">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-amber-200/70">
            Decks in your collection
          </div>
          <div className="space-y-1.5">
            {pending.map((c) => (
              <div key={`${c.kind}:${c.ref}`} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="shrink-0 text-[11px] text-white/40">
                  {c.kind === 'sealed' ? 'sealed' : `ripped · ${c.cards} cards`}
                </span>
                <button
                  onClick={() => void loadCandidate(c)}
                  disabled={busy != null}
                  className="flex shrink-0 items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-white/70 hover:bg-white/10 disabled:opacity-50"
                >
                  {busy === c.ref ? <Loader2 className="h-3 w-3 animate-spin" /> : <Layers className="h-3 w-3" />}
                  Load decklist
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {decks.length > 0 && <ShoppingList onOpenDeck={onOpen} onStatus={onStatus} />}

      {decks.length === 0 ? (
        <p className="text-sm text-white/40">
          No decks yet. Load a deck you own above, start a new one from a commander in your collection, or paste a list
          from Moxfield or Archidekt.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {decks.map((d) => <DeckCard key={d.id} deck={d} onOpen={() => onOpen(d.id)} />)}
        </div>
      )}
    </div>
  )
}

const KIND_LABEL: Record<MtgDeckSummary['kind'], { label: string; cls: string }> = {
  custom: { label: 'Built', cls: 'bg-violet-500/20 text-violet-200' },
  precon: { label: 'Owned deck', cls: 'bg-amber-500/20 text-amber-200' },
  cedh: { label: 'cEDH', cls: 'bg-sky-500/20 text-sky-200' },
  edhrec: { label: 'EDHREC', cls: 'bg-emerald-500/20 text-emerald-200' }
}

function OwnedBar({ owned, total }: { owned: number; total: number }): React.JSX.Element {
  const pct = total ? Math.round((owned / total) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${pct >= 90 ? 'bg-emerald-400' : pct >= 60 ? 'bg-amber-400' : 'bg-red-400/70'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-white/50">{owned}/{total} · {pct}%</span>
    </div>
  )
}

function DeckCard({ deck, onOpen }: { deck: MtgDeckSummary; onOpen: () => void }): React.JSX.Element {
  const kind = KIND_LABEL[deck.kind]
  return (
    <button
      onClick={onOpen}
      className="flex items-start gap-3 rounded-md border border-white/10 bg-white/[0.03] p-3 text-left hover:border-violet-400/30 hover:bg-white/[0.05]"
    >
      <ProductThumb
        image={deck.commander_ext_id ? scryfallImage(deck.commander_ext_id, 'small') : null}
        alt={deck.commanders[0] ?? deck.name}
        size="md"
        icon={Crown}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{deck.name}</span>
          <Pips identity={deck.color_identity} />
        </div>
        <div className="mb-2 truncate text-[11px] text-white/45">
          {deck.commanders.length ? deck.commanders.join(' + ') : 'No commander yet'}
        </div>
        <OwnedBar owned={deck.owned_count} total={deck.card_count} />
        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
          <span className={`rounded px-1.5 py-0.5 ${kind.cls}`}>{kind.label}</span>
          <span className="text-white/40">{money(deck.value)}</span>
          {deck.missing_cost > 0 && <span className="ml-auto text-amber-200/80">need {money(deck.missing_cost)}</span>}
        </div>
      </div>
    </button>
  )
}

function NewDeckForm({
  onCancel, onCreated, onStatus
}: { onCancel: () => void; onCreated: (id: string) => void; onStatus: (s: string | null) => void }): React.JSX.Element {
  const [commanders, setCommanders] = useState<MtgOwnedCommander[]>([])
  const [name, setName] = useState('')
  const [first, setFirst] = useState('')
  const [partner, setPartner] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { void window.atlis.mtg.commanders().then(setCommanders) }, [])
  const byName = useMemo(() => new Map(commanders.map((c) => [c.name, c])), [commanders])
  // Only offered when the first commander's text says it can share the zone.
  const partnerable = /partner|choose a background|friends forever|doctor's companion/i.test(byName.get(first)?.oracle_text ?? '')

  const create = async (): Promise<void> => {
    const picks = [first, partnerable ? partner : ''].filter(Boolean).map((n) => byName.get(n)).filter(Boolean) as MtgOwnedCommander[]
    setSaving(true)
    try {
      const deck = await window.atlis.mtg.deckCreate({
        name: name.trim() || picks.map((p) => p.name.split(',')[0]).join(' + ') || 'New deck',
        commanders: picks.map((p) => ({ name: p.name, ext_id: p.ext_source === 'scryfall' ? p.ext_id : null }))
      })
      onCreated(deck.id)
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const select = 'w-full rounded-md border border-white/10 bg-[#16161d] px-2 py-1.5 text-sm focus:border-violet-400/50 focus:outline-none'
  return (
    <div className="mb-4 space-y-2 rounded-md border border-white/10 bg-white/[0.03] p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Deck name (optional)" className={select} />
        <select value={first} onChange={(e) => setFirst(e.target.value)} className={select}>
          <option value="">Commander — from your legends…</option>
          {commanders.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        {partnerable && (
          <select value={partner} onChange={(e) => setPartner(e.target.value)} className={select}>
            <option value="">Partner / background (optional)</option>
            {commanders.filter((c) => c.name !== first).map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-white/35">
          {commanders.length
            ? 'The card picker then offers only owned cards in your commander’s colours.'
            : 'No owned legends found — you can still start an empty deck and crown a card later.'}
        </span>
        <button onClick={onCancel} className="ml-auto rounded px-2 py-1 text-xs text-white/50 hover:bg-white/10">Cancel</button>
        <button
          onClick={() => void create()}
          disabled={saving}
          className="flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/20 px-2.5 py-1 text-xs text-violet-100 hover:bg-violet-500/30 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />} Create
        </button>
      </div>
    </div>
  )
}

/**
 * Add a preconstructed deck by searching MTGJSON's commander-deck index — by
 * deck name, set name or commander ("mothman" finds Fallout's Mutant Menace).
 */
function PreconForm({
  onCancel, onCreated, onStatus
}: { onCancel: () => void; onCreated: (id: string) => void; onStatus: (s: string | null) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MtgPreconHit[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const search = async (): Promise<void> => {
    if (!query.trim()) return
    setBusy('search')
    try {
      setHits(await window.atlis.mtg.searchPrecons(query))
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const add = async (h: MtgPreconHit): Promise<void> => {
    setBusy(h.fileName)
    try {
      const d = await window.atlis.mtg.deckFromPrecon(h.fileName)
      onStatus(`Added ${d.name} to My decks.`)
      onCreated(d.id)
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const MATCH: Record<MtgPreconHit['matchedBy'], string> = {
    name: 'deck name', set: 'set', commander: 'commander printed in this set'
  }

  return (
    <div className="mb-4 space-y-2 rounded-md border border-white/10 bg-white/[0.03] p-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search() }}
            placeholder="Deck, set or commander — e.g. “mutant menace”, “fallout”, “mothman”"
            className="w-full rounded-md border border-white/10 bg-white/[0.03] py-1.5 pl-8 pr-2 text-sm placeholder:text-white/25 focus:border-violet-400/50 focus:outline-none"
          />
        </div>
        <button
          onClick={() => void search()}
          disabled={busy != null || !query.trim()}
          className="flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/20 px-2.5 py-1 text-xs text-violet-100 hover:bg-violet-500/30 disabled:opacity-50"
        >
          {busy === 'search' && <Loader2 className="h-3 w-3 animate-spin" />} Search
        </button>
        <button onClick={onCancel} className="rounded px-2 py-1 text-xs text-white/50 hover:bg-white/10">Cancel</button>
      </div>
      {hits && (
        <div className="max-h-[300px] divide-y divide-white/5 overflow-y-auto rounded border border-white/5">
          {hits.map((h) => (
            <div key={h.fileName} className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{h.name}</div>
                <div className="truncate text-[11px] text-white/40">
                  {h.setName ?? h.code} · {h.releaseDate?.slice(0, 4) ?? ''} · matched {MATCH[h.matchedBy]}
                </div>
              </div>
              <button
                onClick={() => void add(h)}
                disabled={busy != null}
                className="flex shrink-0 items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-white/70 hover:border-violet-400/50 hover:bg-violet-500/20 disabled:opacity-50"
              >
                {busy === h.fileName ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />} Add
              </button>
            </div>
          ))}
          {hits.length === 0 && <p className="px-2 py-3 text-sm text-white/40">No commander precon matches that.</p>}
        </div>
      )}
    </div>
  )
}

function ImportForm({
  onCancel, onCreated, onStatus
}: { onCancel: () => void; onCreated: (id: string) => void; onStatus: (s: string | null) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length

  const run = async (): Promise<void> => {
    setSaving(true)
    onStatus('Matching card names on Scryfall…')
    try {
      const r = await window.atlis.mtg.deckImport(name.trim() || 'Imported deck', text)
      onStatus(r.note ?? `Imported ${r.deck.name}.`)
      onCreated(r.deck.id)
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-4 space-y-2 rounded-md border border-white/10 bg-white/[0.03] p-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Deck name"
        className="w-full rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5 text-sm focus:border-violet-400/50 focus:outline-none"
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={'Paste an export from Moxfield, Archidekt or MTGO:\n\nCommander\n1 Krenko, Mob Boss\n\nDeck\n1 Sol Ring\n1 Skirk Prospector (DOM) 144\n…'}
        className="w-full rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5 font-mono text-xs focus:border-violet-400/50 focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-white/35">{lines} line(s). A “Commander” section or *CMDR* marker sets the commander.</span>
        <button onClick={onCancel} className="ml-auto rounded px-2 py-1 text-xs text-white/50 hover:bg-white/10">Cancel</button>
        <button
          onClick={() => void run()}
          disabled={saving || !lines}
          className="flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/20 px-2.5 py-1 text-xs text-violet-100 hover:bg-violet-500/30 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />} Import
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- cEDH finder

function CedhFinder({ onOpen, onStatus }: { onOpen: (entryId: string) => void; onStatus: (s: string | null) => void }): React.JSX.Element {
  const [rows, setRows] = useState<MtgCedhMatch[]>([])
  const [loaded, setLoaded] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [depth, setDepth] = useState(40)
  const [query, setQuery] = useState('')
  const [bestOnly, setBestOnly] = useState(true)
  const [ownCommander, setOwnCommander] = useState(false)
  const [colors, setColors] = useState<string[]>([])

  const load = useCallback(async () => {
    setRows(await window.atlis.mtg.cedhMatches())
    setLoaded(true)
  }, [])
  useEffect(() => { void load() }, [load])

  const sync = async (): Promise<void> => {
    setSyncing(true)
    onStatus(`Pulling top cEDH lists for the ${depth} most-played commanders from EDHTop16…`)
    try {
      const r = await window.atlis.mtg.syncCedhLists({ commanders: depth, perCommander: 3 })
      await load()
      onStatus(`${r.lists} tournament lists across ${r.commanders} commanders.` + (r.failed.length ? ` ${r.failed.length} batch(es) failed: ${r.failed[0]}` : ''))
    } catch (e) {
      onStatus(`cEDH sync failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSyncing(false)
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = rows.filter((r) => {
      if (q && !r.commander.toLowerCase().includes(q)) return false
      if (ownCommander && !r.own_commander) return false
      // "Fits": the list's identity sits inside the picked colours.
      if (colors.length && !fitsIdentity(r.color_identity, WUBRG.filter((c) => colors.includes(c)).join(','))) return false
      return true
    })
    if (!bestOnly) return filtered
    const seen = new Set<string>()
    return filtered.filter((r) => (seen.has(r.commander) ? false : (seen.add(r.commander), true)))
  }, [rows, query, bestOnly, ownCommander, colors])

  const syncedAt = rows[0]?.synced_at ?? null
  const syncControls = (
    <div className="flex items-center gap-1.5">
      <select
        value={depth}
        onChange={(e) => setDepth(Number(e.target.value))}
        title="How many of the most-played commanders to pull lists for"
        className="rounded border border-white/10 bg-[#16161d] px-1.5 py-0.5 text-[11px] text-white/60"
      >
        {[20, 40, 60, 100].map((n) => <option key={n} value={n}>Top {n} commanders</option>)}
      </select>
      <button
        onClick={() => void sync()}
        disabled={syncing}
        className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-50"
      >
        {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        {rows.length ? 'Refresh lists' : 'Pull lists'}
      </button>
    </div>
  )

  if (loaded && rows.length === 0) {
    return (
      <div className="p-6 text-center">
        <Trophy className="mx-auto mb-3 h-8 w-8 text-white/20" />
        <p className="mb-1 text-sm text-white/70">No cEDH lists cached yet.</p>
        <p className="mx-auto mb-4 max-w-md text-xs text-white/40">
          ATLIS pulls the best recent finishes (top 16 at 32+ player events, last three months) for the most-played
          commanders on EDHTop16, then ranks every list by how much of it you already own.
        </p>
        <div className="flex justify-center">{syncControls}</div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-white/40">cEDH lists — closest to finished first</h2>
        <div className="ml-auto">{syncControls}</div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commanders…"
            className="w-full rounded-md border border-white/10 bg-white/[0.03] py-1.5 pl-8 pr-8 text-sm placeholder:text-white/25 focus:border-violet-400/50 focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1" title="Lists that fit inside these colours">
          {WUBRG.map((c) => {
            const on = colors.includes(c)
            return (
              <button
                key={c}
                onClick={() => setColors((p) => (on ? p.filter((x) => x !== c) : [...p, c]))}
                className={`h-6 w-6 rounded-full border text-[10px] font-semibold ${
                  on ? 'border-violet-400/60 bg-violet-500/30 text-white' : 'border-white/10 text-white/40 hover:bg-white/10'
                }`}
              >
                {c}
              </button>
            )
          })}
        </div>
        {([
          [bestOnly, setBestOnly, 'Best list per commander'],
          [ownCommander, setOwnCommander, 'I own the commander']
        ] as const).map(([on, set, label]) => (
          <button
            key={label}
            onClick={() => set((v: boolean) => !v)}
            className={`rounded border px-2 py-1 text-[11px] ${
              on ? 'border-violet-400/50 bg-violet-500/20 text-violet-200' : 'border-white/10 text-white/45 hover:bg-white/10'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        {visible.map((r) => (
          <button
            key={r.entry_id}
            onClick={() => onOpen(r.entry_id)}
            className="flex w-full items-center gap-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-left hover:border-violet-400/30"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm">{r.commander}</span>
                <Pips identity={r.color_identity} />
                {r.own_commander && (
                  <span title="You own the commander" className="shrink-0 text-amber-300"><Crown className="h-3 w-3" /></span>
                )}
              </div>
              <div className="truncate text-[11px] text-white/40">
                #{r.standing ?? '?'} of {r.tournament_size ?? '?'} · {r.tournament ?? 'Tournament'} · {r.tournament_date ?? ''}
              </div>
            </div>
            <div className="w-48 shrink-0"><OwnedBar owned={r.owned_count} total={r.card_count} /></div>
            <div className="w-24 shrink-0 text-right">
              <div className="text-sm tabular-nums text-amber-200/90">{money(r.missing_cost)}</div>
              <div className="text-[10px] text-white/35">to finish</div>
            </div>
            <div className="hidden w-20 shrink-0 text-right text-[11px] tabular-nums text-white/35 lg:block">
              {money(r.deck_price)}
              <div className="text-[10px]">list total</div>
            </div>
          </button>
        ))}
        {visible.length === 0 && <p className="text-sm text-white/40">No list matches those filters.</p>}
      </div>
      {syncedAt && (
        <p className="mt-3 text-[11px] text-white/30">
          {rows.length} lists from EDHTop16, synced {new Date(syncedAt).toLocaleDateString()}. Owned is matched by card
          name across printings; basic lands count as owned. Prices are EDHTop16’s per-card quotes.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- deck view

function DeckView({
  open, onBack, onOpenDeck, onStatus
}: { open: Open; onBack: () => void; onOpenDeck: (id: string) => void; onStatus: (s: string | null) => void }): React.JSX.Element {
  const [deck, setDeck] = useState<MtgDeckDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [missingOnly, setMissingOnly] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [zoomed, setZoomed] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [pane, setPane] = useState<'cards' | 'combos' | 'upgrades'>('cards')
  // Bumped on every edit so the EDHREC panels re-score against the new list.
  const [revision, setRevision] = useState(0)
  const editable = open.kind === 'deck'
  const deckId = open.kind === 'deck' ? open.id : null

  const load = useCallback(async () => {
    try {
      const d = open.kind === 'deck'
        ? await window.atlis.mtg.deck(open.id)
        : open.kind === 'cedh' ? await window.atlis.mtg.cedhList(open.entryId) : await window.atlis.mtg.exploreDeck(open.ref)
      setDeck(d)
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [open, onStatus])
  useEffect(() => { setLoading(true); void load() }, [load])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      await load()
      setRevision((r) => r + 1)
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e))
    }
  }

  const recsState = useDeckRecs(deckId, revision, pane !== 'cards')

  /** Add cards to the 99; a previewed card that was added stops offering "Add". */
  const addCards = async (cards: PreviewCard[]): Promise<void> => {
    if (!deckId || !cards.length) return
    await act(async () => {
      for (const c of cards) {
        await window.atlis.mtg.deckSetCard(deckId, { name: c.name, ext_id: c.ext_id, quantity: 1, board: 'main' })
      }
    })
    const added = new Set(cards.map((c) => c.name))
    setPreview((p) => (p?.add && added.has(p.add.name) ? { ...p, add: undefined } : p))
    if (cards.length > 1) onStatus(`Added ${cards.map((c) => c.name).join(', ')}.`)
  }
  const previewOther = (c: PreviewCard): void => setPreview({ key: `rec:${c.name}`, name: c.name, ext_id: c.ext_id, add: c })

  const grouped = useMemo(() => {
    const out = new Map<Section, MtgDeckCardView[]>()
    for (const c of deck?.cards ?? []) {
      if (missingOnly && (c.basic || c.owned >= c.quantity)) continue
      const s = sectionOf(c)
      out.set(s, [...(out.get(s) ?? []), c])
    }
    for (const list of out.values()) list.sort((a, b) => (a.cmc ?? 99) - (b.cmc ?? 99) || a.name.localeCompare(b.name))
    return SECTIONS.filter((s) => out.has(s)).map((s) => [s, out.get(s) as MtgDeckCardView[]] as const)
  }, [deck, missingOnly])

  if (loading && !deck) {
    return <div className="flex items-center gap-2 p-6 text-sm text-white/50"><Loader2 className="h-4 w-4 animate-spin" /> Loading deck…</div>
  }
  if (!deck) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="mb-3 flex items-center gap-1 text-xs text-white/50 hover:text-white/80"><ArrowLeft className="h-3.5 w-3.5" /> Back</button>
        <p className="text-sm text-white/40">That deck no longer exists.</p>
      </div>
    )
  }

  const missing = deck.cards.filter((c) => !c.basic && c.owned < c.quantity)
  const copyList = async (onlyMissing: boolean): Promise<void> => {
    const lines = (onlyMissing ? missing : deck.cards).map((c) => `${onlyMissing ? c.quantity - c.owned : c.quantity} ${c.name}`)
    const text = onlyMissing ? lines.join('\n') : [
      'Commander', ...deck.cards.filter((c) => c.board === 'commander').map((c) => `1 ${c.name}`),
      '', 'Deck', ...deck.cards.filter((c) => c.board === 'main').map((c) => `${c.quantity} ${c.name}`)
    ].join('\n')
    await navigator.clipboard.writeText(text)
    onStatus(onlyMissing ? `Copied ${missing.length} missing card(s) — paste into TCGplayer’s Mass Entry.` : 'Decklist copied.')
  }

  const saveCedh = async (): Promise<void> => {
    if (open.kind === 'deck') return
    try {
      const d = open.kind === 'cedh' ? await window.atlis.mtg.cedhSaveDeck(open.entryId) : await window.atlis.mtg.exploreSaveDeck(open.ref)
      onStatus(`Saved to My decks as “${d.name}”.`)
      onOpenDeck(d.id)
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (): Promise<void> => {
    if (!deckId || !window.confirm(`Delete “${deck.name}”? Your owned cards are not touched.`)) return
    await window.atlis.mtg.deckDelete(deckId)
    onBack()
  }

  const commanderCount = deck.cards.filter((c) => c.board === 'commander').length
  const outside = deck.cards.filter((c) => !c.in_identity).length
  const target = 100

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button onClick={onBack} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-white/50 hover:bg-white/10 hover:text-white/80">
            <ArrowLeft className="h-3.5 w-3.5" /> Decks
          </button>
          {renaming != null ? (
            <input
              autoFocus
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={() => { if (deckId) void act(() => window.atlis.mtg.deckRename(deckId, renaming)); setRenaming(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null) }}
              className="rounded border border-violet-400/40 bg-white/[0.03] px-2 py-0.5 text-sm"
            />
          ) : (
            <h2 className="flex min-w-0 items-center gap-2 truncate text-sm font-medium">
              {deck.name}
              {editable && (
                <button onClick={() => setRenaming(deck.name)} title="Rename" className="text-white/30 hover:text-white/70"><Pencil className="h-3 w-3" /></button>
              )}
            </h2>
          )}
          <Pips identity={deck.color_identity} />
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${KIND_LABEL[deck.kind].cls}`}>{KIND_LABEL[deck.kind].label}</span>
          <div className="ml-auto flex items-center gap-1.5">
            {deck.source_url && (
              <a href={deck.source_url} target="_blank" rel="noreferrer" title="Open the source list"
                className="rounded border border-white/10 p-1.5 text-white/40 hover:bg-white/10 hover:text-white/80">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {open.kind !== 'deck' && (
              <button onClick={() => void saveCedh()} className="flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/20 px-2 py-1 text-[11px] text-violet-100 hover:bg-violet-500/30">
                <Bookmark className="h-3 w-3" /> Save to my decks
              </button>
            )}
            {editable && (
              <button onClick={() => void remove()} title="Delete deck" className="rounded border border-white/10 p-1.5 text-white/40 hover:bg-red-500/20 hover:text-red-200">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Cards" value={`${deck.card_count}/${target}`} warn={deck.card_count !== target} />
          <Stat label="Owned" value={`${deck.owned_count} (${deck.card_count ? Math.round((deck.owned_count / deck.card_count) * 100) : 0}%)`} />
          <Stat label="Deck value" value={money(deck.value)} />
          <Stat label="To finish" value={money(deck.missing_cost)} warn={deck.missing_cost > 0} />
        </div>

        {(deck.note || outside > 0) && (
          <p className="mb-3 text-[11px] text-white/40">
            {deck.note}
            {outside > 0 && <span className="ml-1 text-red-300/80">{outside} card(s) fall outside the commander’s colours.</span>}
          </p>
        )}

        {editable && (
          <div className="mb-3 flex items-center gap-1 border-b border-white/10">
            {([['cards', 'Cards'], ['combos', 'Combos'], ['upgrades', 'Upgrades']] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setPane(id)}
                className={`-mb-px border-b-2 px-3 py-1.5 text-xs ${
                  pane === id ? 'border-violet-400 text-violet-200' : 'border-transparent text-white/45 hover:text-white/80'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {pane !== 'cards' && (
          <>
            <RecsState {...recsState} />
            {recsState.recs && !recsState.recs.note && (pane === 'combos' ? (
              <CombosPanel recs={recsState.recs} activeName={preview?.name ?? null} onPreview={previewOther}
                onAddMany={(cards) => void addCards(cards)} />
            ) : (
              <UpgradesPanel recs={recsState.recs} activeName={preview?.name ?? null} onPreview={previewOther}
                onAdd={(c) => void addCards([c])}
                onRemove={(name) => deckId && void act(() => window.atlis.mtg.deckSetCard(deckId, { name, quantity: 0, board: 'main' }))}
                onSwap={(cut, add) => deckId && void act(async () => {
                  await window.atlis.mtg.deckSetCard(deckId, { name: cut, quantity: 0, board: 'main' })
                  await window.atlis.mtg.deckSetCard(deckId, { name: add.name, ext_id: add.ext_id, quantity: 1, board: 'main' })
                  onStatus(`Swapped ${cut} for ${add.name}.`)
                })}
                onStatus={onStatus} />
            ))}
          </>
        )}

        {pane === 'cards' && (<>
        <div className="mb-2 flex items-center gap-2">
          <button
            onClick={() => setMissingOnly((v) => !v)}
            className={`rounded border px-2 py-1 text-[11px] ${
              missingOnly ? 'border-amber-400/50 bg-amber-500/20 text-amber-100' : 'border-white/10 text-white/45 hover:bg-white/10'
            }`}
          >
            Missing only ({missing.length})
          </button>
          <button onClick={() => void copyList(true)} disabled={!missing.length}
            className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-40">
            <Copy className="h-3 w-3" /> Copy missing
          </button>
          <button onClick={() => void copyList(false)}
            className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[11px] text-white/50 hover:bg-white/10">
            <Copy className="h-3 w-3" /> Copy list
          </button>
        </div>

        <div className="space-y-4">
          {grouped.map(([section, cards]) => (
            <div key={section}>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/35">
                {section} <span className="text-white/25">{cards.reduce((n, c) => n + c.quantity, 0)}</span>
              </div>
              <div className="divide-y divide-white/5 rounded-md border border-white/10 bg-white/[0.02]">
                {cards.map((c) => (
                  <CardRow
                    key={`${c.board}:${c.name_key}`}
                    card={c}
                    editable={editable}
                    active={preview?.key === c.name_key}
                    onPreview={() => setPreview({ key: c.name_key, name: c.name, ext_id: c.ext_id })}
                    onQty={(q) => deckId && void act(() => window.atlis.mtg.deckSetCard(deckId, { name: c.name, ext_id: c.ext_id, quantity: q, board: c.board }))}
                    onCrown={() => deckId && void act(() => window.atlis.mtg.deckMoveCard(deckId, c.name, c.board === 'commander' ? 'main' : 'commander'))}
                  />
                ))}
              </div>
            </div>
          ))}
          {grouped.length === 0 && (
            <p className="text-sm text-white/40">{missingOnly ? 'Nothing missing — you own the whole list.' : 'No cards yet — add some from your collection.'}</p>
          )}
        </div>
        </>)}
      </div>

      {/* Sticks to the top of the scroll area with its own scrollbar, so the
          preview stays beside whatever row is clicked, however long the list. */}
      <aside className="space-y-4 lg:sticky lg:top-0 lg:max-h-[calc(100vh-9rem)] lg:self-start lg:overflow-y-auto lg:pr-1">
        {preview?.ext_id ? (
          <div className="mx-auto w-full max-w-[240px] space-y-2">
            <ProductThumb
              image={scryfallImage(preview.ext_id, 'normal')}
              alt={preview.name}
              size="lg"
              title="Click to enlarge"
              onClick={() => setZoomed(true)}
            />
            {preview.add && deckId && (
              <button
                onClick={() => preview.add && void addCards([preview.add])}
                className="flex w-full items-center justify-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/20 px-2 py-1 text-xs text-violet-100 hover:bg-violet-500/30"
              >
                <Plus className="h-3.5 w-3.5" /> Add to deck
              </button>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-white/10 p-4 text-center text-[11px] text-white/30">
            Click a card to see it here.
          </div>
        )}
        <Curve cards={deck.cards} />
        {editable && deckId && (
          <CardPicker
            deck={deck}
            commanderCount={commanderCount}
            activeKey={preview?.key ?? null}
            onPreview={(o) => {
              const card = { name: o.name, ext_id: o.ext_source === 'scryfall' ? o.ext_id : null }
              setPreview({ key: `pick:${o.id}`, ...card, add: card })
            }}
            onAdd={(o) => void addCards([{ name: o.name, ext_id: o.ext_source === 'scryfall' ? o.ext_id : null }])}
          />
        )}
      </aside>
      {zoomed && preview?.ext_id && (() => {
        const large = scryfallImage(preview.ext_id, 'large')
        return large ? <ImageZoom image={large} name={preview.name} onClose={() => setZoomed(false)} /> : null
      })()}
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }): React.JSX.Element {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-white/35">{label}</div>
      <div className={`text-sm tabular-nums ${warn ? 'text-amber-200' : ''}`}>{value}</div>
    </div>
  )
}

function CardRow({
  card: c, editable, active, onPreview, onQty, onCrown
}: {
  card: MtgDeckCardView
  editable: boolean
  active: boolean
  onPreview: () => void
  onQty: (q: number) => void
  onCrown: () => void
}): React.JSX.Element {
  const have = Math.min(c.owned, c.quantity)
  const status = c.basic || have >= c.quantity ? 'owned' : have > 0 ? 'partial' : 'missing'
  return (
    <div className={`group flex items-center gap-2 px-2 py-1 text-sm ${active ? 'bg-violet-500/10' : 'hover:bg-white/[0.03]'}`}>
      <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-white/40">{c.quantity}</span>
      <span
        title={status === 'owned' ? `Owned (${c.owned})` : status === 'partial' ? `Own ${have} of ${c.quantity}` : 'Not owned'}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
          status === 'owned' ? 'bg-emerald-500/25 text-emerald-300' : status === 'partial' ? 'bg-amber-500/25 text-amber-200' : 'bg-red-500/20 text-red-300'
        }`}
      >
        {status === 'owned' ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
      </span>
      <button onClick={onPreview} className={`min-w-0 flex-1 truncate text-left ${c.in_identity ? '' : 'text-red-300'}`}
        title={c.in_identity ? c.type_line ?? '' : 'Outside the commander’s colour identity'}>
        {c.name}
      </button>
      {c.other_decks.length > 0 && (
        <span title={`Also in: ${c.other_decks.join(', ')}`} className="shrink-0 rounded bg-white/5 px-1 text-[10px] text-white/40">
          +{c.other_decks.length} deck{c.other_decks.length > 1 ? 's' : ''}
        </span>
      )}
      <span className="w-14 shrink-0 text-right font-mono text-[10px] text-white/35">{shortCost(c.mana_cost)}</span>
      <span className={`w-16 shrink-0 text-right text-[11px] tabular-nums ${status === 'owned' ? 'text-white/35' : 'text-amber-200/80'}`}>
        {c.basic ? '' : money(c.price)}
      </span>
      {editable && (
        <span className="flex w-[72px] shrink-0 items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100">
          <button onClick={onCrown} title={c.board === 'commander' ? 'Move to the 99' : 'Make commander'}
            className={`rounded p-0.5 hover:bg-white/10 ${c.board === 'commander' ? 'text-amber-300' : 'text-white/40'}`}>
            <Crown className="h-3 w-3" />
          </button>
          {c.board === 'main' && (
            <>
              <button onClick={() => onQty(c.quantity - 1)} title="One fewer" className="rounded p-0.5 text-white/40 hover:bg-white/10"><Minus className="h-3 w-3" /></button>
              <button onClick={() => onQty(c.quantity + 1)} title="One more" className="rounded p-0.5 text-white/40 hover:bg-white/10"><Plus className="h-3 w-3" /></button>
            </>
          )}
          <button onClick={() => onQty(0)} title="Remove" className="rounded p-0.5 text-white/40 hover:bg-red-500/20 hover:text-red-200"><Trash2 className="h-3 w-3" /></button>
        </span>
      )}
    </div>
  )
}

/** Mana curve of the non-land cards, plus the land count. */
function Curve({ cards }: { cards: MtgDeckCardView[] }): React.JSX.Element {
  const buckets = [0, 0, 0, 0, 0, 0, 0, 0]
  let lands = 0
  for (const c of cards) {
    if (c.board === 'commander') continue
    if (/\bLand\b/.test((c.type_line ?? '').split(' // ')[0])) { lands += c.quantity; continue }
    if (c.cmc == null) continue
    buckets[Math.min(7, Math.floor(c.cmc))] += c.quantity
  }
  const max = Math.max(1, ...buckets)
  const spells = buckets.reduce((a, b) => a + b, 0)
  const avg = spells ? buckets.reduce((s, n, i) => s + n * i, 0) / spells : 0
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 flex items-baseline justify-between text-[11px] text-white/40">
        <span className="uppercase tracking-wide">Mana curve</span>
        <span className="tabular-nums">{lands} lands · avg {avg.toFixed(2)}</span>
      </div>
      <div className="flex h-20 items-end gap-1">
        {buckets.map((n, i) => (
          <div key={i} className="flex flex-1 flex-col items-center justify-end gap-0.5">
            <span className="text-[9px] tabular-nums text-white/40">{n || ''}</span>
            <div className="w-full rounded-sm bg-violet-400/60" style={{ height: `${(n / max) * 56}px` }} />
            <span className="text-[9px] text-white/35">{i === 7 ? '7+' : i}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Add cards from Owned. Only singles legal under the commander's identity are
 * offered (colourless always fits), each name once however many printings
 * are held, and cards already in the deck drop out.
 */
function CardPicker({
  deck, commanderCount, activeKey, onPreview, onAdd
}: {
  deck: MtgDeckDetail
  commanderCount: number
  activeKey: string | null
  onPreview: (o: MtgOwnedItem) => void
  onAdd: (o: MtgOwnedItem) => void
}): React.JSX.Element {
  const [owned, setOwned] = useState<MtgOwnedItem[]>([])
  const [query, setQuery] = useState('')
  const [type, setType] = useState<string>('')
  useEffect(() => { void window.atlis.mtg.owned().then(setOwned) }, [])

  const inDeck = useMemo(() => new Set(deck.cards.map((c) => c.name.split(' // ')[0].toLowerCase())), [deck])
  const pool = useMemo(() => {
    const q = query.trim().toLowerCase()
    const seen = new Set<string>()
    return owned
      .filter((o) => o.category === 'mtg_card' && o.color_identity != null)
      .filter((o) => !commanderCount || fitsIdentity(o.color_identity, deck.color_identity))
      .filter((o) => !inDeck.has(o.name.split(' // ')[0].toLowerCase()))
      .filter((o) => !type || new RegExp(`\\b${type}\\b`).test(o.type_line ?? ''))
      .filter((o) => !q || `${o.name} ${o.type_line ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => (b.cedh_play_rate ?? 0) - (a.cedh_play_rate ?? 0) || a.name.localeCompare(b.name))
      .filter((o) => (seen.has(o.name) ? false : (seen.add(o.name), true)))
      .slice(0, 150)
  }, [owned, query, type, inDeck, deck.color_identity, commanderCount])

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-white/40">Add from your collection</div>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-white/30" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={commanderCount ? 'Search cards that fit…' : 'Search your cards…'}
          className="w-full rounded border border-white/10 bg-white/[0.03] py-1 pl-7 pr-2 text-xs focus:border-violet-400/50 focus:outline-none"
        />
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {['', 'Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Land'].map((t) => (
          <button
            key={t || 'all'}
            onClick={() => setType(t)}
            className={`rounded px-1.5 py-0.5 text-[10px] ${type === t ? 'bg-violet-500/25 text-violet-200' : 'text-white/40 hover:bg-white/5'}`}
          >
            {t || 'All'}
          </button>
        ))}
      </div>
      <div className="max-h-[420px] space-y-0.5 overflow-y-auto">
        {pool.map((o) => (
          // Row click previews; only the + button adds.
          <div
            key={o.id}
            role="button"
            tabIndex={0}
            onClick={() => onPreview(o)}
            onKeyDown={(e) => { if (e.key === 'Enter') onPreview(o) }}
            className={`flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-left text-xs ${
              activeKey === `pick:${o.id}` ? 'bg-violet-500/15' : 'hover:bg-white/5'
            }`}
          >
            <ProductThumb image={imageFor({ extSource: o.ext_source, extId: o.ext_id }, 'small')} alt={o.name} size="xs" />
            <span className="min-w-0 flex-1 truncate">{o.name}</span>
            {o.cedh_play_rate != null && o.cedh_play_rate >= 0.05 && (
              <span title="Share of cEDH tournament decks running it" className="shrink-0 text-[10px] text-sky-300/70">
                {Math.round(o.cedh_play_rate * 100)}%
              </span>
            )}
            <span className="w-10 shrink-0 text-right font-mono text-[10px] text-white/30">{shortCost(o.mana_cost)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onAdd(o) }}
              title="Add to deck"
              className="shrink-0 rounded border border-white/10 p-0.5 text-white/40 hover:border-violet-400/50 hover:bg-violet-500/20 hover:text-violet-200"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        ))}
        {pool.length === 0 && (
          <p className="px-1.5 py-2 text-[11px] text-white/35">
            {owned.length ? 'Nothing in your collection matches.' : 'Loading your collection…'}
          </p>
        )}
      </div>
    </div>
  )
}
