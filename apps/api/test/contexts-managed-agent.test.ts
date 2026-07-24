import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The end of "pick an agent": creating a context WITHOUT an agent_id auto-mints a
// MANAGED agent — the context's own Derive access, no roster persona. The token is
// returned exactly once on the create response; the roster marks the row managed so
// the UI can hide it; rotation is a credential event that never touches identity.
describe("contexts: auto-minted managed agents", () => {
  const owner: TestUser = { id: "u_cma_own", email: "cmaown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_cma_mem", email: "cmamem@derive.test", name: "Member" }
  const { app } = makeAuthedApp("contexts-managed", [owner, member], "editor")

  const mkManifest = async () =>
    (await (await publishAs(app, "# A manifest", {}, as(owner.email))).json()).short_id

  const mkContext = (name: string, body: object = {}) =>
    app.request("/v1/contexts", jsonAs(as(owner.email), { name, ...body }))

  it("create without agent_id mints a managed agent and returns its token ONCE", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await mkContext("Ship Report", { manifest_short_id: await mkManifest() })
    expect(created.status).toBe(201)
    const ctx = await created.json()
    expect(ctx.agent_id).toBeTruthy()
    expect(ctx.agent_token).toMatch(/^dk_agt_/)

    // The minted token IS a working agent bearer (not a 401)…
    const probe = await app.request("/v1/agent/model-credential", {
      headers: bearer(ctx.agent_token),
    })
    expect(probe.status).toBe(200)

    // …and the roster row is marked managed, named after the context,
    // attributed to the creator.
    const roster = (await (await app.request("/v1/agents", { headers: as(owner.email) })).json())
      .agents
    const minted = roster.find((a: { id: string }) => a.id === ctx.agent_id)
    expect(minted).toMatchObject({ name: "Ship Report", managed: true, role: "editor" })

    // The token never appears anywhere again: the GET surface has no token field.
    expect(JSON.stringify(roster)).not.toContain(ctx.agent_token)
  })

  it("a context named like an existing agent mints under a suffixed name, not a 409", async () => {
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analytics" }))
    const created = await mkContext("Analytics", { manifest_short_id: await mkManifest() })
    expect(created.status).toBe(201)
    const ctx = await created.json()
    const roster = (await (await app.request("/v1/agents", { headers: as(owner.email) })).json())
      .agents
    const minted = roster.find((a: { id: string }) => a.id === ctx.agent_id)
    expect(minted.managed).toBe(true)
    expect(minted.name).toMatch(/^Analytics .{4}$/)
  })

  it("a context-name 409 after the mint unwinds the minted agent — no orphaned tokens", async () => {
    const manifest = await mkManifest()
    expect((await mkContext("Dup", { manifest_short_id: manifest })).status).toBe(201)
    const before = (await (await app.request("/v1/agents", { headers: as(owner.email) })).json())
      .agents.length
    const dup = await mkContext("Dup", { manifest_short_id: manifest })
    expect(dup.status).toBe(409)
    const after = (await (await app.request("/v1/agents", { headers: as(owner.email) })).json())
      .agents.length
    expect(after).toBe(before)
  })

  it("passing an explicit agent_id still works and returns NO token", async () => {
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Service Agent" }))
    ).json()
    const created = await mkContext("Runs As Service", {
      agent_id: ag.id,
      manifest_short_id: await mkManifest(),
    })
    expect(created.status).toBe(201)
    const ctx = await created.json()
    expect(ctx.agent_id).toBe(ag.id)
    expect(ctx.agent_token).toBeUndefined()
  })
})

describe("agents: token rotation", () => {
  const owner: TestUser = { id: "u_rot_own", email: "rotown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_rot_mem", email: "rotmem@derive.test", name: "Member" }
  const { app } = makeAuthedApp("agents-rotate", [owner, member], "editor")

  it("rotate kills the old bearer at once; the new one works; identity is untouched", async () => {
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Rotor" }))
    ).json()
    const rotated = await app.request(`/v1/agents/${ag.id}/rotate`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(rotated.status).toBe(200)
    const r = await rotated.json()
    expect(r.token).toMatch(/^dk_agt_/)
    expect(r.token).not.toBe(ag.token)
    expect(r).toMatchObject({ id: ag.id, name: "Rotor" })

    const oldProbe = await app.request("/v1/agent/model-credential", {
      headers: bearer(ag.token),
    })
    expect(oldProbe.status).toBe(401)
    const newProbe = await app.request("/v1/agent/model-credential", {
      headers: bearer(r.token),
    })
    expect(newProbe.status).toBe(200)
  })

  it("rotation is Admin-gated and workspace-scoped", async () => {
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Rotor 2" }))
    ).json()
    const denied = await app.request(`/v1/agents/${ag.id}/rotate`, {
      method: "POST",
      headers: as(member.email),
    })
    expect([401, 403]).toContain(denied.status)
    const missing = await app.request("/v1/agents/ag_nope/rotate", {
      method: "POST",
      headers: as(owner.email),
    })
    expect(missing.status).toBe(404)
  })
})
