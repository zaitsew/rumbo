# Decisions

Current decisions only. Each names its date and the reason. History lives in the PRs.

## D1 — Stack: Next.js on the shared droplet, SQLite, one owner (2026-10-23)

Next.js (App Router, standalone build) behind the shared Caddy on `fabrique-apps-1`, like BankJar.
Storage is SQLite through Node's built-in `node:sqlite` (no native module to build on a 1 GB box),
in a volume at `/srv/rumbo/data/rumbo.db`. Every row carries `user_id` from the first table, so a
second person later is a sign-in change, not a migration. Tier today: `owner`.

## D2 — Data: licensed sources and deep links, never scraping (2026-10-23)

Google's terms (30 Jul 2026) forbid "automated means to access content"; Airbnb and Booking.com forbid
scraping too. Rumbo therefore reads only:

- **Kiwi.com public MCP** (`mcp.kiwi.com`, no key): live flight search. Capped at 60 calls a day.
- **Travelpayouts / Aviasales Data API** (free token): cached fares for cheap-month and anywhere scans.
- **Viator Basic** and **Tiqets Partner API** (free affiliate tokens): activities.
- **LiteAPI** (hotel rates, $0.01 a search) and **Duffel** (flight offers, fees per order and excess
  searches) are paid. Their adapters exist but stay off until Ivan approves the price (POLICY §11).
- **Agents' own connectors.** Booking.com, Expedia, Viator and Tripadvisor ship official connectors in
  Claude and ChatGPT. A scheduled agent uses them under Ivan's own account and posts what it saw with
  `rumbo_observe`. Rumbo never drives a browser against an aggregator.
- **Deep links** for everything else: Google Flights, Google Hotels, Booking.com, Airbnb, Skyscanner,
  Kayak, Discover Cars and the airlines' own booking pages, pre-filled with dates and travellers.

Every observation stores `source`, `url`, `seen_at` and `expires_at`. A price older than its
`expires_at` is shown as stale and never ranks as a deal.

## D3 — The AI never writes a number (2026-10-23)

Prices, durations and scores come from observations and `src/core`. The AI (Anthropic through the
accounts hub, product `rumbo`) does three things only: turns a free-text wish into a `PlanRequest`
(Haiku 5.5), writes the one-line "why" on a feed card from the score's parts (Haiku 5.5), and
suggests destinations outside the curated pool as names to check, never with prices (Sonnet 5.5).
Without a hub token the site works; the rule parser and the template "why" answer.

## D4 — Agents propose, the owner decides (2026-10-23)

An agent may add observations, watches and profile facts (each with `source`). It may not delete,
book or pay. Rumbo hands Loco a proposal (`loco_propose` shape), never a booked item, so Loco's
"people decide" rule holds.

## D5 — Access: one owner key (2026-10-23)

`RUMBO_OWNER_KEY` gates the site, the API and MCP. The web sign-in sets an httpOnly cookie.
API and MCP accept `Authorization: Bearer <key>`. Claude and ChatGPT custom connectors cannot send a
header, so `/mcp/<key>` is accepted too; that URL is a secret, and the key rotates by changing one
env var. Replace with the accounts hub's sign-in when a second person joins.

## D6 — The personal profile never enters the repo (2026-10-23)

The repo is public. `profile.example.yaml` is generic. Ivan's profile lives in the database, seeded
once from a gitignored `profile.local.yaml`, and agents update it through `rumbo_profile_update`.

## D7 — Events belong to SAWk (2026-10-23)

[SAWk](https://github.com/zaitsew/sawk) already keeps an agent-filled feed of offline events where the
owner lives and travels. Ivan chose the split on 2026-10-23: "Split: Rumbo trips, SAWk events". Rumbo
owns plans and travel offers (flights, stays, car, activities). For a trip's city and dates it reads
events from SAWk's API and shows them in the plan; it runs no events collector of its own. The
`event` observation kind stays, for what SAWk returns.
