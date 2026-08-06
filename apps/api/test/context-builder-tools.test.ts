import { describe, expect, it } from "vitest"
import { buildContextBuilderTools } from "../src/lib/context-builder-tools"
import { as, makeAuthedApp } from "./helpers"

const owner = { id: "u-b", email: "b@x.com", name: "B" }
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

describe("builder tool surface", () => {
  it("draft then create publishes the doc and creates the context", async () => {
    const made = makeAuthedApp("builder-tools", [owner])
    await made.app.request("/v1/me", { headers: as(owner.email) })
    const { ctx: appCtx, meta } = made
    const surface = buildContextBuilderTools(appCtx, {
      org: "default",
      user: { id: owner.id, name: owner.name },
      seatRole: "owner",
    })
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
    const made = makeAuthedApp("builder-tools-2", [owner])
    await made.app.request("/v1/me", { headers: as(owner.email) })
    const surface = buildContextBuilderTools(made.ctx, {
      org: "default",
      user: { id: owner.id, name: owner.name },
      seatRole: "owner",
    })
    const out = await surface.execute("create_context_from_draft", {})
    expect(out).toEqual({ error: "call draft_manifest first" })
  })

  it("a duplicate context name is a plain error result, not a throw", async () => {
    const made = makeAuthedApp("builder-tools-3", [owner])
    await made.app.request("/v1/me", { headers: as(owner.email) })
    const surface = buildContextBuilderTools(made.ctx, {
      org: "default",
      user: { id: owner.id, name: owner.name },
      seatRole: "owner",
    })
    await surface.execute("draft_manifest", draft)
    const first = (await surface.execute("create_context_from_draft", {})) as { ok: boolean }
    expect(first.ok).toBe(true)

    // Same draft (same name) again in a fresh surface sharing the same workspace.
    const surface2 = buildContextBuilderTools(made.ctx, {
      org: "default",
      user: { id: owner.id, name: owner.name },
      seatRole: "owner",
    })
    await surface2.execute("draft_manifest", draft)
    const second = await surface2.execute("create_context_from_draft", {})
    expect(second).toEqual({ error: "a context with that name already exists" })
  })
})
