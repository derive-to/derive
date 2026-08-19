#!/usr/bin/env bash
# Run the STORE-BACKED apps/api specs against a real Postgres in an ephemeral
# container. The same specs that `pnpm test` runs on embedded SQLite exercise the
# hosted-tier Postgres driver here, so a wrong WHERE / missing org scope / broken
# transaction in pg.ts fails a test instead of shipping. Requires Docker.
#
# "Store-backed" is derived, not listed — see the note above the run below.
#
#   pnpm test:pg                       # every spec that can reach a store
#   pnpm test:pg artifacts.test.ts     # one file, whichever lane it belongs to
set -euo pipefail

PASSWORD=postgres
DB=derive_test
NAME="derive-pg-test-$$"
# pgvector/pgvector (Postgres + the `vector` extension) so the pgvector store test can
# `CREATE EXTENSION vector` — a superset of stock postgres:16, so the MetaStore specs are
# unaffected. Override with DERIVE_PG_IMAGE.
IMAGE="${DERIVE_PG_IMAGE:-pgvector/pgvector:pg16}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "→ starting ephemeral Postgres ($IMAGE)…"
# Random host port (avoids clashing with any local :5432); bound to loopback.
# A generous max_connections covers many Pools at once — under file parallelism
# several files' isolated-schema stores are live concurrently (pools are lazy, so
# real usage sits well below this ceiling).
#
# Durability is turned OFF on purpose. This container is created for one test run
# and deleted on exit (the trap above), so there is nothing whose survival anyone
# could want: if the machine dies mid-run the answer is to run the suite again,
# not to recover its data. Meanwhile the suite is DDL-heavy — every test file
# replays the full schema into its own namespace — and DDL is exactly what fsync
# punishes.
#   fsync/synchronous_commit/full_page_writes — stop waiting on the disk at all
#   autovacuum                                — nothing lives long enough to need it
#
# How much this buys depends ENTIRELY on how expensive fsync is on the host, and
# the gap is wide enough to mislead: on macOS Docker, where container writes cross
# a virtualization layer, it took the suite 55.6s -> 26.4s (2.1x, CPU 328% -> 684%
# — it had been waiting on disk rather than computing). On the Linux CI runner
# with a local disk, where fsync is already cheap, the same change gives 70s ->
# 59s. Both are real; only the second one is the number CI actually gets. Measure
# there before believing a local A/B of anything I/O-bound.
#
# NEVER copy these to a real database.
docker run -d --rm --name "$NAME" \
  -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB="$DB" \
  -p 127.0.0.1::5432 \
  "$IMAGE" -c max_connections=400 \
  -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
  -c autovacuum=off >/dev/null

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

echo "→ running apps/api suite against Postgres"
cd "$ROOT/apps/api"
# The first test in each file pays the Postgres schema bootstrap (DROP SCHEMA
# CASCADE + full DDL replay via the helpers' deferred store) — on a CI runner
# that alone can cross vitest's default 5s testTimeout as the schema grows.
# Relax the timeout for this lane only; the SQLite lane keeps the 5s default.
#
# File parallelism is ON (previously --no-file-parallelism): helpers.ts keys each
# schema on VITEST_POOL_ID, so concurrent files land in distinct schemas and can't
# collide.
#
# Workers track the core count rather than a fixed 4. The bound that matters here
# is CONNECTIONS, not cores: each worker holds a store pool (node-postgres default
# max=10) and the container above starts with max_connections=400, so the ceiling
# of 16 puts the worst case near 160 — comfortably inside it. A hardcoded 4 was
# wrong in both directions at once: it oversubscribed the old 2-vCPU runner, and
# it would leave most of a larger one idle, even though this lane is I/O-bound on
# Postgres and keeps scaling past one worker per core.
WORKERS="${DERIVE_PG_WORKERS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
[ "$WORKERS" -gt 16 ] && WORKERS=16
echo "→ ${WORKERS} vitest workers"
# ONLY the store-backed specs. This lane exists to run the SAME behaviour against
# the hosted-tier driver, and a spec that never constructs a store cannot do that
# — it executes byte-identical logic in both lanes and the SQLite lane already
# gates it. 112 of the 253 api specs are in that category, ~16% of this lane's
# work, and they were being replayed here for no additional signal.
#
# The membership is the `store` project in apps/api/vitest.config.ts, which
# DERIVES it by walking relative imports to test/helpers.ts (where the backend
# switch lives). Sharing that derivation is deliberate: an eligibility list kept
# separately from the thing it describes is a list that drifts, and the failure
# mode — a spec silently dropped from the Postgres lane — is invisible.
#
# Worth being honest about what this does and does not buy. It is a COST saving,
# not a latency one: vitest distributes whole files, so this lane cannot finish
# faster than its longest single spec, and that is slack-routes at 76s. Splitting
# the oversized specs is what moves the wall clock; this moves the bill.
#
# An explicit file argument bypasses the project filter, so debugging one spec
# still works whichever lane it belongs to.
if [ "$#" -eq 0 ]; then
  pnpm exec vitest run --maxWorkers="$WORKERS" --testTimeout=15000 --project=store
else
  pnpm exec vitest run --maxWorkers="$WORKERS" --testTimeout=15000 "$@"
fi

# Also run @derive/db's store contract against the same Postgres — the only place
# pg.ts (the hosted-tier driver) is covered + gated by the db package's own suite.
# Skipped when a specific api file was requested (debugging one spec).
if [ "$#" -eq 0 ]; then
  echo "→ running @derive/db store contract against Postgres"
  cd "$ROOT"
  pnpm --filter @derive/db test:pg
fi
