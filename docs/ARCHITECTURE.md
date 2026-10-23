# Architecture

Rumbo answers two questions: "where and how do I go?" (a plan from scratch) and "what is worth my
attention this week?" (a ranked feed). People use the site; agents use the same data over MCP and JSON.

## Shape

```
src/core/            pure TypeScript, no I/O: schema, ranking, destination scoring, deep links, Loco export
data/destinations/   one YAML per destination: airports, tags, best months, cost level (open data)
src/server/          I/O: SQLite store, owner auth, collectors, AI through the accounts hub, MCP
src/server/sources/  one adapter per licensed source; each says if it is enabled and how many calls it may make
app/                 Next.js App Router: feed, plan, watches, profile, agents, /api/v1, /mcp
routines/agents/     ready prompts for Claude, Codex, ChatGPT and Grok scheduled runs
tests/               vitest over src/core, the sources (recorded fixtures) and the API
```

## Data flow

```
 watches ──► collect (hourly, server) ──► sources/* ──┐
                                                      ├──► observations ──► rank(profile, history, feedback) ──► feed
 scheduled agents ──► rumbo_agent_brief ──► their own │
   (Claude, Codex,      connectors (Booking, Expedia, │
    ChatGPT, Grok)      Viator, Tripadvisor, Kiwi)  ──┘ rumbo_observe

 plan request ──► parse (rules, then Haiku) ──► destinations × profile ──► live fares for the top 5
             ──► chosen place ──► flights, stays, car, activities, events + deep links ──► Loco proposal
```

## Ranking (src/core/rank.ts)

`score = 0.35·deal + 0.25·fit + 0.20·taste + 0.10·urgency + 0.10·novelty`, each part 0..1, shown
on the card as reasons. A stale price scores `deal = 0`. A dismissed item's place and kind get a
penalty for 30 days; "more like this" boosts its tags. The weights live in one constant and the
tests pin them.

## Sources (src/server/sources)

Each adapter exports `{ name, kinds, enabled(env), dailyCap, run(watch, profile) → Observation[] }`.
A run records its calls in `runs`, so the cap holds across restarts. Free sources run on their own;
paid ones stay off until their env flag is set (D2).

## Agents

- MCP endpoint `/mcp` (Streamable HTTP, stateless). Tools: `rumbo_feed`, `rumbo_feedback`,
  `rumbo_profile_get`, `rumbo_profile_update`, `rumbo_plan_start`, `rumbo_plan_get`, `rumbo_plan_choose`, `rumbo_watch_list`,
  `rumbo_watch_add`, `rumbo_agent_brief`, `rumbo_observe`, `rumbo_import_history`, `rumbo_to_loco`.
- JSON API `/api/v1/*` mirrors the tools; `openapi.json` describes it for GPT actions and Grok.
- Loco: `rumbo_to_loco` returns the arguments for Loco's `loco_propose`; an agent holding both
  connectors makes the call. Loco's own server calls `/api/v1` the same way.
