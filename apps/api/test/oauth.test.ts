import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"

// The OAuth consent flow (Better Auth's oidc-provider) issues an access token; the
// API-side bridge resolves that token to a SCOPED agent that acts in the granting
// user's workspace. Here we inject a grant straight into the oidc-provider tables
// (what the real /authorize → /consent → /token dance would produce) and assert the
// bridge: scope maps to capability, identity is the client, and expiry is honored.

const dir = mkdtempSync(join(tmpdir(), "dock-oauth-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function appWithGrant(
  name: string,
  grant: { token: string; scopes: string; expiresAt: Date; client?: string },
) {
  const path = join(dir, `${name}.db`)
  const meta = new SqliteMetaStore(path) // creates Dock's own tables
  const db = new Database(path)
  // Minimal stand-ins for Better Auth's oidc-provider tables (only the columns the
  // bridge reads). The real plugin creates these via migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT);
    CREATE TABLE IF NOT EXISTS "oauthApplication" (clientId TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS "oauthAccessToken" (accessToken TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, accessTokenExpiresAt TEXT);
  `)
  db.prepare(
    `INSERT OR IGNORE INTO "user"(id,email,name) VALUES('u_o','owner@oauth.test','OAuth Owner')`,
  ).run()
  db.prepare(`INSERT OR IGNORE INTO "oauthApplication"(clientId,name) VALUES('cli',?)`).run(
    grant.client ?? "Claude",
  )
  db.prepare(
    `INSERT INTO "oauthAccessToken"(accessToken,clientId,userId,scopes,accessTokenExpiresAt) VALUES(?,?,?,?,?)`,
  ).run(grant.token, "cli", "u_o", grant.scopes, grant.expiresAt.toISOString())
  db.close()
  return createApp({
    meta,
    blobs: new FsBlobStore(join(dir, `${name}-blobs`)),
    baseUrl: "http://dock.test",
    token: "tok",
  })
}

const publish = (app: ReturnType<typeof createApp>, token: string) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode("<h1>x</h1>")]), "x.html")
  form.append("visibility", "link")
  return app.request("/v1/artifacts", {
    method: "POST",
    body: form,
    headers: { authorization: `Bearer ${token}` },
  })
}

describe("OAuth access token acts as a scoped agent", () => {
  const future = () => new Date(Date.now() + 3_600_000)

  it("a dock:publish grant publishes, authored by the client (not a person)", async () => {
    const app = appWithGrant("pub", {
      token: "tok_pub",
      scopes: "openid dock:publish",
      expiresAt: future(),
      client: "Claude",
    })
    const res = await publish(app, "tok_pub")
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.versions[0].author).toBe("Claude")
  })

  it("a propose-only grant cannot publish (least privilege)", async () => {
    const app = appWithGrant("prop", {
      token: "tok_prop",
      scopes: "openid dock:propose",
      expiresAt: future(),
    })
    expect((await publish(app, "tok_prop")).status).toBe(403)
  })

  it("an expired grant is rejected — the caller falls back to anonymous", async () => {
    const app = appWithGrant("exp", {
      token: "tok_exp",
      scopes: "openid dock:publish",
      expiresAt: new Date(Date.now() - 1000),
    })
    expect((await publish(app, "tok_exp")).status).toBe(403)
  })
})
