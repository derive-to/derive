import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Contexts + sessions: the ask → answer → follow-up loop, its permission edges,
// and the runner's queue. Ask-access is WORKSPACE-SCOPED on the context itself
// (never the manifest's artifact sharing) — a context is a data grant, not a
// document, and must never be reachable outside its workspace.
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
  const { app, meta } = makeAuthedApp("contexts-loop", [owner, daniel, stranger], "commenter")

  let contextId: string
  let sessionId: string
  let agentToken: string
  let manifestShortId: string

  it("setup: ask-access is WORKSPACE-SCOPED on the context, never the manifest", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(daniel.email) })
    await app.request("/v1/me", { headers: as(stranger.email) })
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst", role: "editor" }))
    ).json()
    agentToken = ag.token
    // The manifest is a PRIVATE artifact — and stays that way. Asking is granted by
    // the CONTEXT's own policy, not manifest read, so the private manifest doesn't
    // gate anything for members.
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
    // Least-privilege default: `invited`, so a data grant opens to nobody but the
    // creator until widened. Daniel is a workspace member but not an invited
    // asker, so he's denied and can't even tell it exists.
    expect(x.ask_policy).toBe("invited")
    const denied = await app.request(
      `/v1/contexts/${contextId}/sessions`,
      jsonAs(as(daniel.email), { body_md: "churn for March?" }),
    )
    expect(denied.status).toBe(404)

    // Invite Daniel (a workspace member) to the asker roster → askable.
    const invited = await app.request(
      `/v1/contexts/${contextId}/askers`,
      jsonAs(as(owner.email), { email: daniel.email }),
    )
    expect(invited.status).toBe(201)
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

  it("sessions are private: asker + context owner only; another invited asker is not enough", async () => {
    // The stranger is a workspace member; even inviting them to ASK must not
    // expose Daniel's session — an asker sees only their own conversations.
    await app.request(
      `/v1/contexts/${contextId}/askers`,
      jsonAs(as(owner.email), { email: stranger.email }),
    )
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

  it("SECURITY: a non-member can't ask — not even with the manifest world-linked + public", async () => {
    // The exact leak this model closes: open the manifest to the world (viewer
    // link + public listing) and drop the asker OUT of the workspace. Under the
    // old "ask = manifest read" rule they could open a session (query the data);
    // now the context's workspace-membership floor refuses them — 404, no leak.
    await app.request(`/v1/artifacts/${manifestShortId}/access`, {
      method: "PATCH",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ linkRole: "viewer", listed: "public" }),
    })
    await meta.removeMembership("default", stranger.id)

    // Switch the context back to `workspace` (any member) — the most permissive
    // policy — to prove even THAT never reaches a non-member.
    await app.request(
      `/v1/contexts/${contextId}/access`,
      jsonAs(as(owner.email), { ask_policy: "workspace" }),
    )
    expect(
      (await app.request(`/v1/contexts/${contextId}`, { headers: as(stranger.email) })).status,
    ).toBe(404)
    expect(
      (
        await app.request(
          `/v1/contexts/${contextId}/sessions`,
          jsonAs(as(stranger.email), { body_md: "let me query your data" }),
        )
      ).status,
    ).toBe(404)
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

// Revoking ask-access closes an IN-FLIGHT session too: a member who opened a
// session and is then removed from the workspace can neither read it nor keep
// asking — otherwise the session would be a standing query window that outlives
// their membership (the exact "never outside the workspace" invariant).
describe("sessions: revoking ask-access cuts off an existing session", () => {
  const owner: TestUser = { id: "u_rv_own", email: "rvown@derive.test", name: "Owner" }
  const daniel: TestUser = { id: "u_rv_dan", email: "rvdan@derive.test", name: "Daniel" }
  const { app, meta } = makeAuthedApp("contexts-revoke", [owner, daniel], "commenter")

  it("a removed member can't read or follow up on their own open session", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(daniel.email) })
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst", role: "editor" }))
    ).json()
    const manifest = (await (await publishAs(app, "# m", {}, as(owner.email))).json()).short_id
    const ctx = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Analytics",
          agent_id: ag.id,
          manifest_short_id: manifest,
        }),
      )
    ).json()

    // Open the context to the workspace so Daniel (a member) can ask, then he
    // opens a session.
    await app.request(
      `/v1/contexts/${ctx.id}/access`,
      jsonAs(as(owner.email), { ask_policy: "workspace" }),
    )
    const asked = await app.request(
      `/v1/contexts/${ctx.id}/sessions`,
      jsonAs(as(daniel.email), { body_md: "churn?" }),
    )
    expect(asked.status).toBe(201)
    const sid = (await asked.json()).session.id
    // He can read it while he's a member.
    expect((await app.request(`/v1/sessions/${sid}`, { headers: as(daniel.email) })).status).toBe(
      200,
    )

    // Remove Daniel from the workspace → his in-flight session goes dark.
    await meta.removeMembership("default", daniel.id)
    expect((await app.request(`/v1/sessions/${sid}`, { headers: as(daniel.email) })).status).toBe(
      404,
    )
    const followUp = await app.request(
      `/v1/sessions/${sid}/messages`,
      jsonAs(as(daniel.email), { body_md: "one more query" }),
    )
    expect(followUp.status).toBe(404)
    // The owner still sees it (they manage the context).
    expect((await app.request(`/v1/sessions/${sid}`, { headers: as(owner.email) })).status).toBe(
      200,
    )
  })

  it("a removed CREATOR loses transcript access too — the floor applies to owners", async () => {
    // The creator branch of the session read/patch must also require membership:
    // offboarding doesn't reassign contexts, so created_by persists — a removed
    // creator must not keep reading the data answers from outside the workspace.
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "A2", role: "editor" }))
    ).json()
    const manifest = (await (await publishAs(app, "# m2", {}, as(owner.email))).json()).short_id
    const ctx = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Analytics2",
          agent_id: ag.id,
          manifest_short_id: manifest,
        }),
      )
    ).json()
    const asked = await (
      await app.request(
        `/v1/contexts/${ctx.id}/sessions`,
        jsonAs(as(owner.email), { body_md: "self-ask" }),
      )
    ).json()
    const sid = asked.session.id
    expect((await app.request(`/v1/sessions/${sid}`, { headers: as(owner.email) })).status).toBe(
      200,
    )

    await meta.removeMembership("default", owner.id)
    expect((await app.request(`/v1/sessions/${sid}`, { headers: as(owner.email) })).status).toBe(
      404,
    )
    const close = await app.request(`/v1/sessions/${sid}`, {
      method: "PATCH",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    })
    expect(close.status).toBe(404)
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

// WP3: the runner's config fetch carries the resolved Brandprint — its only window
// into workspace conventions. Agent-branch only; a human never sees runner config.
describe("contexts: the config fetch carries the resolved Brandprint", () => {
  const owner: TestUser = { id: "u_bp_own", email: "bpown@derive.test", name: "Owner" }
  const { app, meta } = makeAuthedApp("contexts-brandprint", [owner], "editor")

  const uploadZip = (files: Record<string, string>, headers: Record<string, string>) => {
    const zipped = zipSync(
      Object.fromEntries(
        Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)] as const),
      ),
    )
    const form = new FormData()
    form.append("file", new Blob([zipped]), "skill.zip")
    return app.request("/v1/artifacts", { method: "POST", body: form, headers })
  }

  it("agent GET carries skills + notes; human GET does not; unset omits it", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst", role: "editor" }))
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

    // Before any Brandprint is set, the agent config fetch omits the block entirely.
    const bare = await (
      await app.request(`/v1/contexts/${x.id}`, { headers: bearer(ag.token) })
    ).json()
    expect(bare.manifest_md).toContain("# Manifest")
    expect(bare.brandprint).toBeUndefined()

    // Seed a Brandprint: a prose note + a real skill bundle in one collection.
    const noteId = (await (await publishAs(app, "# Voice\n\nBe warm.", {}, as(owner.email))).json())
      .short_id
    const skillId = (
      await (
        await uploadZip(
          {
            "SKILL.md":
              "---\nname: chart-style\ndescription: House charts.\n---\n\n# Chart style\n",
            "scripts/x.sh": "echo hi\n",
          },
          as(owner.email),
        )
      ).json()
    ).short_id
    const noteArt = await meta.getByShortId(noteId)
    const skillArt = await meta.getByShortId(skillId)
    if (!noteArt || !skillArt) throw new Error("no artifacts")
    expect(skillArt.current_content_type).toBe("derive/skill")

    const collectionId = "col_ctx_bp"
    await meta.createCollection({
      id: collectionId,
      org_id: noteArt.org_id,
      title: "Brandprint",
      created_by: owner.id,
    })
    await meta.addCollectionItem(collectionId, noteArt.id)
    await meta.addCollectionItem(collectionId, skillArt.id)
    await meta.setOrgSettings(noteArt.org_id, {
      ...(await meta.getOrgSettings(noteArt.org_id)),
      brandprint: { collectionId },
    })

    // The agent config fetch now carries both members, the skill flagged, with versions.
    const cfg = await (
      await app.request(`/v1/contexts/${x.id}`, { headers: bearer(ag.token) })
    ).json()
    expect(cfg.brandprint.profile_short_id).toBeNull()
    const member = (id: string) =>
      cfg.brandprint.members.find((m: { short_id: string }) => m.short_id === id)
    expect(member(noteId)).toMatchObject({ is_skill: false, version: 1 })
    expect(member(skillId)).toMatchObject({ is_skill: true, version: 1 })

    // The human branch (the creator can read it) never carries runner config.
    const human = await (
      await app.request(`/v1/contexts/${x.id}`, { headers: as(owner.email) })
    ).json()
    expect(human.brandprint).toBeUndefined()
    expect(human.manifest_md).toBeUndefined()
  })
})
