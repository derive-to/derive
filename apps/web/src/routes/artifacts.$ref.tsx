import { createFileRoute } from "@tanstack/react-router"
import { artifactQuery, commentsQuery, prefetchArtifactRaw } from "../lib/queries"
import { Artifact } from "../pages/artifact"
import { candidateShortIds, parseRef } from "../pages/artifact/parse-ref"

export const Route = createFileRoute("/artifacts/$ref")({
  // `comment` deep-links to a comment thread (opens the panel + focuses its anchor).
  validateSearch: (s: Record<string, unknown>): { comment?: string } =>
    typeof s.comment === "string" ? { comment: s.comment } : {},
  // Warm the artifact + its comments (and the rendered HTML the iframe loads) so
  // an intent-preloaded link opens instantly. Best-effort: the page owns the
  // auth redirect and the not-found / removed states, so a failed fetch here
  // must not surface as a route error — hence the catch.
  loader: async ({ context: { queryClient }, params }) => {
    const { version } = parseRef(params.ref)
    for (const id of candidateShortIds(params.ref)) {
      const art = await queryClient.ensureQueryData(artifactQuery(id)).catch(() => null)
      if (art) {
        queryClient.prefetchQuery(commentsQuery(id))
        if (!art.removed) prefetchArtifactRaw(id, version ?? art.current_version)
        return
      }
    }
  },
  component: Artifact,
})
