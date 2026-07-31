import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { makeAuth, migrateAuth } from "../src/auth-config"

// The native shell's session hand-off.
//
// Google refuses OAuth from an embedded web view, so the shell runs sign-in in a REAL
// browser. That browser has its own cookie jar, so the session lands there and not in
// the app's web view — and no client-side trick bridges the two (on iOS they are
// genuinely separate stores). The one-time-token plugin closes it: the real browser
// mints a token for its session, the app carries it across, and the WEB VIEW spends it,
// so the Set-Cookie lands in the jar that needs it.
//
// These tests pin the properties the hand-off's safety rests on. It is a credential in a
// URL for a couple of seconds, so "single-use" and "expires" are not nice-to-haves.
const dir = mkdtempSync(join(tmpdir(), "derive-native-handoff-"))
const BASE = "http://localhost:8080"
const dbPath = join(dir, "auth.db")
const db = new Database(dbPath)
const auth = makeAuth(db, BASE, "test-secret-0123456789abcd")
const app = createApp({
  meta: new SqliteMetaStore(dbPath),
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: BASE,
  auth,
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Sign up and return the browser's session cookie — this stands in for the REAL
 *  browser the shell opens for sign-in. */
const signUpAndGetCookie = async (email: string): Promise<string> => {
  const res = await app.request(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "Native Tester" }),
  })
  expect(res.status).toBe(200)
  const setCookie = res.headers.get("set-cookie")
  expect(setCookie).toBeTruthy()
  // Keep just the name=value pairs; the attributes are for a browser, not for us.
  return (setCookie ?? "")
    .split(/,(?=[^;]+=)/)
    .map((c) => (c.split(";")[0] ?? "").trim())
    .join("; ")
}

/** The real browser minting a hand-off token for its own session. */
const generate = (cookie: string) =>
  app.request(`${BASE}/api/auth/one-time-token/generate`, { headers: { cookie, origin: BASE } })

/** The web view spending it. */
const verify = (token: string) =>
  app.request(`${BASE}/api/auth/one-time-token/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ token }),
  })

describe("native session hand-off", () => {
  it("hands a signed-in session to a second cookie jar", async () => {
    await migrateAuth(auth)
    const cookie = await signUpAndGetCookie("handoff@local.test")

    const minted = await generate(cookie)
    expect(minted.status).toBe(200)
    const { token } = (await minted.json()) as { token: string }
    expect(token).toBeTruthy()

    // The web view spends it and is handed a session cookie of its own. This is the
    // whole point: the Set-Cookie belongs to whoever made THIS request.
    const spent = await verify(token)
    expect(spent.status).toBe(200)
    const handedCookie = spent.headers.get("set-cookie")
    expect(handedCookie).toBeTruthy()

    // And that cookie really is a working session, not just a well-formed header.
    const jar = (handedCookie ?? "")
      .split(/,(?=[^;]+=)/)
      .map((c) => (c.split(";")[0] ?? "").trim())
      .join("; ")
    const me = await app.request(`${BASE}/v1/me`, { headers: { cookie: jar } })
    expect(me.status).toBe(200)
    const body = (await me.json()) as { user: { email: string } }
    expect(body.user.email).toBe("handoff@local.test")
  })

  it("is single-use: a replayed token is refused", async () => {
    const cookie = await signUpAndGetCookie("replay@local.test")
    const { token } = (await (await generate(cookie)).json()) as { token: string }

    expect((await verify(token)).status).toBe(200)
    // The token rides in a URL for a moment, so a second spend must find nothing.
    // consumeVerificationValue is what makes this true; if the plugin is ever swapped
    // for a stateless signed token, this test is the thing that should stop it.
    const replayed = await verify(token)
    expect(replayed.status).toBeGreaterThanOrEqual(400)
  })

  it("refuses a token nobody minted", async () => {
    const forged = await verify("not-a-real-token-0123456789")
    expect(forged.status).toBeGreaterThanOrEqual(400)
  })

  it("will not mint for a caller with no session", async () => {
    // The anonymous case is the one that would turn the hand-off into an account
    // takeover, so it is checked explicitly rather than assumed from the middleware.
    const anon = await app.request(`${BASE}/api/auth/one-time-token/generate`, {
      headers: { origin: BASE },
    })
    expect(anon.status).toBeGreaterThanOrEqual(400)
  })

  it("hands over the MINTER's session, never another user's", async () => {
    const alice = await signUpAndGetCookie("alice@local.test")
    const bob = await signUpAndGetCookie("bob@local.test")

    const aliceToken = ((await (await generate(alice)).json()) as { token: string }).token
    const bobToken = ((await (await generate(bob)).json()) as { token: string }).token
    expect(aliceToken).not.toBe(bobToken)

    const spent = await verify(bobToken)
    const jar = (spent.headers.get("set-cookie") ?? "")
      .split(/,(?=[^;]+=)/)
      .map((c) => (c.split(";")[0] ?? "").trim())
      .join("; ")
    const me = await app.request(`${BASE}/v1/me`, { headers: { cookie: jar } })
    const body = (await me.json()) as { user: { email: string } }
    expect(body.user.email).toBe("bob@local.test")
  })

  it("stores the token hashed, so a leaked verification row is not a credential", async () => {
    const cookie = await signUpAndGetCookie("hashed@local.test")
    const { token } = (await (await generate(cookie)).json()) as { token: string }

    // storeToken: "hashed" in auth-config. The plaintext must not be sitting in the
    // table under `one-time-token:<token>` — that identifier is derived from the HASH.
    const rows = db
      .prepare("select identifier from verification where identifier like 'one-time-token:%'")
      .all() as { identifier: string }[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.identifier === `one-time-token:${token}`)).toBe(false)
  })
})
