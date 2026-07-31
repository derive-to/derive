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
 * database. A second deployment with a different secret cannot decrypt that row.
 *
 * Observed on a real preview Worker: /healthz 200, /readyz 200, sign-in 200, /v1/artifacts 500.
 * This test is why .github/workflows/pr-preview.yml refuses to deploy without
 * DERIVE_AUTH_SECRET, and why its comment says the value must MATCH production's.
 *
 * WHAT CHANGED, AND WHY THIS TEST NOW ASSERTS SOMETHING DIFFERENT. Session validation never
 * actually needed the JWKS row. It was reached because the `jwt()` plugin's /get-session
 * after-hook minted a JWT on every authenticated request — for a `set-auth-jwt` header no
 * client here consumes — and that mint had to decrypt the private key. Disabling that hook
 * (see auth-config.ts, a ~80ms Hyperdrive read removed from every signed-in request) decouples
 * the two: a deployment with a mismatched secret now serves its OWN sessions normally.
 *
 * That is the correct behaviour, not a weakening, and the test below proves the part that
 * matters: a cookie minted by one deployment is still REJECTED by the other, because session
 * cookies are signed with each deployment's own secret. Cross-deployment session forgery was
 * never what the old 401 prevented — it was an unrelated decrypt failure aborting getSession.
 *
 * The operational cost is real and worth stating: the mismatch no longer announces itself on
 * the first signed-in request. It now surfaces only where the shared JWKS genuinely matters —
 * OAuth token minting and MCP JWT verification. A preview with the wrong secret will therefore
 * look healthy while browsing and fail later, so the workflow's insistence on a matching secret
 * carries more weight than before, not less.
 */
const dir = mkdtempSync(join(tmpdir(), "derive-shared-db-"))
const dbPath = join(dir, "auth.db")
const db = new Database(dbPath)
const BASE = "http://localhost:8080"

// Two throwaway values standing in for two deployments' DERIVE_AUTH_SECRETs. Marked for the
// secret scanner: the names are what trip its generic-api-key rule, and renaming them to satisfy
// a scanner would cost the thing that makes this test readable.
const PROD_SECRET = "prod-secret-at-least-16-chars" // gitleaks:allow
const OTHER_SECRET = "other-secret-at-least-16-chars" // gitleaks:allow

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

  it("DIFFERENT secret: serves its own sessions — session auth does not depend on the shared JWKS", async () => {
    const preview = appWith(OTHER_SECRET)
    const signIn = await post(preview, "/api/auth/sign-in/email", { email, password })
    expect(signIn.status).toBe(200)
    // Signing in here is a real authentication: the caller presented this account's password to
    // THIS deployment, and got back a cookie signed with THIS deployment's secret. Reading that
    // session back must therefore work. It previously 401'd, but not for any reason to do with
    // the caller's credentials — the jwt plugin's per-request JWT mint could not decrypt the
    // shared JWKS row, and that failure aborted getSession. That coupling is gone.
    const res = await me(preview, cookiesOf(signIn))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ user: { email } })
  })

  it("a cookie minted by one deployment is still rejected by the other", async () => {
    // The property that actually protects anything, and the one to keep asserting: sessions do
    // not cross the secret boundary. Better Auth signs the session cookie with the deployment's
    // own secret, so a cookie minted under PROD_SECRET carries no authority under OTHER_SECRET —
    // independently of anything JWKS-related.
    const signInOnProd = await post(appWith(PROD_SECRET), "/api/auth/sign-in/email", {
      email,
      password,
    })
    expect(signInOnProd.status).toBe(200)
    const stolen = cookiesOf(signInOnProd)
    expect((await me(appWith(OTHER_SECRET), stolen)).status).toBe(401)
    // …and the same cookie still works on the deployment that issued it, so the 401 above is the
    // secret boundary doing its job rather than the cookie simply being malformed.
    expect((await me(appWith(PROD_SECRET), stolen)).status).toBe(200)
  })
})
