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
  kind: "knowledge" as const,
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
    // The schema a model is shown must be the FLAT draft shape, not wrapped under some
    // extra key — a tool call built from a nested schema would fail draft_manifest's own
    // validation, which expects the draft fields at the top level (as the test below sends
    // them).
    const draftTool = surface.tools.find((t) => t.name === "draft_manifest")
    expect(draftTool?.params).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        name: expect.anything(),
        manifest_md: expect.anything(),
      }),
    })

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

    // Same draft (same name) again in a fresh surface sharing the same workspace.
    const surface2 = buildContextBuilderTools(made.ctx, ownerWho)
    await surface2.execute("draft_manifest", draft)
    const second = (await surface2.execute("create_context_from_draft", {})) as {
      error: string
      note: string
    }
    expect(second.error).toBe("a context with that name already exists")
    // …and the person is told their work is safe, because it is: the write-up was already
    // published, so a different name finishes the job rather than restarting the interview.
    expect(second.note).toMatch(/nothing was lost/i)
  })

  // ── WHO MAY ACTUALLY CREATE ──────────────────────────────────────────────────────────────
  //
  // `find` and `read` come from buildChatTools, so their gates are the real tools'. These two
  // are local to the turn and had none — the chat gates admit every MEMBER, including a viewer,
  // and "create a context" is three privileged writes (publish a document, insert a context,
  // mint a managed agent). So the seat is checked here, against the same predicate the REST
  // create route uses.

  it("a viewer's confirmation creates nothing — and publishes nothing", async () => {
    const made = makeAuthedApp("builder-tools-seat", [owner, viewer], "viewer")
    await made.app.request("/v1/me", { headers: as(viewer.email) })
    const surface = buildContextBuilderTools(made.ctx, {
      org: "default",
      user: { id: viewer.id, name: viewer.name },
      seatRole: "viewer",
    })
    // Drafting is fine — it writes nothing, and refusing it would make the refusal arrive at
    // the end of the interview, which is the failure this whole flow exists to avoid.
    expect(await surface.execute("draft_manifest", draft)).toMatchObject({ ok: true })

    const out = (await surface.execute("create_context_from_draft", {})) as { error?: string }
    expect(out.error).toMatch(/permission to create/i)
    // Plain language a model can relay, naming the fix — not a role name or a status code.
    expect(out.error).toMatch(/Settings/)
    expect(out.error).not.toMatch(/manifest|short id|403|forbidden/i)
    // REFUSED BEFORE THE PUBLISH, which is the part that matters: a refusal that fires after
    // the document is written leaves an orphan behind every time somebody tries.
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
    // Take the name first, so the create below fails AFTER the document is published.
    const taken = buildContextBuilderTools(made.ctx, ownerWho)
    await taken.execute("draft_manifest", draft)
    await taken.execute("create_context_from_draft", {})

    const surface = buildContextBuilderTools(made.ctx, ownerWho)
    await surface.execute("draft_manifest", draft)
    expect(await surface.execute("create_context_from_draft", {})).toMatchObject({
      error: "a context with that name already exists",
    })
    const afterFirst = await instructionArtifacts(made.meta)
    // The failed attempt's document is REMEMBERED on the card, so the transcript can hand it to
    // the next attempt rather than leaving it orphaned.
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
    await surface.execute("create_context_from_draft", {}) // collides, publishes + remembers
    const firstDoc = surface.card()?.published_artifact_id
    // They pick a different name. That is a different document, so the remembered one is
    // dropped rather than wired up under a name it does not describe.
    await surface.execute("draft_manifest", { ...draft, name: "Pricing Guide" })
    expect(surface.card()?.published_artifact_id).toBeUndefined()
    const out = (await surface.execute("create_context_from_draft", {})) as { context_id: string }
    const made2 = await made.meta.getContext(out.context_id)
    expect(made2?.name).toBe("Pricing Guide")
    // Wired to a document of ITS OWN, not to the one written for the name they abandoned.
    expect(made2?.manifest_artifact_id).not.toBe(firstDoc)
    expect((await instructionArtifacts(made.meta)).map((a) => a.id)).toContain(firstDoc)
  })

  // ── THE DRAFT OUTLIVING ITS TURN ─────────────────────────────────────────────────────────

  it("seeds from the stored card, so a confirmation next turn needs no re-draft", async () => {
    const made = await setupOwner("builder-tools-seed")
    const first = made.surface
    await first.execute("draft_manifest", draft)
    const stored = first.card() as StoredBuilderCard

    // A NEW surface, as the next turn builds one — and no draft_manifest call on it at all.
    const next = buildContextBuilderTools(made.ctx, ownerWho, stored)
    const out = (await next.execute("create_context_from_draft", {})) as { context_id: string }
    expect((await made.meta.getContext(out.context_id))?.name).toBe("Pricing Helper")
  })
})

// The builder end to end: a chat session opened with purpose "context_builder" drives the
// same tool surface through the real agent loop, so the card the model writes is stored
// whole but read back stripped, and a confirmation on a later turn creates from the exact
// approved draft.
describe("builder session", () => {
  const owner = { id: "u-ow", email: "ow@x.com", name: "Ow" }
  const MANIFEST = "# Pricing Helper\n\nAnswer from the pricing page only."
  const draftArgs = {
    name: "Pricing Helper",
    description: "Answers pricing questions",
    kind: "knowledge",
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
