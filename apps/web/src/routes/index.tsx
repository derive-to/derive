import { createFileRoute } from "@tanstack/react-router"
import { needsFeedbackArtifactsQuery, summaryQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Library } from "../pages/library"
import { LibraryPending } from "../pages/library/library-skeleton"
import { parseLibrarySort } from "../pages/library/sort"
import type { LibrarySearch } from "../pages/library/types"

export const Route = createFileRoute("/")({
  // Auth + first-run onboarding gate (anon → /login, un-onboarded → /welcome).
  beforeLoad: requireOnboarded,
  // Warm the two queries the home header branches on (greeting copy, triage line) WITHOUT
  // awaiting them. Awaiting held the whole route — and with it the artifact list, the one
  // request the person is waiting for — behind two header niceties: on a cold boot the
  // list didn't start until these resolved (~450ms of a ~1s boot, measured). Un-awaited,
  // the grid mounts immediately and the header data streams in behind it. The header
  // stays honest without the await: the greeting renders neutral "Welcome," until the
  // count resolves (never the new-user copy on a guess), the triage line reserves its
  // height while pending, and the grid recomputes scrollMargin on any above-grid height
  // change (artifact-grid.tsx observes the content wrapper), so a late landing shifts
  // nothing it can't absorb. Warm boots are unchanged: within staleTime these are cache
  // hits and the header still paints complete on the first frame.
  loader: ({ context: { queryClient } }) => {
    // prefetchQuery never throws — a failed warm just leaves the in-component useQuery
    // to retry, which is the same fallback the awaited version defended with .catch().
    void queryClient.prefetchQuery(summaryQuery())
    void queryClient.prefetchQuery(needsFeedbackArtifactsQuery())
  },
  // Shape-matched pending frame for the cold-load auth/loader window.
  pendingComponent: LibraryPending,
  // The home library. Its filters + free-text search live in the URL (LibrarySearch)
  // so the nav rail can drive them from anywhere and a filtered/searched library is
  // shareable. The named feeds (Favorites, Following) are their OWN routes, not params
  // here — path = the feed you're viewing, query = how it's filtered (docs/decisions/0002).
  validateSearch: (s: Record<string, unknown>): LibrarySearch => ({
    tag: typeof s.tag === "string" ? s.tag : undefined,
    collection: typeof s.collection === "string" ? s.collection : undefined,
    folder: typeof s.folder === "string" ? s.folder : undefined,
    query: typeof s.query === "string" ? s.query : undefined,
    author: typeof s.author === "string" ? s.author : undefined,
    // "drafts" is the tab's retired name — old bookmarks and agent-emitted
    // links keep landing on the same view.
    tab: s.tab === "mine" || s.tab === "drafts" ? "mine" : undefined,
    sort: parseLibrarySort(s.sort),
  }),
  component: () => <Library view="all" />,
})
