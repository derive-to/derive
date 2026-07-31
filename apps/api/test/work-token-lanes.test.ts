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
          // camelCase. Zod strips unknown keys, so `context_id` binds nothing, mints a fresh
          // agent, and every crossing below then 404s for the wrong reason — hence the assertion
          // on agent_id rather than trusting this line.
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

  /** Drain dispatch (several passes: it starts at most `perOrgLimit` per pass, and this suite
   *  leaves earlier work queued) and hand back everything it booted, with the token it minted
   *  for each. */
  const dispatchAll = async () => {
    const started: { runId: string; token: string }[] = []
    const substrate: Substrate = {
      name: "fake",
      async start(input) {
        started.push(input)
      },
    }
    for (let pass = 0; pass < 6; pass++)
      await dispatchPass({
        meta,
        substrate,
        server: "https://derive.test",
        secret: SECRET,
        perOrgLimit: 50,
      })
    return started
  }

  /** The run token out of a dispatch sweep. Fails loudly rather than returning "" — an empty
   *  token would make every refusal below pass for the wrong reason. */
  const runTokenFrom = (started: { runId: string; token: string }[]): string => {
    const hit = started.find((s) => s.token.startsWith("dkrun_"))
    if (!hit) throw new Error("dispatch minted no run token; nothing to test the crossing with")
    return hit.token
  }

  /** Run one request with `fetch` stubbed, so a tool call that gets past the door attempts a
   *  real outbound call and returns 200 rather than a network error we would have to squint at. */
  const withStubbedFetch = async (send: () => Promise<Response> | Response) => {
    const real = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: 1 }), { status: 200 })) as typeof fetch
    try {
      return await send()
    } finally {
      globalThis.fetch = real
    }
  }

  it("is refused at every session door its ownership check would otherwise let through", async () => {
    const { ctx } = await contextBoundAutomation()
    // Dispatch mints the run's pass. Deliberately not claimed first: claiming moves the run out
    // of the queue dispatch draws from, leaving no token to test the crossing with.
    const runToken = runTokenFrom(await dispatchAll())

    const ask = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "what is our refund rate?" }),
    )
    const session = ((await ask.json()) as { session: { id: string } }).session.id
    const sessToken = (await dispatchAll()).find((s) => s.runId === session)?.token ?? ""

    // Both kinds in hand, or the refusals below prove nothing.
    expect(runToken.startsWith("dkrun_")).toBe(true)
    expect(sessToken.startsWith("dksess_")).toBe(true)

    // The context's real tool, so getting past the door executes an outbound call and returns
    // 200 — the crossing is visible rather than hidden behind "tool not allowed".
    const tool = await withStubbedFetch(() =>
      app.request(
        `/v1/agent/sessions/${session}/tool`,
        jsonAs(bearer(runToken), { tool: "game.get", args: { path: "/x" } }),
      ),
    )
    expect([403, 404]).toContain(tool.status)

    // Answering: would post an agent message as this context and settle someone's ask.
    const answer = await app.request(
      `/v1/sessions/${session}/messages`,
      jsonAs(bearer(runToken), { body_md: "answered by the wrong lane", state: "answered" }),
    )
    expect([401, 403, 404]).toContain(answer.status)

    // State: would fail the session out from under the executor that owns it.
    const patch = await app.request(`/v1/sessions/${session}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bearer(runToken) },
      body: JSON.stringify({ state: "failed" }),
    })
    expect([401, 403, 404]).toContain(patch.status)

    // The queue: reading it claims sessions (open → working), so crossing here takes over the
    // ask lane's work.
    const queue = await app.request(`/v1/contexts/${ctx.id}/queue`, { headers: bearer(runToken) })
    expect([403, 404]).toContain(queue.status)

    // The session's OWN pass still reaches both, so the refusals are about the lane and not
    // about these routes being broken for everyone.
    const rightLane = await withStubbedFetch(() =>
      app.request(
        `/v1/agent/sessions/${session}/tool`,
        jsonAs(bearer(sessToken), { tool: "game.get", args: { path: "/x" } }),
      ),
    )
    expect(rightLane.status).toBe(200)
    const ownQueue = await app.request(`/v1/contexts/${ctx.id}/queue`, {
      headers: bearer(ctx.agent_token),
    })
    expect(ownQueue.status).toBe(200)
  })
})
