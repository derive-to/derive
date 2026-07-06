import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"
import { dir, pub, quotaApp } from "./helpers"

// Where an OAuth agent acts, in precedence order: the X-Derive-Workspace header
// (per-request), the consent screen's (user, client) binding, then the granting
// user's first workspace. Every step is validated against the OWNER's membership
// and fails closed to the next.
describe.skipIf(process.env.DERIVE_TEST_DB === "pg")("OAuth agent workspace targeting", () => {
  // One OAuth grant (tok_ws → u_owner) and TWO workspaces the owner belongs to:
  // ws_one (older, the grant's default) and ws_two (the intended target).
  function twoWorkspaceApp(name: string) {
    const path = join(dir, `${name}.db`)
    const meta = new SqliteMetaStore(path)
    const db = new Database(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT);
      CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
    `)
    db.prepare(
      `INSERT OR IGNORE INTO "user"(id,email,name) VALUES('u_owner','owner@x.test','Owner')`,
    ).run()
    db.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Claude')`).run()
    db.prepare(
      `INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
    ).run(
      sha256("tok_ws"),
      "cli",
      "u_owner",
      JSON.stringify(["openid", "derive:read", "derive:publish", "derive:comment"]),
      new Date(Date.now() + 3_600_000).toISOString(),
    )
    // Distinct created_at so listWorkspaces ordering (asc) is deterministic.
    db.prepare(`INSERT INTO workspace(id,name,created_at) VALUES(?,?,?)`).run(
      "ws_one",
      "First",
      "2020-01-01T00:00:00.000Z",
    )
    db.prepare(`INSERT INTO workspace(id,name,created_at) VALUES(?,?,?)`).run(
      "ws_two",
      "Derive",
      "2021-01-01T00:00:00.000Z",
    )
    const mem = db.prepare(
      `INSERT INTO membership(id,org_id,user_id,role,created_at) VALUES(?,?,?,?,?)`,
    )
    mem.run("m_one", "ws_one", "u_owner", "owner", "2020-01-01T00:00:00.000Z")
    mem.run("m_two", "ws_two", "u_owner", "owner", "2021-01-01T00:00:00.000Z")
    db.close()
    const app = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, `${name}-blobs`)),
      baseUrl: "http://derive.test",
      token: "tok",
    })
    return { app, meta }
  }

  const bearer = { authorization: "Bearer tok_ws" }

  it("publishes into the grant's default workspace without the header", async () => {
    const { app, meta } = twoWorkspaceApp("ws-target-default")
    const res = await pub(app, "<h1>plan</h1>", { title: "Plan" }, undefined, bearer)
    expect(res.status).toBe(201)
    const { short_id } = (await res.json()) as { short_id: string }
    expect((await meta.getByShortId(short_id))?.org_id).toBe("ws_one")
  })

  it("X-Derive-Workspace targets another workspace the owner belongs to", async () => {
    const { app, meta } = twoWorkspaceApp("ws-target-header")
    const res = await pub(app, "<h1>plan</h1>", { title: "Plan" }, undefined, {
      ...bearer,
      "x-derive-workspace": "ws_two",
    })
    expect(res.status).toBe(201)
    const { short_id } = (await res.json()) as { short_id: string }
    expect((await meta.getByShortId(short_id))?.org_id).toBe("ws_two")

    // authorize() must agree with the override: commenting on the artifact just
    // published into ws_two works through the same header (this 403'd when the
    // override lived only in activeWorkspace and not on the agent record).
    const cm = await app.request(`/v1/artifacts/${short_id}/comments`, {
      method: "POST",
      headers: { ...bearer, "x-derive-workspace": "ws_two", "content-type": "application/json" },
      body: JSON.stringify({ body_md: "anchored question" }),
    })
    expect(cm.status).toBe(201)
  })

  it("fails closed: a workspace the owner is NOT a member of keeps the default", async () => {
    const { app, meta } = twoWorkspaceApp("ws-target-foreign")
    const res = await pub(app, "<h1>plan</h1>", { title: "Plan" }, undefined, {
      ...bearer,
      "x-derive-workspace": "ws_nope",
    })
    expect(res.status).toBe(201)
    const { short_id } = (await res.json()) as { short_id: string }
    expect((await meta.getByShortId(short_id))?.org_id).toBe("ws_one")
  })

  it("GET /v1/workspaces lists the granting user's workspaces for an OAuth agent", async () => {
    const { app } = twoWorkspaceApp("ws-target-list")
    const res = await app.request("/v1/workspaces", { headers: bearer })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workspaces: { id: string; name: string }[] }
    expect(body.workspaces.map((w) => w.id)).toEqual(["ws_one", "ws_two"])
  })

  // ---- Consent-time workspace binding (the consent screen's picker) ----------

  it("a consent-time binding re-points the grant's default workspace", async () => {
    const { app, meta } = twoWorkspaceApp("ws-bind-default")
    await meta.setOAuthClientWorkspace("u_owner", "cli", "ws_two")
    const res = await pub(app, "<h1>plan</h1>", { title: "Plan" }, undefined, bearer)
    expect(res.status).toBe(201)
    const { short_id } = (await res.json()) as { short_id: string }
    expect((await meta.getByShortId(short_id))?.org_id).toBe("ws_two")
  })

  it("a binding to a workspace the owner has left falls back to the first", async () => {
    const { app, meta } = twoWorkspaceApp("ws-bind-stale")
    await meta.setOAuthClientWorkspace("u_owner", "cli", "ws_gone")
    const res = await pub(app, "<h1>plan</h1>", { title: "Plan" }, undefined, bearer)
    expect(res.status).toBe(201)
    const { short_id } = (await res.json()) as { short_id: string }
    expect((await meta.getByShortId(short_id))?.org_id).toBe("ws_one")
  })

  it("X-Derive-Workspace still overrides a consent-time binding", async () => {
    const { app, meta } = twoWorkspaceApp("ws-bind-header")
    await meta.setOAuthClientWorkspace("u_owner", "cli", "ws_two")
    const res = await pub(app, "<h1>plan</h1>", { title: "Plan" }, undefined, {
      ...bearer,
      "x-derive-workspace": "ws_one",
    })
    expect(res.status).toBe(201)
    const { short_id } = (await res.json()) as { short_id: string }
    expect((await meta.getByShortId(short_id))?.org_id).toBe("ws_one")
  })

  it("re-consent re-points the binding (upsert on user+client)", async () => {
    const { meta } = twoWorkspaceApp("ws-bind-upsert")
    await meta.setOAuthClientWorkspace("u_owner", "cli", "ws_one")
    await meta.setOAuthClientWorkspace("u_owner", "cli", "ws_two")
    expect(await meta.getOAuthClientWorkspace("u_owner", "cli")).toBe("ws_two")
  })

  // ---- POST /oauth/consent/workspace (the picker's persistence endpoint) ----

  it("the binding endpoint requires same-origin, a session, and membership", async () => {
    const amy = { id: "u_amy", email: "amy@x.test", name: "Amy" }
    const { app, meta } = quotaApp(
      "ws-bind-endpoint",
      {},
      [amy],
      [{ user_id: "u_amy", role: "editor" }],
    )
    const sameOrigin = { origin: "http://localhost" } // hono's app.request base
    const post = (headers: Record<string, string>, orgId: string) =>
      app.request("/oauth/consent/workspace", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ client_id: "cli", org_id: orgId }),
      })
    const asAmy = { ...sameOrigin, "x-test-user": "amy@x.test" }

    // Cross-site posts carry a foreign Origin (or none, from a text/plain form):
    // both refused even with a live session, since SameSite=None deployments
    // would otherwise let a hostile page rebind a victim's client.
    expect((await post({ "x-test-user": "amy@x.test" }, "default")).status).toBe(403)
    const evil = { ...asAmy, origin: "https://evil.example" }
    expect((await post(evil, "default")).status).toBe(403)

    expect((await post(sameOrigin, "default")).status).toBe(401) // no session
    expect((await post(asAmy, "ws_foreign")).status).toBe(403) // not a member
    expect(await meta.getOAuthClientWorkspace("u_amy", "cli")).toBeNull()

    expect((await post(asAmy, "default")).status).toBe(200)
    expect(await meta.getOAuthClientWorkspace("u_amy", "cli")).toBe("default")
  })

  it("the consent screen preselects an existing binding over the active workspace", async () => {
    const amy = { id: "u_amy", email: "amy@x.test", name: "Amy" }
    const { app, meta } = quotaApp(
      "ws-bind-preselect",
      {},
      [amy],
      [{ user_id: "u_amy", role: "editor" }],
    )
    await meta.setOAuthClientWorkspace("u_amy", "cli", "default")
    const res = await app.request("/oauth/consent?client_id=cli&scope=openid", {
      headers: { "x-test-user": "amy@x.test" },
    })
    expect(res.status).toBe(200)
    const page = await res.text()
    expect(page).toContain('value="default" selected')
  })
})
