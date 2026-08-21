-- One-shot cleanup for databases that predate this schema: review_round rows in
-- the `approved` state and the artifact.approved_version column, neither of which
-- the application reads or writes. Run ONCE per existing database, AFTER deploying
-- code at this revision. The boot DDL is additive-only (see
-- scripts/check-schema.mjs), so this deliberate, separately-reviewed drop lives
-- here instead of the schema sources.
--
--   self-host SQLite:  sqlite3 <data-dir>/derive.db < deploy/drop-approved-version.sql
--   D1 (edge):         wrangler d1 execute <db> --remote --file=deploy/drop-approved-version.sql
--   Postgres (hosted): psql "$DATABASE_URL" -f deploy/drop-approved-version.sql

-- Step 1 — normalize persisted state: a round stored as `approved` reads as
-- `sent_back` (the decision it recorded — "good, ship it" — is exactly what a
-- sent-back note says, and resolved_by/resolved_at keep the audit trail).
UPDATE review_round SET state = 'sent_back' WHERE state = 'approved';

-- Step 2 — drop the column nothing reads.
ALTER TABLE artifact DROP COLUMN approved_version;
