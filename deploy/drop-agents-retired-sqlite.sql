-- One-shot removal of the tables the agents release retired, for SELF-HOST SQLITE and D1.
-- Postgres uses deploy/drop-agents-retired.sql instead.
--
--   self-host SQLite:  sqlite3 -bail <data-dir>/derive.db < deploy/drop-agents-retired-sqlite.sql
--   D1 (edge):         wrangler d1 execute <db> --remote --file=deploy/drop-agents-retired-sqlite.sql
--
-- WHEN. Run it ONCE per existing database, AFTER deploying code at this revision: that is the
-- deploy that stops creating and reading these tables. Stop the self-host server first (a live
-- server can hold the WAL lock and stop the script part way). It is not re-runnable once the
-- agent columns are gone. Do not leave it unrun: until it runs, deleting a Context that has old
-- sessions fails on the context_session foreign key, and old encrypted model credentials
-- outlive account deletion. Nothing carries SQLite or D1 data into
-- the agent model automatically, so recreate whatever you still need by hand BEFORE this (see
-- the upgrade note in the self-hosting quickstart): this script deletes that data for good.
-- Take a backup first.
--
-- WHAT. Agents, jobs, schedules and model accounts replaced every table below; nothing in the
-- application has read or written them since. Each one goes with its indexes. `principal` is
-- a placeholder table nothing ever queried. The two agent columns (hosted, runs_seen_at)
-- belonged to hosted runs and the old run claim; agent.managed stays, because imported papers
-- still use it.
--
-- WHY THIS SHAPE. D1 rejects BEGIN / COMMIT inside an executed file (it applies the whole file
-- as one transaction itself), so there is none here. Every statement leaves the database
-- consistent on its own: foreign keys stay on, and children go before their parents, so no
-- DROP ever orphans a row. SQLite has no DROP COLUMN IF EXISTS, so the two column drops fail
-- on a database that has already lost them. That is why this runs once; the table drops alone
-- are safe to repeat.

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

ALTER TABLE agent DROP COLUMN hosted;
ALTER TABLE agent DROP COLUMN runs_seen_at;
