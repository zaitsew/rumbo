# rumbo — agent guide

One line: Rumbo plans trips from scratch (destination, flights, stays, car, activities, events) and
keeps a personal ranked travel feed, for a person on the web and for AI agents over MCP and JSON.

Read first: docs/BRIEF.md (the owner's words), docs/ARCHITECTURE.md, docs/DECISIONS.md, docs/PLAN.md.
The shared contract is `src/core/schema.ts`; change it only in its own PR.

Hard rules:
- No scraping. Data comes from the licensed sources in D2, the agents' own connectors, or a deep link.
- The AI never writes a number. Prices, durations and scores come from observations and `src/core`.
- The repo is public: no personal data, no keys, no profile. Those live in `.env` and the database.
- Agents propose, the owner decides: no tool deletes, books or pays.

## How to run / check it

```
./check.sh
```

The one command that says what is missing (env vars, toolchain, tests) and exits
non-zero with a list. Run it before you start, and again before you push.

## Conventions

- **Skills** are procedures: `.claude/skills/<name>/SKILL.md`, loaded on demand.
  **Rules** are constraints from real corrections: `.claude/rules/`, path-globbed.
  **Facts** are state: a `NOTES.md` or `docs/DECISIONS.md` beside the work,
  rewritten in place. Keep the three apart.
- Routine output goes in `runs/` (gitignored, see `routines/README.md`); a
  decision the next run must respect goes in a committed doc.
- Shipping: open the PR and stop unless this repo is named on the merge-approved
  list in `~/.claude/CLAUDE.md`. One PR per logical unit, `gh pr merge --merge`,
  never squash, never force-push.

Shared session policy for every harness: `~/.agents/POLICY.md`.
