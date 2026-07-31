import { describe, expect, it } from "vitest"
import { dispatchPass, type Substrate } from "../src/lib/dispatch"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// WORK-TOKEN LANES — a pass minted for one job may act on that job, in its own lane, and
// nowhere else.
//
// Derive mints a short-lived capability token per work item: `dkrun_` for an automation run,
// `dksess_` for one asked question. The run lane checks the kind explicitly at every door
// (routes/automations.ts refuses a session token to claim, finish, or call a tool). The SESSION
// lane never got the mirror, and ownership cannot cover for it: a context-bound automation runs
// AS the context's agent, so `context.agent_id === agent.id` is TRUE for a run token aimed at
// any session of that context. The lanes are cryptographically distinct, which stops a token
// verifying as the wrong kind — it does not stop the wrong kind being accepted where kind was
// never checked.
//
// The same lesson is already written down one file over, in routes/model-credentials.ts:
// "belonging to the same agent is not enough".
const SECRET = "test-secret-at-least-16-chars"

describe("a run token cannot act in the session lane", () => {
  const owner: TestUser = { id: "u_wt_own", email: "wtown@derive.test", name: "Owner" }
  const { app, meta } = makeAuthedApp("work-token-lanes", [owner], "editor", {
    deps: { encryptionKey: SECRET },
  })

  /** A context, plus an automation BOUND to it — so the automation's runs act as the context's
   *  own agent, which is what makes this confusion reachable at all. */
  const contextBoundAutomation = async () => {
    // A real tool on the context, so a crossing at the tool door is OBSERVABLE: without a bound
    // connection every call is refused as "tool not allowed" and a lane bug hides behind it.
    const conn = (await (
      await app.request(
        "/v1/connections",
        jsonAs(as(owner.email), {
          toolkit: "game",
          kind: "secret",
          secret: "fixture-secret-value",
          base_url: "https://api.game.test",
          scope: "workspace",
        }),
      )
    ).json()) as { id: string }
    const manifest = await publishAs(app, "# How to answer", { title: "Lanes" }, as(owner.email))
    const { short_id } = (await manifest.json()) as { short_id: string }
    const ctx = (await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Lanes",
          manifest_short_id: short_id,
          connection_ids: [conn.id],
        }),
      )
    ).json()) as { id: string; agent_id: string; agent_token: string }
    const auto = (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          trigger: { kind: "manual" },
          instruction: "Do the scheduled thing.",
          // camelCase, and asserted below. Spelled `context_id` this silently binds NOTHING —
          // zod strips unknown keys, a fresh managed agent is minted, and every crossing below
          // then gets an honest 404 for the wrong reason. That typo cost a full debugging cycle.
          contextId: ctx.id,
        }),
      )
    ).json()) as { id: string; agent_id: string }
    // The precondition that makes the confusion reachable at all: one agent, two lanes.
    expect(auto.agent_id).toBe(ctx.agent_id)
    await app.request(`/v1/automations/${auto.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    return { ctx, auto }
  }

  /** Drain dispatch and hand back the token it minted for one work item. Pass the literal
   *  "*first-run*" to take whatever RUN it started first — used when the run id isn't known
   *  yet, because learning it by claiming would consume the very run we want dispatched. */
  const dispatchedTokenFor = async (workId: string) => {
    const started: { runId: string; token: string }[] = []
    const substrate: Substrate = {
      name: "fake",
      async start(input) {
        started.push(input)
      },
    }
    for (let pass = 0; pass < 6; pass++) {
      await dispatchPass({
        meta,
        substrate,
        server: "https://derive.test",
        secret: SECRET,
        perOrgLimit: 50,
      })
      const hit =
        workId === "*first-run*"
          ? started.find((s) => s.token.startsWith("dkrun_"))
          : started.find((s) => s.runId === workId)
      if (hit) return hit.token
    }
    return ""
  }

  it("is refused at the session tool door, the messages door, and the state door", async () => {
    const { ctx, auto } = await contextBoundAutomation()
    expect(auto.id).toBeTruthy()
    // Let DISPATCH mint the run's pass — deliberately without claiming the run ourselves first,
    // which would move it out of the queue dispatch draws from and leave us with no token to
    // test the crossing with.
    const runToken = await dispatchedTokenFor("*first-run*")

    // A real session on the SAME context, so ownership checks will pass.
    const ask = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "what is our refund rate?" }),
    )
    const session = ((await ask.json()) as { session: { id: string } }).session.id
    const sessToken = await dispatchedTokenFor(session)
    expect(sessToken).toBeTruthy()

    // Only meaningful if we actually obtained a run-scoped pass; otherwise this test would
    // pass vacuously and prove nothing.
    if (!runToken) throw new Error("expected a dispatched run token to test the crossing with")
    expect(runToken.startsWith("dkrun_")).toBe(true)
    expect(sessToken.startsWith("dksess_")).toBe(true)

    // 1. Tools. A run's pass must not reach a session's tool surface. Uses the context's REAL
    //    tool: unfixed this returns 502 (`callTool` attached the decrypted credential and
    //    actually attempted the outbound call), which is the crossing, visible.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as typeof fetch
    let tool: Response
    try {
      tool = await app.request(
        `/v1/agent/sessions/${session}/tool`,
        jsonAs(bearer(runToken), { tool: "game.get", args: { path: "/x" } }),
      )
    } finally {
      globalThis.fetch = realFetch
    }
    expect([403, 404]).toContain(tool.status)
    // Specifically NOT 200/502 — either would mean the call was executed.
    expect(tool.status).not.toBe(200)

    // 2. Settling. It must not answer somebody's question either — that would post an agent
    //    message as this context and close the ask.
    const answer = await app.request(
      `/v1/sessions/${session}/messages`,
      jsonAs(bearer(runToken), { body_md: "answered by the wrong lane", state: "answered" }),
    )
    expect([401, 403, 404]).toContain(answer.status)

    // 3. State. Nor may it fail the session out from under the executor that owns it.
    const patch = await app.request(`/v1/sessions/${session}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bearer(runToken) },
      body: JSON.stringify({ state: "failed" }),
    })
    expect([401, 403, 404]).toContain(patch.status)

    // 4. The queue. Crossing here CLAIMS sessions (open → working) as a side effect, so a run's
    //    pass could quietly take over the ask lane's work.
    const queue = await app.request(`/v1/contexts/${ctx.id}/queue`, { headers: bearer(runToken) })
    expect([403, 404]).toContain(queue.status)

    // CONTROL — the session's OWN pass still reaches the same tool door, so the refusals above
    // are about the LANE and not about these routes being broken for everyone.
    const realFetch2 = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as typeof fetch
    let rightLane: Response
    try {
      rightLane = await app.request(
        `/v1/agent/sessions/${session}/tool`,
        jsonAs(bearer(sessToken), { tool: "game.get", args: { path: "/x" } }),
      )
    } finally {
      globalThis.fetch = realFetch2
    }
    expect(rightLane.status).toBe(200)
    // And its own queue read is served.
    const ownQueue = await app.request(`/v1/contexts/${ctx.id}/queue`, {
      headers: bearer(ctx.agent_token),
    })
    expect(ownQueue.status).toBe(200)
  })
})
