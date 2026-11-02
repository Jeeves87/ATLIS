# Watchlist by lifecycle — Hunt vs Market

Status: build steps 1–3 done (2026-10-04), plus the MSRP ladder and Owned period
moves. The Sets tab is built (`components/mtg/SetsTab.tsx`, `mtg.setFamilies` /
`mtg.familyProducts`); Releases has not been retired yet. Steps 4–5 are still proposals. Builds on `availability-tracking.md`, which
covers the engine underneath the Hunt side.

Decisions made 2026-10-04:
- **One print window for everything (12 months)**, Commander decks included. The real
  lifecycle isn't known yet, so it's a setting, not a rule.
- **No generic dip flag. Use an MSRP ladder instead:** Below MSRP / At MSRP (±2%) /
  Near MSRP (≤ +25% over list *and* ≥ 20% under market) / Over. Implemented in
  `lifecycle.msrpBand`. MSRP is manual, or inferred from the lowest Best Buy/Target price seen.
- **Local stock means a confirmed order only:** within ~30 min drive (25 mi). An
  in-store-only / CHECK_STORES state no longer pings, because it's a "go browse"
  signal. Local pings wait for a per-store adapter (Best Buy API key needed).

## The problem

The Magic watchlist treats every row the same way. A 2021 Collector Box and a
Collector Box with preorders opening next month both get a daily price check
**and** a retail stock sweep. They need opposite things:

- Most old products will never be at retail again. Polling Best Buy for them is
  wasted effort and adds noise.
- Current products need much more than one check a day: preorder opens, restocks,
  local store stock, LGS drops.

The other problem: the pages are split by **data source**, not by **what I'm
trying to do**. Drops is Shopify/Wix, Magic is
Scryfall/MTGJSON/retail, and Secret Lair, preorders, deals and EV each got their
own panel. The result is "checking websites in different pages in different ways".

## The fix: two modes, and a set-first catalogue

Every watched thing is in exactly one **mode**:

| | **Hunt** | **Market** |
|---|---|---|
| Question it answers | Where and when can I buy this at MSRP? | What is this worth, and is it trending? |
| Who's in it | Unreleased or recently released sealed product, reprintable Commander decks, Secret Lair windows | Out-of-print sealed (old boxes), individual cards |
| Cadence | Tiered: 30 s in a drop window, 2–15 min when hot, 15–60 min otherwise | Once a day (the existing price sweep). Nothing faster. |
| Sources | Best Buy, Target, Amazon, Walmart, GameStop, LGS Shopify/Wix, Secret Lair store, preorder calendar | TCGplayer market, MTGJSON history |
| Pings | Preorder live, restock, local stock, drop live, below-market (Discord buy-now lane) | Only for a target price or a dip. Mostly a weekly digest. |
| UI feel | Live board with per-retailer status chips and countdowns | Finance page: sparklines, 30/90/365-day change, % off high |

### Mode is derived, with a manual override

Nobody should have to sort rows by hand. Default rule for sealed:

- **Hunt** if the set is unreleased, **or** it released within the in-print window
  (default 12 months, configurable), **or** a first-party retailer listed it at
  ≤ MSRP × 1.15 in the last 60 days.
- **Market** otherwise.
- Cards are always **Market**. The exception is Secret Lair, which is sold as a drop.

`mtg_sets.released_at` + `set_type` provide the first two rules, and `mtg_listings`
provides the third. The override is a `mode_pinned` flag on the row.

### Reprint tripwire (how a Market item gets back to Hunt)

Market items are never polled at retail. Instead, a cheap daily check looks for:

1. **A new catalogue product with the same identity.** The MTGJSON sync turns up a
   new sealed product whose normalised name matches a Market watch (Commander
   deck reprints usually ship under the same name, in a new set code or a new
   release date).
2. **A sharp market drop.** TCGplayer market down ≥ 25% over 14 days on a sealed
   product. That's usually a reprint announcement or new supply.
3. **An incidental retail sighting.** A first-party listing at ≤ MSRP × 1.15 found
   by any sweep (preorder discovery, LGS feeds).

Any of these flips the row to Hunt (unless it's pinned) and sends a heads-up:
"*Fallout – Mutant Menace* looks like it's being reprinted. Now hunting."

## UI: one Magic page, organised by intent

```
Magic
 ├─ Sets      browse: every set → expand → all its products   (replaces Releases + sealed/set search)
 ├─ Hunt      live board: what's buyable / opening / restocking (absorbs Deals, Preorders, SL upcoming)
 ├─ Market    finance-style: old sealed + cards, daily           (what the price half of Watchlist was)
 ├─ Owned     unchanged
 ├─ EV        unchanged
 ├─ Commanders unchanged
 └─ Search    card search (sealed/set search moves to Sets)
```

### Sets tab

- Sets newest first, grouped by parent (HOB + HOC + tokens = one row). Filters:
  upcoming / in print / out of print / followed.
- Each row: icon, name, release date or countdown, lifecycle badge, how many
  products are watched, and a market index (sum of watched sealed).
- **Expand (the hamburger)** lists every catalogue product from `mtg_sealed`,
  grouped Packs / Boxes & cases / Bundles / Commander decks / Secret Lair / Other.
  Each product shows its thumbnail, MSRP, market price, EV (from `mtg_ev`) and one
  **Watch** button. Watch picks the mode by the rule above, with a small
  Hunt/Market toggle beside it.
- Set-level "Follow" (`mtg_sealed_sets`) becomes "watch every headline product in
  this set". It no longer means "price everything".

### Hunt tab

- Grouped by set, then product. Each product shows a row of **retailer chips**:
  `BB ● preorder $59.99` `Target ○ listed` `Amazon ◐ resellers $142` `LGS ● 3 stores` `Local ● Best Buy Clarksville`.
- A countdown strip on top for the next windows: preorder opens, street dates,
  Secret Lair on-sale times.
- An event feed on the side (the same events that go to Discord).

### Market tab

- A table like the Finance page: name, current price, sparkline, 7/30/90/365-day
  change, % off the 52-week high and low, and a dip flag (price below the 90-day
  median by ≥ X%).
- A portfolio line: the total of what's watched, which shows "how the market is
  doing" at a glance.
- No retail columns at all.

## Drops

Drops keeps its own page, because the intent differs: it is non-MTG limited
releases (Munko, artist drops). What it shares with Hunt is the **engine**:
the Shopify/Wix readers in `drops.ts` become adapters that Hunt listings also
use. MTG LGS stores (Magic
Monday, local BinderPOS shops) belong under Hunt as listings, not as Drops
watches. That's Phase 3 of `availability-tracking.md`. This doc only changes
what the UI and scheduler ask of that engine.

## Hunt fan-out: what's needed to actually get the product

In rough order of value:

1. **Preorder-open detection.** Run discovery on a schedule, not on click. Widen
   it past `CHASE_RE` for Hunt targets the user explicitly watches (Commander
   decks). Fire `preorder_live` on the first first-party `preorder_open`.
2. **Secret Lair windows.** Pings at T−24h and T−15m, then sentinel polling of the
   store during the window (availability doc, Phase 2).
3. **Local Best Buy stock.** Best Buy's official Products API has a per-store
   availability call by SKU + postal code. It needs a free developer key, which
   **you have to register for yourself**. That gives you "Best Buy Clarksville
   has 2" instead of just `CHECK_STORES`. Needs: key, home ZIP, radius.
4. **LGS directory.** Local and major online LGS Shopify/Wix stores as Hunt
   listings with a title filter, using the existing drops readers.
5. **Seller identity.** Marketplace resellers on Walmart, Amazon and Target must
   never read as availability (availability doc, Phase 3).
6. **Deal feeds (heads-up only).** Community deal posts via RSS through
   `feed.ts`, matched against Hunt targets. Unverified: probe before relying on it.

## Build order

1. **Mode + classifier + scheduler gate.** Add `mode` and `mode_pinned` to
   `mtg_watchlist`, add `classifyMode()`, and backfill existing rows. The stock
   sweep skips Market rows. *This cuts retail noise immediately and needs no UI
   work.*
2. **Split the Watchlist tab into Hunt and Market.** Market is built from the
   existing `mtg_prices` history (stats and sparklines are pure queries). Hunt
   reuses today's listing chips + DealsPanel.
3. **Sets tab** with expandable product lists, from `mtg_sets` + `mtg_sealed` +
   `mtg_ev`. Retire Releases.
4. **Reprint tripwire.**
5. **Hunt fan-out** = availability-tracking Phases 2–4, plus Best Buy store
   availability.

## Open decisions

- In-print window: 12 months for all products, or longer for Commander decks?
- Dip threshold for the Market tab and digest (default 15% below the 90-day median?).
- Home ZIP and radius for local stock, and whether to register a Best Buy API key.
- Always-on: Hunt pings only fire while ATLIS is running and the PC is awake.
