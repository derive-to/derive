-- One-shot cleanup for databases that hold lineage to the retired built-in template
-- catalog: artifact.derived_from values of the form `derive://templates/<id>`, which
-- the application no longer resolves (it reads them as an artifact id, finds nothing,
-- and serves the row as underived). Run ONCE per existing database, AFTER deploying
-- code at this revision. derive.to had no such rows; a self-hosted install may.
--
--   self-host SQLite:  sqlite3 <data-dir>/derive.db < deploy/drop-built-in-template-lineage.sql
--   D1 (edge):         wrangler d1 execute <db> --remote --file=deploy/drop-built-in-template-lineage.sql
--   Postgres (hosted): psql "$DATABASE_URL" -f deploy/drop-built-in-template-lineage.sql

UPDATE artifact SET derived_from = NULL WHERE derived_from LIKE 'derive://templates/%';
