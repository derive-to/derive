import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { encryptSecret } from "../src/lib/crypto"
import { quotaApp, TEST_TOKEN } from "./helpers"

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` }

// The GitHub App webhook: reachable without a session (GitHub posts it), gated by
// the App webhook-secret HMAC instead. Exercises the anon allow-list, the App
// credential decrypt, the signature check, and the install-lifecycle mutation.
const KEY = "test-encryption-key"
const WHSEC = "whsec_dock_test"
const ORG = "ghwebhook"

const seedApp = async (meta: Awaited<ReturnType<typeof quotaApp>>["meta"]) => {
  await meta.setGithubApp({
    id: "default",
    app_id: "1",
    slug: "dock-test",
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
