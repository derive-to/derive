-- Cloudflare D1 bootstrap schema for Dock.
-- GENERATED from packages/db/src/schema.ts (SCHEMA_STATEMENTS); do not edit by hand.
-- Regenerate after a schema change: `pnpm --filter @dock/db gen:d1-schema`.
-- Apply once: `wrangler d1 execute <db> --file=deploy/d1-schema.sql`.

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL DEFAULT 'local',
  slug TEXT,
  title TEXT,
  visibility TEXT NOT NULL DEFAULT 'link',
  password_hash TEXT,
  general_role TEXT NOT NULL DEFAULT 'viewer',
  kind TEXT NOT NULL,
  spa INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  current_version INTEGER NOT NULL DEFAULT 0,
  current_content_type TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  removed_at TEXT,
  source_path TEXT,
  author_name TEXT,
  author_login TEXT,
  author_avatar TEXT,
  author_gh_id TEXT
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
  message TEXT,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (artifact_id, n),
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

CREATE TABLE IF NOT EXISTS artifact_favorite (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (artifact_id, user_id),
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS collection_item (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS repo_source (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'local',
  collection_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT 'HEAD',
  includes TEXT NOT NULL,
  token TEXT,
  installation_id TEXT,
  files TEXT NOT NULL DEFAULT '{}',
  last_synced_at TEXT,
  last_status TEXT,
  progress TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (collection_id) REFERENCES collection(id)
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
  base_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  decided_by TEXT,
  decided_version INTEGER,
  decision_note TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (artifact_id) REFERENCES artifact(id)
);

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

CREATE TABLE IF NOT EXISTS principal (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT,
    kind TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

CREATE TABLE IF NOT EXISTS acl (
    artifact_id TEXT PRIMARY KEY REFERENCES artifact(id),
    visibility TEXT NOT NULL,
    password_hash TEXT,
    org_gate TEXT
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

CREATE INDEX IF NOT EXISTS notification_user_time ON notification (user_id, created_at);

CREATE INDEX IF NOT EXISTS agent_mention_inbox ON agent_mention (agent_id, state, created_at);

CREATE INDEX IF NOT EXISTS favorite_user ON artifact_favorite (user_id);

CREATE INDEX IF NOT EXISTS tag_name ON artifact_tag (tag);

CREATE INDEX IF NOT EXISTS collection_item_artifact ON collection_item (artifact_id);

CREATE INDEX IF NOT EXISTS collection_member_user ON collection_member (user_id);

CREATE INDEX IF NOT EXISTS repo_source_org ON repo_source (org_id);

CREATE INDEX IF NOT EXISTS domain_artifact ON domain (artifact_id);

CREATE INDEX IF NOT EXISTS proposal_artifact_state ON proposal (artifact_id, state);

CREATE INDEX IF NOT EXISTS report_state ON report (state, created_at);

CREATE INDEX IF NOT EXISTS audit_artifact ON audit_log (artifact_id, created_at);
