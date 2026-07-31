/**
 * EXPLAIN the bootstrap statement — the program's own rule ("EXPLAIN before calling a
 * query fast or slow") applied to the one statement /v1/bootstrap depends on.
 *
 * Not part of the suite (`.manual.ts`, like weather-artifact.manual.ts): it needs a
 * real Postgres and reports a plan rather than asserting a behavior. Run it against
 * the same ephemeral container the pg lane uses:
 *
 *   docker run -d --rm --name pg-plan -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=derive_test -p 127.0.0.1:55432:5432 pgvector/pgvector:pg17
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/derive_test \
 *     pnpm --filter @derive/api exec tsx test/bootstrap-plan.manual.ts
 *   docker rm -f pg-plan
 *
 * MEASURED 2026-07-31 at 5k artifacts / 5k tags / 2k notifications:
 * Planning 0.27ms, **Execution 2.7-3.3ms**. Four Seq Scans, all size-appropriate —
 * the tables are small enough that the planner correctly prefers a scan to the
 * indexes that exist (artifact_org_created, notification_user_time). This confirms
 * the program's headline from the other direction: the statement's own cost is
 * NOISE (~3ms) against the ~285ms the request takes on the hosted tier. The trip is
 * everything; the query is free.
 *
 * ONE STRUCTURAL NOTE, inherited not introduced: the notifications arm's unread
 * count is `count(*) FILTER (WHERE read = 0) OVER ()`, a window over EVERY row for
 * that user — so that arm is O(user's total notifications) regardless of the LIMIT
 * 50. It is 0.1ms at 2k rows and would not be at 200k. notificationsPage has always
 * done this; the batch inherits it. If a heavy user ever makes this hurt, the fix is
 * a separate cheap COUNT with its own index, not a change to this batch.
 *
 * What to look for on a re-run: Execution Time still in single-digit ms, and no Seq
 * Scan appearing on a table that has GROWN past the planner's crossover.
 */
// biome-ignore-all lint/suspicious/noConsole: a plan-reporting script; stdout IS its output
import { PgMetaStore } from "@derive/db/pg"
import { Pool } from "pg"

const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error("set TEST_DATABASE_URL (see the header comment)")

const ORG = "org_plan"
const USER = "u_plan"

const main = async () => {
  // PgMetaStore.create applies the schema (idempotent) — the same path the Node tier
  // boots with, so the plan below runs against the real DDL and indexes.
  await PgMetaStore.create(url)
  const pool = new Pool({ connectionString: url })

  // Enough rows that a seq scan is distinguishable from an index scan in the plan.
  await pool.query(
    `INSERT INTO workspace (id, name) VALUES ($1, 'Plan Workspace') ON CONFLICT DO NOTHING`,
    [ORG],
  )
  await pool.query(
    `INSERT INTO artifact (id, org_id, short_id, title, kind, current_version, created_at)
     SELECT 'a_'||g, $1, 'sid'||g, 'Artifact '||g, 'file', 1, now()::text
       FROM generate_series(1, 5000) g ON CONFLICT DO NOTHING`,
    [ORG],
  )
  await pool.query(
    `INSERT INTO artifact_tag (id, artifact_id, tag)
     SELECT 'at_'||g, 'a_'||g, 'tag'||(g % 40) FROM generate_series(1, 5000) g ON CONFLICT DO NOTHING`,
  )
  await pool.query(
    `INSERT INTO notification (id, user_id, actor, kind, artifact_id, artifact_short_id,
       artifact_title, thread_id, comment_id, preview, read, created_at)
     SELECT 'n_'||g, $1, 'someone', 'mention', 'a_'||g, 'sid'||g, 'Artifact '||g,
       '', '', 'preview', 0, now()::text
       FROM generate_series(1, 2000) g ON CONFLICT DO NOTHING`,
    [USER],
  )
  await pool.query("ANALYZE")

  // The statement PgMetaStore.bootstrap runs, verbatim in shape.
  const { rows } = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
     SELECT 'summary' arm, (SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
       SELECT 'total' kind, NULL k, count(*)::int n FROM artifact WHERE org_id = $1
       UNION ALL SELECT 'tag', t.tag, count(*)::int FROM artifact_tag t
         JOIN artifact a ON a.id = t.artifact_id WHERE a.org_id = $1 GROUP BY t.tag) t) doc
     UNION ALL
     SELECT 'notifications', (SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.created_at DESC, t.id DESC), '[]'::jsonb) FROM (
       SELECT *, count(*) FILTER (WHERE read = 0) OVER ()::int AS unread_total
         FROM notification WHERE user_id = $2 ORDER BY created_at DESC LIMIT $3) t)`,
    [ORG, USER, 50],
  )
  for (const r of rows) console.log(Object.values(r)[0])

  const seq = rows.map((r) => String(Object.values(r)[0])).filter((l) => /Seq Scan/.test(l))
  console.log(seq.length ? `\n⚠ ${seq.length} Seq Scan(s) above` : "\n✓ no Seq Scan")
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
