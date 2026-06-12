// Postgres schema DDL, applied at boot (idempotent). created_at is an ISO-8601
// text column so every record shape — and its lexical sort — is identical to the
// SQLite driver. user/session/account/verification are owned by Better Auth.
const isoDefault = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

export const PG_SCHEMA_STATEMENTS: string[] = [
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
    created_at TEXT NOT NULL DEFAULT ${isoDefault}
  )`,
  `CREATE TABLE IF NOT EXISTS version (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    n INTEGER NOT NULL,
    blob_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    author TEXT NOT NULL,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT ${isoDefault},
    UNIQUE (artifact_id, n)
  )`,
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
    created_at TEXT NOT NULL DEFAULT ${isoDefault}
  )`,
  `CREATE TABLE IF NOT EXISTS principal (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT,
    kind TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL DEFAULT ${isoDefault}
  )`,
  `CREATE TABLE IF NOT EXISTS acl (
    artifact_id TEXT PRIMARY KEY REFERENCES artifact(id),
    visibility TEXT NOT NULL,
    password_hash TEXT,
    org_gate TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS view (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    version INTEGER NOT NULL,
    viewer TEXT NOT NULL,
    viewer_kind TEXT NOT NULL DEFAULT 'anon',
    created_at TEXT NOT NULL DEFAULT ${isoDefault}
  )`,
  `CREATE INDEX IF NOT EXISTS view_artifact_time ON view (artifact_id, created_at)`,
]
