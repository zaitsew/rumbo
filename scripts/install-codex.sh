#!/usr/bin/env bash
# Connect Codex (CLI, IDE extension and desktop app share one config) to Rumbo (macOS).
#
#   scripts/install-codex.sh [--dry-run] [--uninstall] [--helper] [--daily] [--no-skill] [--url <base url>]
#
# What it does:
#   1. `codex mcp add rumbo --url <url>/mcp --bearer-token-env-var RUMBO_KEY`. Codex reads the key
#      from the environment variable RUMBO_KEY, so ~/.codex/config.toml holds no secret.
#      This script never edits your shell profile; it prints the one line to add (it reads Keychain).
#      --helper uses `http_headers_helper` instead (Keychain read at connect time, no environment
#      variable; use it when you start the Codex desktop app from the Dock).
#   2. links skills/rumbo into ~/.agents/skills/rumbo (Codex's user skills directory)
#   3. --daily: installs the 07:45 launchd job that runs `codex exec` (scripts/run-agent.sh)
#
# Key: run scripts/install-claude.sh first (it stores the key in Keychain, service rumbo account key),
#      or pass RUMBO_KEY=... once (stored in Keychain).
# URL: --url, RUMBO_URL, RUMBO_PUBLIC_URL in .env, default https://rumbo.fabriquefutur.com.
# Run with --dry-run first. The key is never printed.
set -euo pipefail

DRY=0; UNINSTALL=0; HELPER_MODE=0; DAILY=0; SKILL=1; URL_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --helper) HELPER_MODE=1 ;;
    --daily) DAILY=1 ;;
    --no-skill) SKILL=0 ;;
    --url) shift; URL_ARG="${1:-}" ;;
    -h | --help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 64 ;;
  esac
  shift
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$CODEX_DIR/config.toml"
LABEL="com.zaitsew.rumbo.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SKILL_LINK="$HOME/.agents/skills/rumbo"
HELPER="$HOME/.config/rumbo/mcp-headers-codex.sh"

say() { printf '==> %s\n' "$*"; }
run() { printf '    + %s\n' "$*"; [ "$DRY" = 1 ] || "$@"; }

[ "$(uname -s)" = Darwin ] || { echo "This installer is for macOS (Keychain, launchd)." >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "codex not found on PATH" >&2; exit 1; }
[ "$DRY" = 1 ] && say "dry run: nothing will be changed"

# ------------------------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "Codex: remove MCP server rumbo"
  run codex mcp remove rumbo || true
  say "Skill link"
  if [ -L "$SKILL_LINK" ]; then run rm "$SKILL_LINK"
  elif [ -e "$SKILL_LINK" ]; then echo "    $SKILL_LINK is not a symlink; left alone"
  else echo "    none"; fi
  say "launchd job"
  if [ -f "$PLIST" ] && grep -q '<string>codex</string>' "$PLIST"; then
    run launchctl bootout "gui/$(id -u)/$LABEL" || true
    run rm "$PLIST"
  else echo "    none (or it runs another agent; left alone)"; fi
  [ -f "$HELPER" ] && run rm "$HELPER"
  say "done. The Keychain item is shared with Claude Code; scripts/install-claude.sh --uninstall removes it."
  exit 0
fi

# ------------------------------------------------------------------------------------------------
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
say "1/3 Key and Codex MCP server"
KEY="${RUMBO_KEY:-}"
if [ -n "$KEY" ]; then
  case "$KEY" in *[!A-Za-z0-9_.~+/=-]*) echo "The key has unexpected characters." >&2; exit 1 ;; esac
  if [ "$DRY" = 1 ]; then echo "    + store RUMBO_KEY in Keychain (service rumbo, account key)"
  else printf 'add-generic-password -s rumbo -a key -U -w %s\n' "$KEY" | security -i >/dev/null; fi
elif security find-generic-password -s rumbo -a key >/dev/null 2>&1; then
  echo "    key found in Keychain"
elif [ "$DRY" = 1 ]; then echo "    no key yet (a real run needs RUMBO_KEY or scripts/install-claude.sh first)"
else
  echo "No key in Keychain. Run scripts/install-claude.sh first, or set RUMBO_KEY." >&2; exit 1
fi

run codex mcp remove rumbo >/dev/null 2>&1 || true
if [ "$HELPER_MODE" = 1 ]; then
  echo "    helper: $HELPER (reads Keychain; contains no secret)"
  if [ "$DRY" != 1 ]; then
    mkdir -p "$(dirname "$HELPER")"
    cat > "$HELPER" <<'HELPER_EOF'
#!/usr/bin/env bash
# Prints the Rumbo MCP headers as JSON. Written by scripts/install-codex.sh --helper.
set -euo pipefail
k="${RUMBO_KEY:-$(security find-generic-password -s rumbo -a key -w)}"
printf '{"Authorization":"Bearer %s","X-Rumbo-Agent":"codex"}\n' "$k"
HELPER_EOF
    chmod 700 "$HELPER"
  fi
  run codex mcp add rumbo --url "$MCP_URL"
  echo "    + add http_headers_helper = \"$HELPER\" under [mcp_servers.rumbo] in $CONFIG"
  if [ "$DRY" != 1 ]; then
    [ -f "$CONFIG" ] || { echo "codex did not create $CONFIG" >&2; exit 1; }
    tmp="$(mktemp)"
    awk -v line="http_headers_helper = \"$HELPER\"" '
      { print }
      $0 == "[mcp_servers.rumbo]" { print line; done = 1 }
      END { if (!done) exit 3 }' "$CONFIG" > "$tmp" || { rm -f "$tmp"; echo "[mcp_servers.rumbo] not found in $CONFIG" >&2; exit 1; }
    cat "$tmp" > "$CONFIG"; rm -f "$tmp"
  fi
else
  run codex mcp add rumbo --url "$MCP_URL" --bearer-token-env-var RUMBO_KEY
fi
[ "$DRY" = 1 ] || codex mcp get rumbo | sed 's/^/    /'

if [ "$HELPER_MODE" = 0 ]; then
  cat <<'PROFILE'

    Codex reads the key from the environment variable RUMBO_KEY. Add this line to ~/.zprofile
    (this script does not edit your shell profile):

      export RUMBO_KEY="$(security find-generic-password -s rumbo -a key -w 2>/dev/null)"

    The scheduled run (scripts/run-agent.sh) sets it by itself. For the Codex desktop app started from
    the Dock, re-run this script with --helper instead.
PROFILE
fi

# ------------------------------------------------------------------------------------------------
say "2/3 Skill: $SKILL_LINK -> $REPO/skills/rumbo  (Codex's user skills directory is ~/.agents/skills)"
if [ "$SKILL" = 0 ]; then echo "    skipped (--no-skill)"
elif [ -e "$SKILL_LINK" ] && [ ! -L "$SKILL_LINK" ]; then
  echo "    $SKILL_LINK exists and is not a symlink; leaving it." >&2
else
  run mkdir -p "$HOME/.agents/skills"
  run ln -sfn "$REPO/skills/rumbo" "$SKILL_LINK"
fi

# ------------------------------------------------------------------------------------------------
say "3/3 Daily run with codex exec"
if [ "$DAILY" = 0 ]; then echo "    off (add --daily; one scheduled agent is enough to start with)"
else
  rendered="$(sed -e "s|__RUN_SCRIPT__|$REPO/scripts/run-agent.sh|g" -e "s|__HOME__|$HOME|g" \
                  -e "s|__AGENT__|codex|g" "$REPO/scripts/launchd/$LABEL.plist.template")"
  if [ "$DRY" = 1 ]; then echo "    + write $PLIST (RUMBO_AGENT=codex, 07:45)"
  else
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    printf '%s\n' "$rendered" > "$PLIST"; plutil -lint "$PLIST" >/dev/null
  fi
  run launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  run launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi

cat <<NEXT

Done$( [ "$DRY" = 1 ] && echo " (dry run)").
  Try it:   RUMBO_KEY="\$(security find-generic-password -s rumbo -a key -w)" codex exec --skip-git-repo-check "Use the rumbo skill: what's in my travel feed?"
  Remove:   $REPO/scripts/install-codex.sh --uninstall
NEXT
