#!/usr/bin/env bash
# One unattended Rumbo run: Claude Code or Codex follows skills/rumbo in Run mode, on your own
# subscription (no API key). Started by launchd; safe to run by hand.
#
#   scripts/run-agent.sh              run now
#   scripts/run-agent.sh --dry-run    print what would run, run nothing
#
# Environment (all optional):
#   RUMBO_AGENT     codex (default) | claude-code    the name the run posts under
#   RUMBO_MODEL     model for the run (Claude Code default: sonnet)
#   RUMBO_TIMEOUT   seconds before the run is killed (default 1800)
#   RUMBO_KEY       key override; default is the macOS Keychain item service=rumbo account=key
#   RUMBO_FORCE     set to 1 to skip the machine-load check
#
# Claude desktop scheduled tasks and ChatGPT tasks do not use this script; see routines/agents/.
set -euo pipefail

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; exit 64 ;;
esac

AGENT="${RUMBO_AGENT:-codex}"
TIMEOUT="${RUMBO_TIMEOUT:-1800}"
STATE_DIR="${RUMBO_STATE_DIR:-$HOME/.local/state/rumbo}"
log() { printf '%s rumbo-run: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

PROMPT="Use the rumbo skill in Run mode. agent=${AGENT}."
case "$AGENT" in
  claude-code)
    MODEL="${RUMBO_MODEL:-sonnet}"
    CMD=(claude -p "$PROMPT" --model "$MODEL"
         --allowedTools "mcp__rumbo__*,WebSearch,WebFetch,Skill"
         --max-turns 80 --no-session-persistence)
    ;;
  codex)
    # Nobody can answer an approval prompt at 07:45, so Rumbo's tools (they write only the owner's own
    # feed and never delete, book or pay) are approved for this run only; web search is Codex's own tool.
    CMD=(codex exec --skip-git-repo-check --ephemeral --sandbox read-only
         -c 'web_search="live"' -c 'mcp_servers.rumbo.default_tools_approval_mode="approve"')
    [ -n "${RUMBO_MODEL:-}" ] && CMD+=(-m "$RUMBO_MODEL")
    CMD+=("$PROMPT")
    ;;
  *) log "unknown RUMBO_AGENT=$AGENT (codex | claude-code)"; exit 64 ;;
esac

if [ "$DRY" = 1 ]; then
  log "dry run: agent=$AGENT timeout=${TIMEOUT}s cwd=$STATE_DIR"
  log "would check: teyla load --quiet --admit lane (when teyla is installed)"
  log "would read the key from Keychain (service rumbo, account key) into RUMBO_KEY"
  log "would run: ANTHROPIC_API_KEY/OPENAI_API_KEY unset; ${CMD[*]}"
  exit 0
fi

if [ "${RUMBO_FORCE:-0}" != 1 ] && command -v teyla >/dev/null 2>&1; then
  if ! teyla load --quiet --admit lane; then
    log "machine is loaded (teyla load refused a lane); skipping this run"
    exit 0
  fi
fi

command -v "${CMD[0]}" >/dev/null 2>&1 || { log "${CMD[0]} not found on PATH ($PATH)"; exit 127; }

# The key: Keychain unless overridden. Never printed, never written to a file.
if [ -z "${RUMBO_KEY:-}" ]; then
  RUMBO_KEY="$(security find-generic-password -s rumbo -a key -w 2>/dev/null || true)"
fi
if [ -z "$RUMBO_KEY" ]; then
  log "no Rumbo key in Keychain (service rumbo, account key). Run scripts/install-claude.sh"
  exit 78
fi
export RUMBO_KEY

# Subscription, not API billing: an API key in the environment would switch the run to metered use.
unset ANTHROPIC_API_KEY OPENAI_API_KEY
if [ "$AGENT" = codex ]; then
  login="$(codex login status 2>&1 || true)"
  if ! printf '%s' "$login" | grep -qi 'chatgpt'; then
    log "codex is not signed in with ChatGPT (codex login status: $(printf '%s' "$login" | tail -n1)); refusing a metered run"
    exit 78
  fi
fi

mkdir -p "$STATE_DIR"
cd "$STATE_DIR"

if command -v gtimeout >/dev/null 2>&1; then
  RUNNER=(gtimeout --signal=TERM --kill-after=30 "$TIMEOUT")
elif command -v timeout >/dev/null 2>&1; then
  RUNNER=(timeout --signal=TERM --kill-after=30 "$TIMEOUT")
else
  # perl fallback: TERM, then KILL, the child after $TIMEOUT seconds; exit 124 like timeout(1).
  # shellcheck disable=SC2016
  RUNNER=(perl -e 'my $t = shift; my $pid = fork(); die "fork: $!" unless defined $pid;
                   if ($pid == 0) { exec @ARGV or die "exec: $!" }
                   local $SIG{ALRM} = sub { kill "TERM", $pid; sleep 5; kill "KILL", $pid; exit 124 };
                   alarm $t; waitpid($pid, 0); exit(($? & 127) ? 128 + ($? & 127) : $? >> 8)' "$TIMEOUT")
fi

log "start agent=$AGENT timeout=${TIMEOUT}s"
set +e
"${RUNNER[@]}" "${CMD[@]}"
status=$?
set -e
case "$status" in
  0) log "finished ok (exit 0)" ;;
  124) log "killed after ${TIMEOUT}s (timeout)" ;;
  *) log "failed (exit $status)" ;;
esac
exit "$status"
