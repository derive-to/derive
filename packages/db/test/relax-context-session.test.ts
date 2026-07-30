import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { SqliteMetaStore } from "../src/sqlite"

// THE RELAXATION MIGRATION — the one piece of this change that touches existing data.
//
// `ADD COLUMN` cannot say "may now be null" and SQLite has no ALTER COLUMN, so the only way
// is a table rebuild. A rebuild is destructive if it goes wrong, so this proves the three
// things that actually matter: the constraint is gone, EXISTING ROWS SURVIVE INTACT, and a
// second boot does not rebuild again.

/** A database shaped like one deployed BEFORE chat: context_id/context_version NOT NULL. */
const legacyDb = (dir: string) => {
  const path = join(dir, "legacy.sqlite")
  const raw = new Database(path)
  raw.exec(`CREATE TABLE context_session (
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
    dedupe_key TEXT
  )`)
  raw
    .prepare(
      `INSERT INTO context_session (id, context_id, org_id, asker_id, context_version, state, created_at, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("ses_old", "ctx_1", "default", "u-ed", 3, "answered", "2026-01-01T00:00:00.000Z", "k1")
  raw.close()
  return path
}

const info = (path: string) => {
  const raw = new Database(path)
  const cols = raw.pragma("table_info(context_session)") as { name: string; notnull: number }[]
  const rows = raw.prepare("SELECT * FROM context_session").all() as Record<string, unknown>[]
  raw.close()
  return { cols, rows }
}

describe("relaxing context_session on an existing database", () => {
  it("drops the NOT NULL, keeps every row, and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relax-"))
    const path = legacyDb(dir)

    // Before: the old shape, with a row in it.
    const before = info(path)
    expect(before.cols.find((c) => c.name === "context_id")?.notnull).toBe(1)
    expect(before.rows).toHaveLength(1)

    // Booting the store runs the migration.
    const store = new SqliteMetaStore(path)
    const after = info(path)
    expect(after.cols.find((c) => c.name === "context_id")?.notnull).toBe(0)
    expect(after.cols.find((c) => c.name === "context_version")?.notnull).toBe(0)
    // The new column came along, and the pre-existing row is untouched — same id, same
    // context, same version, same dedupe key. A rebuild that loses data is the failure
    // mode worth testing for.
    expect(after.cols.some((c) => c.name === "subject_ref")).toBe(true)
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0]).toMatchObject({
      id: "ses_old",
      context_id: "ctx_1",
      org_id: "default",
      asker_id: "u-ed",
      context_version: 3,
      state: "answered",
      dedupe_key: "k1",
    })
    ;(store as unknown as { close(): void }).close()

    // A SECOND boot must not rebuild again (the pragma guard), and must not lose the row.
    const store2 = new SqliteMetaStore(path)
    const twice = info(path)
    expect(twice.rows).toHaveLength(1)
    expect(twice.cols.find((c) => c.name === "context_id")?.notnull).toBe(0)
    ;(store2 as unknown as { close(): void }).close()
  })

  it("a contextless session can actually be written after the relax", async () => {
    // The point of the whole migration: this INSERT is what the old constraint rejected.
    const dir = mkdtempSync(join(tmpdir(), "relax2-"))
    const path = legacyDb(dir)
    const store = new SqliteMetaStore(path)
    const s = await store.createSession({
      id: "ses_chat",
      context_id: null,
      context_version: null,
      org_id: "default",
      asker_id: "u-ed",
      subject_ref: JSON.stringify({ kind: "artifact", id: "doc1", mode: "publish" }),
    })
    expect(s.context_id).toBeNull()
    expect(s.subject_ref).toContain("doc1")
    ;(store as unknown as { close(): void }).close()
  })
})
