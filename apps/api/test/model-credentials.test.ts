import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

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
