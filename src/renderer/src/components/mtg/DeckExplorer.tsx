/**
 * "What are people doing with this commander?" — real decks from EDHREC,
 * for every bracket, not just the cEDH tournament lists.
 *
 * Pick a commander from EDHREC's most-built list (or type any name), narrow
 * by bracket and theme, then open EDHREC's average deck or one person's list.
 * Either opens in the normal deck view, scored against the collection, and
 * can be saved to My decks.
 *
 * A deck's bracket is whatever its builder tagged, so most decks only show
 * under "Any". The bracket filter asks EDHREC for its bracket page instead of
 * filtering locally, which is why its counts don't add up to the total.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Compass, Crown, ExternalLink, Loader2, Search, Sparkles, X } from 'lucide-react'
import type { MtgExploreCommander, MtgExploreFilter, MtgExplorePage, MtgExploreRef } from '../../types'

const money = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

const BRACKETS: Array<{ n: number; label: string; hint: string }> = [
  { n: 1, label: 'Exhibition', hint: 'Bracket 1: themed, ultra-casual' },
  { n: 2, label: 'Core', hint: 'Bracket 2: precon level' },
  { n: 3, label: 'Upgraded', hint: 'Bracket 3: tuned, a few game changers' },
  { n: 4, label: 'Optimized', hint: 'Bracket 4: high power, no restrictions' },
  { n: 5, label: 'cEDH', hint: 'Bracket 5: competitive' }
]

type Sort = 'newest' | 'cheapest' | 'priciest' | 'salty' | 'chill'
const SORTS: Array<{ id: Sort; label: string }> = [
  { id: 'newest', label: 'Newest' },
  { id: 'cheapest', label: 'Cheapest' },
  { id: 'priciest', label: 'Priciest' },
  { id: 'chill', label: 'Least salty' },
  { id: 'salty', label: 'Saltiest' }
]

/** Everything the explorer needs to come back to where it was after a deck is opened. */
export interface ExplorerState {
  filter: MtgExploreFilter | null
  sort: Sort
  maxPrice: string
}
export const initialExplorerState: ExplorerState = { filter: null, sort: 'newest', maxPrice: '' }

const artUrl = (name: string): string =>
  `https://api.scryfall.com/cards/named?format=image&version=art_crop&exact=${encodeURIComponent(name.split(' // ')[0])}`

export default function DeckExplorer({
  state, onState, onOpen
}: {
  state: ExplorerState
  onState: (s: ExplorerState) => void
  onOpen: (ref: MtgExploreRef) => void
}): React.JSX.Element {
  return state.filter
    ? <CommanderDecks state={state} onState={onState} onOpen={onOpen} />
    : <CommanderPicker onPick={(names) => onState({ ...state, filter: { commanders: names, bracket: null, theme: null } })} />
}

// ---------------------------------------------------------------- picker

function CommanderPicker({ onPick }: { onPick: (names: string[]) => void }): React.JSX.Element {
  const [rows, setRows] = useState<MtgExploreCommander[] | null>(null)
  const [query, setQuery] = useState('')
  const [color, setColor] = useState('')
  const [hideOwned, setHideOwned] = useState(false)

  useEffect(() => { void window.atlis.mtg.exploreCommanders(600).then(setRows) }, [])

  const colors = useMemo(() => [...new Set((rows ?? []).map((r) => r.color_slug))].sort(), [rows])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (rows ?? []).filter((r) =>
      (!q || r.name.toLowerCase().includes(q)) &&
      (!color || r.color_slug === color) &&
      (!hideOwned || (!r.owned && !r.in_decks.length))
    ).slice(0, 150)
  }, [rows, query, color, hideOwned])

  // Anything typed can be explored, charting or not; "A + B" is a partner pair.
  const typed = query.split('+').map((s) => s.trim()).filter(Boolean)
  const exact = visible.some((r) => r.name.toLowerCase() === query.trim().toLowerCase())

  return (
    <div>
      <p className="mb-3 text-xs text-white/45">
        Real Commander decks from EDHREC at every power level. Pick a commander to see how people build it: themes,
        brackets, the average list, and individual decks.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/30" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && typed.length) onPick(visible.length === 1 ? [visible[0].name] : typed) }}
            placeholder="Any commander, e.g. Ms. Bumbleflower (A + B for partners)"
            className="w-full rounded-md border border-white/10 bg-white/[0.03] py-1.5 pl-8 pr-8 text-sm placeholder:text-white/25 focus:border-violet-400/50 focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <select
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="rounded-md border border-white/10 bg-[#15151c] px-2 py-1.5 text-xs text-white/70"
        >
          <option value="">All colours</option>
          {colors.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          onClick={() => setHideOwned((v) => !v)}
          title="Hide commanders you own or already have a deck for"
          className={`rounded border px-2 py-1 text-[11px] ${
            hideOwned ? 'border-violet-400/50 bg-violet-500/20 text-violet-200' : 'border-white/10 text-white/45 hover:bg-white/10'
          }`}
        >
          New to me
        </button>
      </div>

      {typed.length > 0 && !exact && (
        <button
          onClick={() => onPick(typed)}
          className="mb-2 flex w-full items-center gap-2 rounded-md border border-dashed border-violet-400/40 px-3 py-2 text-left text-sm text-violet-100 hover:bg-violet-500/10"
        >
          <Compass className="h-4 w-4" /> Explore “{typed.join(' + ')}” on EDHREC
        </button>
      )}

      {rows == null ? (
        <div className="flex items-center gap-2 text-sm text-white/50"><Loader2 className="h-4 w-4 animate-spin" /> Loading commanders…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-white/40">
          No commander popularity data yet. Run “Pull commander data” on the Commanders tab for a browsable list, or type
          a commander's name above.
        </p>
      ) : (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {visible.map((r) => (
            <button
              key={r.name}
              onClick={() => onPick([r.name])}
              className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-left hover:border-violet-400/40 hover:bg-white/[0.06]"
            >
              <Crown className="h-3.5 w-3.5 shrink-0 text-white/30" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{r.name}</div>
                <div className="truncate text-[11px] text-white/40">#{r.rank_in_color} {r.color_slug}</div>
              </div>
              {r.in_decks.length > 0 && (
                <span title={r.in_decks.join(', ')} className="shrink-0 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-200">in my decks</span>
              )}
              {r.owned && !r.in_decks.length && (
                <span className="shrink-0 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-200">owned</span>
              )}
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-white/55">{r.num_decks.toLocaleString()}</span>
            </button>
          ))}
          {visible.length === 0 && <p className="text-sm text-white/40">No charting commander matches. Use the Explore button above.</p>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- one commander

function CommanderDecks({
  state, onState, onOpen
}: {
  state: ExplorerState
  onState: (s: ExplorerState) => void
  onOpen: (ref: MtgExploreRef) => void
}): React.JSX.Element {
  const filter = state.filter as MtgExploreFilter
  const [page, setPage] = useState<MtgExplorePage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const setFilter = useCallback((f: Partial<MtgExploreFilter>) => onState({ ...state, filter: { ...filter, ...f } }), [state, filter, onState])

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    window.atlis.mtg.exploreCommander(filter)
      .then((p) => { if (live) setPage(p) })
      .catch((e) => { if (live) { setPage(null); setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [filter])

  const maxPrice = Number(state.maxPrice) || null
  const decks = useMemo(() => {
    const rows = (page?.decks ?? []).filter((d) => maxPrice == null || (d.price != null && d.price <= maxPrice))
    const by: Record<Sort, (a: typeof rows[number], b: typeof rows[number]) => number> = {
      newest: () => 0,
      cheapest: (a, b) => (a.price ?? 1e9) - (b.price ?? 1e9),
      priciest: (a, b) => (b.price ?? -1) - (a.price ?? -1),
      chill: (a, b) => (a.salt ?? 1e9) - (b.salt ?? 1e9),
      salty: (a, b) => (b.salt ?? -1) - (a.salt ?? -1)
    }
    return [...rows].sort(by[state.sort])
  }, [page, maxPrice, state.sort])

  const name = page?.commander ?? filter.commanders.join(' + ')
  const bracketLabel = BRACKETS.find((b) => b.n === filter.bracket)?.label
  const themeLabel = page?.themes.find((t) => t.slug === filter.theme)?.label ?? filter.theme

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <button
          onClick={() => onState({ ...state, filter: null })}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-white/50 hover:bg-white/10 hover:text-white/80"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Commanders
        </button>
        <img
          src={artUrl(filter.commanders[0])}
          alt=""
          className="h-10 w-14 shrink-0 rounded object-cover"
          onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{name}</h2>
          <div className="text-[11px] text-white/45">
            {page?.num_decks != null ? `${page.num_decks.toLocaleString()} decks on EDHREC` : loading ? 'Loading…' : ''}
            {page && (filter.bracket || filter.theme) ? ` · ${page.matching.toLocaleString()} ${[bracketLabel, themeLabel].filter(Boolean).join(' ')}` : ''}
          </div>
        </div>
        {page && (
          <a href={page.url} target="_blank" rel="noreferrer" title="Open on EDHREC"
            className="rounded border border-white/10 p-1.5 text-white/40 hover:bg-white/10 hover:text-white/80">
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[11px] uppercase tracking-wide text-white/35">Bracket</span>
        <Chip on={!filter.bracket} onClick={() => setFilter({ bracket: null })}>Any</Chip>
        {BRACKETS.map((b) => (
          <Chip key={b.n} on={filter.bracket === b.n} title={b.hint} onClick={() => setFilter({ bracket: filter.bracket === b.n ? null : b.n })}>
            {b.n} {b.label}
            {page?.bracket_counts[b.n] != null && <span className="ml-1 text-white/35">{page.bracket_counts[b.n].toLocaleString()}</span>}
          </Chip>
        ))}
      </div>

      {page && page.themes.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] uppercase tracking-wide text-white/35">Theme</span>
          {filter.theme && !page.themes.some((t) => t.slug === filter.theme) && (
            <Chip on onClick={() => setFilter({ theme: null })}>{filter.theme} ×</Chip>
          )}
          {page.themes.map((t) => (
            <Chip key={t.slug} on={filter.theme === t.slug} onClick={() => setFilter({ theme: filter.theme === t.slug ? null : t.slug })}>
              {t.label}<span className="ml-1 text-white/35">{t.count.toLocaleString()}</span>
            </Chip>
          ))}
        </div>
      )}

      {error ? (
        <p className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">{error}</p>
      ) : loading && !page ? (
        <div className="flex items-center gap-2 text-sm text-white/50"><Loader2 className="h-4 w-4 animate-spin" /> Asking EDHREC…</div>
      ) : page && (
        <>
          <button
            onClick={() => onOpen({ kind: 'average', ...filter })}
            className="mb-3 flex w-full items-center gap-3 rounded-md border border-violet-400/40 bg-violet-500/10 px-3 py-2.5 text-left hover:bg-violet-500/20"
          >
            <Sparkles className="h-4 w-4 shrink-0 text-violet-200" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-violet-100">Average deck{[bracketLabel, themeLabel].filter(Boolean).length ? `: ${[bracketLabel, themeLabel].filter(Boolean).join(' ')}` : ''}</div>
              <div className="text-[11px] text-white/45">EDHREC's consensus list for this filter, checked against your collection</div>
            </div>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-white/40" />}
          </button>

          {page.similar.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1">
              <span className="mr-1 text-[11px] uppercase tracking-wide text-white/35">Similar</span>
              {page.similar.map((s) => (
                <Chip key={s} on={false} onClick={() => onState({ ...state, filter: { commanders: [s], bracket: filter.bracket, theme: null } })}>{s}</Chip>
              ))}
            </div>
          )}

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-white/40">
              Decks <span className="font-normal normal-case text-white/30">· newest {page.decks.length} of {page.matching.toLocaleString()}</span>
            </h3>
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-1 text-[11px] text-white/45">
                Max $
                <input
                  value={state.maxPrice}
                  onChange={(e) => onState({ ...state, maxPrice: e.target.value.replace(/[^0-9]/g, '') })}
                  placeholder="any"
                  className="w-16 rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-xs"
                />
              </label>
              <select
                value={state.sort}
                onChange={(e) => onState({ ...state, sort: e.target.value as Sort })}
                className="rounded border border-white/10 bg-[#15151c] px-1.5 py-0.5 text-xs text-white/70"
              >
                {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            {decks.map((d) => (
              <button
                key={d.hash}
                onClick={() => onOpen({ kind: 'user', hash: d.hash })}
                className="flex w-full items-center gap-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-left hover:border-violet-400/40 hover:bg-white/[0.06]"
              >
                <span className="w-20 shrink-0 text-[11px] tabular-nums text-white/40">{d.saved ?? '—'}</span>
                <span className="w-20 shrink-0 text-[11px] text-white/55">
                  {d.bracket ? `B${d.bracket} ${BRACKETS.find((b) => b.n === d.bracket)?.label ?? ''}` : <span className="text-white/25">no bracket</span>}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-white/75">
                  {d.tags.length ? d.tags.join(' · ') : <span className="text-white/30">untagged</span>}
                </span>
                <span title="EDHREC salt score: how much the list's cards annoy opponents" className="w-14 shrink-0 text-right text-[11px] tabular-nums text-white/40">
                  {d.salt != null ? `salt ${Math.round(d.salt)}` : ''}
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums">{money(d.price)}</span>
              </button>
            ))}
            {decks.length === 0 && <p className="text-sm text-white/40">No deck matches that price cap.</p>}
          </div>
          <p className="mt-3 text-[11px] text-white/30">
            Deck index and average decks from EDHREC. Prices are EDHREC's estimates. Salt sums how much the deck's cards
            annoy opponents, by EDHREC's community vote.
          </p>
        </>
      )}
    </div>
  )
}

function Chip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded border px-2 py-0.5 text-[11px] ${
        on ? 'border-violet-400/50 bg-violet-500/20 text-violet-200' : 'border-white/10 text-white/50 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  )
}
