import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"
import { dir, pub } from "./helpers"

// `derive context push` end to end over OAuth: an access token with the
// derive:manage scope, held by a workspace admin, can mint the answering agent
// and create the context — attributed to the GRANTOR, exactly like publish.
// The two ceilings hold independently: no manage scope → 403 regardless of
// membership; manage scope but non-admin membership → 403 regardless of scope.
describe.skipIf(process.env.DERIVE_TEST_DB === "pg")("OAuth context management", () => {
  // One workspace; u_admin owns it, u_editor is an editor. Three grants:
  // tok_full (admin + manage), tok_nomanage (admin, publish-only scopes),
  // tok_editor (editor + manage).
  function managedApp(name: string) {
    const path = join(dir, `${name}.db`)
    const meta = new SqliteMetaStore(path)
    const db = new Database(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT);
      CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
    `)
    const user = db.prepare(`INSERT OR IGNORE INTO "user"(id,email,name) VALUES(?,?,?)`)
    user.run("u_admin", "admin@x.test", "Admin")
    user.run("u_editor", "editor@x.test", "Editor")
    db.prepare(
      `INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Derive CLI')`,
    ).run()
    const tok = db.prepare(
      `INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
    )
    const exp = new Date(Date.now() + 3_600_000).toISOString()
    const scopes = (list: string[]) => JSON.stringify(["openid", "derive:read", ...list])
    tok.run(sha256("tok_full"), "cli", "u_admin", scopes(["derive:publish", "derive:manage"]), exp)
    tok.run(sha256("tok_nomanage"), "cli", "u_admin", scopes(["derive:publish"]), exp)
    tok.run(
      sha256("tok_editor"),
      "cli",
      "u_editor",
      scopes(["derive:publish", "derive:manage"]),
      exp,
    )
    // ws_main is the grant default (oldest); ws_side exists to prove the
    // re-home cap: u_admin owns main but is only an editor over there.
    const ws = db.prepare(`INSERT INTO workspace(id,name,created_at) VALUES(?,?,?)`)
    ws.run("ws_main", "Main", "2020-01-01T00:00:00.000Z")
    ws.run("ws_side", "Side", "2021-01-01T00:00:00.000Z")
    const mem = db.prepare(
      `INSERT INTO membership(id,org_id,user_id,role,created_at) VALUES(?,?,?,?,?)`,
    )
    mem.run("m_admin", "ws_main", "u_admin", "owner", "2020-01-01T00:00:00.000Z")
    mem.run("m_editor", "ws_main", "u_editor", "editor", "2020-01-02T00:00:00.000Z")
    mem.run("m_side", "ws_side", "u_admin", "editor", "2021-01-01T00:00:00.000Z")
    db.close()
    const app = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, `${name}-blobs`)),
      baseUrl: "http://derive.test",
      token: "tok",
    })
    return { app, meta }
  }

  const auth = (t: string) => ({
    authorization: `Bearer ${t}`,
    "content-type": "application/json",
  })
  const mintAgent = (app: ReturnType<typeof managedApp>["app"], t: string, name = "Analytics") =>
    app.request("/v1/agents", { method: "POST", headers: auth(t), body: JSON.stringify({ name }) })

  it("the push flow: mint agent → publish manifest → create context, all one grant", async () => {
    const { app, meta } = managedApp("ctx-mgmt-flow")
    const ag = await mintAgent(app, "tok_full")
    expect(ag.status).toBe(201)
    const agent = (await ag.json()) as { id: string; token: string; created_at: string }
    expect(agent.token).toMatch(/^dk_agt_/)
    expect((await meta.listAgents("ws_main"))[0]?.created_by).toBe("u_admin") // the grantor

    const man = await pub(app, "# manifest", { title: "Analytics manifest" }, undefined, {
      authorization: "Bearer tok_full",
    })
    expect(man.status).toBe(201)
    const { short_id } = (await man.json()) as { short_id: string }

    const res = await app.request("/v1/contexts", {
      method: "POST",
      headers: auth("tok_full"),
      body: JSON.stringify({ name: "Analytics", agent_id: agent.id, manifest_short_id: short_id }),
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as { id: string; created_by: string }
    expect(created.created_by).toBe("u_admin")

    // The OAuth creator can also list and delete what it made.
    const list = await app.request("/v1/contexts", { headers: auth("tok_full") })
    expect(list.status).toBe(200)
    const del = await app.request(`/v1/contexts/${created.id}`, {
      method: "DELETE",
      headers: auth("tok_full"),
    })
    expect(del.status).toBe(204)
  })

  it("create accepts the run knobs (MCP parity) and persists them; out-of-range 400s", async () => {
    const { app, meta } = managedApp("ctx-mgmt-knobs")
    const man = await pub(app, "# manifest", { title: "M" }, undefined, {
      authorization: "Bearer tok_full",
    })
    const { short_id } = (await man.json()) as { short_id: string }
    const res = await app.request("/v1/contexts", {
      method: "POST",
      headers: auth("tok_full"),
      body: JSON.stringify({
        name: "Knobbed",
        manifest_short_id: short_id,
        max_run_ms: 120_000,
        max_concurrency: 3,
      }),
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as { id: string }
    expect(await meta.getContext(created.id)).toMatchObject({
      max_run_ms: 120_000,
      max_concurrency: 3,
    })
    // Same bounds as the MCP action: below the 30s lease floor is refused.
    const bad = await app.request("/v1/contexts", {
      method: "POST",
      headers: auth("tok_full"),
      body: JSON.stringify({ name: "Bad", manifest_short_id: short_id, max_run_ms: 1_000 }),
    })
    expect(bad.status).toBe(400)
  })

  it("no manage scope → 403, even for a workspace owner", async () => {
    const { app } = managedApp("ctx-mgmt-noscope")
    expect((await mintAgent(app, "tok_nomanage")).status).toBe(403)
  })

  it("a publish-only grant can't create contexts either — manage is the key, not publish", async () => {
    const { app } = managedApp("ctx-mgmt-pubonly")
    const res = await app.request("/v1/contexts", {
      method: "POST",
      headers: auth("tok_nomanage"),
      body: JSON.stringify({ name: "X", agent_id: "ag_x", manifest_short_id: "abc" }),
    })
    expect(res.status).toBe(401)
  })

  it("the minted runner token is a runtime principal: no context list/create/delete", async () => {
    // The exact stolen-runner-token scenario: the registrant (u_admin) created
    // the context, so a naive created_by match would hand its own agent the
    // delete. The routes must refuse the registered token outright.
    const { app } = managedApp("ctx-mgmt-runner")
    const agent = (await (await mintAgent(app, "tok_full")).json()) as {
      id: string
      token: string
    }
    const man = await pub(app, "# manifest", { title: "M" }, undefined, {
      authorization: "Bearer tok_full",
    })
    const { short_id } = (await man.json()) as { short_id: string }
    const created = (await (
      await app.request("/v1/contexts", {
        method: "POST",
        headers: auth("tok_full"),
        body: JSON.stringify({ name: "A", agent_id: agent.id, manifest_short_id: short_id }),
      })
    ).json()) as { id: string }

    const runner = auth(agent.token)
    expect((await app.request("/v1/contexts", { headers: runner })).status).toBe(401)
    const create = await app.request("/v1/contexts", {
      method: "POST",
      headers: runner,
      body: JSON.stringify({ name: "B", agent_id: agent.id, manifest_short_id: short_id }),
    })
    expect(create.status).toBe(401)
    const del = await app.request(`/v1/contexts/${created.id}`, {
      method: "DELETE",
      headers: runner,
    })
    expect(del.status).toBe(401)
    // Its runtime surface is untouched: the runner still reads its own wiring.
    const own = await app.request(`/v1/contexts/${created.id}`, { headers: runner })
    expect(own.status).toBe(200)
  })

  it("re-homing a manage grant re-caps by the target workspace's membership", async () => {
    const { app } = managedApp("ctx-mgmt-rehome")
    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { ...auth("tok_full"), "x-derive-workspace": "ws_side" },
      body: JSON.stringify({ name: "Side" }),
    })
    expect(res.status).toBe(403) // owner scope, but only editor over there
  })

  it("manage scope can't outrank the human: editor member → 403 on agents", async () => {
    const { app } = managedApp("ctx-mgmt-editor")
    expect((await mintAgent(app, "tok_editor")).status).toBe(403)
  })

  it("no human behind the request → no context: anon 403 (global gate), static token 401", async () => {
    const { app } = managedApp("ctx-mgmt-anon")
    const body = JSON.stringify({ name: "X", agent_id: "ag_x", manifest_short_id: "abc" })
    const anon = await app.request("/v1/contexts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
    expect(anon.status).toBe(403) // the /v1 anonymous-write gate, before the route
    // The static token is a principal but resolves to no human — created_by
    // would be nobody, so the route itself refuses.
    const tok = await app.request("/v1/contexts", { method: "POST", headers: auth("tok"), body })
    expect(tok.status).toBe(401)
  })
})
