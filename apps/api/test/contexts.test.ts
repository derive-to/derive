import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Contexts + sessions: the ask → answer → follow-up loop, its permission edges,
// and the runner's queue. The ask grant is "viewer on the manifest artifact", so
// the sharing machinery is exercised here too (a private manifest gates asking).
describe("contexts: create + wire an agent to a manifest", () => {
  const owner: TestUser = { id: "u_cx_own", email: "cxown@derive.test", name: "Owner" }
  const dev: TestUser = { id: "u_cx_dev", email: "cxdev@derive.test", name: "Dev" }
  const { app } = makeAuthedApp("contexts-create", [owner, dev], "commenter")

  let agentId: string
  let manifestShortId: string

  it("an owner wires an agent to a manifest; the result carries both", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(dev.email) })
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst" }))
    ).json()
    agentId = ag.id
    manifestShortId = (
      await (await publishAs(app, "# Analytics manifest", {}, as(owner.email))).json()
    ).short_id
    const res = await app.request(
      "/v1/contexts",
      jsonAs(as(owner.email), {
        name: "Analytics",
        agent_id: agentId,
        manifest_short_id: manifestShortId,
      }),
    )
    expect(res.status).toBe(201)
    const x = await res.json()
    expect(x).toMatchObject({
      name: "Analytics",
      agent_id: agentId,
      manifest_short_id: manifestShortId,
    })

    const list = await (await app.request("/v1/contexts", { headers: as(owner.email) })).json()
    expect(list.contexts).toHaveLength(1)
  })

  it("a duplicate name is 409; an unknown agent or manifest is 404", async () => {
    const dup = await app.request(
      "/v1/contexts",
      jsonAs(as(owner.email), {
        name: "Analytics",
        agent_id: agentId,
        manifest_short_id: manifestShortId,
      }),
    )
    expect(dup.status).toBe(409)
    expect(
      (
        await app.request(
          "/v1/contexts",
          jsonAs(as(owner.email), {
            name: "X",
            agent_id: "ag_nope",
            manifest_short_id: manifestShortId,
          }),
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await app.request(
          "/v1/contexts",
          jsonAs(as(owner.email), { name: "X", agent_id: agentId, manifest_short_id: "zzzzzzzz" }),
        )
      ).status,
    ).toBe(404)
  })

  it("a commenter cannot create a context (workspace publish gate)", async () => {
    const res = await app.request(
      "/v1/contexts",
      jsonAs(as(dev.email), {
        name: "Rogue",
        agent_id: agentId,
        manifest_short_id: manifestShortId,
      }),
    )
    expect(res.status).toBe(403)
  })
})

describe("sessions: the ask → answer → follow-up loop", () => {
  const owner: TestUser = { id: "u_ss_own", email: "ssown@derive.test", name: "Owner" }
  const daniel: TestUser = { id: "u_ss_dan", email: "ssdan@derive.test", name: "Daniel" }
  const stranger: TestUser = { id: "u_ss_str", email: "ssstr@derive.test", name: "Stranger" }
  const { app } = makeAuthedApp("contexts-loop", [owner, daniel, stranger], "commenter")

  let contextId: string
  let sessionId: string
  let agentToken: string
  let manifestShortId: string

  it("setup: agent + PRIVATE manifest + context; asking is gated on the manifest", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(daniel.email) })
    await app.request("/v1/me", { headers: as(stranger.email) })
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst", role: "editor" }))
    ).json()
    agentToken = ag.token
    // link_role none = true invite-only: the round-4 workspace-default link would
    // otherwise admit Daniel (a member) before the explicit share — this test is
    // about the manifest GATE, so the link stays inert.
    manifestShortId = (
      await (
        await publishAs(
          app,
          "# Manifest",
          { visibility: "private", link_role: "none" },
          as(owner.email),
        )
      ).json()
    ).short_id
    const x = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Analytics",
          agent_id: ag.id,
          manifest_short_id: manifestShortId,
        }),
      )
    ).json()
    contextId = x.id

    // Private manifest, no member row: Daniel can't ask (and can't tell it exists).
    const denied = await app.request(
      `/v1/contexts/${contextId}/sessions`,
      jsonAs(as(daniel.email), { body_md: "churn for March?" }),
    )
    expect(denied.status).toBe(404)

    // Share the manifest with Daniel → the context becomes askable.
    await app.request(`/v1/artifacts/${manifestShortId}/members`, {
      method: "PUT",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ email: daniel.email, role: "viewer" }),
    })
    const asked = await app.request(
      `/v1/contexts/${contextId}/sessions`,
      jsonAs(as(daniel.email), { body_md: "churn for March?" }),
    )
    expect(asked.status).toBe(201)
    const opened = await asked.json()
    sessionId = opened.session.id
    expect(opened.session.state).toBe("open")
    expect(opened.messages).toHaveLength(1)
  })

  it("the runner drains the queue (transcript embedded) and answers with meta", async () => {
    const q = await (
      await app.request(`/v1/contexts/${contextId}/queue`, { headers: bearer(agentToken) })
    ).json()
    expect(q.sessions).toHaveLength(1)
    expect(q.sessions[0].messages[0].body_md).toBe("churn for March?")

    const answered = await app.request(
      `/v1/sessions/${sessionId}/messages`,
      jsonAs(bearer(agentToken), {
        body_md: "March enterprise churn was 3.1%.",
        meta: { query: "select …", confidence: 0.88, caveats: ["small sample"] },
      }),
    )
    expect(answered.status).toBe(201)
    expect((await answered.json()).message.meta.confidence).toBe(0.88)

    // Answered → off the queue; the asker's view carries the parsed meta.
    const drained = await (
      await app.request(`/v1/contexts/${contextId}/queue`, { headers: bearer(agentToken) })
    ).json()
    expect(drained.sessions).toHaveLength(0)
    const view = await (
      await app.request(`/v1/sessions/${sessionId}`, { headers: as(daniel.email) })
    ).json()
    expect(view.session.state).toBe("answered")
    expect(view.messages[1].meta.caveats).toEqual(["small sample"])
  })

  it("a follow-up re-opens the session; closing takes it off the queue for good", async () => {
    const followUp = await app.request(
      `/v1/sessions/${sessionId}/messages`,
      jsonAs(as(daniel.email), { body_md: "and February?" }),
    )
    expect(followUp.status).toBe(201)
    const q = await (
      await app.request(`/v1/contexts/${contextId}/queue`, { headers: bearer(agentToken) })
    ).json()
    expect(q.sessions).toHaveLength(1)

    const closed = await app.request(`/v1/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { ...as(daniel.email), "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    })
    expect(closed.status).toBe(200)
    expect(
      (
        await app.request(
          `/v1/sessions/${sessionId}/messages`,
          jsonAs(as(daniel.email), { body_md: "one more" }),
        )
      ).status,
    ).toBe(409)
  })

  it("sessions are private: asker + context owner only; the roster viewer is not enough", async () => {
    // The stranger holds no view at all; even sharing the manifest with them
    // (roster viewer = may ASK) must not expose Daniel's session.
    await app.request(`/v1/artifacts/${manifestShortId}/members`, {
      method: "PUT",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ email: stranger.email, role: "viewer" }),
    })
    expect(
      (await app.request(`/v1/sessions/${sessionId}`, { headers: as(stranger.email) })).status,
    ).toBe(404)
    expect(
      (await app.request(`/v1/sessions/${sessionId}`, { headers: as(owner.email) })).status,
    ).toBe(200)

    // Listing: the owner sees Daniel's session; the stranger sees only their own (none).
    const ownerList = await (
      await app.request(`/v1/contexts/${contextId}/sessions`, { headers: as(owner.email) })
    ).json()
    expect(ownerList.sessions).toHaveLength(1)
    const strangerList = await (
      await app.request(`/v1/contexts/${contextId}/sessions`, { headers: as(stranger.email) })
    ).json()
    expect(strangerList.sessions).toHaveLength(0)
  })

  it("a foreign agent can neither read the queue nor answer", async () => {
    const other = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Imposter" }))
    ).json()
    expect(
      (await app.request(`/v1/contexts/${contextId}/queue`, { headers: bearer(other.token) }))
        .status,
    ).toBe(404)
    expect(
      (
        await app.request(
          `/v1/sessions/${sessionId}/messages`,
          jsonAs(bearer(other.token), { body_md: "let me in" }),
        )
      ).status,
    ).toBe(404)
  })

  it("the runner can mark a crashed run failed without posting a message", async () => {
    const asked = await (
      await app.request(
        `/v1/contexts/${contextId}/sessions`,
        jsonAs(as(daniel.email), { body_md: "will this crash?" }),
      )
    ).json()
    const failed = await app.request(`/v1/sessions/${asked.session.id}`, {
      method: "PATCH",
      headers: { ...bearer(agentToken), "content-type": "application/json" },
      body: JSON.stringify({ state: "failed" }),
    })
    expect(failed.status).toBe(200)
    expect((await failed.json()).session.state).toBe("failed")
  })

  it("a crash after the asker closed must not reopen the session as failed", async () => {
    const asked = await (
      await app.request(
        `/v1/contexts/${contextId}/sessions`,
        jsonAs(as(daniel.email), { body_md: "closing this one" }),
      )
    ).json()
    await app.request(`/v1/sessions/${asked.session.id}`, {
      method: "PATCH",
      headers: { ...as(daniel.email), "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    })
    const late = await app.request(`/v1/sessions/${asked.session.id}`, {
      method: "PATCH",
      headers: { ...bearer(agentToken), "content-type": "application/json" },
      body: JSON.stringify({ state: "failed" }),
    })
    expect(late.status).toBe(409)
  })

  it("an answer generated before a mid-run follow-up does not settle the session", async () => {
    const asked = await (
      await app.request(
        `/v1/contexts/${contextId}/sessions`,
        jsonAs(as(daniel.email), { body_md: "slow question" }),
      )
    ).json()
    const sid = asked.session.id
    const firstAskerMsg = asked.messages[0].id

    // The follow-up lands while the runner is still generating…
    await app.request(
      `/v1/sessions/${sid}/messages`,
      jsonAs(as(daniel.email), { body_md: "also this!" }),
    )

    // …so the answer (which names the message it addressed) must not close the turn.
    await app.request(
      `/v1/sessions/${sid}/messages`,
      jsonAs(bearer(agentToken), {
        body_md: "answer to the slow question only",
        answers: firstAskerMsg,
      }),
    )
    const view = await (
      await app.request(`/v1/sessions/${sid}`, { headers: as(daniel.email) })
    ).json()
    expect(view.session.state).toBe("open") // still the runner's turn
    expect(view.messages.at(-1).meta.stale).toBe(true) // and the answer is marked superseded

    // The re-serve (answering the follow-up) settles it normally.
    const followUpId = view.messages[1].id
    await app.request(
      `/v1/sessions/${sid}/messages`,
      jsonAs(bearer(agentToken), { body_md: "and the follow-up", answers: followUpId }),
    )
    const settled = await (
      await app.request(`/v1/sessions/${sid}`, { headers: as(daniel.email) })
    ).json()
    expect(settled.session.state).toBe("answered")
  })
})

describe("runner liveness: the queue poll stamps runner_seen_at, throttled", () => {
  const owner: TestUser = { id: "u_rl_own", email: "rlown@derive.test", name: "Owner" }
  const { app, meta } = makeAuthedApp("contexts-liveness", [owner])

  it("the first poll stamps; polls inside the 60s window don't; stale re-stamps", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst" }))
    ).json()
    const manifestShortId = (await (await publishAs(app, "# Manifest", {}, as(owner.email))).json())
      .short_id
    const x = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Analytics",
          agent_id: ag.id,
          manifest_short_id: manifestShortId,
        }),
      )
    ).json()
    expect(x.runner_seen_at).toBeNull() // never polled

    const seenAt = async () =>
      (await (await app.request(`/v1/contexts/${x.id}`, { headers: as(owner.email) })).json())
        .runner_seen_at
    await app.request(`/v1/contexts/${x.id}/queue`, { headers: bearer(ag.token) })
    const first = await seenAt()
    expect(first).toBeTruthy()

    // Backdating (rather than back-to-back polls, whose stamps could collide on
    // the same millisecond) makes the throttle branch unambiguous: 30s old is
    // inside the window and must survive the poll; 2m old must be replaced.
    await meta.touchContextSeen(x.id, new Date(Date.now() - 30_000).toISOString())
    const fresh = await seenAt()
    await app.request(`/v1/contexts/${x.id}/queue`, { headers: bearer(ag.token) })
    expect(await seenAt()).toBe(fresh)

    await meta.touchContextSeen(x.id, new Date(Date.now() - 120_000).toISOString())
    await app.request(`/v1/contexts/${x.id}/queue`, { headers: bearer(ag.token) })
    expect((await seenAt()) > fresh).toBe(true)

    // Both user-facing reads carry the stamp (the console + directory render it).
    const list = await (await app.request("/v1/contexts", { headers: as(owner.email) })).json()
    expect(list.contexts[0].runner_seen_at).toBe(await seenAt())
  })
})
