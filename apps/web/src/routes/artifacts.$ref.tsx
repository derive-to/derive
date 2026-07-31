import { createFileRoute } from "@tanstack/react-router"
import { artifactQuery, commentsQuery, meQuery, prefetchArtifactRaw } from "../lib/queries"
import { Artifact } from "../pages/artifact"
import { candidateShortIds, parseRef } from "../pages/artifact/parse-ref"
import { WorkbenchSkeleton } from "../pages/artifact/workbench-skeleton"

export const Route = createFileRoute("/artifacts/$ref")({
  // Two deep links, each naming its target: `comment` opens a thread (panel + anchor),
  // `review` opens the proposal-review overlay on that proposal. Surfaces that point a
  // human at a pending proposal (the Brandprint profile panel's "Review & comment") use
  // it — landing on the live version would show them the wrong thing, and with several
  // proposals open the overlay must not have to guess which one they meant.
  // `collection` carries the list context you opened FROM, so the header breadcrumb can
  // page between siblings in that collection (dropped otherwise — a direct link has no
  // context and falls back to the artifact's sole collection, if any).
  validateSearch: (
    s: Record<string, unknown>,
  ): { comment?: string; review?: string; collection?: string } => ({
    ...(typeof s.comment === "string" && s.comment ? { comment: s.comment } : {}),
    ...(typeof s.review === "string" && s.review ? { review: s.review } : {}),
    ...(typeof s.collection === "string" && s.collection ? { collection: s.collection } : {}),
  }),
  // Warm the artifact + its comments (and the rendered HTML the iframe loads) so
  // an intent-preloaded link opens instantly. Fire-and-forget: awaiting held the
  // whole route on a skeleton for the record round trip, when the page can
  // already paint its header from the clicked card's list row (artifactQuery's
  // placeholderData) and owns every fallback itself — auth redirect, not-found,
  // removed, and a plain WorkbenchSkeleton when nothing is cached at all. The
  // chain still runs to completion behind the mount, so an intent hover warms
  // exactly what it always did, and the catch keeps a failed fetch out of the
  // route error boundary as before.
  loader: ({ context: { queryClient }, params }) => {
    const { version } = parseRef(params.ref)
    void (async () => {
      for (const id of candidateShortIds(params.ref)) {
        const art = await queryClient.ensureQueryData(artifactQuery(id)).catch(() => null)
        if (art) {
          // Comments are signed-in-only (the API 404s anon by design) — warm them
          // only for a session the page will actually read them with.
          if (queryClient.getQueryData(meQuery().queryKey))
            queryClient.prefetchQuery(commentsQuery(id))
          // The token belongs to the URL the frame loads — see prefetchArtifactRaw.
          if (!art.removed) prefetchArtifactRaw(id, version ?? art.current_version, art.raw_token)
          return
        }
      }
    })()
  },
  // Shape-matched workbench frame while the loader warms the artifact (replaces the
  // generic route skeleton — this is a full-bleed workbench, not a page column).
  pendingComponent: WorkbenchSkeleton,
  // No minimum hold on that frame (see routes/index.tsx): the global
  // defaultPendingMinMs(300) floor delays ready content on a cold deep link, and the
  // shape-matched skeleton needs no smoothing to swap cleanly.
  pendingMinMs: 0,
  component: Artifact,
})
