-- One-shot cleanup for databases that predate this schema: the proposal table and
-- the `addressed` comment state its rows minted. Run ONCE per existing database,
-- AFTER deploying code at this revision (new databases never create the table).
-- The boot DDL is additive-only (see scripts/check-schema.mjs), so this
-- deliberate, separately-reviewed drop lives here instead of the schema sources.
--
--   self-host SQLite:  sqlite3 <data-dir>/derive.db < deploy/drop-proposals.sql
--   D1 (edge):         wrangler d1 execute <db> --remote --file=deploy/drop-proposals.sql
--   Postgres (hosted): psql "$DATABASE_URL" -f deploy/drop-proposals.sql

-- Step 1 — normalize persisted state: a comment thread stored as `addressed` reads
-- as `open` again. The feedback is still live, and `addressed` is not a state the
-- application reads or writes.
UPDATE comment SET state = 'open' WHERE state = 'addressed';

-- Step 2 — drop the table nothing reads.
DROP TABLE IF EXISTS proposal;
