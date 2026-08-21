-- One-shot removal of the retired proposal system. Run ONCE per existing database,
-- AFTER the code that stops reading/writing proposals is deployed (new databases
-- never create the table). The boot DDL is additive-only (see
-- scripts/check-schema.mjs), so this deliberate, separately-reviewed drop lives
-- here instead of the schema sources.
--
--   self-host SQLite:  sqlite3 <data-dir>/derive.db < deploy/drop-proposals.sql
--   D1 (edge):         wrangler d1 execute <db> --remote --file=deploy/drop-proposals.sql
--   Postgres (hosted): psql "$DATABASE_URL" -f deploy/drop-proposals.sql

-- Step 1 — normalize persisted state the retired system minted: a comment thread
-- left `addressed` (a proposal claimed to fix it) reads as `open` again — the
-- feedback is still live, and no reader emits or understands `addressed` any more.
UPDATE comment SET state = 'open' WHERE state = 'addressed';

-- Step 2 — drop the dead weight.
DROP TABLE IF EXISTS proposal;
