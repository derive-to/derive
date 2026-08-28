import { describe, expect, it } from "vitest"
import type { ModelTurn } from "../src/lib/agent-loop"
import { buildContextBuilderTools, type StoredBuilderCard } from "../src/lib/context-builder-tools"
import { catalogOf } from "../src/lib/model-catalog"
import { as, makeAuthedApp } from "./helpers"

const owner = { id: "u-b", email: "b@x.com", name: "B" }
const viewer = { id: "u-v", email: "v@x.com", name: "V" }
const draft = {
  name: "Pricing Helper",
  description: "Answers pricing questions",
  knows: ["The pricing page", "The FAQ"],
  answers: "Short, with links",
  wont: ["Legal advice"],
  manifest_md: "# Pricing Helper\n...",
  source_short_ids: [],
}
const ownerWho = {
  org: "default",
  user: { id: owner.id, name: owner.name },
  seatRole: "owner" as const,
}

const setupOwner = async (name: string) => {
  const made = makeAuthedApp(name, [owner])
  await made.app.request("/v1/me", { headers: as(owner.email) })
  return { ...made, surface: buildContextBuilderTools(made.ctx, ownerWho) }
}

const instructionArtifacts = (meta: ReturnType<typeof makeAuthedApp>["meta"]) =>
  meta.listArtifacts({ orgId: "default", q: "context instructions" })

describe("builder tool surface", () => {
  it("draft then create publishes the doc and creates the context", async () => {
    const { meta, surface } = await setupOwner("builder-tools")
    expect(surface.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["draft_manifest", "create_context_from_draft", "find", "read"]),
    )
    // Tool callers send draft fields at the top level.
    const draftTool = surface.tools.find((t) => t.name === "draft_manifest")
    expect(draftTool?.params).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        name: expect.anything(),
        manifest_md: expect.anything(),
      }),
    })
    expect(draftTool?.params).not.toHaveProperty("properties.kind")

    await surface.execute("draft_manifest", draft)
    expect(surface.card()?.draft.name).toBe("Pricing Helper")
    expect(surface.card()?.created).toBeUndefined()

    const out = (await surface.execute("create_context_from_draft", {})) as {
      ok: boolean
      context_id: string
    }
    expect(out.ok).toBe(true)
    const ctxRow = await meta.getContext(out.context_id)
    expect(ctxRow?.name).toBe("Pricing Helper")
    expect(surface.card()?.created?.context_id).toBe(out.context_id)
  })

  it("create without a draft is a plain error, not a throw", async () => {
    const { surface } = await setupOwner("builder-tools-2")
    const out = await surface.execute("create_context_from_draft", {})
    expect(out).toEqual({ error: "call draft_manifest first" })
  })

  it("a duplicate context name is a plain error result, not a throw", async () => {
    const made = await setupOwner("builder-tools-3")
    const { surface } = made
    await surface.execute("draft_manifest", draft)
    const first = (await surface.execute("create_context_from_draft", {})) as { ok: boolean }
    expect(first.ok).toBe(true)

    const surface2 = buildContextBuilderTools(made.ctx, ownerWho)
    await surface2.execute("draft_manifest", draft)
    const second = (await surface2.execute("create_context_from_draft", {})) as {
      error: string
      note: string
    }
    expect(second.error).toBe("a context with that name already exists")
    // The write-up has already been published, so the response must offer a recoverable retry.
    expect(second.note).toMatch(/nothing was lost/i)
  })

  // Builder writes use the same seat check as the REST create route. The read-only tools retain
  // their own authorization gates.

  it("a viewer's confirmation creates nothing — and publishes nothing", async () => {
    const made = makeAuthedApp("builder-tools-seat", [owner, viewer], "viewer")
    await made.app.request("/v1/me", { headers: as(viewer.email) })
    const surface = buildContextBuilderTools(made.ctx, {
      org: "default",
      user: { id: viewer.id, name: viewer.name },
      seatRole: "viewer",
    })
    // Drafting remains available because it does not write workspace data.
    expect(await surface.execute("draft_manifest", draft)).toMatchObject({ ok: true })

    const out = (await surface.execute("create_context_from_draft", {})) as { error?: string }
    expect(out.error).toMatch(/permission to create/i)
    expect(out.error).toMatch(/Settings/)
    expect(out.error).not.toMatch(/manifest|short id|403|forbidden/i)
    // Authorization must fail before publishing the instruction artifact.
    expect(await instructionArtifacts(made.meta)).toEqual([])
  })

  it("with agent writes off nothing lands, and the draft still works", async () => {
    const made = makeAuthedApp("builder-tools-kill", [owner])
    await made.app.request("/v1/me", { headers: as(owner.email) })
    const surface = buildContextBuilderTools(made.ctx, {
      org: "default",
      user: { id: owner.id, name: owner.name },
      seatRole: "owner",
      flags: { agentWrites: false },
    })
    expect(await surface.execute("draft_manifest", draft)).toMatchObject({ ok: true })

    const out = (await surface.execute("create_context_from_draft", {})) as { error?: string }
    expect(out.error).toMatch(/paused/i)
    expect(out.error).not.toMatch(/manifest|short id|killswitch|agentWrites/i)
    expect(await instructionArtifacts(made.meta)).toEqual([])
  })

  it("a retry wires up the document it already published instead of a second copy", async () => {
    const made = await setupOwner("builder-tools-retry")
    // Reserve the name so the next create fails after publishing its instruction artifact.
    const taken = buildContextBuilderTools(made.ctx, ownerWho)
    await taken.execute("draft_manifest", draft)
    await taken.execute("create_context_from_draft", {})

    const surface = buildContextBuilderTools(made.ctx, ownerWho)
    await surface.execute("draft_manifest", draft)
    expect(await surface.execute("create_context_from_draft", {})).toMatchObject({
      error: "a context with that name already exists",
    })
    const afterFirst = await instructionArtifacts(made.meta)
    // Persist the artifact id so a retry does not publish another copy.
    expect(surface.card()?.published_artifact_id).toBeTruthy()

    await surface.execute("create_context_from_draft", {})
    const afterRetry = await instructionArtifacts(made.meta)
    expect(afterRetry.map((a) => a.id)).toEqual(afterFirst.map((a) => a.id))
  })

  it("a revision publishes its own document — the remembered one is not this text", async () => {
    const made = await setupOwner("builder-tools-revise")
    const taken = buildContextBuilderTools(made.ctx, ownerWho)
    await taken.execute("draft_manifest", draft)
    await taken.execute("create_context_from_draft", {})

    const surface = buildContextBuilderTools(made.ctx, ownerWho)
    await surface.execute("draft_manifest", draft)
    await surface.execute("create_context_from_draft", {})
    const firstDoc = surface.card()?.published_artifact_id
    // A renamed draft must not reuse an instruction artifact written for the old name.
    await surface.execute("draft_manifest", { ...draft, name: "Pricing Guide" })
    expect(surface.card()?.published_artifact_id).toBeUndefined()
    const out = (await surface.execute("create_context_from_draft", {})) as { context_id: string }
    const made2 = await made.meta.getContext(out.context_id)
    expect(made2?.name).toBe("Pricing Guide")
    expect(made2?.manifest_artifact_id).not.toBe(firstDoc)
    expect((await instructionArtifacts(made.meta)).map((a) => a.id)).toContain(firstDoc)
  })

  it("seeds from the stored card, so a confirmation next turn needs no re-draft", async () => {
    const made = await setupOwner("builder-tools-seed")
    const first = made.surface
    await first.execute("draft_manifest", draft)
    const stored = first.card() as StoredBuilderCard

    // Each turn builds a new tool surface from the previous turn's stored card.
    const next = buildContextBuilderTools(made.ctx, ownerWho, stored)
    const out = (await next.execute("create_context_from_draft", {})) as { context_id: string }
    expect((await made.meta.getContext(out.context_id))?.name).toBe("Pricing Helper")
  })
})

// Exercise draft persistence and public projection through the real chat loop.
describe("builder session", () => {
  const owner = { id: "u-ow", email: "ow@x.com", name: "Ow" }
  const MANIFEST = "# Pricing Helper\n\nAnswer from the pricing page only."
  const draftArgs = {
    name: "Pricing Helper",
    description: "Answers pricing questions",
    knows: ["Pricing page"],
    answers: "Short",
    wont: ["Legal advice"],
    manifest_md: MANIFEST,
    source_short_ids: [],
  }

  type Made = ReturnType<typeof makeAuthedApp>

  const scripted = () => {
    let call = 0
    return async (): Promise<ModelTurn> => {
      call++
      if (call === 1)
        return {
          text: "",
          costUsd: null,
          done: false,
          toolUses: [{ id: "t1", name: "draft_manifest", input: draftArgs }],
        }
      return { text: "Here's the plan — look right?", toolUses: [], costUsd: null, done: true }
    }
  }

  const setup = async (name: string, model: () => Promise<ModelTurn>): Promise<Made> => {
    const made = makeAuthedApp(name, [owner], undefined, {
      deps: {
        callModel: model,
        models: catalogOf([{ id: "model-a", label: "A", isDefault: true, build: () => model }]),
      },
    })
    await made.app.request("/v1/me", { headers: as(owner.email) })
    await made.meta.setOrgSettings("default", {
      ...(await made.meta.getOrgSettings("default")),
      chatBeta: true,
    })
    return made
  }

  const openBuilder = (app: Made["app"], email: string, body = "A helper for pricing docs") =>
    app.request("/v1/chat-session", {
      method: "POST",
      headers: { ...as(email), "content-type": "application/json" },
      body: JSON.stringify({ workspace: "default", body_md: body, purpose: "context_builder" }),
    })

  const waitForAgents = async (meta: Made["meta"], sessionId: string, count: number) => {
    let agents = (await meta.listSessionMessages(sessionId)).filter(
      (message) => message.author_kind === "agent",
    )
    for (let i = 0; i < 100 && agents.length < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      agents = (await meta.listSessionMessages(sessionId)).filter(
        (message) => message.author_kind === "agent",
      )
    }
    return agents
  }

  it("stores the complete draft but exposes only the public card", async () => {
    const { app, meta } = await setup("builder-ses", scripted())
    const response = await openBuilder(app, owner.email)
    expect(response.status).toBe(201)
    const { session } = (await response.json()) as { session: { id: string } }
    const [agent] = await waitForAgents(meta, session.id, 1)

    const stored = JSON.parse(agent?.meta ?? "{}")
    expect(stored.card?.draft).toMatchObject({ name: "Pricing Helper", manifest_md: MANIFEST })

    const read = await app.request(`/v1/sessions/${session.id}`, { headers: as(owner.email) })
    const payload = await read.text()
    expect(payload).toContain("Pricing Helper")
    expect(payload).not.toContain("Answer from the pricing page only")
    expect(payload).not.toContain("published_artifact_id")
  })

  it("creates on a later turn from the exact approved draft", async () => {
    let call = 0
    const model = async (): Promise<ModelTurn> => {
      call++
      if (call === 1)
        return {
          text: "",
          costUsd: null,
          done: false,
          toolUses: [{ id: "t1", name: "draft_manifest", input: draftArgs }],
        }
      if (call === 3)
        return {
          text: "",
          costUsd: null,
          done: false,
          toolUses: [{ id: "t2", name: "create_context_from_draft", input: {} }],
        }
      return { text: "Done — it is ready.", toolUses: [], costUsd: null, done: true }
    }
    const { app, meta, ctx } = await setup("builder-ses-two-turn", model)
    const opened = await openBuilder(app, owner.email)
    const { session } = (await opened.json()) as { session: { id: string } }
    expect(await waitForAgents(meta, session.id, 1)).toHaveLength(1)

    const followed = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "Yes, create it" }),
    })
    expect(followed.status).toBe(201)
    const agents = await waitForAgents(meta, session.id, 2)
    const card = JSON.parse(agents[1]?.meta ?? "{}").card as {
      created: { context_id: string }
      published_artifact_id: string
    }
    expect(await meta.getContext(card.created.context_id)).toMatchObject({
      name: "Pricing Helper",
    })

    const artifact = await meta.getArtifactById(card.published_artifact_id)
    const version = artifact ? await meta.getVersion(artifact.id, artifact.current_version) : null
    expect(version ? await ctx.sourceText(version) : null).toBe(
      '<!-- This document is the instruction set for the "Pricing Helper" Context in Derive.\n' +
        "     An agent reads this to learn what it knows and how it should answer.\n" +
        "     Edit it like any document; agents using this Context read the newest version. -->\n\n" +
        MANIFEST,
    )
  })
})
