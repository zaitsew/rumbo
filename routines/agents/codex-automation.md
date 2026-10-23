# Codex automation

Agent name: `codex-automation` (the script names it `codex`; use `RUMBO_AGENT` to change). Schedule: daily 07:45 on your Mac via launchd, or a Codex app automation.

Status: `scripts/run-agent.sh --dry-run` and `scripts/install-codex.sh --dry-run` were run. A real `codex exec` run against a deployed Rumbo is unverified.

## Option A: launchd (recommended, no app needs to be open)

```
scripts/install-claude.sh --dry-run && scripts/install-claude.sh   # stores the key in Keychain (once)
scripts/install-codex.sh --dry-run
scripts/install-codex.sh --daily                                   # MCP server, skill, 07:45 job
```

`install-codex.sh` runs `codex mcp add rumbo --url <url>/mcp --bearer-token-env-var RUMBO_KEY`, so `~/.codex/config.toml` has no secret. `scripts/run-agent.sh` reads the key from Keychain, exports `RUMBO_KEY`, and runs:

```
codex exec --skip-git-repo-check --ephemeral --sandbox read-only \
  -c 'web_search="live"' -c 'mcp_servers.rumbo.default_tools_approval_mode="approve"' \
  "Use the rumbo skill in Run mode. agent=codex."
```

Guards in the script: it skips the run when `teyla load` says the machine is busy, refuses to run on an API key (it needs a ChatGPT login, so the run uses your subscription), and kills a run after 30 minutes. Log: `~/Library/Logs/rumbo-daily.log`.

Run it by hand: `scripts/run-agent.sh`. Remove: `scripts/install-codex.sh --uninstall`.

## Option B: Codex app automation

In the Codex app, create an automation (daily, 07:45) with this prompt. The app needs the key without a shell: install with `scripts/install-codex.sh --helper`, which uses `http_headers_helper` and reads Keychain.

```
Use the rumbo skill in Run mode. agent=codex-automation.
Call rumbo_agent_brief, search with the tools you have, report with rumbo_observe, then show the top
5 of rumbo_feed in 5 lines. Never estimate a price; every price needs a page url and the time you
saw it. Never scrape. Do not book, pay, sign in or delete.
```

## Checks

- `codex mcp get rumbo` shows the URL and `bearer_token_env_var = RUMBO_KEY`.
- `RUMBO_KEY=... codex exec "List the rumbo tools"` names 13 tools.
- After a run: `/agents` shows a `codex` or `codex-automation` row.
- Approval mode `approve` is applied only for the scheduled run; your interactive Codex asks as usual.
