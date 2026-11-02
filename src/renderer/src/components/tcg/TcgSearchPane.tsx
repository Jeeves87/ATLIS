import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Loader2, Search } from 'lucide-react'
import TcgLightbox from './TcgLightbox'
import TcgSetView from './TcgSetView'
import TcgTile from './TcgTile'
import { clean, type Tone } from './tcgUi'
import type { TcgGame, TcgPrinting, TcgProduct, TcgSet, TcgSetProducts } from '../../types'

/**
 * The Magic page's Search tab when another game is picked. Laid out like the
 * Magic search on purpose — Cards / Sealed / Set, a grid of full pictures,
 * click-to-enlarge — so switching games changes the catalogue, not the page.
 */

type Mode = 'cards' | 'sealed' | 'set'
const SET_CHIP_LIMIT = 40

export default function TcgSearchPane({ game, onChanged }: { game: TcgGame; onChanged: () => Promise<void> | void }) {
  const [mode, setMode] = useState<Mode>('cards')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TcgProduct[]>([])
  const [searching, setSearching] = useState(false)
  const [watched, setWatched] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState<string | null>(null)
  const [msg, setMsg] = useState<Tone | null>(null)
  const [preview, setPreview] = useState<TcgProduct | null>(null)
  // Set mode: the game's set list (fetched once per game), and the open set.
  const [sets, setSets] = useState<TcgSet[] | null>(null)
  const [openSet, setOpenSet] = useState<TcgSet | null>(null)
  const [setData, setSetData] = useState<TcgSetProducts | null>(null)

  const loadWatched = useCallback(async () => {
    const ws = await window.atlis.tcg.watches(game.url)
    setWatched(new Set(ws.map((w) => `${w.product_id}:${w.printing}`)))
  }, [game.url])

  useEffect(() => {
    void loadWatched()
    return window.atlis.tcg.onChanged(() => void loadWatched())
  }, [loadWatched])

  // A different game is a different catalogue; keeping anything from the old one would mislead.
  useEffect(() => {
    setResults([])
    setMsg(null)
    setPreview(null)
    setSets(null)
    setOpenSet(null)
    setSetData(null)
  }, [game.url])

  useEffect(() => {
    if (mode !== 'set' || sets) return
    let live = true
    window.atlis.tcg.sets(game.url).then(
      (s) => live && setSets(s),
      (e) => live && setMsg({ tone: 'bad', text: clean(e) })
    )
    return () => {
      live = false
    }
  }, [mode, sets, game.url])

  const matchingSets = useMemo(() => {
    const f = query.trim().toLowerCase()
    return (sets ?? []).filter((s) => !f || s.name.toLowerCase().includes(f) || s.url.includes(f))
  }, [sets, query])

  async function openTheSet(s: TcgSet): Promise<void> {
    setOpenSet(s)
    setSetData(null)
    setSearching(true)
    setMsg(null)
    try {
      setSetData(await window.atlis.tcg.set(game.url, s.url))
    } catch (err) {
      setMsg({ tone: 'bad', text: clean(err) })
    } finally {
      setSearching(false)
    }
  }

  async function runSearch(e?: FormEvent): Promise<void> {
    e?.preventDefault()
    if (mode === 'set') {
      // Enter opens the best match — the only one, or the first (largest) of several.
      const pick = matchingSets[0]
      if (pick) await openTheSet(pick)
      else if (sets) setMsg({ tone: 'bad', text: `No ${game.label} set matches "${query.trim()}".` })
      return
    }
    if (query.trim().length < 2) return
    setSearching(true)
    setMsg(null)
    try {
      const r = await window.atlis.tcg.search({ q: query, game: game.url, type: mode })
      setResults(r)
      if (!r.length) setMsg({ tone: 'bad', text: `No ${mode} in ${game.label} matched "${query.trim()}".` })
    } catch (err) {
      setMsg({ tone: 'bad', text: clean(err) })
    } finally {
      setSearching(false)
    }
  }

  async function track(p: TcgProduct, printing: TcgPrinting): Promise<void> {
    const w = await window.atlis.tcg.add({
      productId: p.productId,
      printing,
      game: game.url,
      gameLabel: p.gameLabel,
      kind: p.sealed ? 'sealed' : 'card',
      name: p.name,
      set: p.set,
      rarity: p.rarity
    })
    setMsg({ tone: 'ok', text: `Tracking ${w.name}${printing === 'Foil' && !p.sealed ? ' (foil)' : ''}.` })
    await loadWatched()
    await onChanged()
  }

  async function trackFromGrid(p: TcgProduct, printing: TcgPrinting): Promise<void> {
    setAdding(`${p.productId}:${printing}`)
    try {
      await track(p, printing)
    } catch (err) {
      setMsg({ tone: 'bad', text: clean(err) })
    } finally {
      setAdding(null)
    }
  }

  /** Sealed "I own this" — one copy into the Vault, listed and priced on the Owned tab. */
  async function own(p: TcgProduct): Promise<void> {
    setAdding(`own:${p.productId}`)
    try {
      const item = await window.atlis.tcg.ownSealed({
        productId: p.productId,
        game: game.url,
        gameLabel: game.label,
        name: p.name,
        set: p.set
      })
      setMsg({
        tone: 'ok',
        text: `${item.name} added to Owned${item.price != null ? ` at $${item.price.toFixed(2)}` : ' — no TCGplayer price yet, the daily refresh will retry'}.`
      })
    } catch (err) {
      setMsg({ tone: 'bad', text: clean(err) })
    } finally {
      setAdding(null)
    }
  }

  const placeholder =
    mode === 'set'
      ? `A ${game.label} set${sets?.[0] ? ` — e.g. ${sets[0].name}` : ''}`
      : mode === 'sealed'
        ? `${game.label} product — e.g. booster box, booster pack, trial deck`
        : `${game.label} card name — or just "${game.label.toLowerCase()}" to browse`

  return (
    <>
      <form onSubmit={(e) => void runSearch(e)} className="mb-5 flex gap-2">
        <div className="flex shrink-0 overflow-hidden rounded-md border border-white/10">
          {(['cards', 'sealed', 'set'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m)
                setMsg(null)
              }}
              className={`px-3 py-2 text-xs capitalize ${mode === m ? 'bg-violet-500/80 font-medium' : 'text-white/50 hover:bg-white/5'}`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-md border border-white/10 bg-black/20 py-2 pl-9 pr-3 text-sm outline-none focus:border-violet-400/50"
          />
        </div>
        <button
          type="submit"
          disabled={searching || (mode !== 'set' && query.trim().length < 2)}
          className="rounded-md bg-violet-500/80 px-3 py-2 text-sm font-medium hover:bg-violet-500 disabled:opacity-50"
        >
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === 'set' ? 'Open' : 'Search'}
        </button>
      </form>

      {msg && <p className={`mb-3 text-xs ${msg.tone === 'ok' ? 'text-emerald-300' : 'text-rose-300'}`}>{msg.text}</p>}

      {mode === 'set' && (
        <div className="mb-4">
          {sets == null ? (
            <p className="flex items-center gap-2 text-xs text-white/40">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading {game.label} sets…
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {matchingSets.slice(0, SET_CHIP_LIMIT).map((s) => (
                <button
                  key={s.url}
                  onClick={() => void openTheSet(s)}
                  className={`rounded-md border px-2 py-1 text-[11px] ${
                    openSet?.url === s.url
                      ? 'border-violet-400/50 bg-violet-500/20 text-violet-100'
                      : 'border-white/10 text-white/60 hover:bg-white/5 hover:text-white/85'
                  }`}
                >
                  {s.name} <span className="text-white/35">{s.count}</span>
                </button>
              ))}
              {matchingSets.length > SET_CHIP_LIMIT && (
                <span className="self-center text-[11px] text-white/35">
                  +{matchingSets.length - SET_CHIP_LIMIT} more — type to narrow
                </span>
              )}
              {!matchingSets.length && <span className="text-[11px] text-white/40">No set matches that.</span>}
            </div>
          )}
        </div>
      )}

      {mode === 'set' && openSet && !setData && searching && (
        <p className="flex items-center gap-2 text-xs text-white/40">
          <Loader2 className="h-3 w-3 animate-spin" /> Pricing every card in {openSet.name}…
        </p>
      )}

      {mode === 'set' && openSet && setData && (
        <TcgSetView
          set={openSet}
          data={setData}
          watched={watched}
          adding={adding}
          onPreview={setPreview}
          onTrack={(p, pr) => void trackFromGrid(p, pr)}
          onOwn={(p) => void own(p)}
        />
      )}

      {mode !== 'set' && results.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">
            {game.label} {mode} ({results.length})
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {results.map((p) => (
              <TcgTile
                key={p.productId}
                p={p}
                watched={watched}
                adding={adding}
                onPreview={() => setPreview(p)}
                onTrack={(pr) => void trackFromGrid(p, pr)}
                onOwn={() => void own(p)}
              />
            ))}
          </div>
        </section>
      )}

      {preview && (
        <TcgLightbox
          product={preview}
          game={game}
          watched={watched}
          onTrack={(pr) => track(preview, pr)}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  )
}
