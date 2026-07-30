import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { makeAuth, migrateAuth } from "../src/auth-config"

/**
 * THE SESSION COOKIE CACHE, against a REAL Better Auth instance — the fake-session harness
 * (`x-test-user`) cannot see any of this, which is exactly why it needs its own test.
 *
 * Resolving a cookie session was measured at 330-500ms on EVERY authenticated request on the
 * hosted edge, isolated by holding the route fixed and changing only the credential:
 *
 *   /v1/artifacts?limit=1   bearer 729ms   cookie 1233ms   (+503)
 *   /v1/automations         bearer 333ms   cookie  664ms   (+331)
 *
 * With the cache on, Better Auth signs the session into a short-lived cookie and answers from
 * it without touching the database.
 *
 * PROVING THAT WITHOUT A STOPWATCH: delete the session ROW, then make a request. If the caller
 * is still authenticated, nothing read the session table — there is nothing left to read. The
 * same assertion is also the honest statement of the trade: for the length of the window, a
 * revoked session still works. The second case pins that the window actually closes, which is
 * the property that makes it acceptable.
 */
const dir = mkdtempSync(join(tmpdir(), "derive-session-cache-"))
const dbPath = join(dir, "auth.db")
const db = new Database(dbPath)

const BASE = "http://localhost:8080"
const auth = makeAuth(db, BASE, "test-secret-0123456789abcd")
const app = createApp({
  meta: new SqliteMetaStore(dbPath),
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: BASE,
  auth,
})

const post = (path: string, body: unknown, cookie = "derive_probe=1") =>
  app.request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify(body),
  })
const get = (path: string, cookie: string) =>
  app.request(`${BASE}${path}`, { headers: { origin: BASE, cookie } })

/** Every Set-Cookie folded into one request-ready Cookie header. */
const cookiesOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("the session cookie cache", () => {
  const email = "cache@derive.test"
  let cookie = ""

  it("migrates and signs up", async () => {
    await migrateAuth(auth)
    const res = await post("/api/auth/sign-up/email", {
      email,
      password: "initialPassw0rd",
      name: "Cache",
    })
    expect(res.status).toBe(200)
  })

  it("issues a session-data cookie alongside the session token", async () => {
    const res = await post("/api/auth/sign-in/email", { email, password: "initialPassw0rd" })
    expect(res.status).toBe(200)
    cookie = cookiesOf(res)
    // The cache is what makes the DB-free path possible; without this cookie the rest of the
    // feature is inert, which is precisely how an earlier attempt at this failed silently.
    expect(cookie).toContain("session_data")
    expect(cookie).toContain("session_token")
  })

  it("still authenticates after the session ROW is deleted — nothing read the table", async () => {
    const before = await get("/v1/me", cookie)
    expect(before.status).toBe(200)

    // Remove every session row. A request that still resolves a user cannot have consulted them.
    const removed = db.prepare("delete from session").run()
    expect(removed.changes).toBeGreaterThan(0)
    expect(db.prepare("select count(*) as n from session").get()).toEqual({ n: 0 })

    const after = await get("/v1/me", cookie)
    expect(after.status).toBe(200)
    expect(await after.json()).toMatchObject({ user: { email } })
  })

  it("refuses once the cached cookie is gone — the window is bounded, not a bypass", async () => {
    // The cache is a cookie with a maxAge; dropping it is what its expiry does. With the rows
    // already deleted, the request must now fail closed rather than fall through to a stale
    // identity — this is the half that makes the trade acceptable.
    const tokenOnly = cookie
      .split("; ")
      .filter((c) => !c.startsWith("__Secure-better-auth.session_data"))
      .filter((c) => !c.startsWith("better-auth.session_data"))
      .join("; ")
    expect(tokenOnly).not.toContain("session_data")

    const res = await get("/v1/me", tokenOnly)
    expect(res.status).toBe(401)
  })
})
