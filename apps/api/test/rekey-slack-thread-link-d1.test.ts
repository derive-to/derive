import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

// deploy/rekey-slack-thread-link-d1.sql, RUN. Not read, not eyeballed — executed against a real
// SQLite database seeded with the real pre-migration schema and real rows.
//
// The sibling relaxation migration shipped a version that could not run anywhere (BEGIN/COMMIT,
// which D1 rejects; and a foreign-key trap that only fires on a populated database), and neither
// was visible to review. So this runs the file exactly as an operator does: whole file,
// statement after statement, foreign keys ON, no enclosing transaction — SQLite's `exec`
// autocommits each statement, which is the strictest reading of how D1 might apply it.

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../deploy/rekey-slack-thread-link-d1.sql", import.meta.url)),
  "utf8",
)

/** The PRE-migration shape: UNIQUE(thread_id). What an existing D1 database actually looks like. */
const LEGACY_SCHEMA = `
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
 *  go before the statements can be split. Same treatment as relax-context-session-d1.test.ts. */
const sqlOnly = MIGRATION.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n")

/** Apply the file the way an operator does — one statement at a time, autocommitted. */
const applyMigration = (raw: Database.Database) => {
  for (const stmt of sqlOnly
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean))
    raw.exec(stmt)
}

const uniques = (raw: Database.Database): string[][] =>
  (raw.pragma("index_list(slack_thread_link)") as { name: string; unique: number }[])
    .filter((i) => i.unique)
    .map((i) =>
      (raw.pragma(`index_info(${JSON.stringify(i.name)})`) as { name: string }[]).map(
        (c) => c.name,
      ),
    )

describe("deploy/rekey-slack-thread-link-d1.sql", () => {
  it("runs statement-by-statement with foreign keys on, and re-keys the table", () => {
    const raw = seeded()
    expect(uniques(raw)).toContainEqual(["thread_id"])
    applyMigration(raw)
    const after = uniques(raw)
    expect(after).toContainEqual(["thread_id", "channel"])
    expect(after).not.toContainEqual(["thread_id"])
    expect(after).toContainEqual(["channel", "message_ts"])
    raw.close()
  })

  it("carries every existing row across", () => {
    const raw = seeded()
    applyMigration(raw)
    expect(raw.prepare("SELECT * FROM slack_thread_link").all()).toEqual([
      {
        id: "stl_1",
        org_id: "default",
        artifact_id: "a_1",
        thread_id: "th_1",
        channel: "C1",
        message_ts: "1700000000.1",
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
    applyMigration(raw)
    expect(second).not.toThrow()
    raw.close()
  })

  // D1 rejects transaction control inside an executed file, and `PRAGMA defer_foreign_keys`
  // only DEFERS the check rather than disabling it — both traps the sibling migration fell into.
  it("carries no BEGIN / COMMIT / PRAGMA", () => {
    expect(sqlOnly).not.toMatch(/\bBEGIN\b/i)
    expect(sqlOnly).not.toMatch(/\bCOMMIT\b/i)
    expect(sqlOnly).not.toMatch(/\bPRAGMA\b/i)
  })

  it("is safe to run twice", () => {
    const raw = seeded()
    applyMigration(raw)
    applyMigration(raw)
    expect(raw.prepare("SELECT COUNT(*) AS n FROM slack_thread_link").get()).toEqual({ n: 1 })
    expect(uniques(raw)).toContainEqual(["thread_id", "channel"])
    raw.close()
  })
})
