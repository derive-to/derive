import { createFileRoute } from "@tanstack/react-router"
import { libraryArtifactsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Library } from "../pages/library"
import { LibraryPending } from "../pages/library/library-skeleton"
import { libraryFeedParams } from "../pages/library/params"
import { parseLibrarySort } from "../pages/library/sort"
import type { LibrarySearch } from "../pages/library/types"

// The Following feed: /following — recent work from the authors and folders you
// follow (the activity feed the follow graph powers; see lib/use-follows). Like
// /favorites, a fixed named feed earns its own path; ?query= search and the sort order
// compose on top. Path = the feed you're viewing, query = how it's filtered (docs/decisions/0002).
export const Route = createFileRoute("/following")({
  beforeLoad: requireOnboarded,
  // Warm the EXACT list this feed renders, keyed the way LibraryBody keys it (one shared
  // builder — see pages/library/params.ts), so an intent hover on the rail's "Following"
  // paints the grid from cache on click instead of starting the request at mount. The
  // named feeds carried no loader at all, which meant the app's global
  // defaultPreload:"intent" had nothing to preload for four of its five library
  // destinations. loaderDeps keys on the search params, or every ?query=/?sort= variant
  // would look like the same match to the router.
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => {
    // prefetchQuery never throws; a failed warm just leaves the body's own query to run.
    void queryClient.prefetchInfiniteQuery(
      libraryArtifactsQuery(libraryFeedParams("following", deps)),
    )
  },
  pendingComponent: LibraryPending,
  validateSearch: (s: Record<string, unknown>): Pick<LibrarySearch, "query" | "sort"> => ({
    query: typeof s.query === "string" ? s.query : undefined,
    sort: parseLibrarySort(s.sort),
  }),
  component: () => <Library view="following" />,
})
