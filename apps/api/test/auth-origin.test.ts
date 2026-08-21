import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { makeAuth, migrateAuth } from "../src/auth-config"

// The same-origin trust in makeAuth. Better Auth rejects a sign-up/in whose Origin
// is not in trustedOrigins (CSRF defense). That check fires for real browsers
// (they send Sec-Fetch-* / cookies); a self-host reached at an origin that doesn't
// exactly match BASE_URL (port-mapped container, reverse proxy) would otherwise
// 403 INVALID_ORIGIN. We trust a request whose Origin equals the origin it was
// actually served on — a same-origin request is never CSRF — while a genuinely
// cross-site Origin stays rejected.
//
// The requests below carry the Fetch-Metadata headers a browser sends, so they hit
// the real CSRF path (validateOrigin) rather than the no-cookie/no-metadata
// short-circuit a bare programmatic POST would take.
const dir = mkdtempSync(join(tmpdir(), "derive-auth-origin-"))

// baseUrl is :8080, but the same-origin/cross-site requests are served at :8081 (a
// port-mapped host) — the exact mismatch that used to 403 on a real browser signup.
const dbPath = join(dir, "auth.db")
const db = new Database(dbPath)
const auth = makeAuth(db, "http://localhost:8080", "test-secret-0123456789abcd")
const app = createApp({
  meta: new SqliteMetaStore(dbPath),
  blobs: new FsBlobStore(join(dir, "blobs")),
  baseUrl: "http://localhost:8080",
  auth,
})

// A browser-shaped sign-up: served at `servedAt`, carrying `origin` and a cookie.
// Better Auth only runs the origin check on /sign-up/email when the request carries
// a cookie (the real SPA always does — the Better Auth client sets one), so the
// cookie is what arms the CSRF/origin check this fix lives behind.
const signUp = (servedAt: string, origin: string, email: string) =>
  app.request(`${servedAt}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      cookie: "derive_probe=1",
    },
    body: JSON.stringify({ email, password: "password12345", name: "Tester" }),
  })

beforeAll(async () => {
  await migrateAuth(auth)
})

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("auth: same-origin trust (self-host port/proxy mismatch)", () => {
  it("accepts a same-origin sign-up whose Origin matches the served origin, not BASE_URL", async () => {
    // Served at :8081, Origin :8081 (same-origin) — != BASE_URL :8080. Without the
    // same-origin trust this 403s; with it, the request is trusted.
    const res = await signUp("http://localhost:8081", "http://localhost:8081", "ok@derive.test")
    expect(res.status).toBe(200)
  })

  it("still rejects a genuinely cross-site Origin (CSRF stays blocked)", async () => {
    // Served at :8081, Origin evil.example (cross-site) — must 403.
    const res = await signUp("http://localhost:8081", "http://evil.example", "evil@derive.test")
    expect(res.status).toBe(403)
  })
})
