import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"
import { dir } from "./helpers"

// OWNER-RUN + create_context over MCP: the owner who wires a context up serves it from
// the grant they already have — bare use({context}) pulls, use({session_id, answer})
// reports — and `automate create_context` stands the context up in the same
// conversation, no REST and no dk_agt_ handoff. The ceilings mirror the REST
// management surface (oauth-context-management.test.ts): run access needs the
// manage-grade (owner) seat AND a manage-grade scope; either missing → the call falls
// through to the give path exactly as before, so every other grant sees zero change.
describe.skipIf(process.env.DERIVE_TEST_DB === "pg")("MCP owner-run + create_context", () => {
  // One workspace; u_admin owns it, u_editor is an editor. Three grants:
  // tok_full (owner + manage), tok_nomanage (owner member, publish-only scopes),
  // tok_editor (editor member + manage scope).
  function ownerApp(name: string) {
    const path = join(dir, `${name}.db`)
    const meta = new SqliteMetaStore(path)
    const db = new Database(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, profession TEXT, about TEXT);
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
    const ws = db.prepare(`INSERT INTO workspace(id,name,created_at) VALUES(?,?,?)`)
    ws.run("ws_main", "Main", "2020-01-01T00:00:00.000Z")
    const mem = db.prepare(
      `INSERT INTO membership(id,org_id,user_id,role,created_at) VALUES(?,?,?,?,?)`,
    )
    mem.run("m_admin", "ws_main", "u_admin", "owner", "2020-01-01T00:00:00.000Z")
    mem.run("m_editor", "ws_main", "u_editor", "editor", "2020-01-02T00:00:00.000Z")
    db.close()
    const app = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, `${name}-blobs`)),
      baseUrl: "http://derive.test",
      token: "tok",
    })
    return { app, meta }
  }
  type App = ReturnType<typeof ownerApp>["app"]

  // A direct tools/call over the stateless /mcp endpoint (mcp-contexts' shape).
  const callRaw = async (
    app: App,
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ text: string; isError: boolean }> => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    })
    const ct = res.headers.get("content-type") ?? ""
    const txt = await res.text()
    const out = ct.includes("application/json")
      ? JSON.parse(txt)
      : JSON.parse(
          (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
        )
    const r = out?.result as { content?: { text: string }[]; isError?: boolean } | undefined
    const t = r?.content?.[0]?.text
    if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
    return { text: t, isError: !!r?.isError }
  }
  const call = async (
    app: App,
    token: string,
    name: string,
    args: Record<string, unknown> = {},
    // biome-ignore lint/suspicious/noExplicitAny: test convenience over a JSON payload
  ): Promise<any> => JSON.parse((await callRaw(app, token, name, args)).text)

  // Publish a manifest and create the context over MCP, all on the owner grant.
  const setupContext = async (app: App, name = "QA") => {
    const manifest = await call(app, "tok_full", "publish", {
      title: `${name} manifest`,
      content: `# ${name} manifest\nRun the checks.`,
    })
    const created = await call(app, "tok_full", "automate", {
      action: "create_context",
      name,
      manifest_short_id: manifest.short_id,
      max_run_ms: 120_000,
      max_concurrency: 2,
    })
    return { manifest, created }
  }

  it("create_context wires the context, persists knobs, and returns no token", async () => {
    const { app, meta } = ownerApp("own-create")
    const { created } = await setupContext(app)
    expect(created.context_id).toBeTruthy()
    expect(created.agent_id).toBeTruthy()
    expect(created.ask_policy).toBe("invited")
    expect(JSON.stringify(created)).not.toContain("dk_agt_")
    const row = await meta.getContext(created.context_id)
    expect(row).toMatchObject({
      name: "QA",
      org_id: "ws_main",
      max_run_ms: 120_000,
      max_concurrency: 2,
    })
    // The auto-minted agent is managed, editor-capped, attributed to the grantor.
    const agents = await meta.listAgents("ws_main")
    expect(agents.find((a) => a.id === created.agent_id)).toMatchObject({
      role: "editor",
      managed: 1,
      created_by: "u_admin",
    })
  })

  it("create_context refuses non-owner grants and bad manifests; a dup name unwinds the mint", async () => {
    const { app, meta } = ownerApp("own-create-gates")
    // Owner seat but publish-only scope → the grant caps to editor → refused.
    const noScope = await call(app, "tok_nomanage", "automate", {
      action: "create_context",
      name: "QA",
      manifest_short_id: "zzzzzzzz",
    })
    expect(noScope.error).toContain("owner")
    // Manage scope but editor seat → same refusal.
    const noSeat = await call(app, "tok_editor", "automate", {
      action: "create_context",
      name: "QA",
      manifest_short_id: "zzzzzzzz",
    })
    expect(noSeat.error).toContain("owner")
    // Owner, but the manifest doesn't exist.
    const noManifest = await call(app, "tok_full", "automate", {
      action: "create_context",
      name: "QA",
      manifest_short_id: "zzzzzzzz",
    })
    expect(noManifest.error).toContain("manifest")
    // A duplicate name errors and unwinds its auto-mint (no orphaned agent).
    const { manifest } = await setupContext(app)
    const before = (await meta.listAgents("ws_main")).length
    const dup = await call(app, "tok_full", "automate", {
      action: "create_context",
      name: "QA",
      manifest_short_id: manifest.short_id,
    })
    expect(dup.error).toContain("already exists")
    expect((await meta.listAgents("ws_main")).length).toBe(before)
  })

  it("owner-run: give, pull, stream progress, settle — one grant end to end", async () => {
    const { app, meta } = ownerApp("own-loop")
    const { created } = await setupContext(app)
    // Empty queue: a bare use({context}) is the runner pull, not a give error — and
    // it says the queue is empty rather than returning a bare zero.
    const empty = await call(app, "tok_full", "use", { context: "QA" })
    expect(empty.claimed).toBe(0)
    expect(empty.note).toContain("Nothing queued")
    // GIVE on the same grant (ask_policy invited admits the creator).
    const opened = await call(app, "tok_full", "use", {
      context: "QA",
      instruction: "Run the smoke suite.",
      wait: 0,
    })
    expect(opened.state).toBe("open")
    // PULL: the session comes back claimed, transcript intact.
    const pulled = await call(app, "tok_full", "use", { context: "QA" })
    expect(pulled.claimed).toBe(1)
    expect(pulled.sessions[0]).toMatchObject({ session_id: opened.session_id, state: "working" })
    expect(pulled.sessions[0].messages.at(-1).body_md).toContain("smoke suite")
    // Progress tick: stays working, streams to the asker's check.
    const tick = await call(app, "tok_full", "use", {
      session_id: opened.session_id,
      answer: "SMK-1 passed, 5 to go.",
      progress: true,
    })
    expect(tick.state).toBe("working")
    const watching = await call(app, "tok_full", "use", { session_id: opened.session_id, wait: 0 })
    expect(watching.state).toBe("working")
    expect(watching.progress.body_md).toContain("SMK-1")
    // Settle with a result artifact bound; the give side collects the answer.
    const report = await call(app, "tok_full", "publish", {
      title: "QA run report",
      content: "# QA run\n6/6 passing.",
    })
    const settled = await call(app, "tok_full", "use", {
      session_id: opened.session_id,
      answer: "6/6 passing.",
      result_artifact_id: report.short_id,
    })
    expect(settled.state).toBe("answered")
    expect(settled.result_url).toContain(report.short_id)
    const collected = await call(app, "tok_full", "use", { session_id: opened.session_id, wait: 0 })
    expect(collected.state).toBe("answered")
    expect(collected.answer.body_md).toBe("6/6 passing.")
    // The agent turns are attributed to the HUMAN who ran them, not a synthetic agent.
    const transcript = await meta.listSessionMessages(opened.session_id)
    const agentTurns = transcript.filter((m) => m.author_kind === "agent")
    expect(agentTurns.length).toBe(2)
    for (const m of agentTurns) expect(m.author_id).toBe("u_admin")
    // The context's created agent never served: the claim + answers were owner-run.
    expect(agentTurns.some((m) => m.author_id === created.agent_id)).toBe(false)
  })

  it("a give on an unserved queue steers the owner to owner-run, not to waiting", async () => {
    const { app } = ownerApp("own-steer")
    await setupContext(app)
    // No runner has ever polled: the owner who queued the work is told they can
    // serve it themselves (a registered agent or non-owner keeps the wait text —
    // covered in mcp-contexts' offline-note test).
    const opened = await call(app, "tok_full", "use", {
      context: "QA",
      instruction: "Run the smoke suite.",
      wait: 0,
    })
    expect(opened.state).toBe("open")
    expect(opened.note).toContain("serve it yourself")
    expect(opened.note).toContain('use({context: "QA"})')
  })

  it("non-owner grants fall through to the give path unchanged", async () => {
    const { app } = ownerApp("own-fallthrough")
    await setupContext(app)
    // Editor seat + manage scope: bare use({context}) is NOT a pull — it falls through
    // to the give path's instruction error, exactly the pre-owner-run behavior.
    const editor = await callRaw(app, "tok_editor", "use", { context: "QA" })
    expect(editor.isError).toBe(true)
    expect(editor.text).toContain("instruction")
    // Owner seat + publish-only scope: the scope caps the role — same fallthrough.
    const noScope = await callRaw(app, "tok_nomanage", "use", { context: "QA" })
    expect(noScope.isError).toBe(true)
    expect(noScope.text).toContain("instruction")
    // A report-shaped call on a session that isn't theirs to run reads as a missing
    // session (the check path), never a runner surface.
    const opened = await call(app, "tok_full", "use", {
      context: "QA",
      instruction: "Q?",
      wait: 0,
    })
    const probe = await callRaw(app, "tok_editor", "use", {
      session_id: opened.session_id,
      answer: "hijack",
    })
    expect(probe.isError).toBe(true)
    expect(probe.text).toContain("No session")
  })
})
