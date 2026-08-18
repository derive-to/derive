import { createFileRoute } from "@tanstack/react-router"
import { artifactQuery, commentsQuery, meQuery } from "../lib/queries"
import { Artifact } from "../pages/artifact"
import { canCommentWithRole } from "../pages/artifact/lib/comment-access"
import { candidateShortIds } from "../pages/artifact/parse-ref"
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
  // `present=1` opens a deck straight into present mode, which is what you want from
  // the link you paste into the calendar invite for the meeting you're presenting in.
  // `use=1` is deferred use-as-template: the public viewer's "Make a copy" sends a
  // signed-out clicker through login with it, and the page fires the copy once the
  // visitor is authenticated. Gated by a same-tab click marker (a pasted ?use=1
  // link must not write — see pages/artifact/lib/use-intent.ts) and stripped after
  // firing either way.
  validateSearch: (
    s: Record<string, unknown>,
  ): {
    comment?: string
    review?: string
    collection?: string
    present?: boolean
    use?: boolean
    scene?: string
    t?: number
  } => ({
    ...(typeof s.comment === "string" && s.comment ? { comment: s.comment } : {}),
    ...(typeof s.review === "string" && s.review ? { review: s.review } : {}),
    ...(typeof s.collection === "string" && s.collection ? { collection: s.collection } : {}),
    ...(s.present === true || s.present === "1" || s.present === "true" ? { present: true } : {}),
    ...(s.use === true || s.use === "1" || s.use === "true" ? { use: true } : {}),
    ...(typeof s.scene === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(s.scene)
      ? { scene: s.scene }
      : {}),
    ...(Number.isFinite(Number(s.t)) && Number(s.t) >= 0 ? { t: Number(s.t) } : {}),
  }),
  // Warm the artifact + its comments so an intent-preloaded link opens instantly.
  // NOT the rendered HTML: a rel=prefetch of the viewer URL is never reused by the
  // iframe's navigation (measured, identical transferSize on both requests), so it
  // only ever doubled the bytes. Re-opens ride the ordinary HTTP cache instead.
  // Fire-and-forget: awaiting held the
  // whole route on a skeleton for the record round trip, when the page can
  // already paint its header from the clicked card's list row (artifactQuery's
  // placeholderData) and owns every fallback itself — auth redirect, not-found,
  // removed, and a plain WorkbenchSkeleton when nothing is cached at all. The
  // chain still runs to completion behind the mount, so an intent hover warms
  // exactly what it always did, and the catch keeps a failed fetch out of the
  // route error boundary as before.
  loader: ({ context: { queryClient }, params }) => {
    void (async () => {
      for (const id of candidateShortIds(params.ref)) {
        const art = await queryClient.ensureQueryData(artifactQuery(id)).catch(() => null)
        if (art) {
          const signedIn = queryClient.getQueryData(meQuery().queryKey)
          const commentsAvailable =
            art.is_workspace_member === true || canCommentWithRole(art.my_role)
          if (signedIn && commentsAvailable) queryClient.prefetchQuery(commentsQuery(id))
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
