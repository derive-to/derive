import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"

// The remote MCP switcher: ONE OAuth login reaches every workspace the granting
// user belongs to. list_workspaces enumerates them; a `workspace` argument (id or
// name) on any tool re-homes that one call; and read/catch_up/comment even find a
// short_id in another workspace automatically. All of it validated against the
// owner's membership and fail-closed — the token already spans the workspaces, the
// tools just let the model use that in-band (no reconnect, no re-consent).

const dir = mkdtempSync(join(tmpdir(), "derive-mcp-ws-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// One grant (tok_ws → u_owner) and TWO workspaces the owner belongs to: ws_one
// (older → the grant's default) and ws_two "Derive" (the target to switch into).
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

type App = ReturnType<typeof createApp>

async function rpc(app: App, body: unknown) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer tok_ws",
    },
    body: JSON.stringify(body),
  })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  let parsed: { result?: unknown; error?: unknown } | null = null
  if (ct.includes("application/json")) parsed = JSON.parse(txt)
  else if (ct.includes("text/event-stream")) {
    const dataLine = txt.split("\n").find((l) => l.startsWith("data:"))
    if (dataLine) parsed = JSON.parse(dataLine.slice(5).trim())
  }
  return { status: res.status, parsed }
}

type RpcOut = Awaited<ReturnType<typeof rpc>>
const toolText = (r: RpcOut): string => {
  const t = (r.parsed?.result as { content?: { text: string }[] } | undefined)?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text in response: ${JSON.stringify(r.parsed)}`)
  return t
}
const call = (app: App, name: string, args: Record<string, unknown> = {}) =>
  rpc(app, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } })
const callJson = async (app: App, name: string, args: Record<string, unknown> = {}) =>
  JSON.parse(toolText(await call(app, name, args)))

describe.skipIf(process.env.DERIVE_TEST_DB === "pg")("remote MCP workspace switcher", () => {
  it("list_workspaces enumerates every workspace the login reaches, flagging the default", async () => {
    const { app } = twoWorkspaceApp("switch-list")
    const out = await callJson(app, "list_workspaces")
    expect(out.count).toBe(2)
    const byId = Object.fromEntries(out.workspaces.map((w: { id: string }) => [w.id, w]))
    expect(byId.ws_one).toMatchObject({ name: "First", default: true })
    expect(byId.ws_two).toMatchObject({ name: "Derive", default: false })
  })

  it("publish with `workspace` lands the new artifact in that workspace, not the default", async () => {
    const { app, meta } = twoWorkspaceApp("switch-publish")
    const created = await callJson(app, "publish", {
      title: "WS2 Doc",
      content: "<h1>lives in derive</h1>",
      workspace: "ws_two",
    })
    expect(created.published).toBe(true)
    expect((await meta.getByShortId(created.short_id))?.org_id).toBe("ws_two")

    // A default publish (no workspace) still lands in the grant's default (ws_one).
    const def = await callJson(app, "publish", { title: "WS1 Doc", content: "<h1>default</h1>" })
    expect((await meta.getByShortId(def.short_id))?.org_id).toBe("ws_one")
  })

  it("read finds a short_id in ANOTHER workspace automatically — and by explicit workspace (id or name)", async () => {
    const { app } = twoWorkspaceApp("switch-read")
    const created = await callJson(app, "publish", {
      title: "Cross Doc",
      content: "<h1>cross workspace</h1>",
      workspace: "ws_two",
    })
    const shortId = created.short_id

    // No workspace given: the default is ws_one, but read roams to ws_two by short_id.
    // read returns a Markdown frontmatter header + body (not JSON).
    const auto = toolText(await call(app, "read", { short_id: shortId }))
    expect(auto).toContain("title: Cross Doc")
    expect(auto).toContain("cross workspace")

    // Explicit by id and by name both work.
    expect(toolText(await call(app, "read", { short_id: shortId, workspace: "ws_two" }))).toContain(
      "title: Cross Doc",
    )
    expect(toolText(await call(app, "read", { short_id: shortId, workspace: "Derive" }))).toContain(
      "title: Cross Doc",
    )
  })

  it("list_artifacts scopes to the targeted workspace", async () => {
    const { app } = twoWorkspaceApp("switch-listarts")
    const created = await callJson(app, "publish", {
      title: "Only In Two",
      content: "<h1>x</h1>",
      workspace: "ws_two",
    })
    const inTwo = (id: string) => (a: { short_id: string }) => a.short_id === id

    // Default workspace (ws_one) doesn't see the ws_two artifact...
    const def = await callJson(app, "list_artifacts")
    expect(def.artifacts.some(inTwo(created.short_id))).toBe(false)
    // ...but targeting ws_two (by name) does.
    const two = await callJson(app, "list_artifacts", { workspace: "Derive" })
    expect(two.workspace).toBe("ws_two")
    expect(two.artifacts.some(inTwo(created.short_id))).toBe(true)
  })

  it("fails closed on a workspace the owner can't reach", async () => {
    const { app } = twoWorkspaceApp("switch-foreign")
    const created = await callJson(app, "publish", {
      title: "Doc",
      content: "<h1>x</h1>",
      workspace: "ws_two",
    })
    expect(toolText(await call(app, "list_artifacts", { workspace: "ws_nope" }))).toContain(
      "No workspace",
    )
    expect(
      toolText(await call(app, "read", { short_id: created.short_id, workspace: "ws_nope" })),
    ).toContain("No workspace")
  })

  // A GRANT SCOPED to a subset (the consent multi-select) clamps the whole MCP
  // surface: list_workspaces shows only the ticked set, and a workspace outside
  // the grant is invisible + unreachable even though the owner belongs to it.
  it("a grant scoped to ONE workspace hides + blocks the other over MCP", async () => {
    const { app, meta } = twoWorkspaceApp("switch-scoped-one")
    // The owner belongs to ws_one + ws_two, but scopes THIS grant to ws_two only.
    await meta.setOAuthClientWorkspaces("u_owner", "cli", ["ws_two"])

    // list_workspaces returns ONLY the granted workspace, and it's the default.
    const ws = await callJson(app, "list_workspaces")
    expect(ws.count).toBe(1)
    expect(ws.workspaces[0]).toMatchObject({ id: "ws_two", default: true })

    // Publishing (no workspace arg) lands in the grant's workspace, ws_two.
    const doc = await callJson(app, "publish", { title: "In grant", content: "<h1>x</h1>" })
    expect((await meta.getByShortId(doc.short_id))?.org_id).toBe("ws_two")

    // Targeting ws_one — a real workspace the owner belongs to, but OUTSIDE the
    // grant — is refused, not silently honored.
    expect(toolText(await call(app, "list_artifacts", { workspace: "ws_one" }))).toContain(
      "in this grant",
    )
    expect(
      toolText(await call(app, "read", { short_id: doc.short_id, workspace: "ws_one" })),
    ).toContain("in this grant")
  })

  it("a grant scoped to a 2-of-3 subset lists exactly those two", async () => {
    const { app, meta } = twoWorkspaceApp("switch-scoped-two")
    // Add a third workspace the owner belongs to, then scope the grant to 1 + 3.
    const db2 = new Database(join(dir, "switch-scoped-two.db"))
    db2
      .prepare(
        `INSERT INTO workspace(id,name,created_at) VALUES('ws_three','Third','2022-01-01T00:00:00.000Z')`,
      )
      .run()
    db2
      .prepare(
        `INSERT INTO membership(id,org_id,user_id,role,created_at) VALUES('m_three','ws_three','u_owner','owner','2022-01-01T00:00:00.000Z')`,
      )
      .run()
    db2.close()
    await meta.setOAuthClientWorkspaces("u_owner", "cli", ["ws_one", "ws_three"])

    const ws = await callJson(app, "list_workspaces")
    expect(ws.count).toBe(2)
    expect(ws.workspaces.map((w: { id: string }) => w.id).sort()).toEqual(["ws_one", "ws_three"])
    // ws_two is a real workspace of the owner's but outside the grant → unreachable.
    expect(toolText(await call(app, "list_artifacts", { workspace: "Derive" }))).toContain(
      "in this grant",
    )
  })
})
