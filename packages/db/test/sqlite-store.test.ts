import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { SqliteMetaStore } from "../src/sqlite"
import { runStoreContract } from "./store-contract"

// The full MetaStore contract on in-memory SQLite — the zero-config default that
// every `pnpm test` runs. pg-store.test.ts runs the same contract against Postgres
// when DOCK_TEST_DB=pg. See store-contract.ts.
runStoreContract("sqlite store", async () => {
  const store = new SqliteMetaStore(":memory:")
  return { store, cleanup: () => store.close() }
})

// The user-directory methods read Better Auth's `user` table, created out of band.
// These behaviours are dialect-specific (better-sqlite3 seeding), so they live here
// rather than in the shared contract.
describe("sqlite store: user directory (Better Auth `user` table)", () => {
  it("tolerates the user table being absent (unmigrated fresh store)", async () => {
    // Without the table the methods swallow the error and return empty.
    const fresh = new SqliteMetaStore(":memory:")
    expect(await fresh.findUserByEmail("nobody@x.com")).toBeNull()
    expect(await fresh.getUsers(["x"])).toEqual([])
    fresh.close()
  })

  it("resolves seeded users by email and id", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "dock-db-user-"))
    const path = join(dir, "store.db")
    const s = new SqliteMetaStore(path)
    const raw = new Database(path)
    raw.exec(
      `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT)`,
    )
    raw
      .prepare(`INSERT INTO user (id, email, name, image) VALUES (?,?,?,?)`)
      .run("u1", "amy@x.com", "Amy", null)
    raw.close()
    expect(await s.findUserByEmail("amy@x.com")).toMatchObject({ id: "u1", name: "Amy" })
    expect((await s.getUsers(["u1"])).map((u) => u.email)).toEqual(["amy@x.com"])
    expect(await s.getUsers([])).toEqual([])
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
