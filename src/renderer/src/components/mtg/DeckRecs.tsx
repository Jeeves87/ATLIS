/**
 * EDHREC-backed panels for a saved deck: the commander's combos measured
 * against the deck and the collection, recommended upgrades split into
 * "already own" and "worth buying", and the cross-deck shopping list.
 *
 * Rows follow the card picker's rule: clicking a row previews the card, and
 * only an explicit + button changes the deck.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, Copy, ExternalLink, Loader2, Minus, Plus, RefreshCw, Scissors, ShoppingCart, Sparkles, X } from 'lucide-react'
import type { MtgCombo, MtgCut, MtgDeckRecs, MtgShoppingItem, MtgUpgrade } from '../../types'

const money = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 1000 ? 0 : 2 })
const pct = (x: number): string => `${Math.round(x * 100)}%`

export interface PreviewCard { name: string; ext_id: string | null }

const PRICE_CAPS = [
  [0, 'Any price'], [1, 'Under $1'], [5, 'Under $5'], [20, 'Under $20'], [50, 'Under $50']
] as const

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-[11px] ${
        on ? 'border-violet-400/50 bg-violet-500/20 text-violet-200' : 'border-white/10 text-white/45 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  )
}

function AddButton({ onClick, title = 'Add to deck' }: { onClick: () => void; title?: string }): React.JSX.Element {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={title}
      className="shrink-0 rounded border border-white/10 p-0.5 text-white/40 hover:border-violet-400/50 hover:bg-violet-500/20 hover:text-violet-200"
    >
      <Plus className="h-3 w-3" />
    </button>
  )
}

/** Loads a deck's recommendations once per deck revision. */
export function useDeckRecs(deckId: string | null, revision: number, enabled: boolean): {
  recs: MtgDeckRecs | null
  loading: boolean
  error: string | null
} {
  const [recs, setRecs] = useState<MtgDeckRecs | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!deckId || !enabled) return
    let live = true
    setLoading(true)
    window.atlis.mtg.deckRecs(deckId)
      .then((r) => { if (live) { setRecs(r); setError(null) } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [deckId, revision, enabled])
  return { recs, loading, error }
}

export function RecsState({ recs, loading, error }: { recs: MtgDeckRecs | null; loading: boolean; error: string | null }): React.JSX.Element | null {
  if (loading && !recs) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-white/50">
        <Loader2 className="h-4 w-4 animate-spin" /> Asking EDHREC about this commander…
      </div>
    )
  }
  if (error) return <p className="py-4 text-sm text-red-300/80">{error}</p>
  if (recs?.note) return <p className="py-4 text-sm text-white/40">{recs.note}</p>
  return null
}

// ---------------------------------------------------------------- combos

type ComboFilter = 'all' | 'in_deck' | 'ready' | 'one'

export function CombosPanel({
  recs, activeName, onPreview, onAddMany
}: {
  recs: MtgDeckRecs
  activeName: string | null
  onPreview: (c: PreviewCard) => void
  onAddMany: (cards: PreviewCard[]) => void
}): React.JSX.Element {
  const [filter, setFilter] = useState<ComboFilter>('all')
  const counts = useMemo(() => ({
    in_deck: recs.combos.filter((c) => c.status === 'in_deck').length,
    ready: recs.combos.filter((c) => c.status === 'ready').length,
    one: recs.combos.filter((c) => c.status === 'missing' && c.missing_count === 1).length
  }), [recs])
  const shown = recs.combos.filter((c) =>
    filter === 'all' ? true : filter === 'one' ? c.status === 'missing' && c.missing_count === 1 : c.status === filter)

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Chip on={filter === 'all'} onClick={() => setFilter('all')}>All {recs.combos.length}</Chip>
        <Chip on={filter === 'in_deck'} onClick={() => setFilter('in_deck')}>In deck {counts.in_deck}</Chip>
        <Chip on={filter === 'ready'} onClick={() => setFilter('ready')}>Own every piece {counts.ready}</Chip>
        <Chip on={filter === 'one'} onClick={() => setFilter('one')}>One card away {counts.one}</Chip>
        {recs.edhrec_url && (
          <a href={`${recs.edhrec_url.replace('/commanders/', '/combos/')}`} target="_blank" rel="noreferrer"
            className="ml-auto flex items-center gap-1 text-[11px] text-white/40 hover:text-white/70">
            EDHREC combos <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <div className="space-y-1.5">
        {shown.map((c) => (
          <ComboRow key={c.id} combo={c} activeName={activeName} onPreview={onPreview} onAddMany={onAddMany} />
        ))}
        {shown.length === 0 && <p className="text-sm text-white/40">No combos in that group.</p>}
      </div>
      <p className="mt-3 text-[11px] text-white/30">
        EDHREC’s combos for {recs.commanders.join(' + ')}, most-played first. Green is in the deck, amber is in your
        collection, red needs buying.
      </p>
    </div>
  )
}

const STATUS: Record<MtgCombo['status'], { label: string; cls: string }> = {
  in_deck: { label: 'In deck', cls: 'bg-emerald-500/20 text-emerald-200' },
  ready: { label: 'Own all', cls: 'bg-amber-500/20 text-amber-100' },
  missing: { label: 'Missing', cls: 'bg-white/10 text-white/50' }
}

function ComboRow({
  combo: c, activeName, onPreview, onAddMany
}: {
  combo: MtgCombo
  activeName: string | null
  onPreview: (c: PreviewCard) => void
  onAddMany: (cards: PreviewCard[]) => void
}): React.JSX.Element {
  const ownedOut = c.pieces.filter((p) => !p.in_deck && p.owned)
  const st = STATUS[c.status]
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        {c.pieces.map((p) => (
          <button
            key={p.name}
            onClick={() => onPreview({ name: p.name, ext_id: p.ext_id })}
            title={p.in_deck ? 'In this deck' : p.owned ? 'In your collection' : `Not owned · ${money(p.price)}`}
            className={`rounded px-1.5 py-0.5 text-xs ${activeName === p.name ? 'ring-1 ring-violet-400/60' : ''} ${
              p.in_deck ? 'bg-emerald-500/15 text-emerald-200' : p.owned ? 'bg-amber-500/15 text-amber-100' : 'bg-red-500/15 text-red-200'
            }`}
          >
            {p.name}
          </button>
        ))}
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${st.cls}`}>
          {c.status === 'missing' ? `${c.missing_count} to buy · ${money(c.missing_cost)}` : st.label}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-white/40">
        <span className="min-w-0 flex-1 truncate" title={c.results.join(' · ')}>{c.results.slice(0, 3).join(' · ')}</span>
        <span className="shrink-0 tabular-nums">{c.decks.toLocaleString()} decks</span>
        {ownedOut.length > 0 && (
          <button
            onClick={() => onAddMany(ownedOut.map((p) => ({ name: p.name, ext_id: p.ext_id })))}
            className="flex shrink-0 items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-white/60 hover:border-violet-400/50 hover:bg-violet-500/20 hover:text-violet-200"
          >
            <Plus className="h-3 w-3" /> Add {ownedOut.length} owned
          </button>
        )}
        <a href={c.url} target="_blank" rel="noreferrer" title="Open on EDHREC" className="shrink-0 text-white/30 hover:text-white/70">
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- upgrades

type BuySort = 'fit' | 'value' | 'cheap'

function reasons(u: MtgUpgrade): string {
  const r: string[] = []
  if (u.inclusion > 0) r.push(`in ${pct(u.inclusion)} of decks`)
  if (u.synergy >= 0.1) r.push(`+${pct(u.synergy)} synergy`)
  if (u.completes) r.push(`finishes ${u.completes} combo${u.completes > 1 ? 's' : ''}`)
  else if (u.combos) r.push(`piece of ${u.combos} combo${u.combos > 1 ? 's' : ''}`)
  return r.join(' · ')
}

function UpgradeRow({
  u, active, onPreview, onAdd
}: { u: MtgUpgrade; active: boolean; onPreview: () => void; onAdd: () => void }): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPreview}
      onKeyDown={(e) => { if (e.key === 'Enter') onPreview() }}
      className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm ${active ? 'bg-violet-500/10' : 'hover:bg-white/[0.03]'}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate">{u.name}</span>
          {u.completes > 0 && <Sparkles className="h-3 w-3 shrink-0 text-amber-300" />}
        </div>
        <div className="truncate text-[11px] text-white/40">
          {u.category ? `${u.category} · ` : ''}{reasons(u)}
        </div>
      </div>
      {!u.owned && <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-amber-200/80">{money(u.price)}</span>}
      <AddButton onClick={onAdd} title={u.owned ? 'Add to deck' : 'Add to deck (shows as missing until bought)'} />
    </div>
  )
}

function cutReason(c: MtgCut): string {
  if (c.unlisted) return 'not among EDHREC’s top cards for this commander'
  const r = [`in ${pct(c.inclusion)} of decks`]
  if (c.synergy != null) r.push(`${c.synergy >= 0 ? '+' : '−'}${pct(Math.abs(c.synergy))} synergy`)
  return r.join(' · ')
}

function CutRow({
  c, active, onPreview, onRemove
}: { c: MtgCut; active: boolean; onPreview: () => void; onRemove: () => void }): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPreview}
      onKeyDown={(e) => { if (e.key === 'Enter') onPreview() }}
      className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm ${active ? 'bg-violet-500/10' : 'hover:bg-white/[0.03]'}`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate">{c.name}</div>
        <div className="truncate text-[11px] text-white/40">{c.type_group} · {cutReason(c)}</div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        title="Cut from deck (stays in your collection)"
        className="shrink-0 rounded border border-white/10 p-0.5 text-white/40 hover:border-red-400/50 hover:bg-red-500/20 hover:text-red-200"
      >
        <Minus className="h-3 w-3" />
      </button>
    </div>
  )
}

export function UpgradesPanel({
  recs, activeName, onPreview, onAdd, onRemove, onSwap, onStatus
}: {
  recs: MtgDeckRecs
  activeName: string | null
  onPreview: (c: PreviewCard) => void
  onAdd: (c: PreviewCard) => void
  onRemove: (name: string) => void
  onSwap: (cut: string, add: PreviewCard) => void
  onStatus: (s: string | null) => void
}): React.JSX.Element {
  const [sort, setSort] = useState<BuySort>('fit')
  const [cap, setCap] = useState(0)

  const buys = useMemo(() => {
    const list = recs.buys.filter((b) => !cap || (b.price != null && b.price <= cap))
    if (sort === 'cheap') return [...list].sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9))
    if (sort === 'value') return [...list].sort((a, b) => b.score / Math.max(0.25, b.price ?? 1e9) - a.score / Math.max(0.25, a.price ?? 1e9))
    return list
  }, [recs, sort, cap])
  const top = buys.slice(0, 40)
  const total = top.slice(0, 15).reduce((s, b) => s + (b.price ?? 0), 0)

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(top.slice(0, 15).map((b) => `1 ${b.name}`).join('\n'))
    onStatus(`Copied the top ${Math.min(15, top.length)} buys (${money(total)}) — paste into TCGplayer’s Mass Entry.`)
  }

  return (
    <div className="space-y-5">
      {recs.swaps.length > 0 && (
        <section>
          <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-violet-200/80">
            <ArrowRight className="h-3 w-3" /> Suggested swaps — from your collection
          </h3>
          <div className="divide-y divide-white/5 rounded-md border border-white/10 bg-white/[0.02]">
            {recs.swaps.map(({ cut, add }) => (
              <div key={cut.name} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                <button onClick={() => onPreview({ name: cut.name, ext_id: cut.ext_id })}
                  className={`min-w-0 flex-1 text-left ${activeName === cut.name ? 'text-violet-200' : ''}`}>
                  <div className="truncate text-red-200/90">− {cut.name}</div>
                  <div className="truncate text-[11px] text-white/35">{cutReason(cut)}</div>
                </button>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-white/30" />
                <button onClick={() => onPreview({ name: add.name, ext_id: add.ext_id })}
                  className={`min-w-0 flex-1 text-left ${activeName === add.name ? 'text-violet-200' : ''}`}>
                  <div className="truncate text-emerald-200/90">+ {add.name}</div>
                  <div className="truncate text-[11px] text-white/35">{reasons(add)}</div>
                </button>
                <button
                  onClick={() => onSwap(cut.name, { name: add.name, ext_id: add.ext_id })}
                  className="shrink-0 rounded border border-white/10 px-2 py-0.5 text-[11px] text-white/60 hover:border-violet-400/50 hover:bg-violet-500/20 hover:text-violet-200"
                >
                  Swap
                </button>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-white/30">Each pairs a card you own with the weakest card of the same type, so the curve and land count hold.</p>
        </section>
      )}

      <section>
        <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-red-200/70">
          <Scissors className="h-3 w-3" /> Weakest cards in this deck — cut candidates
        </h3>
        {recs.cuts.length ? (
          <div className="max-h-[320px] divide-y divide-white/5 overflow-y-auto rounded-md border border-white/10 bg-white/[0.02]">
            {recs.cuts.slice(0, 20).map((c) => (
              <CutRow key={c.name} c={c} active={activeName === c.name}
                onPreview={() => onPreview({ name: c.name, ext_id: c.ext_id })}
                onRemove={() => onRemove(c.name)} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-white/40">Nothing in the 99 to judge yet.</p>
        )}
        <p className="mt-1 text-[11px] text-white/30">
          Ranked by how rarely EDHREC’s decks for this commander play each card. Basic lands, the commander and
          pieces of combos you can assemble are never suggested.
        </p>
      </section>

      <section>
        <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-emerald-200/70">
          <Check className="h-3 w-3" /> Already in your collection — free upgrades
        </h3>
        {recs.owned_adds.length ? (
          <div className="divide-y divide-white/5 rounded-md border border-white/10 bg-white/[0.02]">
            {recs.owned_adds.slice(0, 25).map((u) => (
              <UpgradeRow key={u.name} u={u} active={activeName === u.name}
                onPreview={() => onPreview({ name: u.name, ext_id: u.ext_id })}
                onAdd={() => onAdd({ name: u.name, ext_id: u.ext_id })} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-white/40">Nothing EDHREC recommends for this commander is sitting unused in your collection.</p>
        )}
      </section>

      <section>
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <h3 className="mr-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-200/70">
            <ShoppingCart className="h-3 w-3" /> Worth buying
          </h3>
          <Chip on={sort === 'fit'} onClick={() => setSort('fit')}>Best fit</Chip>
          <Chip on={sort === 'value'} onClick={() => setSort('value')}>Best value</Chip>
          <Chip on={sort === 'cheap'} onClick={() => setSort('cheap')}>Cheapest</Chip>
          <select
            value={cap}
            onChange={(e) => setCap(Number(e.target.value))}
            className="rounded border border-white/10 bg-[#16161d] px-1.5 py-0.5 text-[11px] text-white/60"
          >
            {PRICE_CAPS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <button onClick={() => void copy()} disabled={!top.length}
            className="ml-auto flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-40">
            <Copy className="h-3 w-3" /> Copy top 15 · {money(total)}
          </button>
        </div>
        <div className="divide-y divide-white/5 rounded-md border border-white/10 bg-white/[0.02]">
          {top.map((u) => (
            <UpgradeRow key={u.name} u={u} active={activeName === u.name}
              onPreview={() => onPreview({ name: u.name, ext_id: u.ext_id })}
              onAdd={() => onAdd({ name: u.name, ext_id: u.ext_id })} />
          ))}
          {top.length === 0 && <p className="px-2 py-3 text-sm text-white/40">Nothing under that price.</p>}
        </div>
        <p className="mt-2 text-[11px] text-white/30">
          Ranked from EDHREC{recs.edhrec_decks ? ` (${recs.edhrec_decks.toLocaleString()} decks)` : ''}: how often the
          card is played with this commander, how much more than in other decks (synergy), and how many combos it moves
          closer — <Sparkles className="inline h-3 w-3 text-amber-300" /> means it finishes one with cards you own.
        </p>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------- shopping list

export function ShoppingList({ onOpenDeck, onStatus }: { onOpenDeck: (id: string) => void; onStatus: (s: string | null) => void }): React.JSX.Element {
  const [data, setData] = useState<{ items: MtgShoppingItem[]; decks: number; skipped: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [cap, setCap] = useState(0)
  const [open, setOpen] = useState(false)

  const load = async (): Promise<void> => {
    setBusy(true)
    onStatus('Asking EDHREC about every deck’s commander…')
    try {
      const r = await window.atlis.mtg.shoppingList()
      setData(r)
      onStatus(`Shopping list built from ${r.decks} deck(s).${r.skipped.length ? ` Skipped (no commander / no EDHREC page): ${r.skipped.join(', ')}.` : ''}`)
    } catch (e) {
      onStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const items = (data?.items ?? []).filter((i) => !cap || (i.price != null && i.price <= cap)).slice(0, 50)
  const total = items.slice(0, 20).reduce((s, i) => s + (i.price ?? 0), 0)

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); if (!data) void load() }}
        className="mb-4 flex w-full items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-sm text-white/70 hover:border-violet-400/30"
      >
        <ShoppingCart className="h-4 w-4 text-amber-300" />
        Upgrade shopping list
        <span className="text-[11px] text-white/35">— the cards that would improve the most decks at once</span>
      </button>
    )
  }

  return (
    <div className="mb-4 rounded-md border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-200/70">
          <ShoppingCart className="h-3 w-3" /> Upgrade shopping list
        </h3>
        <select value={cap} onChange={(e) => setCap(Number(e.target.value))}
          className="rounded border border-white/10 bg-[#16161d] px-1.5 py-0.5 text-[11px] text-white/60">
          {PRICE_CAPS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <button onClick={() => void load()} disabled={busy}
          className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-50">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Rebuild
        </button>
        <button
          onClick={() => void navigator.clipboard.writeText(items.slice(0, 20).map((i) => `1 ${i.name}`).join('\n'))
            .then(() => onStatus(`Copied the top ${Math.min(20, items.length)} (${money(total)}).`))}
          disabled={!items.length}
          className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-white/50 hover:bg-white/10 disabled:opacity-40"
        >
          <Copy className="h-3 w-3" /> Copy top 20 · {money(total)}
        </button>
        <button onClick={() => setOpen(false)} className="ml-auto text-white/30 hover:text-white/70"><X className="h-3.5 w-3.5" /></button>
      </div>
      {busy && !data ? (
        <div className="flex items-center gap-2 py-3 text-sm text-white/50"><Loader2 className="h-4 w-4 animate-spin" /> Building…</div>
      ) : (
        <div className="max-h-[360px] divide-y divide-white/5 overflow-y-auto rounded border border-white/5">
          {items.map((i) => (
            <div key={i.name} className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {i.name}
                {i.completes > 0 && <Sparkles className="ml-1 inline h-3 w-3 text-amber-300" />}
              </span>
              <span className="flex min-w-0 shrink flex-wrap justify-end gap-1">
                {i.decks.map((d) => (
                  <button key={d.id} onClick={() => onOpenDeck(d.id)}
                    className="max-w-[160px] truncate rounded bg-white/5 px-1.5 text-[10px] text-white/50 hover:bg-violet-500/20 hover:text-violet-200">
                    {d.name}
                  </button>
                ))}
              </span>
              <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-amber-200/80">{money(i.price)}</span>
            </div>
          ))}
          {items.length === 0 && <p className="px-2 py-3 text-sm text-white/40">Nothing to suggest at that price.</p>}
        </div>
      )}
    </div>
  )
}
