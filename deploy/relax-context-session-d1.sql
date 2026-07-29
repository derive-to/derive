-- One-shot relaxation of context_session for D1, so a session no longer requires a
-- context. Run ONCE per existing D1 database; new databases already create the relaxed
-- shape from deploy/d1-schema.sql and must NOT run this.
--
--   D1 (edge):  wrangler d1 execute <db> --remote --file=deploy/relax-context-session-d1.sql
--
-- WHY A FILE AND NOT BOOT DDL. Chat lets you talk to a document with no context, so
-- context_id and context_version became nullable. `ADD COLUMN` cannot express "may now be
-- null" and SQLite has no `ALTER COLUMN`, so the only route is the documented
-- create-copy-drop-rename rebuild. Postgres says it directly and rides the normal deploy
-- (`ALTER ... DROP NOT NULL` in PG_SCHEMA_STATEMENTS, applied by deploy:pg-schema), and the
-- self-host SQLite driver runs the same rebuild guarded at boot (packages/db/src/sqlite.ts).
-- D1 has neither: its schema is applied out of band and its driver runs no migrations. Hence
-- this file — the same convention as deploy/drop-v1-access.sql.
--
-- SAFETY. `defer_foreign_keys` is the D1-supported way to hold FK enforcement until COMMIT:
-- a rebuild re-validates every foreign key on the copied rows, so a single orphaned session
-- (one whose context was deleted) would otherwise abort the whole migration. The copy is
-- explicit about columns rather than `SELECT *` so a column added later cannot silently
-- shift positions.
--
-- IDEMPOTENCE. Unlike the SQLite boot path there is no pragma check here, so running this
-- twice on an already-relaxed database will fail at `ALTER TABLE ... RENAME` (the target
-- already exists) rather than corrupting anything. Check first if unsure:
--   wrangler d1 execute <db> --remote --command "SELECT sql FROM sqlite_master WHERE name='context_session'"
-- and skip this file if context_id already lacks NOT NULL.

PRAGMA defer_foreign_keys = TRUE;

BEGIN TRANSACTION;

CREATE TABLE context_session__new (
  id TEXT PRIMARY KEY,
  context_id TEXT,
  org_id TEXT NOT NULL,
  asker_id TEXT NOT NULL,
  context_version INTEGER,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  started_at TEXT,
  lease_until TEXT,
  result_artifact_id TEXT,
  dedupe_key TEXT,
  subject_ref TEXT,
  FOREIGN KEY (context_id) REFERENCES context(id)
);

INSERT INTO context_session__new (
  id, context_id, org_id, asker_id, context_version, state,
  created_at, updated_at, started_at, lease_until, result_artifact_id, dedupe_key, subject_ref
)
SELECT
  id, context_id, org_id, asker_id, context_version, state,
  created_at, updated_at, started_at, lease_until, result_artifact_id, dedupe_key, subject_ref
FROM context_session;

DROP TABLE context_session; -- schema-ignore: middle step of the rebuild above, inside the txn

ALTER TABLE context_session__new RENAME TO context_session;

CREATE INDEX IF NOT EXISTS context_session_queue ON context_session (context_id, state, created_at);
CREATE INDEX IF NOT EXISTS context_session_asker ON context_session (asker_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS context_session_dedupe
  ON context_session (context_id, asker_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('open','working');

COMMIT;
