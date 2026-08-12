import { describe, expect, it } from "vitest"
import { cardForWire } from "../src/lib/context-builder-card"
import {
  buildContextBuilderTools,
  latestBuilderCard,
  type StoredBuilderCard,
} from "../src/lib/context-builder-tools"
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

  it("persists template lineage on the Context's instruction artifact", async () => {
    const made = await setupOwner("builder-tools-template-lineage")
    const surface = buildContextBuilderTools(made.ctx, ownerWho, null, {
      uri: "derive://template-libraries/tlb_context/tpl_context",
      title: "Research workflow",
      kind: "context",
      sourceArtifactId: "art_context_template_source",
    })
    await surface.execute("draft_manifest", draft)
    const out = (await surface.execute("create_context_from_draft", {})) as {
      context_id: string
    }
    const context = await made.meta.getContext(out.context_id)
    if (!context) throw new Error("missing context")
    const manifest = await made.meta.getArtifactById(context.manifest_artifact_id)
    expect(manifest?.derived_from).toBe("art_context_template_source")
    const version = manifest
      ? await made.meta.getVersion(manifest.id, manifest.current_version)
      : null
    const source = version ? await made.ctx.sourceText(version) : null
    expect(source).toContain(
      "Adapted from derive://template-libraries/tlb_context/tpl_context; the original remains unchanged.",
    )
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

  it("under the killswitch nothing lands, and the draft still works", async () => {
    const made = makeAuthedApp("builder-tools-kill", [owner])
    await made.app.request("/v1/me", { headers: as(owner.email) })
    const surface = buildContextBuilderTools(made.ctx, {
      org: "default",
      user: { id: owner.id, name: owner.name },
      seatRole: "owner",
      flags: { agentKillswitch: true },
    })
    expect(await surface.execute("draft_manifest", draft)).toMatchObject({ ok: true })

    const out = (await surface.execute("create_context_from_draft", {})) as { error?: string }
    expect(out.error).toMatch(/paused/i)
    expect(out.error).not.toMatch(/manifest|short id|killswitch/i)
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

  it("reads the NEWEST card off a transcript, and ignores one with nothing to build from", () => {
    const row = (id: string, meta: unknown, kind: "agent" | "asker" = "agent") =>
      ({
        id,
        session_id: "ses_1",
        author_kind: kind,
        author_id: "u-b",
        body_md: "…",
        meta: meta === null ? null : JSON.stringify(meta),
        created_at: new Date().toISOString(),
      }) as Parameters<typeof latestBuilderCard>[0][number]

    const carded = (name: string) => ({ card: { draft: { ...draft, name } } })
    expect(
      latestBuilderCard([
        row("1", carded("First")),
        row("2", null),
        row("3", carded("Second")),
        // An ASKER row can never carry a card, and a stripped one is not a draft: neither may
        // win over the real newest.
        row("4", carded("Impostor"), "asker"),
        row("5", { card: { draft: { ...draft, manifest_md: undefined } } }),
        // Meta that is not JSON at all: a hand-edited row must not take the turn down with it.
        { ...row("6", null), meta: "{not json" },
      ])?.draft.name,
    ).toBe("Second")
    expect(latestBuilderCard([])).toBeNull()
  })

  it("the wire view drops the manifest source and the internal pointer", () => {
    const stored: StoredBuilderCard = {
      draft,
      published_artifact_id: "art_1",
      created: { context_id: "ctx_1", name: "Pricing Helper" },
    }
    const wire = cardForWire(stored) as Record<string, unknown>
    expect(wire.published_artifact_id).toBeUndefined()
    expect((wire.draft as Record<string, unknown>).manifest_md).toBeUndefined()
    // Everything a person sees survives, unchanged.
    expect(wire.draft).toMatchObject({ name: "Pricing Helper", knows: draft.knows })
    expect(wire.created).toEqual({ context_id: "ctx_1", name: "Pricing Helper" })
    // Unexpected shapes fail closed rather than leaking unknown stored fields.
    expect(cardForWire(null)).toBeNull()
    expect(cardForWire({ draft: "nonsense" })).toBeNull()
  })
})
