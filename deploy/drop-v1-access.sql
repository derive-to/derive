-- One-shot removal of the retired v1 access schema. Run ONCE per existing
-- database (new databases never create these). The boot DDL is additive-only
-- (see scripts/check-schema.mjs), so this deliberate, separately-reviewed drop
-- lives here instead of the schema sources.
--
--   self-host SQLite:  sqlite3 <data-dir>/derive.db < deploy/drop-v1-access.sql
--   D1 (edge):         wrangler d1 execute <db> --remote --file=deploy/drop-v1-access.sql
--   Postgres (hosted): psql "$DATABASE_URL" -f deploy/drop-v1-access.sql
--
-- Step 1 — safety net for an instance jumping straight from a pre-v2 build to a
-- post-cleanup one: fold any never-backfilled v1 values into the v2 fields (the
-- exact mapping the retired boot backfill applied; every instance that booted a
-- v2 build has already run it, making this a no-op). Includes the pre-collapse
-- vocabulary (link/password → public, unlisted → private).
UPDATE artifact SET
  workspace_access = CASE WHEN visibility IN ('org','public','link','password') THEN 'member' ELSE 'none' END,
  listed = CASE WHEN visibility IN ('public','link','password') THEN 'public' WHEN visibility = 'org' THEN 'workspace' ELSE 'none' END,
  link_role = CASE WHEN visibility IN ('public','link','password') THEN general_role ELSE 'none' END
  WHERE visibility != 'private';

-- Step 2 — drop the dead weight: the acl placeholder (zero query sites; its
-- password_hash was never the live one — that's artifact.password_hash, untouched)
-- and the two backfilled columns (read by nothing since the v2 access model).
DROP TABLE IF EXISTS acl;
ALTER TABLE artifact DROP COLUMN visibility;
ALTER TABLE artifact DROP COLUMN general_role;
