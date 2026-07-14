import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Phase 3 (apply): POST /v1/artifacts/:shortId/rework composes the canned Brandprint
// instruction server-side and lands it in the chosen agent's pull inbox as an @mention
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
    mentions: { body: string; artifact: string; thread_id: string }[]
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
    expect(((await res.json()) as { error: string }).error).toBe("needsAgent")
  })

  it("409 needsBrandprint when no Brandprint resolves — an empty brief never fires", async () => {
    const { app } = makeAuthedApp("rework-nobp", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    await addAgent(app, "Reviser")
    const res = await rework(app, shortId)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe("needsBrandprint")
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
    await publishAs(app, "profile v2", {}, as(owner.email), profId)
    const live = await rework(app, shortId)
    expect(live.status).toBe(201)
    const bodies = (await inboxBodies(app, ag.token)).map((m) => m.body)
    expect(bodies).toHaveLength(2)
    expect(bodies.filter((b) => b.includes("Read derive://brandprint/profile first"))).toHaveLength(
      1,
    )
  })
})
