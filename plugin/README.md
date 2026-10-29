# Rumbo plugin for Claude Code

The `rumbo` skill and the MCP connection to your own Rumbo server (the tool is single-owner: you bring the server and its owner key).

```
/plugin marketplace add zaitsew/rumbo
/plugin install rumbo@rumbo
```

Claude Code asks for the server URL and the owner key (`RUMBO_OWNER_KEY`). The key is stored in the system keychain and sent only as a bearer header to that URL.
Server setup and the tool list are in the [repository README](../README.md).

This directory holds only the manifest and the skill: no `package.json`, because Claude Code would run `npm ci` on it.
`skills/rumbo` in the repository root is a symlink to `plugin/skills/rumbo`, for `scripts/install-claude.sh` and `scripts/install-codex.sh`.
