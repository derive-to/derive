import { tarSync } from "@derive/core"
import { gzipSync, zipSync } from "fflate"
import { beforeAll, describe, expect, it } from "vitest"
import { createInProcessBackplane, type DeriveEvent } from "../src/bus"
import { runImportTick } from "../src/imports"
import { ARXIV_REQUEST_INTERVAL_MS } from "../src/lib/arxiv-import"
import { sharpShrinker } from "../src/lib/image-shrink-node"
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

describe("Context manifest to Skill migration", () => {
  const owner: TestUser = {
    id: "u_skill_migrate",
    email: "skill-migrate@derive.test",
    name: "Owner",
  }
  const { app, meta } = makeAuthedApp("contexts-skill-migrate", [owner])

  it("previews without writing, then appends a private Skill version on the same artifact", async () => {
    const files = zipSync({
      "MANIFEST.md": new TextEncoder().encode(
        "---\nname: Release Context\ndescription: Answers release questions.\nskills:\n  - id: release-proof\n    version: 3\n---\n\n# Release guide\n\nUse the repository evidence.",
      ),
      "references/checklist.md": new TextEncoder().encode("# Checklist"),
    })
    const form = new FormData()
    form.append("file", new Blob([files as BlobPart]), "manifest.zip")
    form.append("title", "Release Context")
    const artifact = await (
      await app.request("/v1/artifacts", { method: "POST", body: form, headers: as(owner.email) })
    ).json()
    const created = await app.request(
      "/v1/contexts",
      jsonAs(as(owner.email), {
        name: "Release Context",
        manifest_short_id: artifact.short_id,
      }),
    )
    expect(created.status).toBe(201)
    const context = await created.json()

    const preview = await app.request(
      "/v1/skill-migrations",
      jsonAs(as(owner.email), { apply: false }),
    )
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({
      applied: false,
      report: [expect.objectContaining({ kind: "context", action: "migrate" })],
    })
    expect((await meta.getByShortId(artifact.short_id))?.current_version).toBe(1)

    const applied = await app.request(
      "/v1/skill-migrations",
      jsonAs(as(owner.email), { apply: true }),
    )
    expect(applied.status).toBe(200)
    const migrated = await meta.getByShortId(artifact.short_id)
    expect(migrated).toMatchObject({
      current_version: 2,
      current_content_type: "derive/skill",
    })
    const detail = await (
      await app.request(`/v1/artifacts/${artifact.short_id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.bundle).toMatchObject({
      isSkill: true,
      name: "release-context",
      description: "Answers release questions.",
    })
    const catalog = await (await app.request("/v1/skills", { headers: as(owner.email) })).json()
    expect(catalog.skills).toContainEqual(expect.objectContaining({ short_id: artifact.short_id }))
    const contextList = await (
      await app.request("/v1/contexts", { headers: as(owner.email) })
    ).json()
    expect(contextList.contexts).toContainEqual(
      expect.objectContaining({ manifest_short_id: artifact.short_id }),
    )
    const contextDetail = await (
      await app.request(`/v1/contexts/${context.id}`, { headers: as(owner.email) })
    ).json()
    expect(contextDetail.manifest.md).toContain("  - id: release-proof\n    version: 3")
    expect(contextDetail.skills).toContainEqual(
      expect.objectContaining({ short_id: "release-proof", pinned: 3 }),
    )

    const replay = await app.request(
      "/v1/skill-migrations",
      jsonAs(as(owner.email), { apply: true }),
    )
    expect(replay.status).toBe(200)
    expect((await meta.getByShortId(artifact.short_id))?.current_version).toBe(2)
  })

  it("migrates a single-file Markdown definition without losing its Skill pins", async () => {
    const definition = new FormData()
    definition.append(
      "file",
      new Blob(
        [
          "---\nskills:\n  - id: evidence-check\n    version: 2\n---\n\n# Evidence Context\n\nCheck every claim.",
        ],
        { type: "text/markdown" },
      ),
      "evidence-context.md",
    )
    definition.append("title", "Evidence Context")
    const manifest = await (
      await app.request("/v1/artifacts", {
        method: "POST",
        body: definition,
        headers: as(owner.email),
      })
    ).json()
    const created = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Evidence Context",
          manifest_short_id: manifest.short_id,
        }),
      )
    ).json()
    const sibling = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Evidence Context Copy",
          manifest_short_id: manifest.short_id,
        }),
      )
    ).json()

    const applied = await app.request(
      "/v1/skill-migrations",
      jsonAs(as(owner.email), { apply: true }),
    )
    expect(applied.status).toBe(200)
    expect(await meta.getByShortId(manifest.short_id)).toMatchObject({
      current_version: 1,
      current_content_type: "text/markdown",
    })
    const migratedContext = await meta.getContext(created.id)
    const migratedSibling = await meta.getContext(sibling.id)
    expect(migratedSibling?.manifest_artifact_id).toBe(migratedContext?.manifest_artifact_id)
    expect(await meta.getArtifactById(migratedContext?.manifest_artifact_id ?? "")).toMatchObject({
      current_version: 1,
      current_content_type: "derive/skill",
    })
    const detail = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.manifest.md).toContain("  - id: evidence-check\n    version: 2")
    expect(detail.skills).toContainEqual(
      expect.objectContaining({ short_id: "evidence-check", pinned: 2 }),
    )
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

describe("contexts: import from arXiv", () => {
  const owner: TestUser = { id: "u_ax_own", email: "axown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_ax_mem", email: "axmem@derive.test", name: "Member" }
  const ID = "2401.12345"
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x1f, 0x8b,
  ])
  const ATOM = (
    id: string,
    title = "Attention Is All You Need",
  ) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/${id}v2</id>
    <published>2024-01-30T18:00:00Z</published>
    <title>${title}</title>
    <summary>  We propose a new simple network architecture, the Transformer &amp; friends.
  </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:comment>15 pages, 5 figures</arxiv:comment>
    <arxiv:primary_category term="cs.CL"/>
    <category term="cs.CL"/><category term="cs.LG"/>
  </entry>
</feed>`
  const ERROR_ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#x</id><title>Error</title><summary>Bad id</summary></entry></feed>`
  const BIBTEX = `@misc{vaswani2024attention,
      title={Attention Is All You Need},
      author={Ashish Vaswani and Noam Shazeer},
      year={2024},
      eprint={${ID}},
      archivePrefix={arXiv},
      primaryClass={cs.CL}
}`
  const SOURCE = () =>
    gzipSync(
      tarSync({
        "paper-src/paper.tex":
          "\\documentclass{article}\n\\begin{document}\n\\begin{abstract}\nWe propose a new simple network architecture.\n\\end{abstract}\n\\input{main}\n\\section{Intro}\nSee \\cite{ref1}.\n\\bibliography{refs}\n\\end{document}\n",
        "paper-src/main.tex": "A chapter, not the paper.",
        "paper-src/refs.bib": "@article{ref1, title={Ref}, author={A}, year={2020}}",
        "paper-src/paper.bbl":
          "\\begin{thebibliography}{1}\\bibitem{ref1} A. Ref. 2020.\\end{thebibliography}",
        "paper-src/fig/a.png": PNG,
      }),
    )

  type Stub = (url: string, init?: RequestInit) => Response | Promise<Response>
  const gzip = (bytes: Uint8Array) =>
    new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-type": "application/gzip" },
    })
  const arxivStub = (
    over: Partial<Record<"metadata" | "source" | "bibtex", Stub>> = {},
    /** Repository archives by `owner/name`, for an import that attaches an implementation. */
    repos: Record<string, () => Response | Promise<Response>> = {},
  ) => {
    const calls: string[] = []
    const stub = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      const u = new URL(url)
      if (u.hostname === "export.arxiv.org")
        return over.metadata?.(url, init) ?? new Response(ATOM(u.searchParams.get("id_list") ?? ID))
      if (u.pathname.startsWith("/src/")) return over.source?.(url, init) ?? gzip(SOURCE())
      if (u.pathname.startsWith("/bibtex/")) return over.bibtex?.(url, init) ?? new Response(BIBTEX)
      // codeload: /<owner>/<name>/tar.gz/<ref>. GitLab: /<ns>/<name>/-/archive/<ref>/….
      const repo = /^\/([^/]+)\/([^/]+)\/(?:tar\.gz|-\/archive)\//.exec(u.pathname)
      if (repo) {
        const served = repos[`${repo[1]}/${repo[2]}`]
        if (served) return served()
      }
      return new Response("nope", { status: 404 })
    }
    return { fetch: stub as unknown as typeof fetch, calls }
  }

  /** A clock that advances only through the worker's own sleeps. */
  const clock = () => {
    let t = Date.parse("2030-01-01T00:00:00.000Z")
    const sleeps: number[] = []
    return {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        t += ms
      },
      sleeps,
      advance: (ms: number) => {
        t += ms
      },
    }
  }

  const setup = (name: string, fetchStub: typeof fetch) => {
    const made = makeAuthedApp(name, [owner, member], "editor", { deps: { fetch: fetchStub } })
    const c = clock()
    const tickDeps = (holder = "w1") => ({
      meta: made.meta,
      blobs: made.ctx.blobs,
      bus: made.ctx.bus,
      notify: made.ctx.notify,
      background: made.ctx.background,
      baseUrl: "http://derive.test",
      fetch: fetchStub,
      now: c.now,
      sleep: c.sleep,
      caps: {
        compressedBytes: 1024 * 1024,
        inflatedBytes: 4 * 1024 * 1024,
        bundleBytes: 4 * 1024 * 1024,
        files: 200,
      },
      repoCaps: {
        compressedBytes: 1024 * 1024,
        inflatedBytes: 4 * 1024 * 1024,
        totalBytes: 4 * 1024 * 1024,
        files: 200,
        depth: 3,
        repos: 5,
      },
      holder,
    })
    return { ...made, clock: c, tickDeps }
  }
  const importPaper = (app: ReturnType<typeof makeAuthedApp>["app"], url: string, who = owner) =>
    app.request("/v1/contexts/import/arxiv", jsonAs(as(who.email), { url }))

  it("queues a paper the moment it is pasted, then the worker turns it into a locked, read-only Context", async () => {
    const stub = arxivStub()
    const { app, meta, ctx, clock: c, tickDeps } = setup("contexts-import", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(member.email) })

    // Any of the forms people paste resolves to the id; the PDF link is the common one.
    const res = await importPaper(app, `https://arxiv.org/pdf/${ID}v2.pdf`)
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(created).toMatchObject({
      name: `arXiv:${ID}`,
      ask_policy: "workspace",
      import: { source: "arxiv", ref: ID, status: "pending", error: null, imported_by: owner.id },
    })
    expect(created.import.url).toBe(`https://arxiv.org/abs/${ID}`)
    // Listed at once, for every member, marked as on its way.
    const listed = await (await app.request("/v1/contexts", { headers: as(member.email) })).json()
    expect(listed.contexts.map((x: { id: string }) => x.id)).toContain(created.id)
    expect(listed.contexts[0].import.status).toBe("pending")
    // One artifact from the first second: the Context points at the paper, whose first
    // version is a placeholder document saying the fetch is on its way. A member can open
    // it (workspace policy) and reads it as a page, never as source.
    const before = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(member.email) })
    ).json()
    expect(before.manifest).toBeNull()
    expect(before.documents).toEqual([
      { short_id: before.manifest_short_id, title: `arXiv:${ID}`, kind: "bundle", role: "paper" },
    ])
    const fetching = await app.request(
      `/v1/artifacts/${before.manifest_short_id}/content?format=text`,
      { headers: as(member.email) },
    )
    expect(await fetching.text()).toContain("Fetching this paper from arXiv")
    // Nothing has been fetched yet: the queue, not the request, talks to arXiv.
    expect(stub.calls).toHaveLength(0)

    expect(await runImportTick(tickDeps())).toBe(1)
    // Three requests, in order, each at least the interval apart.
    expect(stub.calls.map((u) => new URL(u).pathname)).toEqual([
      "/api/query",
      `/src/${ID}v2`,
      `/bibtex/${ID}`,
    ])
    expect(c.sleeps.filter((ms) => ms >= 3000).length).toBeGreaterThanOrEqual(2)
    for (const url of stub.calls) expect(new URL(url).hostname).toMatch(/arxiv\.org$/)

    const after = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(member.email) })
    ).json()
    expect(after.name).toBe("Attention Is All You Need")
    expect(after.import).toMatchObject({ status: "ready", version: 2, error: null })
    // Still one artifact, now the paper: the same short id the queue created.
    expect(after.documents).toEqual([
      {
        short_id: before.manifest_short_id,
        title: "Attention Is All You Need",
        kind: "bundle",
        role: "paper",
      },
    ])
    expect(after.manifest).toBeNull()
    expect(after.bibtex).toContain("@misc{vaswani2024attention")
    expect(after.description).toContain("Ashish Vaswani")

    // The paper: a LaTeX bundle entering at the real paper, with its citation file, the
    // figure byte for byte, tagged, attributed to arXiv and locked.
    const paper = await (
      await app.request(`/v1/artifacts/${after.documents[0].short_id}`, {
        headers: as(member.email),
      })
    ).json()
    expect(paper.title).toBe("Attention Is All You Need")
    expect(paper.locked).toBe(true)
    // v1 was the placeholder the queue published; v2 is the paper, by its own authors.
    expect(paper.versions.map((v: { author: string }) => v.author)).toEqual([
      "arXiv",
      "Ashish Vaswani, Noam Shazeer",
    ])
    expect(paper.current_version).toBe(2)
    expect(paper.import_source).toBe("arxiv")
    const row = await meta.getByShortId(paper.short_id)
    const v = row ? await meta.getVersion(row.id, paper.current_version) : null
    expect(v?.content_type).toBe("derive/latex")
    // What the import decided rides on the version, not in a second document.
    expect(v?.message).toContain(`Imported from arXiv:${ID}v2`)
    expect(v?.message).toContain("unwrapped the top-level directory paper-src/")
    const manifest = JSON.parse(
      new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
    )
    expect(manifest.entry).toBe("/paper.tex")
    expect(Object.keys(manifest.files).sort()).toEqual([
      "/CITATION.bib",
      "/fig/a.png",
      "/main.bbl",
      "/main.tex",
      "/paper.bbl",
      "/paper.tex",
      "/refs.bib",
    ])
    expect([...((await ctx.blobs.get(manifest.files["/fig/a.png"].key)) ?? [])]).toEqual([...PNG])
    expect((await meta.tagsForArtifacts([row?.id ?? ""]))[row?.id ?? ""]).toEqual([
      "arxiv",
      `arxiv:${ID}`,
    ])
    // A person reads the paper, never its LaTeX: `content` answers in prose whatever it
    // is asked for, and the source-shaped routes are not there for them.
    const page = await app.request(`/v1/artifacts/${paper.short_id}/content`, {
      headers: as(member.email),
    })
    expect(page.status).toBe(200)
    const prose = await page.text()
    expect(prose).toContain("Intro")
    expect(prose).not.toContain("\\documentclass")
    expect(prose).not.toContain("\\bibliography")
    for (const path of [
      `/v1/artifacts/${paper.short_id}/source.zip`,
      `/v1/artifacts/${paper.short_id}/files/paper.tex`,
      `/v1/artifacts/${paper.short_id}/bib`,
      `/v1/artifacts/${paper.short_id}/diff?from=1&to=2`,
    ])
      expect((await app.request(path, { headers: as(member.email) })).status).toBe(404)
    // The rendered page is what the viewer shows, and `?raw=1` cannot peel it back.
    const rawTry = await app.request(
      `/raw/${paper.short_id}/v/${paper.current_version}/paper.tex?raw=1`,
      { headers: as(member.email) },
    )
    expect(await rawTry.text()).not.toContain("\\documentclass")

    // Read-only for people: no new version, no restore.
    expect(
      (await publishAs(app, "\\documentclass{article}", {}, as(owner.email), paper.short_id))
        .status,
    ).toBe(409)
    expect(
      (await publishAs(app, "# edited", {}, as(owner.email), after.manifest_short_id)).status,
    ).toBe(409)
    const restore = await app.request(`/v1/artifacts/${after.manifest_short_id}/restore`, {
      ...jsonAs(as(owner.email), { version: 1 }),
    })
    expect(restore.status).toBe(409)
    // And no runs: nothing would answer.
    const session = await app.request(
      `/v1/contexts/${created.id}/sessions`,
      jsonAs(as(owner.email), { body_md: "summarize" }),
    )
    expect(session.status).toBe(409)
    expect((await session.json()).error).toContain("imported paper")

    // The same paper again opens the one Context; a non-arXiv link is refused up front.
    const again = await importPaper(app, `https://huggingface.co/papers/${ID}`)
    expect(again.status).toBe(200)
    expect((await again.json()).id).toBe(created.id)
    const bad = await importPaper(app, "https://example.com/paper.pdf")
    expect(bad.status).toBe(400)
    expect((await bad.json()).code).toBe("not_arxiv")
  })

  it("holds arXiv's gate across workers, honours Retry-After for everyone, and resumes a reclaimed job", async () => {
    let rateLimit = true
    const stub = arxivStub({
      source: () =>
        rateLimit
          ? new Response("slow down", { status: 429, headers: { "retry-after": "120" } })
          : gzip(SOURCE()),
    })
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-gate", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const a = await (await importPaper(app, "2402.00001")).json()
    const b = await (await importPaper(app, "2402.00002")).json()
    expect(
      await meta.countActiveImportJobs(
        a.import ? ((await meta.getContext(a.id))?.org_id ?? "") : "",
      ),
    ).toBe(2)

    // Two workers on one store: one takes the gate, the other gets nothing.
    const [x, y] = await Promise.all([runImportTick(tickDeps("w1")), runImportTick(tickDeps("w2"))])
    expect(x + y).toBe(1)
    const jobA = await meta.getImportJobForContext(a.id)
    expect(jobA).toMatchObject({ status: "failed", error_code: "rate_limited", attempts: 1 })
    // The 429 holds every worker back for the Retry-After, not only the one that saw it.
    const lease = await meta.getImportLease("arxiv", "http://derive.test")
    expect(Date.parse(lease?.next_allowed_at ?? "")).toBeGreaterThanOrEqual(c.now() + 120_000)
    expect(await runImportTick(tickDeps("w2"))).toBe(0)
    c.advance(121_000)
    rateLimit = false
    // The other paper goes first (its job is due; A waits out its backoff).
    expect(await runImportTick(tickDeps("w2"))).toBe(1)
    expect((await meta.getImportJobForContext(b.id))?.status).toBe("ready")
    c.advance(10 * 60_000)
    expect(await runImportTick(tickDeps("w1"))).toBe(1)
    expect((await meta.getImportJobForContext(a.id))?.status).toBe("ready")

    // A worker that died mid-import: its job lease lapses and the next tick resumes from
    // the paper it had already published, fetching only the metadata again.
    const done = await meta.getImportJobForContext(a.id)
    if (!done) throw new Error("job missing")
    await meta.updateImportJob(done.id, {
      status: "fetching",
      lease_until: "2000-01-01T00:00:00.000Z",
      manifest_version: null,
    })
    const before = stub.calls.length
    c.advance(5 * 60_000)
    expect(await runImportTick(tickDeps("w3"))).toBe(1)
    expect(stub.calls.slice(before).map((u) => new URL(u).pathname)).toEqual(["/api/query"])
    const resumed = await meta.getImportJobForContext(a.id)
    expect(resumed).toMatchObject({ status: "ready", paper_artifact_id: done.paper_artifact_id })
    // Resuming republishes nothing: the paper it already published stands.
    const paper = await meta.getArtifactById(done.paper_artifact_id ?? "")
    expect(paper?.current_version).toBe(2)
  })

  it("gives up on arXiv's verdicts without retrying, and says so on the paper's page", async () => {
    const cases: [string, Stub | undefined, Stub | undefined, string][] = [
      ["2403.00001", () => new Response(ERROR_ATOM), undefined, "not_found"],
      [
        "2403.00002",
        undefined,
        () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), { status: 200 }),
        "no_source",
      ],
      [
        "2403.00003",
        undefined,
        () => gzip(gzipSync(tarSync({ "README.md": "no tex here" }))),
        "no_tex",
      ],
      ["2403.00004", undefined, () => gzip(gzipSync(new Uint8Array(6 * 1024 * 1024))), "too_large"],
      [
        "2403.00005",
        undefined,
        () => new Response("", { status: 301, headers: { location: "https://evil.example/src" } }),
        "unavailable",
      ],
    ]
    let current = cases[0]
    const stub = arxivStub({
      metadata: (url, init) => current?.[1]?.(url, init) ?? new Response(ATOM(current?.[0] ?? ID)),
      source: (url, init) => current?.[2]?.(url, init) ?? gzip(SOURCE()),
    })
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-failures", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    for (const kase of cases) {
      current = kase
      const [id, , , code] = kase
      const x = await (await importPaper(app, id)).json()
      c.advance(60_000)
      expect(await runImportTick(tickDeps())).toBe(1)
      const job = await meta.getImportJobForContext(x.id)
      expect(job?.error_code).toBe(code)
      const detail = await (
        await app.request(`/v1/contexts/${x.id}`, { headers: as(owner.email) })
      ).json()
      if (code === "unavailable") {
        // A redirect off arXiv is refused, and counts as arXiv being unreachable: retried.
        expect(job?.status).toBe("failed")
        expect(Date.parse(job?.next_attempt_at ?? "")).toBeGreaterThan(c.now())
        expect(detail.import.status).toBe("failed")
      } else {
        expect(job).toMatchObject({ status: "dead", attempts: 1 })
        expect(detail.import).toMatchObject({ status: "dead", error: { code } })
        // The one artifact says so on its page: it never keeps saying "fetching".
        const page = await app.request(
          `/v1/artifacts/${detail.manifest_short_id}/content?format=text`,
          { headers: as(owner.email) },
        )
        const text = await page.text()
        expect(text).toContain("Import failed:")
        expect(text).not.toContain("Fetching this paper")
      }
      // Its owner can queue it again; the count starts over.
      const retry = await app.request(`/v1/contexts/${x.id}/import/retry`, {
        method: "POST",
        headers: as(owner.email),
      })
      expect(retry.status).toBe(200)
      expect((await retry.json()).import.status).toBe("pending")
      expect((await meta.getImportJobForContext(x.id))?.attempts).toBe(
        code === "unavailable" ? 1 : 0,
      )
      // Clear it so the workspace cap does not trip the next case.
      await app.request(`/v1/contexts/${x.id}`, { method: "DELETE", headers: as(owner.email) })
      expect(await meta.getImportJob(job?.id ?? "")).toBeNull()
    }
  })

  it("shrinks oversized raster figures in place until the bundle fits, and names what it cannot shrink", async () => {
    // A 2200 px square of noise: PNG cannot compress it, so it weighs about as much as
    // its pixels, and the only way under a small cap is fewer pixels.
    const sharp = (await import("sharp")).default
    const noise = new Uint8Array(2200 * 2200)
    for (let at = 0; at < noise.length; at += 65_536)
      crypto.getRandomValues(noise.subarray(at, Math.min(at + 65_536, noise.length)))
    const bigPng = new Uint8Array(
      await sharp(noise, { raw: { width: 2200, height: 2200, channels: 1 } })
        .png()
        .toBuffer(),
    )
    const smallJpg = new Uint8Array(
      await sharp({ create: { width: 200, height: 120, channels: 3, background: "#3366aa" } })
        .jpeg()
        .toBuffer(),
    )
    expect(bigPng.byteLength).toBeGreaterThan(4 * 1024 * 1024)
    const tex = `\\documentclass{article}\\begin{document}\\includegraphics{figs/noise.png}\\includegraphics{figs/tiny.jpg}\\end{document}`
    let source: () => Uint8Array = () =>
      gzipSync(tarSync({ "main.tex": tex, "figs/noise.png": bigPng, "figs/tiny.jpg": smallJpg }))
    const stub = arxivStub({ source: () => gzip(source()) })
    const { app, meta, ctx, clock: c, tickDeps } = setup("contexts-import-shrink", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const caps = {
      compressedBytes: 64 * 1024 * 1024,
      inflatedBytes: 64 * 1024 * 1024,
      bundleBytes: 4 * 1024 * 1024,
      files: 200,
    }
    const x = await (await importPaper(app, "2405.00001")).json()
    expect(await runImportTick({ ...tickDeps(), caps, shrink: sharpShrinker() })).toBe(1)
    const detail = await (
      await app.request(`/v1/contexts/${x.id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.import.status).toBe("ready")
    const paper = await meta.getByShortId(detail.documents[0].short_id)
    const v = paper ? await meta.getVersion(paper.id, paper.current_version) : null
    expect(v?.message).toMatch(
      /shrank 1 figure to at most 1600 px on the long side \(\d+\.\d MB → \d+\.\d MB\)/,
    )
    const manifest = JSON.parse(
      new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
    )
    // Same paths and formats; the PNG lost pixels, the small JPEG kept its bytes.
    expect(Object.keys(manifest.files).sort()).toEqual([
      "/CITATION.bib",
      "/figs/noise.png",
      "/figs/tiny.jpg",
      "/main.tex",
    ])
    const shrunk = (await ctx.blobs.get(manifest.files["/figs/noise.png"].key)) ?? new Uint8Array()
    expect(shrunk.byteLength).toBeLessThan(bigPng.byteLength)
    expect([...shrunk.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    const width = new DataView(shrunk.buffer, shrunk.byteOffset).getUint32(16)
    const height = new DataView(shrunk.buffer, shrunk.byteOffset).getUint32(20)
    expect(Math.max(width, height)).toBe(1600)
    expect([...((await ctx.blobs.get(manifest.files["/figs/tiny.jpg"].key)) ?? [])]).toEqual([
      ...smallJpg,
    ])
    expect(v?.size_bytes).toBeLessThan(caps.bundleBytes)
    const page = await app.request(`/v1/artifacts/${paper?.short_id}/content`, {
      headers: as(owner.email),
    })
    expect(await page.text()).toContain("figs/noise.png")

    // A PDF figure is never touched: when it alone keeps the bundle over the cap, the
    // import gives up and says which file it was.
    source = () =>
      gzipSync(
        tarSync({
          "main.tex":
            "\\documentclass{article}\\begin{document}\\includegraphics{figs/plot.pdf}\\end{document}",
          "figs/plot.pdf": new Uint8Array(6 * 1024 * 1024).fill(0x25),
          "figs/noise.png": bigPng,
        }),
      )
    const y = await (await importPaper(app, "2405.00002")).json()
    c.advance(60_000)
    expect(await runImportTick({ ...tickDeps(), caps, shrink: sharpShrinker() })).toBe(1)
    const job = await meta.getImportJobForContext(y.id)
    expect(job).toMatchObject({ status: "dead", error_code: "too_large" })
    expect(job?.error_detail).toMatch(
      /after shrinking 1 figures; largest: figs\/plot\.pdf \(6\.0 MB\)/,
    )
    const failed = await (
      await app.request(`/v1/contexts/${y.id}`, { headers: as(owner.email) })
    ).json()
    const failedPage = await app.request(
      `/v1/artifacts/${failed.manifest_short_id}/content?format=text`,
      { headers: as(owner.email) },
    )
    expect(await failedPage.text()).toContain("Import failed:")
  }, 30_000)

  // A paper's implementation. The agent reads it; the person gets a link to the
  // repository on its own host and never a file listing.
  const REPO_FILES = {
    "gaussian-splatting-abc123/README.md": "# Gaussian Splatting\n\nRun `train.py`.\n",
    "gaussian-splatting-abc123/docs/index.html": "<h1>Project page</h1>",
    "gaussian-splatting-abc123/docs/site.css": "body { color: red }",
    "gaussian-splatting-abc123/train.py": "def train():\n    return 42\n",
    "gaussian-splatting-abc123/utils/loss.py": "def l1(a, b):\n    return abs(a - b)\n",
    "gaussian-splatting-abc123/.gitmodules":
      '[submodule "submodules/rasterizer"]\n\tpath = submodules/rasterizer\n\turl = https://github.com/graphdeco-inria/diff-gaussian-rasterization\n\tbranch = dr_aa\n[submodule "submodules/knn"]\n\tpath = submodules/knn\n\turl = https://bitbucket.org/bkerbl/simple-knn.git\n[submodule "submodules/walled"]\n\tpath = submodules/walled\n\turl = https://gitlab.example.org/lab/walled.git\n',
  }
  const SUB_FILES = {
    "diff-gaussian-rasterization-def456/setup.py": "from setuptools import setup\nsetup()\n",
  }
  const repoTar = (files: Record<string, string | Uint8Array>) => () =>
    gzip(gzipSync(tarSync(files)))

  it("fetches the repository that implements a paper into the paper's own artifact", async () => {
    const stub = arxivStub(
      {},
      {
        "graphdeco-inria/gaussian-splatting": repoTar(REPO_FILES),
        "graphdeco-inria/diff-gaussian-rasterization": repoTar(SUB_FILES),
        // A lab's own GitLab behind an anti-bot wall: real, and common for the
        // institutional submodules a paper's repository declares.
        "lab/walled": () => new Response("<html>not a bot?</html>", { status: 406 }),
      },
    )
    const { app, meta, ctx, tickDeps } = setup("contexts-import-code", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })

    const res = await app.request(
      "/v1/contexts/import/arxiv",
      jsonAs(as(owner.email), {
        url: "2406.00001",
        code_url: "https://github.com/graphdeco-inria/gaussian-splatting",
      }),
    )
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(await runImportTick(tickDeps())).toBe(1)

    // The repository was fetched from the host's plain archive, with no API call and no
    // token, and the submodule it declares came too.
    const archives = stub.calls.filter((u) => u.includes("/tar.gz/"))
    expect(archives).toEqual([
      "https://codeload.github.com/graphdeco-inria/gaussian-splatting/tar.gz/HEAD",
      "https://codeload.github.com/graphdeco-inria/diff-gaussian-rasterization/tar.gz/dr_aa",
    ])

    const detail = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(owner.email) })
    ).json()
    // The paper's own import is ready, and so is its implementation.
    expect(detail.import.status).toBe("ready")
    const job = await meta.getImportJobForContext(created.id)
    expect(job).toMatchObject({
      code_status: "ready",
      code_error: null,
      code_ref: "github.com/graphdeco-inria/gaussian-splatting",
    })

    // ONE artifact still: the paper, now carrying the code under /code/.
    expect(detail.documents).toHaveLength(1)
    const paper = await meta.getByShortId(detail.documents[0].short_id)
    const v = paper ? await meta.getVersion(paper.id, paper.current_version) : null
    const manifest = JSON.parse(
      new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
    )
    expect(Object.keys(manifest.files).sort()).toEqual([
      "/CITATION.bib",
      "/code/.gitmodules",
      "/code/README.md",
      "/code/docs/index.html",
      "/code/docs/site.css",
      "/code/submodules/rasterizer/setup.py",
      "/code/train.py",
      "/code/utils/loss.py",
      "/fig/a.png",
      "/main.bbl",
      "/main.tex",
      "/paper.bbl",
      "/paper.tex",
      "/refs.bib",
    ])
    // The paper is still the document: a README inside the repository did not take the
    // entry, and the artifact is still a LaTeX paper.
    expect(manifest.entry).toBe("/paper.tex")
    expect(v?.content_type).toContain("latex")
    // The version says what was attached, including the branch caveat and the host it
    // would not follow.
    expect(v?.message).toContain("Attached github.com/graphdeco-inria/gaussian-splatting")
    expect(v?.message).toContain("skipped the submodule at submodules/knn")
    expect(v?.message).toContain("at their declared branch")
    // A submodule that will not come is a gap in the tree, not the end of the fetch: the
    // rest of the implementation is stored and the missing one is named.
    expect(v?.message).toContain("could not fetch the submodule at submodules/walled")
    expect(v?.message).toContain("refused an anonymous download (406)")

    // The code is stored as itself, byte for byte, so an agent asking for that path gets
    // the source rather than a rendering of it.
    expect(
      new TextDecoder().decode(
        (await ctx.blobs.get(manifest.files["/code/train.py"].key)) ?? undefined,
      ),
    ).toBe("def train():\n    return 42\n")

    // ---- and none of it is visible to a person -----------------------------------
    const short = paper?.short_id
    // The file list the artifact page renders: the paper's files, never the repository's.
    const detailJson = await (
      await app.request(`/v1/artifacts/${short}`, { headers: as(owner.email) })
    ).json()
    expect(detailJson.bundle.files.map((f: { path: string }) => f.path)).toEqual([
      "CITATION.bib",
      "fig/a.png",
      "main.bbl",
      "main.tex",
      "paper.bbl",
      "paper.tex",
      "refs.bib",
    ])
    // The machine content API's page list, the other place a path listing escapes.
    const outline = await (
      await app.request(`/v1/artifacts/${short}/content?outline=1`, { headers: as(owner.email) })
    ).json()
    expect(JSON.stringify(outline)).not.toContain("/code/")
    // Serving a file: a repository's HTML, CSS and markdown render BEFORE the paper's
    // source guard, so each has to be refused by name.
    const n = paper?.current_version
    for (const path of [
      "code/train.py",
      "code/README.md",
      "code/docs/index.html",
      "code/docs/site.css",
      "code/docs",
    ]) {
      const raw = await app.request(`/raw/${short}/v/${n}/${path}`, { headers: as(owner.email) })
      expect([raw.status, path]).toEqual([404, path])
    }
    // The paper's own page still renders, with its figure.
    const page = await app.request(`/raw/${short}/v/${n}/`, { headers: as(owner.email) })
    expect(page.status).toBe(200)
    expect(
      (await app.request(`/raw/${short}/v/${n}/fig/a.png`, { headers: as(owner.email) })).status,
    ).toBe(200)
    // And the source export is the paper's source: an implementation is not something
    // the authors wrote.
    expect(
      (await app.request(`/v1/artifacts/${short}/source.zip`, { headers: as(owner.email) })).status,
    ).toBe(404)
  })

  it("keeps every source file and leaves the big media behind", async () => {
    // A repository that is mostly demo media, which is what a paper's repository is.
    // Real bytes, not printable ones: what makes a file media is its content.
    const bigGif = new Uint8Array(3 * 1024 * 1024)
    bigGif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00])
    for (let at = 8; at < bigGif.length; at += 65_536)
      crypto.getRandomValues(bigGif.subarray(at, Math.min(at + 65_536, bigGif.length)))
    const smallPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const stub = arxivStub(
      {},
      {
        "o/r": repoTar({
          "r-abc/train.py": "def train():\n    return 1\n",
          "r-abc/assets/demo.gif": bigGif,
          "r-abc/assets/icon.png": smallPng,
        }),
      },
    )
    const { app, meta, ctx, tickDeps } = setup("contexts-import-code-big", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(owner.email), { url: "2406.00002", code_url: "https://github.com/o/r" }),
      )
    ).json()
    // An artifact with an implementation gets twice this deployment's bundle cap, so a
    // 1 MB cap here leaves 2 MB for a paper plus 3 MB of demo media.
    const base = tickDeps()
    expect(
      await runImportTick({
        ...base,
        caps: { ...base.caps, bundleBytes: 1024 * 1024 },
        repoCaps: { ...base.repoCaps, compressedBytes: 8 * 1024 * 1024 },
      }),
    ).toBe(1)

    const detail = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(owner.email) })
    ).json()
    const paper = await meta.getByShortId(detail.documents[0].short_id)
    const v = paper ? await meta.getVersion(paper.id, paper.current_version) : null
    const manifest = JSON.parse(
      new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
    )
    const code = Object.keys(manifest.files).filter((p: string) => p.startsWith("/code/"))
    // Every line of source survives; the 3 MB GIF does not, and is named.
    expect(code).toContain("/code/train.py")
    expect(code).toContain("/code/assets/icon.png")
    expect(code).not.toContain("/code/assets/demo.gif")
    expect(v?.message).toContain("left out 1 large file")
    expect(v?.message).toContain("assets/demo.gif")
    expect((await meta.getImportJobForContext(created.id))?.code_status).toBe("ready")
  })

  it("attaches an implementation to a paper already imported, then takes it away", async () => {
    const stub = arxivStub(
      {},
      { "o/r": repoTar({ "r-abc/train.py": "def train():\n    return 7\n" }) },
    )
    const { app, meta, ctx, clock: c, tickDeps } = setup("contexts-import-code-later", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await (await importPaper(app, "2406.00005")).json()
    // arXiv's gate holds every worker for the interval after a request, so each tick
    // below waits it out the way a real deployment's next tick would.
    const tick = async () => {
      c.advance(ARXIV_REQUEST_INTERVAL_MS + 1)
      return await runImportTick(tickDeps())
    }
    expect(await tick()).toBe(1)

    const filesOf = async () => {
      const detail = await (
        await app.request(`/v1/contexts/${created.id}`, { headers: as(owner.email) })
      ).json()
      const paper = await meta.getByShortId(detail.documents[0].short_id)
      const v = paper ? await meta.getVersion(paper.id, paper.current_version) : null
      const manifest = JSON.parse(
        new TextDecoder().decode((await ctx.blobs.get(v?.blob_key ?? "")) ?? undefined),
      )
      return { detail, version: v, paths: Object.keys(manifest.files).sort() }
    }
    const imported = await filesOf()
    expect(imported.paths.some((p: string) => p.startsWith("/code/"))).toBe(false)
    expect(imported.detail.import.code).toBeNull()

    // Attach it afterwards: the paper is not fetched again, only its metadata is.
    const before = stub.calls.length
    const attached = await (
      await app.request(
        `/v1/contexts/${created.id}/import/code`,
        jsonAs(as(owner.email), { url: "https://github.com/o/r" }),
      )
    ).json()
    expect(attached.import.code).toEqual({
      url: "https://github.com/o/r",
      status: "pending",
      error: null,
    })
    expect(await tick()).toBe(1)
    expect(stub.calls.slice(before).filter((u) => u.includes("/src/"))).toEqual([])

    const withCode = await filesOf()
    expect(withCode.paths).toContain("/code/train.py")
    expect(withCode.detail.import.code).toMatchObject({ status: "ready", error: null })
    expect(withCode.version?.message).toContain("Attached github.com/o/r")

    // Attaching the SAME repository again is not a change: the job runs, sees the link it
    // already fetched, and leaves the paper on the version it is on.
    const version = withCode.version?.n
    await app.request(
      `/v1/contexts/${created.id}/import/code`,
      jsonAs(as(owner.email), { url: "https://github.com/o/r/" }),
    )
    expect(await tick()).toBe(1)
    expect((await filesOf()).version?.n).toBe(version)

    // Removing it republishes the paper without the code, so it stops being readable.
    const removed = await (
      await app.request(
        `/v1/contexts/${created.id}/import/code`,
        jsonAs(as(owner.email), { url: null }),
      )
    ).json()
    expect(removed.import.code).toBeNull()
    expect(await tick()).toBe(1)
    const gone = await filesOf()
    expect(gone.paths.some((p: string) => p.startsWith("/code/"))).toBe(false)
    expect(gone.paths).toContain("/paper.tex")
    expect(gone.version?.message).toBe("Removed the implementation")
    expect(await meta.getImportJobForContext(created.id)).toMatchObject({
      code_status: null,
      code_ref: null,
    })
  })

  it("a repository that cannot be fetched leaves the paper imported and says why", async () => {
    const stub = arxivStub() // every repository archive 404s
    const { app, meta, tickDeps } = setup("contexts-import-code-fail", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await (
      await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(owner.email), { url: "2406.00003", code_url: "https://github.com/o/gone" }),
      )
    ).json()
    expect(await runImportTick(tickDeps())).toBe(1)

    // The paper is what the import is for: it arrived, and stays arrived.
    const detail = await (
      await app.request(`/v1/contexts/${created.id}`, { headers: as(owner.email) })
    ).json()
    expect(detail.import.status).toBe("ready")
    expect(detail.name).toBe("Attention Is All You Need")
    expect(await meta.getImportJobForContext(created.id)).toMatchObject({
      status: "ready",
      code_status: "failed",
      code_error: "no such repository, or it is not public (the host answered 404)",
    })
  })

  it("refuses a link that is not a public GitHub or GitLab repository", async () => {
    const stub = arxivStub()
    const { app, tickDeps } = setup("contexts-import-code-bad", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    for (const code_url of [
      "https://bitbucket.org/o/r",
      "file:///etc/passwd",
      "https://github.com/only-an-owner",
    ]) {
      const res = await app.request(
        "/v1/contexts/import/arxiv",
        jsonAs(as(owner.email), { url: "2406.00004", code_url }),
      )
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe("not_a_repo")
    }
    // Nothing was queued, so nothing was fetched.
    expect(await runImportTick(tickDeps())).toBe(0)
  })

  it("hands the arXiv gate back before shrinking, so the next import fetches meanwhile", async () => {
    // A figure above the shrink floor, so the codec is entered at all.
    const stub = arxivStub({
      source: () =>
        gzip(
          gzipSync(
            tarSync({
              "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}",
              "fig/big.png": new Uint8Array(100 * 1024),
            }),
          ),
        ),
    })
    const { app, meta, clock: c, tickDeps } = setup("contexts-import-gate-free", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2406.00001")).json()
    let resume: () => void = () => {}
    const shrinking = new Promise<void>((r) => {
      resume = r
    })
    let entered: () => void = () => {}
    const enteredShrink = new Promise<void>((r) => {
      entered = r
    })
    const slow = async () => {
      entered()
      await shrinking
      return null
    }
    const caps = { compressedBytes: 64 << 20, inflatedBytes: 64 << 20, bundleBytes: 1, files: 200 }
    const tick = runImportTick({ ...tickDeps("w1"), caps, shrink: slow })
    await enteredShrink
    // The three requests are out; three seconds later another worker may take the gate
    // although w1 is still busy with the figures.
    c.advance(3_500)
    expect(
      await meta.acquireImportLease(
        "arxiv",
        "http://derive.test",
        "w2",
        new Date(c.now()).toISOString(),
        new Date(c.now() + 240_000).toISOString(),
      ),
    ).toBe(true)
    resume()
    expect(await tick).toBe(1)
    // The job then failed honestly (a 1-byte cap fits nothing), without touching the gate.
    expect((await meta.getImportJobForContext(x.id))?.error_code).toBe("too_large")
    expect((await meta.getImportLease("arxiv", "http://derive.test"))?.holder).toBe("w2")
  })

  it("stops when the Context is discarded mid-fetch, and caps a workspace's imports in flight", async () => {
    let discard: (() => Promise<void>) | null = null
    const stub = arxivStub({
      source: async () => {
        await discard?.()
        return gzip(SOURCE())
      },
    })
    const { app, meta, tickDeps } = setup("contexts-import-cancel", stub.fetch)
    await app.request("/v1/me", { headers: as(owner.email) })
    const x = await (await importPaper(app, "2404.00001")).json()
    const org = (await meta.getContext(x.id))?.org_id ?? ""
    const artifactsBefore = (await meta.listArtifacts({ orgId: org, limit: 100 })).length
    discard = async () => {
      await app.request(`/v1/contexts/${x.id}`, { method: "DELETE", headers: as(owner.email) })
    }
    expect(await runImportTick(tickDeps())).toBe(1)
    expect(await meta.getContext(x.id)).toBeNull()
    expect(await meta.getImportJobForContext(x.id)).toBeNull()
    // The manifest went with the context; no paper was published into the void.
    expect((await meta.listArtifacts({ orgId: org, limit: 100 })).length).toBe(artifactsBefore - 1)

    discard = null
    for (const id of ["2404.00002", "2404.00003", "2404.00004"])
      expect((await importPaper(app, id)).status).toBe(201)
    const fourth = await importPaper(app, "2404.00005")
    expect(fourth.status).toBe(429)
  })
})
