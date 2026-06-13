import { describe, expect, it } from "vitest"
import { app, meta, upload } from "./helpers"

describe("favorites + tags (browse)", () => {
  const idOf = async (shortId: string) => {
    const a = await meta.getByShortId(shortId)
    if (!a) throw new Error(`no artifact ${shortId}`)
    return a.id
  }
  const putTags = (shortId: string, tags: string[]) =>
    app.request(`/v1/artifacts/${shortId}/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags }),
    })

  it("favorites are per-user at the store layer (set, idempotent, remove)", async () => {
    const { short_id } = await (await upload("fav.md", "# Fav")).json()
    const id = await idOf(short_id)
    expect(await meta.listUserFavoriteIds("u1")).not.toContain(id)
    await meta.setFavorite(id, "u1")
    await meta.setFavorite(id, "u1") // idempotent — no duplicate row
    expect(await meta.listUserFavoriteIds("u1")).toContain(id)
    expect(await meta.listUserFavoriteIds("u2")).not.toContain(id) // personal
    await meta.removeFavorite(id, "u1")
    expect(await meta.listUserFavoriteIds("u1")).not.toContain(id)
  })

  it("normalizes tags and surfaces them on list + detail", async () => {
    const { short_id } = await (await upload("t.md", "# Tagged")).json()
    const res = await putTags(short_id, ["React", "react", "  Demo  ", ""])
    expect(res.status).toBe(200)
    expect((await res.json()).tags).toEqual(["demo", "react"]) // trimmed, lowercased, deduped, sorted

    const detail = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(detail.tags).toEqual(["demo", "react"])
    expect(detail.favorite).toBe(false)

    const list = await (await app.request("/v1/artifacts")).json()
    const row = list.artifacts.find((x: { short_id: string }) => x.short_id === short_id)
    expect(row.tags).toEqual(["demo", "react"])
    expect(row).toHaveProperty("favorite")
  })

  it("replaces the full tag set (old tags drop)", async () => {
    const { short_id } = await (await upload("r.md", "# R")).json()
    await putTags(short_id, ["one", "two"])
    expect((await (await putTags(short_id, ["three"])).json()).tags).toEqual(["three"])
    const detail = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(detail.tags).toEqual(["three"])
  })

  it("batches tags across artifacts without N+1", async () => {
    const a1 = await (await upload("b1.md", "# 1")).json()
    const a2 = await (await upload("b2.md", "# 2")).json()
    await putTags(a1.short_id, ["solo"])
    const id1 = await idOf(a1.short_id)
    const id2 = await idOf(a2.short_id)
    const map = await meta.tagsForArtifacts([id1, id2])
    expect(map[id1]).toEqual(["solo"])
    expect(map[id2]).toBeUndefined() // untagged ids simply have no entry
  })
})
