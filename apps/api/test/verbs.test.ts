import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WO5 — owner-authored actions on an artifact. Viewers INVOKE verbs; they never type
// instructions. Params ride as data; the run bills to the owner and starts propose-gated.
describe("verbs (owner-authored actions)", () => {
  const owner: TestUser = { id: "u_verb_own", email: "verbown@derive.test", name: "Owner" }
  const editor: TestUser = { id: "u_verb_ed", email: "verbed@derive.test", name: "Editor" }
  const { app } = makeAuthedApp("verbs", [owner, editor], "editor")

  let n = 0
  const mintAgent = async (who = owner.email) => {
    n += 1
    return (await (
      await app.request("/v1/agents", jsonAs(as(who), { name: `Runner ${n}` }))
    ).json()) as { id: string }
  }
  const makeArtifact = async (who = owner.email) => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("# Doc")]), "doc.md")
    const res = await app.request("/v1/artifacts", { method: "POST", body: form, headers: as(who) })
    return (await res.json()) as { id: string; short_id: string }
  }
  const createVerb = (shortId: string, agentId: string, over: object = {}, who = owner.email) =>
    app.request(
      `/v1/artifacts/${shortId}/verbs`,
      jsonAs(as(who), {
        name: "Send to board",
        instruction: "Compose and email the digest.",
        agentId,
        ...over,
      }),
    )
  const ledger = async () =>
    (
      (await (await app.request("/v1/workspace/runs", { headers: as(owner.email) })).json()) as {
        runs: { id: string; reason: string; meta: string | null }[]
      }
    ).runs

  it("owner authors a verb; it defaults to propose-gated, members-audience", async () => {
    const agent = await mintAgent()
    const art = await makeArtifact()
    const res = await createVerb(art.short_id, agent.id)
    expect(res.status).toBe(201)
    const v = await res.json()
    expect(v).toMatchObject({
      name: "Send to board",
      gate: "propose",
      audience: "members",
      enabled: true,
      created_by: owner.id,
    })
  })

  it("invoking a members verb enqueues a run billed to the owner, with params as data", async () => {
    const agent = await mintAgent()
    const art = await makeArtifact()
    const v = await (await createVerb(art.short_id, agent.id)).json()
    // A non-owner member (editor) may invoke a members-audience verb.
    const res = await app.request(
      `/v1/verbs/${v.id}/invoke`,
      jsonAs(as(editor.email), { params: { note: "for the July board" } }),
    )
    expect(res.status).toBe(201)
    const out = await res.json()
    const row = (await ledger()).find((r) => r.id === out.id)
    expect(row?.reason).toBe(`verb:${v.id}:user:${editor.id}`)
    const meta = JSON.parse(row?.meta ?? "{}")
    expect(meta.owner).toBe(owner.id)
    expect(meta.params).toEqual({ note: "for the July board" })
    expect(meta.targets[0]).toMatchObject({ kind: "artifact", mode: "propose" })
  })

  it("params are data: a non-primitive param is rejected", async () => {
    const agent = await mintAgent()
    const art = await makeArtifact()
    const v = await (await createVerb(art.short_id, agent.id)).json()
    const res = await app.request(
      `/v1/verbs/${v.id}/invoke`,
      jsonAs(as(owner.email), { params: { nested: { evil: true } } }),
    )
    expect(res.status).toBe(400)
  })

  it("an owner-audience verb refuses a non-owner invoker", async () => {
    const agent = await mintAgent()
    const art = await makeArtifact()
    const v = await (await createVerb(art.short_id, agent.id, { audience: "owner" })).json()
    const denied = await app.request(
      `/v1/verbs/${v.id}/invoke`,
      jsonAs(as(editor.email), { params: {} }),
    )
    expect(denied.status).toBe(403)
    // The owner can invoke it.
    const ok = await app.request(
      `/v1/verbs/${v.id}/invoke`,
      jsonAs(as(owner.email), { params: {} }),
    )
    expect(ok.status).toBe(201)
  })

  it("promoting a verb to publish-direct is the owner's call alone", async () => {
    const agent = await mintAgent()
    const art = await makeArtifact()
    const v = await (await createVerb(art.short_id, agent.id)).json()
    // Editor (publisher, not the owner) can't promote it.
    const denied = await app.request(`/v1/verbs/${v.id}`, {
      ...jsonAs(as(editor.email), { gate: "direct" }),
      method: "PATCH",
    })
    expect(denied.status).toBe(403)
    // The owner can.
    const ok = await app.request(`/v1/verbs/${v.id}`, {
      ...jsonAs(as(owner.email), { gate: "direct" }),
      method: "PATCH",
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()).gate).toBe("direct")
    // Now a direct-gated verb's run targets publish, not propose.
    const out = await (
      await app.request(`/v1/verbs/${v.id}/invoke`, jsonAs(as(owner.email), { params: {} }))
    ).json()
    const row = (await ledger()).find((r) => r.id === out.id)
    expect(JSON.parse(row?.meta ?? "{}").targets[0].mode).toBe("publish")
  })
})
