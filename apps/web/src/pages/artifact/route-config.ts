import type { QueryClient } from "@tanstack/react-query"
import { artifactQuery, commentsQuery, meQuery } from "@/lib/queries"
import { canCommentWithRole } from "./lib/comment-access"
import { candidateShortIds } from "./parse-ref"

export type ArtifactSearch = {
  comment?: string
  collection?: string
  present?: boolean
  use?: boolean
  scene?: string
  t?: number
}

// One artifact page, two addresses: /artifacts/$ref is the permalink, /templates/$ref the
// public template page over the same document. Both routes share this search contract
// and loader so a link behaves the same whichever door it came in by.
//
// The `comment` deep link opens a thread (panel + anchor). `collection` carries the list
// context you opened FROM, so the header breadcrumb can page between siblings in that
// collection (dropped otherwise — a direct link has no context and falls back to the
// artifact's sole collection, if any). `present=1` opens a deck straight into present
// mode, which is what you want from the link you paste into the calendar invite for the
// meeting you're presenting in. `use=1` is deferred use-as-template: the public viewer's
// "Make a copy" sends a signed-out clicker through login with it, and the page fires the
// copy once the visitor is authenticated. Gated by a same-tab click marker (a pasted
// ?use=1 link must not write — see pages/artifact/lib/use-intent.ts) and stripped after
// firing either way.
export const artifactRouteSearch = (s: Record<string, unknown>): ArtifactSearch => ({
  ...(typeof s.comment === "string" && s.comment ? { comment: s.comment } : {}),
  ...(typeof s.collection === "string" && s.collection ? { collection: s.collection } : {}),
  // `?use=1` reaches the validator as the number 1 (the router JSON-parses values).
  ...(s.present === true || s.present === 1 || s.present === "true" ? { present: true } : {}),
  ...(s.use === true || s.use === 1 || s.use === "true" ? { use: true } : {}),
  ...(typeof s.scene === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(s.scene)
    ? { scene: s.scene }
    : {}),
  ...(Number.isFinite(Number(s.t)) && Number(s.t) >= 0 ? { t: Number(s.t) } : {}),
})

// Warm the artifact + its comments so an intent-preloaded link opens instantly.
// NOT the rendered HTML: a rel=prefetch of the viewer URL is never reused by the
// iframe's navigation (measured, identical transferSize on both requests), so it
// only ever doubled the bytes. Re-opens ride the ordinary HTTP cache instead.
// Fire-and-forget: awaiting held the whole route on a skeleton for the record round
// trip, when the page can already paint its header from the clicked card's list row
// (artifactQuery's placeholderData) and owns every fallback itself — auth redirect,
// not-found, removed, and a plain WorkbenchSkeleton when nothing is cached at all. The
// chain still runs to completion behind the mount, so an intent hover warms exactly
// what it always did, and the catch keeps a failed fetch out of the route error
// boundary as before.
export const artifactRouteLoader = ({
  context: { queryClient },
  params,
}: {
  context: { queryClient: QueryClient }
  params: { ref: string }
}) => {
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
}
