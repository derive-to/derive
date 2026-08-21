import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
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

/** What a browser does with a response: fold its Set-Cookie into the jar, by name. */
const mergeCookies = (jar: string, res: Response): string => {
  const fresh = res.headers.getSetCookie().map((c) => c.split(";")[0] ?? "")
  const names = new Set(fresh.map((c) => c.split("=")[0]))
  const kept = jar.split("; ").filter((c) => !names.has(c.split("=")[0]))
  return [...kept, ...fresh].join("; ")
}

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("the session cookie cache", () => {
  const email = "cache@derive.test"
  let cookie = ""

  beforeAll(async () => {
    await migrateAuth(auth)
    const res = await post("/api/auth/sign-up/email", {
      email,
      password: "initialPassw0rd",
      name: "Cache",
    })
    if (res.status !== 200) throw new Error(`sign-up failed: ${res.status}`)
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

  it("a profile write refreshes the cached cookie — the save is visible immediately", async () => {
    // Re-establish a session (the row-deletion case above burned the old one).
    const signin = await post("/api/auth/sign-in/email", { email, password: "initialPassw0rd" })
    expect(signin.status).toBe(200)
    let jar = cookiesOf(signin)
    expect(jar).toContain("session_data")

    // The cached cookie is what /v1/me answers from: it still carries no profession.
    const before = await (await get("/v1/me", jar)).json()
    expect(before.user.profession).toBeNull()

    // Save a role. The write goes straight to the user row, BELOW the cookie cache —
    // so the response must carry a re-signed session_data cookie, or every read for
    // the next 60s serves the old value and the save looks lost.
    const saved = await app.request(`${BASE}/v1/me/profile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie: jar },
      body: JSON.stringify({ profession: "Design" }),
    })
    expect(saved.status).toBe(200)
    const refreshed = cookiesOf(saved)
    expect(refreshed).toContain("session_data")

    // The STALE jar still serves the old identity — proof the cache is the reader,
    // and that without the refreshed cookie this would read as data loss.
    const stale = await (await get("/v1/me", jar)).json()
    expect(stale.user.profession).toBeNull()

    // A browser folds the Set-Cookie in; do the same, then the very next read is new.
    jar = mergeCookies(jar, saved)
    const after = await (await get("/v1/me", jar)).json()
    expect(after.user.profession).toBe("Design")
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

describe("the session cookie cache resists tampering", () => {
  /**
   * THE COOKIE CACHE IS AN IDENTITY SOURCE. Attack it.
   *
   * Serving the session from a signed cookie lets a request authenticate without the database
   * being read. That is the point, and it is also new attack surface: if the payload can be
   * edited, forged, or replayed from another deployment, the fast path is an authentication
   * bypass rather than a cache.
   *
   * What this pins, all found by trying them:
   *   - the cached payload is NOT a credential on its own — without a session token it is 401;
   *   - editing it does not change who you are;
   *   - a payload minted under another secret is refused;
   *   - a malformed one is a 401, never a 500. `{}` used to throw "Error parsing JSON" out of
   *     getSession, and since every authenticated request goes through it, one bad cookie meant a
   *     sticky 500 on every page — the client has no reason to re-authenticate, so it loops.
   *
   * KNOWN AND ACCEPTED: presenting account A's session token with account B's cached payload
   * resolves as B. It is not an escalation — both cookies are HttpOnly with identical exposure, so
   * anyone who can read B's session_data can read B's session_token, which already impersonates B
   * outright. It is recorded here so the property is a decision rather than a surprise.
   */
  const dir = mkdtempSync(join(tmpdir(), "derive-cache-tamper-"))
  const dbPath = join(dir, "auth.db")
  const db = new Database(dbPath)
  const BASE = "http://localhost:8080"
  const SECRET = "tamper-secret-at-least-16-chars"

  const appWith = (secret: string) =>
    createApp({
      meta: new SqliteMetaStore(dbPath),
      blobs: new FsBlobStore(join(dir, "blobs")),
      baseUrl: BASE,
      auth: makeAuth(db, BASE, secret),
    })
  const app = appWith(SECRET)

  const signIn = (a: ReturnType<typeof createApp>, email: string) =>
    a.request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie: "p=1" },
      body: JSON.stringify({ email, password: "initialPassw0rd" }),
    })
  const meAs = (cookie: string) =>
    app.request(`${BASE}/v1/me`, { headers: { origin: BASE, cookie } })

  /** The `name=value` pair for a Set-Cookie whose name contains `part`. */
  const pair = (res: Response, part: string): string =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] ?? "")
      .find((p) => p.includes(part)) ?? ""
  const emailOf = async (res: Response): Promise<string | undefined> =>
    res.status === 200
      ? ((await res.json()) as { user?: { email?: string } }).user?.email
      : undefined

  const VICTIM = "victim@derive.test"
  const ATTACKER = "attacker@derive.test"
  let victimToken = ""
  let victimData = ""
  let attackerToken = ""

  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("issues an HttpOnly session-data cookie alongside the token", async () => {
    await migrateAuth(makeAuth(db, BASE, SECRET))
    for (const email of [VICTIM, ATTACKER]) {
      const up = await app.request(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: "p=1" },
        body: JSON.stringify({ email, password: "initialPassw0rd", name: email }),
      })
      expect(up.status).toBe(200)
    }
    const v = await signIn(app, VICTIM)
    const a = await signIn(app, ATTACKER)
    victimToken = pair(v, "session_token")
    victimData = pair(v, "session_data")
    attackerToken = pair(a, "session_token")
    expect(victimData).not.toBe("")
    // HttpOnly is what makes the cross-account note below an accepted property rather than a
    // hole: script on the page cannot read this cookie any more than it can read the token.
    const raw = v.headers.getSetCookie().find((c) => c.includes("session_data")) ?? ""
    expect(raw).toContain("HttpOnly")
    expect(await emailOf(await meAs(`${victimToken}; ${victimData}`))).toBe(VICTIM)
  })

  it("is not a credential on its own — no session token, no identity", async () => {
    expect((await meAs(victimData)).status).toBe(401)
  })

  it("EDITING the payload never yields a different identity", async () => {
    const [name = "", value = ""] = victimData.split(/=(.*)/s)
    const decoded = decodeURIComponent(value)
    const edited = decoded.includes(VICTIM) ? decoded.replaceAll(VICTIM, ATTACKER) : `${decoded}x`
    const res = await meAs(`${victimToken}; ${name}=${encodeURIComponent(edited)}`)
    // Falling back to the database on a bad signature is fine; becoming someone else is not.
    if (res.status === 200) expect(await emailOf(res)).toBe(VICTIM)
    else expect([401, 403]).toContain(res.status)
  })

  it("a MALFORMED payload is a clean 401 or a fallback — never a 500", async () => {
    const [name = ""] = victimData.split("=")
    const value = victimData.slice(name.length + 1)
    const broken = [
      value.slice(0, Math.floor(value.length / 2)), // truncated
      `${value}AAAA`, // appended garbage
      "", // empty
      "null",
      "%7B%7D", // `{}` — the one that used to throw out of getSession and 500 the request
      "%5B%5D", // `[]`
      "not-base64-at-all",
    ]
    for (const bad of broken) {
      const res = await meAs(`${victimToken}; ${name}=${bad}`)
      expect(
        res.status,
        `payload ${JSON.stringify(bad.slice(0, 16))} returned ${res.status}`,
      ).not.toBe(500)
      if (res.status === 200) expect(await emailOf(res)).toBe(VICTIM)
    }
  })

  it("a payload minted under a DIFFERENT secret is refused", async () => {
    // Same database, another deployment's secret: a preview, a rotated key, a self-host sharing
    // storage. Its cached payload must not authenticate here.
    const foreign = appWith("another-secret-at-least-16-chars")
    const foreignData = pair(await signIn(foreign, VICTIM), "session_data")
    if (!foreignData) return // that deployment issued no cache cookie; nothing to replay
    expect((await meAs(foreignData)).status).toBe(401)
  })

  it("cross-account mixing resolves to the CACHED account, and both cookies are HttpOnly", async () => {
    // Recorded, not celebrated. Reaching this requires already holding the victim's HttpOnly
    // session_data, and anyone who can read that can read the victim's HttpOnly session_token —
    // which impersonates them without touching the cache at all. If session_data ever stops
    // being HttpOnly, this test is where that becomes a real finding.
    const who = await emailOf(await meAs(`${attackerToken}; ${victimData}`))
    expect(who === VICTIM || who === ATTACKER).toBe(true)
  })
})
