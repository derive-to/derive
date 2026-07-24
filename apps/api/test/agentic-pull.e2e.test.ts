import { drainRuns, submitRevision } from "@derive/hosted-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Agentic pull — the inbound half — end to end on the REAL stack: an automation BOUND to a
// source connection, a run-now enqueue, the claim that carries the run's LEAST-PRIVILEGE source
// tools, the tool endpoint that runs them server-side (credentials never leave the API, and a
// ref the run didn't bind is refused), and drainRuns wiring those tools onto the run so a pull
// fetches from its source and writes a new artifact version. Only the model is a stand-in
// (runOne is injected and plays the agent — the designed seam); the LocalBroker stands in for a
// vendor with zero external dependency, so the whole flow runs offline.

const owner: TestUser = { id: "u_pull_own", email: "pull@derive.test", name: "Owner" }
const { app } = makeAuthedApp("agentic-pull", [owner], "commenter", {
  deps: { encryptionKey: "test-encryption-key" },
})

// Route the executor's HTTP straight into the in-process app: a true wire-shape test without a
// listening socket. Both the run drain and the tool-execution callback go over fetch.
const shimFetch = () =>
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    return app.request(u.pathname + u.search, init)
  })
afterEach(() => vi.unstubAllGlobals())

const publish = async (title: string, content: string) => {
  const res = await publishAs(app, content, { title }, as(owner.email))
  expect(res.status).toBeLessThan(300)
  return (await res.json()) as { short_id: string }
}
const detail = async (shortId: string) =>
  (await (await app.request(`/v1/artifacts/${shortId}`, { headers: as(owner.email) })).json()) as {
    current_version: number
  }
// Editor seat: the live-publish lane needs it (a commenter seat is propose-only).
const mintAgent = async (name: string) => {
  const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name, role: "editor" }))
  return (await res.json()) as { id: string; token: string }
}
const connect = async (toolkit: string) => {
  const res = await app.request("/v1/connections", jsonAs(as(owner.email), { toolkit }))
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}
const createAutomation = async (body: object) => {
  const res = await app.request("/v1/automations", jsonAs(as(owner.email), body))
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}
const runNow = async (id: string) => {
  const res = await app.request(`/v1/automations/${id}/run`, {
    method: "POST",
    headers: as(owner.email),
  })
  expect(res.status).toBe(201)
}
type ClaimTool = { def: { name: string; description: string }; ref: string }
type ClaimedRun = { id: string; instruction: string; tools: ClaimTool[] }
const claim = async (token: string) => {
  const res = await app.request("/v1/agent/runs/claim", { headers: bearer(token) })
  return (await res.json()) as { runs: ClaimedRun[] }
}
// Claim and assert exactly one run, narrowed so the tests can read it without null noise.
const claimOne = async (token: string): Promise<ClaimedRun> => {
  const { runs } = await claim(token)
  expect(runs).toHaveLength(1)
  const run = runs[0]
  if (!run) throw new Error("expected exactly one claimed run")
  return run
}
const callTool = (token: string, runId: string, body: object) =>
  app.request(`/v1/agent/runs/${runId}/tool`, jsonAs(bearer(token), body))

describe("agentic pull — bound sources, least-privilege tools, and a pulling run", () => {
  it("the claim carries the run's tools — its bound source only, never the workspace's others", async () => {
    const stripe = await connect("stripe")
    await connect("gmail") // a workspace connection the automation does NOT bind
    const agent = await mintAgent("Pull Runner LP")
    const auto = await createAutomation({
      agentId: agent.id,
      trigger: { kind: "manual" },
      instruction: "Pull the latest numbers.",
      connectionIds: [stripe.id],
    })
    await runNow(auto.id)

    const run = await claimOne(agent.token)
    // Exactly the bound source's tools — gmail (connected, unbound) contributes nothing.
    expect(run.tools.map((t) => t.def.name).sort()).toEqual(["stripe.read", "stripe.write"])
    // Every tool rides its connected-account ref, which is how the endpoint scopes execution.
    expect(run.tools.every((t) => t.ref === `local:stripe:${owner.id}`)).toBe(true)
  })

  it("rejects binding a connection that isn't in this workspace", async () => {
    const agent = await mintAgent("Pull Runner Foreign")
    const res = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        agentId: agent.id,
        trigger: { kind: "manual" },
        instruction: "Pull.",
        connectionIds: ["conn_does_not_exist"],
      }),
    )
    expect(res.status).toBe(400)
  })

  it("the tool endpoint runs a bound tool server-side and refuses a ref the run didn't bind", async () => {
    const notion = await connect("notion")
    const agent = await mintAgent("Pull Runner Tool")
    const auto = await createAutomation({
      agentId: agent.id,
      trigger: { kind: "manual" },
      instruction: "Pull the notes.",
      connectionIds: [notion.id],
    })
    await runNow(auto.id)
    const run = await claimOne(agent.token)
    const notionRef = run.tools[0]?.ref ?? ""

    // A bound tool executes; the LocalBroker echoes a deterministic result. Credentials never
    // leave the API — the executor only ever holds the tool def + ref.
    const ok = await callTool(agent.token, run.id, {
      ref: notionRef,
      tool: "notion.read",
      args: { query: "roadmap" },
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({
      result: { ok: true, provider: "local", tool: "notion.read", args: { query: "roadmap" } },
    })

    // A ref outside this run's bound set (least privilege) is refused, even a well-formed one.
    const denied = await callTool(agent.token, run.id, {
      ref: `local:gmail:${owner.id}`,
      tool: "gmail.read",
      args: {},
    })
    expect(denied.status).toBe(403)
  })

  it("a run with no bound sources cannot execute any tool", async () => {
    const agent = await mintAgent("Pull Runner None")
    const auto = await createAutomation({
      agentId: agent.id,
      trigger: { kind: "manual" },
      instruction: "Just write something.",
    })
    await runNow(auto.id)
    const run = await claimOne(agent.token)
    expect(run.tools).toEqual([])
    const denied = await callTool(agent.token, run.id, {
      ref: `local:stripe:${owner.id}`,
      tool: "stripe.read",
      args: {},
    })
    expect(denied.status).toBe(403)
  })

  it("drainRuns wires the source tools onto the run; a pull fetches and writes a new version", async () => {
    // Let the target's writes publish live (still with a review round) so the bump is assertable.
    await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ agentAutoEnabled: true }),
    })
    shimFetch()

    const doc = await publish(
      "Revenue Snapshot",
      "# Revenue Snapshot\n\nMRR: unknown\nUpdated: never",
    )
    const github = await connect("github")
    const agent = await mintAgent("Pull Writer")
    const auto = await createAutomation({
      agentId: agent.id,
      trigger: { kind: "manual" },
      instruction: `Pull the current MRR from the source and refresh ${doc.short_id}.`,
      refs: [{ kind: "artifact", id: doc.short_id, mode: "publish" }],
      connectionIds: [github.id],
    })
    await runNow(auto.id)

    let pulled: unknown
    const res = await drainRuns({
      server: "http://derive.internal",
      agentToken: agent.token,
      manifest: "You are this workspace's agent.",
      resolveModel: () => ({}) as never,
      runOne: async (ctx, task) => {
        expect(task).toContain(doc.short_id)
        // The executor wired the run's SOURCE tools onto the context, keyed by sanitized name.
        const read = ctx.extraTools?.github_read
        expect(read).toBeTruthy()
        // Calling it round-trips through the API's tool endpoint (credentials stay server-side).
        pulled = await read?.execute?.({ args: { query: "mrr" } }, {} as never)
        await submitRevision(ctx, {
          shortId: doc.short_id,
          content: "# Revenue Snapshot\n\nMRR: $42k\nUpdated: today",
          filename: "snapshot.md",
          confidence: 0.9,
          message: "pulled MRR from source",
        })
      },
    })

    expect(res).toMatchObject({ claimed: 1, finished: 1, failed: 0 })
    // The pulled value came back through the proxy, not from the executor holding credentials.
    expect(pulled).toMatchObject({
      ok: true,
      provider: "local",
      tool: "github.read",
      args: { query: "mrr" },
    })
    // The freshness write landed as a new live version.
    expect((await detail(doc.short_id)).current_version).toBe(2)
  })
})
