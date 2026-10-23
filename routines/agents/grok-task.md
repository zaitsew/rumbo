# Grok task

Agent name: `grok-task`. Schedule: daily, around 07:30 Europe/Madrid.

Status: unverified. Confirmed from documentation (2026-10): the xAI Responses API accepts a remote MCP tool (`server_url`, `server_label`, `authorization`, `allowed_tools`). Not confirmed: whether grok.com Tasks can attach a custom MCP connector. Until you see it in the app, use the JSON API (Option A) or the xAI API (Option B).

Note: the Grok subscription may be cancelled or downgraded; this routine is optional.

## Option A: Grok Tasks with the JSON API (no connector needed)

Grok can browse and call public URLs, but a task cannot hold a secret safely. Use this only if you accept the key in the task text, or skip it. Prompt:

```
Daily Rumbo run. Agent name: grok-task.
1. GET <your site>/api/v1/brief?agent=grok-task with header Authorization: Bearer <KEY>. Follow its due_watches.
2. Search the web for each; open result pages. Never scrape or log in. Never estimate a price.
3. POST <your site>/api/v1/observations with header Authorization: Bearer <KEY> and a JSON body
   {"agent":"grok-task","observations":[...],"checked_watch_ids":[...]} in the shape of the brief's examples.
   Every price needs provenance.url and provenance.seen_at.
4. GET <your site>/api/v1/feed?limit=5 and reply with 5 lines: title, place, price if any, first reason.
You cannot book, pay or delete.
```

## Option B: xAI Responses API with remote MCP (a script on your Mac)

Not wired to a scheduler in this repo; sketch only. The key is read from Keychain, never from the file.

```
curl https://api.x.ai/v1/responses \
  -H "Authorization: Bearer $XAI_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.7",
    "tools": [{
      "type": "mcp",
      "server_url": "<your site>/mcp?agent=grok-task",
      "server_label": "rumbo",
      "authorization": "'"$RUMBO_KEY"'",
      "allowed_tools": ["rumbo_agent_brief","rumbo_observe","rumbo_feed"]
    }, {"type": "web_search"}],
    "input": "Daily Rumbo run, agent grok-task: call rumbo_agent_brief, search, report with rumbo_observe, then show rumbo_feed limit 5 in 5 lines. Never estimate a price; never scrape."
  }'
```

This bills the xAI API per token; check the cost of one run before scheduling it (POLICY section 11: any metered charge is stated and asked twice).

## Checks

- After a run: `/agents` shows a `grok-task` row.
- `401`: the key is wrong or in the wrong place; three failures lock the client address for 10 minutes.
