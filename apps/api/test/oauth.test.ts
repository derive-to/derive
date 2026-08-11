import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { oauthIssuerFor } from "../src/auth-config"
import { sha256 } from "../src/lib/crypto"

// The OAuth consent flow (Better Auth's oauth-provider) issues an opaque access
// token, stored hashed; the API-side bridge resolves it to a SCOPED agent that acts
// in the granting user's workspace. Here we inject a grant straight into the
// oauth-provider tables (what the real /authorize → /consent → /token dance would
// produce) and assert the bridge: scope maps to capability, identity is the client,
// and expiry is honored.

const dir = mkdtempSync(join(tmpdir(), "derive-oauth-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function appWithGrant(
  name: string,
  grant: { token: string; scopes: string; expiresAt: Date; client?: string },
) {
  const path = join(dir, `${name}.db`)
  const meta = new SqliteMetaStore(path) // creates Derive's own tables
  const db = new Database(path)
  // Minimal stand-ins for the oauth-provider tables (only the columns the bridge
  // reads). The token is stored hashed and scopes as a JSON array, mirroring the
  // real plugin; the bridge looks up by sha256 of the presented bearer.
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, profession TEXT, about TEXT);
    CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
  `)
  db.prepare(
    `INSERT OR IGNORE INTO "user"(id,email,name) VALUES('u_o','owner@oauth.test','OAuth Owner')`,
  ).run()
  db.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli',?)`).run(
    grant.client ?? "Claude",
  )
  db.prepare(
    `INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
  ).run(
    sha256(grant.token),
    "cli",
    "u_o",
    JSON.stringify(grant.scopes.split(/\s+/).filter(Boolean)),
    grant.expiresAt.toISOString(),
  )
  db.close()
  return createApp({
    meta,
    blobs: new FsBlobStore(join(dir, `${name}-blobs`)),
    baseUrl: "http://derive.test",
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

describe("the OAuth issuer identifier (RFC 9207)", () => {
  // A strict client compares the `iss` on an authorization response against the `issuer`
  // in the metadata it discovered, byte for byte, and refuses the callback on a mismatch.
  // Ours disagreed — the metadata advertised the origin, Better Auth stamped its own
  // baseURL (origin + /api/auth) — and only clients that check were affected, so the
  // surface looked healthy from every client we use ourselves.
  //
  // oauthIssuerFor is now the single derivation; auth-config stamps with it and
  // oauth-agent verifies with it. What this file can reach is the third site: the
  // metadata route. Note it derives from the REQUEST origin (deliberately — so a proxy
  // or workers.dev host is correct without configuration), while the stamp derives from
  // the configured baseUrl. They coincide when baseUrl is the origin clients reach,
  // which is the assumption oauthIssuerFor documents.
  it("is the bare origin, whatever shape baseUrl arrives in", () => {
    expect(oauthIssuerFor("https://derive.to")).toBe("https://derive.to")
    expect(oauthIssuerFor("https://derive.to/")).toBe("https://derive.to")
    // Better Auth's baseURL shape — the value that caused the mismatch — normalises away.
    expect(oauthIssuerFor("https://derive.to/api/auth")).toBe("https://derive.to")
    expect(oauthIssuerFor("http://localhost:8787")).toBe("http://localhost:8787")
  })

  it("is what the discovery metadata advertises, never a path-bearing form", async () => {
    const app = appWithGrant("issuer", {
      token: "tok_iss",
      scopes: "openid derive:read",
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    const discovery = await (await app.request("/.well-known/oauth-authorization-server")).json()

    // RFC 8414 derives the metadata URL from the issuer, so `${origin}/api/auth` would
    // belong at /.well-known/oauth-authorization-server/api/auth rather than here — a path
    // in this field breaks discovery even if the stamp agreed with it.
    expect(discovery.issuer).toBe(oauthIssuerFor(discovery.issuer))
    // The endpoints DO keep the basePath. That asymmetry is what made this easy to get
    // wrong, so pin it rather than leaving it to memory.
    expect(discovery.authorization_endpoint).toBe(`${discovery.issuer}/api/auth/oauth2/authorize`)
  })
})

describe("OAuth access token acts as a scoped agent", () => {
  const future = () => new Date(Date.now() + 3_600_000)

  it("a derive:publish grant publishes, authored by the granting human (not the client name)", async () => {
    // An OAuth agent (the `derive login` CLI, a remote MCP client) acts on behalf of the
    // user who consented, so its published work is attributed to that person — publishing
    // through the CLI reads the same as publishing in the browser, not as "Claude".
    const app = appWithGrant("pub", {
      token: "tok_pub",
      scopes: "openid derive:publish",
      expiresAt: future(),
      client: "Claude",
    })
    const res = await publish(app, "tok_pub")
    expect(res.status).toBe(201)
    const j = await res.json()
    expect(j.versions[0].author).toBe("OAuth Owner")
  })

  it("a propose-only grant cannot publish (least privilege)", async () => {
    const app = appWithGrant("prop", {
      token: "tok_prop",
      scopes: "openid derive:propose",
      expiresAt: future(),
    })
    expect((await publish(app, "tok_prop")).status).toBe(403)
  })

  it("an expired grant is rejected — the caller falls back to anonymous", async () => {
    const app = appWithGrant("exp", {
      token: "tok_exp",
      scopes: "openid derive:publish",
      expiresAt: new Date(Date.now() - 1000),
    })
    expect((await publish(app, "tok_exp")).status).toBe(403)
  })
})

describe("anonymous OAuth client reaper", () => {
  it("reaps only abandoned anonymous clients (keeps owned / consented / recent / with-token)", async () => {
    const path = join(dir, "reap.db")
    const meta = new SqliteMetaStore(path)
    const db = new Database(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, userId TEXT, createdAt TEXT);
      CREATE TABLE IF NOT EXISTS "oauthConsent" (clientId TEXT);
      CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT, clientId TEXT);
    `)
    const old = "2020-01-01T00:00:00.000Z"
    const ins = db.prepare(`INSERT INTO "oauthClient"(clientId,userId,createdAt) VALUES(?,?,?)`)
    ins.run("anon-old", null, old) // the only one that should be reaped
    ins.run("anon-recent", null, new Date().toISOString()) // too new
    ins.run("anon-consented", null, old) // a human consented
    ins.run("owned", "u_1", old) // registered by a signed-in user
    ins.run("anon-token", null, old) // holds a live token
    db.prepare(`INSERT INTO "oauthConsent"(clientId) VALUES('anon-consented')`).run()
    db.prepare(`INSERT INTO "oauthAccessToken"(token,clientId) VALUES('t','anon-token')`).run()
    db.close()

    const reaped = await meta.pruneStaleOAuthClients("2021-01-01T00:00:00.000Z")
    expect(reaped).toBe(1)

    const left = new Database(path)
    const ids = (
      left.prepare(`SELECT clientId FROM "oauthClient" ORDER BY clientId`).all() as {
        clientId: string
      }[]
    ).map((r) => r.clientId)
    left.close()
    expect(ids).toEqual(["anon-consented", "anon-recent", "anon-token", "owned"])
  })
})
