import { describe, expect, it } from "vitest"
import type { ModelTurn } from "../src/lib/agent-loop"
import { catalogOf } from "../src/lib/model-catalog"
import { as, makeAuthedApp } from "./helpers"

const owner = { id: "u-ow", email: "ow@x.com", name: "Ow" }
const draftArgs = {
  name: "Pricing Helper",
  description: "Answers pricing questions",
  kind: "knowledge",
  knows: ["Pricing page"],
  answers: "Short",
  wont: ["Legal advice"],
  manifest_md: "# Pricing Helper",
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
    const meta2 = JSON.parse(agent?.meta ?? "{}")
    expect(meta2.card?.draft?.name).toBe("Pricing Helper")
    expect(meta2.card?.draft?.manifest_md).toBeUndefined() // internal, never shipped to the client
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
})
