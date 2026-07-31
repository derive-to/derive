import { createFileRoute } from "@tanstack/react-router"
import { bootstrapQuery } from "../lib/bootstrap"
import { libraryArtifactsQuery, needsFeedbackArtifactsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Library } from "../pages/library"
import { LibraryPending } from "../pages/library/library-skeleton"
import { libraryFeedParams } from "../pages/library/params"
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
  // The filters are search params, so the loader keys on them: without loaderDeps the
  // router treats every filtered library as the same match and an intent hover on a
  // sidebar collection link cannot preload the view it actually opens.
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => {
    // prefetchQuery never throws — a failed warm just leaves the in-component useQuery
    // to retry, which is the same fallback the awaited version defended with .catch().
    // The summary rides the boot BATCH (/v1/bootstrap seeds it with the collections,
    // settings and notifications the shell is about to ask for) — prefetching it here
    // starts that one request in the loader instead of on the nav rail's mount, and
    // prefetching summaryQuery individually would fire the exact request the batch
    // exists to remove.
    void queryClient.prefetchQuery(bootstrapQuery(queryClient))
    void queryClient.prefetchQuery(needsFeedbackArtifactsQuery())
    // Warm the EXACT list this URL renders, keyed the way the body keys it — through the
    // one shared builder (pages/library/params.ts), not a second copy of the mapping — so
    // hovering a rail filter paints that grid from cache on click.
    void queryClient.prefetchInfiniteQuery(libraryArtifactsQuery(libraryFeedParams("all", deps)))
  },
  // Shape-matched pending frame for the cold-load auth/loader window.
  pendingComponent: LibraryPending,
  // No minimum hold on that frame. The global defaultPendingMinMs(300) exists to stop a
  // skeleton flashing mid-navigation — but on a cold boot the skeleton is up from first
  // paint regardless, and the floor was measured holding the READY library back ~250ms
  // (route resolved ~110ms, component mounted ~380ms). LibraryPending is shape-matched,
  // so the swap lands in the same geometry and needs no smoothing delay. Warm in-app
  // navs resolve inside defaultPendingMs(150), so the pending frame never shows there
  // and this changes nothing for them.
  pendingMinMs: 0,
  // The home library. Its filters + free-text search live in the URL (LibrarySearch)
  // so the nav rail can drive them from anywhere and a filtered/searched library is
  // shareable. The named feeds (Favorites, Following) are their OWN routes, not params
  // here — path = the feed you're viewing, query = how it's filtered (docs/decisions/0002).
  validateSearch: (s: Record<string, unknown>): LibrarySearch => ({
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
