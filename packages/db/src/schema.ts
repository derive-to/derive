/** One SQL schema, run verbatim by every driver (SQLite, D1, and Postgres). */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS artifact (
    id TEXT PRIMARY KEY,
    short_id TEXT NOT NULL UNIQUE,
    org_id TEXT NOT NULL DEFAULT 'local',
    slug TEXT,
    title TEXT,
    visibility TEXT NOT NULL DEFAULT 'link',
    kind TEXT NOT NULL,
    spa INTEGER NOT NULL DEFAULT 0,
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS version (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    n INTEGER NOT NULL,
    blob_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    author TEXT NOT NULL,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (artifact_id, n)
  )`,
  // Created up front so migrations stay forward-only.
  `CREATE TABLE IF NOT EXISTS comment (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    thread_id TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    path TEXT,
    anchor TEXT,
    body_md TEXT NOT NULL,
    author TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS principal (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT,
    kind TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS acl (
    artifact_id TEXT PRIMARY KEY REFERENCES artifact(id),
    visibility TEXT NOT NULL,
    password_hash TEXT,
    org_gate TEXT
  )`,
]
