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
    expect(mentions[0]?.body).toContain(`to artifact ${prof}`)
    expect(mentions[0]?.body).toContain("review round")

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

// ---------------------------------------------------------------------------
// Save-as-skill: the same canned-instruction-to-agent-inbox pattern as rework (needsAgent,
// alreadyQueued, the thread must be on this artifact).
describe("save-as-skill: gating and firing", () => {
  // Save-as-skill: the capture pair. GET returns the copyable prompt; POST delivers the
  // identical instruction (saveAsSkillInstruction is the single source) to a registered
  // agent's pull inbox — the rework-route pattern. The captured skill publishes LIVE and
  // gets reviewed by comments on the live version.

  const owner: TestUser = {
    id: "u_cap_own",
    email: "capown@derive.test",
    name: "Owner",
    username: "capown",
  }
  const editor: TestUser = {
    id: "u_cap_ed",
    email: "caped@derive.test",
    name: "Ed",
    username: "caped",
  }

  const { app } = makeAuthedApp("skillcap", [owner, editor], "editor")

  const addAgent = async (name: string) =>
    (await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name, role: "editor" }))
    ).json()) as { id: string; name: string; token: string }

  const comment = async (shortId: string, body: string) =>
    (await (
      await app.request(
        `/v1/artifacts/${shortId}/comments`,
        jsonAs(as(owner.email), { body_md: body }),
      )
    ).json()) as { thread_id: string }

  const getPrompt = (shortId: string, qs = "") =>
    app.request(`/v1/artifacts/${shortId}/save-as-skill${qs}`, { headers: as(editor.email) })
  const post = (shortId: string, body: Record<string, unknown> = {}) =>
    app.request(`/v1/artifacts/${shortId}/save-as-skill`, jsonAs(as(editor.email), body))

  describe("GET /save-as-skill — the copyable capture prompt", () => {
    it("404s a thread that is not on this artifact", async () => {
      const a = await (await publishAs(app, "# A", {}, as(owner.email))).json()
      const b = await (await publishAs(app, "# B", {}, as(owner.email))).json()
      const elsewhere = await comment(b.short_id, "unrelated")
      const res = await getPrompt(a.short_id, `?threadId=${elsewhere.thread_id}`)
      expect(res.status).toBe(404)
    })
  })

  describe("POST /save-as-skill — the one-click ask", () => {
    it("lands the instruction in the agent's inbox, once per artifact", async () => {
      const page = await (
        await publishAs(app, "<h1>Report</h1>", { title: "Report" }, as(owner.email))
      ).json()
      const agent = await addAgent("Capturer")
      const res = await post(page.short_id, { note: "the summary-table rule" })
      expect(res.status).toBe(201)

      const inbox = (await (
        await app.request("/v1/agent/inbox", { headers: bearer(agent.token) })
      ).json()) as { mentions: { body: string }[] }
      const body = inbox.mentions[0]?.body ?? ""
      expect(body).toContain(page.short_id)
      expect(body).toContain("derive://skills")
      expect(body).toContain("From the requester: the summary-table rule")

      const again = await post(page.short_id)
      expect(again.status).toBe(409)
      expect(((await again.json()) as { code: string }).code).toBe("alreadyQueued")
    })

    it("409s needsAgent when no agent is registered", async () => {
      const lone = makeAuthedApp("skillcap-noagent", [owner, editor], "editor")
      const page = await (await publishAs(lone.app, "# Doc", {}, as(owner.email))).json()
      const res = await lone.app.request(
        `/v1/artifacts/${page.short_id}/save-as-skill`,
        jsonAs(as(editor.email), {}),
      )
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe("needsAgent")
    })
  })
})
