-- One-shot re-key of slack_thread_link for D1, from UNIQUE(thread_id) to
-- UNIQUE(thread_id, channel). Run ONCE per existing D1 database; new databases already create
-- the right shape from deploy/d1-schema.sql and do not need it (running it anyway is harmless —
-- see IDEMPOTENCE below).
--
--   D1 (edge):  wrangler d1 execute <db> --remote --file=deploy/rekey-slack-thread-link-d1.sql
--
-- WHY. A Derive comment thread now mirrors into every channel subscribed to its artifact, so
-- one thread legitimately has several Slack messages — one per channel. The old single-column
-- unique rejects the second one with `UNIQUE constraint failed`, and a constraint change has no
-- additive form: `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, and the
-- generated MIGRATION_STATEMENTS only ever emit `ADD COLUMN`. So an upgraded database would keep
-- the old constraint indefinitely and break the first time a second channel subscribed, with
-- nothing failing at deploy time to say so.
--
-- Postgres says this directly and rides the normal deploy (a guarded constraint swap in
-- PG_SCHEMA_STATEMENTS); the self-host SQLite driver runs the equivalent rebuild guarded at boot
-- (packages/db/src/sqlite.ts, which can wrap it in one transaction). D1 can do neither, hence
-- this file.
--
-- WHAT D1 CANNOT DO. No `BEGIN` / `COMMIT` — D1 rejects explicit transaction control inside an
-- executed file, so every statement below stands alone and each leaves the database consistent
-- by itself. The foreign-key trap that shaped deploy/relax-context-session-d1.sql does NOT apply
-- here: slack_thread_link declares no foreign keys and nothing references it, so the DROP below
-- orphans nothing.
--
-- IDEMPOTENCE. Re-running this on an already-migrated database is safe: the copy re-inserts the
-- same rows into a fresh table with the same shape, and the result is identical. The only cost
-- is the rewrite. It is NOT safe to run concurrently with live traffic writing thread links —
-- rows written between the INSERT and the RENAME would be lost with the dropped table. Slack
-- thread links are only written when a comment is mirrored, so pick a quiet moment.

CREATE TABLE IF NOT EXISTS slack_thread_link__new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (thread_id, channel),
  UNIQUE (channel, message_ts)
);

INSERT OR IGNORE INTO slack_thread_link__new
  (id, org_id, artifact_id, thread_id, channel, message_ts, created_at)
  SELECT id, org_id, artifact_id, thread_id, channel, message_ts, created_at
  FROM slack_thread_link;

DROP TABLE slack_thread_link;

ALTER TABLE slack_thread_link__new RENAME TO slack_thread_link;
