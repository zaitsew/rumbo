# Getting started with Rumbo

## What this is

Rumbo is one person's trip planner and travel feed. You tell it where you live, what you like and when you are free;
servers and AI agents add flights, stays and events they find, and Rumbo keeps them in one list.

## What you need before you start

- The owner key (`RUMBO_OWNER_KEY`). Whoever runs the server sets it; there is no sign-up.
- A browser. Nothing to install.

## First five minutes

1. Open the site and sign in with the owner key.
2. Open **Profile**. Fill in your home city and airports, then move the interest sliders. Save.
3. Open **Watches**. Add a route (for example VLC to LIS, departing in December) and an alert price.
4. Open **Feed**. Findings appear here as the server and your agents post them.

You are set up when: **the profile page shows your values after a reload and a watch is listed as active.**

## If something goes wrong

- "That key is not right": check `RUMBO_OWNER_KEY` in the server's `.env`. Ten wrong tries lock the address out for ten minutes, even for the right key.
- Signed out after a key change: expected. Rotating the key signs every browser out.
- The feed is empty: nothing has been collected yet. Post an observation to `/api/v1/observations` or wait for a watch to run.
