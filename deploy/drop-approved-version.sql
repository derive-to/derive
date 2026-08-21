-- One-shot removal of the retired approval machinery's storage. Run ONCE per
-- existing database, AFTER the code that stops reading/writing it is deployed.
-- The boot DDL is additive-only (see scripts/check-schema.mjs), so this
-- deliberate, separately-reviewed drop lives here instead of the schema sources.
--
--   self-host SQLite:  sqlite3 <data-dir>/derive.db < deploy/drop-approved-version.sql
--   D1 (edge):         wrangler d1 execute <db> --remote --file=deploy/drop-approved-version.sql
--   Postgres (hosted): psql "$DATABASE_URL" -f deploy/drop-approved-version.sql

-- Step 1 — normalize persisted state: a round left `approved` reads as `sent_back`
-- (the decision it recorded — "good, ship it" — is exactly what a sent-back note
-- says now, and resolved_by/resolved_at keep the audit trail).
UPDATE review_round SET state = 'sent_back' WHERE state = 'approved';

-- Step 2 — drop the retired pointer.
ALTER TABLE artifact DROP COLUMN approved_version;
