import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { type Backplane, createInProcessBackplane, type DeriveEvent } from "../src/bus"
import { sha256 } from "../src/lib/crypto"

// The strong MCP loop, server side: an agent publish must reach the human's open
// tabs (version.published on the artifact channel, artifact.pushed + a bell row on
// the user channel, opened_in_tab receipt in the tool result), and catch_up's
// `wait` must block until the human acts (send back / approve / comment) instead
// of the agent polling on a cadence.

const dir = mkdtempSync(join(tmpdir(), "derive-mcp-loop-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// Same harness as mcp.test.ts (OAuth grant seeded straight into the provider
// tables), plus an injected in-process backplane the test can observe.
function loopApp(name: string) {
  const path = join(dir, `${name}.db`)
  const meta = new SqliteMetaStore(path)
  const db = new Database(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, profession TEXT, about TEXT);
    CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
  `)
  db.prepare(
    `INSERT OR IGNORE INTO "user"(id,email,name) VALUES('u_o','owner@x.test','Owner')`,
  ).run()
  db.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Claude')`).run()
  db.prepare(
    `INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
  ).run(
    sha256(`tok_${name}`),
    "cli",
    "u_o",
    JSON.stringify(["openid", "derive:read", "derive:publish"]),
    new Date(Date.now() + 3_600_000).toISOString(),
  )
  db.close()
  const backplane = createInProcessBackplane()
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, `${name}-blobs`)),
    baseUrl: "http://derive.test",
    token: "tok",
    backplane,
  })
  return { app, meta, backplane, token: `tok_${name}` }
}

type App = ReturnType<typeof createApp>

async function rpc(app: App, token: string, body: unknown) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  if (ct.includes("application/json")) return JSON.parse(txt)
  const dataLine = txt.split("\n").find((l) => l.startsWith("data:"))
  return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null
}

const call = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
  const out = await rpc(app, token, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  })
  const t = (out?.result as { content?: { text: string }[] } | undefined)?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
  return JSON.parse(t)
}

const record = (bp: Backplane, channel: string): DeriveEvent[] => {
  const seen: DeriveEvent[] = []
  bp.subscribe(channel, (e) => seen.push(e))
  return seen
}

describe("MCP publish reaches the human (event parity + auto-open)", () => {
  it("emits version.published + artifact.pushed, writes a bell row, and reports opened_in_tab", async () => {
    const { app, meta, backplane, token } = loopApp("push")
    // An "open tab": a live subscriber on the user channel (what the bell SSE holds).
    const userEvents = record(backplane, "u:u_o")

    const created = await call(app, token, "publish", {
      content: "<h1>Draft</h1>",
      title: "Loop Draft",
    })
    expect(created.published).toBe(true)
    expect(created.opened_in_tab).toBe(true) // the subscriber caught the push

    // The user channel got the auto-open signal (and the bell notification).
    const pushed = userEvents.find((e) => e.type === "artifact.pushed")
    expect(pushed).toMatchObject({
      short_id: created.short_id,
      kind: "created",
      title: "Loop Draft",
    })
    expect(typeof pushed?.url).toBe("string")
    expect(userEvents.some((e) => e.type === "notification")).toBe(true)
    const rows = await meta.listNotifications("u_o", 10)
    expect(rows.some((r) => r.kind === "publish" && r.artifact_short_id === created.short_id)).toBe(
      true,
    )

    // A revision reaches the artifact channel (live reload for a viewing tab)
    // and pushes kind "revised".
    const a = await meta.getByShortId(created.short_id as string)
    if (!a) throw new Error("artifact missing")
    const artEvents = record(backplane, a.id)
    const revised = await call(app, token, "publish", {
      content: "<h1>Draft v2</h1>",
      short_id: created.short_id,
    })
    expect(revised.version).toBe(2)
    expect(artEvents.some((e) => e.type === "version.published" && e.n === 2)).toBe(true)
    expect(userEvents.some((e) => e.type === "artifact.pushed" && e.kind === "revised")).toBe(true)
    // Revisions don't add bell rows (only creates and review asks do).
    const after = await meta.listNotifications("u_o", 10)
    expect(after.filter((r) => r.artifact_short_id === created.short_id)).toHaveLength(1)
  })

  it("reports opened_in_tab:false with a local-open hint when no tab is listening", async () => {
    const { app, token } = loopApp("notab")
    const created = await call(app, token, "publish", {
      content: "<h1>Nobody home</h1>",
      title: "Unseen Draft",
    })
    expect(created.opened_in_tab).toBe(false)
    expect(created.note).toContain("open")
  })

  it("request_review writes ONE bell row (review beats publish) and notifies live", async () => {
    const { app, meta, backplane, token } = loopApp("ask")
    const userEvents = record(backplane, "u:u_o")
    const created = await call(app, token, "publish", {
      content: "<h1>Plan</h1>",
      title: "Reviewed Plan",
      request_review: true,
    })
    expect(created.review_requested).toBe(true)
    const rows = await meta.listNotifications("u_o", 10)
    const mine = rows.filter((r) => r.artifact_short_id === created.short_id)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.kind).toBe("review")
    expect(mine[0]?.preview).toContain("review")
    const pushed = userEvents.find((e) => e.type === "artifact.pushed")
    expect(pushed?.review_requested).toBe(true)
  })
})

describe("the ack: comment react over MCP", () => {
  it("lands the emoji on the thread's latest HUMAN comment, idempotently", async () => {
    const { app, meta, token } = loopApp("react")
    const created = await call(app, token, "publish", {
      content: "<h1>Q&A</h1>",
      title: "Ack Target",
    })
    const q = await call(app, token, "comment", {
      short_id: created.short_id,
      body: "Q1: which option?",
    })
    const a = await meta.getByShortId(created.short_id as string)
    if (!a) throw new Error("artifact missing")
    // The human answers in the thread (store-level; the route needs a session).
    await meta.createComment({
      id: "c_human_1",
      artifact_id: a.id,
      thread_id: q.thread as string,
      base_version: 1,
      path: null,
      anchor: null,
      body_md: "(a), and note it in 5.2",
      author: "Anir",
      author_id: "u_o",
    })
    const ack = await call(app, token, "comment", {
      short_id: created.short_id,
      reply_to: q.thread,
      react: "👍",
    })
    expect(ack.reacted).toBe("👍")
    expect(ack.reacted_to).toBe("c_human_1") // the human's comment, not the agent's own
    expect(ack.note).toContain("Acknowledged")
    // Idempotent: acking twice never toggles the reaction back off.
    await call(app, token, "comment", {
      short_id: created.short_id,
      reply_to: q.thread,
      react: "👍",
    })
    const stored = await meta.getComment("c_human_1")
    const reactions = JSON.parse(stored?.meta ?? "{}").reactions as Record<string, string[]>
    expect(reactions["👍"]).toEqual(["Claude"])
  })
})

describe("HTTP publish parity (the CLI / stdio-shim path)", () => {
  it("an agent-credentialed HTTP publish pushes, bells, and reports opened_in_tab", async () => {
    const { app, meta, backplane, token } = loopApp("httppar")
    const userEvents = record(backplane, "u:u_o")
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>via http</h1>")]), "index.html")
    form.append("title", "CLI Draft")
    form.append("request_review", "true")
    const res = await app.request("/v1/artifacts", {
      method: "POST",
      body: form,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(201)
    const out = (await res.json()) as Record<string, unknown>
    expect(out.review_requested).toBe(true)
    expect(out.opened_in_tab).toBe(true) // the recorder holds the user channel
    expect(out.visibility).toBe("private") // agent creates take the workspace default here too
    expect(userEvents.some((e) => e.type === "artifact.pushed" && e.kind === "created")).toBe(true)
    const rows = await meta.listNotifications("u_o", 10)
    expect(rows.some((r) => r.kind === "review")).toBe(true)
  })
})

describe("private — the agent-draft default", () => {
  it("new MCP publishes land private, still findable by the agent", async () => {
    const { app, meta, token } = loopApp("unlisted")
    const created = await call(app, token, "publish", {
      content: "<h1>Draft</h1>",
      title: "Quiet Draft",
    })
    expect(created.visibility).toBe("private")
    const a = await meta.getByShortId(created.short_id as string)
    expect(a?.general_role).toBe("viewer")

    // The agent's list_artifacts finds it through the acting user's owner row —
    // it can always find its own work; a teammate's private draft stays invisible.
    const list = await call(app, token, "list_artifacts", {})
    const shortIds = (list.artifacts as { short_id: string }[]).map((x) => x.short_id)
    expect(shortIds).toContain(created.short_id)

    // Explicit visibility still wins over the workspace default.
    const open = await call(app, token, "publish", {
      content: "<h1>Open</h1>",
      title: "Open Doc",
      visibility: "workspace",
    })
    expect(open.visibility).toBe("org")
  })

  it("honors the workspace's defaultAgentVisibility setting", async () => {
    const { app, meta, token } = loopApp("wsdefaults")
    // The OAuth agent runs in the granting user's personal workspace.
    const org = "ws_p_u_o"
    const { DEFAULT_ORG_SETTINGS } = await import("@derive/core")
    await meta.setOrgSettings(org, { ...DEFAULT_ORG_SETTINGS, defaultAgentVisibility: "org" })
    const created = await call(app, token, "publish", {
      content: "<h1>C</h1>",
      title: "Team Draft",
    })
    expect(created.visibility).toBe("org")

    await meta.setOrgSettings(org, {
      ...DEFAULT_ORG_SETTINGS,
      defaultAgentVisibility: "private",
    })
    const priv = await call(app, token, "publish", {
      content: "<h1>P</h1>",
      title: "Private Draft",
    })
    expect(priv.visibility).toBe("private")
  })
})

describe("catch_up `wait` long-poll", () => {
  it("blocks while the round is pending and wakes the moment it is sent back", async () => {
    const { app, meta, backplane, token } = loopApp("wake")
    const created = await call(app, token, "publish", {
      content: "<h1>Round 1</h1>",
      title: "Waiting Plan",
      request_review: true,
    })
    const a = await meta.getByShortId(created.short_id as string)
    if (!a) throw new Error("artifact missing")

    const started = Date.now()
    const waiting = call(app, token, "catch_up", { short_id: created.short_id, wait: 30 })
    // The human sends back ~100ms in (what the review route does server-side).
    setTimeout(() => {
      void (async () => {
        const round = await meta.getPendingRound(a.id)
        if (round) await meta.resolveReviewRound(round.id, { state: "sent_back", note: "go" })
        backplane.publish(a.id, { type: "review.sent_back", round_id: round?.id })
      })()
    }, 100)

    const out = await waiting
    expect(Date.now() - started).toBeLessThan(10_000) // woke early, not the full 30s
    expect((out.review as { state: string }).state).toBe("sent_back")
    expect((out.review as { note: string | null }).note).toBe("go")
  })

  it("returns immediately when the round is already actionable", async () => {
    const { app, meta, token } = loopApp("nowait")
    const created = await call(app, token, "publish", {
      content: "<h1>Done deal</h1>",
      title: "Approved Plan",
      request_review: true,
    })
    const a = await meta.getByShortId(created.short_id as string)
    if (!a) throw new Error("artifact missing")
    const round = await meta.getPendingRound(a.id)
    if (round) await meta.resolveReviewRound(round.id, { state: "approved", note: null })

    const started = Date.now()
    const out = await call(app, token, "catch_up", { short_id: created.short_id, wait: 30 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect((out.review as { state: string }).state).toBe("approved")
  })

  it("times out quietly and returns the still-pending state", async () => {
    const { app, token } = loopApp("timeout")
    const created = await call(app, token, "publish", {
      content: "<h1>Quiet</h1>",
      title: "Quiet Plan",
      request_review: true,
    })
    const started = Date.now()
    const out = await call(app, token, "catch_up", { short_id: created.short_id, wait: 1 })
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect((out.review as { state: string }).state).toBe("pending")
  })
})
