import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// POST /v1/artifacts/:shortId/rework composes the canned Brandprint instruction
// server-side and lands it in the chosen agent's pull inbox as an @mention
// comment — the same path the ask-agent composer uses, minus the human typing it.

const owner: TestUser = {
  id: "u_rw_own",
  email: "rwown@derive.test",
  name: "Owner",
  username: "rwown",
}
const editor: TestUser = { id: "u_rw_ed", email: "rwed@derive.test", name: "Ed", username: "rwed" }

type App = ReturnType<typeof makeAuthedApp>["app"]
type Meta = ReturnType<typeof makeAuthedApp>["meta"]

const newArtifact = async (app: App) => {
  const r = await publishAs(app, "# Doc", {}, as(owner.email))
  return (await r.json()).short_id as string
}

// Register an agent (owner-only route); the token is returned once, here.
const addAgent = async (app: App, name: string) =>
  (await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name, role: "editor" }))
  ).json()) as {
    id: string
    name: string
    token: string
  }

// Seed a Brandprint: a collection holding the given doc, pointed at by the workspace
// (the same store-level seeding mcp.test.ts uses).
const seedBrandprint = async (meta: Meta, artShortId: string, extra?: { profileId?: string }) => {
  const art = await meta.getByShortId(artShortId)
  if (!art) throw new Error("no artifact")
  const collectionId = `col_${artShortId}`
  await meta.createCollection({
    id: collectionId,
    org_id: art.org_id,
    title: "Brandprint",
    created_by: owner.id,
  })
  await meta.addCollectionItem(collectionId, art.id)
  await meta.setOrgSettings(art.org_id, {
    ...(await meta.getOrgSettings(art.org_id)),
    brandprint: { collectionId, ...extra },
  })
}

const rework = (
  app: App,
  shortId: string,
  body: Record<string, unknown> = {},
  who = editor.email,
) => app.request(`/v1/artifacts/${shortId}/rework`, jsonAs(as(who), body))

const inboxBodies = async (app: App, token: string) => {
  const inbox = (await (
    await app.request("/v1/agent/inbox", { headers: bearer(token) })
  ).json()) as {
    mentions: { id: string; body: string; artifact: string; thread_id: string }[]
  }
  return inbox.mentions
}

describe("rework: gating", () => {
  it("409 needsAgent when the workspace has no registered agent", async () => {
    const { app, meta } = makeAuthedApp("rework-noagent", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    await seedBrandprint(meta, shortId)
    const res = await rework(app, shortId)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe("needsAgent")
  })

  it("409 needsBrandprint when no Brandprint resolves — an empty brief never fires", async () => {
    const { app } = makeAuthedApp("rework-nobp", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    await addAgent(app, "Reviser")
    const res = await rework(app, shortId)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe("needsBrandprint")
  })

  it("409s brandprintDisabled when the caller turned the workspace Brandprint off", async () => {
    const { app, meta } = makeAuthedApp("rework-disabled", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    await seedBrandprint(meta, shortId)
    await addAgent(app, "Reviser")
    // The caller turns the workspace layer off, with no personal collection of
    // their own to fall back to — the brief goes empty because of the toggle,
    // not because nothing was ever set up.
    const saved = await app.request(
      "/v1/me/profile",
      jsonAs(as(editor.email), { brandprint: { useWorkspaceBrandprint: false } }),
    )
    expect(saved.status).toBe(200)
    const res = await rework(app, shortId)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe("brandprintDisabled")
    expect(body.error).toBe("Brandprint is turned off in your settings. Turn it on to rework.")
  })

  it("rework proceeds on the personal collection when the workspace layer is off", async () => {
    const { app, meta } = makeAuthedApp("rework-disabled-personal", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    await seedBrandprint(meta, shortId)
    const ag = await addAgent(app, "Reviser")
    // The caller turns the workspace layer off but keeps their own collection —
    // the resolved brief is non-empty, so rework fires as usual.
    const col = await (
      await app.request("/v1/collections", jsonAs(as(editor.email), { title: "My Brandprint" }))
    ).json()
    const saved = await app.request(
      "/v1/me/profile",
      jsonAs(as(editor.email), {
        brandprint: { collectionId: col.id, useWorkspaceBrandprint: false },
      }),
    )
    expect(saved.status).toBe(200)
    const res = await rework(app, shortId)
    expect(res.status).toBe(201)
    const mentions = await inboxBodies(app, ag.token)
    expect(mentions).toHaveLength(1)
    expect(mentions[0]?.body).toContain("@Reviser")
  })

  it("404 for an unknown artifact; 404 for an agentId from another workspace", async () => {
    const { app, meta } = makeAuthedApp("rework-404", [owner, editor], "editor")
    expect((await rework(app, "nope")).status).toBe(404)
    const shortId = await newArtifact(app)
    await seedBrandprint(meta, shortId)
    await addAgent(app, "Reviser")
    expect((await rework(app, shortId, { agentId: "agt_elsewhere" })).status).toBe(404)
  })
})

describe("rework: firing", () => {
  it("sole agent, agentId omitted: the canned request lands in the agent's inbox", async () => {
    const { app, meta } = makeAuthedApp("rework-sole", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    await seedBrandprint(meta, shortId)
    const ag = await addAgent(app, "Reviser")
    const res = await rework(app, shortId)
    expect(res.status).toBe(201)
    const { requestId } = (await res.json()) as { requestId: string }
    expect(requestId).toBeTruthy()
    const mentions = await inboxBodies(app, ag.token)
    expect(mentions).toHaveLength(1)
    expect(mentions[0]?.artifact).toBe(shortId)
    expect(mentions[0]?.thread_id).toBe(requestId)
    expect(mentions[0]?.body).toContain("@Reviser")
    expect(mentions[0]?.body).toContain("derive://brandprint/*")
    expect(mentions[0]?.body).toContain("Publish the result as a new version.")
    expect(mentions[0]?.body).not.toContain("derive://brandprint/profile")
  })

  it("workspace Brandprint unset, requester's personal profile carries one: still fires", async () => {
    const { app } = makeAuthedApp("rework-personal", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    const ag = await addAgent(app, "Reviser")
    // No seedBrandprint call — the workspace layer stays unset. Seed the requester's
    // PERSONAL layer through the real route the web uses (POST /v1/me/profile), same
    // as profiles.test.ts, pointed at a collection the requester can reach.
    const col = await (
      await app.request("/v1/collections", jsonAs(as(editor.email), { title: "My Brandprint" }))
    ).json()
    const saved = await app.request(
      "/v1/me/profile",
      jsonAs(as(editor.email), { brandprint: { collectionId: col.id } }),
    )
    expect(saved.status).toBe(200)
    const res = await rework(app, shortId)
    expect(res.status).toBe(201)
    const mentions = await inboxBodies(app, ag.token)
    expect(mentions).toHaveLength(1)
    expect(mentions[0]?.body).toContain("@Reviser")
  })

  it("several agents: omitted agentId 400s; a chosen agentId fires that agent only", async () => {
    const { app, meta } = makeAuthedApp("rework-many", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    await seedBrandprint(meta, shortId)
    const a = await addAgent(app, "Reviser")
    const b = await addAgent(app, "Stylist")
    expect((await rework(app, shortId)).status).toBe(400)
    const res = await rework(app, shortId, { agentId: b.id })
    expect(res.status).toBe(201)
    expect(await inboxBodies(app, a.token)).toHaveLength(0)
    const got = await inboxBodies(app, b.token)
    expect(got).toHaveLength(1)
    expect(got[0]?.body).toContain("@Stylist")
  })

  it("a LIVE brand profile is named as the first read; a pending one is not", async () => {
    const { app, meta } = makeAuthedApp("rework-profile", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    const ag = await addAgent(app, "Reviser")
    // The profile stub is v1 (pending); publishing a second version makes it live.
    const profId = (await (await publishAs(app, "profile v1", {}, as(owner.email))).json())
      .short_id as string
    await seedBrandprint(meta, shortId, { profileId: profId })
    const pending = await rework(app, shortId)
    expect(pending.status).toBe(201)
    const first = await inboxBodies(app, ag.token)
    expect(first[0]?.body).not.toContain("Read derive://brandprint/profile first")
    // The queue dedupes per (agent, artifact), so the agent acks the handled request
    // before the second fire — exactly the real loop.
    await app.request(`/v1/agent/mentions/${first[0]?.id}/ack`, {
      method: "POST",
      headers: bearer(ag.token),
    })
    await publishAs(app, "profile v2", {}, as(owner.email), profId)
    const live = await rework(app, shortId)
    expect(live.status).toBe(201)
    const second = await inboxBodies(app, ag.token)
    expect(second).toHaveLength(1)
    expect(second[0]?.body).toContain("Read derive://brandprint/profile first")
  })
})

// The generate endpoint fires the build-the-profile brief at the workspace's brand
// profile artifact — same @mention-to-inbox mechanics as rework, different canned text.
const generate = (
  app: App,
  shortId: string,
  body: Record<string, unknown> = {},
  who = editor.email,
) => app.request(`/v1/artifacts/${shortId}/generate-profile`, jsonAs(as(who), body))

describe("generate-profile: gating and firing", () => {
  it("400 when the artifact is not the workspace's brand profile", async () => {
    const { app, meta } = makeAuthedApp("gen-notprofile", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    await seedBrandprint(meta, shortId) // brandprint set, but no profileId points here
    await addAgent(app, "Reviser")
    const res = await generate(app, shortId)
    expect(res.status).toBe(400)
  })

  it("409 needsAgent when no agent is registered", async () => {
    const { app, meta } = makeAuthedApp("gen-noagent", [owner, editor], "editor")
    const doc = await newArtifact(app)
    const prof = await newArtifact(app)
    await seedBrandprint(meta, doc, { profileId: prof })
    const res = await generate(app, prof)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe("needsAgent")
  })

  it("fires the build brief into the agent inbox; a repeat while queued is alreadyQueued", async () => {
    const { app, meta } = makeAuthedApp("gen-fire", [owner, editor], "editor")
    const doc = await newArtifact(app)
    const prof = await newArtifact(app)
    await seedBrandprint(meta, doc, { profileId: prof })
    const ag = await addAgent(app, "Reviser")

    const res = await generate(app, prof)
    expect(res.status).toBe(201)
    expect(((await res.json()) as { requestId: string }).requestId).toBeTruthy()
    const mentions = await inboxBodies(app, ag.token)
    expect(mentions).toHaveLength(1)
    expect(mentions[0]?.artifact).toBe(prof)
    expect(mentions[0]?.body).toContain("@Reviser")
    expect(mentions[0]?.body).toContain("derive://brandprint/reference")
    expect(mentions[0]?.body).toContain(`for_review: true to artifact ${prof}`)

    // The queue already holds this ask — a second fire must not stack a duplicate.
    const again = await generate(app, prof)
    expect(again.status).toBe(409)
    expect(((await again.json()) as { code: string }).code).toBe("alreadyQueued")
    expect(await inboxBodies(app, ag.token)).toHaveLength(1)
  })
})

describe("rework: queue dedupe", () => {
  it("a second rework while one is queued is alreadyQueued, not a duplicate", async () => {
    const { app, meta } = makeAuthedApp("rework-dedupe", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    await seedBrandprint(meta, shortId)
    const ag = await addAgent(app, "Reviser")
    expect((await rework(app, shortId)).status).toBe(201)
    const again = await rework(app, shortId)
    expect(again.status).toBe(409)
    expect(((await again.json()) as { code: string }).code).toBe("alreadyQueued")
    expect(await inboxBodies(app, ag.token)).toHaveLength(1)
  })
})
