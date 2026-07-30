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
 * TWO DEPLOYMENTS, ONE DATABASE — the preview/staging contract.
 *
 * A preview Worker shares production's database on purpose (a preview you cannot sign into, or
 * that shows an empty library, proves nothing). Whether that works turns on one thing that is
 * easy to get wrong and fails in a thoroughly misleading way: sign-in SUCCEEDS with the wrong
 * secret, and the failure only appears on the next request.
 *
 * Better Auth encrypts the JWKS private key with DERIVE_AUTH_SECRET and stores it in the shared
 * database. A second deployment with a different secret cannot decrypt that row, and getSession
 * throws — so every signed-in page 500s while the login page looks perfectly healthy.
 *
 * Observed exactly this on a real preview Worker: /healthz 200, /readyz 200, sign-in 200,
 * /v1/artifacts 500. This test is why .github/workflows/pr-preview.yml refuses to deploy
 * without DERIVE_AUTH_SECRET, and why its comment says the value must MATCH production's.
 */
const dir = mkdtempSync(join(tmpdir(), "derive-shared-db-"))
const dbPath = join(dir, "auth.db")
const db = new Database(dbPath)
const BASE = "http://localhost:8080"

const PROD_SECRET = "prod-secret-0123456789abcdef"
const OTHER_SECRET = "other-secret-0123456789abcd"

const appWith = (secret: string) =>
  createApp({
    meta: new SqliteMetaStore(dbPath),
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: BASE,
    auth: makeAuth(db, BASE, secret),
  })

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie: "p=1" },
    body: JSON.stringify(body),
  })
const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")
const me = (app: ReturnType<typeof createApp>, cookie: string) =>
  app.request(`${BASE}/v1/me`, { headers: { origin: BASE, cookie } })

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("a second deployment on the same database", () => {
  const email = "shared@derive.test"
  const password = "initialPassw0rd"

  it("production creates the user and the encrypted jwks row", async () => {
    const prod = makeAuth(db, BASE, PROD_SECRET)
    await migrateAuth(prod)
    expect(
      (await post(appWith(PROD_SECRET), "/api/auth/sign-up/email", { email, password, name: "S" }))
        .status,
    ).toBe(200)
    // Force the row to exist — this is what a second deployment inherits.
    await prod.api.getJwks()
    expect((db.prepare("select count(*) as n from jwks").get() as { n: number }).n).toBeGreaterThan(
      0,
    )
  })

  it("SAME secret: signs in and reads the session — a preview works", async () => {
    const preview = appWith(PROD_SECRET)
    const signIn = await post(preview, "/api/auth/sign-in/email", { email, password })
    expect(signIn.status).toBe(200)
    const res = await me(preview, cookiesOf(signIn))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user: { email } })
  })

  it("DIFFERENT secret: signs in fine, then every authenticated request fails", async () => {
    const preview = appWith(OTHER_SECRET)
    // The trap: this succeeds, so a smoke test that stops at the login page reports healthy.
    const signIn = await post(preview, "/api/auth/sign-in/email", { email, password })
    expect(signIn.status).toBe(200)
    // And this does not.
    const res = await me(preview, cookiesOf(signIn))
    expect(res.status).toBe(500)
  })
})
