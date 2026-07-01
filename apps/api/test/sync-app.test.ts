import { createHmac, generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { encryptSecret, signState } from "../src/lib/crypto"
import { quotaApp, TEST_TOKEN } from "./helpers"

// A real RSA key (PKCS#1, as GitHub's manifest returns) so appJwt/getAppInfo can
// actually sign during the auto-heal check.
const { privateKey: RSA_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` }

// The GitHub App webhook: reachable without a session (GitHub posts it), gated by
// the App webhook-secret HMAC instead. Exercises the anon allow-list, the App
// credential decrypt, the signature check, and the install-lifecycle mutation.
const KEY = "test-encryption-key"
const WHSEC = "whsec_derive_test"
const ORG = "ghwebhook"

const seedApp = async (meta: Awaited<ReturnType<typeof quotaApp>>["meta"]) => {
  await meta.setGithubApp({
    id: "default",
    app_id: "1",
    slug: "derive-test",
    client_id: "Iv1.x",
    client_secret: encryptSecret("cs", KEY),
    private_key: encryptSecret(
      "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
      KEY,
    ),
    webhook_secret: encryptSecret(WHSEC, KEY),
    created_at: "2026-06-15T00:00:00.000Z",
  })
}

const signed = (body: string) => `sha256=${createHmac("sha256", WHSEC).update(body).digest("hex")}`

const postWebhook = (
  app: ReturnType<typeof quotaApp>["app"],
  event: string,
  payload: unknown,
  signature?: string,
) => {
  const body = JSON.stringify(payload)
  return app.request("/v1/sync/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      ...(signature === null ? {} : { "x-hub-signature-256": signature ?? signed(body) }),
    },
    body,
  })
}

describe("github app webhook", () => {
  it("rejects a bad signature without touching state", async () => {
    const { app, meta } = quotaApp("ghwebhook", { encryptionKey: KEY })
    await seedApp(meta)
    await meta.upsertGithubInstallation({
      installation_id: "77",
      org_id: ORG,
      account_login: "acme",
      created_by: "u",
      created_at: "2026-06-15T00:00:00.000Z",
    })
    const res = await postWebhook(
      app,
      "installation",
      { action: "deleted", installation: { id: 77 } },
      "sha256=bad",
    )
    expect(res.status).toBe(401)
    // Untouched.
    expect(await meta.getGithubInstallation("77")).not.toBeNull()
  })

  it("drops the installation on a correctly-signed installation.deleted", async () => {
    const { app, meta } = quotaApp("ghwebhook2", { encryptionKey: KEY })
    await seedApp(meta)
    await meta.upsertGithubInstallation({
      installation_id: "88",
      org_id: "ghwebhook2",
      account_login: "acme",
      created_by: "u",
      created_at: "2026-06-15T00:00:00.000Z",
    })
    const res = await postWebhook(app, "installation", {
      action: "deleted",
      installation: { id: 88 },
    })
    expect(res.status).toBe(200)
    expect(await meta.getGithubInstallation("88")).toBeNull()
  })

  it("404s the webhook when no App is configured", async () => {
    const { app } = quotaApp("ghwebhook3", { encryptionKey: KEY })
    const res = await postWebhook(app, "push", { ref: "refs/heads/main" })
    expect(res.status).toBe(404)
  })
})

describe("github app status + install gating", () => {
  it("reports app not configured and refuses install until set up", async () => {
    const { app } = quotaApp("ghstatus", { encryptionKey: KEY })
    const statusRes = await app.request("/v1/sync/github", { headers: AUTH })
    const status = (await statusRes.json()) as { app: { configured: boolean } }
    expect(status.app).toEqual({ configured: false })

    const install = await app.request("/v1/sync/github/install", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: "{}",
    })
    expect(install.status).toBe(409)
  })
})

// The post-install handshake: GitHub redirects the browser to our callback with
// installation_id + the state we signed at the start. The binding to a workspace
// comes from that signed state, never the session.
describe("github app install callback", () => {
  it("records the installation from signed state and redirects to the picker", async () => {
    const { app, meta } = quotaApp("ghcb", { encryptionKey: KEY })
    const state = signState({ org: "default", uid: "u1" }, KEY)
    const res = await app.request(
      `/v1/sync/github/callback?installation_id=991&state=${encodeURIComponent(state)}`,
    )
    expect(res.status).toBe(302)
    const loc = res.headers.get("location") ?? ""
    expect(loc).toContain("/settings?tab=github")
    expect(loc).toContain("gh_install=991")
    expect(await meta.getGithubInstallation("991")).toMatchObject({ org_id: "default" })
  })

  it("rejects a forged/expired state without recording anything", async () => {
    const { app, meta } = quotaApp("ghcb2", { encryptionKey: KEY })
    const res = await app.request("/v1/sync/github/callback?installation_id=992&state=bogus")
    expect(res.status).toBe(302)
    expect(res.headers.get("location") ?? "").toContain("gh_error=install_expired")
    expect(await meta.getGithubInstallation("992")).toBeNull()
  })

  // Direct install on GitHub (setup_url fires with NO state): fall back to the
  // session's workspace so the install is still recorded, not dropped.
  it("records a stateless (direct GitHub) install against the session workspace", async () => {
    const { app, meta } = quotaApp("ghcb3", { encryptionKey: KEY })
    const res = await app.request("/v1/sync/github/callback?installation_id=993")
    expect(res.status).toBe(302)
    const loc = res.headers.get("location") ?? ""
    expect(loc).toContain("gh_install=993")
    expect(await meta.getGithubInstallation("993")).toMatchObject({ org_id: "default" })
  })
})

// Auto-heal: a configured App the owner deleted on GitHub must report as
// unconfigured so the UI re-offers setup instead of a dead Install link.
describe("github app auto-heal (GET /app verification)", () => {
  afterEach(() => vi.unstubAllGlobals())
  const seedLiveApp = (meta: ReturnType<typeof quotaApp>["meta"]) =>
    meta.setGithubApp({
      id: "default",
      app_id: "55",
      slug: "derive-test",
      client_id: "x",
      client_secret: encryptSecret("cs", KEY),
      private_key: encryptSecret(RSA_PEM, KEY),
      webhook_secret: encryptSecret(WHSEC, KEY),
      created_at: "2026-06-15T00:00:00.000Z",
    })
  // GET /app stub. `perms`/`events` default to Derive's full required set so a
  // healthy App reports upToDate; pass partial sets to exercise the diff.
  const stubGetApp = (
    status: number,
    perms: Record<string, string> = {
      contents: "read",
      metadata: "read",
      pull_requests: "write",
    },
    events: string[] = ["push", "pull_request", "issue_comment", "pull_request_review_comment"],
  ) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/app")
          ? new Response(
              JSON.stringify({ slug: "derive-test", html_url: "x", permissions: perms, events }),
              { status },
            )
          : new Response("nf", { status: 404 }),
      ),
    )
  const statusApp = async (app: ReturnType<typeof quotaApp>["app"]) =>
    (await (await app.request("/v1/sync/github", { headers: AUTH })).json()) as {
      app: {
        configured: boolean
        slug?: string
        upToDate?: boolean
        missing?: { permissions: Record<string, string>; events: string[] }
      }
    }

  it("stays configured + up to date while GitHub has the App with all perms", async () => {
    const { app, meta } = quotaApp("ghheal", { encryptionKey: KEY })
    await seedLiveApp(meta)
    stubGetApp(200)
    const { app: a } = await statusApp(app)
    expect(a).toMatchObject({ configured: true, slug: "derive-test", upToDate: true })
    expect(a.missing).toEqual({ permissions: {}, events: [] })
  })

  it("flags a missing permission/event in the diff", async () => {
    const { app, meta } = quotaApp("ghheal-diff", { encryptionKey: KEY })
    await seedLiveApp(meta)
    // App only has metadata:read — missing contents, pull_requests, all events.
    stubGetApp(200, { metadata: "read" }, [])
    const { app: a } = await statusApp(app)
    expect(a.upToDate).toBe(false)
    expect(a.missing?.permissions).toMatchObject({ contents: "read", pull_requests: "write" })
    expect(a.missing?.events).toEqual([
      "push",
      "pull_request",
      "issue_comment",
      "pull_request_review_comment",
    ])
  })

  it("reports unconfigured once the App is deleted on GitHub (404)", async () => {
    const { app, meta } = quotaApp("ghheal2", { encryptionKey: KEY })
    await seedLiveApp(meta)
    stubGetApp(404)
    expect((await statusApp(app)).app).toEqual({ configured: false })
  })
})
