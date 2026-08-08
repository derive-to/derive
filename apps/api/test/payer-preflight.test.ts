import { describe, expect, it } from "vitest"
import { POOL_USER } from "../src/lib/payer"
import { as, connectPoolPlan, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The PAYER PREFLIGHT: never queue work that nothing can pay for.
//
// Before this, a workspace with no connected model plan could create an automation, press Run
// now, boot a container, and fail — paying container time to discover something knowable at the
// door. Worse on a schedule, which repeats that forever with nobody watching.
//
// Every lane that CREATES work is covered here, because a guard with one hole is not a guard:
// the REST run-now, the webhook fire, the schedule tick, the MCP run_now, and both ask lanes
// (REST and MCP). The lanes that merely RECORD work which already ran elsewhere must NOT be
// guarded, and that is asserted too — refusing those would lose the ledger for exactly the BYO
// users who cost us nothing.
//
// Each test here fails if the corresponding guard is deleted. That was checked by deleting them.
describe("payer preflight: refusing work nothing can pay for", () => {
  const owner: TestUser = { id: "u_pay_own", email: "payown@derive.test", name: "Owner" }
  // noPlan: this whole file is about a workspace that has connected nothing.
  const { app, meta } = makeAuthedApp("payer-preflight", [owner], "editor", { noPlan: true })

  const mintAgent = async (name: string) => {
    const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name }))
    return (await res.json()) as { id: string; token: string }
  }
  const createAutomation = async (agentId: string, over: object = {}) => {
    const res = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        agentId,
        trigger: { kind: "manual" },
        instruction: "keep the roadmap current",
        ...over,
      }),
    )
    return (await res.json()) as { id: string; fire_secret?: string }
  }

  it("REST run-now is refused with 402, and the message names every way to fix it", async () => {
    const agent = await mintAgent("RunNow")
    const a = await createAutomation(agent.id)
    const res = await app.request(`/v1/automations/${a.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(res.status).toBe(402)
    const body = (await res.json()) as { error: string }
    // The refusal has to be actionable: an API key, an OAuth connection and a CLI login all
    // count, and the workspace pool and owner-lend are alternatives to connecting your own.
    expect(body.error).toMatch(/API key/i)
    expect(body.error).toMatch(/workspace/i)
  })

  it("atomic create-and-run unwinds both the automation and its managed agent when no plan can pay", async () => {
    const beforeAutos = await meta.listAutomations("default")
    const beforeAgents = await meta.listAgents("default")
    const res = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: { kind: "manual" },
        instruction: "prove or leave no partial setup",
        provider: "codex",
        runNow: true,
      }),
    )
    expect(res.status).toBe(402)
    expect(await meta.listAutomations("default")).toHaveLength(beforeAutos.length)
    expect(await meta.listAgents("default")).toHaveLength(beforeAgents.length)
  })

  it("a webhook fire is refused, so the CALLER learns to stop retrying", async () => {
    const agent = await mintAgent("Fire")
    const a = await createAutomation(agent.id, { trigger: { kind: "event", on: "webhook" } })
    expect(a.fire_secret).toBeTruthy()
    const res = await app.request(`/v1/automations/${a.id}/fire`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.fire_secret}`, "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    })
    expect(res.status).toBe(402)
  })

  it("the MCP ask lane is refused before a session opens", async () => {
    // The REST ask lane's twin. Both guard AFTER the dedupe join, so joining an already-open
    // session keeps working even in a workspace whose plan was disconnected afterwards.
    const agent = await mintAgent("AskAgent")
    const manifest = (await (
      await publishAs(app, "# QA manifest", { title: "QA manifest" }, as(owner.email))
    ).json()) as { short_id: string }
    const create = await app.request(
      "/v1/contexts",
      jsonAs(as(owner.email), {
        name: "QA",
        agent_id: agent.id,
        manifest_short_id: manifest.short_id,
      }),
    )
    expect(create.status).toBe(201)
    const cx = (await create.json()) as { id: string }
    const res = await app.request(
      `/v1/contexts/${cx.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "what changed this week?" }),
    )
    expect(res.status).toBe(402)
  })

  it("connecting a plan unblocks the SAME request that was refused", async () => {
    // The other half of the promise: the refusal has to be a door, not a wall. This is the
    // test that would catch a preflight stricter than the executor — one that refuses work
    // which would in fact have run.
    const agent = await mintAgent("Unblocked")
    const a = await createAutomation(agent.id)
    const run = () =>
      app.request(`/v1/automations/${a.id}/run`, { method: "POST", headers: as(owner.email) })

    expect((await run()).status).toBe(402)
    await connectPoolPlan(meta, "default")
    expect((await run()).status).toBe(201)

    // ...and the pool row is what did it — the tier a workspace adds for work with no person
    // behind it.
    const creds = await meta.listModelCredentials("default", POOL_USER)
    expect(creds.length).toBe(1)
  })

  it("requires a plan for the selected provider instead of accepting an unrelated subscription", async () => {
    const agent = await mintAgent("ProviderExact")
    const a = await createAutomation(agent.id, { provider: "codex" })
    const run = () =>
      app.request(`/v1/automations/${a.id}/run`, { method: "POST", headers: as(owner.email) })

    await connectPoolPlan(meta, "default", "claude-code")
    expect((await run()).status).toBe(402)
    await connectPoolPlan(meta, "default", "codex")
    expect((await run()).status).toBe(201)
  })
})

describe("payer preflight: recording work that already ran is NEVER refused", () => {
  const owner: TestUser = { id: "u_rec_own", email: "recown@derive.test", name: "Owner" }
  const { app } = makeAuthedApp("payer-record", [owner], "editor", { noPlan: true })

  it("POST /v1/agent/runs files a finished run with no plan connected", async () => {
    // A BYO run executed on someone's own machine, at their own expense, and is filing its
    // receipt. Requiring a Derive-side plan here would refuse to record history for the users
    // who cost us nothing — the exact opposite of what the preflight is for. The distinction
    // is queue-work vs record-work, not which endpoint it is.
    const mint = await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Local" }))
    const agent = (await mint.json()) as { id: string; token: string }
    const res = await app.request("/v1/agent/runs", {
      method: "POST",
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "local", status: "succeeded" }),
    })
    expect(res.status).toBe(201)
  })
})

describe("payer preflight: the operator gateway covers only the loop it can authenticate", () => {
  const owner: TestUser = { id: "u_pay_gateway", email: "gateway@derive.test", name: "Owner" }
  const model = async () => ({ text: "ok", toolUses: [], costUsd: null, done: true })

  const createAndRun = async (
    app: ReturnType<typeof makeAuthedApp>["app"],
    provider: "claude-code" | "codex" = "claude-code",
  ) => {
    const create = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: { kind: "manual" },
        instruction: "keep this current",
        provider,
      }),
    )
    const automation = (await create.json()) as { id: string }
    return app.request(`/v1/automations/${automation.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
  }

  it("does not mistake an attended callModel gateway for a CLI plan", async () => {
    const { app } = makeAuthedApp("payer-attended-only", [owner], "editor", {
      noPlan: true,
      deps: { callModel: model },
    })
    expect((await createAndRun(app)).status).toBe(402)
  })

  it("covers Claude on the in-process loop, while Codex still requires a Codex plan", async () => {
    const { app } = makeAuthedApp("payer-loop-operator", [owner], "editor", {
      noPlan: true,
      deps: { callModel: model, automationOperatorPays: true },
    })
    expect((await createAndRun(app)).status).toBe(201)
    expect((await createAndRun(app, "codex")).status).toBe(402)
  })
})
