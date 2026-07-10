import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { parseOAuthScopes } from "../src/repos"
import { SqliteMetaStore } from "../src/sqlite"
import { runStoreContract } from "./store-contract"

// The full MetaStore contract on in-memory SQLite — the zero-config default that
// every `pnpm test` runs. pg-store.test.ts runs the same contract against Postgres
// when DERIVE_TEST_DB=pg. See store-contract.ts.
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
    expect(await fresh.getUserByUsername("ghost")).toBeNull()
    expect(await fresh.searchDiscoverableUsers("a", 10)).toEqual([])
    fresh.close()
  })

  it("resolves users by email/id/handle, sets avatar, and powers opt-in search", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "derive-db-user-"))
    const path = join(dir, "store.db")
    const s = new SqliteMetaStore(path)
    const raw = new Database(path)
    // No column default: an unset `discoverable` is NULL, which search treats as
    // discoverable (on by default), same as a pre-migration row.
    raw.exec(
      `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT)`,
    )
    raw.exec(`CREATE UNIQUE INDEX user_username ON user (username)`)
    const ins = raw.prepare(`INSERT INTO user (id, email, name) VALUES (?,?,?)`)
    ins.run("u1", "amy@x.com", "Amy")
    ins.run("u2", "bo@x.com", "Bo")
    raw.close()

    // Email + id directory.
    expect(await s.findUserByEmail("amy@x.com")).toMatchObject({ id: "u1", name: "Amy" })
    expect((await s.getUsers(["u1"])).map((u) => u.email)).toEqual(["amy@x.com"])
    expect(await s.getUsers([])).toEqual([])

    // Claim a handle; resolve it; reject a clash; own handle re-set is a no-op.
    expect(await s.setUsername("u1", "amy")).toBe("ok")
    expect(await s.getUserByUsername("amy")).toMatchObject({ id: "u1", username: "amy" })
    expect(await s.getUserByUsername("nope")).toBeNull()
    expect(await s.setUsername("u2", "amy")).toBe("taken")
    expect(await s.setUsername("u1", "amy")).toBe("ok")

    // Avatar.
    await s.setUserImage("u1", "https://cdn/x.png")
    expect((await s.getUserByUsername("amy"))?.image).toBe("https://cdn/x.png")

    // People search: on by default. amy (discoverable unset/NULL) is found right
    // away; opting out hides her; opting back in shows her. Case-insensitive on
    // handle or name; an empty query returns nothing.
    expect((await s.searchDiscoverableUsers("am", 10)).map((u) => u.username)).toEqual(["amy"])
    expect((await s.searchDiscoverableUsers("AMY", 10)).map((u) => u.id)).toEqual(["u1"])
    await s.setUserDiscoverable("u1", false)
    expect(await s.searchDiscoverableUsers("am", 10)).toEqual([]) // opted out
    await s.setUserDiscoverable("u1", true)
    expect((await s.searchDiscoverableUsers("am", 10)).map((u) => u.username)).toEqual(["amy"])
    expect(await s.searchDiscoverableUsers("", 10)).toEqual([])

    s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("round-trips a user brandprint (set, read, clear)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "derive-db-brandprint-"))
    const path = join(dir, "store.db")
    const s = new SqliteMetaStore(path)
    const raw = new Database(path)
    raw.exec(
      `CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT, brandprint TEXT)`,
    )
    raw.prepare(`INSERT INTO user (id, email, name) VALUES (?,?,?)`).run("u1", "amy@x.com", "Amy")
    raw.close()

    await s.setUserProfile("u1", { brandprint: JSON.stringify({ collectionId: "col_x" }) })
    expect(await s.getUserBrandprint("u1")).toBe(JSON.stringify({ collectionId: "col_x" }))
    await s.setUserProfile("u1", { brandprint: null })
    expect(await s.getUserBrandprint("u1")).toBeNull()

    s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("maps GitHub account ids to Derive users (account → user join); tolerates absent tables", async () => {
    // Absent Better Auth tables → graceful empty (fresh store); empty input short-circuits.
    const fresh = new SqliteMetaStore(":memory:")
    expect(await fresh.usersByGithubIds(["4242"])).toEqual([])
    expect(await fresh.usersByGithubIds([])).toEqual([])
    fresh.close()

    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "derive-db-gh-"))
    const path = join(dir, "store.db")
    const s = new SqliteMetaStore(path)
    const raw = new Database(path)
    raw.exec(
      `CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT)`,
    )
    // Better Auth's account table: camelCase columns, one row per linked provider.
    raw.exec(
      `CREATE TABLE account (id TEXT PRIMARY KEY, "accountId" TEXT, "providerId" TEXT, "userId" TEXT)`,
    )
    raw
      .prepare(`INSERT INTO user (id, name, image, username) VALUES (?,?,?,?)`)
      .run("u1", "Ada", "https://cdn/ada.png", "ada-handle")
    raw
      .prepare(`INSERT INTO account (id, "accountId", "providerId", "userId") VALUES (?,?,?,?)`)
      .run("acc-gh", "4242", "github", "u1")
    // A non-GitHub provider for the same user must NOT match.
    raw
      .prepare(`INSERT INTO account (id, "accountId", "providerId", "userId") VALUES (?,?,?,?)`)
      .run("acc-goog", "g-1", "google", "u1")
    raw.close()

    expect(await s.usersByGithubIds(["4242", "missing"])).toEqual([
      {
        gh_id: "4242",
        id: "u1",
        name: "Ada",
        image: "https://cdn/ada.png",
        username: "ada-handle",
      },
    ])
    expect(await s.usersByGithubIds([])).toEqual([])

    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

// Scope strings reach us two ways: Better Auth's oauth-provider stores a JSON array,
// but older/space-delimited forms must still parse. Pure helper, exhaustively covered.
describe("parseOAuthScopes", () => {
  it("handles JSON arrays, space-delimited, non-array JSON, and empties", () => {
    expect(parseOAuthScopes(JSON.stringify(["derive:read", "derive:publish"]))).toEqual([
      "derive:read",
      "derive:publish",
    ])
    expect(parseOAuthScopes(JSON.stringify(["a", 1, "b"]))).toEqual(["a", "b"]) // drops non-strings
    expect(parseOAuthScopes("derive:read  derive:publish")).toEqual([
      "derive:read",
      "derive:publish",
    ]) // space form
    expect(parseOAuthScopes('{"not":"array"}')).toEqual(['{"not":"array"}']) // valid JSON, not array
    expect(parseOAuthScopes("")).toEqual([])
    expect(parseOAuthScopes(null)).toEqual([])
  })

  it("handles an already-parsed array (pg json/jsonb columns come back parsed)", () => {
    // node-postgres parses json/jsonb before we ever see it: the value is a real
    // array, not a string. This was the prod 500 — `s.split is not a function`
    // in getOAuthGrant — for every OAuth bearer on the Postgres tier.
    expect(parseOAuthScopes(["derive:read", "derive:publish"])).toEqual([
      "derive:read",
      "derive:publish",
    ])
    expect(parseOAuthScopes([])).toEqual([])
    expect(parseOAuthScopes(["a", 1, "b"] as unknown as string[])).toEqual(["a", "b"]) // drops non-strings
  })
})

// The people directory (browse), follower/following lists (the user-table JOIN), and the
// author_id backfill all read Better Auth's `user`/`account` tables, so — like the
// user-directory methods above — they're seeded + asserted per-dialect here.
describe("sqlite store: people directory + follower lists + author backfill", () => {
  it("tolerates the auth tables being absent (fresh store) → empty / zero", async () => {
    const fresh = new SqliteMetaStore(":memory:")
    expect(await fresh.listDiscoverableUsers(10)).toEqual([])
    expect(await fresh.listFollowers("u1", 10)).toEqual([])
    expect(await fresh.listFollowing("u1", 10)).toEqual([])
    expect(await fresh.backfillAuthorIds()).toBe(0)
    fresh.close()
  })

  it("browses discoverable people, resolves follower/following profiles, backfills author_id", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "derive-db-people-"))
    const path = join(dir, "store.db")
    const s = new SqliteMetaStore(path)
    const raw = new Database(path)
    raw.exec(
      `CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT)`,
    )
    raw.exec(
      `CREATE TABLE account (id TEXT PRIMARY KEY, "accountId" TEXT, "providerId" TEXT, "userId" TEXT)`,
    )
    const insU = raw.prepare(
      `INSERT INTO user (id, name, username, discoverable, profession) VALUES (?,?,?,?,?)`,
    )
    insU.run("u1", "Amy", "amy", null, "Engineering") // discoverable (null = on by default)
    insU.run("u2", "Bo", "bo", 1, "Design") // discoverable on
    insU.run("u3", "Cy", "cy", 0, null) // opted out → excluded
    insU.run("u4", "Dee", null, null, null) // no handle → excluded
    raw
      .prepare(`INSERT INTO account (id, "accountId", "providerId", "userId") VALUES (?,?,?,?)`)
      .run("acc", "9999", "github", "u1")
    raw.close()

    // Browse: discoverable + handle-claimed only, ordered by handle. cy (opted out) and
    // dee (no handle) are excluded.
    expect((await s.listDiscoverableUsers(10)).map((u) => u.username)).toEqual(["amy", "bo"])

    // Follower / following lists resolve to public profiles (the user-table JOIN happy
    // path — the branch the cross-dialect contract can't reach without a user table).
    await s.addFollow({ id: "f1", org_id: "*", user_id: "u2", kind: "user", target: "u1" }) // bo → amy
    expect((await s.listFollowers("u1", 10)).map((u) => u.username)).toEqual(["bo"])
    expect((await s.listFollowing("u2", 10)).map((u) => u.username)).toEqual(["amy"])
    expect(await s.listFollowers("u2", 10)).toEqual([]) // nobody follows bo

    // Backfill: a synced artifact whose author_gh_id maps to a Derive user gets author_id
    // stamped; a second run is a no-op (idempotent).
    const a = await s.createArtifact({
      id: "a1",
      short_id: "sh1",
      org_id: "o",
      slug: null,
      title: "T",
      kind: "file",
      spa: 0,
    })
    await s.addVersion(a.id, {
      id: "v1",
      blob_key: "b",
      content_type: "text/html",
      size_bytes: 1,
      author: "Amy",
      author_gh_id: "9999",
      message: null,
    })
    expect((await s.getArtifactById("a1"))?.author_id).toBeNull()
    expect(await s.backfillAuthorIds()).toBe(1)
    expect((await s.getArtifactById("a1"))?.author_id).toBe("u1")
    expect(await s.backfillAuthorIds()).toBe(0) // idempotent — nothing left to fill

    s.close()
    rmSync(dir, { recursive: true, force: true })
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
    // Connected-agents surface fails open too: no tables → empty list, revoke is a no-op.
    expect(await fresh.listUserGrants("u1")).toEqual([])
    await expect(fresh.revokeUserGrant("u1", "client_x")).resolves.toBeUndefined()
    fresh.close()
  })

  it("lists a user's authorized agents and revokes one (consent + tokens dropped)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "derive-db-grants-"))
    const path = join(dir, "store.db")
    const s = new SqliteMetaStore(path)
    const raw = new Database(path)
    raw.exec(`
      CREATE TABLE IF NOT EXISTS "oauthClient" ("clientId" TEXT PRIMARY KEY, name TEXT, "userId" TEXT, "createdAt" TEXT);
      CREATE TABLE IF NOT EXISTS "oauthAccessToken" ("token" TEXT PRIMARY KEY, "clientId" TEXT, "userId" TEXT, "scopes" TEXT, "expiresAt" TEXT);
      CREATE TABLE IF NOT EXISTS "oauthRefreshToken" ("token" TEXT PRIMARY KEY, "clientId" TEXT, "userId" TEXT, "expiresAt" TEXT);
      CREATE TABLE IF NOT EXISTS "oauthConsent" ("id" TEXT PRIMARY KEY, "clientId" TEXT, "userId" TEXT, "scopes" TEXT, "updatedAt" TEXT);
    `)
    raw
      .prepare(`INSERT INTO "oauthClient" ("clientId",name) VALUES (?,?)`)
      .run("client_a", "Claude Code")
    raw
      .prepare(
        `INSERT INTO "oauthConsent" ("id","clientId","userId","scopes","updatedAt") VALUES (?,?,?,?,?)`,
      )
      .run(
        "cons1",
        "client_a",
        "u1",
        JSON.stringify(["derive:read", "derive:propose"]),
        "2026-06-01T00:00:00.000Z",
      )
    // A live access + refresh token under that grant, and an unrelated other user's consent.
    raw
      .prepare(
        `INSERT INTO "oauthAccessToken" ("token","clientId","userId","scopes","expiresAt") VALUES (?,?,?,?,?)`,
      )
      .run("tok1", "client_a", "u1", JSON.stringify(["derive:read"]), "2099-01-01T00:00:00.000Z")
    // A refresh token too — the 30-day one that, if not killed, could mint fresh access
    // tokens for weeks after a "revoke". Revocation MUST drop it.
    raw
      .prepare(
        `INSERT INTO "oauthRefreshToken" ("token","clientId","userId","expiresAt") VALUES (?,?,?,?)`,
      )
      .run("rt1", "client_a", "u1", "2099-01-01T00:00:00.000Z")
    raw
      .prepare(
        `INSERT INTO "oauthConsent" ("id","clientId","userId","scopes","updatedAt") VALUES (?,?,?,?,?)`,
      )
      .run(
        "cons2",
        "client_a",
        "other",
        JSON.stringify(["derive:read"]),
        "2026-06-02T00:00:00.000Z",
      )
    raw.close()

    const grants = await s.listUserGrants("u1")
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ clientId: "client_a", clientName: "Claude Code" })
    expect(grants[0]?.scopes).toEqual(["derive:read", "derive:propose"])

    await s.revokeUserGrant("u1", "client_a")
    // u1's grant + BOTH token kinds are gone; the other user's consent is untouched.
    expect(await s.listUserGrants("u1")).toEqual([])
    expect(await s.listUserGrants("other")).toHaveLength(1)
    const check = new Database(path)
    const count = (table: string) =>
      (
        check.prepare(`SELECT count(*) as n FROM "${table}" WHERE "userId"='u1'`).get() as {
          n: number
        }
      ).n
    expect(count("oauthAccessToken")).toBe(0)
    expect(count("oauthRefreshToken")).toBe(0) // the 30-day token really is revoked
    check.close()
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("resolves a seeded grant and reaps only abandoned anonymous clients", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "derive-db-oauth-"))
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
      .run(
        "hash_live",
        "client_live",
        "u1",
        JSON.stringify(["derive:read", "derive:publish"]),
        future,
      )
    // An abandoned anonymous client: no user, old, no token, no consent → reapable.
    raw
      .prepare(`INSERT INTO "oauthClient" ("clientId",name,"userId","createdAt") VALUES (?,?,?,?)`)
      .run("client_stale", "Ghost", null, "2020-01-01T00:00:00.000Z")
    raw.close()

    const grant = await s.getOAuthGrant("hash_live")
    expect(grant).toMatchObject({ userId: "u1", userEmail: "amy@x.com", clientName: "Claude" })
    expect(grant?.scopes).toEqual(["derive:read", "derive:publish"])
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
