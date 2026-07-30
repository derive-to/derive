-- One-shot relaxation of context_session for D1, so a session no longer requires a
-- context. Run ONCE per existing D1 database; new databases already create the relaxed
-- shape from deploy/d1-schema.sql and do not need it (running it anyway is harmless — see
-- IDEMPOTENCE below).
--
--   D1 (edge):  wrangler d1 execute <db> --remote --file=deploy/relax-context-session-d1.sql
--
-- WHY A FILE AND NOT BOOT DDL. Chat lets you talk to a document with no context, so
-- context_id and context_version became nullable. `ADD COLUMN` cannot express "may now be
-- null" and SQLite has no `ALTER COLUMN`, so the only route is a table rebuild. Postgres says
-- it directly and rides the normal deploy (`ALTER ... DROP NOT NULL` in PG_SCHEMA_STATEMENTS);
-- the self-host SQLite driver runs the same rebuild guarded at boot (packages/db/src/sqlite.ts,
-- which can switch `PRAGMA foreign_keys` off and wrap the whole thing in one transaction).
-- D1 can do neither, and this file is shaped around exactly that.
--
-- WHAT D1 CANNOT DO, AND WHY THE OBVIOUS VERSION OF THIS FILE COULD NEVER RUN.
--
--   1. NO `BEGIN` / `COMMIT`. D1 rejects explicit transaction control inside an executed
--      file. Every statement below therefore stands alone, and each one leaves the database
--      consistent by itself — there is no point at which a half-applied file has a broken
--      foreign key.
--
--   2. FOREIGN KEYS CANNOT BE TURNED OFF. `PRAGMA defer_foreign_keys` only DEFERS the check
--      to commit; it does not disable enforcement. That is the trap the first version fell
--      into: `DROP TABLE context_session` performs an implicit delete, and with any
--      `session_message` row present that orphans every one of them and bumps the deferred
--      violation counter. Re-creating the parent afterwards (renaming `context_session__new`
--      into place) does NOT clear that counter — SQLite decrements it only when a matching
--      parent row is inserted against the live constraint — so the commit failed with
--      FOREIGN KEY constraint failed on any database that had ever held one chat message.
--      Which is every database that has ever been used.
--
-- THE SHAPE THAT WORKS: park the children, rebuild the parent, put the children back. No
-- pragma, no transaction, and no `ALTER TABLE ... RENAME` (whose schema re-parse is its own
-- failure mode — see the narrowed catch in packages/db/src/sqlite.ts). No statement ever
-- leaves a foreign key violated at its own end, so this behaves identically whether D1 runs
-- the file as one batch or statement by statement.
--
-- ORPHANS ARE PRESERVED, NOT DROPPED. A session whose context was deleted cannot be copied
-- back under `context_id REFERENCES context(id)`, and deleting the row would be silent data
-- loss. Since the whole point of this migration is that context_id may now be NULL, an orphan
-- is relaxed into a contextless session instead: the row survives, its transcript survives,
-- and it lands in exactly the shape chat sessions already have.
--
-- IDEMPOTENCE. Safe to run twice: the hold tables are dropped first if they exist, and the
-- rebuild lands on the same final shape whether or not the constraint was still there. (The
-- previous version failed on a second run, at `ALTER TABLE ... RENAME` onto an existing
-- name.) To check whether it is needed at all:
--   wrangler d1 execute <db> --remote --command "SELECT sql FROM sqlite_master WHERE name='context_session'"
-- and skip it if context_id already lacks NOT NULL.
--
-- VERIFIED by running this exact file against a real SQLite database seeded from
-- deploy/d1-schema.sql — with sessions, session_message rows and an orphaned session — in
-- apps/api/test/relax-context-session-d1.test.ts, which asserts every row survives.

-- 1. Clear any leftovers from an interrupted earlier attempt.
DROP TABLE IF EXISTS context_session__hold;
DROP TABLE IF EXISTS session_message__hold;
DROP TABLE IF EXISTS context_session__new;

-- 2. Park both tables' rows in plain, constraint-free copies. `CREATE TABLE ... AS SELECT`
--    carries the data and the column names and none of the keys, which is what makes step 3
--    safe.
CREATE TABLE context_session__hold AS SELECT * FROM context_session;
CREATE TABLE session_message__hold AS SELECT * FROM session_message;

-- 3. Empty the child. Nothing references session_message, so this violates nothing — and it
--    is what lets the parent be dropped without orphaning anything. The rows are in the hold
--    table and come back in step 7.
DELETE FROM session_message;

-- 4. Drop the old parent. No children remain, so there is no implicit-delete violation and
--    nothing deferred to fail later.
DROP TABLE context_session;

-- 5. Re-create it in the RELAXED shape — identical to deploy/d1-schema.sql, so a migrated
--    database and a fresh one are indistinguishable afterwards.
CREATE TABLE context_session (
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

-- 6. Copy the sessions back. Columns are listed explicitly so a column added later cannot
--    silently shift positions. The CASE is the orphan handling described above: a context_id
--    pointing at a context that no longer exists becomes NULL rather than failing the insert
--    or losing the row.
INSERT INTO context_session (
  id, context_id, org_id, asker_id, context_version, state,
  created_at, updated_at, started_at, lease_until, result_artifact_id, dedupe_key, subject_ref
)
SELECT
  id,
  CASE WHEN context_id IN (SELECT id FROM context) THEN context_id ELSE NULL END,
  org_id, asker_id, context_version, state,
  created_at, updated_at, started_at, lease_until, result_artifact_id, dedupe_key, subject_ref
FROM context_session__hold;

-- 7. Put the messages back. Their parents exist again, so the foreign key is satisfied. A
--    message whose session was ALREADY missing before this migration stays out: it was
--    unreachable then, and re-inserting it would fail the constraint.
INSERT INTO session_message (id, session_id, author_kind, author_id, body_md, meta, created_at)
SELECT id, session_id, author_kind, author_id, body_md, meta, created_at
FROM session_message__hold
WHERE session_id IN (SELECT id FROM context_session);

-- 8. Indexes, matching deploy/d1-schema.sql exactly. They went with the dropped table.
CREATE INDEX IF NOT EXISTS context_session_queue ON context_session (context_id, state, created_at);
CREATE INDEX IF NOT EXISTS context_session_asker ON context_session (asker_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS context_session_dedupe
  ON context_session (context_id, asker_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('open','working');

-- 9. Clean up.
DROP TABLE context_session__hold;
DROP TABLE session_message__hold;
