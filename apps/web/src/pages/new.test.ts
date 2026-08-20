import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import type { Artifact } from "@/api"
import { seedPublishedArtifact } from "./new"

describe("new artifact handoff", () => {
  it("invalidates the lean publish seed so native detail chrome loads without a reload", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    })
    const published = {
      short_id: "bundle123",
      title: "Dogfood bundle",
      current_version: 1,
      current_content_type: "text/x-derive-linked-bundle",
      kind: "file",
    } as Artifact

    await seedPublishedArtifact(client, published)

    expect(client.getQueryData(["artifact", "bundle123"])).toMatchObject({
      short_id: "bundle123",
      my_role: "owner",
    })
    expect(client.getQueryState(["artifact", "bundle123"])?.isInvalidated).toBe(true)
  })
})
