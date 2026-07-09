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
DB=derive_test
NAME="derive-pg-test-$$"
IMAGE="${DERIVE_PG_IMAGE:-postgres:16-alpine}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "→ starting ephemeral Postgres ($IMAGE)…"
# Random host port (avoids clashing with any local :5432); bound to loopback.
# A generous max_connections covers many Pools at once — under file parallelism
# several files' isolated-schema stores are live concurrently (pools are lazy, so
# real usage sits well below this ceiling).
docker run -d --rm --name "$NAME" \
  -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB="$DB" \
  -p 127.0.0.1::5432 \
  "$IMAGE" -c max_connections=400 >/dev/null

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

export DERIVE_TEST_DB=pg
export TEST_DATABASE_URL="$URL"

# Modes:
#   test-pg.sh              → api suite + @derive/db store contract (local, full run)
#   test-pg.sh --shard=i/N  → one shard of the api suite (a CI matrix leg)
#   test-pg.sh --db-only    → just the @derive/db store contract (its own CI leg)
if [ "${1:-}" = "--db-only" ]; then
  echo "→ running @derive/db store contract against Postgres"
  cd "$ROOT"
  pnpm --filter @derive/db test:pg
else
  echo "→ running apps/api suite against Postgres"
  cd "$ROOT/apps/api"
  # The first test in each file pays the Postgres schema bootstrap (DROP SCHEMA
  # CASCADE + full DDL replay via the helpers' deferred store) — on a CI runner
  # that alone can cross vitest's default 5s testTimeout as the schema grows.
  # Relax the timeout for this lane only; the SQLite lane keeps the 5s default.
  #
  # File parallelism is ON (previously --no-file-parallelism): helpers.ts keys each
  # schema on VITEST_POOL_ID, so concurrent files land in distinct schemas and can't
  # collide. --maxWorkers=4 bounds the live per-store pools (node-postgres default
  # max=10) so their connections stay well under max_connections. Note vitest does
  # NOT clamp an explicit maxWorkers to core count, so this runs 4 forks even on a
  # 2-vCPU box — fine here because pg tests are I/O-bound (waiting on Postgres). A
  # CI shard passes --shard=i/N through "$@".
  pnpm exec vitest run --maxWorkers=4 --testTimeout=15000 "$@"

  # Also run @derive/db's store contract when running the whole suite locally
  # (skipped for a specific file or a CI shard, which pass args).
  if [ "$#" -eq 0 ]; then
    echo "→ running @derive/db store contract against Postgres"
    cd "$ROOT"
    pnpm --filter @derive/db test:pg
  fi
fi
