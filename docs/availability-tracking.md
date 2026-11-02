# Availability Tracking — consolidated design

Status: Phase 1 implemented (2026-09-12). Phases 2–5 are still proposals.

## Goal

A daily **price** check already works for cards and sealed product, so leave it alone.
This design is about a different question: **when can I actually buy a limited
item at or near MSRP, and where?** It covers items that are:

1. limited-run,
2. worth more on the secondary market the moment you get them,
3. hard to find.

Examples: Fallout Commander decks, Collector Booster preorders, Secret Lair drops.

The system must produce three kinds of "ping", each with a direct buy link, in Discord:

| # | Situation | Example |
|---|-----------|---------|
| 1 | A preorder is **actually open** (not just announced or listed) | Best Buy flips a Collector Box from COMING_SOON to PREORDER |
| 2 | Something **sold out is coming back**, or has come back | Best Buy Fallout deck: SOLD_OUT, then a restock signal, then ADD_TO_CART |
| 3 | A **timed drop** is about to go on sale, and then goes live | Secret Lair superdrop at its on-sale hour |

Also important: resellers now list on big-box marketplaces above MSRP, and those
listings must **not** look like availability.

---

## What's wrong today

There is plenty of machinery. It's split across four systems that don't share a
model, and the MTG side doesn't reach Discord at all.

1. **MTG retail alerts never reach Discord.** `notifyStock` and `notifyDeal`
   (`src/main/mtg.ts:2383`, `:2423`) call Electron `Notification` directly. They
   skip `alerts.dispatch`, so the Discord sink registered in `index.ts` never sees
   a restock, a preorder, or a below-market deal. Only Drops (Shopify) goes
   through the sink registry.

2. **Stock checks run hourly, not every 20 minutes.** `STOCK_EVERY_MS` is 20
   minutes (`mtg.ts:2361`), but it's only evaluated inside a tick that
   `setInterval` fires every `REFRESH_EVERY_MS` = 60 minutes (`mtg.ts:2516`).

3. **The retailer's real state gets thrown away.** `bestBuyStatus`
   (`retail.ts:414`) collapses Best Buy's `buttonState` into four buckets.
   `SOLD_OUT`, `COMING_SOON`, `CHECK_STORES` and `IN_STORE_ONLY` carry different
   meanings, and two of them become `in_stock`. Signal #2 ("sold out, but they're
   getting more") lives in exactly the detail that's discarded. Raw state only
   survives as prose in `last_error`.

4. **No seller identity.** The deal logic assumes a big-box price *is* list
   (`BIG_BOX`, `retail.ts:1016`). That stopped being true once Amazon, Walmart and
   Target began hosting marketplace sellers. A reseller at 3x MSRP on walmart.com
   reads the same as Walmart itself. Amazon with no buy box is reported as
   `unknown` instead of "resellers only".

5. **The preorder sweep is manual, capped, and silent.** `scanPreorders` runs only
   when clicked, stops at 40 checks, and never dispatches an alert. `CHASE_RE`
   (`retail.ts:840`) only admits "collector / signature / serialized" names, so a
   product like *Fallout – Mutant Menace Commander Deck* never appears in it.
   Watchlist rows are still refreshed, so the gap is only in discovery.

6. **Secret Lair stops at the calendar.** `secretlair.ts` knows each drop's date
   and MSRP, but nothing fires before or at on-sale time. Nothing watches the
   store during the window either.

7. **Transitions are status-only.** `refreshListings` emits an event only when
   `status` changes. A marketplace price falling to MSRP, which usually means
   first-party stock is back, produces nothing.

---

## The consolidated model

Four concepts replace the per-feature tables (`mtg_listings` and `drop_products`):

```
target        the thing you want            "Fallout – Mutant Menace Commander Deck"
  └─ listing  one place it is sold          Best Buy SKU (online) | LGS Shopify handle | store #412
       └─ observation   what it said, when   stored ONLY when something changed
  └─ window   a scheduled on-sale moment    Secret Lair superdrop, opens at an exact time
event         derived by one differ from (previous observation, new observation) or from a window
```

### target
`id, name, kind (sealed|card|secret_lair|drop), msrp, msrp_source (published|inferred|manual),
market_ref (tcgplayer product id), image, tier (window|hot|normal|daily), notify, created_at`

MSRP is a first-class field. Every seller judgement depends on it. The source is
recorded because an inferred MSRP (the lowest first-party price ever seen) is
weaker than a published one.

### listing
`id, target_id, retailer, adapter, url, scope (online | store:<id>), match (exact|searched|manual),
verified (bool), created_at`

`match` and `verified` carry forward what `retail.ts` already does well:
exact id-derived links beat name-searched ones, and a searched listing that fails
the price-sanity check can never trigger a buy-now ping.

### observation — the core change
```
status        announced | listed | preorder_open | in_stock | in_store_only
              | sold_out_restocking | sold_out | marketplace_only | removed | unknown
raw_state     the retailer's own words, verbatim: "SOLD_OUT", "COMING_SOON",
              "Temporarily out of stock.", Shopify available=false + inventory_policy=continue
price         the price a buyer pays right now
seller        first_party | marketplace | unknown
seller_name   "Walmart.com", "Sold by GameDealsUSA"
fulfillment   ship | pickup | in_store_only (set, may be several)
qty_hint      exact count when a source exposes one, else "limited"/"low"/null
release_at    preorder ship / street date when the page states one
checked_at
```

`unknown` means "the read failed". It's never news, and it never triggers anything.

### Status mapping (per adapter)

| Retailer signal | → status |
|---|---|
| Best Buy `ADD_TO_CART` | in_stock |
| Best Buy `PREORDER` | preorder_open |
| Best Buy `COMING_SOON` (never been buyable) | listed |
| Best Buy `COMING_SOON` **after** having been `SOLD_OUT` | sold_out_restocking |
| Best Buy `SOLD_OUT` / `SOLD_OUT_ONLINE` | sold_out |
| Best Buy `CHECK_STORES` / `IN_STORE_ONLY` | in_store_only |
| Amazon "Temporarily out of stock" / "usually ships within" | sold_out_restocking |
| Amazon "Currently unavailable" | sold_out |
| Amazon no buy box, third-party offers only | marketplace_only |
| Walmart `sellerName` ≠ Walmart.com, or Target "Sold and shipped by <partner>" | marketplace (seller) |
| Shopify variant `available=false` with `inventory_policy=continue` | sold_out_restocking (backorder) |
| any page "backordered" / "notify me when available" | sold_out_restocking |
| big-box price > MSRP × 1.15 and seller unproven | treated as marketplace |

"Restocking" is a guess built from retailer wording. The embed labels it that
way, as a signal and not a promise.

### window
`id, target_id (or superdrop id), opens_at (exact ms), closes_at (nullable), source, listing_ids`

Windows come from `mtg_sl_upcoming` (date plus a configured on-sale hour; historically
Secret Lair has gone live in the morning Pacific time, which should be verified per
drop), from announced preorder-open dates, and from manual entry.

---

## Events (the pings)

One differ produces every event. Each event lands in one of three **lanes**, and
the lane decides where it goes and whether it @mentions.

| Event | Trigger | Lane |
|---|---|---|
| `preorder_live` | anything → `preorder_open`, first-party | **buy-now** |
| `restock` | `sold_out*` / `marketplace_only` / `listed` → `in_stock` or `in_store_only`, first-party | **buy-now** |
| `below_market` | first-party price ≤ market × (1 − threshold) (existing deal logic, now seller-gated) | **buy-now** |
| `drop_live` | window opened **and** the store confirms buyable | **buy-now** |
| `restock_signal` | `sold_out` → `sold_out_restocking` | heads-up |
| `new_listing` | a retailer created a page for a watched target (often precedes preorder) | heads-up |
| `drop_soon` | window T−24h and T−15m | heads-up |
| `sold_out` | buyable → `sold_out*`, including how long it lasted | log |
| `reseller_only` | first-party gone, marketplace sellers remain (with lowest marketplace price) | log |
| `price_move` | price change ≥ 5% at the same seller class | log |

Rules:
- **buy-now requires `match=exact|manual` or a verified searched match.** An
  unverified match gets downgraded to heads-up with a "verify before buying" note.
- **Only first-party sellers can put something in buy-now.** Marketplace listings
  never ping as availability.
- Cooldown and dedupe reuse `db.claimAlert` via `alerts.dispatch`, keyed on
  `sink:target:listing:event`. That's already restart-safe.

---

## Polling: tiers and budget

| Tier | Who's in it | Cheap sources (Shopify JSON, TCGplayer pricepoints) | Rendered big-box pages |
|---|---|---|---|
| **window** | listings tied to a window, T−10m → T+60m | 30 s | 60 s |
| **hot** | limited targets currently sold out/restocking, or a preorder expected within 14 days | 2 min (ETag → mostly 304) | 15 min |
| **normal** | everything else being watched | 15 min | 60 min |
| **daily** | the existing price check | unchanged | unchanged |

Tiers are **computed, not set by hand**: a target moves to `hot` when it goes
`sold_out_restocking` or a window is within 14 days, and returns to `normal` after
7 quiet days. Manual pin to hot is allowed.

**Today's ceiling is the renderer, and that's a design choice, not a Chromium limit.**
`render.ts` sends every rendered load through one hidden window, at 3–5 s per load,
so it tops out around 12–20 loads a minute *total*. ATLIS's browser already runs many
tabs as separate `WebContentsView`s. The same mechanism supports a monitor tab pool
(below).

### Render pool (replaces the single hidden window)

- **One lane per retailer, with concurrency 1 inside each lane.** Rate limits and bot
  checks apply per site, so a single retailer's cadence doesn't change. Different
  retailers stop waiting on each other. Start with about 4 hidden `WebContentsView`s:
  images off, each a renderer process of roughly 100–200 MB.
- **Sentinel tabs for the window tier.** During a drop window, a dedicated tab stays
  loaded on the store page and reloads in place. It never waits behind a sweep, and
  a warm reload is much cheaper than a cold load.
- **Read the page's own API calls.** A live tab can record the JSON responses the page
  fetches for itself, using `webContents.debugger` (CDP `Network.getResponseBody`).
  Those requests carry cookies that already passed the site's bot check. This may
  unlock data that plain fetch can't reach, such as Target RedSky availability and
  Best Buy pickup/fulfillment calls. **Unverified: probe each one before relying on it.**
- **Separate session partition.** Today `render.ts`'s window *and* the user's browser
  tabs both use `session.defaultSession`, so background sweeps carry the user's
  signed-in Amazon/Best Buy cookies. If a sweep trips a bot check, it trips against
  the real account. Monitor tabs should use their own partition, ideally one per
  retailer (`persist:monitor-amazon`, …), so a flag on one site can't taint another.
- **Never use the user-visible tabs.** Navigating them would take over whatever the
  user (or the agent's `browser_*` tools) is looking at.

The scheduler must still:

- give `window` tier strict priority,
- cap rendered loads per retailer per hour (Amazon's bot check trips on bursts),
- spend cheap JSON reads freely and rendered loads sparingly.

With a 4-lane pool, a rough target is 10–20 hot listings *per big-box retailer* at
15-minute cadence, plus windows on sentinel tabs and hundreds of Shopify listings.

---

## Sources: what can actually be read

| Source | Read | Seller ID | In-store | Notes |
|---|---|---|---|---|
| Shopify storefronts | `/products.json`, per-variant `available` | n/a (store is the seller) | no | **Covers many LGS web stores** (BinderPOS runs on Shopify). Cheapest, best signal. Reuse `drops.ts`. |
| Wix Stores | visitor token from `/_api/v1/access-tokens`, then `/_api/catalog-reader-server/api/v1/products/query` | n/a (store is the seller) | no | **Implemented** in `drops.ts` (kind `wix`). Uncached, and carries stock quantity. The page HTML is CDN-cached for days, so don't use it. First watch: Magic Monday (magicmonday.shop). |
| Best Buy | rendered search, Apollo `buttonState` | needs parsing | `CHECK_STORES` flag only | Product pages fail with HTTP/2 errors; search payload works. Per-store counts need the official API key. |
| Amazon | rendered product page | buy-box "Sold by" | no | Bot-check interstitial handled; keep long gaps. |
| Walmart | page state (`__NEXT_DATA__`) | `sellerName` | no | Reader needs writing; page state carries the seller. |
| Target | rendered HTML only | "Sold and shipped by" text | no | RedSky JSON is CAPTCHA'd; slugs + page text only. |
| TCGplayer | pricepoints JSON | n/a | no | Market reference, not a buy-now source. |
| Secret Lair store | rendered page during window only | first-party | no | Confirms `drop_live` / `sold_out` inside a window; never polled outside one. |
| GameStop | rendered page | "Sold by" | pickup flag | New adapter; lists Commander decks as assortments ("Deck May Vary"). Mark assortment listings, since a random deck is not the target. |
| eBay | blocked | — | — | IP-level block; Browse API needs OAuth. Out of scope. |

What stays unchanged: reads only. No login, no cart, no checkout. Every existing
module already takes that position, and this design keeps it.

---

## Discord output

**Three webhooks, one per lane.** They share one guild rate-limit bucket (see
`discordAlert.ts`), which is fine at personal volume.

- `#buy-now`: @mention, green embed, sent immediately.
- `#heads-up`: no mention, amber embed.
- `#log`: no mention, batched, plus the daily digest.

If only one webhook is configured, every lane goes there and the lane shows in the
embed title.

**buy-now embed:**
```
PREORDER LIVE — Best Buy                              [thumbnail]
Universes Beyond: Fallout – Mutant Menace Commander Deck
Price $59.99 · MSRP $59.99 · Market $202.91 · Spread +$142.92
Sold by Best Buy · Ship · Pickup
Buy at Best Buy (title link) · TCGplayer market (field link)
restock after 212 days sold out · checked 09:41:07
```
Real link buttons require a bot. Webhooks get the embed `url` (title link) plus
markdown links in a field.

**Daily digest** (one message at a configured hour) is the "daily updates, not
day-trading" view:
- **Buyable now at MSRP:** target → retailer links
- **Restock signals:** targets in `sold_out_restocking`, and where
- **Windows in the next 7 days:** Secret Lair and preorder opens, with times
- **Went quiet:** targets that sold out in the last 24 h, and how long they lasted

---

## Build phases

**Phase 1: plumbing fixes (small, independent of the new model)** — ✅ done

As built, with two additions beyond the list below:
- `COMING_SOON` now maps to a new `listed` status. It used to map to `preorder`, which
  announced preorders that couldn't be placed. After a sell-out it becomes `sold_out_restocking`.
- An unreadable page no longer overwrites a known status with `unknown`. Doing so
  made the next good read look like a restock.
- Price-target alerts from the daily price check are unchanged and still desktop-only.
- Send MTG stock transitions and deals through `alerts.dispatch` with a
  `PolicyResolver` for MTG watches. Delete the direct `Notification` calls; the
  desktop sink already covers them. → *MTG alerts reach Discord.*
- Fix the stock cadence: give the stock sweep its own interval, or tick at the
  fastest clock.
- Add a `raw_state` column to `mtg_listings` and stop collapsing Best Buy states.
  Add `in_store_only` and `sold_out_restocking`.
- Include market, spread and a TCGplayer link in MTG alert payloads.
- Move `render.ts`'s hidden window onto its own session partition, so sweeps stop
  sharing the user's signed-in cookies. One-line change, worth doing before any cadence increase.

**Phase 2: timed windows**
- `windows` table, seeded from `mtg_sl_upcoming` with a configurable on-sale hour.
- A scheduler that fires `drop_soon` at T−24h and T−15m, polls in window tier, and
  emits `drop_live` / `sold_out` with duration.

**Phase 3: unified model and seller identity**
- `targets / listings / observations / events` tables and one `Adapter` interface
  (`read(listing) → Observation`).
- Move the Best Buy, Amazon, Target and TCGplayer readers out of `retail.ts`,
  and Shopify out of `drops.ts`; write Walmart and JSON-LD readers. Add seller parsing.
- Migrate `mtg_listings` rows to listings, and `drop_products` history to observations.
- Computed tiers, plus a render pool: per-retailer lanes, sentinel tabs for windows,
  and a per-retailer budget.
- Probe in-page API capture (CDP network responses) for Target and Best Buy pickup data.

**Phase 4: coverage**
- Scheduled preorder discovery, plus explicit "watch this product" targets for
  non-collector items the chase regex skips.
- An LGS directory: add local and major online LGS Shopify stores as listings with
  a title filter.
- GameStop and Walmart adapters.

**Phase 5: output**
- Lane routing across three webhooks, the daily digest, and a digest preview in the UI.

---

## Open questions

1. **Always-on:** alerts only fire while ATLIS is running and the PC is awake. A
   morning drop is missed if the machine is asleep. Moving the poller to a small
   always-on host is a later decision; the sink/producer split in `alerts.ts`
   already allows it.
2. **Which LGSs** should be seeded as Shopify listings?
3. **Secret Lair on-sale hour:** confirm the current time and whether it varies by drop.
