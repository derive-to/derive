import type { SearchIndex } from "@derive/core"
import { describe, expect, it } from "vitest"
import { computeTagSuggestions } from "../src/lib/tag-suggestions"
import { app, meta, upload } from "./helpers"

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

  it("aggregates neighbor tags via the dense arm — ranked by frequency, current tags excluded", async () => {
    // The semantic path the SQLite endpoint can't reach: seed a subject + neighbors, then
    // drive computeTagSuggestions with a STUB SearchIndex that returns those neighbors, so
    // the real aggregation (frequency count, current-tag + sift- exclusion, ranking) runs.
    const subject = await (
      await upload("dense-subj.md", "x", { title: "Subject", tags: "draft" })
    ).json()
    const n1 = await (await upload("dense-n1.md", "x", { title: "N1", tags: "roadmap, q4" })).json()
    const n2 = await (await upload("dense-n2.md", "x", { title: "N2", tags: "roadmap" })).json()
    // "draft" here is already on the subject → must be excluded from suggestions.
    const n3 = await (await upload("dense-n3.md", "x", { title: "N3", tags: "misc, draft" })).json()

    const subjRec = await meta.getByShortId(subject.short_id)
    if (!subjRec) throw new Error("subject missing")
    const neighborIds = await Promise.all(
      [n1, n2, n3].map(async (x) => (await meta.getByShortId(x.short_id))?.id ?? ""),
    )
    // Stub the dense arm: return the neighbors (ranked), ignore the query text. Only
    // `search` is called by computeTagSuggestions; the rest are no-op to satisfy the type.
    const search: SearchIndex = {
      search: async () => neighborIds.map((id, i) => ({ id, score: 1 - i * 0.1, chunk: "" })),
      indexArtifact: async () => {},
      indexArtifacts: async () => {},
      unindexArtifact: async () => {},
    }
    const suggestions = await computeTagSuggestions(
      { meta, search, sourceText: async () => "subject body text" },
      subjRec,
      undefined,
    )
    // roadmap on 2 neighbors → first; misc on 1; q4 on 1; draft excluded (already current).
    expect(suggestions.suggested.find((t) => t.tag === "roadmap")?.count).toBe(2)
    expect(suggestions.suggested[0]?.tag).toBe("roadmap")
    expect(suggestions.suggested.map((t) => t.tag).sort()).toEqual(["misc", "q4", "roadmap"])
    expect(suggestions.suggested.some((t) => t.tag === "draft")).toBe(false)
  })
})
