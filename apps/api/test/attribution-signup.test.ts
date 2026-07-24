import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { makeAuth, migrateAuth } from "../src/auth-config"
import { SRC_COOKIE, signupAttributionHook } from "../src/lib/attribution"

// The signup half of attribution: a REAL Better Auth sign-up (the same harness as
// auth-origin.test.ts) carrying the d_src cookie the capture middleware stamped —
// the user-create hook must record it, and must never be able to block the signup.
const dir = mkdtempSync(join(tmpdir(), "derive-attr-signup-"))

const dbPath = join(dir, "auth.db")
const db = new Database(dbPath)
const meta = new SqliteMetaStore(dbPath)
const auth = makeAuth(db, "http://localhost:8080", "test-secret-0123456789abcd", {
  recordSignupAttribution: signupAttributionHook(meta),
})
const app = createApp({
  meta,
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: "http://localhost:8080",
  auth,
})

// A second auth stack whose hook always throws — attribution is best-effort
// telemetry and must never cost an account.
const db2 = new Database(join(dir, "auth2.db"))
const auth2 = makeAuth(db2, "http://localhost:8080", "test-secret-0123456789abcd", {
  recordSignupAttribution: async () => {
    throw new Error("attribution store down")
  },
})
const app2 = createApp({
  meta: new SqliteMetaStore(join(dir, "auth2.db")),
  blobs: new FsBlobStore(join(dir, "blobs2")),
  baseUrl: "http://localhost:8080",
  auth: auth2,
})

beforeAll(async () => {
  await migrateAuth(auth)
  await migrateAuth(auth2)
})
afterAll(() => {
  db.close()
  db2.close()
  rmSync(dir, { recursive: true, force: true })
})

const stamp = (v: object) => `${SRC_COOKIE}=${encodeURIComponent(JSON.stringify(v))}`

const signUp = (a: typeof app, email: string, cookie?: string) =>
  a.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // A cookie arms Better Auth's CSRF/origin check; real browser signups always
      // carry a same-origin Origin header, so send one (auth-origin.test.ts pattern).
      origin: "http://localhost:8080",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ email, password: "password12345", name: "Tester" }),
  })

describe("signup attribution (the user-create hook)", () => {
  it("records the d_src stamp onto the new account", async () => {
    const res = await signUp(
      app,
      "badge@example.com",
      stamp({ k: "badge", a: "ab12cd34", p: "/artifacts/doc-ab12cd34", r: "news.ycombinator.com" }),
    )
    expect(res.status).toBe(200)
    const userId = (await res.json()).user.id as string
    expect(await meta.getSignupAttribution(userId)).toMatchObject({
      user_id: userId,
      source_kind: "badge",
      source_artifact: "ab12cd34",
      landing_path: "/artifacts/doc-ab12cd34",
      referrer: "news.ycombinator.com",
    })
  })

  it("records nothing for an organic signup (no cookie)", async () => {
    const res = await signUp(app, "organic@example.com")
    expect(res.status).toBe(200)
    const userId = (await res.json()).user.id as string
    expect(await meta.getSignupAttribution(userId)).toBeNull()
  })

  it("treats a garbage stamp as organic — signup still succeeds", async () => {
    const res = await signUp(app, "garbage@example.com", `${SRC_COOKIE}=%7Bnope`)
    expect(res.status).toBe(200)
    const userId = (await res.json()).user.id as string
    expect(await meta.getSignupAttribution(userId)).toBeNull()
  })

  it("a throwing attribution hook never blocks account creation", async () => {
    const res = await signUp(app2, "resilient@example.com", stamp({ k: "badge", p: "/" }))
    expect(res.status).toBe(200)
  })
})
