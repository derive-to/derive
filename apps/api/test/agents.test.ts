import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

describe("agents: @mention → pull inbox → ack", () => {
  const owner: TestUser = { id: "u_ag_own", email: "agown@derive.test", name: "Owner" }
  const dev: TestUser = { id: "u_ag_dev", email: "agdev@derive.test", name: "Dev" }
  const { app } = makeAuthedApp("agents", [owner, dev], "commenter")
  let shortId: string
  let agentId: string
  let agentToken: string
  let mentionId: string

  it("an owner registers an agent and gets its token once; a commenter cannot", async () => {
    // Provision roles in order: owner first (claims ownership), then dev (commenter).
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(dev.email) })
    expect((await app.request("/v1/agents", jsonAs(as(dev.email), { name: "Nope" }))).status).toBe(
      403,
    )
    const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Claude" }))
    expect(res.status).toBe(201)
    const a = await res.json()
    agentId = a.id
    agentToken = a.token
    expect(a.role).toBe("commenter")
    expect(typeof agentToken).toBe("string")
  })

  it("stores only the token hash at rest, yet the raw token still authenticates", async () => {
    const ag: TestUser = { id: "u_ag_hash", email: "aghash@derive.test", name: "Hasher" }
    const { app: a2, meta: m2 } = makeAuthedApp("agent-hash", [ag], "commenter")
    await a2.request("/v1/me", { headers: as(ag.email) }) // claims ownership
    const reg = await (await a2.request("/v1/agents", jsonAs(as(ag.email), { name: "Bot" }))).json()
    const raw = reg.token as string
    // Single-workspace mode provisions under the default org id.
    const [stored] = await m2.listAgents("default")
    if (!stored) throw new Error("expected one agent")
    expect(stored.token).not.toBe(raw) // the raw secret is never at rest
    expect(stored.token).toMatch(/^[0-9a-f]{64}$/) // it's a sha-256 hash
    // The raw token still works: the agent can read its own inbox.
    const inbox = await a2.request("/v1/agent/inbox", { headers: bearer(raw) })
    expect(inbox.status).toBe(200)
    // A near-miss token (its hash) does not authenticate.
    const wrong = await a2.request("/v1/agent/inbox", { headers: bearer(stored.token) })
    expect(wrong.status).toBe(401)
    m2.close()
  })

  it("a comment @mentioning the agent lands in the agent's inbox, not a notification", async () => {
    shortId = (
      await (await publishAs(app, "<h1>draft</h1>", { visibility: "org" }, as(owner.email))).json()
    ).short_id
    const cm = await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(owner.email), {
        body_md: "@Claude tighten the headline",
        mentions: [{ id: agentId, name: "Claude" }],
      }),
    )
    expect(cm.status).toBe(201)

    // The agent pulls its inbox with its own token.
    const inbox = await (
      await app.request("/v1/agent/inbox", { headers: bearer(agentToken) })
    ).json()
    expect(inbox.agent.id).toBe(agentId)
    expect(inbox.mentions).toHaveLength(1)
    expect(inbox.mentions[0].artifact).toBe(shortId)
    expect(inbox.mentions[0].body).toContain("tighten the headline")
    mentionId = inbox.mentions[0].id
  })

  it("acking the mention clears it from the inbox", async () => {
    const ack = await app.request(`/v1/agent/mentions/${mentionId}/ack`, {
      method: "POST",
      headers: bearer(agentToken),
    })
    expect(ack.status).toBe(200)
    const inbox = await (
      await app.request("/v1/agent/inbox", { headers: bearer(agentToken) })
    ).json()
    expect(inbox.mentions).toHaveLength(0)
  })

  it("the inbox rejects a non-agent caller", async () => {
    expect((await app.request("/v1/agent/inbox", { headers: as(owner.email) })).status).toBe(401)
  })
})

describe("agents: the record says who did the work", () => {
  const owner: TestUser = { id: "u_ag_rec", email: "agrec@derive.test", name: "Owner" }
  const { app } = makeAuthedApp("agents-record", [owner], "owner")

  it("an agent's publish, ask, comment and resolve are recorded as the agent's, on the person's behalf", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    const reg = await (
      await app.request(
        "/v1/agents",
        jsonAs(as(owner.email), { name: "Claude Code", role: "editor" }),
      )
    ).json()
    const shortId = (await (await publishAs(app, "<h1>v1</h1>", {}, as(owner.email))).json())
      .short_id
    const pub = await publishAs(
      app,
      "<h1>v2</h1>",
      { request_review: "true", review_note: "Check §3." },
      bearer(reg.token),
      shortId,
    )
    expect(pub.status).toBe(201)

    // The byline stays the person's (authored work is theirs); the actor is the agent.
    const art = await (
      await app.request(`/v1/artifacts/${shortId}`, { headers: as(owner.email) })
    ).json()
    const byN = (n: number) => art.versions.find((v: { n: number }) => v.n === n)
    expect(byN(1).agent).toBeNull()
    expect(byN(2)).toMatchObject({ author: "Owner", agent: { id: reg.id, name: "Claude Code" } })
    expect(art.sessions.find((s: { n: number }) => s.n === 2)).toMatchObject({
      from_n: 2,
      agent_name: "Claude Code",
    })

    // The round names its asker, by name and kind.
    const review = await (
      await app.request(`/v1/artifacts/${shortId}/review`, { headers: as(owner.email) })
    ).json()
    expect(review.pending).toMatchObject({
      requested_by: reg.id,
      requested_by_name: "Claude Code",
      requested_by_kind: "agent",
    })

    // A comment carries its author's kind, from the recorded id.
    const theirs = await (
      await app.request(
        `/v1/artifacts/${shortId}/comments`,
        jsonAs(as(owner.email), { body_md: "Is §3 right?" }),
      )
    ).json()
    expect(theirs.author_kind).toBe("user")
    const agents = await (
      await app.request(
        `/v1/artifacts/${shortId}/comments`,
        jsonAs(bearer(reg.token), { body_md: "Fixed in the next version." }),
      )
    ).json()
    expect(agents).toMatchObject({ author: "Claude Code", author_id: reg.id, author_kind: "agent" })

    // A publish that names the thread in `resolves` records itself as the resolver.
    const fix = await publishAs(
      app,
      "<h1>v3</h1>",
      { resolves: theirs.id },
      bearer(reg.token),
      shortId,
    )
    expect(fix.status).toBe(201)
    const settled = (
      await (
        await app.request(`/v1/artifacts/${shortId}/comments?state=resolved`, {
          headers: as(owner.email),
        })
      ).json()
    ).comments
    expect(settled.find((c: { id: string }) => c.id === theirs.id).resolution).toMatchObject({
      by: "Claude Code",
      by_id: reg.id,
      by_kind: "agent",
      version: 3,
    })
  })
})
