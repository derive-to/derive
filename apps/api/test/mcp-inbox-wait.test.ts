import { describe, expect, it } from "vitest"
import { createInProcessBackplane, type DeriveEvent } from "../src/bus"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Phase 2 slice 1 — the cross-doc wake. An @mention lands a row in the agent's
// pull inbox AND publishes `request.created` on the agent's `u:<id>` channel, so a
// session long-polling `catch_up({wait})` (no short_id = the work queue, formerly
// check_requests) wakes in ~a beat instead of only on its next reconnect. Mirrors
// catch_up's artifact `wait`: the event is a wake signal only, so the handler
// always answers from a fresh store read.

const owner: TestUser = { id: "u_iw_own", email: "iwown@derive.test", name: "Owner" }

type App = ReturnType<typeof makeAuthedApp>["app"]

// A direct tools/call over the stateless /mcp endpoint (same shape as mcp-loop.test.ts).
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

describe("catch_up({wait}) work queue — the cross-doc wake", () => {
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
