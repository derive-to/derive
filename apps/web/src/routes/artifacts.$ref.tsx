import { createFileRoute } from "@tanstack/react-router"
import { artifactQuery, commentsQuery, prefetchArtifactRaw } from "../lib/queries"
import { Artifact } from "../pages/artifact"
import { candidateShortIds, parseRef } from "../pages/artifact/parse-ref"
import { WorkbenchSkeleton } from "../pages/artifact/workbench-skeleton"

export const Route = createFileRoute("/artifacts/$ref")({
  // Two deep links, each naming its target: `comment` opens a thread (panel + anchor),
  // `review` opens the proposal-review overlay on that proposal. Surfaces that point a
  // human at a pending proposal (the Brandprint profile panel's "Review & comment") use
  // it — landing on the live version would show them the wrong thing, and with several
  // proposals open the overlay must not have to guess which one they meant.
  validateSearch: (s: Record<string, unknown>): { comment?: string; review?: string } => ({
    ...(typeof s.comment === "string" && s.comment ? { comment: s.comment } : {}),
    ...(typeof s.review === "string" && s.review ? { review: s.review } : {}),
  }),
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
  // Shape-matched workbench frame while the loader warms the artifact (replaces the
  // generic route skeleton — this is a full-bleed workbench, not a page column).
  pendingComponent: WorkbenchSkeleton,
  component: Artifact,
})
