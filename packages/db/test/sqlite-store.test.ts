import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { parseOAuthScopes } from "../src/repos"
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

// Scope strings reach us two ways: Better Auth's oauth-provider stores a JSON array,
// but older/space-delimited forms must still parse. Pure helper, exhaustively covered.
describe("parseOAuthScopes", () => {
  it("handles JSON arrays, space-delimited, non-array JSON, and empties", () => {
    expect(parseOAuthScopes(JSON.stringify(["dock:read", "dock:publish"]))).toEqual([
      "dock:read",
      "dock:publish",
    ])
    expect(parseOAuthScopes(JSON.stringify(["a", 1, "b"]))).toEqual(["a", "b"]) // drops non-strings
    expect(parseOAuthScopes("dock:read  dock:publish")).toEqual(["dock:read", "dock:publish"]) // space form
    expect(parseOAuthScopes('{"not":"array"}')).toEqual(['{"not":"array"}']) // valid JSON, not array
    expect(parseOAuthScopes("")).toEqual([])
    expect(parseOAuthScopes(null)).toEqual([])
  })
})

// getOAuthGrant / getOAuthClientName / pruneStaleOAuthClients read Better Auth's
// oauth-provider tables (created out of band by the auth migrator), so — like the
// user-directory methods above — they're seeded and asserted per-dialect here.
describe("sqlite store: OAuth grants (Better Auth oauth-provider tables)", () => {
  it("tolerates the oauth tables being absent (unmigrated store)", async () => {
    const fresh = new SqliteMetaStore(":memory:")
    expect(await fresh.getOAuthGrant("deadbeef")).toBeNull()
    expect(await fresh.getOAuthClientName("client_x")).toBeNull()
    expect(await fresh.pruneStaleOAuthClients(new Date().toISOString())).toBe(0)
    fresh.close()
  })

  it("resolves a seeded grant and reaps only abandoned anonymous clients", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "dock-db-oauth-"))
    const path = join(dir, "store.db")
    const s = new SqliteMetaStore(path)
    const raw = new Database(path)
    raw.exec(`
      CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT);
      CREATE TABLE IF NOT EXISTS "oauthClient" ("clientId" TEXT PRIMARY KEY, name TEXT, "userId" TEXT, "createdAt" TEXT);
      CREATE TABLE IF NOT EXISTS "oauthAccessToken" ("token" TEXT PRIMARY KEY, "clientId" TEXT, "userId" TEXT, "scopes" TEXT, "expiresAt" TEXT);
      CREATE TABLE IF NOT EXISTS "oauthConsent" ("id" TEXT PRIMARY KEY, "clientId" TEXT, "userId" TEXT);
    `)
    raw.prepare(`INSERT INTO user (id,email,name) VALUES (?,?,?)`).run("u1", "amy@x.com", "Amy")
    raw
      .prepare(`INSERT INTO "oauthClient" ("clientId",name,"userId","createdAt") VALUES (?,?,?,?)`)
      .run("client_live", "Claude", "u1", "2026-01-01T00:00:00.000Z")
    const future = new Date(Date.now() + 3_600_000).toISOString()
    raw
      .prepare(
        `INSERT INTO "oauthAccessToken" ("token","clientId","userId","scopes","expiresAt") VALUES (?,?,?,?,?)`,
      )
      .run("hash_live", "client_live", "u1", JSON.stringify(["dock:read", "dock:publish"]), future)
    // An abandoned anonymous client: no user, old, no token, no consent → reapable.
    raw
      .prepare(`INSERT INTO "oauthClient" ("clientId",name,"userId","createdAt") VALUES (?,?,?,?)`)
      .run("client_stale", "Ghost", null, "2020-01-01T00:00:00.000Z")
    raw.close()

    const grant = await s.getOAuthGrant("hash_live")
    expect(grant).toMatchObject({ userId: "u1", userEmail: "amy@x.com", clientName: "Claude" })
    expect(grant?.scopes).toEqual(["dock:read", "dock:publish"])
    expect(grant?.expiresAt.getTime()).toBe(Date.parse(future))
    expect(await s.getOAuthClientName("client_live")).toBe("Claude")
    expect(await s.getOAuthGrant("missing")).toBeNull()

    // client_live is protected by its access token; only client_stale is reaped.
    expect(await s.pruneStaleOAuthClients("2025-01-01T00:00:00.000Z")).toBe(1)
    expect(await s.getOAuthClientName("client_stale")).toBeNull()
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
