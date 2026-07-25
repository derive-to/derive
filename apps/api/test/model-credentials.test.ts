import { newId } from "@derive/core"
import { describe, expect, it } from "vitest"
import { encryptSecret } from "../src/lib/crypto"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Model-plan credentials + the chain the executor bills against:
//   initiator (asker/clicker)  ->  owner (only if THIS agent is lent)  ->  workspace pool  ->  null
// A member connects their OWN plan token (encrypted at rest). The owner fallback is OFF by
// default — it applies only to agents the owner has explicitly lent — so isolation AND the
// default-closed gate are what these tests pin down.
describe("model credentials", () => {
  const owner: TestUser = { id: "u_mc_own", email: "mcown@derive.test", name: "Owner" }
  const other: TestUser = { id: "u_mc_oth", email: "mcoth@derive.test", name: "Other" }
  // A configured encryption key is what makes the connect endpoint work at all.
  const { app } = makeAuthedApp("model-creds", [owner, other], "editor", {
    deps: { encryptionKey: "test-enc-secret" },
  })

  const mintAgent = async (email: string, name: string) => {
    const res = await app.request("/v1/agents", jsonAs(as(email), { name }))
    return (await res.json()) as { id: string; token: string }
  }
  const connect = (email: string, body: object) =>
    app.request("/v1/me/model-credentials", jsonAs(as(email), body))
  const lend = (email: string, agentId: string, enabled: boolean) =>
    app.request(`/v1/workspace/owner-lend/${agentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(email) },
      body: JSON.stringify({ enabled }),
    })
  const agentCred = (token: string, provider = "codex") =>
    app.request(`/v1/agent/model-credential?provider=${provider}`, { headers: bearer(token) })

  it("connect stores an encrypted secret; list returns hints only, never the token", async () => {
    const token = "sk-ant-oat01-SUPERSECRETVALUE9999"
    const res = await connect(owner.email, { provider: "codex", kind: "api_key", token })
    expect(res.status).toBe(201)
    expect((await res.json()).hint).toBe("9999")

    const list = await (
      await app.request("/v1/me/model-credentials", { headers: as(owner.email) })
    ).json()
    expect(list.credentials).toHaveLength(1)
    expect(list.credentials[0]).toMatchObject({ provider: "codex", kind: "api_key", hint: "9999" })
    // The raw token is NEVER in the list response.
    expect(JSON.stringify(list)).not.toContain(token)
  })

  it("owner-lend is OFF by default: a no-initiator fetch is null even though the owner has a plan", async () => {
    await connect(owner.email, { provider: "codex", kind: "api_key", token: "owner-plan-fixture" })
    const agent = await mintAgent(owner.email, "Owner Runner")
    const got = await (await agentCred(agent.token)).json()
    // The owner has a plan, but this agent isn't lent — fail closed, don't silently bill them.
    expect(got.credential).toBeNull()
  })

  it("once the owner lends THIS agent, the fetch returns the owner's decrypted plan (source owner)", async () => {
    await connect(owner.email, { provider: "codex", kind: "api_key", token: "owner-plan-lent" })
    const agent = await mintAgent(owner.email, "Lent Runner")
    const on = await lend(owner.email, agent.id, true)
    expect(on.status).toBe(200)
    const got = await (await agentCred(agent.token)).json()
    expect(got.credential).toEqual({ kind: "api_key", value: "owner-plan-lent" })
    expect(got.source).toBe("owner")
    // Un-lending closes it again — the gate is live, not a one-way latch.
    await lend(owner.email, agent.id, false)
    expect((await (await agentCred(agent.token)).json()).credential).toBeNull()
  })

  it("ISOLATION: a lent agent resolves ONLY its owner's row, and only the asked provider", async () => {
    // Owner connects codex, but NOT claude-code. Cross-USER keying (one user's row is never
    // another's) is proven exhaustively in the db store-contract (u1 vs u2).
    await connect(owner.email, { provider: "codex", kind: "api_key", token: "sk-owner-only" })
    const agent = await mintAgent(owner.email, "Owner Runner 2")
    await lend(owner.email, agent.id, true)
    expect((await (await agentCred(agent.token, "codex")).json()).credential?.value).toBe(
      "sk-owner-only",
    )
    // Even lent, an unconnected provider is null — never another provider's row.
    expect((await (await agentCred(agent.token, "claude-code")).json()).credential).toBeNull()
  })

  it("only the agent's OWNER may lend; a non-admin member is refused", async () => {
    const agent = await mintAgent(owner.email, "Guarded Runner")
    const res = await lend(other.email, agent.id, true)
    expect([401, 403]).toContain(res.status)
  })

  it("the agent surface requires an agent bearer", async () => {
    const anon = await app.request("/v1/agent/model-credential?provider=codex")
    expect([401, 403]).toContain(anon.status)
  })
})

// The workspace POOL (a sentinel-user credential row) is the org's shared plan, billed only
// when nobody more specific is on the hook. And owner-lend OUTRANKS the pool: a deliberate
// per-agent grant is honored before the shared wallet.
describe("model credentials: workspace pool + owner-lend precedence", () => {
  const owner: TestUser = { id: "u_mcp_own", email: "mcpown@derive.test", name: "Owner" }
  const editor: TestUser = { id: "u_mcp_ed", email: "mcped@derive.test", name: "Editor" }
  const { app } = makeAuthedApp("model-creds-pool", [owner, editor], "editor", {
    deps: { encryptionKey: "test-enc-secret" },
  })
  const mintAgent = async (name: string) =>
    (await (await app.request("/v1/agents", jsonAs(as(owner.email), { name }))).json()) as {
      id: string
      token: string
    }
  const connectPool = (email: string, body: object) =>
    app.request("/v1/workspace/model-credentials", jsonAs(as(email), body))
  const lend = (agentId: string, enabled: boolean) =>
    app.request(`/v1/workspace/owner-lend/${agentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ enabled }),
    })
  const agentCred = (token: string) =>
    app.request("/v1/agent/model-credential?provider=codex", { headers: bearer(token) })

  it("a non-admin cannot connect the workspace pool", async () => {
    const res = await connectPool(editor.email, {
      provider: "codex",
      kind: "api_key",
      token: "sk-pool-nope",
    })
    expect([401, 403]).toContain(res.status)
  })

  it("the pool bills a run when nobody is lent (source pool)", async () => {
    const res = await connectPool(owner.email, {
      provider: "codex",
      kind: "api_key",
      token: "sk-workspace-pool",
    })
    expect(res.status).toBe(201)
    const agent = await mintAgent("Pool Runner")
    const got = await (await agentCred(agent.token)).json()
    expect(got.credential).toEqual({ kind: "api_key", value: "sk-workspace-pool" })
    expect(got.source).toBe("pool")
  })

  it("owner-lend OUTRANKS the pool: a lent agent bills the owner, not the pool", async () => {
    await app.request(
      "/v1/me/model-credentials",
      jsonAs(as(owner.email), {
        provider: "codex",
        kind: "api_key",
        token: "sk-owner-over-pool",
      }),
    )
    const agent = await mintAgent("Precedence Runner")
    await lend(agent.id, true)
    const got = await (await agentCred(agent.token)).json()
    expect(got.credential?.value).toBe("sk-owner-over-pool")
    expect(got.source).toBe("owner")
  })

  it("the pool is hints-only on GET and removable; deleting it re-closes the fallback", async () => {
    const list = await (
      await app.request("/v1/workspace/model-credentials", { headers: as(owner.email) })
    ).json()
    expect(list.credentials.some((c: { provider: string }) => c.provider === "codex")).toBe(true)
    expect(JSON.stringify(list)).not.toContain("sk-workspace-pool")
    const del = await app.request("/v1/workspace/model-credentials/codex", {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(del.status).toBe(204)
    // Pool gone and nobody lent → a fresh agent is fail-closed.
    const agent = await mintAgent("Post-Delete Runner")
    expect((await (await agentCred(agent.token)).json()).credential).toBeNull()
  })
})

// The initiator chain: a session-keyed fetch bills the run's ASKER first — their question,
// their tokens. Only when the asker has no plan does it consider the owner (and only if the
// agent is lent). Session ids resolve ONLY within the calling agent's own context: anything
// else is a 404, so foreign ids neither leak nor bill.
describe("model credentials: session-keyed initiator resolution", () => {
  const owner: TestUser = { id: "u_mcs_own", email: "mcsown@derive.test", name: "Owner" }
  const asker: TestUser = { id: "u_mcs_ask", email: "mcsask@derive.test", name: "Asker" }
  const { app } = makeAuthedApp("model-creds-sessions", [owner, asker], "editor", {
    deps: { encryptionKey: "test-enc-secret" },
  })
  const connect = (email: string, body: object) =>
    app.request("/v1/me/model-credentials", jsonAs(as(email), body))

  let agentId: string
  let agentToken: string
  let sessionId: string

  it("setup: wire a context, invite the asker, open a session, connect both plans", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(asker.email) })
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Shared Analyst" }))
    ).json()
    agentId = ag.id
    agentToken = ag.token
    const manifest = await (await publishAs(app, "# Shared manifest", {}, as(owner.email))).json()
    const ctx = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Shared",
          agent_id: ag.id,
          manifest_short_id: manifest.short_id,
        }),
      )
    ).json()
    await app.request(
      `/v1/contexts/${ctx.id}/askers`,
      jsonAs(as(owner.email), { email: asker.email }),
    )
    const asked = await (
      await app.request(
        `/v1/contexts/${ctx.id}/sessions`,
        jsonAs(as(asker.email), { body_md: "whose plan pays?" }),
      )
    ).json()
    sessionId = asked.session?.id
    expect(sessionId).toBeTruthy()
    await connect(owner.email, {
      provider: "claude-code",
      kind: "api_key",
      token: "sk-owner-plan",
    })
    await connect(asker.email, {
      provider: "claude-code",
      kind: "api_key",
      token: "sk-asker-plan",
    })
  })

  it("a session-keyed fetch returns the ASKER's plan, not the owner's", async () => {
    const got = await (
      await app.request(`/v1/agent/model-credential?provider=claude-code&session=${sessionId}`, {
        headers: bearer(agentToken),
      })
    ).json()
    expect(got.credential).toEqual({ kind: "api_key", value: "sk-asker-plan" })
    expect(got.source).toBe("asker")
  })

  it("an asker with no plan is null by default (owner not lent, no pool) — fail closed", async () => {
    await app.request("/v1/me/model-credentials/claude-code", {
      method: "DELETE",
      headers: as(asker.email),
    })
    const got = await (
      await app.request(`/v1/agent/model-credential?provider=claude-code&session=${sessionId}`, {
        headers: bearer(agentToken),
      })
    ).json()
    expect(got.credential).toBeNull()
  })

  it("an asker with no plan uses the OWNER's plan once the agent is lent (source owner)", async () => {
    await app.request(`/v1/workspace/owner-lend/${agentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ enabled: true }),
    })
    const got = await (
      await app.request(`/v1/agent/model-credential?provider=claude-code&session=${sessionId}`, {
        headers: bearer(agentToken),
      })
    ).json()
    expect(got.credential).toEqual({ kind: "api_key", value: "sk-owner-plan" })
    expect(got.source).toBe("owner")
  })

  it("ISOLATION: a session outside the calling agent's context is a 404, not a bill", async () => {
    // A second agent NOT wired to the context must not resolve the session at all.
    const foreign = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Unwired Runner" }))
    ).json()
    const res = await app.request(
      `/v1/agent/model-credential?provider=claude-code&session=${sessionId}`,
      { headers: bearer(foreign.token) },
    )
    expect(res.status).toBe(404)
  })

  it("an unknown session id is a 404, never a silent owner fallback", async () => {
    const res = await app.request(
      "/v1/agent/model-credential?provider=claude-code&session=ses_nope",
      { headers: bearer(agentToken) },
    )
    expect(res.status).toBe(404)
  })
})

// The automation lane of the same chain: ?run= resolves the run's initiated_by (the person
// who clicked Run now) before the owner tier; a clock/event run (null initiator) falls
// straight through to owner/pool. Run ids resolve only for the agent the run belongs to.
describe("model credentials: run-keyed initiator resolution", () => {
  const owner: TestUser = { id: "u_mcr_own", email: "mcrown@derive.test", name: "Owner" }
  const clicker: TestUser = { id: "u_mcr_clk", email: "mcrclk@derive.test", name: "Clicker" }
  const { app } = makeAuthedApp("model-creds-runs", [owner, clicker], "editor", {
    deps: { encryptionKey: "test-enc-secret" },
  })
  const connect = (email: string, body: object) =>
    app.request("/v1/me/model-credentials", jsonAs(as(email), body))

  let agentId: string
  let agentToken: string
  let runId: string

  it("setup: automation + Run now by the clicker, both plans connected", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(clicker.email) })
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Automation Runner" }))
    ).json()
    agentId = ag.id
    agentToken = ag.token
    const auto = await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          agentId: ag.id,
          trigger: { kind: "manual" },
          instruction: "whose plan pays for a run?",
        }),
      )
    ).json()
    const run = await (
      await app.request(`/v1/automations/${auto.id}/run`, {
        method: "POST",
        headers: as(clicker.email),
      })
    ).json()
    runId = run.id
    expect(runId).toBeTruthy()
    await connect(owner.email, {
      provider: "claude-code",
      kind: "api_key",
      token: "sk-owner-plan",
    })
    await connect(clicker.email, {
      provider: "claude-code",
      kind: "api_key",
      token: "sk-clicker-plan",
    })
  })

  it("a run-keyed fetch bills the CLICKER (initiated_by), not the owner", async () => {
    const got = await (
      await app.request(`/v1/agent/model-credential?provider=claude-code&run=${runId}`, {
        headers: bearer(agentToken),
      })
    ).json()
    expect(got.credential).toEqual({ kind: "api_key", value: "sk-clicker-plan" })
    expect(got.source).toBe("initiator")
  })

  it("an initiator with no plan is null by default (agent not lent, no pool)", async () => {
    await app.request("/v1/me/model-credentials/claude-code", {
      method: "DELETE",
      headers: as(clicker.email),
    })
    const got = await (
      await app.request(`/v1/agent/model-credential?provider=claude-code&run=${runId}`, {
        headers: bearer(agentToken),
      })
    ).json()
    expect(got.credential).toBeNull()
  })

  it("an initiator with no plan uses the OWNER's plan once the agent is lent", async () => {
    await app.request(`/v1/workspace/owner-lend/${agentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ enabled: true }),
    })
    const got = await (
      await app.request(`/v1/agent/model-credential?provider=claude-code&run=${runId}`, {
        headers: bearer(agentToken),
      })
    ).json()
    expect(got.credential).toEqual({ kind: "api_key", value: "sk-owner-plan" })
    expect(got.source).toBe("owner")
  })

  it("ISOLATION: another agent's run id is a 404, not a bill", async () => {
    const foreign = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Unrelated Runner" }))
    ).json()
    const res = await app.request(`/v1/agent/model-credential?provider=claude-code&run=${runId}`, {
      headers: bearer(foreign.token),
    })
    expect(res.status).toBe(404)
  })

  it("an unknown run id is a 404, never a silent owner fallback", async () => {
    const res = await app.request("/v1/agent/model-credential?provider=claude-code&run=run_nope", {
      headers: bearer(agentToken),
    })
    expect(res.status).toBe(404)
  })
})

// Robustness of the resolver's read path: a workspace-pool row keyed on the sentinel user
// never surfaces in a personal list, and a stored secret that can't be decrypted (a rotated
// DERIVE_AUTH_SECRET, a corrupt blob) is treated as absent — null with reason "unreadable",
// never a 500. Both are edges the account-safety story leans on.
describe("model credentials: pool isolation + unreadable secrets", () => {
  const owner: TestUser = { id: "u_mcx_own", email: "mcxown@derive.test", name: "Owner" }
  const { app, meta } = makeAuthedApp("model-creds-x", [owner], "editor", {
    deps: { encryptionKey: "test-enc-secret" },
  })
  const mintAgent = async (name: string) =>
    (await (await app.request("/v1/agents", jsonAs(as(owner.email), { name }))).json()) as {
      id: string
      token: string
    }

  it("the workspace pool never leaks into a personal list", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    // Connect ONLY the pool (the sentinel-user row), nothing personal.
    const res = await app.request(
      "/v1/workspace/model-credentials",
      jsonAs(as(owner.email), { provider: "codex", kind: "api_key", token: "sk-pool-only-7777" }),
    )
    expect(res.status).toBe(201)
    const mine = await (
      await app.request("/v1/me/model-credentials", { headers: as(owner.email) })
    ).json()
    // The admin's OWN list is empty: the pool row is keyed on the sentinel user, not them.
    expect(mine.credentials).toHaveLength(0)
  })

  it("an unreadable stored secret is null + reason 'unreadable', never a 500", async () => {
    // Simulate a key rotation: a v1 blob encrypted under a DIFFERENT key can't be read here.
    const now = new Date().toISOString()
    await meta.setModelCredential({
      id: newId("mcr"),
      org_id: "default",
      user_id: "__workspace_pool__",
      provider: "claude-code",
      kind: "oauth",
      secret: encryptSecret("stale-token", "a-different-key"),
      hint: "9999",
      created_at: now,
      updated_at: now,
    })
    const agent = await mintAgent("Reader")
    const res = await app.request("/v1/agent/model-credential?provider=claude-code", {
      headers: bearer(agent.token),
    })
    expect(res.status).toBe(200) // NOT a 500
    const body = await res.json()
    expect(body.credential).toBeNull()
    expect(body.reason).toBe("unreadable")
  })
})

// Refresh persistence: the executor PUTs a refreshed blob back to the SAME row a run resolved
// to, so a rotated single-use login (Codex) stays valid across runs. Same 404 isolation as the
// read: a foreign session/run id never writes a cross-row.
describe("model credentials: refresh persistence (PUT)", () => {
  const owner: TestUser = { id: "u_mcr2_own", email: "mcr2own@derive.test", name: "Owner" }
  const { app } = makeAuthedApp("model-creds-refresh", [owner], "editor", {
    deps: { encryptionKey: "test-enc-secret" },
  })
  const mintAgent = async (name: string) =>
    (await (await app.request("/v1/agents", jsonAs(as(owner.email), { name }))).json()) as {
      id: string
      token: string
    }
  const readCred = (agentToken: string) =>
    app.request("/v1/agent/model-credential?provider=codex", { headers: bearer(agentToken) })
  const putCred = (token: string, agentToken: string, q = "") =>
    app.request(`/v1/agent/model-credential?provider=codex${q}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...bearer(agentToken) },
      body: JSON.stringify({ token }),
    })

  it("persists a refreshed login back to the resolved (pool) row; next read returns it", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request(
      "/v1/workspace/model-credentials",
      jsonAs(as(owner.email), { provider: "codex", kind: "login", token: '{"tokens":{"v":1}}' }),
    )
    const agent = await mintAgent("Refresher")
    const before = await (await readCred(agent.token)).json()
    expect(before.credential).toEqual({ kind: "login", value: '{"tokens":{"v":1}}' })
    // The run rotated the token in place; persist the refreshed blob.
    expect((await putCred('{"tokens":{"v":2}}', agent.token)).status).toBe(200)
    const after = await (await readCred(agent.token)).json()
    expect(after.credential.value).toBe('{"tokens":{"v":2}}')
  })

  it("a PUT with a foreign session id is a 404, never a cross-row write", async () => {
    const agent = await mintAgent("Refresher 2")
    const res = await putCred("x", agent.token, "&session=ses_nope")
    expect(res.status).toBe(404)
  })

  it("a PUT that resolves to no row is a 404 no-op (nothing to persist)", async () => {
    // No claude-code credential exists anywhere, so there is no row to update.
    const agent = await mintAgent("Refresher 3")
    const res = await app.request("/v1/agent/model-credential?provider=claude-code", {
      method: "PUT",
      headers: { "content-type": "application/json", ...bearer(agent.token) },
      body: JSON.stringify({ token: "x" }),
    })
    expect(res.status).toBe(404)
  })
})
