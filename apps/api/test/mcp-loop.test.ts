import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createApp } from "../src/app"
import { type Backplane, createInProcessBackplane, type DeriveEvent } from "../src/bus"
import { sha256 } from "../src/lib/crypto"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

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
      author: "Maya",
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

describe("MCP visual review pins", () => {
  it("anchors an agent comment to the same durable loop target as the visual UI", async () => {
    const { app, meta, token } = loopApp("visual-pin")
    const target = "derive-improve-node-revise"
    const created = await call(app, token, "publish", {
      content: `<main><p>Before</p><div id="${target}" data-derive-review-id="${target}" data-derive-review-kind="loop-step" data-derive-review-label="Loop step — Revise">Revise the brief</div><p>After</p></main>`,
      title: "Visual review target",
    })
    const result = await call(app, token, "comment", {
      short_id: created.short_id,
      body: "The evidence check should happen before this step.",
      visual_target: target,
    })
    expect(result.anchored_to).toBe(target)

    const artifact = await meta.getByShortId(created.short_id as string)
    if (!artifact) throw new Error("artifact missing")
    const comments = await meta.listComments(artifact.id)
    expect(JSON.parse(comments[0]?.anchor ?? "{}")).toMatchObject({
      type: "ElementSelector",
      id: target,
      role: "loop-step",
      snapshot: { label: "Loop step — Revise" },
    })
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
    expect(out.listed).toBe("none") // agent creates take the workspace default (team draft) here too
    expect(userEvents.some((e) => e.type === "artifact.pushed" && e.kind === "created")).toBe(true)
    const rows = await meta.listNotifications("u_o", 10)
    expect(rows.some((r) => r.kind === "review")).toBe(true)
  })
})

describe("the team-draft default", () => {
  it("new MCP publishes land unlisted, still findable by the agent", async () => {
    const { app, meta, token } = loopApp("unlisted")
    const created = await call(app, token, "publish", {
      content: "<h1>Draft</h1>",
      title: "Quiet Draft",
    })
    expect(created.listed).toBe("none")
    const a = await meta.getByShortId(created.short_id as string)
    expect(a?.workspace_access).toBe("member")
    expect(a?.link_role).toBe("none")

    // The agent's find (browse) surfaces it through the acting user's owner row —
    // it can always find its own work; a teammate's invite-only draft stays invisible.
    const list = await call(app, token, "find", {})
    const shortIds = (list.results as { short_id?: string }[]).map((x) => x.short_id)
    expect(shortIds).toContain(created.short_id)

    // An explicit listing still wins over the workspace default.
    const open = await call(app, token, "publish", {
      content: "<h1>Open</h1>",
      title: "Open Doc",
      listed: "workspace",
    })
    expect(open.listed).toBe("workspace")
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
        if (round) await meta.resolveReviewRound(round.id, { note: "go" })
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
    if (round) await meta.resolveReviewRound(round.id, { note: "good to go" })

    const started = Date.now()
    const out = await call(app, token, "catch_up", { short_id: created.short_id, wait: 30 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect((out.review as { state: string }).state).toBe("sent_back")
  })
})

describe("comment bells (the MCP path)", () => {
  it("an agent's comment on the human's artifact bells them — parity with HTTP", async () => {
    const { app, meta, token } = loopApp("comment-bell")
    const created = await call(app, token, "publish", {
      content: "<h1>Doc</h1>",
      title: "Doc",
    })
    // The publish itself belled u_o (kind publish/review); an agent COMMENT on
    // the doc must too — before the shared fan-out, this path belled no one.
    await call(app, token, "comment", {
      short_id: created.short_id,
      body: "I have a question about the intro.",
    })
    const rows = await meta.listNotifications("u_o", 10)
    expect(rows.some((n) => n.kind === "comment")).toBe(true)
  })
})

// The MCP tool wrote the comment row and belled people, but never ran the CHANNEL fan-out the
// HTTP route runs — so an agent's comment reached no Slack channel, no webhook, no email, no
// GitHub PR. Not a deliberate quiet mode: isCollaboratorAuthor goes out of its way to return
// true for a registered agent, i.e. the gate was built to let exactly these through. Both paths
// now run one shared action, so they can't drift again.
describe("channel fan-out parity (the MCP path)", () => {
  const drain = (meta: ReturnType<typeof loopApp>["meta"]) =>
    meta.claimDueDeliveries(
      new Date(Date.now() + 60_000).toISOString(),
      100,
      new Date(Date.now() + 120_000).toISOString(),
    )

  const listedDoc = async (app: ReturnType<typeof loopApp>["app"], token: string) =>
    await call(app, token, "publish", {
      content: "<h1>Doc</h1>",
      title: "Doc",
      workspace_access: "member",
      listed: "workspace",
    })

  it("an agent's comment posts to the connected Slack channel", async () => {
    const { app, meta, token } = loopApp("mcp-slack-mirror")
    const created = await listedDoc(app, token)
    const artifact = await meta.getByShortId(created.short_id as string)
    await meta.setSlackInstall({
      org_id: artifact?.org_id ?? "",
      team_id: "T1",
      team_name: "Acme",
      bot_token: "xoxb-stored",
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.upsertSlackSubscription({
      id: "sub_mcp",
      org_id: artifact?.org_id ?? "",
      channel_id: "C1",
    })
    await call(app, token, "comment", {
      short_id: created.short_id,
      body: "I have a question about the intro.",
    })
    const rows = await drain(meta)
    expect(rows.some((d) => d.kind === "slack_app" && d.event_type === "comment.created")).toBe(
      true,
    )
  })

  it("an agent's comment reaches subscribed webhooks", async () => {
    const { app, meta, token } = loopApp("mcp-webhook-fanout")
    const created = await listedDoc(app, token)
    const artifact = await meta.getByShortId(created.short_id as string)
    await meta.createWebhook({
      id: "wh_mcp1",
      org_id: artifact?.org_id ?? "",
      artifact_id: null,
      url: "http://example.com/hook",
      secret: "s",
      kind: "generic",
      events: "comment.created,comment.resolved",
    })
    await call(app, token, "comment", { short_id: created.short_id, body: "a note" })
    const rows = await drain(meta)
    expect(rows.some((d) => d.kind === "generic" && d.event_type === "comment.created")).toBe(true)
  })

  // The fan-out is best-effort and the comment row is already durable when it runs, so a
  // channel-side failure must not be reported to the agent as a failed comment — an agent that
  // believes its comment failed retries and duplicates it. The HTTP route gets this from
  // background(); the MCP path has to ask for the same guard.
  it("still reports success when the fan-out throws — the comment was written", async () => {
    const { app, meta, token } = loopApp("mcp-fanout-throws")
    const created = await listedDoc(app, token)
    const artifact = await meta.getByShortId(created.short_id as string)
    vi.spyOn(meta, "getSlackInstall").mockRejectedValue(new Error("channel lookup exploded"))
    const out = await call(app, token, "comment", {
      short_id: created.short_id,
      body: "a note",
    })
    expect(out.comment_id).toBeTruthy()
    vi.restoreAllMocks()
    // ...and it really is in the store, not just claimed in the reply.
    const rows = await meta.listComments(artifact?.id ?? "")
    expect(rows.some((r) => r.body_md === "a note")).toBe(true)
  })

  // resolveThreadAction fans comment.resolved out to every webhook subscriber and discards its
  // update count, so without the HTTP route's existence check an agent could emit unbounded
  // "a thread was resolved" events — including into a Slack channel — for threads that never
  // existed. Before the shared action this path emitted no webhooks at all, so the regression
  // came in with it.
  it("refuses to resolve a thread that isn't on the artifact, and emits nothing", async () => {
    const { app, meta, token } = loopApp("mcp-resolve-ghost")
    const created = await listedDoc(app, token)
    const artifact = await meta.getByShortId(created.short_id as string)
    await meta.createWebhook({
      id: "wh_mcp3",
      org_id: artifact?.org_id ?? "",
      artifact_id: null,
      url: "http://example.com/hook",
      secret: "s",
      kind: "generic",
      events: "comment.resolved",
    })
    const raw = await rpc(app, token, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "comment",
        arguments: {
          short_id: created.short_id,
          reply_to: "th_does_not_exist",
          set_state: "resolved",
        },
      },
    })
    const out = raw?.result as { isError?: boolean; content?: { text: string }[] } | undefined
    expect(out?.isError).toBe(true)
    expect(out?.content?.[0]?.text ?? "").toMatch(/thread/i)
    const rows = await drain(meta)
    expect(rows.some((d) => d.event_type === "comment.resolved")).toBe(false)
  })

  it("an agent resolving a thread fans out comment.resolved", async () => {
    const { app, meta, token } = loopApp("mcp-resolve-fanout")
    const created = await listedDoc(app, token)
    const artifact = await meta.getByShortId(created.short_id as string)
    await meta.createWebhook({
      id: "wh_mcp2",
      org_id: artifact?.org_id ?? "",
      artifact_id: null,
      url: "http://example.com/hook",
      secret: "s",
      kind: "generic",
      events: "comment.resolved",
    })
    const c = await call(app, token, "comment", { short_id: created.short_id, body: "a note" })
    await call(app, token, "comment", {
      short_id: created.short_id,
      reply_to: c.thread as string,
      set_state: "resolved",
    })
    const rows = await drain(meta)
    expect(rows.some((d) => d.kind === "generic" && d.event_type === "comment.resolved")).toBe(true)
  })
})

describe("catch_up({wait}) work queue — the cross-doc wake", () => {
  // Phase 2 slice 1 — the cross-doc wake. An @mention lands a row in the agent's
  // pull inbox AND publishes `request.created` on the agent's `u:<id>` channel, so a
  // session long-polling `catch_up({wait})` (no short_id = the work queue, formerly
  // check_requests) wakes in ~a beat instead of only on its next reconnect. Mirrors
  // catch_up's artifact `wait`: the event is a wake signal only, so the handler
  // always answers from a fresh store read.

  const owner: TestUser = { id: "u_iw_own", email: "iwown@derive.test", name: "Owner" }

  type App = ReturnType<typeof makeAuthedApp>["app"]

  // A direct tools/call over the stateless /mcp endpoint.
  const call = async (
    app: App,
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
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
    const t = (out?.result as { content?: { text: string }[] } | undefined)?.content?.[0]?.text
    if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
    return JSON.parse(t)
  }

  // Register an agent (owner-only) and return its raw token + id.
  const registerAgent = async (app: App) => {
    await app.request("/v1/me", { headers: as(owner.email) }) // claims ownership
    const a = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Claude" }))
    ).json()
    return { agentId: a.id as string, agentToken: a.token as string }
  }

  const mention = (app: App, shortId: string, agentId: string, body: string) =>
    app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(owner.email), { body_md: body, mentions: [{ id: agentId, name: "Claude" }] }),
    )

  it("blocks, then wakes the instant an @mention lands, and answers from a fresh read", async () => {
    const backplane = createInProcessBackplane()
    const { app } = makeAuthedApp("inbox-wait", [owner], "commenter", { deps: { backplane } })
    const { agentId, agentToken } = await registerAgent(app)
    const shortId = (
      await (await publishAs(app, "<h1>draft</h1>", { visibility: "org" }, as(owner.email))).json()
    ).short_id

    // Record the agent's channel so the wake publish is pinned explicitly.
    const woke: DeriveEvent[] = []
    backplane.subscribe(`u:${agentId}`, (e) => woke.push(e))

    // Start the long-poll BEFORE the mention exists — its connect snapshot is empty,
    // so it must block on the wake rather than return immediately.
    const waiting = call(app, agentToken, "catch_up", { wait: 10 })
    const cm = await mention(app, shortId, agentId, "@Claude tighten the headline")
    expect(cm.status).toBe(201)

    const res = await waiting
    const pending = res.pending as { request: string }[]
    expect(pending).toHaveLength(1)
    expect(pending[0]?.request).toContain("tighten the headline")
    expect(woke.map((e) => e.type)).toContain("request.created")
  })

  it("returns immediately when a request is already queued (no needless block)", async () => {
    const { app } = makeAuthedApp("inbox-ready", [owner], "commenter")
    const { agentId, agentToken } = await registerAgent(app)
    const shortId = (
      await (await publishAs(app, "<h1>draft</h1>", { visibility: "org" }, as(owner.email))).json()
    ).short_id
    expect((await mention(app, shortId, agentId, "@Claude do the thing")).status).toBe(201)

    // A generous wait that must NOT be spent: the request is already pending, so the
    // call returns at once. (If it blocked the full 30s the test would time out.)
    const started = Date.now()
    const res = await call(app, agentToken, "catch_up", { wait: 30 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(res.pending).toHaveLength(1)
  })
})
