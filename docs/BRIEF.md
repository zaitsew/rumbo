# Brief — the owner's words

Rumbo exists because of this request (Ivan Zaitsev, 2026-10-23), quoted verbatim:

> Develop a tool that will help me to plan trips (destination, flight tickets, rent a car, hotels, activities, etc.) from scratch and will make a personal recommendations feed. I think it can be a separate web product from Loco, but Loco will natively use it. it should analyze aggregators (like google flights, google hotels, booking.com, airbnb) and providers (airlines direct websites, for example).
>
> Also, i think it should be deeply integrated on ai harnesses (codex, claude code in claude macos, etc.) and ai bots (like grok bot, chatgpt dots, etc.) - so the scheduled runs performed, collected and prioritized the events depending on my profile and history

Name and home, chosen the same day: "Rumbo (Recommended)", "zaitsew · public".

## What each sentence asks for, and where it lives

| his words | what Rumbo does | where |
|---|---|---|
| "plan trips (destination, flight tickets, rent a car, hotels, activities, etc.) from scratch" | A plan starts from a free-text wish or a form (when, how long, who, budget, mood). Rumbo ranks destinations, then fills flights, stays, car, activities and events for the chosen one. | `/plan`, `src/core/destinations.ts`, `src/server/plan.ts` |
| "a personal recommendations feed" | Watches and agents produce observations (a fare, a stay, an event). A deterministic ranker scores each against the profile and history and shows why. | `/`, `src/core/rank.ts` |
| "a separate web product from Loco, but Loco will natively use it" | Own repo, own site, own API and MCP. A plan exports as a Loco proposal (`loco_propose` shape); Loco calls Rumbo's API. | `src/core/loco.ts`, `docs/AGENTS.md` |
| "analyze aggregators (like google flights, google hotels, booking.com, airbnb) and providers (airlines direct websites)" | Licensed APIs where they exist (Kiwi MCP, Travelpayouts, Viator, Tiqets; events from SAWk, D7), official agent connectors (Booking.com, Expedia, Viator, Tripadvisor in Claude and ChatGPT), and one-tap deep links into Google Flights, Google Hotels, Booking.com, Airbnb, Skyscanner and the airlines' own sites. No scraping. See D2. | `src/server/sources/`, `src/core/links.ts` |
| "deeply integrated on ai harnesses (codex, claude code in claude macos, etc.) and ai bots (like grok bot, chatgpt dots, etc.)" | A remote MCP server and a JSON API. Ready prompts for a Claude scheduled task, a Codex automation, a ChatGPT task and a Grok task. | `/mcp`, `routines/agents/` |
| "the scheduled runs performed, collected and prioritized the events depending on my profile and history" | The server runs due watches on a schedule. Scheduled agents ask `rumbo_agent_brief` what to check, use their own connectors, and post findings with `rumbo_observe`. Everything lands in one ranked feed. | `src/server/collect.ts`, `rumbo_agent_brief`, `rumbo_observe` |
