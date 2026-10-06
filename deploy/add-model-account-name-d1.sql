-- One-time additive column for naming model accounts, on an EXISTING Cloudflare D1 database.
-- New databases get it from deploy/d1-schema.sql; Postgres adds it at boot.
--
--   wrangler d1 execute <db> --remote --file=deploy/add-model-account-name-d1.sql
--
-- SQLite/D1 has no ADD COLUMN IF NOT EXISTS: run it once. The retired ortam_connection_json
-- column can stay; nothing reads it.
ALTER TABLE model_account ADD COLUMN name TEXT;
