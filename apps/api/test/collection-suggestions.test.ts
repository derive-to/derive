import type { SearchIndex } from "@derive/core"
import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs, type TestUser, app as tokenApp, upload } from "./helpers"

// GET /v1/artifacts/{shortId}/collection-suggestions — the picker's semantic tier.
// The dense index nominates neighbor ARTIFACTS with no access knowledge; these tests
// pin what the route layers on top: vote aggregation into collections, the members-only
// rule, and the per-collection role gate (an invite-only collection a neighbor lives in
// must not surface for a non-member).

const ana: TestUser = { id: "u_sug_ana", email: "ana@sug.test", name: "Ana", username: "anasug" }
const ben: TestUser = { id: "u_sug_ben", email: "ben@sug.test", name: "Ben", username: "bensug" }

/** A SearchIndex whose `similar` answers from a mutable map (internal artifact ids are
 *  only known after publishing, so tests fill it in as they go). */
const fakeSearch = (neighbors: Record<string, { id: string; score: number }[]>): SearchIndex => ({
  indexArtifact: async () => {},
  indexArtifacts: async () => {},
  unindexArtifact: async () => {},
  search: async () => [],
  similar: async (_orgId, artifactId) =>
    (neighbors[artifactId] ?? []).map((n) => ({ ...n, chunk: "" })),
})

describe("collection suggestions", () => {
  it("aggregates neighbor votes per collection and hides invite-only collections from non-members", async () => {
    const neighbors: Record<string, { id: string; score: number }[]> = {}
    const { app, meta } = makeAuthedApp("colsug", [ana, ben], "editor", {
      deps: { search: fakeSearch(neighbors) },
    })
    const A = as(ana.email)
    const B = as(ben.email)
    const json = { "content-type": "application/json" }

    const publish = async (title: string, headers: Record<string, string>) => {
      const r = await (await publishAs(app, `${title} body`, { title }, headers)).json()
      const art = await meta.getByShortId(r.short_id)
      if (!art) throw new Error(`missing ${title}`)
      return { shortId: r.short_id as string, id: art.id }
    }
    const target = await publish("Target", A)
    const n1 = await publish("Close neighbor", A)
    const n2 = await publish("Mid neighbor", A)
    const n3 = await publish("Far neighbor", A)

    const collection = async (title: string, headers: Record<string, string>) =>
      (await (
        await app.request("/v1/collections", {
          method: "POST",
          headers: { ...json, ...headers },
          body: JSON.stringify({ title }),
        })
      ).json()) as { id: string }
    const add = (colId: string, shortId: string, headers: Record<string, string>) =>
      app.request(`/v1/collections/${colId}/items/${shortId}`, {
        method: "PUT",
        headers: { ...json, ...headers },
      })

    // Ana's workspace-open collections: X holds the closest neighbor, Y holds the two
    // mid ones — Y must outrank X on summed votes (0.6 + 0.5 > 0.9).
    const colX = await collection("X", A)
    const colY = await collection("Y", A)
    await add(colX.id, n1.shortId, A)
    await add(colY.id, n2.shortId, A)
    await add(colY.id, n3.shortId, A)
    // Ben's INVITE-ONLY collection also holds the closest neighbor. It must surface
    // for Ben (creator = owner) and stay invisible to Ana (no role).
    const colZ = await collection("Z", B)
    expect(
      (
        await app.request(`/v1/collections/${colZ.id}/access`, {
          method: "PATCH",
          headers: { ...json, ...B },
          body: JSON.stringify({ workspaceAccess: "none" }),
        })
      ).status,
    ).toBe(200)
    await add(colZ.id, n1.shortId, B)

    neighbors[target.id] = [
      { id: n1.id, score: 0.9 },
      { id: n2.id, score: 0.6 },
      { id: n3.id, score: 0.5 },
    ]

    const suggestionsFor = async (headers: Record<string, string>) =>
      (
        (await (
          await app.request(`/v1/artifacts/${target.shortId}/collection-suggestions`, { headers })
        ).json()) as { suggestions: { id: string; score: number }[] }
      ).suggestions

    const anas = await suggestionsFor(A)
    expect(anas.map((s) => s.id)).toEqual([colY.id, colX.id])
    expect(anas[0]?.score).toBeCloseTo(1.1)

    // Ben additionally sees his invite-only Z. X and Z tie at 0.9 and collection ids
    // are random here, so pin Y first and compare the rest as a set.
    const bens = await suggestionsFor(B)
    expect(bens.map((s) => s.id).sort()).toEqual([colX.id, colY.id, colZ.id].sort())
    expect(bens[0]?.id).toBe(colY.id)
  })

  it("answers [] when no dense arm is bound, and 404s an unreadable artifact", async () => {
    // The shared token app binds no SearchIndex — the endpoint degrades, never errors.
    const { short_id } = await (await upload("sug-none.md", "x", { title: "No arm" })).json()
    const res = await (
      await tokenApp.request(`/v1/artifacts/${short_id}/collection-suggestions`)
    ).json()
    expect(res.suggestions).toEqual([])

    expect((await tokenApp.request("/v1/artifacts/zzzzzzzz/collection-suggestions")).status).toBe(
      404,
    )
  })
})
