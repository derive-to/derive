-- One-time additive columns for an agent's harness effort and machine, on an EXISTING
-- Cloudflare D1 database. New databases get them from deploy/d1-schema.sql; Postgres and
-- self-host SQLite add them at boot.
--
--   wrangler d1 execute <db> --remote --file=deploy/add-agent-machine-columns-d1.sql
--
-- SQLite/D1 has no ADD COLUMN IF NOT EXISTS: run it once.
ALTER TABLE agent ADD COLUMN effort TEXT;
ALTER TABLE agent ADD COLUMN sandbox_json TEXT;
-- Tasks on one agent can each hold their own sandbox (safe to re-run).
DROP INDEX IF EXISTS job_machine_holder;
