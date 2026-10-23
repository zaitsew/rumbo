#!/usr/bin/env bash
# Connect Claude Code (terminal and the Mac app's Code tab) to Rumbo (macOS).
#
#   scripts/install-claude.sh [--dry-run] [--uninstall] [--purge] [--url <base url>]
#                             [--store-key-in-config]
#
# What it does, in order:
#   1. stores your Rumbo owner key in the macOS Keychain (service rumbo, account key)
#   2. registers the MCP server `rumbo` for your user in Claude Code. The key is read from Keychain
#      at connect time by a 3-line helper (headersHelper), so ~/.claude.json holds no secret
#   3. links skills/rumbo into ~/.claude/skills/rumbo
#
# Needs: RUMBO_KEY (the RUMBO_OWNER_KEY of the server; or type it when asked, input hidden) and a URL:
#        --url, RUMBO_URL, or RUMBO_PUBLIC_URL in .env, default https://rumbo.fabriquefutur.com.
# Run with --dry-run first. The key is never printed. Safe to re-run.
# --uninstall removes the server and the skill link; the Keychain item and helper stay while Codex
# uses them (--purge removes them too).
#
# Scheduled runs: Claude desktop scheduled tasks are created in the app, not here. Paste
# routines/agents/claude-scheduled-task.md (see routines/agents/README.md).
set -euo pipefail

DRY=0; UNINSTALL=0; PURGE=0; KEY_IN_CONFIG=0; URL_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) UNINSTALL=1; PURGE=1 ;;
    --store-key-in-config) KEY_IN_CONFIG=1 ;;
    --url) shift; URL_ARG="${1:-}" ;;
    -h | --help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 64 ;;
  esac
  shift
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_LINK="$HOME/.claude/skills/rumbo"
HELPER="$HOME/.config/rumbo/mcp-headers.sh"

say() { printf '==> %s\n' "$*"; }
# run: print the command (never one carrying the key) and execute it unless --dry-run.
run() { printf '    + %s\n' "$*"; [ "$DRY" = 1 ] || "$@"; }

[ "$(uname -s)" = Darwin ] || { echo "This installer is for macOS (Keychain)." >&2; exit 1; }
[ "$DRY" = 1 ] && say "dry run: nothing will be changed"

# ------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "Claude Code: remove MCP server rumbo (user scope)"
  if command -v claude >/dev/null 2>&1; then run claude mcp remove rumbo --scope user || true
  else echo "    claude not found; skipped"; fi

  say "Skill link"
  if [ -L "$SKILL_LINK" ]; then run rm "$SKILL_LINK"
  elif [ -e "$SKILL_LINK" ]; then echo "    $SKILL_LINK is not a symlink; left alone"
  else echo "    none"; fi

  # The helper and the Keychain item are shared with Codex (scripts/install-codex.sh): keep them
  # while Codex still uses Rumbo, unless --purge.
  say "Helper and Keychain item"
  if [ "$PURGE" != 1 ] && command -v codex >/dev/null 2>&1 && codex mcp get rumbo >/dev/null 2>&1; then
    echo "    kept: Codex still uses them (pass --purge to remove anyway)"
  else
    [ -f "$HELPER" ] && run rm "$HELPER" || echo "    no helper"
    run security delete-generic-password -s rumbo -a key || echo "    no Keychain item"
  fi
  say "done. Rotate RUMBO_OWNER_KEY on the server if the key may have leaked."
  exit 0
fi

# ------------------------------------------------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  [ "$DRY" = 1 ] && echo "note: claude (Claude Code) not found on PATH; a real run needs it" >&2 || { echo "claude (Claude Code) not found on PATH" >&2; exit 1; }
fi

RUMBO_URL="${URL_ARG:-${RUMBO_URL:-}}"
if [ -z "$RUMBO_URL" ] && [ -f "$REPO/.env" ]; then
  RUMBO_URL="$(sed -n 's/^RUMBO_PUBLIC_URL=//p' "$REPO/.env" | head -n1 | tr -d '"'"'"' \r')"
fi
RUMBO_URL="${RUMBO_URL:-https://rumbo.fabriquefutur.com}"
RUMBO_URL="${RUMBO_URL%/}"; RUMBO_URL="${RUMBO_URL%/mcp}"
case "$RUMBO_URL" in https://*|http://localhost*|http://127.0.0.1*) ;; *) echo "The URL must be https:// (got $RUMBO_URL)" >&2; exit 1 ;; esac
case "$RUMBO_URL" in *[\"\ \\]*) echo "The URL has characters that need escaping" >&2; exit 1 ;; esac
MCP_URL="$RUMBO_URL/mcp"
say "Rumbo server: $MCP_URL"

# ------------------------------------------------------------------------------------------------
say "1/3 Key -> macOS Keychain (service rumbo, account key)"
KEY="${RUMBO_KEY:-}"
if [ -n "$KEY" ]; then echo "    using RUMBO_KEY from the environment"
elif security find-generic-password -s rumbo -a key >/dev/null 2>&1; then
  echo "    a key is already in Keychain; keeping it (re-run with RUMBO_KEY=... to replace)"
elif [ "$DRY" = 1 ]; then echo "    would ask for the key (input hidden)"
elif [ -t 0 ]; then
  printf '    Paste your Rumbo owner key (input hidden): '
  read -rs KEY; echo
else
  echo "No key. Set RUMBO_KEY or run this in a terminal." >&2; exit 1
fi
if [ -n "$KEY" ]; then
  case "$KEY" in *[!A-Za-z0-9_.~+/=-]*|"") echo "The key has unexpected characters; paste only the key." >&2; exit 1 ;; esac
  if [ "$DRY" = 1 ]; then echo "    + security add-generic-password -s rumbo -a key -U   (key via stdin)"
  else
    # `security -i` reads the command from stdin, so the key never appears in the process list.
    printf 'add-generic-password -s rumbo -a key -U -w %s\n' "$KEY" | security -i >/dev/null
    echo "    stored"
  fi
  # A quick check; a server that is not deployed yet is a warning, not a failure.
  if [ "$DRY" != 1 ] && command -v curl >/dev/null 2>&1; then
    code="$(printf 'Authorization: Bearer %s\n' "$KEY" | curl -sS -o /dev/null -w '%{http_code}' -H @- "$RUMBO_URL/api/v1/profile" 2>/dev/null || true)"
    case "$code" in
      200) echo "    key accepted by the server" ;;
      401 | 429 | 503) echo "    WARNING: the server answered HTTP $code. Check the key and the URL." ;;
      *) echo "    note: could not verify the key (HTTP ${code:-none}); is Rumbo deployed at $RUMBO_URL?" ;;
    esac
  fi
fi

# ------------------------------------------------------------------------------------------------
say "2/3 Claude Code MCP server (user scope)"
if [ "$KEY_IN_CONFIG" = 1 ]; then
  [ -n "$KEY" ] || KEY="$(security find-generic-password -s rumbo -a key -w 2>/dev/null || true)"
  echo "    --store-key-in-config: the key will be written to ~/.claude.json"
  run claude mcp remove rumbo --scope user >/dev/null 2>&1 || true
  if [ "$DRY" = 1 ]; then
    echo "    + claude mcp add --transport http --scope user rumbo $MCP_URL --header 'Authorization: Bearer <key>' --header 'X-Rumbo-Agent: claude-code'"
  else
    claude mcp add --transport http --scope user rumbo "$MCP_URL" --header "Authorization: Bearer $KEY" --header "X-Rumbo-Agent: claude-code"
  fi
else
  # The helper prints the headers from Keychain each time Claude Code connects (headersHelper).
  echo "    helper: $HELPER (reads Keychain; contains no secret)"
  if [ "$DRY" != 1 ]; then
    mkdir -p "$(dirname "$HELPER")"
    cat > "$HELPER" <<'HELPER_EOF'
#!/usr/bin/env bash
# Prints the Rumbo MCP headers as JSON. Written by scripts/install-claude.sh.
set -euo pipefail
k="${RUMBO_KEY:-$(security find-generic-password -s rumbo -a key -w)}"
printf '{"Authorization":"Bearer %s","X-Rumbo-Agent":"%s"}\n' "$k" "${RUMBO_AGENT:-claude-code}"
HELPER_EOF
    chmod 700 "$HELPER"
  fi
  json="{\"type\":\"http\",\"url\":\"$MCP_URL\",\"headersHelper\":\"$HELPER\"}"
  run claude mcp remove rumbo --scope user >/dev/null 2>&1 || true
  run claude mcp add-json --scope user rumbo "$json"
fi

# ------------------------------------------------------------------------------------------------
say "3/3 Skill: $SKILL_LINK -> $REPO/skills/rumbo"
if [ -e "$SKILL_LINK" ] && [ ! -L "$SKILL_LINK" ]; then
  echo "    $SKILL_LINK exists and is not a symlink; leaving it. Remove it and re-run." >&2
else
  run mkdir -p "$HOME/.claude/skills"
  run ln -sfn "$REPO/skills/rumbo" "$SKILL_LINK"
fi

cat <<NEXT

Done$( [ "$DRY" = 1 ] && echo " (dry run)").
  Check:    claude mcp list            (rumbo should say Connected)
  Try it:   claude -p "Use the rumbo skill: what's in my travel feed?" --allowedTools "mcp__rumbo__*"
  Schedule: paste routines/agents/claude-scheduled-task.md into a Claude desktop scheduled task (07:30 Europe/Madrid)
  Remove:   $REPO/scripts/install-claude.sh --uninstall
NEXT
