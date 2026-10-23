# Rumbo

Rumbo plans trips from scratch (destination, flights, stays, car, activities, events) and keeps one ranked travel feed.
It is a personal tool for one owner, used on the web and by AI agents over MCP and JSON.
Prices come from licensed sources and deep links, never scraping; the AI never writes a number.

## Quick start

```
cp .env.example .env     # then set RUMBO_OWNER_KEY (openssl rand -hex 24)
./check.sh               # says what is missing; runs types, tests, data checks
npm run dev              # starts Next on port 3000
open http://localhost:3000
# sign in with your RUMBO_OWNER_KEY, then add a watch or fill in /profile
```

Without `RUMBO_OWNER_KEY` the server refuses everything, even on localhost: pages show "Set RUMBO_OWNER_KEY in .env", `/api` answers 503 `not_configured`, and a loud warning prints. Only `GET /api/v1/health` stays open.
`npm run seed-profile` loads a profile from the gitignored `profile.local.yaml` (copy `profile.example.yaml`).
`./check.sh usage` prints counters from the database: observations, watches, plans, feedback, last collect.

## Status

Alpha. Foundation only: app shell, SQLite store, owner key, JSON API, profile and watches pages. The ranked feed, the planner, the collectors and the MCP endpoint land in later lanes (docs/PLAN.md).

## What is here

| path | what |
|---|---|
| `app/` | Next.js App Router: pages, `/api/v1`, `/signin` |
| `src/core/` | pure TypeScript: the shared schema and, later, ranking and deep links |
| `src/server/` | SQLite store (`node:sqlite`), owner auth, API helpers |
| `scripts/` | `seed-profile`, `usage`, `validate-data`, `deploy.sh` |
| `deploy/droplet/` | Dockerfile, compose and Caddy fragments for the shared server |
| `docs/` | brief, architecture, decisions, plan |

Access: one key, `RUMBO_OWNER_KEY` (D5). The browser signs in at `/signin` and holds an httpOnly cookie with an HMAC of the key.
API clients send `Authorization: Bearer <key>`. Wrong keys are counted per client address: ten failures in ten minutes lock that address out (429 for every request, right key included); 300 failures from all addresses lock everyone out until the window rolls. Data lives in SQLite at `RUMBO_DB` (default `./data/rumbo.db`), every row with a `user_id`.

## JSON API

All routes under `/api/v1` need the owner key, except `GET /api/v1/health`. Errors are `{ "error": "code", "detail": ... }`.

```
GET|PUT  /api/v1/profile
GET|POST /api/v1/watches            DELETE /api/v1/watches/:id
GET|POST /api/v1/observations       POST takes an array, at most 200 per call: { accepted, rejected: [{ index, error }] }
GET|POST /api/v1/feedback
GET|POST /api/v1/history
GET      /api/v1/plans              GET /api/v1/plans/:id
```

## Which header is trusted

Failures are counted per client address. Production runs behind Caddy on a private Docker network, so the compose file sets `RUMBO_TRUST_PROXY=1`:
Rumbo then reads the **last** entry of `X-Forwarded-For` (the hop Caddy added, which a client cannot choose).
Without that variable no forwarded header is believed and all clients share one bucket, which is the safe setting for a local `next dev`.
`Host` is never used for access decisions.

## Deploy

Target: `rumbo.fabriquefutur.com` on the shared droplet (`fabrique-apps-1`), container port **3110** on the internal `apps` network (nothing is published on the host).
The box cannot compile Next, so `scripts/deploy.sh` builds on this machine, ships the standalone output, and builds the image there.
The database sits in a volume at `/srv/rumbo/data`, mounted as `/data` (`RUMBO_DB=/data/rumbo.db`); a deploy never touches it.

```
./scripts/deploy.sh --dry     # print every step, run nothing
./scripts/deploy.sh           # build, ship, first run creates the product with add-product.sh
```

On the first run, put `RUMBO_OWNER_KEY` in `/srv/rumbo/.env` on the server and start the container (the script prints the command).
The image needs Node 24 or newer for `node:sqlite`.

## Docs

[Brief](docs/BRIEF.md) · [Architecture](docs/ARCHITECTURE.md) · [Decisions](docs/DECISIONS.md) · [Plan](docs/PLAN.md) · [Getting started](docs/GETTING-STARTED.md)

## Licence

Apache-2.0, see `LICENSE`.
