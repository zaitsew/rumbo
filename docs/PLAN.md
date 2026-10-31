# Plan — MVP (2026-10-23)

Goal: the owner opens rumbo.fabriquefutur.com, starts a trip from one sentence, and sees a feed that
scheduled agents and the server's own collectors fill every day.

## Wave 1 (parallel, no shared files)

| lane | branch | owns |
|---|---|---|
| A — app foundation | `foundation` | Next app shell, SQLite store, owner auth, `/api/v1` CRUD, profile and watches pages, deploy, check.sh |
| B — core ranking | `core-rank` | `src/core/{rank,destinations,links,loco}.ts`, `data/destinations/*.yaml`, tests |
| C — sources | `sources` | `src/server/sources/*`, recorded fixtures, tests |

## Wave 2 (after wave 1 merges)

| lane | branch | owns |
|---|---|---|
| D — agents | `agents` | `/mcp`, `src/server/ai.ts`, `routines/agents/*`, `/agents` page, openapi |
| E — plan and feed | `plan-feed` | `/plan`, `/plan/[id]`, feed page, `collect` scheduler, seed script |

## Done means

Deployed, `./check.sh` green, one plan made end to end, the feed showing items from at least one
server source and one agent run, and a Claude scheduled task posting observations daily.
