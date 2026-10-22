# Sources

Rumbo reads only the sources below (decision D2): documented APIs with a key or a public MCP. It never
scrapes a website and never drives a browser against an aggregator. Code: `src/server/sources/`.
Last checked against the providers' own docs on 2026-10-23.

## The table

| Source | Kinds | Cost | Env vars | Daily cap | Terms and what they say about programmatic use | Get a key |
|---|---|---|---|---|---|---|
| `kiwi-mcp` (Kiwi.com public MCP, tool `search-flight`) | flight | Free, no key | `RUMBO_KIWI_MCP=0` switches it off | 60 | [Website terms](https://www.kiwi.com/ag/pages/content/terms/), [MCP page](https://www.kiwi.com/ag/pages/mcp/). Neither mentions scheduled or programmatic use, an API, an AI agent or a rate limit. The terms forbid "commercial use" of the site and software that "interferes" with it (2.6.4, 2.6.7). **Unclear, not forbidden.** On by default for a personal, non-commercial tool under 60 calls a day. | None |
| `travelpayouts` (Aviasales Data API) | flight (cached fares) | Free | `TRAVELPAYOUTS_TOKEN`, optional `TRAVELPAYOUTS_MARKER` (affiliate links) | 500 (ours) | Data API is meant for programmatic use; the docs say the data is cached and suit static pages, and ask for GZIP. No rate limit stated for the data endpoints. Terms page not read (support site answers 403 to bots): **unverified**. | [travelpayouts.com](https://www.travelpayouts.com/) > Tools > API |
| `ticketmaster` (Discovery API v2) | event | Free | `TICKETMASTER_API_KEY` | 1000 (key allows 5,000 and 5 a second) | [Terms of use](https://developer.ticketmaster.com/support/terms-of-use/): the API is for programmatic use; no caching of Event Content "other than for reasonable periods"; no reselling or sublicensing. Rumbo keeps a row until the event has happened and re-reads it on each run. | [developer.ticketmaster.com](https://developer.ticketmaster.com/) > Get Your API Key |
| `viator` (Partner API v2, Basic access) | activity | Free (commission on bookings) | `VIATOR_API_KEY` | 500 (ours; Viator limits per endpoint in a 10-second window) | [Technical docs](https://docs.viator.com/partner-api/technical/). The affiliate API is built for programmatic use; limits are per partner account. The affiliate agreement text was not read: **unverified**. | [partnerresources.viator.com](https://partnerresources.viator.com/) > Affiliate > Basic access |
| `tiqets` (Distributor API v2, Content) | activity | Free (commission on bookings) | `TIQETS_API_KEY` | 500 (ours; Tiqets allows 15 requests a second) | [API terms](https://developers.tiqets.dev/basics/terms-of-service.md): licence "only as necessary to develop, test and support an integration" under the partner agreement; no excessive use; stay inside the rate limits. | [tiqets.com/affiliate](https://www.tiqets.com/affiliate/) > Tools > API tokens |
| `liteapi` (Nuitee Connect hotel rates) | stay | **Paid, off** (see below) | `LITEAPI_KEY` and `RUMBO_ALLOW_PAID_LITEAPI=1` | 100 | [Pricing](https://docs.liteapi.travel/reference/api-pricing-usage-costs). Rates, prebook and book are free "within ToS usage, assuming a reasonable look-to-book ratio". | [dashboard.liteapi.travel](https://dashboard.liteapi.travel/) |
| `duffel` (flight offer requests) | flight | **Paid, off** (see below) | `DUFFEL_TOKEN` and `RUMBO_ALLOW_PAID_DUFFEL=1` | 40 | [Pricing](https://duffel.com/pricing). Programmatic by design. Never creates an order. | [app.duffel.com](https://app.duffel.com/) > Developers > Access tokens |

`./check.sh` and the agents page print each source's state with `describeSources(env)`: on or off, and the
exact variable to set when it is off.

## Kiwi MCP

- Server: `https://mcp.kiwi.com` (Streamable HTTP). One search tool, **`search-flight`**; a second,
  `feedback-to-devs`, is not used. The full listing is `tests/fixtures/sources/kiwi-tools.json`.
- Required inputs: `flyFrom`, `flyTo`, `departureDate` (dd/mm/yyyy). Rumbo also uses `departureDateTo`,
  `nights_in_dst_from/to` (turns it into a return search), `adults`, `currency`, `max_sector_stopovers`,
  `one_for_city` and `sort`. `flyFrom` and `flyTo` take comma-separated IATA lists and `flyTo` takes
  `"anywhere"`; both were tried live on 2026-10-23.
- Returns `itineraries[]` with `price` (all passengers), `bookingUrl`, `outbound`/`inbound` legs with
  local-time segments (no offset; Rumbo adds one from the airport's country, see `time.ts`).
- The tool states no price expiry. Rumbo treats a Kiwi price as good for six hours (unverified).
- Terms: see the table. If Kiwi says scheduled use is not allowed, set `RUMBO_KIWI_MCP=0`; the planner
  then falls back to Travelpayouts and deep links.

## Paid sources

Both stay off until the owner approves the price (POLICY section 11: state the price, ask twice).

- **Duffel.** Searches are free up to 1,500 searches per order a month; above that each costs $0.005. Rumbo
  never orders, so every search is above the ratio: at the 40-call cap that is at most $0.20 a day. Orders
  (not made by Rumbo) cost a fee plus 1% of the order value.
- **LiteAPI.** D2 says "$0.01 a search". LiteAPI's pricing page says otherwise for this path: the rates
  endpoints are free within the terms at a reasonable look-to-book ratio, and the $0.01 applies to Places
  endpoints and $0.05 to price-index endpoints. Rumbo's adapter calls `GET /data/hotels` and
  `POST /hotels/min-rates` only. With zero bookings the "reasonable ratio" may still bite, so the gate stays
  and the cap is 100 calls a day (at most $1 if the $0.01 reading is right). The owner decides.

## Behaviour all sources share

- **Provenance.** Every observation carries `source`, `url` when the provider gives one, `seen_at`, and
  `expires_at`. Kiwi: 6 hours. Travelpayouts: the API's `expires_at` when present, else 24 hours. Viator and
  Tiqets: 24 hours. LiteAPI: 6 hours. Duffel: the offer's `expires_at`. Ticketmaster: the event's start. A
  past `expires_at` is passed through; the ranker marks it stale.
- **Money** is integer minor units. Flight prices are per person: Kiwi and Duffel quote the whole party and
  Rumbo divides by the passenger count.
- **Ids** are `sha256(kind + key fields)`, never the price or the source. Flights: origin, destination,
  depart and return dates, first outbound flight number. Stays: name, place, dates. Activities and events:
  title, place, date (and venue). The same offer seen twice, by one source or two, is one row; `runSources`
  keeps the cheaper copy.
- **Caps** are counted before the call, per source and UTC day, in a `CallLedger` (SQLite in the app, memory
  in tests). A query that would cross the cap is skipped and reported as `skipped: "cap"`. A source answering
  401, 403 or 429 gets no more queries that run.
- **Errors** name the host and path, never the query string, so Ticketmaster's key stays out of logs.

## What is unverified

- Kiwi: whether scheduled use is allowed (terms are silent); the price lifetime.
- Travelpayouts: the v3 `prices_for_dates` request and response fields (the official page returned 403).
  The adapter uses `departure_at=YYYY-MM`, `one_way`, `unique` (one fare per destination when going
  "anywhere"), `sorting`, `currency`, and reads `origin_airport`, `destination_airport`, `transfers`,
  `return_transfers`, `duration_to`, `link`. The `x-access-token` header is documented. The deprecated v1
  `cheap` endpoint (documented, has `expires_at`) is not used. The month-matrix endpoint is not used; a
  window wider than a month becomes one call per month, up to three.
- Viator: the affiliate agreement; that `productUrl` carries the partner's tracking.
- Tiqets: `city_name` is documented but not the recommended filter; `product_url` tracking depends on the
  token's sitebrand.
- LiteAPI: whether `min-rates` `price` is the whole stay; the real cost of the rates path (above).
- Duffel: `time_zone` and `city_name` on place objects.
- The keyed adapters are tested on synthetic fixtures built from the documented shapes (`"_synthetic": true`).
  Only Kiwi has a recorded real response. Run `npx tsx scripts/source-smoke.ts` after setting a key.
- Country is given as the source gives it: Kiwi uses a name ("Portugal"), others an ISO code ("PT").

## Agent connectors (not called by Rumbo)

Scheduled agents use these under the owner's own account, per D2, and post what they saw with
`rumbo_observe`. Rumbo never calls them and never holds their credentials.

- **Booking.com**, **Expedia**, **Viator** and **Tripadvisor**: the official connectors in Claude and ChatGPT.
- **Kiwi MCP**: the same server the Kiwi adapter uses, as a connector. An agent may search there directly.
- Grok and Codex tasks use whatever search they have and post the same way.

Everything else is a deep link built in `src/core/links.ts`: Google Flights, Google Hotels, Booking.com,
Airbnb, Skyscanner, Kayak, Discover Cars and the airlines' own pages.
