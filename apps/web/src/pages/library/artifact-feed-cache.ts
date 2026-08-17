import type { InfiniteData } from "@tanstack/react-query"
import type { Artifact, api } from "@/api"

type ArtifactPage = Awaited<ReturnType<typeof api.listArtifacts>>

export type ArtifactFeedData = InfiniteData<ArtifactPage>

/** Remove artifacts from every loaded page of an infinite library feed. */
export function removeArtifactsFromFeed(
  data: ArtifactFeedData | undefined,
  ids: ReadonlySet<string>,
): ArtifactFeedData | undefined {
  if (!data) return data
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      artifacts: page.artifacts.filter((artifact: Artifact) => !ids.has(artifact.short_id)),
    })),
  }
}
