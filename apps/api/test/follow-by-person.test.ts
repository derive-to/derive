import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { publish } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import Database from "better-sqlite3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// "Follow a person" (FollowKind "user"). A publish records the creating Dock user as
// artifact.author_id, and followedArtifactIds surfaces a followed person's work two
// ways: author_id (hand-published) OR author_gh_id → their linked GitHub account
// (synced). The handle→user/account resolution rides Better Auth's user/account
// tables, which the Dock store doesn't create — so the test stands them up.

const dir = mkdtempSync(join(tmpdir(), "dock-follow-person-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dbPath = join(dir, "follow.db")
const WS = "ws_test"
let meta: SqliteMetaStore
let ids: { manual: string; synced: string; other: string }

const raw = (fn: (db: Database.Database) => void) => {
  const db = new Database(dbPath)
  db.pragma("busy_timeout = 3000")
  fn(db)
  db.close()
}

beforeAll(async () => {
  meta = new SqliteMetaStore(dbPath)
  const blobs = new FsBlobStore(join(dir, "blobs"))

  // Better Auth's identity tables (followedArtifactIds resolves handles through them).
  raw((db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, username TEXT, name TEXT, image TEXT);
      CREATE TABLE IF NOT EXISTS "account" (id TEXT PRIMARY KEY, accountId TEXT, providerId TEXT, userId TEXT);
    `)
    db.prepare(`INSERT INTO "user"(id,username,name) VALUES (?,?,?),(?,?,?),(?,?,?)`).run(
      "u_alice",
      "alice",
      "Alice",
      "u_me",
      "me",
      "Me",
      "u_other",
      "other",
      "Other",
    )
    // Alice signed in with GitHub (numeric id gh_123) — links her synced authorship.
    db.prepare(
      `INSERT INTO "account"(id,accountId,providerId,userId) VALUES ('ac1','gh_123','github','u_alice')`,
    ).run()
  })

  const mk = async (title: string, opts: { authorId?: string }) =>
    (
      await publish(meta, blobs, {
        bytes: new TextEncoder().encode("<p>x</p>"),
        filename: "a.html",
        isBundle: false,
        title,
        author: "seed",
        orgId: WS,
        visibility: "org",
        authorId: opts.authorId,
      })
    ).artifact

  const manual = (await mk("Alice — hand-published", { authorId: "u_alice" })).id
  const synced = await mk("Alice — synced from GitHub", {})
  // Sync denormalizes the committer's GitHub id onto the artifact; emulate that.
  raw((db) => db.prepare(`UPDATE artifact SET author_gh_id='gh_123' WHERE id=?`).run(synced.id))
  const other = (await mk("Someone else's", { authorId: "u_other" })).id
  ids = { manual, synced: synced.id, other }
})

describe("publish records author_id", () => {
  it("attributes a logged-in publish to the creating user", async () => {
    const a = await meta.getArtifactById(ids.manual)
    expect(a?.author_id).toBe("u_alice")
  })
})

describe("followedArtifactIds for a user-follow", () => {
  it("surfaces the person's hand-published AND synced work, nothing else", async () => {
    await meta.addFollow({
      id: "fl1",
      org_id: WS,
      user_id: "u_me",
      kind: "user",
      target: "alice",
    })
    const got = await meta.followedArtifactIds("u_me", WS)
    expect([...got].sort()).toEqual([ids.manual, ids.synced].sort())
    expect(got).not.toContain(ids.other)
  })

  it("returns nothing once the follow is removed", async () => {
    await meta.removeFollow("u_me", WS, "user", "alice")
    expect(await meta.followedArtifactIds("u_me", WS)).toEqual([])
  })
})
