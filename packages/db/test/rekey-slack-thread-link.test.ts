import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { SqliteMetaStore } from "../src/sqlite"

// THE RE-KEY MIGRATION — the piece of this change that touches existing data.
//
// A comment thread now mirrors into every subscribed channel, so slack_thread_link is keyed
// (thread_id, channel) rather than thread_id alone. A constraint change has no additive form —
// CREATE TABLE IF NOT EXISTS is a no-op on an existing table and the generated migrations only
// ADD COLUMN — so an upgraded database would keep the old unique forever and reject the second
// channel. This proves the three things that matter: the old constraint is gone, EXISTING ROWS
// SURVIVE INTACT, and a second boot does not rebuild again.

const dir = mkdtempSync(join(tmpdir(), "derive-rekey-stl-"))

/** A database shaped like one deployed BEFORE multi-channel: UNIQUE(thread_id). */
const legacyDb = (name: string) => {
  const path = join(dir, `${name}.sqlite`)
  const raw = new Database(path)
  raw.exec(`CREATE TABLE slack_thread_link (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    message_ts TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (thread_id),
    UNIQUE (channel, message_ts)
  )`)
  raw
    .prepare(
      `INSERT INTO slack_thread_link (id, org_id, artifact_id, thread_id, channel, message_ts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("stl_old", "default", "a_1", "th_1", "C1", "1700000000.1", "2026-01-01T00:00:00.000Z")
  raw.close()
  return path
}

/** The unique indexes actually on the table, as column-name lists. */
const uniques = (path: string): string[][] => {
  const raw = new Database(path)
  const idx = raw.pragma("index_list(slack_thread_link)") as { name: string; unique: number }[]
  const out = idx
    .filter((i) => i.unique)
    .map((i) =>
      (raw.pragma(`index_info(${JSON.stringify(i.name)})`) as { name: string }[]).map(
        (c) => c.name,
      ),
    )
  raw.close()
  return out
}

describe("slack_thread_link re-key", () => {
  it("replaces UNIQUE(thread_id) with UNIQUE(thread_id, channel) on an existing database", () => {
    const path = legacyDb("legacy")
    expect(uniques(path)).toContainEqual(["thread_id"])

    const store = new SqliteMetaStore(path)
    store.close()

    const after = uniques(path)
    expect(after).toContainEqual(["thread_id", "channel"])
    expect(after).not.toContainEqual(["thread_id"])
    // Reply-back resolves off this one; it must survive the rebuild.
    expect(after).toContainEqual(["channel", "message_ts"])
  })

  it("keeps every existing row", async () => {
    const path = legacyDb("rows")
    const store = new SqliteMetaStore(path)
    const link = await store.getSlackThreadLink("th_1", "C1")
    expect(link).toMatchObject({
      id: "stl_old",
      org_id: "default",
      artifact_id: "a_1",
      thread_id: "th_1",
      channel: "C1",
      message_ts: "1700000000.1",
      created_at: "2026-01-01T00:00:00.000Z",
    })
    store.close()
  })

  // The whole point: the same thread in a second channel used to be rejected.
  it("admits a second channel for the same thread after migrating", async () => {
    const path = legacyDb("second-channel")
    const store = new SqliteMetaStore(path)
    await store.setSlackThreadLink({
      id: "stl_new",
      org_id: "default",
      artifact_id: "a_1",
      thread_id: "th_1",
      channel: "C2",
      message_ts: "1700000000.2",
      created_at: new Date().toISOString(),
    })
    expect((await store.listSlackThreadLinksByThread("th_1")).map((l) => l.channel).sort()).toEqual(
      ["C1", "C2"],
    )
    store.close()
  })

  it("is a no-op on a second boot, and on a fresh database", async () => {
    const path = legacyDb("idempotent")
    new SqliteMetaStore(path).close()
    const store = new SqliteMetaStore(path)
    expect(await store.getSlackThreadLink("th_1", "C1")).toBeTruthy()
    store.close()
    expect(uniques(path)).toContainEqual(["thread_id", "channel"])

    const fresh = join(dir, "fresh.sqlite")
    new SqliteMetaStore(fresh).close()
    expect(uniques(fresh)).toContainEqual(["thread_id", "channel"])
    expect(uniques(fresh)).not.toContainEqual(["thread_id"])
  })
})
