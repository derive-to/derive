import { describe, expect, it } from "vitest"
import type { ModelTurn } from "../src/lib/agent-loop"
import { catalogOf } from "../src/lib/model-catalog"
import { as, makeAuthedApp } from "./helpers"

const owner = { id: "u-ow", email: "ow@x.com", name: "Ow" }
const viewer = { id: "u-vi", email: "vi@x.com", name: "Vi" }
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

/** A model scripted turn-by-turn: first call draft_manifest, then prose. Shape is
 *  AgentLoopInput["callModel"]'s real contract (agent-loop.ts's `ModelTurn`) — the same one
 *  chat-workspace.test.ts's scripted models return. */
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

describe("builder session", () => {
  it("creates a builder session and the reply carries the card", async () => {
    const model = scripted()
    const { app, meta } = makeAuthedApp("builder-ses", [owner], undefined, {
      deps: {
        callModel: model,
        models: catalogOf([{ id: "model-a", label: "A", isDefault: true, build: () => model }]),
      },
    })
    await app.request("/v1/me", { headers: as(owner.email) })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
    })

    const res = await app.request("/v1/context-builder-session", {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ workspace: "default", body_md: "A helper for pricing docs" }),
    })
    expect(res.status).toBe(201)
    const { session } = (await res.json()) as { session: { id: string } }

    // Attended serve runs in ctx.background; poll the store until an agent message lands.
    let msgs = await meta.listSessionMessages(session.id)
    for (let i = 0; i < 50 && !msgs.some((m) => m.author_kind === "agent"); i++) {
      await new Promise((r) => setTimeout(r, 50))
      msgs = await meta.listSessionMessages(session.id)
    }
    const agent = msgs.find((m) => m.author_kind === "agent")
    expect(agent).toBeTruthy()
    const stored = JSON.parse(agent?.meta ?? "{}")
    expect(stored.card?.draft?.name).toBe("Pricing Helper")
    // The ROW keeps the manifest source — that is what the next turn creates from, instead of
    // asking the model to write it again (see StoredBuilderCard).
    expect(stored.card?.draft?.manifest_md).toBe(MANIFEST)

    // …and the CLIENT never sees it. Same message, read the way the surface reads it.
    const got = await app.request(`/v1/sessions/${session.id}`, { headers: as(owner.email) })
    const body = (await got.json()) as {
      messages: { author_kind: string; meta?: { card?: { draft?: Record<string, unknown> } } }[]
    }
    const wire = body.messages.find((m) => m.author_kind === "agent")
    expect(wire?.meta?.card?.draft?.name).toBe("Pricing Helper")
    expect(wire?.meta?.card?.draft?.manifest_md).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("Answer from the pricing page only")
  })

  it("without chatBeta the route refuses like chat does", async () => {
    const { app, meta } = makeAuthedApp("builder-ses-off", [owner], undefined, {
      deps: { callModel: scripted() },
    })
    await app.request("/v1/me", { headers: as(owner.email) })
    // Chat is on by default now (see chat-attended.test.ts), so the case worth gating is a
    // workspace that has explicitly opted OUT — the same deliberate act chatArrival gates on
    // for every other chat surface.
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: false,
    })
    const res = await app.request("/v1/context-builder-session", {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ workspace: "default", body_md: "hi" }),
    })
    expect(res.status).toBe(404) // not_enabled maps to 404, same as /v1/chat-session
  })

  // The spec's promise: "the conversation checks this up front and says so plainly instead of
  // failing at the end". The chat gates admit every member, and a member may be a viewer — who
  // can hold the whole interview and only then discover they were never allowed to finish it.
  it("a seat that cannot create is refused before the first question, in plain words", async () => {
    const model = scripted()
    const { app, meta } = makeAuthedApp("builder-ses-seat", [owner, viewer], "viewer", {
      deps: {
        callModel: model,
        models: catalogOf([{ id: "model-a", label: "A", isDefault: true, build: () => model }]),
      },
    })
    await app.request("/v1/me", { headers: as(viewer.email) })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
    })
    const body = JSON.stringify({ workspace: "default", body_md: "A helper for pricing docs" })

    const refused = await app.request("/v1/context-builder-session", {
      method: "POST",
      headers: { ...as(viewer.email), "content-type": "application/json" },
      body,
    })
    expect(refused.status).toBe(403)
    const said = ((await refused.json()) as { error: string }).error
    expect(said).toMatch(/permission to create/i)
    expect(said).toMatch(/Settings/) // names the fix
    expect(said).not.toMatch(/manifest|short id|role|forbidden/i)

    // The same request from a seat that CAN create opens the conversation, so this is a gate on
    // standing rather than the route having quietly stopped working.
    const ok = await app.request("/v1/context-builder-session", {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body,
    })
    expect(ok.status).toBe(201)
  })

  // THE ORDINARY RHYTHM: draft on one turn, "yes, do it" on the next. The surface is rebuilt per
  // turn, so without the draft persisting the model would have to write the manifest again from
  // memory — and the created context could differ from the card the person actually approved.
  it("confirms on the NEXT turn, and creates from the very text that was approved", async () => {
    let call = 0
    const model = async (): Promise<ModelTurn> => {
      call++
      // Turn one: draft, then say so. Turn two: create, with NO new draft call.
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
    const { app, meta, ctx } = makeAuthedApp("builder-ses-two-turn", [owner], undefined, {
      deps: {
        callModel: model,
        models: catalogOf([{ id: "model-a", label: "A", isDefault: true, build: () => model }]),
      },
    })
    await app.request("/v1/me", { headers: as(owner.email) })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
    })

    const opened = await app.request("/v1/context-builder-session", {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ workspace: "default", body_md: "A helper for pricing docs" }),
    })
    expect(opened.status).toBe(201)
    const { session } = (await opened.json()) as { session: { id: string } }
    const settled = async (n: number) => {
      let msgs = await meta.listSessionMessages(session.id)
      for (let i = 0; i < 100 && msgs.filter((m) => m.author_kind === "agent").length < n; i++) {
        await new Promise((r) => setTimeout(r, 50))
        msgs = await meta.listSessionMessages(session.id)
      }
      return msgs.filter((m) => m.author_kind === "agent")
    }
    expect(await settled(1)).toHaveLength(1)

    // Turn two is nothing but a confirmation — the model never re-drafts.
    const followed = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "Yes, create it" }),
    })
    expect(followed.status).toBe(201)
    const agents = await settled(2)
    expect(agents).toHaveLength(2)

    const card = JSON.parse(agents[1]?.meta ?? "{}").card as {
      created?: { context_id: string }
      published_artifact_id?: string
    }
    expect(card?.created?.context_id).toBeTruthy()
    expect(await meta.getContext(card.created?.context_id ?? "")).toMatchObject({
      name: "Pricing Helper",
    })

    // THE DOCUMENT IS THE ONE THEY APPROVED, byte for byte: the header explaining what the file
    // is, then turn one's text verbatim — not a paraphrase the model produced a second time.
    const docs = await meta.listArtifacts({ orgId: "default", q: "context instructions" })
    expect(docs).toHaveLength(1)
    const doc = docs[0]
    expect(doc?.id).toBe(card.published_artifact_id)
    const version = doc ? await meta.getVersion(doc.id, doc.current_version) : null
    const text = version ? await ctx.sourceText(version) : null
    expect(text).toBe(
      '<!-- This document is the instruction set for the "Pricing Helper" context in Derive.\n' +
        "     Agents read it to learn what the context knows and how it should answer.\n" +
        "     Edit it like any document; the context uses the newest version. -->\n\n" +
        MANIFEST,
    )

    // And none of that reaches the client — the transcript the surface reads carries the card,
    // never the source behind it.
    const got = await app.request(`/v1/sessions/${session.id}`, { headers: as(owner.email) })
    const payload = await got.text()
    expect(payload).toContain("Pricing Helper")
    expect(payload).not.toContain("Answer from the pricing page only")
    expect(payload).not.toContain("published_artifact_id")
  })
})
