import { createFileRoute } from "@tanstack/react-router"
import { artifactQuery, commentsQuery, prefetchArtifactRaw } from "../lib/queries"
import { Artifact } from "../pages/artifact"
import { parseRef } from "../pages/artifact/parse-ref"

export const Route = createFileRoute("/a/$ref")({
  // `c` deep-links to a comment thread (opens the panel + focuses its anchor).
  validateSearch: (s: Record<string, unknown>): { c?: string } =>
    typeof s.c === "string" ? { c: s.c } : {},
  // Warm the artifact + its comments (and the rendered HTML the iframe loads) so
  // an intent-preloaded link opens instantly. Best-effort: the page owns the
  // auth redirect and the not-found / removed states, so a failed fetch here
  // must not surface as a route error — hence the catch.
  loader: async ({ context: { queryClient }, params }) => {
    const { shortId, version } = parseRef(params.ref)
    const art = await queryClient.ensureQueryData(artifactQuery(shortId)).catch(() => null)
    queryClient.prefetchQuery(commentsQuery(shortId))
    if (art && !art.removed) prefetchArtifactRaw(shortId, version ?? art.current_version)
  },
  component: Artifact,
})
