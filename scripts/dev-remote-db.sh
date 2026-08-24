#!/usr/bin/env bash
# Run the local dev stack (API + web) against a REMOTE database.
#
# This exists because "does my UI change work against real data" is a question local
# seed data answers badly. It is also how a day of writes once went to production
# unnoticed, so this script is deliberately loud and deliberately narrow.
#
# Two protections, neither of which this script removes:
#
#   1. The API's remote-database guard (apps/api/src/node.ts). That guard
# refuses a remote DATABASE_URL under `pnpm dev` unless DERIVE_ALLOW_REMOTE_DB=1 comes
# from the actual shell — it snapshots the value before loading any .env precisely so a
# stray file can't grant its own permission. This script sets it in the shell, which is
# the consent the guard asks for: typing the command IS the deliberate act. The guard
#      still fires, still logs its warning, and you still see which host answered.
#
#   2. DERIVE_BACKGROUND_WORKERS=0, forced below. The API otherwise runs shared
#      background work that WRITES: the webhook delivery worker every 1.5s, a daily
#      prune and an expired-draft sweep that DELETE rows. The prune fires on BOOT, not
#      just on a timer — so without this, merely
#      starting this script would delete rows in that database and start delivering its
#      webhooks from this machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.remote"

if [ ! -f "$ENV_FILE" ]; then
  echo "dev:remote: missing $ENV_FILE" >&2
  echo "  see the header of this script for the keys it expects" >&2
  exit 1
fi

# Parse rather than `source`. A .env file is not a shell script: a Neon URL ends
# `?sslmode=require&channel_binding=require`, and `.` would read that `&` as a background
# operator and silently truncate the value. Same for `$`, backticks, spaces and `#`. So
# read it line by line and never let the shell evaluate a value.
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"                      # tolerate CRLF
  case "$line" in '' | '#'*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  key="${line%%=*}"
  val="${line#*=}"
  case "$key" in [A-Za-z_][A-Za-z0-9_]*) ;; *) continue ;; esac
  # Strip one layer of surrounding quotes if the author used them.
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  export "$key=$val"
done < "$ENV_FILE"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "dev:remote: no DATABASE_URL in $ENV_FILE" >&2
  exit 1
fi

# Host only — never print the credential, this scrolls past in a shared terminal.
HOST="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[^:]+://[^@]*@?([^/:?]+).*#\1#')"

case "$HOST" in
  localhost | 127.0.0.1 | 0.0.0.0 | *.localhost)
    echo "dev:remote: $ENV_FILE points at $HOST, which is local — use \`pnpm dev:all\`." >&2
    exit 1
    ;;
esac

export DERIVE_ALLOW_REMOTE_DB=1
# Forced, not defaulted: this is the difference between reading production and becoming
# a second writer against it. Overriding it in the env file will not take effect.
export DERIVE_BACKGROUND_WORKERS=0

# A server already on the API port is the quiet failure mode here: the web dev server
# proxies to a fixed port, so a leftover process keeps answering the SPA and the server
# you just started is ignored. It reads as "sign-in is broken" rather than as a conflict,
# and the leftover is usually pointed at a different database.
API_PORT="${PORT:-8090}"
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "dev:remote: something is already listening on port $API_PORT." >&2
  echo "  The web app proxies there, so it would talk to that process, not this one." >&2
  echo "  Stop it first:  lsof -nP -iTCP:$API_PORT -sTCP:LISTEN -t | xargs kill" >&2
  exit 1
fi

printf '\n\033[41;97m  REMOTE DATABASE    \033[0m %s\n\n' "$HOST"
printf '  Everything you do here writes to that database. That includes the things you\n'
printf '  do not think of as writing: signing in creates a real session, opening an\n'
printf '  artifact increments its view count and records presence.\n\n'
if [ -z "${OBJECT_STORE_URL:-}" ]; then
  printf '  Blobs are LOCAL, so artifact bodies and card thumbnails will be missing.\n'
  printf '  Add OBJECT_STORE_URL to .env.neon-debug to read real content too.\n\n'
fi
printf '  Background workers are OFF, so this process will not deliver webhooks, run\n'
printf '  automations, prune, or sweep. Your own reads and edits still hit it.\n\n'
printf '  Confirm the startup lines say:\n'
printf '    meta: postgres (%s)\n' "$HOST"
printf '    workers: OFF (DERIVE_BACKGROUND_WORKERS=0)\n\n'
printf '  Ctrl-C now if that is not what you meant.\n\n'

if [ "${1:-}" = "--check" ]; then
  printf '  --check: parsed and validated, not starting anything.\n\n'
  exit 0
fi

cd "$ROOT"
exec pnpm dev:all
