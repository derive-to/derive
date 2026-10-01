-- One-shot removal of the tables the agents release retired, for POSTGRES. Self-host SQLite
-- and D1 use deploy/drop-agents-retired-sqlite.sql instead (D1 rejects BEGIN / COMMIT, and
-- SQLite has no DROP COLUMN IF EXISTS).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/drop-agents-retired.sql
--
-- WHEN. Run it ONCE per existing database, AFTER deploying code at this revision: that is the
-- deploy that stops creating and reading these tables. An older build re-creates them at boot,
-- so running this first only buys you empty tables back. If the database ever held Contexts,
-- automations or stored model credentials, run scripts/agents-cutover.sql with -v apply=1
-- BEFORE this: the cutover reads these tables to carry their data into agents, schedules and
-- model accounts, and this script deletes that data for good. Take a backup first.
--
-- WHAT. Agents, jobs, schedules and model accounts replaced every table below; nothing in the
-- application has read or written them since. Each one goes with its indexes. `principal` is
-- a placeholder table nothing ever queried. The two agent columns (hosted, runs_seen_at)
-- belonged to hosted runs and the old run claim; agent.managed stays, because imported papers
-- still use it.
--
-- The boot DDL is additive-only (see scripts/check-schema.mjs), so this deliberate,
-- separately-reviewed drop lives here instead of the schema sources. One transaction: either
-- every drop lands or none does. Safe to re-run: every statement is IF EXISTS.

BEGIN;

-- Children before parents: these four reference context_session or workflow_run.
DROP TABLE IF EXISTS session_message;
DROP TABLE IF EXISTS context_session;
DROP TABLE IF EXISTS workflow_publish_receipt;
DROP TABLE IF EXISTS workflow_artifact_activity;
DROP TABLE IF EXISTS workflow_step_attempt;
DROP TABLE IF EXISTS workflow_run;

-- No foreign keys between the rest.
DROP TABLE IF EXISTS run_attempt;
DROP TABLE IF EXISTS run;
DROP TABLE IF EXISTS automation;
DROP TABLE IF EXISTS context_runtime;
DROP TABLE IF EXISTS runtime_setup;
DROP TABLE IF EXISTS runtime_owner;
DROP TABLE IF EXISTS runtime_model_binding;
DROP TABLE IF EXISTS runtime_model_connection;
DROP TABLE IF EXISTS workflow_files;
DROP TABLE IF EXISTS workflow_draft;
DROP TABLE IF EXISTS workflow_test;
DROP TABLE IF EXISTS model_credential;
DROP TABLE IF EXISTS principal;

ALTER TABLE agent DROP COLUMN IF EXISTS hosted;
ALTER TABLE agent DROP COLUMN IF EXISTS runs_seen_at;

COMMIT;
