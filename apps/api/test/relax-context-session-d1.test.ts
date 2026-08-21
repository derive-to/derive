import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

// deploy/relax-context-session-d1.sql, RUN. Not read, not eyeballed — executed against a real
// SQLite database seeded with the real pre-relaxation schema and real rows.
//
// The previous version of that file could not run anywhere, for two reasons that only a real
// execution surfaces:
//
//   - it used BEGIN / COMMIT, which D1 rejects inside an executed file; and
//   - `PRAGMA defer_foreign_keys` DEFERS the foreign-key check rather than disabling it, so
//     `DROP TABLE context_session` orphaned every `session_message` row and the commit failed —
//     on any database that had ever held a single chat message, i.e. every database in use.
//
// Both are invisible to review and both are caught by one honest execution, so this test runs
// the file exactly as an operator does: whole file, statement after statement, foreign keys ON
// (SQLite's `exec` autocommits each statement, which is the strictest reading of how D1 might
// apply it — a version that only works inside one big transaction fails here).

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../deploy/relax-context-session-d1.sql", import.meta.url)),
  "utf8",
)

/** The PRE-relaxation shape: context_id and context_version still NOT NULL. This is what an
 *  existing D1 database actually looks like, and the thing the migration has to move off. The
 *  rest is copied from deploy/d1-schema.sql, including session_message's foreign key — which is
 *  the whole difficulty. */
const LEGACY_SCHEMA = `
CREATE TABLE context (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE context_session (
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
  subject_ref TEXT,
  FOREIGN KEY (context_id) REFERENCES context(id)
);
CREATE INDEX context_session_queue ON context_session (context_id, state, created_at);
CREATE INDEX context_session_asker ON context_session (asker_id, created_at);
CREATE UNIQUE INDEX context_session_dedupe
  ON context_session (context_id, asker_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('open','working');
CREATE TABLE session_message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body_md TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (session_id) REFERENCES context_session(id)
);
CREATE INDEX session_message_session ON session_message (session_id, created_at);
`

/** A used database: two contexts, three sessions (one of them ORPHANED — its context was
 *  deleted, which the old FK tolerated only because it was inserted before the delete), and
 *  session_message rows hanging off two of them. */
const seed = () => {
  const db = new Database(":memory:")
  db.exec(LEGACY_SCHEMA)
  db.pragma("foreign_keys = ON")
  db.exec(`
    INSERT INTO context (id, org_id, name) VALUES ('ctx_a', 'ws_1', 'Research');
    INSERT INTO context (id, org_id, name) VALUES ('ctx_gone', 'ws_1', 'Deleted later');
    INSERT INTO context_session (id, context_id, org_id, asker_id, context_version, state, dedupe_key)
      VALUES ('ses_1', 'ctx_a', 'ws_1', 'usr_1', 3, 'open', 'daily');
    INSERT INTO context_session (id, context_id, org_id, asker_id, context_version, state, subject_ref)
      VALUES ('ses_2', 'ctx_a', 'ws_1', 'usr_2', 3, 'answered', '{"kind":"artifact","id":"abc"}');
    INSERT INTO context_session (id, context_id, org_id, asker_id, context_version, state)
      VALUES ('ses_orphan', 'ctx_gone', 'ws_1', 'usr_1', 1, 'closed');
    INSERT INTO session_message (id, session_id, author_kind, author_id, body_md)
      VALUES ('sm_1', 'ses_1', 'asker', 'usr_1', 'what changed this week?');
    INSERT INTO session_message (id, session_id, author_kind, author_id, body_md, meta)
      VALUES ('sm_2', 'ses_1', 'agent', 'ag_1', 'here is the summary', '{"outcome":"answered"}');
    INSERT INTO session_message (id, session_id, author_kind, author_id, body_md)
      VALUES ('sm_3', 'ses_2', 'asker', 'usr_2', 'and the quarter?');
  `)
  // The orphan: delete the context out from under ses_orphan. Done with FKs briefly off
  // because the LEGACY schema is what allowed this state to exist in the first place (older
  // builds, a manual delete, an FK-less D1 era) — the point is that such rows are out there.
  db.pragma("foreign_keys = OFF")
  db.exec("DELETE FROM context WHERE id = 'ctx_gone'")
  db.pragma("foreign_keys = ON")
  return db
}

const columns = (db: Database.Database) =>
  db.pragma("table_info(context_session)") as { name: string; notnull: number }[]

describe("deploy/relax-context-session-d1.sql", () => {
  it("runs against a used database, with foreign keys enforced", () => {
    const db = seed()
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1)
    // Precondition: the constraint this migration exists to remove is really there, and there
    // really are child rows (the exact combination the old file died on).
    expect(columns(db).find((c) => c.name === "context_id")?.notnull).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM session_message").get() as { n: number }).n).toBe(
      3,
    )

    expect(() => db.exec(MIGRATION)).not.toThrow()

    // The relaxation landed: both columns are nullable now.
    const after = columns(db)
    expect(after.find((c) => c.name === "context_id")?.notnull).toBe(0)
    expect(after.find((c) => c.name === "context_version")?.notnull).toBe(0)
    // And foreign keys were never disabled behind our back.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1)
    expect(db.pragma("foreign_key_check", { simple: false })).toEqual([])
  })

  it("keeps every session and every message, and relaxes the orphan instead of dropping it", () => {
    const db = seed()
    db.exec(MIGRATION)

    const sessions = db
      .prepare(
        "SELECT id, context_id, org_id, asker_id, state, dedupe_key, subject_ref FROM context_session ORDER BY id",
      )
      .all() as Record<string, unknown>[]
    expect(sessions.map((s) => s.id)).toEqual(["ses_1", "ses_2", "ses_orphan"])
    // Every column survived the round trip, not merely the primary key.
    expect(sessions[0]).toMatchObject({
      context_id: "ctx_a",
      asker_id: "usr_1",
      dedupe_key: "daily",
    })
    expect(sessions[1]).toMatchObject({
      state: "answered",
      subject_ref: '{"kind":"artifact","id":"abc"}',
    })
    // THE ORPHAN. Its context is gone, so it could not be copied back under the foreign key —
    // and deleting it would be silent data loss. It becomes a contextless session, which is
    // exactly the shape this migration exists to make legal.
    expect(sessions[2]).toMatchObject({ id: "ses_orphan", context_id: null, state: "closed" })

    const messages = db
      .prepare("SELECT id, session_id, body_md, meta FROM session_message ORDER BY id")
      .all() as Record<string, unknown>[]
    expect(messages.map((m) => m.id)).toEqual(["sm_1", "sm_2", "sm_3"])
    expect(messages[1]).toMatchObject({ session_id: "ses_1", meta: '{"outcome":"answered"}' })
  })

  it("accepts a contextless session afterwards — the point of the whole exercise", () => {
    const db = seed()
    db.exec(MIGRATION)
    expect(() =>
      db
        .prepare(
          "INSERT INTO context_session (id, context_id, org_id, asker_id, context_version, subject_ref) VALUES (?, NULL, ?, ?, NULL, ?)",
        )
        .run("ses_chat", "ws_1", "usr_1", '{"kind":"artifact","id":"doc"}'),
    ).not.toThrow()
  })

  it("is idempotent: a second run is a no-op, not a failure", () => {
    const db = seed()
    db.exec(MIGRATION)
    expect(() => db.exec(MIGRATION)).not.toThrow()
    expect((db.prepare("SELECT COUNT(*) AS n FROM context_session").get() as { n: number }).n).toBe(
      3,
    )
    expect((db.prepare("SELECT COUNT(*) AS n FROM session_message").get() as { n: number }).n).toBe(
      3,
    )
    expect(columns(db).find((c) => c.name === "context_id")?.notnull).toBe(0)
  })

  it("carries no BEGIN/COMMIT — D1 rejects transaction control inside an executed file", () => {
    const statements = MIGRATION.split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n")
    expect(statements).not.toMatch(/\bBEGIN\b/i)
    expect(statements).not.toMatch(/\bCOMMIT\b/i)
    // And no PRAGMA: defer_foreign_keys was the trap (it defers, it does not disable), and
    // nothing else here needs one.
    expect(statements).not.toMatch(/\bPRAGMA\b/i)
  })
})

// deploy/rekey-slack-thread-link-d1.sql, RUN. Not read, not eyeballed — executed against a real
// SQLite database seeded with the real pre-migration schema and real rows.
//
// The sibling relaxation migration shipped a version that could not run anywhere (BEGIN/COMMIT,
// which D1 rejects; and a foreign-key trap that only fires on a populated database), and neither
// was visible to review. So this runs the file exactly as an operator does: whole file,
// statement after statement, foreign keys ON, no enclosing transaction — SQLite's `exec`
// autocommits each statement, which is the strictest reading of how D1 might apply it.
describe("deploy/rekey-slack-thread-link-d1.sql", () => {
  const MIGRATION = readFileSync(
    fileURLToPath(new URL("../../../deploy/rekey-slack-thread-link-d1.sql", import.meta.url)),
    "utf8",
  )
  const ADD_INLINE_MENTION_COLUMNS = readFileSync(
    fileURLToPath(new URL("../../../deploy/add-inline-mention-columns-d1.sql", import.meta.url)),
    "utf8",
  )

  /** The pre-inline-mentions D1 shape: a link key of UNIQUE(thread_id) and no mention kind. */
  const LEGACY_SCHEMA = `
  CREATE TABLE agent_mention (
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

  CREATE TABLE slack_thread_link (
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
  `

  const seeded = () => {
    const raw = new Database(":memory:")
    raw.pragma("foreign_keys = ON")
    raw.exec(LEGACY_SCHEMA)
    raw
      .prepare(
        `INSERT INTO slack_thread_link (id, org_id, artifact_id, thread_id, channel, message_ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("stl_1", "default", "a_1", "th_1", "C1", "1700000000.1", "2026-01-01T00:00:00.000Z")
    return raw
  }

  /** The file with its comment lines stripped — comments carry prose semicolons, so they have to
   *  go before the statements can be split. Same treatment the relaxation migration gets above. */
  const sqlOnly = (sql: string) =>
    sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n")

  /** Apply the file the way an operator does — one statement at a time, autocommitted. */
  const apply = (raw: Database.Database, sql: string) => {
    for (const stmt of sqlOnly(sql)
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean))
      raw.exec(stmt)
  }

  const applyUpgrade = (raw: Database.Database) => {
    apply(raw, ADD_INLINE_MENTION_COLUMNS)
    apply(raw, MIGRATION)
  }

  const uniques = (raw: Database.Database): string[][] =>
    (raw.pragma("index_list(slack_thread_link)") as { name: string; unique: number }[])
      .filter((i) => i.unique)
      .map((i) =>
        (raw.pragma(`index_info(${JSON.stringify(i.name)})`) as { name: string }[]).map(
          (c) => c.name,
        ),
      )

  it("runs statement-by-statement with foreign keys on, and re-keys the table", () => {
    const raw = seeded()
    expect(uniques(raw)).toContainEqual(["thread_id"])
    applyUpgrade(raw)
    const after = uniques(raw)
    expect(after).toContainEqual(["thread_id", "channel"])
    expect(after).not.toContainEqual(["thread_id"])
    expect(after).toContainEqual(["channel", "message_ts"])
    raw.close()
  })

  it("carries every existing row across", () => {
    const raw = seeded()
    applyUpgrade(raw)
    expect(raw.prepare("SELECT * FROM slack_thread_link").all()).toEqual([
      {
        id: "stl_1",
        org_id: "default",
        artifact_id: "a_1",
        thread_id: "th_1",
        channel: "C1",
        message_ts: "1700000000.1",
        surface: "channel_mirror",
        recipient_user_id: null,
        slack_user_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ])
    raw.close()
  })

  it("admits the second channel that the old constraint rejected", () => {
    const raw = seeded()
    const second = () =>
      raw
        .prepare(
          `INSERT INTO slack_thread_link (id, org_id, artifact_id, thread_id, channel, message_ts, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("stl_2", "default", "a_1", "th_1", "C2", "1700000000.2", "2026-01-02T00:00:00.000Z")
    expect(second).toThrow(/UNIQUE/i) // the bug this migration exists for
    applyUpgrade(raw)
    expect(second).not.toThrow()
    raw.close()
  })

  // D1 rejects transaction control inside an executed file, and `PRAGMA defer_foreign_keys`
  // only DEFERS the check rather than disabling it — both traps the sibling migration fell into.
  it("carries no BEGIN / COMMIT / PRAGMA", () => {
    expect(sqlOnly(MIGRATION)).not.toMatch(/\bBEGIN\b/i)
    expect(sqlOnly(MIGRATION)).not.toMatch(/\bCOMMIT\b/i)
    expect(sqlOnly(MIGRATION)).not.toMatch(/\bPRAGMA\b/i)
  })

  it("is safe to run twice", () => {
    const raw = seeded()
    applyUpgrade(raw)
    apply(raw, MIGRATION)
    expect(raw.prepare("SELECT COUNT(*) AS n FROM slack_thread_link").get()).toEqual({ n: 1 })
    expect(uniques(raw)).toContainEqual(["thread_id", "channel"])
    raw.close()
  })
})
