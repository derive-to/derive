import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

// The hand-run deploy/*.sql files for SQLite and D1, RUN. Not read, not eyeballed: each one is
// executed against a real SQLite database seeded with real rows, the way an operator applies it
// (statement after statement, foreign keys ON, no enclosing transaction; SQLite's `exec`
// autocommits each statement, which is the strictest reading of how D1 applies a file).
//
// That is what catches the traps review cannot: D1 rejects BEGIN / COMMIT inside an executed
// file, and it enforces foreign keys with no way to turn them off, so a parent dropped before
// its child table fails on any database that ever held a row.

const readDeploy = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../deploy/${name}`, import.meta.url)), "utf8")

/** A file with its comment lines stripped: comments carry prose semicolons, so they have to go
 *  before the statements can be split. */
const sqlOnly = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")

/** Apply a file the way an operator does: one statement at a time, autocommitted. */
const apply = (raw: Database.Database, sql: string) => {
  for (const stmt of sqlOnly(sql)
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean))
    raw.exec(stmt)
}

describe("deploy/drop-agents-retired-sqlite.sql", () => {
  const DROP = readDeploy("drop-agents-retired-sqlite.sql")

  // Every table the agents release retired. The drop script must remove exactly these.
  const RETIRED = [
    "automation",
    "context_runtime",
    "context_session",
    "model_credential",
    "principal",
    "run",
    "run_attempt",
    "runtime_model_binding",
    "runtime_model_connection",
    "runtime_owner",
    "runtime_setup",
    "session_message",
    "workflow_artifact_activity",
    "workflow_draft",
    "workflow_files",
    "workflow_publish_receipt",
    "workflow_run",
    "workflow_step_attempt",
    "workflow_test",
  ]

  /** The retired tables as an upgraded database still has them. Every foreign key between them
   *  (and into `context`) is the real one; the other columns are trimmed to what the test uses. */
  const LEGACY = `
  CREATE TABLE context_session (
    id TEXT PRIMARY KEY,
    context_id TEXT,
    org_id TEXT NOT NULL,
    asker_id TEXT NOT NULL,
    FOREIGN KEY (context_id) REFERENCES context(id)
  );
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    body_md TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES context_session(id)
  );
  CREATE TABLE workflow_run (id TEXT PRIMARY KEY, org_id TEXT NOT NULL);
  CREATE TABLE workflow_step_attempt (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL,
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_run(id)
  );
  CREATE TABLE workflow_publish_receipt (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL,
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_run(id) ON DELETE CASCADE
  );
  CREATE TABLE workflow_artifact_activity (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL,
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_run(id)
  );
  CREATE TABLE automation (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL);
  CREATE TABLE run (id TEXT PRIMARY KEY, automation_id TEXT);
  CREATE UNIQUE INDEX run_schedule_occurrence ON run (automation_id) WHERE automation_id IS NOT NULL;
  CREATE TABLE run_attempt (id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
  CREATE TABLE context_runtime (id TEXT PRIMARY KEY);
  CREATE TABLE runtime_setup (id TEXT PRIMARY KEY);
  CREATE TABLE runtime_owner (context_id TEXT PRIMARY KEY);
  CREATE TABLE runtime_model_binding (context_id TEXT PRIMARY KEY);
  CREATE TABLE runtime_model_connection (id TEXT PRIMARY KEY);
  CREATE TABLE workflow_files (context_id TEXT PRIMARY KEY);
  CREATE TABLE workflow_draft (context_id TEXT PRIMARY KEY);
  CREATE TABLE workflow_test (id TEXT PRIMARY KEY, context_id TEXT NOT NULL);
  CREATE TABLE model_credential (id TEXT PRIMARY KEY, secret TEXT NOT NULL);
  CREATE TABLE principal (id TEXT PRIMARY KEY, org_id TEXT NOT NULL);
  ALTER TABLE agent ADD COLUMN hosted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE agent ADD COLUMN runs_seen_at TEXT;
  `

  /** A used database: today's schema plus the retired tables, with rows in both, including
   *  child rows under every foreign key the drop has to get past. */
  const seeded = () => {
    const raw = new Database(":memory:")
    raw.pragma("foreign_keys = ON")
    raw.exec(readDeploy("d1-schema.sql"))
    raw.exec(LEGACY)
    raw.exec(`
      INSERT INTO agent (id, org_id, name, token, managed, hosted, runs_seen_at)
        VALUES ('ag_1', 'ws_1', 'Paper', 'tok', 1, 1, '2026-09-01T00:00:00.000Z');
      INSERT INTO artifact (id, short_id, org_id, kind) VALUES ('a_1', 'abc', 'ws_1', 'doc');
      INSERT INTO context (id, org_id, name, agent_id, manifest_artifact_id, created_by)
        VALUES ('ctx_1', 'ws_1', 'arXiv:2501.00001', 'ag_1', 'a_1', 'usr_1');
      INSERT INTO context_session (id, context_id, org_id, asker_id)
        VALUES ('ses_1', 'ctx_1', 'ws_1', 'usr_1');
      INSERT INTO session_message (id, session_id, body_md) VALUES ('sm_1', 'ses_1', 'q');
      INSERT INTO workflow_run (id, org_id) VALUES ('wfr_1', 'ws_1');
      INSERT INTO workflow_step_attempt (id, workflow_run_id) VALUES ('wsa_1', 'wfr_1');
      INSERT INTO workflow_publish_receipt (id, workflow_run_id) VALUES ('wpr_1', 'wfr_1');
      INSERT INTO workflow_artifact_activity (id, workflow_run_id) VALUES ('waa_1', 'wfr_1');
      INSERT INTO model_credential (id, secret) VALUES ('mc_1', 'sealed');
    `)
    return raw
  }

  const tables = (raw: Database.Database) =>
    (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((r) => r.name)
      .sort()

  it("drops every retired table on a used database, with foreign keys enforced", () => {
    const raw = seeded()
    const before = tables(raw)
    for (const t of RETIRED) expect(before).toContain(t)

    apply(raw, DROP)

    // Exactly the retired tables are gone, and nothing else went with them.
    const after = tables(raw)
    expect(before.filter((t) => !after.includes(t))).toEqual([...RETIRED].sort())
    expect(raw.pragma("foreign_keys", { simple: true })).toBe(1)
    expect(raw.pragma("foreign_key_check")).toEqual([])
    raw.close()
  })

  it("drops agent.hosted and agent.runs_seen_at, keeping the agent, its managed flag and the paper", () => {
    const raw = seeded()
    apply(raw, DROP)
    const cols = (raw.pragma("table_info(agent)") as { name: string }[]).map((c) => c.name)
    expect(cols).not.toContain("hosted")
    expect(cols).not.toContain("runs_seen_at")
    expect(raw.prepare("SELECT id, managed FROM agent").all()).toEqual([{ id: "ag_1", managed: 1 }])
    expect(raw.prepare("SELECT id FROM context").all()).toEqual([{ id: "ctx_1" }])
    raw.close()
  })

  it("is not undone by the next schema apply", () => {
    const raw = seeded()
    apply(raw, DROP)
    // Every deploy re-applies d1-schema.sql; it must not bring a retired table back.
    raw.exec(readDeploy("d1-schema.sql"))
    const after = tables(raw)
    for (const t of RETIRED) expect(after).not.toContain(t)
    raw.close()
  })

  it("carries no BEGIN / COMMIT / PRAGMA", () => {
    expect(sqlOnly(DROP)).not.toMatch(/\bBEGIN\b/i)
    expect(sqlOnly(DROP)).not.toMatch(/\bCOMMIT\b/i)
    expect(sqlOnly(DROP)).not.toMatch(/\bPRAGMA\b/i)
  })
})

describe("deploy/rekey-slack-thread-link-d1.sql", () => {
  const MIGRATION = readDeploy("rekey-slack-thread-link-d1.sql")
  const ADD_INLINE_MENTION_COLUMNS = readDeploy("add-inline-mention-columns-d1.sql")

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
  // only DEFERS the check rather than disabling it.
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
