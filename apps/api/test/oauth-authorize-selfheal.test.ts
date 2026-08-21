import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { makeAuth, migrateAuth } from "../src/auth-config"

// Regression coverage for the "invalid_client / client_id is required" dead end
// (see reference_derive_oauth_stale_client_id): an agent (Claude.ai, another MCP
// client) holds a client_id from a DCR registration that no longer resolves —
// typically reaped by pruneStaleOAuthClients because its human never finished the
// browser consent — and keeps sending it. Without self-heal, /authorize dead-ends on
// the oauth-provider's generic error page with no recovery path visible to the
// human. The app.ts middleware re-registers a fresh client for the same
// redirect_uri and continues the flow transparently.

const dir = mkdtempSync(join(tmpdir(), "derive-oauth-selfheal-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const BASE = "http://localhost"
const REDIRECT = "http://localhost/cb"

async function freshApp(name: string) {
  const path = join(dir, `${name}.db`)
  const meta = new SqliteMetaStore(path)
  const db = new Database(path)
  db.pragma("journal_mode = WAL")
  const auth = makeAuth(db, BASE, "test-secret-0123456789-abcdefghijklmnopqrstuv")
  await migrateAuth(auth)
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, `${name}-blobs`)),
    baseUrl: BASE,
    auth,
  })
  return { app, meta, auth }
}

async function registerClient(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "RealClient", redirect_uris: [REDIRECT] }),
  })
  expect(res.status, "DCR should succeed").toBeLessThan(300)
  return ((await res.json()) as { client_id: string }).client_id
}

const authorizeUrl = (clientId: string) =>
  `/api/auth/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=openid+derive%3Aread` +
  `&state=xyz&code_challenge=abc123&code_challenge_method=S256`

describe("authorize self-heals a client_id that no longer resolves", () => {
  it("re-registers a fresh client and redirects under the new id instead of erroring", async () => {
    const { app, meta } = await freshApp("heal")

    const res = await app.request(authorizeUrl("ghost-client-that-was-pruned"), {
      redirect: "manual",
    })

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location") ?? "", BASE)
    expect(location.pathname).not.toBe("/api/auth/error")
    const newClientId = location.searchParams.get("client_id")
    expect(newClientId).toBeTruthy()
    expect(newClientId).not.toBe("ghost-client-that-was-pruned")
    await expect(meta.oauthClientExists(newClientId as string)).resolves.toBe(true)

    // Following the healed redirect must not loop back into another heal — the new
    // client_id now resolves, so the request proceeds into the real flow.
    const follow = await app.request(location.pathname + location.search, { redirect: "manual" })
    expect(follow.status).toBe(302)
    const followLocation = new URL(follow.headers.get("location") ?? "", BASE)
    expect(followLocation.pathname).not.toBe("/api/auth/error")
    expect(followLocation.searchParams.get("client_id") ?? newClientId).toBe(newClientId)
  })

  it("a real, still-registered client_id passes through unchanged", async () => {
    const { app } = await freshApp("real")
    const clientId = await registerClient(app)

    const res = await app.request(authorizeUrl(clientId), { redirect: "manual" })

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location") ?? "", BASE)
    expect(location.pathname).not.toBe("/api/auth/error")
    // Untouched: still the client we registered, not silently swapped.
    expect(location.searchParams.get("client_id") ?? clientId).toBe(clientId)
  })
})
