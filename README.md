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

Alpha. Shell, store, owner key, JSON API, ranking core and source collectors are in. The MCP endpoint, the feed service and the agent setup for Claude, Codex, ChatGPT and Grok are in the `agents` lane. The planner pages and the feed UI come from the plan-feed lane (docs/PLAN.md).

## What is here

| path | what |
|---|---|
| `app/` | Next.js App Router: pages, `/api/v1`, `/signin` |
| `src/core/` | pure TypeScript: the shared schema and, later, ranking and deep links |
| `src/server/` | SQLite store (`node:sqlite`), owner auth, API helpers |
| `scripts/` | `seed-profile`, `usage`, `validate-data`, `deploy.sh`, `install-claude.sh`, `install-codex.sh`, `run-agent.sh` |
| `routines/agents/` | scheduled-run prompts and setup per harness (Claude, Codex, ChatGPT, Grok) |
| `skills/rumbo/` | the skill Claude Code and Codex load for "rumbo run" and trip questions |
| `deploy/droplet/` | Dockerfile, compose and Caddy fragments for the shared server |
| `docs/` | brief, architecture, decisions, plan |

Access: one key, `RUMBO_OWNER_KEY` (D5). The browser signs in at `/signin` and holds an httpOnly cookie with an HMAC of the key.
API clients send `Authorization: Bearer <key>`. Wrong keys are counted per client address: ten failures in ten minutes lock that address out (429 for every request, right key included); 300 failures from all addresses lock everyone out until the window rolls. Data lives in SQLite at `RUMBO_DB` (default `./data/rumbo.db`), every row with a `user_id`.

## JSON API

All routes under `/api/v1` need the owner key, except `GET /api/v1/health`. Errors are `{ "error": "code", "detail": ... }`.

```
GET|PUT|PATCH /api/v1/profile       PATCH merges { set, note, agent } and never deletes
GET      /api/v1/feed               ?limit &kinds &include_stale: ranked, best first
GET      /api/v1/brief              ?agent &connectors: what a scheduled run should do now
GET|POST /api/v1/watches            DELETE /api/v1/watches/:id
GET|POST /api/v1/observations       POST takes an array, at most 200 per call: { accepted, rejected: [{ index, error }] }
GET|POST /api/v1/feedback
GET|POST /api/v1/history
GET      /api/v1/plans              GET /api/v1/plans/:id    GET /api/v1/plans/:id/loco
```

The OpenAPI 3.1 document (for GPT actions and Grok) is public at `/openapi.json`; `/llms.txt` describes the site for agents. Neither holds a secret.

## Connect your AI agents

Rumbo speaks MCP (Streamable HTTP, stateless) at `/mcp` with `Authorization: Bearer <key>`, and at `/mcp/<key>` for connectors that cannot set a header.
Both go through the same lockout and rate limit. Tools: `rumbo_feed`, `rumbo_feedback`, `rumbo_profile_get`, `rumbo_profile_update`, `rumbo_watch_list`, `rumbo_watch_add`, `rumbo_observe`, `rumbo_import_history`, `rumbo_agent_brief`, `rumbo_to_loco`. None deletes, books or pays.

```
scripts/install-claude.sh --dry-run && scripts/install-claude.sh   # Claude Code: key in Keychain, MCP server, skill
scripts/install-codex.sh --dry-run && scripts/install-codex.sh     # Codex: same key, bearer_token_env_var
open http://localhost:3000/agents                                   # snippets for every harness, with your host
```

Set `RUMBO_PUBLIC_URL` when the site sits behind a proxy so the snippets show the right address.
Scheduled runs (Claude desktop task, `codex exec` via launchd, ChatGPT and Grok tasks) are in `routines/agents/README.md`.
The `/mcp/<key>` URL is a secret: Caddy must not log request paths for it (the shipped Caddy fragment has no `log` directive; keep it that way or filter `/mcp/*`).

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
