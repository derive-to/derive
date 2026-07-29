-- Cloudflare D1 bootstrap schema for Derive.
-- GENERATED from packages/db/src/schema.ts (SCHEMA_STATEMENTS); do not edit by hand.
-- Regenerate after a schema change: `pnpm --filter @derive/db gen:d1-schema`.
-- Apply once: `wrangler d1 execute <db> --file=deploy/d1-schema.sql`.

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL DEFAULT 'local',
  slug TEXT,
  title TEXT,
  workspace_access TEXT NOT NULL DEFAULT 'none',
  link_role TEXT NOT NULL DEFAULT 'none',
  listed TEXT NOT NULL DEFAULT 'none',
  password_hash TEXT,
  kind TEXT NOT NULL,
  spa INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  current_version INTEGER NOT NULL DEFAULT 0,
  current_content_type TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  removed_at TEXT,
  expires_at TEXT,
  first_foreign_view_at TEXT,
  public_history INTEGER,
  source_path TEXT,
  author_name TEXT,
  author_login TEXT,
  author_avatar TEXT,
  author_gh_id TEXT,
  author_id TEXT
);

CREATE TABLE IF NOT EXISTS version (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  blob_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  author TEXT NOT NULL,
  author_login TEXT,
  author_avatar TEXT,
  author_gh_id TEXT,
  author_id TEXT,
  source TEXT,
  message TEXT,
  name TEXT,
  preview_key TEXT,
  preview_status TEXT,
  preview_error TEXT,
  preview_full_key TEXT,
  preview_full_status TEXT,
  preview_full_error TEXT,
  preview_marked_key TEXT,
  preview_marked_status TEXT,
  preview_marked_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (artifact_id, n),
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE TABLE IF NOT EXISTS version_data (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  slot TEXT NOT NULL,
  json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  gen INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (artifact_id, n, slot),
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE TABLE IF NOT EXISTS comment (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  path TEXT,
  anchor TEXT,
  body_md TEXT NOT NULL,
  author TEXT NOT NULL,
  author_id TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  meta TEXT,
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE TABLE IF NOT EXISTS webhook (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  artifact_id TEXT,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'generic',
  events TEXT NOT NULL DEFAULT '*',
  label TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE TABLE IF NOT EXISTS webhook_delivery (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS render_job (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version_n INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS membership (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS artifact_member (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (artifact_id, user_id),
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE TABLE IF NOT EXISTS notification (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_short_id TEXT NOT NULL,
  artifact_title TEXT,
  thread_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  preview TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agent (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'commenter',
  created_by TEXT,
  hosted INTEGER NOT NULL DEFAULT 0,
  managed INTEGER NOT NULL DEFAULT 0,
  runs_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (token),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS agent_mention (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_short_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS automation (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  instruction TEXT NOT NULL,
  refs TEXT,
  connection_ids TEXT,
  context_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  automation_id TEXT,
  agent_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  initiated_by TEXT,
  status TEXT NOT NULL,
  scheduled_for TEXT,
  started_at TEXT,
  finished_at TEXT,
  cost_micro_usd INTEGER,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS plan (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  limits TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS connection (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'personal',
  kind TEXT NOT NULL DEFAULT 'oauth',
  secret_enc TEXT,
  base_url TEXT,
  broker TEXT NOT NULL,
  toolkit TEXT NOT NULL,
  broker_ref TEXT NOT NULL,
  scopes_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS invitation (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  token TEXT NOT NULL,
  invited_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS invitation_org_email ON invitation (org_id, email);

CREATE TABLE IF NOT EXISTS artifact_invite (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'commenter',
  token TEXT NOT NULL,
  invited_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS artifact_invite_artifact_email ON artifact_invite (artifact_id, email);

CREATE TABLE IF NOT EXISTS beta_signup (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS signup_attribution (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_artifact TEXT,
  landing_path TEXT,
  referrer TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS oauth_client_workspace (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, client_id, org_id)
);

CREATE TABLE IF NOT EXISTS artifact_favorite (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (artifact_id, user_id),
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE TABLE IF NOT EXISTS follow (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, org_id, kind, target)
);

CREATE TABLE IF NOT EXISTS artifact_tag (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (artifact_id, tag),
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE TABLE IF NOT EXISTS collection (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  workspace_access TEXT NOT NULL DEFAULT 'member',
  folder_id TEXT
);

CREATE TABLE IF NOT EXISTS collection_item (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  folder_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (collection_id, artifact_id),
  FOREIGN KEY (collection_id) REFERENCES collection(id),
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE TABLE IF NOT EXISTS collection_member (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (collection_id, user_id),
  FOREIGN KEY (collection_id) REFERENCES collection(id)
);

CREATE TABLE IF NOT EXISTS folder (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  collection_id TEXT,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS repo_source (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  collection_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT 'HEAD',
  includes TEXT NOT NULL,
  token TEXT,
  installation_id TEXT,
  pr_number INTEGER,
  files TEXT NOT NULL DEFAULT '{}',
  last_synced_at TEXT,
  last_status TEXT,
  progress TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (collection_id) REFERENCES collection(id)
);

CREATE TABLE IF NOT EXISTS org_settings (
  org_id TEXT PRIMARY KEY,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS model_credential (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  secret TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, user_id, provider)
);

CREATE TABLE IF NOT EXISTS slack_install (
  org_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  team_name TEXT,
  bot_token TEXT NOT NULL,
  bot_user_id TEXT,
  default_channel TEXT,
  needs_reauth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS slack_thread_link (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (thread_id),
  UNIQUE (channel, message_ts)
);

CREATE TABLE IF NOT EXISTS slack_user_link (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (team_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS slack_user_link_user ON slack_user_link (team_id, user_id);

CREATE TABLE IF NOT EXISTS user_notification_pref (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  prefs TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS github_app (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  private_key TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS github_installation (
  installation_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  account_login TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS domain (
  host TEXT PRIMARY KEY,
  artifact_id TEXT,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'subdomain',
  status TEXT NOT NULL DEFAULT 'active',
  cf_hostname_id TEXT,
  verification TEXT,
  redirect_to TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE TABLE IF NOT EXISTS proposal (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  message TEXT,
  author TEXT NOT NULL,
  author_id TEXT,
  on_behalf_of TEXT,
  base_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  decided_by TEXT,
  decided_version INTEGER,
  decision_note TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE TABLE IF NOT EXISTS review_round (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  requested_for TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

CREATE INDEX IF NOT EXISTS review_round_artifact ON review_round (artifact_id, requested_for);

CREATE TABLE IF NOT EXISTS context (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  manifest_artifact_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  runner_seen_at TEXT,
  ask_policy TEXT NOT NULL DEFAULT 'invited',
  max_run_ms INTEGER,
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  connection_ids TEXT,
  config TEXT,
  UNIQUE (org_id, name),
  FOREIGN KEY (manifest_artifact_id) REFERENCES artifact(id)
);

CREATE TABLE IF NOT EXISTS context_asker (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (context_id, user_id),
  FOREIGN KEY (context_id) REFERENCES context(id)
);

CREATE TABLE IF NOT EXISTS context_session (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  asker_id TEXT NOT NULL,
  context_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  started_at TEXT,
  lease_until TEXT,
  result_artifact_id TEXT,
  dedupe_key TEXT,
  FOREIGN KEY (context_id) REFERENCES context(id)
);

CREATE INDEX IF NOT EXISTS context_session_queue ON context_session (context_id, state, created_at);

CREATE INDEX IF NOT EXISTS context_session_asker ON context_session (asker_id, created_at);

CREATE TABLE IF NOT EXISTS session_message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body_md TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (session_id) REFERENCES context_session(id)
);

CREATE INDEX IF NOT EXISTS session_message_session ON session_message (session_id, created_at);

CREATE TABLE IF NOT EXISTS report (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  artifact_id TEXT NOT NULL,
  artifact_short_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  reporter TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  action TEXT NOT NULL,
  artifact_id TEXT,
  actor TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS asset (
  hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS asset_org ON asset (org_id);

CREATE TABLE IF NOT EXISTS principal (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT,
    kind TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

CREATE TABLE IF NOT EXISTS view (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    version INTEGER NOT NULL,
    viewer TEXT NOT NULL,
    viewer_kind TEXT NOT NULL DEFAULT 'anon',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

CREATE INDEX IF NOT EXISTS artifact_org_created ON artifact (org_id, created_at, id);

CREATE INDEX IF NOT EXISTS view_artifact_time ON view (artifact_id, created_at);

CREATE INDEX IF NOT EXISTS delivery_due ON webhook_delivery (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS render_job_due ON render_job (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS notification_user_time ON notification (user_id, created_at);

CREATE INDEX IF NOT EXISTS agent_mention_inbox ON agent_mention (agent_id, state, created_at);

CREATE INDEX IF NOT EXISTS favorite_user ON artifact_favorite (user_id);

CREATE INDEX IF NOT EXISTS artifact_member_by_user ON artifact_member (user_id);

CREATE INDEX IF NOT EXISTS tag_name ON artifact_tag (tag);

CREATE INDEX IF NOT EXISTS collection_item_artifact ON collection_item (artifact_id);

CREATE INDEX IF NOT EXISTS collection_member_user ON collection_member (user_id);

CREATE INDEX IF NOT EXISTS repo_source_org ON repo_source (org_id);

CREATE INDEX IF NOT EXISTS domain_artifact ON domain (artifact_id);

CREATE INDEX IF NOT EXISTS proposal_artifact_state ON proposal (artifact_id, state);

CREATE INDEX IF NOT EXISTS comment_artifact_state ON comment (artifact_id, state);

CREATE INDEX IF NOT EXISTS report_state ON report (state, created_at);

CREATE INDEX IF NOT EXISTS audit_artifact ON audit_log (artifact_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search USING fts5(text, artifact_id UNINDEXED, org_id UNINDEXED, tokenize='unicode61 remove_diacritics 0');

CREATE UNIQUE INDEX IF NOT EXISTS context_session_dedupe ON context_session (context_id, asker_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('open', 'working');

CREATE UNIQUE INDEX IF NOT EXISTS run_schedule_occurrence ON run (automation_id, scheduled_for) WHERE reason = 'schedule' AND automation_id IS NOT NULL AND scheduled_for IS NOT NULL;
