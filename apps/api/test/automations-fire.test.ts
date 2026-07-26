import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WO1 — the fire URL (the "webhook kick" the run queue was built for). An external system
// POSTs to a per-automation secret URL; the body becomes run input, and a burst of fires
// coalesces into one queued run carrying every payload. Authed by the secret alone.
describe("automations: fire URL (webhook kick)", () => {
  const owner: TestUser = { id: "u_fire_own", email: "fireown@derive.test", name: "Owner" }
  const { app } = makeAuthedApp("automations-fire", [owner], "commenter")

  let n = 0
  const mintAgent = async () => {
    n += 1
    const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name: `Runner ${n}` }))
    return (await res.json()) as { id: string; token: string }
  }
  const createWebhookAutomation = async (over: object = {}) => {
    const agent = await mintAgent()
    const res = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        agentId: agent.id,
        trigger: { kind: "event", on: "webhook" },
        instruction: "fold the payload into the changelog",
        ...over,
      }),
    )
    return { agent, body: (await res.json()) as Record<string, unknown> }
  }
  const fire = (id: string, secret: string | undefined, body: string) =>
    app.request(`/v1/automations/${id}/fire`, {
      method: "POST",
      headers: {
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        "content-type": "application/json",
      },
      body,
    })
  const ledger = async () => {
    const res = await app.request("/v1/workspace/runs", { headers: as(owner.email) })
    return ((await res.json()) as { runs: { id: string; reason: string; meta: string | null }[] })
      .runs
  }

  it("mints a fire secret once on create; the secret is never readable again", async () => {
    const { body } = await createWebhookAutomation()
    expect(body.fire_secret).toMatch(/^dfire_/)
    expect(body.fire_url).toBe(`/v1/automations/${body.id}/fire`)
    expect(body.has_fire_url).toBe(true)
    // The stored hash never surfaces on read; the raw secret is gone after this response.
    expect((body.trigger as Record<string, unknown>).secret_hash).toBeUndefined()
    const listed = (await (
      await app.request("/v1/automations", { headers: as(owner.email) })
    ).json()) as { automations: Record<string, unknown>[] }
    const mine = listed.automations.find((x) => x.id === body.id)
    expect(mine?.has_fire_url).toBe(true)
    expect(mine?.fire_secret).toBeUndefined()
    expect((mine?.trigger as Record<string, unknown>).secret_hash).toBeUndefined()
  })

  it("a valid secret fires a run; the payload rides into the run", async () => {
    const { body } = await createWebhookAutomation()
    const res = await fire(
      body.id as string,
      body.fire_secret as string,
      JSON.stringify({ release: "v2.4.0" }),
    )
    expect(res.status).toBe(202)
    const out = (await res.json()) as { id: string; status: string; coalesced: boolean }
    expect(out).toMatchObject({ status: "queued", coalesced: false })
    const row = (await ledger()).find((r) => r.id === out.id)
    expect(row?.reason).toBe("fire")
    expect(JSON.parse(row?.meta ?? "{}").payloads).toEqual([{ release: "v2.4.0" }])
  })

  it("the payload reaches the EXECUTOR, not just the run row", async () => {
    // The seam nothing covered, and which was broken the whole time: payloads were validated,
    // capped, coalesced and CAS-appended onto the run, and then the claim response never
    // returned them — so a webhook-triggered run executed with no idea what had fired it.
    // Asserting the row proves storage; only this proves DELIVERY.
    const { agent, body } = await createWebhookAutomation()
    await fire(body.id as string, body.fire_secret as string, JSON.stringify({ release: "v9" }))
    const claim = await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    expect(claim.status).toBe(200)
    const { runs } = (await claim.json()) as {
      runs: { automation_id: string; payloads: unknown[] }[]
    }
    expect(runs.find((r) => r.automation_id === body.id)?.payloads).toEqual([{ release: "v9" }])
  })

  it("a burst coalesces: many fires fold into one run carrying every payload", async () => {
    const { body } = await createWebhookAutomation()
    const ids = new Set<string>()
    for (let i = 0; i < 10; i += 1) {
      const out = (await (
        await fire(body.id as string, body.fire_secret as string, JSON.stringify({ i }))
      ).json()) as { id: string }
      ids.add(out.id)
    }
    // All ten folded into ONE queued run.
    expect(ids.size).toBe(1)
    const runId = [...ids][0]
    const row = (await ledger()).find((r) => r.id === runId)
    const payloads = JSON.parse(row?.meta ?? "{}").payloads as { i: number }[]
    expect(payloads).toHaveLength(10)
    expect(payloads.map((p) => p.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it("a fire after the run is claimed starts a fresh run (never folds into a running run)", async () => {
    const { agent, body } = await createWebhookAutomation()
    const first = (await (
      await fire(body.id as string, body.fire_secret as string, JSON.stringify({ a: 1 }))
    ).json()) as { id: string }
    // Claim it → running; the next fire cannot fold into a run that has left the queue.
    await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    const second = (await (
      await fire(body.id as string, body.fire_secret as string, JSON.stringify({ a: 2 }))
    ).json()) as { id: string; coalesced: boolean }
    expect(second.id).not.toBe(first.id)
    expect(second.coalesced).toBe(false)
  })

  it("a bad secret is 401; a missing or non-webhook automation is 404", async () => {
    const { body } = await createWebhookAutomation()
    expect((await fire(body.id as string, "dfire_wrong", "{}")).status).toBe(401)
    expect((await fire(body.id as string, undefined, "{}")).status).toBe(401)
    expect((await fire("auto_nope", "dfire_x", "{}")).status).toBe(404)
    // A non-webhook automation has no fire URL → 404, never revealing its trigger kind.
    const agent = await mintAgent()
    const manual = (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          agentId: agent.id,
          trigger: { kind: "manual" },
          instruction: "x",
        }),
      )
    ).json()) as { id: string; has_fire_url: boolean }
    expect(manual.has_fire_url).toBe(false)
    expect((await fire(manual.id, "dfire_x", "{}")).status).toBe(404)
  })

  it("a disabled automation refuses fires; empty, invalid, and oversized bodies are handled", async () => {
    const { body: off } = await createWebhookAutomation({ enabled: false })
    expect((await fire(off.id as string, off.fire_secret as string, "{}")).status).toBe(400)

    const { body: live } = await createWebhookAutomation()
    // An empty body fires with an empty payload.
    expect((await fire(live.id as string, live.fire_secret as string, "")).status).toBe(202)
    // Invalid JSON is rejected before it can reach the queue.
    expect((await fire(live.id as string, live.fire_secret as string, "{not json")).status).toBe(
      400,
    )
    // An over-cap body is rejected.
    const huge = JSON.stringify({ big: "x".repeat(70_000) })
    expect((await fire(live.id as string, live.fire_secret as string, huge)).status).toBe(413)
  })
})
