import { describe, expect, it } from "vitest"
import { app, upload } from "./helpers"

// Tags as the findability layer: set them at publish time, filter the library by them, and
// ask for suggestions. The embedded SQLite test backend has NO dense arm, so suggestions
// here exercise the vocabulary-only fallback (current + vocabulary, empty neighbor list) —
// the semantic-neighbor path is covered by the shared computeTagSuggestions logic against a
// real embedder in deployed envs.

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

describe("tag-suggestions", () => {
  it("returns current tags + the workspace vocabulary (neighbor path is a no-op without a dense arm)", async () => {
    await (await upload("s1.md", "x", { title: "Neighbor", tags: "roadmap" })).json()
    const { short_id } = await (
      await upload("s2.md", "x", { title: "Subject", tags: "draft" })
    ).json()

    const res = await app.request(`/v1/artifacts/${short_id}/tag-suggestions`)
    expect(res.status).toBe(200)
    const s = (await res.json()) as {
      current: string[]
      suggested: { tag: string }[]
      vocabulary: { tag: string; count: number }[]
    }
    expect(s.current).toEqual(["draft"])
    // No dense arm in the SQLite test backend → no neighbor suggestions, but the vocabulary
    // (which includes tags from the whole workspace) still answers.
    expect(s.suggested).toEqual([])
    expect(s.vocabulary.map((t) => t.tag)).toContain("roadmap")
  })
})
