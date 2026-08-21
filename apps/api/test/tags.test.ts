import { describe, expect, it } from "vitest"
import { app, upload } from "./helpers"

// Tags as the findability layer: set them at publish time, replace them over PUT /tags, and
// filter the library by them.

const detail = async (shortId: string) =>
  (await (await app.request(`/v1/artifacts/${shortId}`)).json()) as { tags: string[] }

describe("tags on publish", () => {
  it("sets browse tags from a JSON-array `tags` field, normalized", async () => {
    const { short_id } = await (
      await upload("p1.md", "x", { title: "Tagged", tags: JSON.stringify(["Q3 Plan", "planning"]) })
    ).json()
    // Lowercased, inner whitespace collapsed, sorted.
    expect((await detail(short_id)).tags).toEqual(["planning", "q3 plan"])
  })

  it("add_tags is ADDITIVE: unions with existing tags, never replaces — the automation stamp", async () => {
    const { short_id } = await (
      await upload("p3.md", "x", { title: "Stamped", tags: "curated" })
    ).json()
    // A republish carrying add_tags (the executor's tag-target stamp) unions in.
    await upload("p3.md", "y", { add_tags: JSON.stringify(["weekly-health", "Curated"]) }, short_id)
    expect((await detail(short_id)).tags).toEqual(["curated", "weekly-health"])
    // And a stamp on a fresh create works with no pre-existing tags.
    const fresh = await (
      await upload("p4.md", "x", { title: "Fresh", add_tags: "weekly-health" })
    ).json()
    expect((await detail(fresh.short_id)).tags).toEqual(["weekly-health"])
  })

  it("accepts a comma/space list too, and an empty field leaves a republish's tags intact", async () => {
    const { short_id } = await (
      await upload("p2.md", "x", { title: "T", tags: "alpha, beta" })
    ).json()
    expect((await detail(short_id)).tags).toEqual(["alpha", "beta"])
    // Republish WITHOUT a tags field — tags must survive (absent ≠ clear).
    await upload("p2.md", "y", {}, short_id)
    expect((await detail(short_id)).tags).toEqual(["alpha", "beta"])
    // Republish with an EMPTY tags field clears them (explicit "remove all").
    await upload("p2.md", "z", { tags: "" }, short_id)
    expect((await detail(short_id)).tags).toEqual([])
  })
})

describe("filtering + vocabulary", () => {
  it("?tag= narrows the listing, and the summary counts each tag", async () => {
    const a = await (await upload("f1.md", "x", { title: "A", tags: "shared,only-a" })).json()
    await (await upload("f2.md", "x", { title: "B", tags: "shared" })).json()

    const listed = (await (await app.request("/v1/artifacts?tag=shared")).json()) as {
      artifacts: { short_id: string }[]
    }
    expect(listed.artifacts.length).toBeGreaterThanOrEqual(2)

    const onlyA = (await (await app.request("/v1/artifacts?tag=only-a")).json()) as {
      artifacts: { short_id: string }[]
    }
    expect(onlyA.artifacts.map((x) => x.short_id)).toEqual([a.short_id])

    const summary = (await (await app.request("/v1/tags")).json()) as {
      tags: { tag: string; count: number }[]
    }
    expect(summary.tags.find((t) => t.tag === "shared")?.count).toBeGreaterThanOrEqual(2)
  })
})

describe("favorites + tags (browse)", () => {
  const putTags = (shortId: string, tags: string[]) =>
    app.request(`/v1/artifacts/${shortId}/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags }),
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
})
