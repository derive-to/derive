import { zipSync } from "fflate"
import { beforeAll, describe, expect, it } from "vitest"
import { createInProcessBackplane, type DeriveEvent } from "../src/bus"
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
    const library = await (
      await app.request("/v1/artifacts?limit=100&exclude_workflows=true", {
        headers: as(owner.email),
      })
    ).json()
    expect(
      library.artifacts.map((artifact: { short_id: string }) => artifact.short_id),
    ).not.toContain(manifestShortId)
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

  it("adopts every legacy diagram and keeps an invalid one visible with blockers", async () => {
    const purpose = "Coordinate a release"
    const graph = {
      id: "announce",
      entry: "done",
      nodes: [{ id: "done", kind: "terminal", result: "Announcement ready" }],
      routes: [],
      scenarios: [
        {
          id: "expected",
          kind: "expected",
          path: ["done"],
          outcome: "Announcement is ready",
        },
      ],
    }
    const loop = {
      id: "repair",
      entry: "check",
      nodes: [
        {
          id: "check",
          kind: "context",
          context_ref: "quality-checker",
          instruction: "Return ready or revise.",
          result: "A quality decision",
          routing: "one",
        },
        { id: "done", kind: "terminal", result: "Release is ready" },
      ],
      routes: [
        { from: "check", to: "check", when: "revise", fallback: true },
        { from: "check", to: "done", when: "ready" },
      ],
      loops: [
        {
          id: "quality-repair",
          nodes: ["check"],
          goal: "Reach ready",
          evaluate: "Check release quality",
          stop: {
            max_attempts: 2,
            stagnation_limit: 1,
            human_stop: "The release owner stops",
          },
        },
      ],
      scenarios: [
        {
          id: "expected",
          kind: "expected",
          path: ["check", "done"],
          outcome: "Release is ready",
        },
        {
          id: "failure",
          kind: "failure",
          path: ["check"],
          outcome: "Failure remains visible",
        },
        {
          id: "revision",
          kind: "expected",
          path: ["check", "check", "done"],
          outcome: "One repair lands",
        },
      ],
    }
    const visible = {
      schema: "derive.linked-bundle/v1",
      purpose,
      members: [],
      diagrams: [
        {
          id: "announce",
          title: "Announcement",
          type: "graph",
          nodes: [{ id: "done", label: "Done" }],
          edges: [],
        },
        {
          id: "repair",
          title: "Repair",
          type: "loop",
          nodes: [
            { id: "check", label: "Check" },
            { id: "done", label: "Done" },
          ],
          edges: [
            { from: "check", to: "check", label: "revise" },
            { from: "check", to: "done", label: "ready" },
          ],
        },
      ],
    }
    const source = `<!doctype html><script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(visible)}</script><script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify({ schema: "derive.workflow/v1", purpose, diagrams: [graph, loop] })}</script>`
    const multiId = (await (await publishAs(app, source, {}, as(owner.email))).json()).short_id

    const invalidVisible = {
      schema: "derive.linked-bundle/v1",
      purpose: "Broken graph",
      members: [],
      diagrams: [
        {
          id: "broken",
          title: "Broken graph",
          type: "graph",
          nodes: [{ id: "missing", label: "Missing definition" }],
          edges: [],
        },
      ],
    }
    const invalidDefinition = {
      schema: "derive.workflow/v1",
      purpose: "Broken graph",
      diagrams: [{ id: "broken", entry: "missing", nodes: [], routes: [], scenarios: [] }],
    }
    const invalidSource = `<!doctype html><script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(invalidVisible)}</script><script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify(invalidDefinition)}</script>`
    const invalidId = (await (await publishAs(app, invalidSource, {}, as(owner.email))).json())
      .short_id

    const imported = await (
      await app.request("/v1/workflows/import", jsonAs(as(owner.email), { dry_run: false }))
    ).json()
    expect(
      imported.items
        .filter((item: { manifest_short_id: string }) => item.manifest_short_id === multiId)
        .map((item: { diagram_id: string; kind: string; status: string }) => ({
          diagram_id: item.diagram_id,
          kind: item.kind,
          status: item.status,
        })),
    ).toEqual([
      { diagram_id: "announce", kind: "graph", status: "imported" },
      { diagram_id: "repair", kind: "loop", status: "imported" },
    ])
    const invalid = imported.items.find(
      (item: { manifest_short_id: string }) => item.manifest_short_id === invalidId,
    )
    expect(invalid).toMatchObject({ status: "imported", kind: "graph", diagram_id: "broken" })
    expect(invalid.errors.length).toBeGreaterThan(0)
    const detail = await (
      await app.request(`/v1/contexts/${invalid.context_id}`, { headers: as(owner.email) })
    ).json()
    expect(detail).toMatchObject({ kind: "graph", manifest_status: "needs-changes" })
    expect(detail.manifest_errors.length).toBeGreaterThan(0)
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

  it("F6: a follow-up on a CLAIMED (working) session keeps it working — the claim isn't vacated", async () => {
    const asked = await (
      await app.request(
        `/v1/contexts/${contextId}/sessions`,
        jsonAs(as(daniel.email), { body_md: "long-running question" }),
      )
    ).json()
    const sid = asked.session.id

    // The runner claims it: open -> working, holding a live lease.
    const q = await (
      await app.request(`/v1/contexts/${contextId}/queue`, { headers: bearer(agentToken) })
    ).json()
    expect(q.sessions.some((s: { id: string }) => s.id === sid)).toBe(true)
    const afterClaim = await (
      await app.request(`/v1/sessions/${sid}`, { headers: as(daniel.email) })
    ).json()
    expect(afterClaim.session.state).toBe("working")

    // A follow-up lands mid-run. It must STAY `working` (the active claim is not vacated) —
    // a read-then-write reopen could race a concurrent settle and strand it `working` with
    // no runner, or flip it to `open` where a second runner double-claims. This is the exact
    // stranding race the atomic appendFollowupReopen closes.
    const followUp = await app.request(
      `/v1/sessions/${sid}/messages`,
      jsonAs(as(daniel.email), { body_md: "one more thing" }),
    )
    expect(followUp.status).toBe(201)
    const afterFollowUp = await (
      await app.request(`/v1/sessions/${sid}`, { headers: as(daniel.email) })
    ).json()
    expect(afterFollowUp.session.state).toBe("working")

    // A concurrent serve does not re-claim it (still working, live lease) — no double-run.
    const q2 = await (
      await app.request(`/v1/contexts/${contextId}/queue`, { headers: bearer(agentToken) })
    ).json()
    expect(q2.sessions.some((s: { id: string }) => s.id === sid)).toBe(false)
  })
})

describe("sessions: context policy is pinned at open", () => {
  it("fails closed before claim when the context manifest changed", async () => {
    const owner: TestUser = { id: "u_pin_own", email: "pinown@derive.test", name: "Owner" }
    const asker: TestUser = { id: "u_pin_ask", email: "pinask@derive.test", name: "Asker" }
    const { app, meta } = makeAuthedApp("contexts-version-pin", [owner, asker], "commenter")
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(asker.email) })
    const agent = await (
      await app.request(
        "/v1/agents",
        jsonAs(as(owner.email), { name: "Pinned runner", role: "editor" }),
      )
    ).json()
    const manifest = await (await publishAs(app, "# Manifest v1", {}, as(owner.email))).json()
    const context = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Pinned context",
          agent_id: agent.id,
          manifest_short_id: manifest.short_id,
        }),
      )
    ).json()
    await app.request(
      `/v1/contexts/${context.id}/askers`,
      jsonAs(as(owner.email), { email: asker.email }),
    )
    const opened = await (
      await app.request(
        `/v1/contexts/${context.id}/sessions`,
        jsonAs(as(asker.email), { body_md: "Run the pinned policy." }),
      )
    ).json()
    expect(opened.session.context_version).toBe(1)

    const revised = await publishAs(
      app,
      "# Manifest v2\nChanged instructions.",
      {},
      as(owner.email),
      manifest.short_id,
    )
    expect(revised.status).toBe(201)
    const queue = await (
      await app.request(`/v1/contexts/${context.id}/queue`, {
        headers: bearer(agent.token),
      })
    ).json()
    expect(queue.sessions).toHaveLength(0)

    const observed = await (
      await app.request(`/v1/sessions/${opened.session.id}`, { headers: as(asker.email) })
    ).json()
    expect(observed.session.state).toBe("failed")
    expect(observed.messages.at(-1).body_md).toContain("changed from v1 to v2")
    expect(observed.messages.at(-1).body_md).toContain("nothing ran")

    // Sessions queued before context-version pinning shipped have NULL here. They must not
    // inherit whatever manifest happens to be current at rollout: that would execute policy
    // they never opened against. Fail them exactly like a moved explicit pin.
    const legacy = await meta.createSession({
      id: "ses_legacy_unpinned_queue",
      context_id: context.id,
      org_id: "default",
      asker_id: asker.id,
      context_version: null,
    })
    const legacyQueue = await (
      await app.request(`/v1/contexts/${context.id}/queue`, {
        headers: bearer(agent.token),
      })
    ).json()
    expect(legacyQueue.sessions).toHaveLength(0)
    const legacyObserved = await meta.getSession(legacy.id)
    expect(legacyObserved?.state).toBe("failed")
    const legacyMessages = await meta.listSessionMessagesFor([legacy.id])
    expect(legacyMessages.at(-1)?.body_md).toContain("an unpinned legacy version")
    expect(legacyMessages.at(-1)?.body_md).toContain("nothing ran")
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

// The runner's config fetch carries the resolved Brandprint — its only window
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

// The terminal-turn wake: every settle write (the runner's answer, a crash-fail,
// an asker/owner close) publishes `session.settled` on the ASKER's `u:<id>`
// channel, so an MCP ask({wait}) long-poll wakes at once. A wake signal only —
// waiters re-read the session — so an asker follow-up (state back to `open`)
// must NOT publish it.
describe("session.settled — the terminal-turn wake event", () => {
  const owner: TestUser = { id: "u_sw_own", email: "swown@derive.test", name: "Owner" }

  const setup = async (name: string) => {
    const backplane = createInProcessBackplane()
    const { app } = makeAuthedApp(name, [owner], "commenter", { deps: { backplane } })
    await app.request("/v1/me", { headers: as(owner.email) })
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst" }))
    ).json()
    const manifest = await (await publishAs(app, "# manifest", {}, as(owner.email))).json()
    const cx = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Analytics",
          agent_id: ag.id,
          manifest_short_id: manifest.short_id,
        }),
      )
    ).json()
    const opened = await (
      await app.request(
        `/v1/contexts/${cx.id}/sessions`,
        jsonAs(as(owner.email), { body_md: "what changed?" }),
      )
    ).json()
    const events: DeriveEvent[] = []
    backplane.subscribe(`u:${owner.id}`, (e) => events.push(e))
    const settled = () => events.filter((e) => e.type === "session.settled")
    return { app, agentToken: ag.token as string, session: opened.session, settled }
  }

  it("the runner's answer publishes it on the asker's channel", async () => {
    const { app, agentToken, session, settled } = await setup("session-wake-answer")
    const res = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ body_md: "All quiet.", state: "answered" }),
    })
    expect(res.status).toBe(201)
    expect(settled()).toMatchObject([{ session_id: session.id, state: "answered" }])
  })

  it("an asker follow-up does not publish; a close does", async () => {
    const { app, session, settled } = await setup("session-wake-close")
    const follow = await app.request(
      `/v1/sessions/${session.id}/messages`,
      jsonAs(as(owner.email), { body_md: "also, why?" }),
    )
    expect(follow.status).toBe(201)
    const close = await app.request(`/v1/sessions/${session.id}`, {
      ...jsonAs(as(owner.email), { state: "closed" }),
      method: "PATCH",
    })
    expect(close.status).toBe(200)
    expect(settled()).toMatchObject([{ session_id: session.id, state: "closed" }])
  })
})

// The manifest, framed for a reader: pin health against each skill's ACTUAL current
// version, repo pointers, description + skill count on both GET :id and the list —
// and none of it reaches the runner's own (agent) branch, which keeps getting raw
// manifest_md like before this widening.
describe("contexts: the manifest package (skills, pin health, repos, description)", () => {
  const owner: TestUser = { id: "u_mf_own", email: "mfown@derive.test", name: "Owner" }
  const asker: TestUser = { id: "u_mf_ask", email: "mfask@derive.test", name: "Asker" }
  const { app } = makeAuthedApp("contexts-manifest", [owner, asker], "commenter")

  let contextId: string
  let agentId: string
  let currentSkillId: string
  let staleSkillId: string

  // Was `it("setup: pin one skill current and one behind, add a repo, wire the context")`. It asserted nothing — it only
  // built the fixture the cases below run against — so reporting it as a
  // passing test inflated the inventory and implied a guarantee it never
  // made. As a hook it still fails the suite if it throws.
  beforeAll(async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(asker.email) })

    currentSkillId = (await (await publishAs(app, "# Skill A v1", {}, as(owner.email))).json())
      .short_id
    const staleSkill = await publishAs(app, "# Skill B v1", {}, as(owner.email))
    staleSkillId = (await staleSkill.json()).short_id
    // Push a second version so the pin below (v1) trails the artifact's real current (v2).
    await publishAs(app, "# Skill B v2", {}, as(owner.email), staleSkillId)

    const manifestMd = [
      "---",
      "skills:",
      `  - id: ${currentSkillId}`,
      "    version: 1",
      `  - id: ${staleSkillId}`,
      "    version: 1",
      "repos:",
      "  - url: https://github.com/acme/widget-e2e",
      "    ref: main",
      "---",
      "",
      "# Staging QA",
      "",
      "Smoke-tests the staging app in a real browser.",
      "",
      "## Scopes",
      "",
      "Try `run smoke` or `run full`.",
    ].join("\n")
    const manifestShortId = (await (await publishAs(app, manifestMd, {}, as(owner.email))).json())
      .short_id

    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "QA Agent" }))
    ).json()
    agentId = ag.id
    const x = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Staging QA",
          agent_id: agentId,
          manifest_short_id: manifestShortId,
          max_run_ms: 1_800_000,
        }),
      )
    ).json()
    contextId = x.id
    await app.request(
      `/v1/contexts/${contextId}/askers`,
      jsonAs(as(owner.email), { email: asker.email }),
    )
  })

  it("GET :id gives an asker the package: description, skill pin health, repos, budget", async () => {
    const res = await app.request(`/v1/contexts/${contextId}`, { headers: as(asker.email) })
    expect(res.status).toBe(200)
    const x = await res.json()
    expect(x.description).toBe("Smoke-tests the staging app in a real browser.")
    expect(x.skills_count).toBe(2)
    expect(x.manifest_version).toBe(1)
    expect(x.manifest).toMatchObject({ version: 1 })
    expect(x.manifest.md).toContain("Staging QA")
    expect(x.repos).toEqual([{ url: "https://github.com/acme/widget-e2e", ref: "main" }])
    expect(x.max_run_ms).toBe(1_800_000)
    expect(x.max_concurrency).toBe(1)
    const current = x.skills.find((s: { short_id: string }) => s.short_id === currentSkillId)
    const stale = x.skills.find((s: { short_id: string }) => s.short_id === staleSkillId)
    expect(current).toMatchObject({ pinned: 1, current: 1, stale: false })
    expect(stale).toMatchObject({ pinned: 1, current: 2, stale: true })
  })

  it("the runner's OWN branch never gets the reader package — raw manifest_md only", async () => {
    // A dk_agt_ bearer needs its own request; rotate the context's registered agent to get one.
    const rotated = await app.request(`/v1/agents/${agentId}/rotate`, jsonAs(as(owner.email), {}))
    const token = (await rotated.json()).token
    const res = await app.request(`/v1/contexts/${contextId}`, { headers: bearer(token) })
    const x = await res.json()
    expect(typeof x.manifest_md).toBe("string")
    expect(x.manifest).toBeUndefined()
    expect(x.skills).toBeUndefined()
    expect(x.repos).toBeUndefined()
  })
})

describe("contexts: typed single, graph, and loop manifest projections", () => {
  const owner: TestUser = { id: "u_tm_own", email: "tmown@derive.test", name: "Owner" }
  const { app } = makeAuthedApp("contexts-typed-manifest", [owner])

  const agentManifestHtml = (value: unknown) =>
    `<!doctype html><h1>Build brief</h1><script type="application/derive-facts" data-fact="agent-manifest">${JSON.stringify(value)}</script>`

  it("create, list, and detail all expose the same ready graph identity", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    const manifest = {
      schema: "derive.agent-manifest/v2",
      kind: "graph",
      purpose: "Build a cited brief",
      title: "Brief builder",
      labels: { build: "Build the brief" },
      diagram: {
        id: "brief",
        entry: "build",
        nodes: [
          {
            id: "build",
            kind: "context",
            context_ref: "writer",
            instruction: "Build the cited brief.",
            result: "A cited brief",
            terminal: true,
          },
        ],
        routes: [],
        scenarios: [
          {
            id: "expected",
            kind: "expected",
            path: ["build"],
            outcome: "The cited brief is ready",
          },
          {
            id: "failure",
            kind: "failure",
            path: ["build"],
            outcome: "The failure is visible",
          },
        ],
      },
    }
    const shortId = (
      await (await publishAs(app, agentManifestHtml(manifest), {}, as(owner.email))).json()
    ).short_id
    const created = await app.request(
      "/v1/contexts",
      jsonAs(as(owner.email), { name: "Brief builder", manifest_short_id: shortId }),
    )
    expect(created.status).toBe(201)
    const context = await created.json()
    expect(context).toMatchObject({
      kind: "graph",
      manifest_status: "ready",
      manifest_source: "agent-manifest-v2",
      manifest_errors: [],
      node_count: 1,
      loop_count: 0,
      description: "Build a cited brief",
    })

    const list = await (await app.request("/v1/contexts", { headers: as(owner.email) })).json()
    expect(list.contexts[0]).toMatchObject({
      id: context.id,
      kind: "graph",
      manifest_status: "ready",
      node_count: 1,
    })

    const detail = await (
      await app.request(`/v1/contexts/${context.id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.workflow_preview).toMatchObject({
      status: "ready",
      purpose: "Build a cited brief",
    })
    expect(detail.workflow_definition).toMatchObject({
      schema: "derive.workflow/v1",
      diagrams: [{ id: "brief", entry: "build" }],
    })

    const browserRun = await app.request(
      `/v1/contexts/${context.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "Build this in the browser." }),
    )
    expect(browserRun.status).toBe(409)
    expect(await browserRun.text()).toContain("runs from a local agent over the remote Derive MCP")
    const sessions = await (
      await app.request(`/v1/contexts/${context.id}/sessions`, { headers: as(owner.email) })
    ).json()
    expect(sessions.sessions).toEqual([])
  })

  it("keeps a malformed typed manifest visible but refuses to call it ready", async () => {
    const shortId = (
      await (
        await publishAs(
          app,
          agentManifestHtml({
            schema: "derive.agent-manifest/v2",
            kind: "loop",
            purpose: "Repair until good",
            title: "Repair loop",
            diagram: { id: "repair", entry: "missing", nodes: [], routes: [], scenarios: [] },
          }),
          {},
          as(owner.email),
        )
      ).json()
    ).short_id
    const created = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), { name: "Broken repair", manifest_short_id: shortId }),
      )
    ).json()
    expect(created.kind).toBe("loop")
    expect(created.manifest_status).toBe("needs-changes")
    expect(created.manifest_errors).toEqual(
      expect.arrayContaining(["AM-04 loop manifest requires at least one bounded loop policy"]),
    )
    expect(created.workflow_preview).toBeUndefined()
  })

  it("dry-runs and idempotently adopts a legacy graph artifact as a context", async () => {
    const purpose = "Publish a release note"
    const diagram = {
      id: "release",
      entry: "draft",
      nodes: [
        {
          id: "draft",
          kind: "context",
          context_ref: "writer",
          instruction: "Draft the release note.",
          result: "A release note",
          terminal: true,
        },
      ],
      routes: [],
      scenarios: [
        {
          id: "expected",
          kind: "expected",
          path: ["draft"],
          outcome: "The release note is ready",
        },
        {
          id: "failure",
          kind: "failure",
          path: ["draft"],
          outcome: "The failure remains visible",
        },
      ],
    }
    const source = `<!doctype html><h1>Legacy graph</h1>
      <script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify({
        schema: "derive.linked-bundle/v1",
        purpose,
        members: [],
        diagrams: [
          {
            id: "release",
            title: "Release note",
            type: "graph",
            nodes: [{ id: "draft", label: "Draft" }],
            edges: [],
          },
        ],
      })}</script>
      <script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify({
        schema: "derive.workflow/v1",
        purpose,
        diagrams: [diagram],
      })}</script>`
    const shortId = (await (await publishAs(app, source, {}, as(owner.email))).json()).short_id

    const beforeDryRun = await (
      await app.request("/v1/contexts", { headers: as(owner.email) })
    ).json()
    const dry = await (
      await app.request("/v1/workflows/import", jsonAs(as(owner.email), { dry_run: true }))
    ).json()
    expect(
      dry.items.find((item: { manifest_short_id: string }) => item.manifest_short_id === shortId),
    ).toMatchObject({ status: "would-import", kind: "graph", diagram_id: "release" })
    const afterDryRun = await (
      await app.request("/v1/contexts", { headers: as(owner.email) })
    ).json()
    expect(afterDryRun.contexts.map((item: { id: string }) => item.id)).toEqual(
      beforeDryRun.contexts.map((item: { id: string }) => item.id),
    )

    const imported = await (
      await app.request("/v1/workflows/import", jsonAs(as(owner.email), { dry_run: false }))
    ).json()
    const made = imported.items.find(
      (item: { manifest_short_id: string }) => item.manifest_short_id === shortId,
    )
    expect(made).toMatchObject({ status: "imported", kind: "graph", diagram_id: "release" })
    expect(made.context_id).toMatch(/^ctx_/)

    const repeated = await (
      await app.request("/v1/workflows/import", jsonAs(as(owner.email), { dry_run: false }))
    ).json()
    expect(
      repeated.items.find(
        (item: { manifest_short_id: string }) => item.manifest_short_id === shortId,
      ),
    ).toMatchObject({ status: "already-imported", context_id: made.context_id })

    const list = await (await app.request("/v1/contexts", { headers: as(owner.email) })).json()
    expect(
      list.contexts.find((context: { id: string }) => context.id === made.context_id),
    ).toMatchObject({ kind: "graph", manifest_source: "workflow-v1", manifest_status: "ready" })
  })
})

// The RECORD lane: files a run that already happened on the owner's own machine —
// no dispatch, no queue, answered on arrival. The context ledger's analog of
// `automate record` (mcp-tools/automate.ts), stamped via SessionMeta.lane rather
// than a new column.
describe("contexts: record a run that already happened locally", () => {
  const owner: TestUser = {
    id: "u_rec_own",
    email: "recown@derive.test",
    name: "Owner",
    username: "recowner",
  }
  const member: TestUser = { id: "u_rec_mem", email: "recmem@derive.test", name: "Member" }
  const { app } = makeAuthedApp("contexts-record", [owner, member], "commenter")

  let contextId: string

  // Was `it("setup: wire a context")`. It asserted nothing — it only
  // built the fixture the cases below run against — so reporting it as a
  // passing test inflated the inventory and implied a guarantee it never
  // made. As a hook it still fails the suite if it throws.
  beforeAll(async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(member.email) })
    const manifestShortId = (
      await (await publishAs(app, "# Staging QA", {}, as(owner.email))).json()
    ).short_id
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "QA Agent" }))
    ).json()
    contextId = (
      await (
        await app.request(
          "/v1/contexts",
          jsonAs(as(owner.email), {
            name: "Staging QA",
            agent_id: ag.id,
            manifest_short_id: manifestShortId,
          }),
        )
      ).json()
    ).id
  })

  it("the owner records a run: an already-answered session, lane:local on the reply", async () => {
    const artifact = await (await publishAs(app, "# Daily Run", {}, as(owner.email))).json()
    const res = await app.request(
      `/v1/contexts/${contextId}/sessions/record`,
      jsonAs(as(owner.email), {
        instruction: "run smoke",
        answer: "14 of 15 checks passed.",
        result_artifact_id: artifact.short_id,
      }),
    )
    expect(res.status).toBe(201)
    const { session, messages } = await res.json()
    expect(session.state).toBe("answered")
    expect(session.result_artifact_id).toBe(artifact.short_id)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ author_kind: "asker", body_md: "run smoke" })
    expect(messages[1]).toMatchObject({
      author_kind: "agent",
      body_md: "14 of 15 checks passed.",
      meta: { lane: "local" },
    })

    // Filed into the SAME ledger a normal ask uses — the owner's Activity view sees it,
    // with the asker resolved and the lane surfaced.
    const list = await (
      await app.request(`/v1/contexts/${contextId}/sessions`, { headers: as(owner.email) })
    ).json()
    const row = list.sessions.find((s: { id: string }) => s.id === session.id)
    expect(row).toMatchObject({ lane: "local", asker_username: expect.any(String) })
  })

  it("a workspace member who isn't the creator or a manager cannot record", async () => {
    const res = await app.request(
      `/v1/contexts/${contextId}/sessions/record`,
      jsonAs(as(member.email), { instruction: "run smoke", answer: "done" }),
    )
    expect(res.status).toBe(403)
  })

  it("refuses to bind a result id that is not a live artifact in the context workspace", async () => {
    const res = await app.request(
      `/v1/contexts/${contextId}/sessions/record`,
      jsonAs(as(owner.email), {
        instruction: "run smoke",
        answer: "done",
        result_artifact_id: "not-a-result",
      }),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toContain("result artifact")
  })
})

// A context's OUTPUTS: what it produced, grouped by artifact — the console's Output tab.
// Derived from result bindings that already exist; the interesting edges are the grouping
// (a report republished nightly is one row with a run count) and the visibility gate (an
// output you cannot read comes back titleless, never as the document).
describe("contexts: outputs — what a context produced", () => {
  const owner: TestUser = { id: "u_out_own", email: "outown@derive.test", name: "Owner" }
  const asker: TestUser = { id: "u_out_ask", email: "outask@derive.test", name: "Asker" }
  // A workspace member who is NOT on the asker roster — the 404 case.
  const outsider: TestUser = { id: "u_out_no", email: "outno@derive.test", name: "Outsider" }
  const { app } = makeAuthedApp("contexts-outputs", [owner, asker, outsider], "commenter")

  let contextId: string
  let dailyRun: string
  let secret: string

  const record = (headers: Record<string, string>, body: Record<string, unknown>) =>
    app.request(`/v1/contexts/${contextId}/sessions/record`, jsonAs(headers, body))

  it("setup: two runs bind the same report, one binds a private artifact", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(asker.email) })
    const manifestShortId = (
      await (await publishAs(app, "# Staging QA", {}, as(owner.email))).json()
    ).short_id
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "QA Agent" }))
    ).json()
    contextId = (
      await (
        await app.request(
          "/v1/contexts",
          jsonAs(as(owner.email), {
            name: "Staging QA",
            agent_id: ag.id,
            manifest_short_id: manifestShortId,
          }),
        )
      ).json()
    ).id
    await app.request(
      `/v1/contexts/${contextId}/askers`,
      jsonAs(as(owner.email), { email: asker.email }),
    )

    dailyRun = (
      await (await publishAs(app, "# Daily Run", { title: "Daily Run" }, as(owner.email))).json()
    ).short_id
    // Private to the owner: the asker can ask this context but must not read this doc.
    secret = (
      await (
        await publishAs(
          app,
          "# Internal only",
          { title: "Internal only", visibility: "private", link_role: "none" },
          as(owner.email),
        )
      ).json()
    ).short_id

    // Two runs bind the SAME report — the grouping case.
    for (const answer of ["run 1 done", "run 2 done"]) {
      const res = await record(as(owner.email), {
        instruction: "run smoke",
        answer,
        result_artifact_id: dailyRun,
      })
      expect(res.status).toBe(201)
    }
    // One run binds the private artifact, and one binds nothing at all.
    expect(
      (
        await record(as(owner.email), {
          instruction: "run internals",
          answer: "done",
          result_artifact_id: secret,
        })
      ).status,
    ).toBe(201)
    expect(
      (await record(as(owner.email), { instruction: "just a question", answer: "no artifact" }))
        .status,
    ).toBe(201)
  })

  it("groups by artifact with a run count; a session that bound nothing is absent", async () => {
    const res = await app.request(`/v1/contexts/${contextId}/outputs`, { headers: as(owner.email) })
    expect(res.status).toBe(200)
    const { outputs } = await res.json()
    // Two distinct artifacts, NOT three rows — the report's two runs collapse into one.
    expect(outputs).toHaveLength(2)
    const report = outputs.find((o: { short_id: string }) => o.short_id === dailyRun)
    expect(report).toMatchObject({ runs: 2, title: "Daily Run" })
    expect(report.version).toBe(1)
    expect(typeof report.last_run_at).toBe("string")
    // Most recently produced first.
    expect(outputs[0].short_id).toBe(secret)
  })

  it("an output the viewer cannot read comes back titleless, never as the document", async () => {
    const { outputs } = await (
      await app.request(`/v1/contexts/${contextId}/outputs`, { headers: as(asker.email) })
    ).json()
    // The RUN is not a secret — it is already in the transcript this asker can see — but
    // the private document behind it is.
    const hidden = outputs.find((o: { short_id: string }) => o.short_id === secret)
    expect(hidden).toMatchObject({ title: null, version: null, runs: 1 })
    // The readable one still resolves fully in the same response.
    expect(outputs.find((o: { short_id: string }) => o.short_id === dailyRun)).toMatchObject({
      title: "Daily Run",
    })
  })

  it("a workspace member who may not ask gets 404 — outputs never leak the context's existence", async () => {
    await app.request("/v1/me", { headers: as(outsider.email) })
    expect(
      (await app.request(`/v1/contexts/${contextId}/outputs`, { headers: as(outsider.email) }))
        .status,
    ).toBe(404)
  })

  // These four sessions were opened in a tight loop, so several genuinely SHARE a
  // created_at — which is the case a timestamp-only cursor silently drops. Paging the
  // whole list one row at a time is the assertion: every session must appear exactly
  // once, in the same order the unpaged list returns.
  it("pages the whole list with the keyset cursor — no row skipped, none repeated", async () => {
    const all = await (
      await app.request(`/v1/contexts/${contextId}/sessions`, { headers: as(owner.email) })
    ).json()
    expect(all.sessions).toHaveLength(4)
    expect(all.next_cursor).toBeNull() // a short page is provably the end

    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard++) {
      const url: string = `/v1/contexts/${contextId}/sessions?limit=1${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`
      const page = await (await app.request(url, { headers: as(owner.email) })).json()
      if (page.sessions.length === 0) break
      seen.push(...page.sessions.map((s: { id: string }) => s.id))
      cursor = page.next_cursor
      if (!cursor) break
    }
    expect(seen).toEqual(all.sessions.map((s: { id: string }) => s.id))
    expect(new Set(seen).size).toBe(seen.length)
  })
})
