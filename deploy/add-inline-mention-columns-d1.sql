-- One-time additive columns for inline mention replies on an EXISTING Cloudflare D1 database.
-- New databases already get these fields from deploy/d1-schema.sql.
--
-- Run this exactly once, BEFORE deploy/rekey-slack-thread-link-d1.sql:
--
--   wrangler d1 execute <db> --remote --file=deploy/add-inline-mention-columns-d1.sql
--
-- SQLite/D1 does not support ADD COLUMN IF NOT EXISTS. If this was already applied, do not run
-- it again; the re-key script is safe to re-run after this one-time additive step.
--
-- These defaults make every existing row retain its old meaning: legacy inbox rows are explicit
-- mentions and legacy Slack roots are channel mirrors.

ALTER TABLE agent_mention ADD COLUMN kind TEXT NOT NULL DEFAULT 'mention';

ALTER TABLE slack_thread_link ADD COLUMN surface TEXT NOT NULL DEFAULT 'channel_mirror';
ALTER TABLE slack_thread_link ADD COLUMN recipient_user_id TEXT;
ALTER TABLE slack_thread_link ADD COLUMN slack_user_id TEXT;
