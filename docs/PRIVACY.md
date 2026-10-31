# Privacy: every call that leaves the server

Rumbo makes the calls in the tables below and no others. Each row names the trigger, the host, what is
sent, whether it runs without the owner asking, and how to turn it off. "Default on" means it runs with a
stock install and no flag. `teyla hosts .` compares this file with the code on every `./check.sh`.

Rumbo has one user, the owner, and no analytics, ad SDK or error-reporting service. The server stores the
owner's profile, past trips, watches, observations, feedback and plans in a local SQLite file
(`RUMBO_DB`) and sends none of it anywhere except as the rows below describe.

## Calls this product makes

Rows 1 to 6 are server calls. Rows 7 and later are links the owner opens with a click: the server never
requests those hosts, and the search text in them is the route, place and dates of the trip being planned.

| # | Trigger | Host | What is sent | Default on | Turn it off |
|---|---|---|---|---|---|
| 1 | Flight search for a watch or a plan. A due watch (hourly collect), `rumbo_plan_start` / `rumbo_plan_choose` or the plan form | `mcp.kiwi.com` | Origin and destination airport codes, depart and return dates, nights, adults, currency, stop limit. No name, e-mail, key or profile text. | Yes (free, no key, 60 calls a day) | `RUMBO_KIWI_MCP=0` |
| 2 | Cached fares for a watch or a plan. A due watch (hourly collect), `rumbo_plan_start` / `rumbo_plan_choose` or the plan form | `api.travelpayouts.com` | Origin and destination codes, month or dates, currency. The `TRAVELPAYOUTS_TOKEN` goes in a header. No profile text. | Only when `TRAVELPAYOUTS_TOKEN` is set | Unset `TRAVELPAYOUTS_TOKEN` |
| 3 | Activities for a watch or a plan. A due watch (hourly collect), `rumbo_plan_start` / `rumbo_plan_choose` or the plan form | `api.viator.com` | A city name (destination lookup), the date, the currency. `VIATOR_API_KEY` goes in a header. | Only when `VIATOR_API_KEY` is set | Unset `VIATOR_API_KEY` |
| 4 | Activities for a watch or a plan. A due watch (hourly collect), `rumbo_plan_start` / `rumbo_plan_choose` or the plan form | `api.tiqets.com` | A city name, language `en`, currency. `TIQETS_API_KEY` goes in a header. | Only when `TIQETS_API_KEY` is set | Unset `TIQETS_API_KEY` |
| 5 | Hotel rates for a watch or a plan (paid source, off until the owner approves the price). A due watch (hourly collect), `rumbo_plan_start` / `rumbo_plan_choose` or the plan form | `api.liteapi.travel` | A city name and country code, check-in and check-out dates, adults and child ages, currency, guest nationality (default `ES`). `LITEAPI_KEY` in a header. | No (needs `LITEAPI_KEY` and `RUMBO_ALLOW_PAID_LITEAPI=1`) | Unset either variable |
| 6 | Flight offers for a watch or a plan (paid source, off until the owner approves the price). A due watch (hourly collect), `rumbo_plan_start` / `rumbo_plan_choose` or the plan form | `api.duffel.com` | Origin and destination codes, dates, passenger types and child ages. `DUFFEL_TOKEN` in a header. Rumbo never creates an order. | No (needs `DUFFEL_TOKEN` and `RUMBO_ALLOW_PAID_DUFFEL=1`) | Unset either variable |
| 7 | The owner clicks Google Flights, Google Hotels and Google Maps links in the feed or a plan | `www.google.com` | Nothing from the server: the page prints a URL (`src/core/links.ts`) and the owner's browser opens it. The URL carries route or place, dates and party size, never a name or a key. | No (needs a click) | Do not click the link |
| 8 | The owner clicks a Skyscanner flight link in the feed or a plan | `www.skyscanner.net` | Nothing from the server: the page prints a URL (`src/core/links.ts`) and the owner's browser opens it. The URL carries route or place, dates and party size, never a name or a key. | No (needs a click) | Do not click the link |
| 9 | The owner clicks a Kayak flight link in the feed or a plan | `www.kayak.com` | Nothing from the server: the page prints a URL (`src/core/links.ts`) and the owner's browser opens it. The URL carries route or place, dates and party size, never a name or a key. | No (needs a click) | Do not click the link |
| 10 | The owner clicks a Kiwi.com flight link in the feed or a plan | `www.kiwi.com` | Nothing from the server: the page prints a URL (`src/core/links.ts`) and the owner's browser opens it. The URL carries route or place, dates and party size, never a name or a key. | No (needs a click) | Do not click the link |
| 11 | The owner clicks a deep link returned by the Travelpayouts API, resolved against this host in the feed or a plan | `www.aviasales.com` | Nothing from the server: the page prints a URL (`src/core/links.ts`) and the owner's browser opens it. The URL carries route or place, dates and party size, never a name or a key. | No (needs a click) | Do not click the link |
| 12 | The owner clicks a Booking.com stay link in the feed or a plan | `www.booking.com` | Nothing from the server: the page prints a URL (`src/core/links.ts`) and the owner's browser opens it. The URL carries route or place, dates and party size, never a name or a key. | No (needs a click) | Do not click the link |
| 13 | The owner clicks an Airbnb stay link in the feed or a plan | `www.airbnb.com` | Nothing from the server: the page prints a URL (`src/core/links.ts`) and the owner's browser opens it. The URL carries route or place, dates and party size, never a name or a key. | No (needs a click) | Do not click the link |
| 14 | The owner clicks a DiscoverCars link in the feed or a plan | `www.discovercars.com` | Nothing from the server: the page prints a URL (`src/core/links.ts`) and the owner's browser opens it. The URL carries route or place, dates and party size, never a name or a key. | No (needs a click) | Do not click the link |
| 15 | The owner clicks a Rentalcars link in the feed or a plan | `www.rentalcars.com` | Nothing from the server: the page prints a URL (`src/core/links.ts`) and the owner's browser opens it. The URL carries route or place, dates and party size, never a name or a key. | No (needs a click) | Do not click the link |
| 16 | The owner clicks a GetYourGuide activity link in the feed or a plan | `www.getyourguide.com` | Nothing from the server: the page prints a URL (`src/core/links.ts`) and the owner's browser opens it. The URL carries route or place, dates and party size, never a name or a key. | No (needs a click) | Do not click the link |
| 17 | The owner clicks a Viator activity link in the feed or a plan | `www.viator.com` | Nothing from the server: the page prints a URL (`src/core/links.ts`) and the owner's browser opens it. The URL carries route or place, dates and party size, never a name or a key. | No (needs a click) | Do not click the link |
| 18 | The owner clicks an airline link in a plan | `wizzair.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 19 | The owner clicks an airline link in a plan | `www.aireuropa.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 20 | The owner clicks an airline link in a plan | `www.airfrance.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 21 | The owner clicks an airline link in a plan | `www.bintercanarias.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 22 | The owner clicks an airline link in a plan | `www.easyjet.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 23 | The owner clicks an airline link in a plan | `www.emirates.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 24 | The owner clicks an airline link in a plan | `www.flytap.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 25 | The owner clicks an airline link in a plan | `www.iberia.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 26 | The owner clicks an airline link in a plan | `www.iberiaexpress.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 27 | The owner clicks an airline link in a plan | `www.ita-airways.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 28 | The owner clicks an airline link in a plan | `www.klm.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 29 | The owner clicks an airline link in a plan | `www.lufthansa.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 30 | The owner clicks an airline link in a plan | `www.qatarairways.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 31 | The owner clicks an airline link in a plan | `www.ryanair.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 32 | The owner clicks an airline link in a plan | `www.transavia.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 33 | The owner clicks an airline link in a plan | `www.turkishairlines.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 34 | The owner clicks an airline link in a plan | `www.volotea.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |
| 35 | The owner clicks an airline link in a plan | `www.vueling.com` | Nothing from the server: a URL (`src/core/links.ts`) with route, dates and party size is printed and the owner's browser opens it. | No (needs a click) | Do not click the link |

## Calls that carry user content to a model provider

| # | Trigger | Host | What is sent | Default on | Consent | Turn it off |
|---|---|---|---|---|---|---|
| 1 | `rumbo_plan_start`, the plan form or `POST /api/v1/plans` with free text (`aiParsePlan`), and the "why" line under the top feed items (`aiWhy`) | `*.supabase.co` | The accounts hub (a Supabase project; its host is the `ACCOUNTS_URL` env var, which has no default in the code), path `/functions/v1/ai`. For a plan: the owner's trip sentence (first 600 characters), today's date and the owner's home city, to Claude Haiku 5.5. For the feed: an item title and up to 7 ranker reasons. A hub service token goes in a header, with the product name `rumbo` and the fixed user label `owner`. Never the profile, history, e-mail or any key. | Only when `ACCOUNTS_SERVICE_RUMBO` and `ACCOUNTS_URL` are set on the server | The owner sets the token on purpose in the server's env file (`.env.example`, `deploy/droplet/.env.example`); there is no other user. | Unset `ACCOUNTS_SERVICE_RUMBO` or set `RUMBO_AI=off` |

The hub forwards the request to Anthropic. The model only returns a forced tool call; its answer is
checked against a schema, and a sentence with a number not found in the reasons is dropped. Rumbo works
without it.

## Hosts the owner configures

The static scan cannot see these because the host comes from an environment variable. They are off until
the variable is set.

- `SAWK_URL`: Rumbo reads the owner's SAWk events feed (`GET /api/feed?city=&from=&to=&limit=`) with
  `SAWK_TOKEN` as a bearer. It sends a city name and a date range. The owner's own server.
- `RUMBO_OAUTH_ISSUER` and `RUMBO_OAUTH_JWKS_URL`: only when OAuth for `/mcp` is on (`docs/MCP-OAUTH.md`).
  Rumbo fetches the issuer's discovery document and signing keys (public data, no user content), at most
  a few times an hour.
- `ACCOUNTS_URL`: the hub host in model-provider row 1. Required for the AI features; no default.

## Where data lives

- The SQLite file at `RUMBO_DB` on the droplet's data volume. It holds trips, preferences, watches,
  sightings with the provider URLs, feedback and plans. It is not copied to any third party.
- Server logs hold request lines and errors. The MCP path key (`/mcp/<key>`) is redacted from MCP errors
  (`src/server/mcp/http.ts`, `redact`) and the app prints no request line itself.

## Accepted risk: the key in the MCP URL

`/mcp/<RUMBO_OWNER_KEY>` exists because the Claude.ai and ChatGPT custom connectors cannot send an
`Authorization` header. The URL is therefore a secret: it lands in the reverse proxy's access log and in the
connector's own configuration. Why it is accepted: the only user is the owner, the key is one value that
`/mcp` also accepts as a bearer, wrong keys in the path are counted and locked out per client address exactly like
wrong bearers (10 failures in 10 minutes), and rotating `RUMBO_OWNER_KEY` revokes the URL. Mitigations:
the SDK request carries a clean URL, the key is redacted from anything Rumbo prints, and the Caddy fragment
(`deploy/droplet/Caddyfile.fragment`) must not log the `/mcp/*` path. OAuth (`docs/MCP-OAUTH.md`) is the
way out of this risk; turning it on lets the owner drop the URL form.

## How to keep this true

Run `teyla hosts .` in this repo. It lists every host the code can reach, by file and line, and compares
the list with this file:

- A host that no row covers is a FIX. Add a row: what is sent, when, and how to turn it off.
- A row that no code reaches is a WARN (a stale row). Delete it.
- A host built at run time (a URL assembled from variables) is not found. Document it by hand, as above.
