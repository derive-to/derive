import { describe, expect, it } from "vitest"
import type { Artifact } from "@/api"
import { type ArtifactFeedData, removeArtifactsFromFeed } from "./artifact-feed-cache"

const artifact = (shortId: string) => ({ short_id: shortId }) as Artifact

describe("removeArtifactsFromFeed", () => {
  it("removes matching artifacts from every loaded page", () => {
    const data = {
      pageParams: ["", "next"],
      pages: [
        { artifacts: [artifact("a"), artifact("b")], next_cursor: "next" },
        { artifacts: [artifact("b"), artifact("c")], next_cursor: null },
      ],
    } satisfies ArtifactFeedData

    const next = removeArtifactsFromFeed(data, new Set(["b"]))

    expect(next?.pages.map((page) => page.artifacts.map((a) => a.short_id))).toEqual([["a"], ["c"]])
    expect(next?.pageParams).toEqual(data.pageParams)
  })
})
