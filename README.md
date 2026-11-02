# ATLIS — Agentic Task & LLM Interaction Studio

Standalone agentic harness for personal work. Electron + TypeScript + React 19 + Tailwind v4, with the built-in `node:sqlite` (zero native dependencies).

## Apps

ATLIS is one window with a nav rail of apps. Anything that isn't core can be hidden from Settings.

- **Sessions** — multi-provider chat and agentic runs (Anthropic, OpenAI, GitHub Copilot, LM Studio). Every session is independent; several can stream and use tools at once.
- **Browser** — a real Chromium `WebContentsView` with tabs and bookmarks (importable from Firefox-family browsers). You drive it from the address bar; the agent drives the same page through its `browser_*` tools. A floating chat dock talks to a session without leaving the page.
- **Arena** — blind head-to-head model battles: one prompt, two models side by side under anonymous labels; vote, reveal, and keep a leaderboard with win rates and cost per battle.
- **Torrents** — a minimal torrent client whose whole point is that sharing ends at 100%: a finished download stops immediately and never seeds.
- **Planner** — local calendar, reminders and to-dos, which the agent can read and schedule into.
- **Feed** — one reader for YouTube channels, subreddits and RSS/Atom feeds.
- **Finance** — market pulse, watchlist, deep dives and a position-size calculator.
- **Vault** — a catalogue of collectibles (cards, sealed product, coins, bullion, knives) with valuations over time and live spot prices.
- **Land** — scores rural parcels for buildability and drive time to the places that matter, from county GIS and public data.
- **Magic** — release calendar, card and sealed prices, a watchlist with MSRP bands and retailer stock checks, deck building and recommendations, pack EV, and Commander games against the Forge rules engine.
- **Drops** — watches limited-run stores (Shopify, Wix) for restocks and preorders, with alerts to the desktop and Discord.
- **Agent Zoo** — browse and edit the agents, skills and tools defined in your workspace.
- **Documents** — research and reference material, stored as HTML with Markdown on demand.

## Under the hood

- **Roundtable** — give a session 2+ participant seats (any provider/model mix, optional personas) and the models hold a real peer discussion: one message buys a configurable turn budget, each turn ends with a hidden `NEXT:` handoff, and the group ends early with an explicit **Resolution** when it reaches consensus.
- **Agentic tool loop** — embedded-browser navigation/read/click/type, raw `fetch_url`, `save_document`, a persistent PowerShell (`shell_exec`, plus background processes with `shell_bg_wait` watch patterns), cross-session memory (`memory_*`, SQLite FTS5 search), a learned-skills library (`skill_read`/`skill_save`, SKILL.md format under `<workspace>/skills/`), and tools for every app above.
- **MCP client** — connect any Model Context Protocol server (stdio or HTTP) from Settings; its tools join the agent loop as `mcp__<server>__<tool>` with live per-server status.
- **App Host** — launch your own software under test in a managed sandbox; if it exposes an MCP endpoint, its tools appear to the agent automatically.
- **Desktop control** — let the agent drive an installed desktop app by screenshot, click and keystroke.
- **Discord** — alerts out to a channel, and an optional bot that brings a channel's messages in to an agent session.
- **Rich text composer** — TipTap editor; HTML is the native format and Markdown is computed from it for the model.
- **Usage metering** — every model call records tokens, list-price cost and modeled energy, attributed to its session and project; the title bar shows the running total.
- **SQLite persistence** — everything lives in `%APPDATA%/ATLIS/atlis.db` (WAL mode). If the WAL journal ever corrupts, boot self-heals by quarantining it (`atlis.db-wal.corrupt-<timestamp>`) and continuing from the last checkpoint.
- **History cost control** — image attachments are only inlined for the most recent turns and older tool results are truncated in replayed history, so long agentic sessions don't burn tokens quadratically.

## Running

```powershell
npm install
npm run dev      # development with HMR
npm run dist     # build a Windows installer into release/
```

Then open **Settings** and add keys:

| Provider | Credential |
|---|---|
| Anthropic | API key from console.anthropic.com |
| OpenAI | API key from platform.openai.com |
| Copilot | GitHub token (`gh auth token`); ATLIS exchanges it for a short-lived Copilot bearer |
| LM Studio | Base URL of a local LM Studio server |

Keys are stored in the local database, never in the repository. Set `ATLIS_USER_DATA` to run against a throwaway profile.

Commander games need an installed copy of [Forge](https://github.com/Card-Forge/forge), a Temurin JDK 17+, and the bridge built once with `forge-bridge\build.ps1`.

## Architecture

```
src/main          Electron main process
  db/             node:sqlite schema + queries
  providers/      anthropic | openai | copilot | lmstudio behind one streaming interface
  agent/          tool specs + per-session agentic loop (usage metering per call)
                  + shell (persistent PowerShell), memory, skills
  mcp.ts          MCP client manager (@modelcontextprotocol/sdk, stdio + http)
  browser/        WebContentsView manager (user + agent shared browser)
  ...             one module per app (mtg, drops, vault, land/, feed, finance, torrents, …)
src/preload       contextBridge API (window.atlis)
src/renderer      React 19 + Tailwind v4 + Zustand + TipTap + Recharts
forge-bridge/     Java bridge to the Forge rules engine (separately licensed, see below)
tools/            dev harnesses (table-preview: the game table without Electron)
```

### Usage metering methodology

Cost uses published list prices per MTok (longest-prefix model matching; Copilot is subscription-billed → $0 marginal). Energy is modeled — providers publish no per-token figures — at ≈5 J/output token (frontier), 2 J (mid), 0.5 J (small), input at 10%, PUE ≈ 1.2. Order-of-magnitude gauge, not a meter.

## License

ATLIS is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You are free to use, modify and share it for any noncommercial purpose (personal use, hobby projects, study, research). Commercial use needs a separate license from the author.

The exception is [`forge-bridge/`](forge-bridge/), which is built against Forge (GPL-3.0) and is therefore licensed under the [GNU General Public License v3.0 or later](forge-bridge/LICENSE). ATLIS talks to it only as a separate process over a JSON-lines protocol; see [forge-bridge/README.md](forge-bridge/README.md).

Magic: The Gathering is a trademark of Wizards of the Coast. ATLIS is not affiliated with or endorsed by Wizards of the Coast, Scryfall, TCGplayer, or any retailer it reads.
