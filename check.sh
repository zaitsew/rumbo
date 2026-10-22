#!/usr/bin/env bash
# The first-run check: prints what's missing, verifies the toolchain, runs the
# type check, tests and data validation. Exits non-zero with a clear list if something is wrong.
#
#   ./check.sh
set -uo pipefail
cd "$(dirname "$0")"

# --- usage mode: real-usage counters, read by `teyla products` --------------
# Print key=value lines from the product's own store: rows logged, messages
# sent, sessions this week, active users. Zero is a finding, not an error.
# What to count per tier: templates/analytics/STANDARD.md in Teyla's repo. A
# Supabase product reads its counters with: teyla probe-sql <ref> "select …"
case "${1:-}" in
  usage)
    # Counters come from the product's own SQLite store (RUMBO_DB, default ./data/rumbo.db).
    if [ -d node_modules ]; then
      npm run -s usage
    else
      echo "usage_probe=not_installed"
    fi
    exit 0 ;;
esac

missing=()
warnings=()

# --- env vars -------------------------------------------------------------
# Only RUMBO_OWNER_KEY is required. Everything else in .env.example is optional: a source
# whose key is missing stays off, and RUMBO_DB defaults to ./data/rumbo.db.
REQUIRED_ENV=(RUMBO_OWNER_KEY)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
for var in "${REQUIRED_ENV[@]}"; do
  if [ -z "${!var:-}" ]; then
    missing+=("env: $var (copy .env.example to .env; generate one with: openssl rand -hex 24)")
  fi
done

# --- toolchain -----------------------------------------------------------
if [ -f package.json ]; then
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$node_major" -ge 24 ] || missing+=("toolchain: node >= 24 (found $(node -v)); node:sqlite needs it")
  else
    missing+=("toolchain: node >= 24 (package.json present)")
  fi
  command -v npm  >/dev/null 2>&1 || missing+=("toolchain: npm (package.json present)")
  [ -d node_modules ] || missing+=("run: npm install")
fi
if [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  command -v python3 >/dev/null 2>&1 || missing+=("toolchain: python3")
fi
if [ -f Package.swift ] || ls -- *.xcodeproj >/dev/null 2>&1; then
  command -v swift >/dev/null 2>&1 || missing+=("toolchain: swift")
fi
if [ -f Cargo.toml ]; then
  command -v cargo >/dev/null 2>&1 || missing+=("toolchain: cargo")
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "MISSING:"
  for m in "${missing[@]}"; do echo "  - $m"; done
  exit 1
fi

# --- tests, if any exist ---------------------------------------------------
ran_tests=0
if [ -f package.json ] && command -v npm >/dev/null 2>&1; then
  npx tsc --noEmit || { echo "npx tsc --noEmit FAILED"; exit 1; }
  npx vitest run && ran_tests=1 || { echo "npx vitest run FAILED"; exit 1; }
  npm run -s validate-data || { echo "npm run validate-data FAILED"; exit 1; }
fi
if { [ -f pyproject.toml ] || [ -f requirements.txt ]; } && command -v python3 >/dev/null 2>&1; then
  if python3 -m pytest --version >/dev/null 2>&1; then
    python3 -m pytest -q && ran_tests=1 || { echo "pytest FAILED"; exit 1; }
  fi
fi
if [ -f Package.swift ] && command -v swift >/dev/null 2>&1; then
  swift build && swift test && ran_tests=1 || { echo "swift test FAILED"; exit 1; }
fi

if [ "$ran_tests" -eq 0 ]; then
  warnings+=("no test runner found — nothing was actually run")
fi

echo "OK"
for w in ${warnings[@]+"${warnings[@]}"}; do echo "  note: $w"; done
exit 0
