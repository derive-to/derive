#!/usr/bin/env bash
# Run the apps/api test suite against a real Postgres in an ephemeral container.
# The same specs that `pnpm test` runs on embedded SQLite exercise the hosted-
# tier Postgres driver here, so a wrong WHERE / missing org scope / broken
# transaction in pg.ts fails a test instead of shipping. Requires Docker.
#
#   pnpm test:pg                       # whole suite
#   pnpm test:pg artifacts.test.ts     # one file (extra args pass through)
set -euo pipefail

PASSWORD=postgres
DB=dock_test
NAME="dock-pg-test-$$"
IMAGE="${DOCK_PG_IMAGE:-postgres:16-alpine}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "→ starting ephemeral Postgres ($IMAGE)…"
# Random host port (avoids clashing with any local :5432); bound to loopback.
# A generous max_connections covers one Pool per isolated test schema.
docker run -d --rm --name "$NAME" \
  -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB="$DB" \
  -p 127.0.0.1::5432 \
  "$IMAGE" -c max_connections=200 >/dev/null

PORT="$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')"
URL="postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DB}"
echo "→ Postgres on 127.0.0.1:${PORT}"

printf "→ waiting for readiness"
for i in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then
    echo " ok"
    break
  fi
  printf "."
  sleep 0.5
  if [ "$i" -eq 60 ]; then echo " timed out" && exit 1; fi
done

export DOCK_TEST_DB=pg
export TEST_DATABASE_URL="$URL"

echo "→ running apps/api suite against Postgres"
cd "$ROOT/apps/api"
pnpm exec vitest run --no-file-parallelism "$@"
