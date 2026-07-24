import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Per-user model-plan credentials. A member connects their OWN plan token (encrypted at
// rest); the executor fetches it via an agent bearer — scoped to the agent's registrant, so
// one user's token never reaches another user's runs. Isolation is the point of these tests.
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

  it("the agent surface returns the DECRYPTED credential of the agent's own registrant", async () => {
    await connect(owner.email, {
      provider: "codex",
      kind: "api_key",
      token: "sk-owner-plan-1234",
    })
    const agent = await mintAgent(owner.email, "Owner Runner")
    const got = await (
      await app.request("/v1/agent/model-credential?provider=codex", {
        headers: bearer(agent.token),
      })
    ).json()
    // Decrypted round-trip: the runner gets the real value to inject.
    expect(got.credential).toEqual({ kind: "api_key", value: "sk-owner-plan-1234" })
  })

  it("ISOLATION: the endpoint resolves ONLY the calling agent's registrant + provider", async () => {
    // Owner connects codex, but NOT claude-code. Their own agent gets the codex token and
    // null for claude-code — the lookup is keyed (org, registrant, provider), so it can only
    // ever return this agent-owner's own row. Cross-USER keying (one user's row is never
    // another's) is proven exhaustively in the db store-contract (u1 vs u2).
    await connect(owner.email, { provider: "codex", kind: "api_key", token: "sk-owner-only" })
    const agent = await mintAgent(owner.email, "Owner Runner 2")
    const codexGot = await (
      await app.request("/v1/agent/model-credential?provider=codex", {
        headers: bearer(agent.token),
      })
    ).json()
    expect(codexGot.credential?.value).toBe("sk-owner-only")
    const claudeGot = await (
      await app.request("/v1/agent/model-credential?provider=claude-code", {
        headers: bearer(agent.token),
      })
    ).json()
    expect(claudeGot.credential).toBeNull()
  })

  it("a missing provider connection is null (fail-closed at the runner), not a leak", async () => {
    const agent = await mintAgent(owner.email, "Runner 2")
    const got = await (
      await app.request("/v1/agent/model-credential?provider=claude-code", {
        headers: bearer(agent.token),
      })
    ).json()
    expect(got.credential).toBeNull()
  })

  it("disconnect removes it; the agent then gets null", async () => {
    await connect(owner.email, { provider: "codex", kind: "oauth", token: "sk-to-delete" })
    const del = await app.request("/v1/me/model-credentials/codex", {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(del.status).toBe(204)
    const agent = await mintAgent(owner.email, "Runner 3")
    const got = await (
      await app.request("/v1/agent/model-credential?provider=codex", {
        headers: bearer(agent.token),
      })
    ).json()
    expect(got.credential).toBeNull()
  })

  it("the agent surface requires an agent bearer", async () => {
    const anon = await app.request("/v1/agent/model-credential?provider=codex")
    expect([401, 403]).toContain(anon.status)
  })
})

// The initiator chain: a session-keyed fetch bills the run's ASKER first — their question,
// their tokens — and only falls back to the agent's registrant when the asker has no plan
// (the interim chain until the workspace pool lands). Session ids resolve ONLY within the
// calling agent's own context: anything else is a 404, so foreign ids neither leak nor bill.
describe("model credentials: session-keyed initiator resolution", () => {
  const owner: TestUser = { id: "u_mcs_own", email: "mcsown@derive.test", name: "Owner" }
  const asker: TestUser = { id: "u_mcs_ask", email: "mcsask@derive.test", name: "Asker" }
  const { app } = makeAuthedApp("model-creds-sessions", [owner, asker], "editor", {
    deps: { encryptionKey: "test-enc-secret" },
  })
  const connect = (email: string, body: object) =>
    app.request("/v1/me/model-credentials", jsonAs(as(email), body))

  let agentToken: string
  let sessionId: string

  it("setup: wire a context, invite the asker, open a session, connect both plans", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(asker.email) })
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Shared Analyst" }))
    ).json()
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
      token: "sk-registrant-plan",
    })
    await connect(asker.email, {
      provider: "claude-code",
      kind: "api_key",
      token: "sk-asker-plan",
    })
  })

  it("a session-keyed fetch returns the ASKER's plan, not the registrant's", async () => {
    const got = await (
      await app.request(`/v1/agent/model-credential?provider=claude-code&session=${sessionId}`, {
        headers: bearer(agentToken),
      })
    ).json()
    expect(got.credential).toEqual({ kind: "api_key", value: "sk-asker-plan" })
    expect(got.source).toBe("asker")
  })

  it("an asker with no plan falls back to the registrant (interim, until the pool)", async () => {
    await app.request("/v1/me/model-credentials/claude-code", {
      method: "DELETE",
      headers: as(asker.email),
    })
    const got = await (
      await app.request(`/v1/agent/model-credential?provider=claude-code&session=${sessionId}`, {
        headers: bearer(agentToken),
      })
    ).json()
    expect(got.credential).toEqual({ kind: "api_key", value: "sk-registrant-plan" })
    expect(got.source).toBe("registrant")
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

  it("an unknown session id is a 404, never a silent registrant fallback", async () => {
    const res = await app.request(
      "/v1/agent/model-credential?provider=claude-code&session=ses_nope",
      { headers: bearer(agentToken) },
    )
    expect(res.status).toBe(404)
  })
})
