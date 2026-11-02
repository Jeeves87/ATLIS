import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { dirname, join } from 'path'
import { existsSync, renameSync } from 'fs'
import { randomUUID } from 'crypto'
import type { TorrentRow } from '../torrents'

let db: DatabaseSync

/**
 * Open the DB, verifying it actually reads. A corrupt WAL journal blocks every
 * future boot with "database disk image is malformed" even when the base file
 * is intact (seen 2026-07-02, 4MB WAL) — so on corruption, quarantine the
 * -wal/-shm files and retry from the last checkpointed state instead of
 * refusing to launch. Rethrows if the base file itself is corrupt.
 */
function openWithRecovery(dbPath: string): DatabaseSync {
  const attempt = (): DatabaseSync => {
    const d = new DatabaseSync(dbPath)
    try {
      d.exec('PRAGMA journal_mode = WAL')
      const row = d.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined
      if (row?.quick_check !== 'ok') throw new Error(`quick_check: ${row?.quick_check ?? 'no result'}`)
      return d
    } catch (err) {
      try { d.close() } catch { /* already unusable */ }
      throw err
    }
  }
  try {
    return attempt()
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      for (const suffix of ['-wal', '-shm']) {
        const file = dbPath + suffix
        if (existsSync(file)) renameSync(file, `${file}.corrupt-${stamp}`)
      }
    } catch (renameErr) {
      // EBUSY here means another ATLIS instance still holds the journal —
      // don't yank it out from under a live process.
      throw new Error(
        `Database failed to open (${err instanceof Error ? err.message : err}) and its journal could not be quarantined (${renameErr instanceof Error ? renameErr.message : renameErr}). Is another ATLIS instance running?`
      )
    }
    console.error(`atlis.db failed to open (${err instanceof Error ? err.message : err}); quarantined WAL/SHM as *.corrupt-${stamp} and retrying from last checkpoint`)
    return attempt()
  }
}

/** Where the live database file sits — for read-only side connections (agent/dbquery.ts). */
export function dbFilePath(): string {
  return join(app.getPath('userData'), 'atlis.db')
}

export function initDb(): void {
  const dbPath = dbFilePath()
  db = openWithRecovery(dbPath)
  db.exec('PRAGMA foreign_keys = ON')

  preMigrate()

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#7C5CFF',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      provider TEXT NOT NULL DEFAULT 'anthropic',
      model TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      agent_mode INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      content_md TEXT NOT NULL DEFAULT '',
      content_html TEXT NOT NULL DEFAULT '',
      tool_name TEXT,
      tool_payload TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      project_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      energy_wh REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_time ON usage(created_at);

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      html TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER,
      all_day INTEGER NOT NULL DEFAULT 0,
      timezone TEXT,
      location TEXT,
      notes TEXT,
      tags_json TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      external_id TEXT,
      recurrence_rule TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_at);

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      priority TEXT NOT NULL DEFAULT 'normal',
      due_at INTEGER,
      scheduled_at INTEGER,
      tags_json TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      external_id TEXT,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_todos_status_due ON todos(status, due_at);

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      remind_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      linked_type TEXT,
      linked_id TEXT,
      notification_sent_at INTEGER,
      snoozed_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_status_time ON reminders(status, remind_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feed_sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,            -- youtube | reddit | rss
      title TEXT NOT NULL,
      url TEXT NOT NULL,             -- canonical fetch url (RSS/Atom xml, reddit listing json)
      handle TEXT,                   -- original user input (e.g. @mkbhd, r/programming, https://…)
      icon TEXT,
      category TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fetched_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comparisons (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      provider_a TEXT NOT NULL,
      model_a TEXT NOT NULL,
      provider_b TEXT NOT NULL,
      model_b TEXT NOT NULL,
      response_a TEXT NOT NULL DEFAULT '',
      response_b TEXT NOT NULL DEFAULT '',
      cost_a REAL NOT NULL DEFAULT 0,
      cost_b REAL NOT NULL DEFAULT 0,
      latency_a_ms INTEGER,
      latency_b_ms INTEGER,
      winner TEXT,                  -- 'a' | 'b' | 'tie' | 'both_bad' | NULL while unvoted
      is_blind INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'running',  -- running | done | error
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comparisons_time ON comparisons(created_at DESC);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vault_items (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL DEFAULT 'coin',   -- coin | bullion | knife | other
      name TEXT NOT NULL,
      year TEXT,
      maker TEXT,                              -- mint / manufacturer / brand
      grade TEXT,                              -- condition or certified grade (e.g. MS-63, VF, "like new")
      quantity INTEGER NOT NULL DEFAULT 1,
      metal TEXT,                              -- gold | silver | platinum | palladium | copper | NULL
      metal_weight_ozt REAL,                   -- troy oz of that metal PER ITEM (melt basis)
      purchase_price REAL,                     -- total paid for the whole quantity
      purchase_date TEXT,
      notes TEXT,
      photos TEXT,                             -- JSON ImageAttachment[]
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vault_valuations (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,                      -- melt | market | manual
      value_mid REAL NOT NULL,                 -- USD for the whole quantity
      value_low REAL,
      value_high REAL,
      spot_price REAL,                         -- $/ozt used, melt only
      source TEXT,                             -- where the estimate came from
      notes TEXT,                              -- rationale / citations
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vault_valuations_item ON vault_valuations(item_id, kind, created_at DESC);

    -- Cached Scryfall set list; drives the release calendar and set pickers.
    CREATE TABLE IF NOT EXISTS mtg_sets (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      set_type TEXT,                           -- expansion | core | commander | masters | ...
      released_at TEXT,                        -- YYYY-MM-DD (street date)
      card_count INTEGER,
      digital INTEGER NOT NULL DEFAULT 0,
      icon_svg_uri TEXT,
      scryfall_uri TEXT,
      parent_set_code TEXT,                    -- e.g. HOC's parent is HOB
      synced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mtg_sets_released ON mtg_sets(released_at);

    -- Things you want but do not own yet. Owned copies live in vault_items.
    CREATE TABLE IF NOT EXISTS mtg_watchlist (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'card',       -- card | sealed
      name TEXT NOT NULL,
      set_code TEXT,
      collector_number TEXT,
      image_url TEXT,
      ext_source TEXT NOT NULL DEFAULT 'scryfall',
      ext_id TEXT,                             -- scryfall card id (null for sealed, which has no free feed)
      variant TEXT NOT NULL DEFAULT 'nonfoil', -- nonfoil | foil | etched
      target_price REAL,                       -- alert when the quote is at or under this
      alert_enabled INTEGER NOT NULL DEFAULT 1,
      last_price REAL,
      last_checked_at INTEGER,
      last_alert_at INTEGER,                   -- throttles repeat notifications to one a day
      notes TEXT,
      tags_json TEXT,
      -- Also added in preMigrate for older databases (see addColumnIfMissing).
      mode_override TEXT,                      -- hunt | market | null = derive (lifecycle.ts)
      msrp REAL,                               -- list price, USD
      msrp_source TEXT,                        -- manual | inferred
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Daily price history, keyed by card+finish+day so a re-run overwrites
    -- rather than duplicating. Scryfall only moves once a day upstream.
    CREATE TABLE IF NOT EXISTS mtg_prices (
      id TEXT PRIMARY KEY,
      ext_id TEXT NOT NULL,
      variant TEXT NOT NULL,
      price REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      source TEXT NOT NULL DEFAULT 'scryfall',
      observed_on TEXT NOT NULL,               -- YYYY-MM-DD, local
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mtg_prices_day ON mtg_prices(ext_id, variant, source, observed_on);
    -- The read path: "newest / previous / N-days-ago price for this card".
    -- idx_mtg_prices_day has source between the card and the day, so it finds
    -- a card's rows but not in date order, and every such lookup sorted the
    -- card's whole history. With ~1k owned cards that made the Owned list a
    -- ~1s query run on the main thread; this index brings it to ~20ms.
    CREATE INDEX IF NOT EXISTS idx_mtg_prices_card_day ON mtg_prices(ext_id, variant, observed_on);

    -- Scryfall card facts for cards ATLIS already references (owned rows,
    -- watchlist). vault_items only stores a name and a scryfall id, which is
    -- enough to price a card but not enough to ask "which of my cards could go
    -- in a Golgari deck" — colour identity, type line and oracle text all live
    -- up at Scryfall. Cached rather than fetched per question because the
    -- answers never change for a given printing: a card's colour identity is
    -- fixed at print time, unlike its price.
    --
    -- Keyed by printing (scryfall id) because that is what vault_items holds,
    -- but oracle_id is carried alongside: deckbuilding is an oracle-level
    -- question, where a Sol Ring is a Sol Ring regardless of which of the
    -- fifty printings is in the box.
    CREATE TABLE IF NOT EXISTS mtg_card_meta (
      ext_id TEXT PRIMARY KEY,                 -- scryfall printing id
      oracle_id TEXT,                          -- stable across printings
      name TEXT NOT NULL,
      -- Punctuation-folded name, so joining to EDHREC's spelling is an index
      -- lookup rather than something SQLite cannot express. See cardNameKey().
      name_key TEXT NOT NULL DEFAULT '',
      set_code TEXT,
      set_name TEXT,
      collector_number TEXT,
      rarity TEXT,
      mana_cost TEXT,
      cmc REAL,
      type_line TEXT,
      oracle_text TEXT,
      -- Sorted, joined letters: '' = colourless, 'B,G' = Golgari. Stored
      -- sorted so an exact-identity match is a string compare, not set logic.
      color_identity TEXT NOT NULL DEFAULT '',
      colors TEXT NOT NULL DEFAULT '',
      keywords TEXT,                           -- JSON string[]
      legal_commander INTEGER NOT NULL DEFAULT 0,
      edhrec_rank INTEGER,
      reserved INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mtg_card_meta_oracle ON mtg_card_meta(oracle_id);
    CREATE INDEX IF NOT EXISTS idx_mtg_card_meta_name ON mtg_card_meta(name);
    -- NOTE: the index on name_key is NOT here. On a database created before
    -- name_key existed, CREATE TABLE IF NOT EXISTS is a no-op, so the column
    -- is only added later by migrate() — indexing it here would throw "no such
    -- column" and take the whole app down before it can open a window.

    -- How many real decks run each commander, from EDHREC's per-colour top
    -- lists. Answers the question a collection cannot: a Legendary Creature in
    -- the box might be a format staple or a card nobody has ever built around,
    -- and nothing on the card itself says which.
    --
    -- Coverage is deliberately partial. EDHREC publishes the top ~100 per
    -- colour identity, so ABSENCE from this table is itself the useful signal
    -- — it means the card is outside the top 100 of its colours, not that the
    -- sync failed. Rows are a mirror of an upstream list, so a sync replaces
    -- a colour's rows wholesale rather than merging: a commander that falls
    -- out of the top 100 should stop claiming a rank.
    CREATE TABLE IF NOT EXISTS mtg_commander_stats (
      name_key TEXT PRIMARY KEY,               -- lowercased, punctuation-folded name
      name TEXT NOT NULL,                      -- as EDHREC spells it
      slug TEXT,                               -- edhrec url slug
      num_decks INTEGER NOT NULL DEFAULT 0,
      potential_decks INTEGER,
      color_slug TEXT NOT NULL,                -- golgari | mono-white | five-color | ...
      rank_in_color INTEGER NOT NULL,          -- 1 = most-built in that identity
      synced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mtg_commander_stats_decks ON mtg_commander_stats(num_decks DESC);

    -- cEDH tournament play rate per card, from EDHTop16 (see cedh.ts). Keyed
    -- by Scryfall's full card name, which is what EDHTop16 matches on — the
    -- " // " of a double-faced card included. play_rate NULL means EDHTop16
    -- has no record of the card in any tournament deck: stored, so a card
    -- nobody plays is not re-asked about on every sync.
    CREATE TABLE IF NOT EXISTS mtg_cedh_stats (
      name TEXT PRIMARY KEY,
      play_rate REAL,                          -- 0..1, last 12 months
      synced_at INTEGER NOT NULL
    );

    -- Sealed product catalogue from MTGJSON (booster boxes, bundles, Secret
    -- Lair drops). Scryfall has no concept of sealed product, and MTGJSON has
    -- no sealed PRICES — this is the catalogue half only; prices come from the
    -- tcgplayer_product_id.
    CREATE TABLE IF NOT EXISTS mtg_sealed (
      uuid TEXT PRIMARY KEY,                   -- MTGJSON sealed product uuid
      name TEXT NOT NULL,
      set_code TEXT NOT NULL,
      category TEXT,                           -- box_set | booster_box | bundle | ...
      subtype TEXT,                            -- secret_lair | collector | draft | ...
      release_date TEXT,
      tcgplayer_product_id TEXT,               -- the only usable price handle
      card_kingdom_id TEXT,
      synced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mtg_sealed_set ON mtg_sealed(set_code);
    CREATE INDEX IF NOT EXISTS idx_mtg_sealed_name ON mtg_sealed(name);

    -- ANNOUNCED-but-unreleased Secret Lair drops. Deliberately separate from
    -- mtg_sealed: MTGJSON only learns about a drop once it exists, which is
    -- after the window a collector cares about. Rows are a mirror of an
    -- upstream list, so the sync REPLACES the table wholesale rather than
    -- merging — a drop that disappears upstream has gone on sale or been
    -- pulled, and either way should stop being "upcoming".
    CREATE TABLE IF NOT EXISTS mtg_sl_upcoming (
      id TEXT PRIMARY KEY,                     -- upstream row id
      drop_id TEXT,                            -- superdrop this belongs to
      drop_name TEXT,
      drop_release_date TEXT,                  -- YYYY-MM-DD, local
      name TEXT NOT NULL,
      picture TEXT,
      release_date TEXT,                       -- YYYY-MM-DD, local
      msrp REAL,                               -- USD, converted from cents
      foil INTEGER NOT NULL DEFAULT 0,
      etched INTEGER NOT NULL DEFAULT 0,
      randomized INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mtg_sl_upcoming_date ON mtg_sl_upcoming(release_date);

    -- Standing expected-value board: one row per sealed product ATLIS has
    -- evaluated, so "what is worth opening right now" is a query rather than a
    -- thing the user has to remember to check. Deliberately a cache, not a
    -- ledger: rows are recomputed in place and carry the time each half was
    -- last established, because the price moves daily while the EV (which
    -- depends on the whole card pool) moves slowly.
    CREATE TABLE IF NOT EXISTS mtg_ev (
      uuid TEXT PRIMARY KEY,                   -- MTGJSON sealed product uuid
      set_code TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,                      -- pack | box | case | deck | bundle | other
      tcgplayer_product_id TEXT,
      price REAL,                              -- what the sealed product costs
      ev_mean REAL,                            -- expected value of the contents
      ev_median REAL,                          -- null for deterministic products
      ev_liquid REAL,                          -- counting only cards >= $2
      method TEXT NOT NULL,                    -- deterministic | simulated
      packs INTEGER NOT NULL DEFAULT 0,
      chance_of_profit REAL,
      net REAL,                                -- ev_mean - price
      net_pct REAL,
      note TEXT,
      priced_at INTEGER,
      computed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mtg_ev_net ON mtg_ev(net_pct DESC);
    CREATE INDEX IF NOT EXISTS idx_mtg_ev_set ON mtg_ev(set_code);

    -- Commander decks: built by hand from owned cards, a precon's list, or a
    -- saved cEDH tournament list. Cards are stored by NAME (with an optional
    -- preferred printing), because a deck asks "do I own a Sol Ring", not
    -- "do I own that Sol Ring" — ownership is matched across printings.
    CREATE TABLE IF NOT EXISTS mtg_decks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'custom',     -- custom | precon | cedh | edhrec
      color_identity TEXT NOT NULL DEFAULT '', -- sorted WUBRG, from the commander(s)
      source_ref TEXT,                         -- sealed vault id / product name / EDHTop16 entry id
      source_url TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mtg_deck_cards (
      deck_id TEXT NOT NULL REFERENCES mtg_decks(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,                  -- cardNameKey(name)
      ext_id TEXT,                             -- preferred Scryfall printing, when known
      quantity INTEGER NOT NULL DEFAULT 1,
      board TEXT NOT NULL DEFAULT 'main',      -- commander | main
      PRIMARY KEY (deck_id, name_key, board)
    );
    CREATE INDEX IF NOT EXISTS idx_mtg_deck_cards_key ON mtg_deck_cards(name_key);

    -- Card facts for cards the collection does NOT hold — a precon reprint or a
    -- cEDH staple has no mtg_card_meta row until it is owned, and a deck view
    -- still needs its type, curve slot and price. Keyed by folded name; the
    -- price is one representative printing's, not the cheapest.
    CREATE TABLE IF NOT EXISTS mtg_card_info (
      name_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ext_id TEXT,
      type_line TEXT,
      mana_cost TEXT,
      cmc REAL,
      color_identity TEXT NOT NULL DEFAULT '',
      price REAL,
      source TEXT NOT NULL,                    -- scryfall | edhtop16
      synced_at INTEGER NOT NULL
    );

    -- EDHREC commander pages (recommended cards + combos), parsed and cached
    -- per commander slug so a deck's upgrade view is not two fetches per open.
    CREATE TABLE IF NOT EXISTS mtg_edhrec_pages (
      slug TEXT PRIMARY KEY,
      data TEXT NOT NULL,                      -- JSON CommanderPage
      fetched_at INTEGER NOT NULL
    );

    -- Recent high-finishing cEDH tournament lists from EDHTop16, mirrored so
    -- "which of these could I finish" is a local query. Replaced wholesale on
    -- each sync, like the commander popularity table.
    CREATE TABLE IF NOT EXISTS mtg_cedh_lists (
      entry_id TEXT PRIMARY KEY,
      commander TEXT NOT NULL,                 -- "Kraum, Ludevic's Opus / Tymna the Weaver"
      color_identity TEXT NOT NULL DEFAULT '',
      standing INTEGER,
      player TEXT,
      tournament TEXT,
      tournament_size INTEGER,
      tournament_date TEXT,
      decklist_url TEXT,
      deck_price REAL,
      cards TEXT NOT NULL,                     -- JSON CedhCard[], commanders included
      synced_at INTEGER NOT NULL
    );

    -- Where a tracked thing can actually be bought. One row per retailer per
    -- item. The kind column records how much to trust the URL: an id-derived
    -- product link is exact, a searched one was matched by name and can be
    -- wrong, a search link is just a shortcut to that retailer's results page.
    CREATE TABLE IF NOT EXISTS mtg_listings (
      id TEXT PRIMARY KEY,
      watch_id TEXT REFERENCES mtg_watchlist(id) ON DELETE CASCADE,
      vault_item_id TEXT REFERENCES vault_items(id) ON DELETE CASCADE,
      -- Preorder scanning attaches listings to a catalogue product directly,
      -- with no watchlist row involved.
      sealed_uuid TEXT,
      retailer TEXT NOT NULL,                  -- tcgplayer | cardkingdom | target | bestbuy | amazon | ebay | manual
      kind TEXT NOT NULL DEFAULT 'search',     -- product | searched | search | manual
      title TEXT,
      url TEXT NOT NULL,
      price REAL,
      status TEXT NOT NULL DEFAULT 'unknown',  -- in_stock | in_store_only | preorder | listed | sold_out_restocking | out_of_stock | unknown
      -- The retailer's own words for that status (Best Buy's buttonState, the
      -- phrase matched on an Amazon page). Kept verbatim because the status is
      -- a judgement and this is the evidence it was made from.
      raw_state TEXT,
      last_checked_at INTEGER,
      last_error TEXT,
      deal_alert_at INTEGER,                   -- also added in preMigrate for older databases
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mtg_listings_watch ON mtg_listings(watch_id);
    CREATE INDEX IF NOT EXISTS idx_mtg_listings_item ON mtg_listings(vault_item_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mtg_listings_unique ON mtg_listings(retailer, url);

    CREATE TABLE IF NOT EXISTS torrents (
      id TEXT PRIMARY KEY,
      info_hash TEXT,
      name TEXT NOT NULL DEFAULT '',
      magnet TEXT,                   -- magnet URI (magnet adds)
      torrent_file TEXT,             -- stored .torrent copy (file/url adds); resume source
      save_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'downloading',  -- downloading | paused | done | error
      error TEXT,
      total_bytes INTEGER,
      downloaded_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      files_json TEXT,
      added_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_torrents_added ON torrents(added_at DESC);

    CREATE TABLE IF NOT EXISTS feed_items (
      id TEXT PRIMARY KEY,           -- stable hash of source + guid/url
      source_id TEXT NOT NULL REFERENCES feed_sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      author TEXT,
      summary TEXT,
      thumbnail TEXT,
      published_at INTEGER,
      score INTEGER,
      comments INTEGER,
      extra_json TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_saved INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      fetched_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feed_items_published ON feed_items(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feed_items_source ON feed_items(source_id);
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS land_regions (
      fips TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      min_lon REAL, min_lat REAL, max_lon REAL, max_lat REAL,
      source TEXT NOT NULL DEFAULT '{}',   -- JSON RegionDef.parcels
      extras TEXT NOT NULL DEFAULT '{}',   -- JSON: address points, state-tier sources
      parcel_count INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new',  -- new | ingesting | ready | error
      note TEXT,
      ingested_at INTEGER,
      overlays_at INTEGER,
      scored_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS land_parcels (
      id TEXT PRIMARY KEY,                 -- '<fips>:<pin>'
      fips TEXT NOT NULL,
      pin TEXT NOT NULL,
      address TEXT, city TEXT, owner TEXT,
      acres REAL,                          -- computed from geometry, never trusted from source
      land_use TEXT,
      vacant INTEGER NOT NULL DEFAULT 0,
      assessed REAL,
      lat REAL NOT NULL, lon REAL NOT NULL,
      min_lon REAL, min_lat REAL, max_lon REAL, max_lat REAL,
      candidate INTEGER NOT NULL DEFAULT 0,
      ingested_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_land_parcels_fips ON land_parcels(fips);
    CREATE INDEX IF NOT EXISTS idx_land_parcels_cand ON land_parcels(candidate, fips);
    CREATE VIRTUAL TABLE IF NOT EXISTS land_parcel_bbox USING rtree(
      rowid, min_lon, max_lon, min_lat, max_lat
    );

    -- One row per parcel per enrichment source; the JSON is the source's own
    -- fact shape. Cached indefinitely — flood maps and soil surveys change on a
    -- multi-year cadence, so refetching costs bandwidth and buys nothing.
    CREATE TABLE IF NOT EXISTS land_facts (
      parcel_id TEXT NOT NULL,
      source TEXT NOT NULL,                -- flood | terrain | soil | canopy | wetland | karst | toxic | utility | jurisdiction
      json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (parcel_id, source)
    ) WITHOUT ROWID;

    -- Region-scale overlay polygons, fetched once per region and intersected
    -- locally. Multipolygons are split to one outer ring per row (geopoly has
    -- no hole support); dropping holes is conservative for hazard layers.
    CREATE VIRTUAL TABLE IF NOT EXISTS land_overlay USING geopoly(kind, fips, attrs);

    CREATE TABLE IF NOT EXISTS land_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fips TEXT NOT NULL,
      lat REAL NOT NULL, lon REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_land_addresses_fips ON land_addresses(fips);
    CREATE VIRTUAL TABLE IF NOT EXISTS land_address_bbox USING rtree(
      rowid, min_lon, max_lon, min_lat, max_lat
    );

    -- County-submitted assessment records (Indiana DLGF). Kept separate from
    -- land_parcels because it has its own source, its own annual cadence, and
    -- its own key space -- and because Kentucky has no equivalent, so this
    -- table is simply empty for KY parcels rather than making them look broken.
    CREATE TABLE IF NOT EXISTS land_assessments (
      parcel_id TEXT PRIMARY KEY,
      fips TEXT NOT NULL,
      av_land REAL,
      av_improvement REAL,
      av_total REAL,
      deeded_acres REAL,
      class_code TEXT,
      owner_name TEXT,
      owner_street TEXT,
      owner_city TEXT,
      owner_state TEXT,
      owner_zip TEXT,
      -- Set when the owner's mailing address is outside the county the land is
      -- in: the standard signal that an owner may sell to a direct approach.
      absentee INTEGER NOT NULL DEFAULT 0,
      assessment_year INTEGER,
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_land_assess_fips ON land_assessments(fips, absentee);

    -- Places that matter to THIS household. Not county data and not tied to a
    -- region: these are the fixed points a life is arranged around, and they are
    -- what separates "good land" from "good land for us".
    CREATE TABLE IF NOT EXISTS land_anchors (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',  -- work | family | school | other
      lat REAL NOT NULL, lon REAL NOT NULL,
      address TEXT,
      weight REAL NOT NULL DEFAULT 1,
      ideal_minutes REAL NOT NULL DEFAULT 20,
      max_minutes REAL NOT NULL DEFAULT 60,
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at INTEGER NOT NULL
    );

    -- Amenities from OpenStreetMap, one row per point, bulk-loaded per region.
    CREATE TABLE IF NOT EXISTS land_pois (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fips TEXT NOT NULL,
      kind TEXT NOT NULL,                  -- fuel | grocery | ramp | hospital | school | pharmacy | fire
      name TEXT,
      lat REAL NOT NULL, lon REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_land_pois_kind ON land_pois(fips, kind);
    CREATE VIRTUAL TABLE IF NOT EXISTS land_poi_bbox USING rtree(
      rowid, min_lon, max_lon, min_lat, max_lat
    );

    -- The second scoring axis, kept in its own table rather than folded into
    -- land_scores on purpose. Land quality is a property of the ground; fit is
    -- a property of the household. Blending them would hide the single most
    -- useful result: good land that would demand a different life.
    CREATE TABLE IF NOT EXISTS land_fit (
      parcel_id TEXT PRIMARY KEY,
      score REAL NOT NULL,
      verdict TEXT NOT NULL,               -- easy | workable | shift | remote | unknown
      commute_minutes REAL,                -- worst active anchor, the binding constraint
      detail TEXT NOT NULL DEFAULT '{}',   -- JSON per-anchor and per-amenity breakdown
      scored_at INTEGER NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS land_scores (
      parcel_id TEXT PRIMARY KEY,
      total REAL NOT NULL,
      verdict TEXT NOT NULL,               -- strong | workable | marginal | avoid | unknown
      subs TEXT NOT NULL DEFAULT '{}',     -- JSON Record<factor, {score, weight, why}>
      flags TEXT NOT NULL DEFAULT '[]',    -- JSON string[] — hard blockers first
      hookup_low REAL, hookup_high REAL,
      coverage REAL NOT NULL DEFAULT 0,    -- 0..1 share of weighted factors actually known
      scored_at INTEGER NOT NULL
    ) WITHOUT ROWID;

    -- Listings are entered/imported by hand for now (no MLS feed), so they are
    -- kept independent of parcels and matched in afterwards.
    CREATE TABLE IF NOT EXISTS land_listings (
      id TEXT PRIMARY KEY,
      parcel_id TEXT,
      fips TEXT,
      source TEXT, url TEXT,
      address TEXT, price REAL, acres REAL,
      lat REAL, lon REAL,
      status TEXT NOT NULL DEFAULT 'open', -- open | pending | gone | rejected
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_land_listings_parcel ON land_listings(parcel_id);

    -- Line-extension pricing is per utility, published per tariff, and has to be
    -- typed in by a human. Kept as data so adding a provider never needs a build.
    CREATE TABLE IF NOT EXISTS land_utilities (
      id TEXT PRIMARY KEY,
      fips TEXT NOT NULL,
      kind TEXT NOT NULL,                  -- electric | water | gas
      name TEXT NOT NULL,
      base_fee REAL NOT NULL DEFAULT 0,
      free_feet REAL NOT NULL DEFAULT 0,
      cost_per_foot REAL NOT NULL DEFAULT 0,
      source_url TEXT, note TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_land_utilities_fips ON land_utilities(fips, kind);
  `)

  db.exec(`
    -- Limited-run availability watching: "tell me the moment this is buyable".
    --
    -- Deliberately NOT folded into the mtg_* tables. Those are keyed by
    -- Scryfall/MTGJSON ids and describe cards that already exist; a drop watch
    -- points at a storefront that may be holding nothing at all yet, and the
    -- thing worth knowing is the TRANSITION, not the catalogue.
    CREATE TABLE IF NOT EXISTS drop_watches (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'shopify',    -- shopify | wix | page
      url TEXT NOT NULL,                       -- store origin, or the page to poll
      title_match TEXT,                        -- optional case-insensitive title filter
      -- 'hot' polls on the fast clock. A drop that sells out in ninety seconds
      -- is not caught by a ten-minute sweep, but polling every store that fast
      -- would be rude, so urgency is per-watch and opt-in.
      priority TEXT NOT NULL DEFAULT 'normal', -- hot | normal
      enabled INTEGER NOT NULL DEFAULT 1,
      notify INTEGER NOT NULL DEFAULT 1,
      etag TEXT,                               -- conditional request; a 304 costs nothing
      last_checked_at INTEGER,
      last_ok_at INTEGER,
      last_error TEXT,
      -- Also added in preMigrate for databases that predate them. That pass
      -- runs before this block and skips tables that don't exist yet, so a
      -- fresh database only gets these columns by declaring them here.
      heat REAL,
      sellout_rate REAL,
      median_uptime_ms INTEGER,
      scored_at INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0,
      alert_kinds TEXT,
      alert_cooldown_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_drop_watches_url ON drop_watches(url);

    -- Mirror of what a watch last saw: one row per product for a Shopify watch,
    -- one synthetic row for a page watch. A gone flag rather than DELETE: a
    -- product vanishing from the feed is itself a signal (unpublished ahead of
    -- a relaunch) and deleting the row would throw away first_seen_at.
    CREATE TABLE IF NOT EXISTS drop_products (
      id TEXT PRIMARY KEY,                     -- watch_id + ':' + ext_id
      watch_id TEXT NOT NULL REFERENCES drop_watches(id) ON DELETE CASCADE,
      ext_id TEXT NOT NULL,
      handle TEXT,
      title TEXT NOT NULL,
      url TEXT,
      image TEXT,
      price REAL,
      available INTEGER NOT NULL DEFAULT 0,
      variants_total INTEGER NOT NULL DEFAULT 0,
      variants_available INTEGER NOT NULL DEFAULT 0,
      product_type TEXT,
      published_at INTEGER,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_available_at INTEGER,
      gone INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_drop_products_watch ON drop_products(watch_id, gone);

    -- The timeline. A storefront only ever describes NOW, so without this there
    -- is no way to answer "when did it go live, and how long was it up" after
    -- the fact — which is exactly the question a missed drop raises.
    CREATE TABLE IF NOT EXISTS drop_events (
      id TEXT PRIMARY KEY,
      watch_id TEXT NOT NULL REFERENCES drop_watches(id) ON DELETE CASCADE,
      product_id TEXT,
      kind TEXT NOT NULL,                      -- restock | sold_out | new_product | removed | price_change
      title TEXT NOT NULL,
      detail TEXT,
      url TEXT,
      price REAL,
      seen INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drop_events_time ON drop_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_drop_events_watch ON drop_events(watch_id, created_at DESC);

    -- What has already been shouted about, so it is not shouted about twice.
    -- A product's availability bit FLAPS: an abandoned cart releases its hold
    -- and the variant blinks back for a few seconds, which without this table
    -- is four identical "BACK IN STOCK" pings for one restock. Keyed per sink
    -- per product per kind, and persisted rather than held in memory because
    -- an app restart must not re-arm an alert the user already saw.
    CREATE TABLE IF NOT EXISTS alert_sends (
      key TEXT PRIMARY KEY,                    -- sink + watch + product + kind
      sent_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_sends_time ON alert_sends(sent_at DESC);

    -- Card watches for games that are not Magic (Palworld, Cyberpunk, Pokemon,
    -- ...). NEW tables, deliberately separate from every mtg_* table: Magic's
    -- data comes from Scryfall and MTGJSON, and these games have only
    -- TCGplayer. One row per product PRINTING, because Normal and Foil are
    -- different markets. Observations are written only when the quote changes.
    CREATE TABLE IF NOT EXISTS tcg_watches (
      id TEXT PRIMARY KEY,
      game TEXT NOT NULL,                      -- TCGplayer product-line url name
      game_label TEXT NOT NULL,
      product_id TEXT NOT NULL,                -- TCGplayer productId
      printing TEXT NOT NULL,                  -- Normal | Foil
      kind TEXT NOT NULL DEFAULT 'card',       -- card | sealed
      name TEXT NOT NULL,
      set_name TEXT,
      rarity TEXT,
      image_url TEXT,
      target_price REAL,                       -- alert when market reaches this
      notify INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      last_price REAL,                         -- latest market price, for fast listing
      last_median REAL,                        -- latest listed median; null while nothing is listed
      last_in_stock INTEGER,
      last_checked_at INTEGER,
      last_ok_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tcg_watches_product ON tcg_watches(product_id, printing);
    CREATE INDEX IF NOT EXISTS idx_tcg_watches_game ON tcg_watches(game);
    CREATE TABLE IF NOT EXISTS tcg_observations (
      id TEXT PRIMARY KEY,
      watch_id TEXT NOT NULL REFERENCES tcg_watches(id) ON DELETE CASCADE,
      observed_at INTEGER NOT NULL,
      price REAL,                              -- market price for this printing
      median REAL,                             -- listed median, present only while listed
      in_stock INTEGER,                        -- 1 when copies are listed
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tcg_obs_watch ON tcg_observations(watch_id, observed_at DESC);

    -- Candidate storefronts, before anything is known about them. Discovery
    -- fills this in bulk (Common Crawl enumerates Shopify domains without
    -- anyone pasting links); probing then confirms which are real shops worth
    -- watching. Kept separate from drop_watches so a pool of 50k unproven
    -- domains never pollutes the list of things actually being polled.
    CREATE TABLE IF NOT EXISTS drop_candidates (
      domain TEXT PRIMARY KEY,
      source TEXT NOT NULL,                    -- commoncrawl | suggest | manual
      -- NULL until probed; 1 confirmed Shopify, 0 confirmed not.
      shopify INTEGER,
      products INTEGER,
      -- Sample of product titles, used to judge whether a shop is in the niche
      -- at all. A vape shop and a vinyl label both run Shopify.
      title_sample TEXT,
      niche_score REAL,
      promoted INTEGER NOT NULL DEFAULT 0,     -- 1 once it has become a watch
      probed_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drop_candidates_state ON drop_candidates(shopify, promoted);
    CREATE INDEX IF NOT EXISTS idx_drop_candidates_niche ON drop_candidates(niche_score DESC);

    -- ---------------------------------------------------------------- signals
    -- Demand intent, mined from what people actually type into a search box.
    --
    -- Google's autocomplete is the cheapest honest read on purchase intent
    -- available without a key: "labubu where to buy" and "pokemon 151 booster
    -- box where to buy" are completions that only exist because enough people
    -- typed them. That is a measurement, not a sentiment guess — which is why
    -- this replaces the LLM-scoring idea rather than sitting alongside it.
    CREATE TABLE IF NOT EXISTS signal_terms (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',   -- manual | watch | trends | discovery
      watch_id TEXT,                           -- set when the term came from a drop watch
      enabled INTEGER NOT NULL DEFAULT 1,
      last_checked_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_terms_term ON signal_terms(term);

    -- One row per completion per day. The DAY is part of the key on purpose:
    -- a single snapshot says almost nothing, and it is the movement of a
    -- completion up the list across days that indicates demand outrunning
    -- supply. Re-running inside a day overwrites rather than duplicating.
    CREATE TABLE IF NOT EXISTS signal_suggestions (
      id TEXT PRIMARY KEY,
      term_id TEXT NOT NULL REFERENCES signal_terms(id) ON DELETE CASCADE,
      suggestion TEXT NOT NULL,
      intent TEXT NOT NULL,                    -- purchase | scarcity | release | resale | community | other
      rank INTEGER NOT NULL,                   -- 0-based position within its prefix
      observed_on TEXT NOT NULL,               -- YYYY-MM-DD, local
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_sugg_day
      ON signal_suggestions(term_id, suggestion, observed_on);
    CREATE INDEX IF NOT EXISTS idx_signal_sugg_term ON signal_suggestions(term_id, observed_on DESC);

    -- ---------------------------------------------------------------- discord
    -- Community telemetry from PUBLIC invite metadata only.
    --
    -- Discord's invite endpoint answers without auth and returns the guild
    -- name, total members and how many are online right now. That is enough to
    -- see a community forming and to catch the moment one wakes up, and it
    -- requires no bot, no server permission and no message access at all.
    --
    -- Message content is deliberately out of scope: reading it needs either a
    -- bot invited by a server admin (rarely possible for someone else's shop)
    -- or a user token driven like a bot, which violates Discord's terms and
    -- gets the account terminated. Neither belongs in an automated poller.
    CREATE TABLE IF NOT EXISTS discord_watches (
      id TEXT PRIMARY KEY,
      invite_code TEXT NOT NULL,               -- the code alone, never a full URL
      guild_id TEXT,
      label TEXT NOT NULL,                     -- guild name, resolved on first fetch
      watch_id TEXT,                           -- optional link to the store it belongs to
      enabled INTEGER NOT NULL DEFAULT 1,
      last_checked_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_watches_code ON discord_watches(invite_code);

    -- One sample per guild per hour. Hour-keyed so a frequent poller collapses
    -- into a clean series rather than inflating it: a single membership number
    -- means nothing, and it is the SHAPE over hours and days that shows a
    -- community forming or a room suddenly filling up.
    CREATE TABLE IF NOT EXISTS discord_samples (
      id TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL REFERENCES discord_watches(id) ON DELETE CASCADE,
      members INTEGER,
      online INTEGER,
      observed_at INTEGER NOT NULL,
      observed_hour TEXT NOT NULL              -- YYYY-MM-DDTHH, local
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_samples_hour
      ON discord_samples(discord_id, observed_hour);
    CREATE INDEX IF NOT EXISTS idx_discord_samples_time ON discord_samples(discord_id, observed_at DESC);
  `)

  migrate()

  // No agent run survives a process restart — clear any stale 'running' status.
  db.exec(`UPDATE sessions SET status = 'idle' WHERE status != 'idle'`)
}

const tableExists = (name: string): boolean =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

/** Migrations that must run BEFORE the schema is declared. */
function preMigrate(): void {
  retireTables()
  // Columns added to tables that already exist in the wild. ADD COLUMN is the
  // only in-place schema change SQLite supports, and it must happen before the
  // CREATE TABLE IF NOT EXISTS block, which is a no-op on an existing table
  // and therefore never adds them.
  addColumnIfMissing('mtg_listings', 'deal_alert_at', 'INTEGER')
  addColumnIfMissing('mtg_listings', 'raw_state', 'TEXT')
  // Hunt vs Market. Null override means "derive it", which is what every
  // existing row should get — nothing the user set is being changed.
  addColumnIfMissing('mtg_watchlist', 'mode_override', 'TEXT')
  addColumnIfMissing('mtg_watchlist', 'msrp', 'REAL')
  addColumnIfMissing('mtg_watchlist', 'msrp_source', 'TEXT')
  addColumnIfMissing('mtg_ev', 'engine', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('mtg_ev', 'basis', "TEXT NOT NULL DEFAULT ''")
  // Store-heat metrics, computed from observed sell-out behaviour. Added by
  // migration so an existing install picks them up without losing its watches.
  addColumnIfMissing('drop_watches', 'heat', 'REAL')
  addColumnIfMissing('drop_watches', 'sellout_rate', 'REAL')
  addColumnIfMissing('drop_watches', 'median_uptime_ms', 'INTEGER')
  addColumnIfMissing('drop_watches', 'scored_at', 'INTEGER')
  // Set when the user chooses a priority by hand; the auto-tiering scorer
  // leaves pinned watches alone, so an explicit choice always outranks it.
  addColumnIfMissing('drop_watches', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  // Per-watch alert policy. Both null means "use the app default", which is
  // what every existing row wants — a migration must not quietly change how
  // loud a watch the user already tuned is.
  addColumnIfMissing('drop_watches', 'alert_kinds', 'TEXT')
  addColumnIfMissing('drop_watches', 'alert_cooldown_ms', 'INTEGER')
}

// Tables left behind by apps that have since been removed from ATLIS.
const RETIRED_TABLES = ['stuff_observations', 'stuff_listings', 'stuff_items']

/**
 * Drop retired tables, after taking one full copy of the database first
 * (atlis.pre-1.0.db beside it) so nothing they held is lost for good.
 */
function retireTables(): void {
  const present = RETIRED_TABLES.filter(tableExists)
  if (!present.length) return
  const backup = join(dirname(dbFilePath()), 'atlis.pre-1.0.db')
  if (!existsSync(backup)) db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
  for (const t of present) db.exec(`DROP TABLE IF EXISTS ${t}`)
}

/** ADD COLUMN, but idempotent — SQLite has no `IF NOT EXISTS` for columns. */
function addColumnIfMissing(table: string, column: string, decl: string): void {
  if (!tableExists(table)) return
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  if (cols.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}

/**
 * Add, backfill and index mtg_card_meta.name_key.
 *
 * Three steps that must happen in this order, which is why it is not a bare
 * addColumnIfMissing call. The column arrives with DEFAULT '' so every row
 * cached before this migration would join to nothing — silently returning an
 * empty commander list rather than failing loudly — so the backfill is part of
 * the migration, not an afterthought. The index goes last because it cannot be
 * created until the column exists.
 */
function migrateCardMetaNameKey(): void {
  if (!tableExists('mtg_card_meta')) return
  addColumnIfMissing('mtg_card_meta', 'name_key', "TEXT NOT NULL DEFAULT ''")

  const stale = db.prepare("SELECT ext_id, name FROM mtg_card_meta WHERE name_key = ''")
    .all() as unknown as { ext_id: string; name: string }[]
  if (stale.length) {
    const upd = db.prepare('UPDATE mtg_card_meta SET name_key = ? WHERE ext_id = ?')
    db.exec('BEGIN')
    try {
      for (const r of stale) upd.run(cardNameKey(r.name), r.ext_id)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_mtg_card_meta_name_key ON mtg_card_meta(name_key)')
}

/** Migrations that run after the schema is declared. */
function migrate(): void {
  const msgCols = db.prepare('PRAGMA table_info(messages)').all() as unknown as { name: string }[]
  if (!msgCols.some((c) => c.name === 'attachments')) {
    db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT')
  }
  if (!msgCols.some((c) => c.name === 'author')) {
    db.exec('ALTER TABLE messages ADD COLUMN author TEXT')
  }
  const sessCols = db.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[]
  if (!sessCols.some((c) => c.name === 'participants')) {
    db.exec('ALTER TABLE sessions ADD COLUMN participants TEXT')
  }
  addColumnIfMissing('vault_items', 'ext_source', 'TEXT')
  addColumnIfMissing('vault_items', 'ext_id', 'TEXT')
  addColumnIfMissing('vault_items', 'variant', 'TEXT')
  addColumnIfMissing('mtg_listings', 'sealed_uuid', 'TEXT')
  migrateCardMetaNameKey()
  addColumnIfMissing('land_parcels', 'city', 'TEXT')
  initMemoryFts()
}

/**
 * Full-text index over memories, kept in sync by triggers.
 *
 * FTS5 is a compile-time option and is not guaranteed present in node:sqlite,
 * so a build without it must still boot — searchMemories() falls back to LIKE
 * when this flag is false rather than the whole app failing to start.
 */
let memoryFtsAvailable = false
function initMemoryFts(): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, content='memories', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `)
    memoryFtsAvailable = true
  } catch {
    memoryFtsAvailable = false
  }
}

const now = () => Date.now()

// node:sqlite's parameter typing requires an index signature; our row objects
// are plain string/number/null so the cast is safe.
type SqlParams = Record<string, string | number | bigint | null>
const params = (o: object): SqlParams => o as SqlParams

// ---------- settings ----------
const SECRET_SETTINGS = new Set(['anthropic_api_key', 'openai_api_key', 'github_token', 'discord_alert_webhook', 'discord_bot_token', 'lmstudio_api_key'])

function normalizeSetting(key: string, value: string): string {
  // API tokens are often pasted with a trailing newline/space; trim secrets only.
  return SECRET_SETTINGS.has(key) ? value.trim() : value
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  const value = row?.value == null ? null : normalizeSetting(key, row.value)
  return value || null
}

export function setSetting(key: string, value: string): void {
  const normalized = normalizeSetting(key, value)
  // An empty secret is almost always an accidental clear (a blurred input, a
  // failed paste) and would silently sign the user out of a provider.
  if (SECRET_SETTINGS.has(key) && normalized === '') return
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, normalized)
}

/**
 * Remove a setting outright.
 *
 * setSetting deliberately refuses to blank a secret, because an empty write is
 * almost always an accidental clear. Turning a secret OFF on purpose therefore
 * needs its own verb rather than an empty string.
 */
export function deleteSetting(key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as unknown as { key: string; value: string }[]
  return Object.fromEntries(rows.map((r) => [r.key, normalizeSetting(r.key, r.value)]))
}

// ---------- projects ----------
export interface Project {
  id: string
  name: string
  color: string
  created_at: number
}

export function listProjects(): Project[] {
  return db.prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as Project[]
}
export function createProject(name: string, color: string): Project {
  const p: Project = { id: randomUUID(), name, color, created_at: now() }
  db.prepare('INSERT INTO projects (id, name, color, created_at) VALUES (@id, @name, @color, @created_at)').run(params(p))
  return p
}
export function deleteProject(id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}

// ---------- sessions ----------
export interface Session {
  id: string
  title: string
  project_id: string | null
  provider: string
  model: string
  system_prompt: string
  agent_mode: number
  status: string
  /** JSON Participant[] or { seats, maxTurns } — 2+ seats makes it a roundtable. */
  participants: string | null
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

export interface RoundtableConfig {
  seats: Participant[]
  /** Total speaking turns per user message / continue. */
  maxTurns: number
}

const validSeats = (arr: unknown): Participant[] =>
  Array.isArray(arr) ? (arr as Participant[]).filter((p) => p && p.name && p.provider && p.model) : []

/**
 * Read the roundtable config off a session.
 *
 * Two shapes are accepted because the column predates maxTurns: a bare
 * Participant[] (legacy) and the current { seats, maxTurns }. A legacy row gets
 * a derived turn budget rather than zero, which would leave the table silent.
 * Capped at 24 so a wide table cannot run away burning tokens.
 */
export function roundtableConfig(s: Session): RoundtableConfig {
  const empty: RoundtableConfig = { seats: [], maxTurns: 0 }
  if (!s.participants) return empty
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

export function listSessions(): Session[] {
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as unknown as Session[]
}
export function getSession(id: string): Session | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined
}
export function createSession(opts: {
  title?: string
  project_id?: string | null
  provider: string
  model: string
}): Session {
  const s: Session = {
    id: randomUUID(),
    title: opts.title ?? 'New Session',
    project_id: opts.project_id ?? null,
    provider: opts.provider,
    model: opts.model,
    system_prompt: '',
    agent_mode: 1,
    status: 'idle',
    participants: null,
    created_at: now(),
    updated_at: now()
  }
  db.prepare(`INSERT INTO sessions (id, title, project_id, provider, model, system_prompt, agent_mode, status, participants, created_at, updated_at)
    VALUES (@id, @title, @project_id, @provider, @model, @system_prompt, @agent_mode, @status, @participants, @created_at, @updated_at)`).run(params(s))
  return s
}
export function updateSession(id: string, patch: Partial<Session>): void {
  const allowed = ['title', 'project_id', 'provider', 'model', 'system_prompt', 'agent_mode', 'status', 'participants'] as const
  const sets: string[] = []
  const patchParams: Record<string, unknown> = { id }
  for (const k of allowed) {
    if (k in patch) {
      sets.push(`${k} = @${k}`)
      patchParams[k] = (patch as Record<string, unknown>)[k]
    }
  }
  if (!sets.length) return
  sets.push('updated_at = @updated_at')
  patchParams.updated_at = now()
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = @id`).run(params(patchParams))
}
export function deleteSession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

// ---------- messages ----------
export interface ImageAttachment {
  id: string
  kind: 'image'
  mime: string
  /** Also the atlis-media:// host used to render it. */
  filename: string
  name: string
}

export interface Message {
  id: string
  session_id: string
  role: string
  kind: string
  content_md: string
  content_html: string
  tool_name: string | null
  tool_payload: string | null
  /** Roundtable participant name; null for the single-model agent. */
  author: string | null
  attachments: ImageAttachment[]
  created_at: number
}

/** The stored row: a Message whose attachments are still serialized. */
type MessageRow = Omit<Message, 'attachments'> & { attachments: string | null }

/** Rows store attachments as a JSON string; callers always want the array. */
function fromRow(r: MessageRow): Message {
  return { ...r, attachments: r.attachments ? JSON.parse(r.attachments) : [] }
}

export function listMessages(sessionId: string): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid')
    .all(sessionId) as unknown as MessageRow[]
  return rows.map(fromRow)
}

export function addMessage(m: {
  id?: string
  session_id: string
  role: string
  kind: string
  content_md: string
  content_html: string
  tool_name?: string | null
  tool_payload?: string | null
  author?: string | null
  attachments?: ImageAttachment[]
}): Message {
  const id = m.id ?? randomUUID()
  const attachments = m.attachments ?? []
  const row = {
    id,
    session_id: m.session_id,
    role: m.role,
    kind: m.kind,
    content_md: m.content_md,
    content_html: m.content_html,
    tool_name: m.tool_name ?? null,
    tool_payload: m.tool_payload ?? null,
    author: m.author ?? null,
    attachments: attachments.length ? JSON.stringify(attachments) : null,
    created_at: now()
  }
  db.prepare(`INSERT INTO messages (id, session_id, role, kind, content_md, content_html, tool_name, tool_payload, author, attachments, created_at)
    VALUES (@id, @session_id, @role, @kind, @content_md, @content_html, @tool_name, @tool_payload, @author, @attachments, @created_at)`).run(params(row))
  // Adding a message is what marks a session as active, so the sidebar's
  // ordering depends on this touch.
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), m.session_id)
  return { ...row, attachments } as unknown as Message
}

/**
 * Every image filename a session references, so deleting the session can take
 * its media with it rather than orphaning files on disk.
 */
export function sessionImageFilenames(sessionId: string): string[] {
  const rows = db
    .prepare('SELECT attachments FROM messages WHERE session_id = ? AND attachments IS NOT NULL')
    .all(sessionId) as unknown as { attachments: string }[]
  const names: string[] = []
  for (const r of rows) {
    try {
      for (const a of JSON.parse(r.attachments) as ImageAttachment[]) if (a.filename) names.push(a.filename)
    } catch {
      /* one malformed row must not block cleanup of the rest */
    }
  }
  return names
}

// ---------- usage ----------
export interface UsageRow {
  id: string
  session_id: string | null
  project_id: string | null
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd: number
  energy_wh: number
  created_at: number
}

export function addUsage(u: Omit<UsageRow, 'id' | 'created_at'>): void {
  db.prepare(`INSERT INTO usage (id, session_id, project_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, energy_wh, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    randomUUID(),
    u.session_id,
    u.project_id,
    u.provider,
    u.model,
    u.input_tokens,
    u.output_tokens,
    u.cache_read_tokens,
    u.cache_write_tokens,
    u.cost_usd,
    u.energy_wh,
    now()
  )
}


// ---------- documents ----------
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

export function listDocs(): DocMeta[] {
  return db
    .prepare('SELECT id, title, session_id, created_at, updated_at FROM documents ORDER BY updated_at DESC')
    .all() as unknown as DocMeta[]
}
export function getDoc(id: string): Doc | undefined {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as Doc | undefined
}
export function saveDoc(d: { id?: string | null; title: string; html: string; session_id?: string | null }): Doc {
  if (d.id) {
    db.prepare('UPDATE documents SET title = ?, html = ?, updated_at = ? WHERE id = ?').run(d.title, d.html, now(), d.id)
    // The row was just written, so the read back cannot miss.
    return getDoc(d.id) as Doc
  }
  const doc: Doc = {
    id: randomUUID(),
    title: d.title,
    html: d.html,
    session_id: d.session_id ?? null,
    created_at: now(),
    updated_at: now()
  }
  db.prepare('INSERT INTO documents (id, title, html, session_id, created_at, updated_at) VALUES (@id, @title, @html, @session_id, @created_at, @updated_at)').run(params(doc))
  return doc
}
export function deleteDoc(id: string): void {
  db.prepare('DELETE FROM documents WHERE id = ?').run(id)
}

// ---------- planner: calendar / todos / reminders ----------

/**
 * Tags arrive either already serialized (from a row round-trip) or as an array
 * from a caller. Storing the array verbatim would write "[object Object]".
 */
function jsonOrNull(v: unknown): string | null {
  if (v == null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
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

export function createCalendarEvent(e: {
  title: string
  start_at: number
  end_at?: number | null
  all_day?: boolean | number
  timezone?: string | null
  location?: string | null
  notes?: string | null
  tags?: unknown
  source?: string
  external_id?: string | null
  recurrence_rule?: string | null
}): CalendarEvent {
  const row: CalendarEvent = {
    id: randomUUID(),
    title: e.title,
    start_at: Number(e.start_at),
    end_at: e.end_at == null ? null : Number(e.end_at),
    all_day: e.all_day ? 1 : 0,
    timezone: e.timezone ?? null,
    location: e.location ?? null,
    notes: e.notes ?? null,
    tags_json: jsonOrNull(e.tags),
    source: e.source ?? 'local',
    external_id: e.external_id ?? null,
    recurrence_rule: e.recurrence_rule ?? null,
    created_at: now(),
    updated_at: now()
  }
  db.prepare(`INSERT INTO calendar_events (id, title, start_at, end_at, all_day, timezone, location, notes, tags_json, source, external_id, recurrence_rule, created_at, updated_at)
    VALUES (@id, @title, @start_at, @end_at, @all_day, @timezone, @location, @notes, @tags_json, @source, @external_id, @recurrence_rule, @created_at, @updated_at)`).run(params(row))
  return row
}

export function listCalendarEvents(startAt: number, endAt: number, query?: string): CalendarEvent[] {
  if (query?.trim()) {
    return db.prepare(`SELECT * FROM calendar_events WHERE start_at >= ? AND start_at <= ? AND title LIKE ? ORDER BY start_at, rowid`)
      .all(Number(startAt), Number(endAt), `%${query.trim()}%`) as unknown as CalendarEvent[]
  }
  return db.prepare('SELECT * FROM calendar_events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at, rowid')
    .all(Number(startAt), Number(endAt)) as unknown as CalendarEvent[]
}

export function updateCalendarEvent(id: string, patch: Partial<CalendarEvent> & { tags?: unknown }): void {
  const allowed = ['title', 'start_at', 'end_at', 'all_day', 'timezone', 'location', 'notes', 'source', 'external_id', 'recurrence_rule'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if ('tags' in patch) { sets.push('tags_json = @tags_json'); p.tags_json = jsonOrNull(patch.tags) }
  if (!sets.length) return
  sets.push('updated_at = @updated_at')
  p.updated_at = now()
  db.prepare(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function deleteCalendarEvent(id: string): void {
  db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
}

/**
 * Lookup by the pair that identifies an imported event. Feature syncs (the MTG
 * release calendar, for one) use this to move an existing event when its date
 * slips rather than inserting a duplicate.
 */
export function findCalendarEventByExternalId(source: string, externalId: string): CalendarEvent | undefined {
  return db.prepare('SELECT * FROM calendar_events WHERE source = ? AND external_id = ?').get(source, externalId) as CalendarEvent | undefined
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

export function createTodo(t: {
  title: string
  notes?: string | null
  priority?: string
  due_at?: number | null
  scheduled_at?: number | null
  tags?: unknown
  source?: string
  external_id?: string | null
}): TodoItem {
  const row: TodoItem = {
    id: randomUUID(),
    title: t.title,
    notes: t.notes ?? null,
    status: 'active',
    priority: t.priority ?? 'normal',
    due_at: t.due_at == null ? null : Number(t.due_at),
    scheduled_at: t.scheduled_at == null ? null : Number(t.scheduled_at),
    tags_json: jsonOrNull(t.tags),
    source: t.source ?? 'local',
    external_id: t.external_id ?? null,
    completed_at: null,
    created_at: now(),
    updated_at: now()
  }
  db.prepare(`INSERT INTO todos (id, title, notes, status, priority, due_at, scheduled_at, tags_json, source, external_id, completed_at, created_at, updated_at)
    VALUES (@id, @title, @notes, @status, @priority, @due_at, @scheduled_at, @tags_json, @source, @external_id, @completed_at, @created_at, @updated_at)`).run(params(row))
  return row
}

export function listTodos(filter?: {
  status?: string
  priority?: string
  dueBefore?: number | null
  tag?: string
}): TodoItem[] {
  const where: string[] = []
  const p: Record<string, unknown> = {}
  if (filter?.status) { where.push('status = @status'); p.status = filter.status }
  if (filter?.priority) { where.push('priority = @priority'); p.priority = filter.priority }
  if (filter?.dueBefore != null) { where.push('due_at IS NOT NULL AND due_at <= @dueBefore'); p.dueBefore = Number(filter.dueBefore) }
  if (filter?.tag) { where.push('tags_json LIKE @tag'); p.tag = `%${filter.tag}%` }
  // High first, then soonest due; undated todos sort last via a max-int
  // COALESCE rather than being dropped by the comparison.
  const sql = `SELECT * FROM todos${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, COALESCE(due_at, 9223372036854775807), created_at DESC`
  return db.prepare(sql).all(params(p)) as unknown as TodoItem[]
}

export function updateTodo(id: string, patch: Partial<TodoItem> & { tags?: unknown }): void {
  const allowed = ['title', 'notes', 'status', 'priority', 'due_at', 'scheduled_at', 'source', 'external_id', 'completed_at'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if ('tags' in patch) { sets.push('tags_json = @tags_json'); p.tags_json = jsonOrNull(patch.tags) }
  if (!sets.length) return
  sets.push('updated_at = @updated_at')
  p.updated_at = now()
  db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function completeTodo(id: string): void {
  updateTodo(id, { status: 'completed', completed_at: now() })
}

export function deleteTodo(id: string): void {
  db.prepare('DELETE FROM todos WHERE id = ?').run(id)
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

export function createReminder(r: {
  title: string
  remind_at: number
  linked_type?: string | null
  linked_id?: string | null
}): ReminderItem {
  const row: ReminderItem = {
    id: randomUUID(),
    title: r.title,
    remind_at: Number(r.remind_at),
    status: 'pending',
    linked_type: r.linked_type ?? null,
    linked_id: r.linked_id ?? null,
    notification_sent_at: null,
    snoozed_until: null,
    created_at: now(),
    updated_at: now()
  }
  db.prepare(`INSERT INTO reminders (id, title, remind_at, status, linked_type, linked_id, notification_sent_at, snoozed_until, created_at, updated_at)
    VALUES (@id, @title, @remind_at, @status, @linked_type, @linked_id, @notification_sent_at, @snoozed_until, @created_at, @updated_at)`).run(params(row))
  return row
}

export function listReminders(startAt?: number | null, endAt?: number | null, status?: string): ReminderItem[] {
  const where: string[] = []
  const p: Record<string, unknown> = {}
  if (startAt != null) { where.push('remind_at >= @startAt'); p.startAt = Number(startAt) }
  if (endAt != null) { where.push('remind_at <= @endAt'); p.endAt = Number(endAt) }
  if (status) { where.push('status = @status'); p.status = status }
  return db.prepare(`SELECT * FROM reminders${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY remind_at, rowid`)
    .all(params(p)) as unknown as ReminderItem[]
}

export function updateReminder(id: string, patch: Partial<ReminderItem>): void {
  const allowed = ['title', 'remind_at', 'status', 'linked_type', 'linked_id', 'notification_sent_at', 'snoozed_until'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if (!sets.length) return
  sets.push('updated_at = @updated_at')
  p.updated_at = now()
  db.prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function deleteReminder(id: string): void {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(id)
}

// ---------- feed ----------
export interface FeedSource {
  id: string; kind: string; title: string; url: string; handle: string | null; icon: string | null
  category: string | null; enabled: number; last_fetched_at: number | null; last_error: string | null; created_at: number
}
export interface FeedItem {
  id: string; source_id: string; kind: string; title: string; url: string; author: string | null
  summary: string | null; thumbnail: string | null; published_at: number | null; score: number | null
  comments: number | null; extra_json: string | null; is_read: number; is_saved: number; is_hidden: number
  fetched_at: number; created_at: number
}
/** A feed item joined with its source's display title. */
export interface FeedItemJoined extends FeedItem { source_title: string }

export function listFeedSources(): FeedSource[] {
  return db.prepare('SELECT * FROM feed_sources ORDER BY created_at').all() as unknown as FeedSource[]
}
export function getFeedSource(id: string): FeedSource | undefined {
  return db.prepare('SELECT * FROM feed_sources WHERE id = ?').get(id) as FeedSource | undefined
}
export function createFeedSource(s: {
  kind: string; title: string; url: string; handle?: string | null; icon?: string | null; category?: string | null
}): FeedSource {
  const row: FeedSource = {
    id: randomUUID(), kind: s.kind, title: s.title, url: s.url, handle: s.handle ?? null, icon: s.icon ?? null,
    category: s.category ?? null, enabled: 1, last_fetched_at: null, last_error: null, created_at: now()
  }
  db.prepare(`INSERT INTO feed_sources (id, kind, title, url, handle, icon, category, enabled, last_fetched_at, last_error, created_at)
    VALUES (@id, @kind, @title, @url, @handle, @icon, @category, @enabled, @last_fetched_at, @last_error, @created_at)`).run(params(row))
  return row
}
export function updateFeedSource(id: string, patch: Partial<FeedSource>): void {
  const allowed = ['kind', 'title', 'url', 'handle', 'icon', 'category', 'enabled', 'last_fetched_at', 'last_error'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if (!sets.length) return
  db.prepare(`UPDATE feed_sources SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}
export function deleteFeedSource(id: string): void { db.prepare('DELETE FROM feed_sources WHERE id = ?').run(id) }

/**
 * Insert a fetched item, or refresh its volatile fields if already present.
 * User state (is_read / is_saved / is_hidden) is never overwritten so a refresh
 * keeps your reading position. Returns true if the row was newly inserted.
 */
export function upsertFeedItem(it: {
  id: string; source_id: string; kind: string; title: string; url: string; author?: string | null
  summary?: string | null; thumbnail?: string | null; published_at?: number | null; score?: number | null
  comments?: number | null; extra_json?: string | null
}): boolean {
  const existing = db.prepare('SELECT id FROM feed_items WHERE id = ?').get(it.id) as { id: string } | undefined
  if (existing) {
    db.prepare(`UPDATE feed_items SET title = @title, url = @url, author = @author, summary = @summary,
      thumbnail = @thumbnail, published_at = @published_at, score = @score, comments = @comments,
      extra_json = @extra_json, fetched_at = @fetched_at WHERE id = @id`).run(params({
        id: it.id, title: it.title, url: it.url, author: it.author ?? null, summary: it.summary ?? null,
        thumbnail: it.thumbnail ?? null, published_at: it.published_at ?? null, score: it.score ?? null,
        comments: it.comments ?? null, extra_json: it.extra_json ?? null, fetched_at: now()
      }))
    return false
  }
  db.prepare(`INSERT INTO feed_items (id, source_id, kind, title, url, author, summary, thumbnail, published_at, score, comments, extra_json, is_read, is_saved, is_hidden, fetched_at, created_at)
    VALUES (@id, @source_id, @kind, @title, @url, @author, @summary, @thumbnail, @published_at, @score, @comments, @extra_json, 0, 0, 0, @fetched_at, @created_at)`).run(params({
      id: it.id, source_id: it.source_id, kind: it.kind, title: it.title, url: it.url, author: it.author ?? null,
      summary: it.summary ?? null, thumbnail: it.thumbnail ?? null, published_at: it.published_at ?? null,
      score: it.score ?? null, comments: it.comments ?? null, extra_json: it.extra_json ?? null,
      fetched_at: now(), created_at: now()
    }))
  return true
}

export function listFeedItems(opt?: {
  filter?: 'all' | 'unread' | 'saved'; kind?: string; sourceId?: string; limit?: number; offset?: number
}): FeedItemJoined[] {
  // A disabled source stays in the table but drops out of the timeline, so
  // toggling it off is instant and reversible without losing its items.
  const where: string[] = ['i.is_hidden = 0', 's.enabled = 1']
  const p: Record<string, unknown> = {}
  if (opt?.filter === 'unread') where.push('i.is_read = 0')
  if (opt?.filter === 'saved') where.push('i.is_saved = 1')
  if (opt?.kind) { where.push('i.kind = @kind'); p.kind = opt.kind }
  if (opt?.sourceId) { where.push('i.source_id = @sourceId'); p.sourceId = opt.sourceId }
  p.limit = Math.min(Math.max(opt?.limit ?? 100, 1), 500)
  p.offset = opt?.offset ?? 0
  return db.prepare(`SELECT i.*, s.title AS source_title FROM feed_items i JOIN feed_sources s ON s.id = i.source_id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(i.published_at, i.fetched_at) DESC
    LIMIT @limit OFFSET @offset`).all(params(p)) as unknown as FeedItemJoined[]
}

export function getFeedItem(id: string): FeedItem | undefined {
  return db.prepare('SELECT * FROM feed_items WHERE id = ?').get(id) as FeedItem | undefined
}

export function setFeedItemState(id: string, patch: { is_read?: boolean; is_saved?: boolean; is_hidden?: boolean }): void {
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  if ('is_read' in patch) { sets.push('is_read = @is_read'); p.is_read = patch.is_read ? 1 : 0 }
  if ('is_saved' in patch) { sets.push('is_saved = @is_saved'); p.is_saved = patch.is_saved ? 1 : 0 }
  if ('is_hidden' in patch) { sets.push('is_hidden = @is_hidden'); p.is_hidden = patch.is_hidden ? 1 : 0 }
  if (!sets.length) return
  db.prepare(`UPDATE feed_items SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function markFeedRead(sourceId?: string): void {
  if (sourceId) db.prepare('UPDATE feed_items SET is_read = 1 WHERE source_id = ? AND is_hidden = 0').run(sourceId)
  else db.prepare('UPDATE feed_items SET is_read = 1 WHERE is_hidden = 0').run()
}

export function feedUnreadCounts(): Record<string, number> {
  const rows = db.prepare(`SELECT source_id, COUNT(*) n FROM feed_items WHERE is_read = 0 AND is_hidden = 0 GROUP BY source_id`)
    .all() as unknown as { source_id: string; n: number }[]
  return Object.fromEntries(rows.map((r) => [r.source_id, r.n]))
}

/**
 * Cap history per source. Saved items are exempt — the point of saving one is
 * that it outlives the rolling window.
 */
export function pruneFeedItems(keepPerSource = 250): void {
  db.prepare(`DELETE FROM feed_items WHERE is_saved = 0 AND id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY COALESCE(published_at, fetched_at) DESC) rn
      FROM feed_items
    ) WHERE rn > @keep
  )`).run(params({ keep: keepPerSource }))
}

// ---------- memories ----------
export interface MemoryRow {
  id: string
  text: string
  category: string
  session_id: string | null
  created_at: number
  updated_at: number
}

export function addMemory(m: { text: string; category?: string | null; session_id?: string | null }): MemoryRow {
  const row: MemoryRow = {
    id: randomUUID(),
    text: m.text.trim(),
    category: (m.category || 'general').trim().toLowerCase(),
    session_id: m.session_id ?? null,
    created_at: now(),
    updated_at: now()
  }
  db.prepare(`INSERT INTO memories (id, text, category, session_id, created_at, updated_at)
    VALUES (@id, @text, @category, @session_id, @created_at, @updated_at)`).run(params(row))
  return row
}

export function updateMemory(id: string, text: string, category?: string | null): boolean {
  const sets = ['text = @text', 'updated_at = @updated_at']
  const p: Record<string, unknown> = { id, text: text.trim(), updated_at: now() }
  if (category) { sets.push('category = @category'); p.category = category.trim().toLowerCase() }
  const r = db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
  return Number(r.changes) > 0
}

export function deleteMemory(id: string): boolean {
  return Number(db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes) > 0
}

export function listMemories(category?: string, limit = 200): MemoryRow[] {
  if (category) {
    return db.prepare('SELECT * FROM memories WHERE category = ? ORDER BY updated_at DESC LIMIT ?')
      .all(category.trim().toLowerCase(), limit) as unknown as MemoryRow[]
  }
  return db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as MemoryRow[]
}

/**
 * Recall by relevance, FTS5 when the build has it and LIKE when it doesn't.
 *
 * Words are OR-ed rather than AND-ed: recall should surface a partial match,
 * because the agent rarely phrases a query the way the memory was written.
 * Quote characters are stripped because they are FTS5 syntax — a stray
 * apostrophe would otherwise throw rather than search.
 */
export function searchMemories(query: string, limit = 12): MemoryRow[] {
  const words = query.split(/\s+/).map((w) => w.replace(/["'*^]/g, '')).filter((w) => w.length > 1)
  if (!words.length) return listMemories(undefined, limit)
  if (memoryFtsAvailable) {
    try {
      const match = words.map((w) => `"${w}"`).join(' OR ')
      return db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
        WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, limit) as unknown as MemoryRow[]
    } catch { /* fall through to LIKE */ }
  }
  const where = words.map((_, i) => `text LIKE @w${i}`).join(' OR ')
  const p: Record<string, unknown> = { limit }
  words.forEach((w, i) => { p[`w${i}`] = `%${w}%` })
  return db.prepare(`SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC LIMIT @limit`)
    .all(params(p)) as unknown as MemoryRow[]
}

export function memoryCount(): number {
  return (db.prepare('SELECT COUNT(*) n FROM memories').get() as unknown as { n: number }).n
}

// ---------- arena (blind model comparison) ----------
export interface ComparisonRow {
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

export function createComparison(c: {
  prompt: string; provider_a: string; model_a: string; provider_b: string; model_b: string; is_blind?: boolean
}): ComparisonRow {
  const row: ComparisonRow = {
    id: randomUUID(),
    prompt: c.prompt,
    provider_a: c.provider_a,
    model_a: c.model_a,
    provider_b: c.provider_b,
    model_b: c.model_b,
    response_a: '',
    response_b: '',
    cost_a: 0,
    cost_b: 0,
    latency_a_ms: null,
    latency_b_ms: null,
    winner: null,
    is_blind: c.is_blind ? 1 : 0,
    status: 'running',
    error: null,
    created_at: now()
  }
  db.prepare(`INSERT INTO comparisons (id, prompt, provider_a, model_a, provider_b, model_b, response_a, response_b,
    cost_a, cost_b, latency_a_ms, latency_b_ms, winner, is_blind, status, error, created_at)
    VALUES (@id, @prompt, @provider_a, @model_a, @provider_b, @model_b, @response_a, @response_b,
    @cost_a, @cost_b, @latency_a_ms, @latency_b_ms, @winner, @is_blind, @status, @error, @created_at)`).run(params(row))
  return row
}

export function patchComparison(id: string, patch: Partial<ComparisonRow>): void {
  const allowed = ['response_a', 'response_b', 'cost_a', 'cost_b', 'latency_a_ms', 'latency_b_ms', 'winner', 'status', 'error'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if (!sets.length) return
  db.prepare(`UPDATE comparisons SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function getComparison(id: string): ComparisonRow | undefined {
  return db.prepare('SELECT * FROM comparisons WHERE id = ?').get(id) as ComparisonRow | undefined
}

export function listComparisons(limit = 50): ComparisonRow[] {
  return db.prepare('SELECT * FROM comparisons ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as ComparisonRow[]
}

export function deleteComparison(id: string): void {
  db.prepare('DELETE FROM comparisons WHERE id = ?').run(id)
}

// ---------- vault ----------
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
  /** melt | market | manual */
  kind: string
  value_mid: number
  value_low: number | null
  value_high: number | null
  spot_price: number | null
  source: string | null
  notes: string | null
  created_at: number
}

/** item_id -> kind -> latest valuation */
export type VaultLatest = Record<string, Partial<Record<string, VaultValuation>>>

/** The stored row: a VaultItem whose photos are still serialized. */
type VaultRow = Omit<VaultItem, 'photos'> & { photos: string | null }

/** Photos are stored as a JSON string; a malformed value degrades to none. */
function vaultFromRow(r: VaultRow): VaultItem {
  let photos: ImageAttachment[] = []
  try {
    photos = r.photos ? JSON.parse(r.photos) : []
  } catch { /* keep the item, lose only its photos */ }
  return { ...r, photos }
}

export function listVaultItems(category?: string): VaultItem[] {
  const rows = (category
    ? db.prepare('SELECT * FROM vault_items WHERE category = ? ORDER BY created_at').all(category)
    : db.prepare('SELECT * FROM vault_items ORDER BY created_at').all()) as unknown as VaultRow[]
  return rows.map(vaultFromRow)
}

export function getVaultItem(id: string): VaultItem | undefined {
  const row = db.prepare('SELECT * FROM vault_items WHERE id = ?').get(id) as VaultRow | undefined
  return row ? vaultFromRow(row) : undefined
}

export function createVaultItem(i: {
  category?: string
  name: string
  year?: string | null
  maker?: string | null
  grade?: string | null
  quantity?: number
  metal?: string | null
  metal_weight_ozt?: number | null
  purchase_price?: number | null
  purchase_date?: string | null
  notes?: string | null
  ext_source?: string | null
  ext_id?: string | null
  variant?: string | null
}): VaultItem {
  const row = {
    id: randomUUID(),
    category: (i.category || 'coin').trim().toLowerCase(),
    name: i.name.trim(),
    year: i.year ?? null,
    maker: i.maker ?? null,
    grade: i.grade ?? null,
    // Quantity is a count of physical copies — never zero or fractional, and a
    // non-numeric input falls back to one rather than wiping the holding.
    quantity: Math.max(1, Math.round(Number(i.quantity ?? 1)) || 1),
    metal: i.metal ? String(i.metal).trim().toLowerCase() : null,
    metal_weight_ozt: i.metal_weight_ozt == null ? null : Number(i.metal_weight_ozt),
    purchase_price: i.purchase_price == null ? null : Number(i.purchase_price),
    purchase_date: i.purchase_date ?? null,
    notes: i.notes ?? null,
    photos: null,
    ext_source: i.ext_source ?? null,
    ext_id: i.ext_id ?? null,
    variant: i.variant ?? null,
    created_at: now(),
    updated_at: now()
  }
  db.prepare(`INSERT INTO vault_items (id, category, name, year, maker, grade, quantity, metal, metal_weight_ozt, purchase_price, purchase_date, notes, photos, ext_source, ext_id, variant, created_at, updated_at)
    VALUES (@id, @category, @name, @year, @maker, @grade, @quantity, @metal, @metal_weight_ozt, @purchase_price, @purchase_date, @notes, @photos, @ext_source, @ext_id, @variant, @created_at, @updated_at)`).run(params(row))
  return { ...row, photos: [] } as unknown as VaultItem
}

export function updateVaultItem(id: string, patch: Partial<VaultItem>): void {
  const allowed = ['category', 'name', 'year', 'maker', 'grade', 'quantity', 'metal', 'metal_weight_ozt', 'purchase_price', 'purchase_date', 'notes', 'ext_source', 'ext_id', 'variant'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if ('photos' in patch) {
    sets.push('photos = @photos')
    p.photos = patch.photos?.length ? JSON.stringify(patch.photos) : null
  }
  if (!sets.length) return
  sets.push('updated_at = @updated_at')
  p.updated_at = now()
  db.prepare(`UPDATE vault_items SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function deleteVaultItem(id: string): void {
  db.prepare('DELETE FROM vault_items WHERE id = ?').run(id)
}

export function addVaultValuation(v: {
  item_id: string
  kind: string
  value_mid: number
  value_low?: number | null
  value_high?: number | null
  spot_price?: number | null
  source?: string | null
  notes?: string | null
}): VaultValuation {
  const row: VaultValuation = {
    id: randomUUID(),
    item_id: v.item_id,
    kind: v.kind,
    value_mid: Number(v.value_mid),
    value_low: v.value_low == null ? null : Number(v.value_low),
    value_high: v.value_high == null ? null : Number(v.value_high),
    spot_price: v.spot_price == null ? null : Number(v.spot_price),
    source: v.source ?? null,
    notes: v.notes ?? null,
    created_at: now()
  }
  db.prepare(`INSERT INTO vault_valuations (id, item_id, kind, value_mid, value_low, value_high, spot_price, source, notes, created_at)
    VALUES (@id, @item_id, @kind, @value_mid, @value_low, @value_high, @spot_price, @source, @notes, @created_at)`).run(params(row))
  return row
}

export function listVaultValuations(itemId: string, kind?: string): VaultValuation[] {
  return (kind
    ? db.prepare('SELECT * FROM vault_valuations WHERE item_id = ? AND kind = ? ORDER BY created_at').all(itemId, kind)
    : db.prepare('SELECT * FROM vault_valuations WHERE item_id = ? ORDER BY created_at').all(itemId)) as unknown as VaultValuation[]
}

/** The newest valuation of each kind for every item, in one pass. */
export function latestVaultValuations(): VaultLatest {
  const rows = db.prepare(`SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY item_id, kind ORDER BY created_at DESC) rn
    FROM vault_valuations
  ) WHERE rn = 1`).all() as unknown as VaultValuation[]
  const out: VaultLatest = {}
  for (const r of rows) {
    (out[r.item_id] ??= {})[r.kind] = r
  }
  return out
}

/**
 * Drop today's valuations of one kind so a re-run replaces rather than stacks.
 * The day boundary is local, matching how the history is displayed.
 */
export function deleteVaultValuationsToday(itemId: string, kind: string): void {
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  db.prepare('DELETE FROM vault_valuations WHERE item_id = ? AND kind = ? AND created_at >= ?').run(itemId, kind, dayStart.getTime())
}

// ---------- mtg ----------
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
  /** card | sealed */
  kind: string
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
  /** hunt | market, or null to let lifecycle.ts derive it. */
  mode_override: string | null
  msrp: number | null
  /** manual | inferred — an inferred MSRP is the lowest first-party price seen. */
  msrp_source: string | null
  created_at: number
  updated_at: number
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

export interface MtgSealed {
  uuid: string
  name: string
  set_code: string
  category: string | null
  subtype: string | null
  release_date: string | null
  tcgplayer_product_id: string | null
  card_kingdom_id: string | null
  synced_at: number
}

export interface MtgSlUpcoming {
  id: string
  drop_id: string | null
  drop_name: string | null
  drop_release_date: string | null
  name: string
  picture: string | null
  release_date: string | null
  msrp: number | null
  foil: number
  etched: number
  randomized: number
  synced_at: number
}

export interface MtgListing {
  id: string
  watch_id: string | null
  vault_item_id: string | null
  sealed_uuid: string | null
  retailer: string
  /** product | searched | search | manual */
  kind: string
  title: string | null
  url: string
  price: number | null
  status: string
  /** The retailer's verbatim state behind `status`, e.g. Best Buy's SOLD_OUT. */
  raw_state: string | null
  last_checked_at: number | null
  last_error: string | null
  deal_alert_at: number | null
  created_at: number
  updated_at: number
}

export interface MtgEvRow {
  uuid: string
  set_code: string
  name: string
  kind: string
  tcgplayer_product_id: string | null
  price: number | null
  ev_mean: number | null
  ev_median: number | null
  ev_liquid: number | null
  method: string
  packs: number
  chance_of_profit: number | null
  net: number | null
  net_pct: number | null
  note: string | null
  priced_at: number | null
  computed_at: number
  engine: number
  basis: string
}

/** One owned MTG row, joined to its newest observed price. */
export interface MtgOwnedRow {
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
  points: number
  /** How many separate vault rows this line represents (1 unless stacked). */
  entries: number
  /** Newest observed day, YYYY-MM-DD. */
  last_on: string | null
  /** Price on the previous observed day — null until there are two points. */
  prev_price: number | null
  prev_on: string | null
  /** Sorted WUBRG letters, '' for colourless. Null when the card is unsynced. */
  color_identity: string | null
  type_line: string | null
  mana_cost: string | null
  cmc: number | null
  oracle_id: string | null
  set_code: string | null
  rarity: string | null
  /** EDHTop16 cEDH play rate, 0..1. Null = not synced yet OR never played (see cedh_synced). */
  cedh_play_rate: number | null
  /** 1 once EDHTop16 has been asked about this card. */
  cedh_synced: number
}

/** cEDH play rates, keyed by Scryfall card name. */
export function upsertCedhStats(rows: Array<{ name: string; play_rate: number | null }>): void {
  const at = now()
  const ins = db.prepare(`INSERT INTO mtg_cedh_stats (name, play_rate, synced_at) VALUES (@name, @play_rate, @synced_at)
    ON CONFLICT(name) DO UPDATE SET play_rate = excluded.play_rate, synced_at = excluded.synced_at`)
  db.exec('BEGIN')
  try {
    for (const r of rows) ins.run(params({ ...r, synced_at: at }))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/**
 * Owned card names (Scryfall's spelling) whose cEDH rate is missing or older
 * than staleBefore. Sealed rows have no card name to ask about.
 */
export function listCedhStaleNames(staleBefore: number): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT m.name FROM vault_items v
    JOIN mtg_card_meta m ON m.ext_id = v.ext_id
    LEFT JOIN mtg_cedh_stats c ON c.name = m.name
    WHERE v.ext_source = 'scryfall' AND v.category != 'mtg_sealed'
      AND (c.name IS NULL OR c.synced_at < ?)
    ORDER BY m.name`).all(staleBefore) as unknown as Array<{ name: string }>
  return rows.map((r) => r.name)
}

/** Stored cEDH rates for these names (any card, owned or not). Names with no row are absent. */
export function getCedhStats(names: string[]): Map<string, { play_rate: number | null; synced_at: number }> {
  const out = new Map<string, { play_rate: number | null; synced_at: number }>()
  const stmt = db.prepare('SELECT name, play_rate, synced_at FROM mtg_cedh_stats WHERE name = ?')
  for (const n of new Set(names)) {
    const r = stmt.get(n) as { name: string; play_rate: number | null; synced_at: number } | undefined
    if (r) out.set(r.name, { play_rate: r.play_rate, synced_at: r.synced_at })
  }
  return out
}

/** One cached Scryfall printing. Mirrors the mtg_card_meta columns. */
export interface MtgCardMetaRow {
  ext_id: string
  oracle_id: string | null
  name: string
  name_key: string
  set_code: string | null
  set_name: string | null
  collector_number: string | null
  rarity: string | null
  mana_cost: string | null
  cmc: number | null
  type_line: string | null
  oracle_text: string | null
  color_identity: string
  colors: string
  keywords: string | null
  legal_commander: number
  edhrec_rank: number | null
  reserved: number
  synced_at: number
}

/**
 * Fold a card name to a comparison key.
 *
 * EDHREC, Scryfall and the vault do not agree on punctuation — curly vs
 * straight apostrophes, accented letters, and the " // " of a double-faced
 * card whose front face is the only name EDHREC lists. Everything that varies
 * is stripped so "Lim-Dul the Necromancer" and "Lim-Dûl the Necromancer" are
 * the same commander.
 */
export function cardNameKey(name: string): string {
  const front = name.split(' // ')[0]
  return front
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // drop combining accents
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export interface MtgCommanderStat {
  name_key: string
  name: string
  slug: string | null
  num_decks: number
  potential_decks: number | null
  color_slug: string
  rank_in_color: number
  synced_at: number
}

/**
 * Replace one colour's commander rankings.
 *
 * Wholesale rather than upsert: the upstream list is a top-100 snapshot, so a
 * commander that has dropped off it must lose its row, not keep a stale rank
 * forever. Wrapped in a transaction so a mid-sync failure cannot leave a
 * colour with no rows at all.
 */
export function replaceCommanderStats(colorSlug: string, rows: Omit<MtgCommanderStat, 'color_slug' | 'synced_at'>[]): void {
  const at = now()
  const del = db.prepare('DELETE FROM mtg_commander_stats WHERE color_slug = ?')
  const ins = db.prepare(`INSERT INTO mtg_commander_stats (name_key, name, slug, num_decks, potential_decks, color_slug, rank_in_color, synced_at)
    VALUES (@name_key, @name, @slug, @num_decks, @potential_decks, @color_slug, @rank_in_color, @synced_at)
    ON CONFLICT(name_key) DO UPDATE SET
      name = excluded.name, slug = excluded.slug, num_decks = excluded.num_decks,
      potential_decks = excluded.potential_decks, color_slug = excluded.color_slug,
      rank_in_color = excluded.rank_in_color, synced_at = excluded.synced_at`)
  db.exec('BEGIN')
  try {
    del.run(colorSlug)
    for (const r of rows) ins.run(params({ ...r, color_slug: colorSlug, synced_at: at }))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** The most-built commanders across every colour, for the deck explorer. */
export function listTopCommanderStats(limit: number): MtgCommanderStat[] {
  return db.prepare('SELECT * FROM mtg_commander_stats ORDER BY num_decks DESC LIMIT ?')
    .all(Math.max(1, Math.min(5000, Math.floor(limit)))) as unknown as MtgCommanderStat[]
}

export function countCommanderStats(): { rows: number; synced_at: number | null } {
  const r = db.prepare('SELECT COUNT(*) AS rows, MAX(synced_at) AS synced_at FROM mtg_commander_stats')
    .get() as unknown as { rows: number; synced_at: number | null }
  return r
}

/** An owned card that is legal to head a deck, with how much the world plays it. */
export interface OwnedCommanderRow {
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
  /** Null when EDHREC does not rank it — i.e. outside the top 100 of its colours. */
  num_decks: number | null
  rank_in_color: number | null
  color_slug: string | null
  edhrec_slug: string | null
}

/**
 * Owned cards that can legally be a commander, ranked by how many real decks
 * run them.
 *
 * "Can be a commander" is a Legendary Creature, plus the handful of cards
 * whose rules text grants it (planeswalkers like Teferi, Backgrounds, Grist).
 * Checking oracle text for that grant is what keeps the list honest rather
 * than a naive type-line filter.
 *
 * NULLs sort last: a commander EDHREC does not rank is the "nobody builds
 * this" answer, which belongs at the bottom, not the top.
 *
 * Grouped by name rather than by vault row, because three printings of the
 * same legend are one commander to build around, not three candidates. The
 * quantities add up and the cheapest printing's id represents the group, since
 * that is the copy you would actually sleeve.
 */
export function listOwnedCommanders(): OwnedCommanderRow[] {
  return db.prepare(`
    WITH owned AS (
      SELECT v.id, m.name, m.name_key, v.ext_id, v.ext_source, v.quantity, m.set_code, m.rarity,
        m.type_line, m.oracle_text, m.color_identity,
        (SELECT p.price FROM mtg_prices p
          WHERE p.ext_id = v.ext_id AND p.variant = v.variant
          ORDER BY p.observed_on DESC LIMIT 1) AS last_price
      FROM vault_items v
      JOIN mtg_card_meta m ON m.ext_id = v.ext_id
      WHERE v.ext_source = 'scryfall' AND v.category != 'mtg_sealed'
        AND (m.type_line LIKE '%Legendary%Creature%'
             OR m.oracle_text LIKE '%can be your commander%')
    )
    SELECT o.id, o.name, o.ext_id, o.ext_source, o.qty AS quantity, o.set_code, o.rarity,
      o.type_line, o.oracle_text, o.color_identity, o.last_price,
      cs.num_decks, cs.rank_in_color, cs.color_slug, cs.slug AS edhrec_slug
    FROM (
      -- min(last_price) picks the group's representative row; SQLite's
      -- bare-column rule then carries THAT row's id, set and image with it,
      -- rather than an arbitrary one.
      SELECT *, SUM(quantity) AS qty, MIN(COALESCE(last_price, 1e9)) AS cheapest
      FROM owned GROUP BY name_key
    ) o
    LEFT JOIN mtg_commander_stats cs ON cs.name_key = o.name_key
    ORDER BY cs.num_decks IS NULL, cs.num_decks DESC, o.name
  `).all() as unknown as OwnedCommanderRow[]
}

export function upsertMtgCardMeta(m: Omit<MtgCardMetaRow, 'synced_at' | 'name_key'>): void {
  db.prepare(`INSERT INTO mtg_card_meta (ext_id, oracle_id, name, name_key, set_code, set_name, collector_number, rarity,
      mana_cost, cmc, type_line, oracle_text, color_identity, colors, keywords, legal_commander, edhrec_rank, reserved, synced_at)
    VALUES (@ext_id, @oracle_id, @name, @name_key, @set_code, @set_name, @collector_number, @rarity,
      @mana_cost, @cmc, @type_line, @oracle_text, @color_identity, @colors, @keywords, @legal_commander, @edhrec_rank, @reserved, @synced_at)
    ON CONFLICT(ext_id) DO UPDATE SET
      oracle_id = excluded.oracle_id, name = excluded.name, name_key = excluded.name_key, set_code = excluded.set_code,
      set_name = excluded.set_name, collector_number = excluded.collector_number, rarity = excluded.rarity,
      mana_cost = excluded.mana_cost, cmc = excluded.cmc, type_line = excluded.type_line,
      oracle_text = excluded.oracle_text, color_identity = excluded.color_identity, colors = excluded.colors,
      keywords = excluded.keywords, legal_commander = excluded.legal_commander,
      edhrec_rank = excluded.edhrec_rank, reserved = excluded.reserved, synced_at = excluded.synced_at`)
    .run(params({ ...m, name_key: cardNameKey(m.name), synced_at: now() }))
}

/**
 * Owned scryfall ids with no cached metadata yet.
 *
 * Drives the sync: only the gap is fetched, so adding one card to the vault
 * costs one Scryfall call rather than re-pulling the whole collection.
 */
export function listMtgCardMetaGaps(): string[] {
  return (db.prepare(`
    SELECT DISTINCT v.ext_id FROM vault_items v
    LEFT JOIN mtg_card_meta m ON m.ext_id = v.ext_id
    WHERE v.ext_id IS NOT NULL AND v.ext_id != '' AND v.ext_source = 'scryfall'
      AND v.category != 'mtg_sealed' AND m.ext_id IS NULL
  `).all() as unknown as { ext_id: string }[]).map((r) => r.ext_id)
}

export function upsertMtgSet(s: Omit<MtgSet, 'synced_at'>): void {
  db.prepare(`INSERT INTO mtg_sets (code, name, set_type, released_at, card_count, digital, icon_svg_uri, scryfall_uri, parent_set_code, synced_at)
    VALUES (@code, @name, @set_type, @released_at, @card_count, @digital, @icon_svg_uri, @scryfall_uri, @parent_set_code, @synced_at)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name, set_type = excluded.set_type, released_at = excluded.released_at,
      card_count = excluded.card_count, digital = excluded.digital, icon_svg_uri = excluded.icon_svg_uri,
      scryfall_uri = excluded.scryfall_uri, parent_set_code = excluded.parent_set_code,
      synced_at = excluded.synced_at`).run(params({ ...s, synced_at: now() }))
}

export function listMtgSets(): MtgSet[] {
  return db.prepare('SELECT * FROM mtg_sets ORDER BY released_at DESC').all() as unknown as MtgSet[]
}

export function listMtgWatchlist(): MtgWatch[] {
  return db.prepare('SELECT * FROM mtg_watchlist ORDER BY created_at DESC').all() as unknown as MtgWatch[]
}

export function getMtgWatch(id: string): MtgWatch | undefined {
  return db.prepare('SELECT * FROM mtg_watchlist WHERE id = ?').get(id) as MtgWatch | undefined
}

export function createMtgWatch(w: {
  kind?: string
  name: string
  set_code?: string | null
  collector_number?: string | null
  image_url?: string | null
  ext_source?: string | null
  ext_id?: string | null
  variant?: string | null
  target_price?: number | null
  alert_enabled?: boolean | number
  notes?: string | null
  tags?: unknown
}): MtgWatch {
  const row = {
    id: randomUUID(),
    kind: (w.kind || 'card').trim().toLowerCase(),
    name: w.name.trim(),
    set_code: w.set_code ?? null,
    collector_number: w.collector_number ?? null,
    image_url: w.image_url ?? null,
    ext_source: w.ext_source ?? 'scryfall',
    ext_id: w.ext_id ?? null,
    variant: w.variant ?? 'nonfoil',
    target_price: w.target_price == null ? null : Number(w.target_price),
    // Default ON: a watch exists to alert. Only an explicit false turns it off,
    // so an omitted field never silently mutes a new watch.
    alert_enabled: w.alert_enabled === false || w.alert_enabled === 0 ? 0 : 1,
    last_price: null,
    last_checked_at: null,
    last_alert_at: null,
    notes: w.notes ?? null,
    tags_json: jsonOrNull(w.tags),
    created_at: now(),
    updated_at: now()
  }
  db.prepare(`INSERT INTO mtg_watchlist (id, kind, name, set_code, collector_number, image_url, ext_source, ext_id, variant, target_price, alert_enabled, last_price, last_checked_at, last_alert_at, notes, tags_json, created_at, updated_at)
    VALUES (@id, @kind, @name, @set_code, @collector_number, @image_url, @ext_source, @ext_id, @variant, @target_price, @alert_enabled, @last_price, @last_checked_at, @last_alert_at, @notes, @tags_json, @created_at, @updated_at)`).run(params(row))
  return row as unknown as MtgWatch
}

export function updateMtgWatch(id: string, patch: Partial<MtgWatch> & { tags?: unknown }): void {
  const allowed = [
    'kind',
    'name',
    'set_code',
    'collector_number',
    'image_url',
    'ext_source',
    'ext_id',
    'variant',
    'target_price',
    'alert_enabled',
    'last_price',
    'last_checked_at',
    'last_alert_at',
    'notes',
    'mode_override',
    'msrp',
    'msrp_source'
  ] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if ('tags' in patch) { sets.push('tags_json = @tags_json'); p.tags_json = jsonOrNull(patch.tags) }
  if (!sets.length) return
  sets.push('updated_at = @updated_at')
  p.updated_at = now()
  db.prepare(`UPDATE mtg_watchlist SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function deleteMtgWatch(id: string): void {
  db.prepare('DELETE FROM mtg_watchlist WHERE id = ?').run(id)
}

/**
 * Record one day's price. The day-keyed unique index means a re-run inside the
 * same day overwrites rather than appending, which is what keeps an hourly
 * scheduler from producing 24 identical points.
 */
export function recordMtgPrice(p: {
  ext_id: string; variant: string; price: number; currency?: string; source?: string; observed_on: string
}): void {
  db.prepare(`INSERT INTO mtg_prices (id, ext_id, variant, price, currency, source, observed_on, created_at)
    VALUES (@id, @ext_id, @variant, @price, @currency, @source, @observed_on, @created_at)
    ON CONFLICT(ext_id, variant, source, observed_on) DO UPDATE SET
      price = excluded.price, created_at = excluded.created_at`).run(params({
    id: randomUUID(),
    ext_id: p.ext_id,
    variant: p.variant,
    price: Number(p.price),
    currency: p.currency ?? 'usd',
    source: p.source ?? 'scryfall',
    observed_on: p.observed_on,
    created_at: now()
  }))
}

export function listMtgPrices(extId: string, variant: string, limitDays = 400): MtgPrice[] {
  return db.prepare(`SELECT * FROM mtg_prices WHERE ext_id = ? AND variant = ?
    ORDER BY observed_on DESC LIMIT ?`).all(extId, variant, Number(limitDays)) as unknown as MtgPrice[]
}

/** Lookback windows, in days, that price rows carry a comparison point for. */
export const PRICE_PERIODS = [7, 30, 90] as const

/**
 * The price at each lookback, measured back from the item's NEWEST observed
 * day rather than from today, so a scheduler that missed the last two days
 * still compares like with like. `pN_on` names the day actually used: when
 * history is shorter than the window it falls back to the oldest point, and
 * the date is what lets the UI say "only 12 days of history" instead of
 * passing a 12-day move off as a 30-day one.
 */
export interface PeriodPrices {
  /** Newest observed day — what the lookbacks are measured from. */
  last_on: string | null
  p7: number | null
  p7_on: string | null
  p30: number | null
  p30_on: string | null
  p90: number | null
  p90_on: string | null
}

export function attachPeriodPrices<T extends { ext_id: string | null; variant: string | null }>(
  rows: T[]
): Array<T & PeriodPrices> {
  const latest = db.prepare('SELECT MAX(observed_on) AS d FROM mtg_prices WHERE ext_id = ? AND variant = ?')
  const atOrBefore = db.prepare(`SELECT price, observed_on FROM mtg_prices
    WHERE ext_id = ? AND variant = ? AND observed_on <= date(?, ?)
    ORDER BY observed_on DESC, source LIMIT 1`)
  const oldest = db.prepare(`SELECT price, observed_on FROM mtg_prices
    WHERE ext_id = ? AND variant = ? ORDER BY observed_on ASC, source LIMIT 1`)
  // Stacked owned rows repeat a printing; one lookup per (printing, finish).
  const memo = new Map<string, PeriodPrices>()
  return rows.map((r) => {
    const empty: PeriodPrices = { last_on: null, p7: null, p7_on: null, p30: null, p30_on: null, p90: null, p90_on: null }
    if (!r.ext_id || !r.variant) return { ...r, ...empty }
    const key = `${r.ext_id}|${r.variant}`
    let out = memo.get(key)
    if (!out) {
      out = { ...empty }
      const last = (latest.get(r.ext_id, r.variant) as { d: string | null } | undefined)?.d ?? null
      out.last_on = last
      if (last) {
        const first = oldest.get(r.ext_id, r.variant) as { price: number; observed_on: string } | undefined
        for (const days of PRICE_PERIODS) {
          let hit = atOrBefore.get(r.ext_id, r.variant, last, `-${days} days`) as
            | { price: number; observed_on: string }
            | undefined
          if (!hit && first && first.observed_on < last) hit = first
          if (hit) {
            ;(out as unknown as Record<string, unknown>)[`p${days}`] = hit.price
            ;(out as unknown as Record<string, unknown>)[`p${days}_on`] = hit.observed_on
          }
        }
      }
      memo.set(key, out)
    }
    return { ...r, ...out }
  })
}

/** Owned MTG cards from the vault, each with its newest observed price. */
export function listMtgOwned(): MtgOwnedRow[] {
  return db.prepare(`
    SELECT v.id, v.name, v.category, v.quantity, v.maker, v.ext_source, v.ext_id, v.variant, v.purchase_price,
      (SELECT p.price FROM mtg_prices p
        WHERE p.ext_id = v.ext_id AND p.variant = v.variant
        ORDER BY p.observed_on DESC LIMIT 1) AS last_price,
      (SELECT COUNT(*) FROM mtg_prices p
        WHERE p.ext_id = v.ext_id AND p.variant = v.variant) AS points,
      1 AS entries,
      -- The move since the PREVIOUS OBSERVED day, not literally yesterday. The
      -- scheduler can miss a day (laptop asleep, Scryfall down), and comparing
      -- against a day that was never recorded would silently report no change
      -- on exactly the cards that moved while it was off.
      --
      -- Stepping back to the previous distinct observed_on rather than
      -- OFFSET 1 matters because mtg_prices is unique per (card, finish,
      -- SOURCE, day): two sources quoting the same day would otherwise make
      -- "yesterday" resolve to today's other quote, and every card would read
      -- as flat.
      (SELECT p.observed_on FROM mtg_prices p
        WHERE p.ext_id = v.ext_id AND p.variant = v.variant
        ORDER BY p.observed_on DESC LIMIT 1) AS last_on,
      (SELECT p.price FROM mtg_prices p
        WHERE p.ext_id = v.ext_id AND p.variant = v.variant
          AND p.observed_on < (SELECT MAX(p2.observed_on) FROM mtg_prices p2
                                WHERE p2.ext_id = v.ext_id AND p2.variant = v.variant)
        ORDER BY p.observed_on DESC LIMIT 1) AS prev_price,
      (SELECT p.observed_on FROM mtg_prices p
        WHERE p.ext_id = v.ext_id AND p.variant = v.variant
          AND p.observed_on < (SELECT MAX(p2.observed_on) FROM mtg_prices p2
                                WHERE p2.ext_id = v.ext_id AND p2.variant = v.variant)
        ORDER BY p.observed_on DESC LIMIT 1) AS prev_on,
      -- LEFT JOIN: a row the metadata sync has not reached yet still lists and
      -- still prices, it just cannot be colour-filtered until the next sync.
      m.color_identity, m.type_line, m.mana_cost, m.cmc, m.oracle_id, m.set_code, m.rarity,
      c.play_rate AS cedh_play_rate, (c.name IS NOT NULL) AS cedh_synced
    FROM vault_items v
    LEFT JOIN mtg_card_meta m ON m.ext_id = v.ext_id
    LEFT JOIN mtg_cedh_stats c ON c.name = m.name
    WHERE v.ext_id IS NOT NULL AND v.ext_id != '' AND v.ext_source IN ('scryfall','tcgplayer')
    -- Most valuable first, by what the holding is actually worth (unit price ×
    -- quantity), so three $100 copies outrank one $200 card. Unpriced rows sort
    -- last rather than to the top as 0-with-no-data.
    ORDER BY (COALESCE(last_price, 0) * v.quantity) DESC, v.name
  `).all() as unknown as MtgOwnedRow[]
}

/**
 * The owned list with identical copies collapsed into one line.
 *
 * Adding four copies of a card as four separate vault rows — which is what
 * happens when you log them one at a time out of a box — makes the Owned page
 * four identical tiles deep. Stacking them is purely a display concern, so it
 * lives here rather than in listMtgOwned(): the per-row version is still the
 * truth, and rebuildHistory depends on seeing every vault id to backfill it.
 *
 * The key is (printing, finish), NOT card name. Two Sol Rings from different
 * sets have different prices and different histories, and collapsing them
 * would mean picking one price to show for both. Cards that merely share a
 * name still list separately, which is also what you want when the whole page
 * is about what each holding is worth.
 *
 * quantity and purchase_price add up across the stack; the price columns are
 * identical for every row in a group by construction, since the group key is
 * exactly what mtg_prices is keyed on.
 */
export function listMtgOwnedStacked(): MtgOwnedRow[] {
  return db.prepare(`
    WITH rows AS (
      SELECT v.id, v.name, v.category, v.quantity, v.maker, v.ext_source, v.ext_id, v.variant,
        v.purchase_price,
        (SELECT p.price FROM mtg_prices p
          WHERE p.ext_id = v.ext_id AND p.variant = v.variant
          ORDER BY p.observed_on DESC LIMIT 1) AS last_price,
        (SELECT COUNT(*) FROM mtg_prices p
          WHERE p.ext_id = v.ext_id AND p.variant = v.variant) AS points,
        (SELECT p.observed_on FROM mtg_prices p
          WHERE p.ext_id = v.ext_id AND p.variant = v.variant
          ORDER BY p.observed_on DESC LIMIT 1) AS last_on,
        (SELECT p.price FROM mtg_prices p
          WHERE p.ext_id = v.ext_id AND p.variant = v.variant
            AND p.observed_on < (SELECT MAX(p2.observed_on) FROM mtg_prices p2
                                  WHERE p2.ext_id = v.ext_id AND p2.variant = v.variant)
          ORDER BY p.observed_on DESC LIMIT 1) AS prev_price,
        (SELECT p.observed_on FROM mtg_prices p
          WHERE p.ext_id = v.ext_id AND p.variant = v.variant
            AND p.observed_on < (SELECT MAX(p2.observed_on) FROM mtg_prices p2
                                  WHERE p2.ext_id = v.ext_id AND p2.variant = v.variant)
          ORDER BY p.observed_on DESC LIMIT 1) AS prev_on
      FROM vault_items v
      WHERE v.ext_id IS NOT NULL AND v.ext_id != '' AND v.ext_source IN ('scryfall','tcgplayer')
    )
    SELECT r.keep_id AS id, r.name, r.category, r.qty AS quantity, r.maker, r.ext_source, r.ext_id, r.variant,
      r.paid AS purchase_price, r.last_price, r.points, r.entries, r.last_on, r.prev_price, r.prev_on,
      m.color_identity, m.type_line, m.mana_cost, m.cmc, m.oracle_id, m.set_code, m.rarity,
      c.play_rate AS cedh_play_rate, (c.name IS NOT NULL) AS cedh_synced
    FROM (
      SELECT *, SUM(quantity) AS qty, COUNT(*) AS entries,
        -- Cost basis only when EVERY copy in the stack has one. SUM() skips
        -- NULLs, so a stack where two of four copies recorded a price would
        -- otherwise report half the money spent and an invented gain.
        CASE WHEN COUNT(purchase_price) = COUNT(*) THEN SUM(purchase_price) END AS paid,
        -- The lone min/max aggregate: SQLite then resolves every bare column
        -- above to THAT row, so the id, name and set shown belong together
        -- instead of being picked independently.
        MIN(id) AS keep_id
      FROM rows
      GROUP BY ext_id, variant
    ) r
    LEFT JOIN mtg_card_meta m ON m.ext_id = r.ext_id
    LEFT JOIN mtg_cedh_stats c ON c.name = m.name
    -- Same ordering rule as the unstacked list: holding value, not unit price.
    ORDER BY (COALESCE(r.last_price, 0) * r.qty) DESC, r.name
  `).all() as unknown as MtgOwnedRow[]
}

/**
 * Turn an item's existing price history into vault valuations.
 *
 * Prices are per-card and per-day; valuations are per-holding, so each point is
 * multiplied by quantity. Days already carrying a market valuation are skipped,
 * making this safe to re-run. Timestamps land at local noon so the row cannot
 * drift across a day boundary in either direction.
 */
export function backfillVaultValuations(itemId: string): number {
  const item = getVaultItem(itemId)
  if (!item?.ext_id || !item.variant) return 0
  const prices = db.prepare('SELECT observed_on, price, source FROM mtg_prices WHERE ext_id = ? AND variant = ? ORDER BY observed_on')
    .all(item.ext_id, item.variant) as unknown as { observed_on: string; price: number; source: string }[]
  if (!prices.length) return 0

  const localDay = (ms: number): string => {
    const d = new Date(ms)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const existing = new Set(
    (db.prepare(`SELECT created_at FROM vault_valuations WHERE item_id = ? AND kind = 'market'`)
      .all(itemId) as unknown as { created_at: number }[]).map((r) => localDay(r.created_at))
  )

  let added = 0
  for (const p of prices) {
    if (existing.has(p.observed_on)) continue
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.observed_on)
    if (!m) continue
    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime()
    db.prepare(`INSERT INTO vault_valuations (id, item_id, kind, value_mid, value_low, value_high, spot_price, source, notes, created_at)
      VALUES (@id, @item_id, 'market', @value_mid, NULL, NULL, NULL, @source, NULL, @created_at)`).run(params({
      id: randomUUID(),
      item_id: itemId,
      value_mid: Math.round(p.price * item.quantity * 100) / 100,
      source: `${p.source} history (${p.observed_on})`,
      created_at: at
    }))
    added++
  }
  return added
}

export function getMtgSealed(uuid: string): MtgSealed | undefined {
  return db.prepare('SELECT * FROM mtg_sealed WHERE uuid = ?').get(uuid) as MtgSealed | undefined
}

/** Owned sealed rows carry only the TCGplayer id; this finds the MTGJSON product behind it. */
export function findMtgSealedByTcgplayer(productId: string): MtgSealed | undefined {
  return db.prepare('SELECT * FROM mtg_sealed WHERE tcgplayer_product_id = ? ORDER BY release_date DESC LIMIT 1')
    .get(productId) as MtgSealed | undefined
}

/**
 * Open one copy of an owned sealed product: its cards become owned vault rows
 * and the sealed holding drops by one (or goes, if it was the last copy).
 *
 * One transaction, so a failure part-way cannot leave the cards added while
 * the box is still counted — or the box gone with half its cards missing.
 */
export function ripMtgSealed(sealedId: string, cards: {
  name: string
  maker: string
  quantity: number
  ext_id: string
  variant: string
  purchase_price: number | null
  notes: string
}[]): VaultItem[] {
  const sealed = getVaultItem(sealedId)
  if (!sealed) throw new Error(`vault item ${sealedId} not found`)
  const created: VaultItem[] = []
  db.exec('BEGIN')
  try {
    for (const c of cards) {
      created.push(createVaultItem({ category: 'mtg_card', ext_source: 'scryfall', ...c }))
    }
    if (sealed.quantity > 1) {
      // purchase_price is for the whole holding, so the remaining copies keep
      // their share of it rather than the full amount.
      const left = sealed.quantity - 1
      updateVaultItem(sealedId, {
        quantity: left,
        purchase_price: sealed.purchase_price == null ? null : (sealed.purchase_price * left) / sealed.quantity
      })
    } else {
      deleteVaultItem(sealedId)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  // Outside the transaction: history is a nicety, and a hiccup here should
  // not undo the rip itself.
  for (const c of created) backfillVaultValuations(c.id)
  return created
}

export function upsertMtgSealed(p: Omit<MtgSealed, 'synced_at'>): void {
  db.prepare(`INSERT INTO mtg_sealed (uuid, name, set_code, category, subtype, release_date, tcgplayer_product_id, card_kingdom_id, synced_at)
    VALUES (@uuid, @name, @set_code, @category, @subtype, @release_date, @tcgplayer_product_id, @card_kingdom_id, @synced_at)
    ON CONFLICT(uuid) DO UPDATE SET
      name = excluded.name, set_code = excluded.set_code, category = excluded.category,
      subtype = excluded.subtype, release_date = excluded.release_date,
      tcgplayer_product_id = excluded.tcgplayer_product_id, card_kingdom_id = excluded.card_kingdom_id,
      synced_at = excluded.synced_at`).run(params({ ...p, synced_at: now() }))
}

/**
 * Whether a set's sealed catalogue has been pulled at least once — or, with
 * maxAgeMs, pulled recently enough. Ongoing sets (SLD gains drops every month)
 * need the age check; a one-shot pull leaves them frozen at first search.
 */
export function mtgSealedSetSynced(setCode: string, maxAgeMs?: number): boolean {
  const r = db.prepare('SELECT COUNT(*) c, MAX(synced_at) last FROM mtg_sealed WHERE set_code = ?').get(setCode) as unknown as {
    c: number
    last: number | null
  }
  if (r.c === 0) return false
  return maxAgeMs == null || (r.last ?? 0) >= Date.now() - maxAgeMs
}

export function markMtgListingDealAlert(id: string, at = Date.now()): void {
  db.prepare('UPDATE mtg_listings SET deal_alert_at = ? WHERE id = ?').run(at, id)
}

export function listMtgListings(opts: { watchId?: string; vaultItemId?: string; sealedUuid?: string } = {}): MtgListing[] {
  if (opts.sealedUuid) {
    return db.prepare('SELECT * FROM mtg_listings WHERE sealed_uuid = ? ORDER BY retailer').all(opts.sealedUuid) as unknown as MtgListing[]
  }
  if (opts.watchId) {
    return db.prepare('SELECT * FROM mtg_listings WHERE watch_id = ? ORDER BY kind, retailer').all(opts.watchId) as unknown as MtgListing[]
  }
  if (opts.vaultItemId) {
    return db.prepare('SELECT * FROM mtg_listings WHERE vault_item_id = ? ORDER BY kind, retailer').all(opts.vaultItemId) as unknown as MtgListing[]
  }
  return db.prepare('SELECT * FROM mtg_listings ORDER BY created_at DESC').all() as unknown as MtgListing[]
}

/**
 * Insert or refresh a listing, keyed on (retailer, url).
 *
 * The owner columns are COALESCEd rather than overwritten: the same URL can be
 * discovered first by a preorder scan (which knows only the sealed uuid) and
 * later by a watchlist row, and the second write must not erase the first
 * association.
 */
export function upsertMtgListing(l: {
  watch_id?: string | null
  vault_item_id?: string | null
  sealed_uuid?: string | null
  retailer: string
  kind?: string
  title?: string | null
  url: string
  price?: number | null
  status?: string
  raw_state?: string | null
  last_checked_at?: number | null
  last_error?: string | null
}): MtgListing {
  const row = {
    id: randomUUID(),
    watch_id: l.watch_id ?? null,
    vault_item_id: l.vault_item_id ?? null,
    sealed_uuid: l.sealed_uuid ?? null,
    retailer: l.retailer,
    kind: l.kind ?? 'search',
    title: l.title ?? null,
    url: l.url,
    price: l.price == null ? null : Number(l.price),
    status: l.status ?? 'unknown',
    raw_state: l.raw_state ?? null,
    last_checked_at: l.last_checked_at ?? null,
    last_error: l.last_error ?? null,
    created_at: now(),
    updated_at: now()
  }
  db.prepare(`INSERT INTO mtg_listings (id, watch_id, vault_item_id, sealed_uuid, retailer, kind, title, url, price, status, raw_state, last_checked_at, last_error, created_at, updated_at)
    VALUES (@id, @watch_id, @vault_item_id, @sealed_uuid, @retailer, @kind, @title, @url, @price, @status, @raw_state, @last_checked_at, @last_error, @created_at, @updated_at)
    ON CONFLICT(retailer, url) DO UPDATE SET
      watch_id = COALESCE(excluded.watch_id, mtg_listings.watch_id),
      vault_item_id = COALESCE(excluded.vault_item_id, mtg_listings.vault_item_id),
      sealed_uuid = COALESCE(excluded.sealed_uuid, mtg_listings.sealed_uuid),
      kind = excluded.kind, title = COALESCE(excluded.title, mtg_listings.title),
      price = excluded.price, status = excluded.status, raw_state = excluded.raw_state,
      last_checked_at = excluded.last_checked_at, last_error = excluded.last_error,
      updated_at = excluded.updated_at`).run(params(row))
  return (db.prepare('SELECT * FROM mtg_listings WHERE retailer = ? AND url = ?').get(l.retailer, l.url) ?? row) as unknown as MtgListing
}

export function updateMtgListing(id: string, patch: Partial<MtgListing>): void {
  const allowed = ['title', 'price', 'status', 'raw_state', 'last_checked_at', 'last_error', 'kind'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if (!sets.length) return
  sets.push('updated_at = @updated_at')
  p.updated_at = now()
  db.prepare(`UPDATE mtg_listings SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function deleteMtgListing(id: string): void {
  db.prepare('DELETE FROM mtg_listings WHERE id = ?').run(id)
}

/** Sealed products for a set that carry a price handle; the rest are unpriceable. */
/** The whole catalogue for one set, including products with no TCGplayer id (shown, just not priceable). */
export function listMtgSealedAll(setCode: string): MtgSealed[] {
  return db.prepare('SELECT * FROM mtg_sealed WHERE set_code = ? ORDER BY name').all(setCode.toLowerCase()) as unknown as MtgSealed[]
}

/** Catalogue size per set code, in one query — the Sets list shows it for every family. */
export function mtgSealedCountsBySet(): Map<string, number> {
  const rows = db.prepare('SELECT set_code, COUNT(*) AS c FROM mtg_sealed GROUP BY set_code').all() as unknown as Array<{ set_code: string; c: number }>
  return new Map(rows.map((r) => [r.set_code, r.c]))
}

export function listSealedForSet(setCode: string): MtgSealed[] {
  return db.prepare(`SELECT * FROM mtg_sealed
    WHERE set_code = ? AND tcgplayer_product_id IS NOT NULL AND tcgplayer_product_id != ''
    ORDER BY name`).all(setCode.toLowerCase()) as unknown as MtgSealed[]
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

/**
 * Newest and oldest-in-window price per sealed product, so the UI can show a
 * move over the period without pulling the whole series for every row.
 */
export function sealedPriceSnapshot(setCode: string, sinceYmd: string): MtgSealedPriceRow[] {
  return db.prepare(`
    SELECT s.uuid, s.name, s.set_code AS setCode, s.category, s.subtype,
      s.tcgplayer_product_id AS tcgplayerProductId,
      (SELECT p.price FROM mtg_prices p
        WHERE p.ext_id = s.tcgplayer_product_id AND p.variant = 'sealed'
        ORDER BY p.observed_on DESC LIMIT 1) AS latest,
      (SELECT p.observed_on FROM mtg_prices p
        WHERE p.ext_id = s.tcgplayer_product_id AND p.variant = 'sealed'
        ORDER BY p.observed_on DESC LIMIT 1) AS latestOn,
      (SELECT p.price FROM mtg_prices p
        WHERE p.ext_id = s.tcgplayer_product_id AND p.variant = 'sealed' AND p.observed_on >= ?
        ORDER BY p.observed_on ASC LIMIT 1) AS earliest,
      (SELECT p.observed_on FROM mtg_prices p
        WHERE p.ext_id = s.tcgplayer_product_id AND p.variant = 'sealed' AND p.observed_on >= ?
        ORDER BY p.observed_on ASC LIMIT 1) AS earliestOn,
      (SELECT COUNT(*) FROM mtg_prices p
        WHERE p.ext_id = s.tcgplayer_product_id AND p.variant = 'sealed') AS points
    FROM mtg_sealed s
    WHERE s.set_code = ? AND s.tcgplayer_product_id IS NOT NULL AND s.tcgplayer_product_id != ''
    ORDER BY latest DESC, s.name
  `).all(sinceYmd, sinceYmd, setCode.toLowerCase()) as unknown as MtgSealedPriceRow[]
}

/**
 * Already-released Secret Lairs from the catalogue. Matched on subtype OR name
 * because MTGJSON's subtype is not set consistently across older drops.
 */
export function listRecentSecretLair(sinceYmd: string, limit = 40): MtgSealed[] {
  return db.prepare(`SELECT * FROM mtg_sealed
    WHERE (subtype = 'secret_lair' OR name LIKE 'Secret Lair%')
      AND release_date IS NOT NULL AND release_date >= ?
    ORDER BY release_date DESC, name LIMIT ?`).all(sinceYmd, Number(limit)) as unknown as MtgSealed[]
}

export function listUpcomingSecretLair(): MtgSlUpcoming[] {
  return db.prepare('SELECT * FROM mtg_sl_upcoming ORDER BY release_date, drop_name, name').all() as unknown as MtgSlUpcoming[]
}

/**
 * Mirror the announced list wholesale, in one transaction.
 *
 * A drop that disappears upstream has either gone on sale or been pulled, and
 * either way should stop being "upcoming" — so this replaces rather than
 * merges. The transaction keeps a mid-sync failure from leaving the table
 * empty; on error the rollback restores the previous contents.
 */
export function replaceUpcomingSecretLair(rows: Omit<MtgSlUpcoming, 'synced_at'>[]): number {
  const stamp = Date.now()
  const run = db.prepare(`INSERT INTO mtg_sl_upcoming
      (id, drop_id, drop_name, drop_release_date, name, picture, release_date, msrp, foil, etched, randomized, synced_at)
    VALUES (@id, @drop_id, @drop_name, @drop_release_date, @name, @picture, @release_date, @msrp, @foil, @etched, @randomized, @synced_at)`)
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM mtg_sl_upcoming').run()
    for (const r of rows) run.run(params({ ...r, synced_at: stamp }))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return rows.length
}

/** EV board, best net percentage first; unscored rows sort last, not as zero. */
export function listMtgEv(): MtgEvRow[] {
  return db.prepare('SELECT * FROM mtg_ev ORDER BY net_pct IS NULL, net_pct DESC, name').all() as unknown as MtgEvRow[]
}

export function getMtgEv(uuid: string): MtgEvRow | undefined {
  return db.prepare('SELECT * FROM mtg_ev WHERE uuid = ?').get(uuid) as MtgEvRow | undefined
}

export function upsertMtgEv(r: Omit<MtgEvRow, 'computed_at'> & { computed_at?: number }): void {
  db.prepare(`INSERT INTO mtg_ev
      (uuid, set_code, name, kind, tcgplayer_product_id, price, ev_mean, ev_median, ev_liquid, method, packs, chance_of_profit, net, net_pct, note, priced_at, computed_at, engine, basis)
    VALUES (@uuid, @set_code, @name, @kind, @tcgplayer_product_id, @price, @ev_mean, @ev_median, @ev_liquid, @method, @packs, @chance_of_profit, @net, @net_pct, @note, @priced_at, @computed_at, @engine, @basis)
    ON CONFLICT(uuid) DO UPDATE SET
      set_code=excluded.set_code, name=excluded.name, kind=excluded.kind,
      tcgplayer_product_id=excluded.tcgplayer_product_id, price=excluded.price,
      ev_mean=excluded.ev_mean, ev_median=excluded.ev_median, ev_liquid=excluded.ev_liquid,
      method=excluded.method, packs=excluded.packs, chance_of_profit=excluded.chance_of_profit,
      net=excluded.net, net_pct=excluded.net_pct, note=excluded.note,
      priced_at=excluded.priced_at, computed_at=excluded.computed_at, engine=excluded.engine, basis=excluded.basis`).run(params({ ...r, computed_at: r.computed_at ?? Date.now() }))
}

export function deleteMtgEv(uuid: string): void {
  db.prepare('DELETE FROM mtg_ev WHERE uuid = ?').run(uuid)
}

/**
 * Name search over the sealed catalogue. Terms are AND-ed so each extra word
 * narrows; with no terms and no set codes it returns nothing rather than the
 * entire table.
 */
export function searchMtgSealed(terms: string[], setCodes?: string[], limit = 60): MtgSealed[] {
  const where: string[] = []
  const args: unknown[] = []
  for (const t of terms.filter(Boolean)) {
    where.push('name LIKE ?')
    args.push(`%${t}%`)
  }
  if (setCodes?.length) {
    where.push(`set_code IN (${setCodes.map(() => '?').join(',')})`)
    args.push(...setCodes)
  }
  if (!where.length) return []
  args.push(Number(limit))
  return db.prepare(`SELECT * FROM mtg_sealed WHERE ${where.join(' AND ')}
    ORDER BY release_date DESC, name LIMIT ?`).all(...(args as never[])) as unknown as MtgSealed[]
}

// ---------- torrents ----------
export function listTorrents(): TorrentRow[] {
  return db.prepare('SELECT * FROM torrents ORDER BY added_at DESC').all() as unknown as TorrentRow[]
}
export function getTorrent(id: string): TorrentRow | undefined {
  return db.prepare('SELECT * FROM torrents WHERE id = ?').get(id) as TorrentRow | undefined
}
export function insertTorrent(row: TorrentRow): void {
  db.prepare(`INSERT INTO torrents (id, info_hash, name, magnet, torrent_file, save_path, status, error, total_bytes, downloaded_bytes, uploaded_bytes, files_json, added_at, completed_at)
    VALUES (@id, @info_hash, @name, @magnet, @torrent_file, @save_path, @status, @error, @total_bytes, @downloaded_bytes, @uploaded_bytes, @files_json, @added_at, @completed_at)`).run(params(row))
}
export function updateTorrent(id: string, patch: Partial<TorrentRow>): void {
  const allowed = ['info_hash', 'name', 'status', 'error', 'total_bytes', 'downloaded_bytes', 'uploaded_bytes', 'files_json', 'completed_at'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if (!sets.length) return
  db.prepare(`UPDATE torrents SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}
export function deleteTorrent(id: string): void {
  db.prepare('DELETE FROM torrents WHERE id = ?').run(id)
}

// ---------- land ----------
export interface LandRegion {
  fips: string
  state: string
  name: string
  enabled: number
  min_lon: number | null
  min_lat: number | null
  max_lon: number | null
  max_lat: number | null
  /** JSON RegionDef.parcels */
  source: string
  /** JSON: address points, state-tier sources */
  extras: string
  parcel_count: number
  candidate_count: number
  /** new | ingesting | ready | error */
  status: string
  note: string | null
  ingested_at: number | null
  overlays_at: number | null
  scored_at: number | null
}

export interface LandParcel {
  /** '<fips>:<pin>' */
  id: string
  fips: string
  pin: string
  address: string | null
  city: string | null
  owner: string | null
  /** Computed from geometry, never trusted from source. */
  acres: number | null
  land_use: string | null
  vacant: number
  assessed: number | null
  lat: number
  lon: number
  min_lon: number | null
  min_lat: number | null
  max_lon: number | null
  max_lat: number | null
  candidate: number
  ingested_at: number
}

export interface LandScore {
  parcel_id: string
  total: number
  /** strong | workable | marginal | avoid | unknown */
  verdict: string
  /** JSON Record<factor, {score, weight, why}> */
  subs: string
  /** JSON string[] — hard blockers first */
  flags: string
  hookup_low: number | null
  hookup_high: number | null
  /** 0..1 share of weighted factors actually known. */
  coverage: number
  scored_at: number
}

/** A parcel joined to its score, as the map and list views consume it. */
export interface LandParcelScored extends LandParcel {
  total: number | null
  verdict: string | null
  flags: string | null
  hookup_low: number | null
  hookup_high: number | null
  coverage: number | null
}

export interface LandAssessment {
  parcel_id: string
  fips: string
  av_land: number | null
  av_improvement: number | null
  av_total: number | null
  deeded_acres: number | null
  class_code: string | null
  owner_name: string | null
  owner_street: string | null
  owner_city: string | null
  owner_state: string | null
  owner_zip: string | null
  absentee: number
  assessment_year: number | null
  updated_at: number
}

export interface LandAnchor {
  id: string
  label: string
  /** work | family | school | other */
  kind: string
  lat: number
  lon: number
  address: string | null
  weight: number
  ideal_minutes: number
  max_minutes: number
  active: number
  notes: string | null
  created_at: number
}

export interface LandListing {
  id: string
  parcel_id: string | null
  fips: string | null
  source: string | null
  url: string | null
  address: string | null
  price: number | null
  acres: number | null
  lat: number | null
  lon: number | null
  /** open | pending | gone | rejected */
  status: string
  notes: string | null
  created_at: number
  updated_at: number
}

export interface LandUtility {
  id: string
  fips: string
  /** electric | water | gas */
  kind: string
  name: string
  base_fee: number
  free_feet: number
  cost_per_foot: number
  source_url: string | null
  note: string | null
  updated_at: number
}

export interface LandFit {
  parcel_id: string
  score: number
  /** easy | workable | shift | remote | unknown */
  verdict: string
  commute_minutes: number | null
  detail: string
  scored_at: number
}

export function listLandRegions(): LandRegion[] {
  return db.prepare('SELECT * FROM land_regions ORDER BY state, name').all() as unknown as LandRegion[]
}

export function getLandRegion(fips: string): LandRegion | undefined {
  return db.prepare('SELECT * FROM land_regions WHERE fips = ?').get(fips) as LandRegion | undefined
}

/**
 * Upsert a region definition. The progress columns (counts, status, the *_at
 * stamps) are deliberately NOT in the conflict clause — re-declaring a region
 * must not wipe the record of what has already been ingested for it.
 */
export function upsertLandRegion(r: {
  fips: string
  state: string
  name: string
  enabled?: number
  min_lon?: number | null
  min_lat?: number | null
  max_lon?: number | null
  max_lat?: number | null
  source?: string
  extras?: string
}): void {
  db.prepare(`
    INSERT INTO land_regions (fips, state, name, enabled, min_lon, min_lat, max_lon, max_lat, source, extras)
    VALUES (@fips, @state, @name, @enabled, @min_lon, @min_lat, @max_lon, @max_lat, @source, @extras)
    ON CONFLICT(fips) DO UPDATE SET
      state = excluded.state, name = excluded.name,
      min_lon = excluded.min_lon, min_lat = excluded.min_lat,
      max_lon = excluded.max_lon, max_lat = excluded.max_lat,
      source = excluded.source, extras = excluded.extras
  `).run(params({
    fips: r.fips,
    state: r.state,
    name: r.name,
    enabled: r.enabled ?? 1,
    min_lon: r.min_lon ?? null,
    min_lat: r.min_lat ?? null,
    max_lon: r.max_lon ?? null,
    max_lat: r.max_lat ?? null,
    source: r.source ?? '{}',
    extras: r.extras ?? '{}'
  }))
}

/** Column names are whitelisted by pattern because they are interpolated. */
export function patchLandRegion(fips: string, patch: Record<string, unknown>): void {
  const cols = Object.keys(patch).filter((k) => k !== 'fips' && /^[a-z_]+$/.test(k))
  if (!cols.length) return
  const sets = cols.map((c) => c + ' = @' + c).join(', ')
  db.prepare('UPDATE land_regions SET ' + sets + ' WHERE fips = @fips').run(params({ ...patch, fips }))
}

/**
 * Replace a region's parcels wholesale, keeping the R-tree in step.
 *
 * The bbox index is a separate virtual table with no foreign key, so its rows
 * must be deleted through a join on the parcels being removed — and inserted
 * per parcel afterwards. A point parcel (no bbox in the source) degrades to a
 * zero-area box at its centroid rather than being left out of the index, which
 * would make it invisible to every map query.
 */
export function replaceLandParcels(fips: string, rows: Array<Omit<LandParcel, 'ingested_at'>>): number {
  const ts = now()
  const delBox = db.prepare('DELETE FROM land_parcel_bbox WHERE rowid IN (SELECT rowid FROM land_parcels WHERE fips = ?)')
  const del = db.prepare('DELETE FROM land_parcels WHERE fips = ?')
  const ins = db.prepare(`
    INSERT INTO land_parcels (id, fips, pin, address, city, owner, acres, land_use, vacant, assessed,
                              lat, lon, min_lon, min_lat, max_lon, max_lat, candidate, ingested_at)
    VALUES (@id, @fips, @pin, @address, @city, @owner, @acres, @land_use, @vacant, @assessed,
            @lat, @lon, @min_lon, @min_lat, @max_lon, @max_lat, @candidate, @ingested_at)
  `)
  const insBox = db.prepare('INSERT INTO land_parcel_bbox (rowid, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)')
  const findRowid = db.prepare('SELECT rowid FROM land_parcels WHERE id = ?')
  db.exec('BEGIN')
  try {
    delBox.run(fips)
    del.run(fips)
    for (const r of rows) {
      ins.run(params({ ...r, ingested_at: ts }))
      const rid = findRowid.get(r.id) as { rowid: number } | undefined
      if (rid) insBox.run(rid.rowid, r.min_lon ?? r.lon, r.max_lon ?? r.lon, r.min_lat ?? r.lat, r.max_lat ?? r.lat)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return rows.length
}

export function getLandParcel(id: string): LandParcel | undefined {
  return db.prepare('SELECT * FROM land_parcels WHERE id = ?').get(id) as LandParcel | undefined
}

/**
 * Re-apply the candidate filter for a region. Clears the flag first so the
 * result is the filter's current opinion rather than the union of every filter
 * ever run. `where` is caller-built SQL — internal, never user input.
 */
export function markLandCandidates(fips: string, where: string, args: Record<string, unknown>): number {
  db.prepare('UPDATE land_parcels SET candidate = 0 WHERE fips = @fips').run(params({ fips }))
  const r = db.prepare('UPDATE land_parcels SET candidate = 1 WHERE fips = @fips AND (' + where + ')').run(params({ ...args, fips }))
  return Number(r.changes ?? 0)
}

export function listLandCandidates(fips: string, limit = 100000): LandParcel[] {
  return db.prepare('SELECT * FROM land_parcels WHERE fips = ? AND candidate = 1 ORDER BY acres DESC LIMIT ?')
    .all(fips, limit) as unknown as LandParcel[]
}

/** Candidates with no cached fact from this source yet — the enrichment queue. */
export function listLandUnenriched(fips: string, source: string, limit: number): LandParcel[] {
  return db.prepare(`
    SELECT p.* FROM land_parcels p
    LEFT JOIN land_facts f ON f.parcel_id = p.id AND f.source = ?
    WHERE p.fips = ? AND p.candidate = 1 AND f.parcel_id IS NULL
    ORDER BY p.acres DESC LIMIT ?
  `).all(source, fips, limit) as unknown as LandParcel[]
}

export function putLandFact(parcelId: string, source: string, value: unknown): void {
  db.prepare(`INSERT INTO land_facts (parcel_id, source, json, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(parcel_id, source) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`)
    .run(parcelId, source, JSON.stringify(value ?? null), now())
}

export function getLandFacts(parcelId: string): Record<string, unknown> {
  const rows = db.prepare('SELECT source, json FROM land_facts WHERE parcel_id = ?').all(parcelId) as unknown as { source: string; json: string }[]
  const out: Record<string, unknown> = {}
  for (const r of rows) {
    try {
      out[r.source] = JSON.parse(r.json)
    } catch { /* a corrupt cached fact is simply absent */ }
  }
  return out
}

export function countLandFacts(fips: string, source: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM land_facts f JOIN land_parcels p ON p.id = f.parcel_id
    WHERE p.fips = ? AND f.source = ?`).get(fips, source) as unknown as { c: number }).c
}

export function replaceLandOverlay(fips: string, kind: string, rings: Array<{ ring: string; attrs?: unknown }>): number {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM land_overlay WHERE fips = ? AND kind = ?').run(fips, kind)
    const ins = db.prepare('INSERT INTO land_overlay (_shape, kind, fips, attrs) VALUES (?, ?, ?, ?)')
    for (const r of rings) ins.run(r.ring, kind, fips, JSON.stringify(r.attrs ?? null))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return rings.length
}

/** Overlay polygons containing a point — the per-parcel hazard lookup. */
export function overlayAt(fips: string, kind: string, lon: number, lat: number): unknown[] {
  const rows = db.prepare(`SELECT attrs FROM land_overlay
    WHERE kind = ? AND fips = ? AND geopoly_contains_point(_shape, ?, ?)`).all(kind, fips, lon, lat) as unknown as { attrs: string }[]
  return rows.map((r) => {
    try {
      return JSON.parse(r.attrs)
    } catch {
      return null
    }
  })
}

/** Overlay polygons overlapping a box — used when a parcel is bigger than a point. */
export function overlayNear(fips: string, kind: string, box: [number, number, number, number]): unknown[] {
  const [minLon, minLat, maxLon, maxLat] = box
  const shape = JSON.stringify([[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]])
  const rows = db.prepare(`SELECT attrs FROM land_overlay
    WHERE kind = ? AND fips = ? AND geopoly_overlap(_shape, ?)`).all(kind, fips, shape) as unknown as { attrs: string }[]
  return rows.map((r) => {
    try {
      return JSON.parse(r.attrs)
    } catch {
      return null
    }
  })
}

export function countLandOverlay(fips: string, kind: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM land_overlay WHERE fips = ? AND kind = ?').get(fips, kind) as unknown as { c: number }).c
}

export function replaceLandAddresses(fips: string, pts: Array<{ lat: number; lon: number }>): number {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM land_address_bbox WHERE rowid IN (SELECT id FROM land_addresses WHERE fips = ?)').run(fips)
    db.prepare('DELETE FROM land_addresses WHERE fips = ?').run(fips)
    const ins = db.prepare('INSERT INTO land_addresses (fips, lat, lon) VALUES (?, ?, ?)')
    const insBox = db.prepare('INSERT INTO land_address_bbox (rowid, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)')
    for (const p of pts) {
      const r = ins.run(fips, p.lat, p.lon)
      insBox.run(Number(r.lastInsertRowid), p.lon, p.lon, p.lat, p.lat)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return pts.length
}

export function addressesInBox(minLon: number, minLat: number, maxLon: number, maxLat: number, limit = 64): Array<{ lat: number; lon: number }> {
  return db.prepare(`SELECT a.lat, a.lon FROM land_address_bbox b JOIN land_addresses a ON a.id = b.rowid
    WHERE b.min_lon >= ? AND b.max_lon <= ? AND b.min_lat >= ? AND b.max_lat <= ? LIMIT ?`)
    .all(minLon, maxLon, minLat, maxLat, limit) as unknown as Array<{ lat: number; lon: number }>
}

export function countLandAddresses(fips: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM land_addresses WHERE fips = ?').get(fips) as unknown as { c: number }).c
}

export function putLandScore(s: Omit<LandScore, 'scored_at'>): void {
  db.prepare(`INSERT INTO land_scores (parcel_id, total, verdict, subs, flags, hookup_low, hookup_high, coverage, scored_at)
    VALUES (@parcel_id, @total, @verdict, @subs, @flags, @hookup_low, @hookup_high, @coverage, @scored_at)
    ON CONFLICT(parcel_id) DO UPDATE SET total = excluded.total, verdict = excluded.verdict,
      subs = excluded.subs, flags = excluded.flags, hookup_low = excluded.hookup_low,
      hookup_high = excluded.hookup_high, coverage = excluded.coverage, scored_at = excluded.scored_at`)
    .run(params({ ...s, scored_at: now() }))
}

export function getLandScore(parcelId: string): LandScore | undefined {
  return db.prepare('SELECT * FROM land_scores WHERE parcel_id = ?').get(parcelId) as LandScore | undefined
}

/**
 * Parcels intersecting the map viewport, best-scored first.
 *
 * Driven off the R-tree rather than the parcels table: a region is hundreds of
 * thousands of rows and a bounding-box scan on plain columns is not viable at
 * pan speed. fips and verdict are interpolated rather than bound because
 * SQLite cannot bind an IN list — both are stripped to a safe character class
 * first, and both are internal values, never typed by a user.
 */
export function landParcelsInView(o: {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
  limit?: number
  candidatesOnly?: boolean
  minAcres?: number | null
  maxAcres?: number | null
  fips?: string[]
  verdicts?: string[]
}): LandParcelScored[] {
  const clauses = ['b.max_lon >= @minLon', 'b.min_lon <= @maxLon', 'b.max_lat >= @minLat', 'b.min_lat <= @maxLat']
  const args: Record<string, unknown> = {
    minLon: o.minLon,
    minLat: o.minLat,
    maxLon: o.maxLon,
    maxLat: o.maxLat,
    limit: Math.min(Math.max(o.limit ?? 2000, 1), 20000)
  }
  if (o.candidatesOnly !== false) clauses.push('p.candidate = 1')
  if (o.minAcres != null) { clauses.push('p.acres >= @minAcres'); args.minAcres = o.minAcres }
  if (o.maxAcres != null) { clauses.push('p.acres <= @maxAcres'); args.maxAcres = o.maxAcres }
  if (o.fips?.length) {
    const safe = o.fips.map((f) => String(f).replace(/[^0-9]/g, '')).filter(Boolean)
    if (safe.length) clauses.push('p.fips IN (' + safe.map((f) => "'" + f + "'").join(',') + ')')
  }
  if (o.verdicts?.length) {
    const safe = o.verdicts.map((v) => String(v).replace(/[^a-z]/g, '')).filter(Boolean)
    if (safe.length) clauses.push('s.verdict IN (' + safe.map((v) => "'" + v + "'").join(',') + ')')
  }
  return db.prepare(`
    SELECT p.*, s.total, s.verdict, s.flags, s.hookup_low, s.hookup_high, s.coverage
    FROM land_parcel_bbox b
    JOIN land_parcels p ON p.rowid = b.rowid
    LEFT JOIN land_scores s ON s.parcel_id = p.id
    WHERE ` + clauses.join(' AND ') + `
    ORDER BY s.total DESC, p.acres DESC
    LIMIT @limit
  `).all(params(args)) as unknown as LandParcelScored[]
}

export function listLandListings(status?: string): LandListing[] {
  return (status
    ? db.prepare('SELECT * FROM land_listings WHERE status = ? ORDER BY updated_at DESC').all(status)
    : db.prepare('SELECT * FROM land_listings ORDER BY updated_at DESC').all()) as unknown as LandListing[]
}

/** Fields absent from the patch fall back to the stored row, not to null. */
export function upsertLandListing(l: Partial<LandListing> & { id?: string }): LandListing {
  const existing = l.id ? db.prepare('SELECT * FROM land_listings WHERE id = ?').get(l.id) as LandListing | undefined : undefined
  const row: LandListing = {
    id: existing?.id ?? l.id ?? randomUUID(),
    parcel_id: l.parcel_id ?? existing?.parcel_id ?? null,
    fips: l.fips ?? existing?.fips ?? null,
    source: l.source ?? existing?.source ?? null,
    url: l.url ?? existing?.url ?? null,
    address: l.address ?? existing?.address ?? null,
    price: l.price ?? existing?.price ?? null,
    acres: l.acres ?? existing?.acres ?? null,
    lat: l.lat ?? existing?.lat ?? null,
    lon: l.lon ?? existing?.lon ?? null,
    status: l.status ?? existing?.status ?? 'open',
    notes: l.notes ?? existing?.notes ?? null,
    created_at: existing?.created_at ?? now(),
    updated_at: now()
  }
  db.prepare(`INSERT INTO land_listings (id, parcel_id, fips, source, url, address, price, acres, lat, lon, status, notes, created_at, updated_at)
    VALUES (@id, @parcel_id, @fips, @source, @url, @address, @price, @acres, @lat, @lon, @status, @notes, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET parcel_id = excluded.parcel_id, fips = excluded.fips, source = excluded.source,
      url = excluded.url, address = excluded.address, price = excluded.price, acres = excluded.acres,
      lat = excluded.lat, lon = excluded.lon, status = excluded.status, notes = excluded.notes,
      updated_at = excluded.updated_at`).run(params(row))
  return row
}

export function deleteLandListing(id: string): void {
  db.prepare('DELETE FROM land_listings WHERE id = ?').run(id)
}

export function listLandUtilities(fips?: string): LandUtility[] {
  return (fips
    ? db.prepare('SELECT * FROM land_utilities WHERE fips = ? ORDER BY kind, name').all(fips)
    : db.prepare('SELECT * FROM land_utilities ORDER BY fips, kind, name').all()) as unknown as LandUtility[]
}

export function upsertLandUtility(u: Omit<LandUtility, 'updated_at'>): void {
  db.prepare(`INSERT INTO land_utilities (id, fips, kind, name, base_fee, free_feet, cost_per_foot, source_url, note, updated_at)
    VALUES (@id, @fips, @kind, @name, @base_fee, @free_feet, @cost_per_foot, @source_url, @note, @updated_at)
    ON CONFLICT(id) DO UPDATE SET fips = excluded.fips, kind = excluded.kind, name = excluded.name,
      base_fee = excluded.base_fee, free_feet = excluded.free_feet, cost_per_foot = excluded.cost_per_foot,
      source_url = excluded.source_url, note = excluded.note, updated_at = excluded.updated_at`)
    .run(params({ ...u, updated_at: now() }))
}

/**
 * Mark parcels with no address point inside them as vacant.
 *
 * An address point is the most reliable free proxy for a structure: county
 * parcel data carries an improvement flag only sporadically, and it is often
 * years stale. Absence of evidence is treated as vacancy on purpose — the
 * candidate filter is meant to be generous and is narrowed later by scoring.
 */
export function markVacantByNoAddress(fips: string): number {
  const r = db.prepare(`
    UPDATE land_parcels SET vacant = 1
    WHERE fips = @fips AND NOT EXISTS (
      SELECT 1 FROM land_address_bbox b
      WHERE b.min_lon >= land_parcels.min_lon AND b.max_lon <= land_parcels.max_lon
        AND b.min_lat >= land_parcels.min_lat AND b.max_lat <= land_parcels.max_lat
    )
  `).run(params({ fips }))
  return Number(r.changes ?? 0)
}

export function replaceLandAssessments(fips: string, rows: Array<Omit<LandAssessment, 'updated_at'>>): number {
  const ts = now()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM land_assessments WHERE fips = ?').run(fips)
    const ins = db.prepare(`
      INSERT INTO land_assessments (parcel_id, fips, av_land, av_improvement, av_total,
        deeded_acres, class_code, owner_name, owner_street, owner_city, owner_state,
        owner_zip, absentee, assessment_year, updated_at)
      VALUES (@parcel_id, @fips, @av_land, @av_improvement, @av_total,
        @deeded_acres, @class_code, @owner_name, @owner_street, @owner_city, @owner_state,
        @owner_zip, @absentee, @assessment_year, @updated_at)
      ON CONFLICT(parcel_id) DO UPDATE SET
        av_land = excluded.av_land, av_improvement = excluded.av_improvement,
        av_total = excluded.av_total, deeded_acres = excluded.deeded_acres,
        class_code = excluded.class_code, owner_name = excluded.owner_name,
        owner_street = excluded.owner_street, owner_city = excluded.owner_city,
        owner_state = excluded.owner_state, owner_zip = excluded.owner_zip,
        absentee = excluded.absentee, assessment_year = excluded.assessment_year,
        updated_at = excluded.updated_at
    `)
    for (const r of rows) ins.run(params({ ...r, updated_at: ts }))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return rows.length
}

export function getLandAssessment(parcelId: string): LandAssessment | undefined {
  return db.prepare('SELECT * FROM land_assessments WHERE parcel_id = ?').get(parcelId) as LandAssessment | undefined
}

export function countLandAssessments(fips: string): { total: number; absentee: number } {
  const r = db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(absentee), 0) absentee
    FROM land_assessments WHERE fips = ?`).get(fips) as unknown as { total: number; absentee: number }
  return { total: Number(r.total ?? 0), absentee: Number(r.absentee ?? 0) }
}

/**
 * Local assessed land value per acre, as a distribution rather than a mean.
 *
 * Comps are wildly skewed — one tiny high-value lot drags an average far above
 * what acreage actually trades at — so the quartiles are the useful output.
 * The default radius is ~3 miles in degrees, close enough at this latitude and
 * far cheaper than a real distance computation over a whole county.
 */
export function landValuePerAcreNear(o: {
  lat: number
  lon: number
  radiusDeg?: number
  minAcres?: number
  maxAcres?: number
  limit?: number
}): { median: number | null; p25: number | null; p75: number | null; samples: number } {
  const r = o.radiusDeg ?? 0.045
  const rows = db.prepare(`
    SELECT a.av_land / p.acres AS per_acre
    FROM land_parcel_bbox b
    JOIN land_parcels p ON p.rowid = b.rowid
    JOIN land_assessments a ON a.parcel_id = p.id
    WHERE b.max_lon >= @minLon AND b.min_lon <= @maxLon
      AND b.max_lat >= @minLat AND b.min_lat <= @maxLat
      AND p.acres >= @minAcres AND p.acres <= @maxAcres
      AND a.av_land > 0
    ORDER BY per_acre
    LIMIT @limit
  `).all(params({
    minLon: o.lon - r,
    maxLon: o.lon + r,
    minLat: o.lat - r,
    maxLat: o.lat + r,
    minAcres: o.minAcres ?? 0.5,
    maxAcres: o.maxAcres ?? 200,
    limit: o.limit ?? 4000
  })) as unknown as { per_acre: number }[]
  const vals = rows.map((x) => x.per_acre).filter((v) => Number.isFinite(v) && v > 0)
  if (!vals.length) return { median: null, p25: null, p75: null, samples: 0 }
  const at = (q: number): number => vals[Math.min(vals.length - 1, Math.floor(vals.length * q))]
  return { median: at(0.5), p25: at(0.25), p75: at(0.75), samples: vals.length }
}

/** Scored candidate parcels whose owner lives out of county — the approach list. */
export function listAbsenteeOwners(o: {
  fips?: string[]
  verdicts?: string[]
  minAcres?: number
  limit?: number
}): Array<LandParcelScored & {
  owner_name: string | null
  owner_city: string | null
  owner_state: string | null
  av_land: number | null
  av_total: number | null
}> {
  const clauses = ['a.absentee = 1', 'p.candidate = 1', 'p.acres >= @minAcres']
  const args: Record<string, unknown> = {
    minAcres: o.minAcres ?? 1,
    limit: Math.min(Math.max(o.limit ?? 200, 1), 5000)
  }
  if (o.fips?.length) {
    const safe = o.fips.map((f) => String(f).replace(/[^0-9]/g, '')).filter(Boolean)
    if (safe.length) clauses.push('p.fips IN (' + safe.map((f) => "'" + f + "'").join(',') + ')')
  }
  if (o.verdicts?.length) {
    const safe = o.verdicts.map((v) => String(v).replace(/[^a-z]/g, '')).filter(Boolean)
    if (safe.length) clauses.push('s.verdict IN (' + safe.map((v) => "'" + v + "'").join(',') + ')')
  }
  return db.prepare(`
    SELECT p.*, s.total, s.verdict, s.flags, s.hookup_low, s.hookup_high, s.coverage,
           a.owner_name, a.owner_city, a.owner_state, a.av_land, a.av_total
    FROM land_parcels p
    JOIN land_assessments a ON a.parcel_id = p.id
    LEFT JOIN land_scores s ON s.parcel_id = p.id
    WHERE ` + clauses.join(' AND ') + `
    ORDER BY s.total DESC, p.acres DESC
    LIMIT @limit
  `).all(params(args)) as unknown as Array<LandParcelScored & {
    owner_name: string | null
    owner_city: string | null
    owner_state: string | null
    av_land: number | null
    av_total: number | null
  }>
}

/** Just the join keys, for matching an external table against a region cheaply. */
export function listLandParcelKeys(fips: string): Array<{ id: string; pin: string; city: string | null }> {
  return db.prepare('SELECT id, pin, city FROM land_parcels WHERE fips = ?').all(fips) as unknown as Array<{ id: string; pin: string; city: string | null }>
}

export function listLandAnchors(activeOnly = false): LandAnchor[] {
  return (activeOnly
    ? db.prepare('SELECT * FROM land_anchors WHERE active = 1 ORDER BY kind, label').all()
    : db.prepare('SELECT * FROM land_anchors ORDER BY kind, label').all()) as unknown as LandAnchor[]
}

export function upsertLandAnchor(a: Partial<LandAnchor> & { label: string; lat: number; lon: number }): LandAnchor {
  const existing = a.id ? db.prepare('SELECT * FROM land_anchors WHERE id = ?').get(a.id) as LandAnchor | undefined : undefined
  const row: LandAnchor = {
    id: existing?.id ?? a.id ?? randomUUID(),
    label: a.label,
    kind: a.kind ?? existing?.kind ?? 'other',
    lat: Number(a.lat),
    lon: Number(a.lon),
    address: a.address ?? existing?.address ?? null,
    weight: a.weight ?? existing?.weight ?? 1,
    ideal_minutes: a.ideal_minutes ?? existing?.ideal_minutes ?? 20,
    max_minutes: a.max_minutes ?? existing?.max_minutes ?? 60,
    active: a.active ?? existing?.active ?? 1,
    notes: a.notes ?? existing?.notes ?? null,
    created_at: existing?.created_at ?? now()
  }
  db.prepare(`INSERT INTO land_anchors (id, label, kind, lat, lon, address, weight, ideal_minutes, max_minutes, active, notes, created_at)
    VALUES (@id, @label, @kind, @lat, @lon, @address, @weight, @ideal_minutes, @max_minutes, @active, @notes, @created_at)
    ON CONFLICT(id) DO UPDATE SET label = excluded.label, kind = excluded.kind, lat = excluded.lat,
      lon = excluded.lon, address = excluded.address, weight = excluded.weight,
      ideal_minutes = excluded.ideal_minutes, max_minutes = excluded.max_minutes,
      active = excluded.active, notes = excluded.notes`).run(params(row))
  return row
}

export function deleteLandAnchor(id: string): void {
  db.prepare('DELETE FROM land_anchors WHERE id = ?').run(id)
}

export function replaceLandPois(fips: string, rows: Array<{ kind: string; name: string | null; lat: number; lon: number }>): number {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM land_poi_bbox WHERE rowid IN (SELECT id FROM land_pois WHERE fips = ?)').run(fips)
    db.prepare('DELETE FROM land_pois WHERE fips = ?').run(fips)
    const ins = db.prepare('INSERT INTO land_pois (fips, kind, name, lat, lon) VALUES (?, ?, ?, ?, ?)')
    const insBox = db.prepare('INSERT INTO land_poi_bbox (rowid, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)')
    for (const r of rows) {
      const res = ins.run(fips, r.kind, r.name, r.lat, r.lon)
      insBox.run(Number(res.lastInsertRowid), r.lon, r.lon, r.lat, r.lat)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return rows.length
}

export function countLandPois(fips: string): Record<string, number> {
  const rows = db.prepare('SELECT kind, COUNT(*) n FROM land_pois WHERE fips = ? GROUP BY kind').all(fips) as unknown as { kind: string; n: number }[]
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]))
}

export function listLandPois(fips: string): Array<{ kind: string; name: string | null; lat: number; lon: number }> {
  return db.prepare('SELECT kind, name, lat, lon FROM land_pois WHERE fips = ?').all(fips) as unknown as Array<{ kind: string; name: string | null; lat: number; lon: number }>
}

export function putLandFit(f: Omit<LandFit, 'scored_at'>): void {
  db.prepare(`INSERT INTO land_fit (parcel_id, score, verdict, commute_minutes, detail, scored_at)
    VALUES (@parcel_id, @score, @verdict, @commute_minutes, @detail, @scored_at)
    ON CONFLICT(parcel_id) DO UPDATE SET score = excluded.score, verdict = excluded.verdict,
      commute_minutes = excluded.commute_minutes, detail = excluded.detail, scored_at = excluded.scored_at`)
    .run(params({ ...f, scored_at: now() }))
}

export function countLandFit(fips: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM land_fit f JOIN land_parcels p ON p.id = f.parcel_id
    WHERE p.fips = ?`).get(fips) as unknown as { c: number }).c
}

// ---------- drops (limited-run availability) ----------
export interface DropWatch {
  id: string
  label: string
  /** shopify | page */
  kind: string
  url: string
  /** Optional case-insensitive substring; only matching products are tracked. */
  title_match: string | null
  /** hot | normal */
  priority: string
  enabled: number
  notify: number
  etag: string | null
  last_checked_at: number | null
  last_ok_at: number | null
  last_error: string | null
  /** Observed sell-out behaviour; written by the scorer, null until scored. */
  heat: number | null
  sellout_rate: number | null
  median_uptime_ms: number | null
  scored_at: number | null
  /** 1 when the user set the priority by hand; auto-tiering skips it. */
  pinned: number
  /** CSV of transition kinds worth alerting on; null uses the app default. */
  alert_kinds: string | null
  /** Per-product silence window after an alert; null uses the app default. */
  alert_cooldown_ms: number | null
  created_at: number
  updated_at: number
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

export interface DropEvent {
  id: string
  watch_id: string
  product_id: string | null
  /** restock | sold_out | new_product | removed | price_change */
  kind: string
  title: string
  detail: string | null
  url: string | null
  price: number | null
  seen: number
  created_at: number
}

/** An event carrying the label of the watch that produced it. */
export interface DropEventJoined extends DropEvent {
  watch_label: string
}

export function listDropWatches(): DropWatch[] {
  return db.prepare('SELECT * FROM drop_watches ORDER BY created_at').all() as unknown as DropWatch[]
}

export function getDropWatch(id: string): DropWatch | undefined {
  return db.prepare('SELECT * FROM drop_watches WHERE id = ?').get(id) as DropWatch | undefined
}

/** The url is unique, so this is how a seed decides whether to insert. */
export function findDropWatchByUrl(url: string): DropWatch | undefined {
  return db.prepare('SELECT * FROM drop_watches WHERE url = ?').get(url) as DropWatch | undefined
}

export function createDropWatch(w: {
  label: string
  kind?: string
  url: string
  title_match?: string | null
  priority?: string
  notify?: boolean | number
}): DropWatch {
  const row: DropWatch = {
    id: randomUUID(),
    label: w.label.trim(),
    kind: (w.kind || 'shopify').trim().toLowerCase(),
    url: w.url.trim().replace(/\/+$/, ''),
    title_match: w.title_match?.trim() || null,
    priority: (w.priority || 'normal').trim().toLowerCase(),
    enabled: 1,
    // Default ON, same reasoning as an MTG watch: a watch exists to alert.
    notify: w.notify === false || w.notify === 0 ? 0 : 1,
    etag: null,
    last_checked_at: null,
    last_ok_at: null,
    last_error: null,
    heat: null,
    sellout_rate: null,
    median_uptime_ms: null,
    scored_at: null,
    pinned: 0,
    alert_kinds: null,
    alert_cooldown_ms: null,
    created_at: now(),
    updated_at: now()
  }
  // Every key of `row` must be named here: node:sqlite throws "Unknown named
  // parameter" for any extra one, and when the heat/alert columns were added to
  // the row but not to this list, every new watch failed to insert.
  db.prepare(`INSERT INTO drop_watches (id, label, kind, url, title_match, priority, enabled, notify, etag, last_checked_at, last_ok_at, last_error,
      heat, sellout_rate, median_uptime_ms, scored_at, pinned, alert_kinds, alert_cooldown_ms, created_at, updated_at)
    VALUES (@id, @label, @kind, @url, @title_match, @priority, @enabled, @notify, @etag, @last_checked_at, @last_ok_at, @last_error,
      @heat, @sellout_rate, @median_uptime_ms, @scored_at, @pinned, @alert_kinds, @alert_cooldown_ms, @created_at, @updated_at)`).run(params(row))
  return row
}

export function updateDropWatch(id: string, patch: Partial<DropWatch>): void {
  const allowed = ['label', 'kind', 'url', 'title_match', 'priority', 'enabled', 'notify', 'etag', 'last_checked_at', 'last_ok_at', 'last_error', 'heat', 'sellout_rate', 'median_uptime_ms', 'scored_at', 'pinned', 'alert_kinds', 'alert_cooldown_ms'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if (!sets.length) return
  sets.push('updated_at = @updated_at')
  p.updated_at = now()
  db.prepare(`UPDATE drop_watches SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function deleteDropWatch(id: string): void {
  db.prepare('DELETE FROM drop_watches WHERE id = ?').run(id)
}

/**
 * Products a watch has ever seen. Sold-out rows are included by default,
 * because for a drop watcher they are the normal resting state — the whole
 * point is to be holding them when one flips.
 */
export function listDropProducts(watchId?: string, includeGone = false): DropProduct[] {
  const where: string[] = []
  const p: Record<string, unknown> = {}
  if (watchId) { where.push('watch_id = @watchId'); p.watchId = watchId }
  if (!includeGone) where.push('gone = 0')
  return db.prepare(`SELECT * FROM drop_products${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY available DESC, title`).all(params(p)) as unknown as DropProduct[]
}

export function getDropProduct(id: string): DropProduct | undefined {
  return db.prepare('SELECT * FROM drop_products WHERE id = ?').get(id) as DropProduct | undefined
}

/**
 * Record what a poll saw.
 *
 * first_seen_at survives updates — it is what makes "this product appeared
 * forty seconds ago" answerable — and last_available_at only ever moves
 * forward, so the history survives a product going back out of stock.
 */
export function upsertDropProduct(p: {
  id: string
  watch_id: string
  ext_id: string
  handle?: string | null
  title: string
  url?: string | null
  image?: string | null
  price?: number | null
  available: boolean | number
  variants_total?: number
  variants_available?: number
  product_type?: string | null
  published_at?: number | null
}): void {
  const avail = p.available ? 1 : 0
  const stamp = now()
  db.prepare(`INSERT INTO drop_products (id, watch_id, ext_id, handle, title, url, image, price, available,
      variants_total, variants_available, product_type, published_at, first_seen_at, last_seen_at, last_available_at, gone)
    VALUES (@id, @watch_id, @ext_id, @handle, @title, @url, @image, @price, @available,
      @variants_total, @variants_available, @product_type, @published_at, @stamp, @stamp, @last_available_at, 0)
    ON CONFLICT(id) DO UPDATE SET
      handle = excluded.handle, title = excluded.title, url = excluded.url, image = excluded.image,
      price = excluded.price, available = excluded.available,
      variants_total = excluded.variants_total, variants_available = excluded.variants_available,
      product_type = excluded.product_type, published_at = excluded.published_at,
      last_seen_at = excluded.last_seen_at,
      last_available_at = COALESCE(excluded.last_available_at, drop_products.last_available_at),
      gone = 0`).run(params({
    id: p.id,
    watch_id: p.watch_id,
    ext_id: p.ext_id,
    handle: p.handle ?? null,
    title: p.title,
    url: p.url ?? null,
    image: p.image ?? null,
    price: p.price == null ? null : Number(p.price),
    available: avail,
    variants_total: p.variants_total ?? 0,
    variants_available: p.variants_available ?? 0,
    product_type: p.product_type ?? null,
    published_at: p.published_at ?? null,
    stamp,
    last_available_at: avail ? stamp : null
  }))
}

/** Flag products a poll no longer returned; never deletes, see the schema note. */
export function markDropProductsGone(watchId: string, keepExtIds: string[]): number {
  if (!keepExtIds.length) {
    const r = db.prepare('UPDATE drop_products SET gone = 1 WHERE watch_id = ? AND gone = 0').run(watchId)
    return Number(r.changes ?? 0)
  }
  const holes = keepExtIds.map(() => '?').join(',')
  const r = db.prepare(`UPDATE drop_products SET gone = 1
    WHERE watch_id = ? AND gone = 0 AND ext_id NOT IN (${holes})`).run(watchId, ...keepExtIds)
  return Number(r.changes ?? 0)
}

export function addDropEvent(e: {
  watch_id: string
  product_id?: string | null
  kind: string
  title: string
  detail?: string | null
  url?: string | null
  price?: number | null
}): DropEvent {
  const row: DropEvent = {
    id: randomUUID(),
    watch_id: e.watch_id,
    product_id: e.product_id ?? null,
    kind: e.kind,
    title: e.title,
    detail: e.detail ?? null,
    url: e.url ?? null,
    price: e.price == null ? null : Number(e.price),
    seen: 0,
    created_at: now()
  }
  db.prepare(`INSERT INTO drop_events (id, watch_id, product_id, kind, title, detail, url, price, seen, created_at)
    VALUES (@id, @watch_id, @product_id, @kind, @title, @detail, @url, @price, @seen, @created_at)`).run(params(row))
  return row
}

export function listDropEvents(opts?: { watchId?: string; limit?: number }): DropEventJoined[] {
  const where: string[] = []
  const p: Record<string, unknown> = { limit: Math.min(Math.max(opts?.limit ?? 200, 1), 1000) }
  if (opts?.watchId) { where.push('e.watch_id = @watchId'); p.watchId = opts.watchId }
  return db.prepare(`SELECT e.*, w.label AS watch_label FROM drop_events e
    JOIN drop_watches w ON w.id = e.watch_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.created_at DESC LIMIT @limit`).all(params(p)) as unknown as DropEventJoined[]
}

export function markDropEventsSeen(watchId?: string): void {
  if (watchId) db.prepare('UPDATE drop_events SET seen = 1 WHERE watch_id = ? AND seen = 0').run(watchId)
  else db.prepare('UPDATE drop_events SET seen = 1 WHERE seen = 0').run()
}

export function unseenDropEventCount(): number {
  return (db.prepare('SELECT COUNT(*) n FROM drop_events WHERE seen = 0').get() as unknown as { n: number }).n
}

/** Cap the timeline. A restock every twenty minutes would grow without bound. */
export function pruneDropEvents(keep = 2000): void {
  db.prepare(`DELETE FROM drop_events WHERE id IN (
    SELECT id FROM drop_events ORDER BY created_at DESC LIMIT -1 OFFSET @keep
  )`).run(params({ keep }))
}

// ---------- alert cooldown ----------

/**
 * Claim the right to send one alert, atomically.
 *
 * Returns true at most once per cooldown window for a given key. The check and
 * the write are one statement on purpose: two sweeps overlapping (a manual
 * "check now" landing on top of the scheduler) would otherwise both read "no
 * recent send" and both fire.
 */
export function claimAlert(key: string, cooldownMs: number, now = Date.now()): boolean {
  const r = db.prepare(`INSERT INTO alert_sends (key, sent_at) VALUES (@key, @now)
    ON CONFLICT(key) DO UPDATE SET sent_at = excluded.sent_at
      WHERE alert_sends.sent_at <= @cutoff`)
    .run(params({ key, now, cutoff: now - cooldownMs }))
  return r.changes > 0
}

/** Forget cooldowns older than any plausible window, so the table stays small. */
export function pruneAlertSends(olderThanMs = 7 * 86_400_000): void {
  db.prepare('DELETE FROM alert_sends WHERE sent_at < ?').run(Date.now() - olderThanMs)
}

// ---------- drop candidates (discovery pool) ----------
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

/**
 * Bulk-add discovered domains. Ignores collisions rather than updating, so a
 * re-run of discovery never clobbers a probe result that already cost a
 * request. Returns how many were genuinely new.
 */
export function addDropCandidates(domains: Array<{ domain: string; source: string }>): number {
  if (!domains.length) return 0
  const ins = db.prepare(`INSERT INTO drop_candidates (domain, source, shopify, products, title_sample, niche_score, promoted, probed_at, error, created_at)
    VALUES (@domain, @source, NULL, NULL, NULL, NULL, 0, NULL, NULL, @created_at)
    ON CONFLICT(domain) DO NOTHING`)
  let added = 0
  db.exec('BEGIN')
  try {
    for (const d of domains) {
      const r = ins.run(params({ domain: d.domain, source: d.source, created_at: now() }))
      added += Number(r.changes ?? 0)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return added
}

/** Domains not yet probed — the work queue for the prober. */
export function listUnprobedCandidates(limit = 200): DropCandidate[] {
  return db.prepare('SELECT * FROM drop_candidates WHERE probed_at IS NULL ORDER BY created_at LIMIT ?')
    .all(limit) as unknown as DropCandidate[]
}

export function updateDropCandidate(domain: string, patch: Partial<DropCandidate>): void {
  const allowed = ['source', 'shopify', 'products', 'title_sample', 'niche_score', 'promoted', 'probed_at', 'error'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { domain }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if (!sets.length) return
  db.prepare(`UPDATE drop_candidates SET ${sets.join(', ')} WHERE domain = @domain`).run(params(p))
}

/** Confirmed shops, best niche fit first, that have not been promoted yet. */
export function listTopCandidates(limit = 50): DropCandidate[] {
  return db.prepare(`SELECT * FROM drop_candidates
    WHERE shopify = 1 AND promoted = 0 AND niche_score IS NOT NULL
    ORDER BY niche_score DESC, products DESC LIMIT ?`).all(limit) as unknown as DropCandidate[]
}

export function dropCandidateCounts(): { total: number; probed: number; shopify: number; promoted: number } {
  const r = db.prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(probed_at IS NOT NULL), 0) probed,
    COALESCE(SUM(shopify = 1), 0) shopify,
    COALESCE(SUM(promoted = 1), 0) promoted
    FROM drop_candidates`).get() as unknown as { total: number; probed: number; shopify: number; promoted: number }
  return { total: Number(r.total), probed: Number(r.probed), shopify: Number(r.shopify), promoted: Number(r.promoted) }
}

// ---------- signals (demand intent) ----------
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

export interface SignalSuggestion {
  id: string
  term_id: string
  suggestion: string
  /** purchase | scarcity | release | resale | community | other */
  intent: string
  rank: number
  observed_on: string
  created_at: number
}

export function listSignalTerms(): SignalTerm[] {
  return db.prepare('SELECT * FROM signal_terms ORDER BY created_at').all() as unknown as SignalTerm[]
}

export function findSignalTerm(term: string): SignalTerm | undefined {
  return db.prepare('SELECT * FROM signal_terms WHERE term = ?').get(term.trim().toLowerCase()) as SignalTerm | undefined
}

export function createSignalTerm(t: { term: string; source?: string; watch_id?: string | null }): SignalTerm {
  const row: SignalTerm = {
    id: randomUUID(),
    term: t.term.trim().toLowerCase(),
    source: t.source ?? 'manual',
    watch_id: t.watch_id ?? null,
    enabled: 1,
    last_checked_at: null,
    last_error: null,
    created_at: now()
  }
  db.prepare(`INSERT INTO signal_terms (id, term, source, watch_id, enabled, last_checked_at, last_error, created_at)
    VALUES (@id, @term, @source, @watch_id, @enabled, @last_checked_at, @last_error, @created_at)`).run(params(row))
  return row
}

export function updateSignalTerm(id: string, patch: Partial<SignalTerm>): void {
  const allowed = ['term', 'source', 'watch_id', 'enabled', 'last_checked_at', 'last_error'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if (!sets.length) return
  db.prepare(`UPDATE signal_terms SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function deleteSignalTerm(id: string): void {
  db.prepare('DELETE FROM signal_terms WHERE id = ?').run(id)
}

/**
 * Store one day's completions. Day-keyed, so the scheduler can run as often as
 * it likes without inflating the history — the same completion seen twice in a
 * day is one row whose rank is refreshed.
 */
export function recordSuggestions(
  termId: string,
  rows: Array<{ suggestion: string; intent: string; rank: number }>,
  observedOn: string
): void {
  const ins = db.prepare(`INSERT INTO signal_suggestions (id, term_id, suggestion, intent, rank, observed_on, created_at)
    VALUES (@id, @term_id, @suggestion, @intent, @rank, @observed_on, @created_at)
    ON CONFLICT(term_id, suggestion, observed_on) DO UPDATE SET
      rank = MIN(signal_suggestions.rank, excluded.rank), intent = excluded.intent`)
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      ins.run(params({
        id: randomUUID(),
        term_id: termId,
        suggestion: r.suggestion,
        intent: r.intent,
        rank: r.rank,
        observed_on: observedOn,
        created_at: now()
      }))
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function listSuggestions(termId: string, observedOn?: string): SignalSuggestion[] {
  if (observedOn) {
    return db.prepare('SELECT * FROM signal_suggestions WHERE term_id = ? AND observed_on = ? ORDER BY rank, suggestion')
      .all(termId, observedOn) as unknown as SignalSuggestion[]
  }
  return db.prepare(`SELECT * FROM signal_suggestions WHERE term_id = ?
    AND observed_on = (SELECT MAX(observed_on) FROM signal_suggestions WHERE term_id = ?)
    ORDER BY rank, suggestion`).all(termId, termId) as unknown as SignalSuggestion[]
}

export interface SuggestionMove {
  suggestion: string
  intent: string
  rank: number
  /** Rank on the earliest day in the window; null when it is newly present. */
  wasRank: number | null
  /** Positive means it climbed (toward rank 0) since the window opened. */
  delta: number | null
}

/**
 * Rank movement for a term's completions over a window.
 *
 * A completion that is NEW in the window is the strongest signal of all — it
 * means a phrase nobody was typing has become common enough for Google to
 * suggest it — so those are reported with a null wasRank rather than dropped.
 */
export function suggestionMoves(termId: string, days = 7): SuggestionMove[] {
  const since = new Date(Date.now() - days * 86_400_000)
  const p = (n: number): string => String(n).padStart(2, '0')
  const sinceYmd = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())}`
  return db.prepare(`
    WITH latest AS (
      SELECT suggestion, intent, rank FROM signal_suggestions
      WHERE term_id = @term AND observed_on = (SELECT MAX(observed_on) FROM signal_suggestions WHERE term_id = @term)
    ),
    earliest AS (
      SELECT suggestion, MIN(rank) rank FROM signal_suggestions
      WHERE term_id = @term AND observed_on >= @since
        AND observed_on = (SELECT MIN(observed_on) FROM signal_suggestions WHERE term_id = @term AND observed_on >= @since)
      GROUP BY suggestion
    )
    SELECT l.suggestion, l.intent, l.rank, e.rank AS wasRank,
      CASE WHEN e.rank IS NULL THEN NULL ELSE e.rank - l.rank END AS delta
    FROM latest l LEFT JOIN earliest e ON e.suggestion = l.suggestion
    ORDER BY (e.rank IS NOT NULL), delta DESC, l.rank
  `).all(params({ term: termId, since: sinceYmd })) as unknown as SuggestionMove[]
}

/** Distinct days on which a term has been sampled — how much history exists. */
export function signalDayCount(termId: string): number {
  return Number((db.prepare('SELECT COUNT(DISTINCT observed_on) n FROM signal_suggestions WHERE term_id = ?')
    .get(termId) as unknown as { n: number }).n)
}

/** Cap suggestion history; a term sampled daily for a year is plenty. */
export function pruneSignalSuggestions(keepDays = 400): void {
  const cut = new Date(Date.now() - keepDays * 86_400_000)
  const p = (n: number): string => String(n).padStart(2, '0')
  db.prepare('DELETE FROM signal_suggestions WHERE observed_on < ?')
    .run(`${cut.getFullYear()}-${p(cut.getMonth() + 1)}-${p(cut.getDate())}`)
}

// ---------- discord (public community telemetry) ----------
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

export interface DiscordSample {
  id: string
  discord_id: string
  members: number | null
  online: number | null
  observed_at: number
  observed_hour: string
}

export function listDiscordWatches(): DiscordWatch[] {
  return db.prepare('SELECT * FROM discord_watches ORDER BY created_at').all() as unknown as DiscordWatch[]
}

export function getDiscordWatch(id: string): DiscordWatch | undefined {
  return db.prepare('SELECT * FROM discord_watches WHERE id = ?').get(id) as DiscordWatch | undefined
}

export function findDiscordWatchByCode(code: string): DiscordWatch | undefined {
  return db.prepare('SELECT * FROM discord_watches WHERE invite_code = ?').get(code) as DiscordWatch | undefined
}

export function createDiscordWatch(w: {
  invite_code: string
  label: string
  guild_id?: string | null
  watch_id?: string | null
}): DiscordWatch {
  const row: DiscordWatch = {
    id: randomUUID(),
    invite_code: w.invite_code.trim(),
    guild_id: w.guild_id ?? null,
    label: w.label.trim(),
    watch_id: w.watch_id ?? null,
    enabled: 1,
    last_checked_at: null,
    last_error: null,
    created_at: now()
  }
  db.prepare(`INSERT INTO discord_watches (id, invite_code, guild_id, label, watch_id, enabled, last_checked_at, last_error, created_at)
    VALUES (@id, @invite_code, @guild_id, @label, @watch_id, @enabled, @last_checked_at, @last_error, @created_at)`).run(params(row))
  return row
}

export function updateDiscordWatch(id: string, patch: Partial<DiscordWatch>): void {
  const allowed = ['invite_code', 'guild_id', 'label', 'watch_id', 'enabled', 'last_checked_at', 'last_error'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) if (k in patch) { sets.push(`${k} = @${k}`); p[k] = (patch as Record<string, unknown>)[k] }
  if (!sets.length) return
  db.prepare(`UPDATE discord_watches SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function deleteDiscordWatch(id: string): void {
  db.prepare('DELETE FROM discord_watches WHERE id = ?').run(id)
}

/** Hour-keyed, so polling more often than hourly refines rather than inflates. */
export function recordDiscordSample(s: {
  discord_id: string
  members: number | null
  online: number | null
  observedHour: string
}): void {
  db.prepare(`INSERT INTO discord_samples (id, discord_id, members, online, observed_at, observed_hour)
    VALUES (@id, @discord_id, @members, @online, @observed_at, @observed_hour)
    ON CONFLICT(discord_id, observed_hour) DO UPDATE SET
      members = excluded.members, online = excluded.online, observed_at = excluded.observed_at`).run(params({
    id: randomUUID(),
    discord_id: s.discord_id,
    members: s.members,
    online: s.online,
    observed_at: now(),
    observed_hour: s.observedHour
  }))
}

/**
 * Newest first, ordered by the hour a sample DESCRIBES rather than the moment
 * it was written. The two differ whenever history is backfilled, and ordering
 * on write time then reports an old row as the current one — which silently
 * inverts every growth figure derived from it. observed_hour is
 * YYYY-MM-DDTHH, so lexical order is chronological order.
 */
export function listDiscordSamples(discordId: string, limit = 400): DiscordSample[] {
  return db.prepare('SELECT * FROM discord_samples WHERE discord_id = ? ORDER BY observed_hour DESC LIMIT ?')
    .all(discordId, limit) as unknown as DiscordSample[]
}

/** Oldest sample at or after an hour bucket — the baseline end of a window. */
export function discordSampleAt(discordId: string, sinceHour: string): DiscordSample | undefined {
  return db.prepare(`SELECT * FROM discord_samples WHERE discord_id = ? AND observed_hour >= ?
    ORDER BY observed_hour ASC LIMIT 1`).get(discordId, sinceHour) as DiscordSample | undefined
}

export function pruneDiscordSamples(keepDays = 180): void {
  db.prepare('DELETE FROM discord_samples WHERE observed_at < ?').run(Date.now() - keepDays * 86_400_000)
}

/**
 * Reconcile the vacancy flag against assessed improvement value.
 *
 * The class code is a proxy for "no building"; a zero improvement value is the
 * assessor's own statement of it. Once assessments are loaded, prefer the fact
 * — which also repairs parcels ingested under an earlier, wronger class list
 * without needing a full re-ingest of the county.
 */
export function reconcileVacancyFromAssessments(fips: string): { vacant: number; changed: number } {
  const before = (db.prepare('SELECT COUNT(*) c FROM land_parcels WHERE fips = ? AND vacant = 1')
    .get(fips) as { c: number }).c
  db.prepare(`
    UPDATE land_parcels SET vacant = (
      SELECT CASE WHEN a.av_improvement IS NOT NULL AND a.av_improvement = 0 THEN 1 ELSE 0 END
      FROM land_assessments a WHERE a.parcel_id = land_parcels.id
    )
    WHERE fips = @fips
      AND EXISTS (SELECT 1 FROM land_assessments a
                  WHERE a.parcel_id = land_parcels.id AND a.av_improvement IS NOT NULL)
  `).run(params({ fips }))
  const after = (db.prepare('SELECT COUNT(*) c FROM land_parcels WHERE fips = ? AND vacant = 1')
    .get(fips) as { c: number }).c
  return { vacant: after, changed: Math.abs(after - before) }
}

// ---------- tcg (card watches for games other than Magic) ----------
// Only ever touches tcg_* tables. Nothing here reads or writes an mtg_* row.

export interface TcgWatch {
  id: string
  game: string
  game_label: string
  product_id: string
  /** Normal | Foil */
  printing: string
  /** card | sealed */
  kind: string
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

export interface TcgObservation {
  id: string
  watch_id: string
  observed_at: number
  price: number | null
  median: number | null
  in_stock: number | null
  note: string | null
}

export function listTcgWatches(game?: string): TcgWatch[] {
  // Sealed first, then cards by name — a booster box is usually what is being watched.
  const order = "ORDER BY CASE kind WHEN 'sealed' THEN 0 ELSE 1 END, name COLLATE NOCASE, printing"
  return (game
    ? db.prepare(`SELECT * FROM tcg_watches WHERE game = ? ${order}`).all(game)
    : db.prepare(`SELECT * FROM tcg_watches ${order}`).all()) as unknown as TcgWatch[]
}

export function getTcgWatch(id: string): TcgWatch | undefined {
  return db.prepare('SELECT * FROM tcg_watches WHERE id = ?').get(id) as TcgWatch | undefined
}

export function findTcgWatch(productId: string, printing: string): TcgWatch | undefined {
  return db.prepare('SELECT * FROM tcg_watches WHERE product_id = ? AND printing = ?').get(productId, printing) as
    | TcgWatch
    | undefined
}

export function createTcgWatch(w: {
  game: string
  game_label: string
  product_id: string
  printing: string
  kind: string
  name: string
  set_name?: string | null
  rarity?: string | null
  image_url?: string | null
  target_price?: number | null
}): TcgWatch {
  const target = w.target_price == null ? null : Number(w.target_price)
  const row: TcgWatch = {
    id: randomUUID(),
    game: w.game,
    game_label: w.game_label,
    product_id: w.product_id,
    printing: w.printing,
    kind: w.kind,
    name: w.name,
    set_name: w.set_name ?? null,
    rarity: w.rarity ?? null,
    image_url: w.image_url ?? null,
    target_price: target != null && Number.isFinite(target) ? target : null,
    notify: 1,
    notes: null,
    last_price: null,
    last_median: null,
    last_in_stock: null,
    last_checked_at: null,
    last_ok_at: null,
    last_error: null,
    created_at: now(),
    updated_at: now()
  }
  db.prepare(`INSERT INTO tcg_watches (id, game, game_label, product_id, printing, kind, name, set_name, rarity, image_url,
      target_price, notify, notes, last_price, last_median, last_in_stock, last_checked_at, last_ok_at, last_error, created_at, updated_at)
    VALUES (@id, @game, @game_label, @product_id, @printing, @kind, @name, @set_name, @rarity, @image_url,
      @target_price, @notify, @notes, @last_price, @last_median, @last_in_stock, @last_checked_at, @last_ok_at, @last_error, @created_at, @updated_at)`)
    .run(params(row))
  return row
}

export function updateTcgWatch(id: string, patch: Partial<TcgWatch>): void {
  const allowed = ['target_price', 'notify', 'notes', 'last_price', 'last_median', 'last_in_stock', 'last_checked_at', 'last_ok_at', 'last_error'] as const
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of allowed) {
    if (!(k in patch)) continue
    const v = (patch as Record<string, unknown>)[k]
    let val: unknown = typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v
    if (k === 'target_price' && val != null) {
      const n = Number(val)
      val = Number.isFinite(n) && n > 0 ? n : null
    }
    sets.push(`${k} = @${k}`)
    p[k] = val
  }
  if (!sets.length) return
  sets.push('updated_at = @updated_at')
  p.updated_at = now()
  db.prepare(`UPDATE tcg_watches SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

export function deleteTcgWatch(id: string): void {
  // History goes with it via ON DELETE CASCADE.
  db.prepare('DELETE FROM tcg_watches WHERE id = ?').run(id)
}

export function addTcgObservation(o: { watch_id: string; price: number | null; median: number | null; in_stock: number | null; note?: string | null }): void {
  db.prepare(`INSERT INTO tcg_observations (id, watch_id, observed_at, price, median, in_stock, note)
    VALUES (@id, @watch_id, @observed_at, @price, @median, @in_stock, @note)`).run(
    params({ id: randomUUID(), watch_id: o.watch_id, observed_at: Date.now(), price: o.price, median: o.median, in_stock: o.in_stock, note: o.note ?? null })
  )
}

export function latestTcgObservation(watchId: string): TcgObservation | undefined {
  return db.prepare('SELECT * FROM tcg_observations WHERE watch_id = ? ORDER BY observed_at DESC LIMIT 1').get(watchId) as
    | TcgObservation
    | undefined
}

export function listTcgObservations(watchId: string): TcgObservation[] {
  return db.prepare('SELECT * FROM tcg_observations WHERE watch_id = ? ORDER BY observed_at ASC').all(watchId) as unknown as TcgObservation[]
}

// ---------------------------------------------------------------- mtg decks

export interface MtgDeck {
  id: string
  name: string
  kind: 'custom' | 'precon' | 'cedh' | 'edhrec'
  color_identity: string
  source_ref: string | null
  source_url: string | null
  notes: string | null
  created_at: number
  updated_at: number
}

export interface MtgDeckCard {
  deck_id: string
  name: string
  name_key: string
  ext_id: string | null
  quantity: number
  board: 'commander' | 'main'
}

type DeckCardInput = { name: string; ext_id?: string | null; quantity?: number; board?: 'commander' | 'main' }

export function listMtgDecks(): MtgDeck[] {
  return db.prepare('SELECT * FROM mtg_decks ORDER BY updated_at DESC').all() as unknown as MtgDeck[]
}

export function getMtgDeck(id: string): MtgDeck | undefined {
  return db.prepare('SELECT * FROM mtg_decks WHERE id = ?').get(id) as MtgDeck | undefined
}

export function findMtgDeckBySource(sourceRef: string): MtgDeck | undefined {
  return db.prepare('SELECT * FROM mtg_decks WHERE source_ref = ? LIMIT 1').get(sourceRef) as MtgDeck | undefined
}

export function listMtgDeckCards(deckId?: string): MtgDeckCard[] {
  return (deckId
    ? db.prepare("SELECT * FROM mtg_deck_cards WHERE deck_id = ? ORDER BY board = 'main', name").all(deckId)
    : db.prepare('SELECT * FROM mtg_deck_cards').all()) as unknown as MtgDeckCard[]
}

/**
 * Create a deck with its whole list in one transaction. Duplicate names on
 * the same board merge into one row with the counts added, since imports
 * routinely list a card once per printing.
 */
export function createMtgDeck(
  d: { name: string; kind?: MtgDeck['kind']; color_identity?: string; source_ref?: string | null; source_url?: string | null; notes?: string | null },
  cards: DeckCardInput[] = []
): MtgDeck {
  const row: MtgDeck = {
    id: randomUUID(),
    name: d.name.trim() || 'Untitled deck',
    kind: d.kind ?? 'custom',
    color_identity: d.color_identity ?? '',
    source_ref: d.source_ref ?? null,
    source_url: d.source_url ?? null,
    notes: d.notes ?? null,
    created_at: now(),
    updated_at: now()
  }
  db.exec('BEGIN')
  try {
    db.prepare(`INSERT INTO mtg_decks (id, name, kind, color_identity, source_ref, source_url, notes, created_at, updated_at)
      VALUES (@id, @name, @kind, @color_identity, @source_ref, @source_url, @notes, @created_at, @updated_at)`).run(params(row))
    for (const c of cards) upsertDeckCardRow(row.id, c, true)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return row
}

/** `add` sums onto an existing row (imports); otherwise the count is set, and 0 removes. */
function upsertDeckCardRow(deckId: string, c: DeckCardInput, add: boolean): void {
  const key = cardNameKey(c.name)
  if (!key) return
  const qty = Math.max(0, Math.round(Number(c.quantity ?? 1)) || 0)
  const board = c.board === 'commander' ? 'commander' : 'main'
  if (!add && qty === 0) {
    db.prepare('DELETE FROM mtg_deck_cards WHERE deck_id = ? AND name_key = ? AND board = ?').run(deckId, key, board)
    return
  }
  const merge = add ? 'mtg_deck_cards.quantity + excluded.quantity' : 'excluded.quantity'
  db.prepare(`INSERT INTO mtg_deck_cards (deck_id, name, name_key, ext_id, quantity, board)
    VALUES (@deck_id, @name, @name_key, @ext_id, @quantity, @board)
    ON CONFLICT(deck_id, name_key, board) DO UPDATE SET
      quantity = ${merge},
      ext_id = COALESCE(excluded.ext_id, mtg_deck_cards.ext_id)`).run(
    params({ deck_id: deckId, name: c.name.trim(), name_key: key, ext_id: c.ext_id ?? null, quantity: Math.max(1, qty), board })
  )
}

/** Set one card's count on a board (0 removes it). */
export function setMtgDeckCard(deckId: string, c: DeckCardInput & { quantity: number }): void {
  upsertDeckCardRow(deckId, c, false)
  touchMtgDeck(deckId)
}

/** Move a card between the command zone and the 99. */
export function moveMtgDeckCard(deckId: string, name: string, to: 'commander' | 'main'): void {
  const key = cardNameKey(name)
  const from = to === 'commander' ? 'main' : 'commander'
  const row = db.prepare('SELECT * FROM mtg_deck_cards WHERE deck_id = ? AND name_key = ? AND board = ?')
    .get(deckId, key, from) as MtgDeckCard | undefined
  if (!row) return
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM mtg_deck_cards WHERE deck_id = ? AND name_key = ? AND board = ?').run(deckId, key, from)
    upsertDeckCardRow(deckId, { name: row.name, ext_id: row.ext_id, quantity: 1, board: to }, false)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  touchMtgDeck(deckId)
}

export function updateMtgDeck(id: string, patch: Partial<Pick<MtgDeck, 'name' | 'notes' | 'color_identity' | 'kind'>>): void {
  const sets: string[] = []
  const p: Record<string, unknown> = { id }
  for (const k of ['name', 'notes', 'color_identity', 'kind'] as const) {
    if (patch[k] === undefined) continue
    sets.push(`${k} = @${k}`)
    p[k] = patch[k]
  }
  if (!sets.length) return
  sets.push('updated_at = @updated_at')
  p.updated_at = now()
  db.prepare(`UPDATE mtg_decks SET ${sets.join(', ')} WHERE id = @id`).run(params(p))
}

function touchMtgDeck(id: string): void {
  db.prepare('UPDATE mtg_decks SET updated_at = ? WHERE id = ?').run(now(), id)
}

export function deleteMtgDeck(id: string): void {
  // Cards go with it via ON DELETE CASCADE.
  db.prepare('DELETE FROM mtg_decks WHERE id = ?').run(id)
}

/**
 * Every owned single, one row per vault row, with the facts a deck view needs.
 * The name comes from the metadata cache when synced (Scryfall's spelling,
 * which decklists use) and from the vault row otherwise.
 */
export interface MtgOwnedCardFact {
  vault_id: string
  name: string
  ext_id: string | null
  ext_source: string | null
  quantity: number
  variant: string | null
  notes: string | null
  type_line: string | null
  mana_cost: string | null
  cmc: number | null
  color_identity: string | null
  last_price: number | null
}

export function listMtgOwnedCardFacts(): MtgOwnedCardFact[] {
  return db.prepare(`
    SELECT v.id AS vault_id, COALESCE(m.name, v.name) AS name, v.ext_id, v.ext_source, v.quantity, v.variant, v.notes,
      m.type_line, m.mana_cost, m.cmc, m.color_identity,
      (SELECT p.price FROM mtg_prices p
        WHERE p.ext_id = v.ext_id AND p.variant = v.variant
        ORDER BY p.observed_on DESC LIMIT 1) AS last_price
    FROM vault_items v
    LEFT JOIN mtg_card_meta m ON m.ext_id = v.ext_id
    WHERE v.category = 'mtg_card'
  `).all() as unknown as MtgOwnedCardFact[]
}

export interface MtgCardInfo {
  name_key: string
  name: string
  ext_id: string | null
  type_line: string | null
  mana_cost: string | null
  cmc: number | null
  color_identity: string
  price: number | null
  source: string
  synced_at: number
}

export function getMtgCardInfo(keys: string[]): Map<string, MtgCardInfo> {
  const out = new Map<string, MtgCardInfo>()
  const stmt = db.prepare('SELECT * FROM mtg_card_info WHERE name_key = ?')
  for (const k of new Set(keys)) {
    const r = stmt.get(k) as MtgCardInfo | undefined
    if (r) out.set(k, r)
  }
  return out
}

export function upsertMtgCardInfo(rows: Array<Omit<MtgCardInfo, 'synced_at' | 'name_key'>>): void {
  if (!rows.length) return
  const at = now()
  const ins = db.prepare(`INSERT INTO mtg_card_info (name_key, name, ext_id, type_line, mana_cost, cmc, color_identity, price, source, synced_at)
    VALUES (@name_key, @name, @ext_id, @type_line, @mana_cost, @cmc, @color_identity, @price, @source, @synced_at)
    ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, ext_id = COALESCE(excluded.ext_id, mtg_card_info.ext_id),
      type_line = excluded.type_line, mana_cost = excluded.mana_cost, cmc = excluded.cmc,
      color_identity = excluded.color_identity, price = COALESCE(excluded.price, mtg_card_info.price),
      source = excluded.source, synced_at = excluded.synced_at`)
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      const key = cardNameKey(r.name)
      if (key) ins.run(params({ ...r, name_key: key, synced_at: at }))
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export interface MtgCedhListRow {
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
  /** JSON CedhCard[], commanders included. */
  cards: string
  synced_at: number
}

export function replaceMtgCedhLists(rows: Array<Omit<MtgCedhListRow, 'synced_at'>>): void {
  const at = now()
  const ins = db.prepare(`INSERT INTO mtg_cedh_lists (entry_id, commander, color_identity, standing, player, tournament,
      tournament_size, tournament_date, decklist_url, deck_price, cards, synced_at)
    VALUES (@entry_id, @commander, @color_identity, @standing, @player, @tournament, @tournament_size,
      @tournament_date, @decklist_url, @deck_price, @cards, @synced_at)`)
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM mtg_cedh_lists')
    for (const r of rows) ins.run(params({ ...r, synced_at: at }))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function listMtgCedhLists(): MtgCedhListRow[] {
  return db.prepare('SELECT * FROM mtg_cedh_lists').all() as unknown as MtgCedhListRow[]
}

export function getMtgEdhrecPage(slug: string): { data: string; fetched_at: number } | undefined {
  return db.prepare('SELECT data, fetched_at FROM mtg_edhrec_pages WHERE slug = ?').get(slug) as
    | { data: string; fetched_at: number }
    | undefined
}

export function putMtgEdhrecPage(slug: string, data: string): void {
  db.prepare(`INSERT INTO mtg_edhrec_pages (slug, data, fetched_at) VALUES (?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`).run(slug, data, now())
}

export function getMtgCedhList(entryId: string): MtgCedhListRow | undefined {
  return db.prepare('SELECT * FROM mtg_cedh_lists WHERE entry_id = ?').get(entryId) as MtgCedhListRow | undefined
}
