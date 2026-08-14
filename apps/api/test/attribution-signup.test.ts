import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { makeAuth, migrateAuth } from "../src/auth-config"

// A real Better Auth signup followed by the same authenticated, cookieless source
// handoff the login page performs after password, social, or OIDC account creation.
const dir = mkdtempSync(join(tmpdir(), "derive-attr-signup-"))
const dbPath = join(dir, "auth.db")
const db = new Database(dbPath)
const meta = new SqliteMetaStore(dbPath)
const auth = makeAuth(db, "http://localhost:8080", "test-secret-0123456789abcd")
const app = createApp({
  meta,
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: "http://localhost:8080",
  auth,
})

beforeAll(() => migrateAuth(auth))
afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const signUp = (email: string) =>
  app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:8080" },
    body: JSON.stringify({ email, password: "password12345", name: "Tester" }),
  })

const sessionCookies = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .filter(Boolean)
    .join("; ")

const record = (cookie: string, body: object) =>
  app.request("/v1/me/signup-attribution", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:8080",
      cookie,
    },
    body: JSON.stringify(body),
  })

describe("signup attribution handoff", () => {
  it("records an explicit source after account creation, without d_src", async () => {
    const signup = await signUp("badge@example.com")
    expect(signup.status).toBe(200)
    expect(signup.headers.get("set-cookie")).not.toContain("d_src")
    const userId = (await signup.clone().json()).user.id as string

    const response = await record(sessionCookies(signup), {
      source_kind: "badge",
      source_artifact: "ab12cd34",
      landing_path: "/artifacts/doc-ab12cd34",
    })
    expect(response.status).toBe(200)
    expect(await meta.getSignupAttribution(userId)).toMatchObject({
      user_id: userId,
      source_kind: "badge",
      source_artifact: "ab12cd34",
      landing_path: "/artifacts/doc-ab12cd34",
      referrer: null,
    })
  })

  it("records nothing when an organic signup sends no source handoff", async () => {
    const signup = await signUp("organic@example.com")
    expect(signup.status).toBe(200)
    const userId = (await signup.json()).user.id as string
    expect(await meta.getSignupAttribution(userId)).toBeNull()
  })

  it("rejects malformed source input without changing the account", async () => {
    const signup = await signUp("garbage@example.com")
    const userId = (await signup.clone().json()).user.id as string
    const response = await record(sessionCookies(signup), { source_kind: "<script>" })
    expect(response.status).toBe(400)
    expect(await meta.getSignupAttribution(userId)).toBeNull()
  })

  it("keeps the first source when the browser retries", async () => {
    const signup = await signUp("retry@example.com")
    const userId = (await signup.clone().json()).user.id as string
    const cookie = sessionCookies(signup)
    expect((await record(cookie, { source_kind: "docs_home", landing_path: "/" })).status).toBe(200)
    expect((await record(cookie, { source_kind: "badge", landing_path: "/x" })).status).toBe(200)
    expect(await meta.getSignupAttribution(userId)).toMatchObject({
      source_kind: "docs_home",
      landing_path: "/",
    })
  })
})
