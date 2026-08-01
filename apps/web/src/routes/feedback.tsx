import { createFileRoute } from "@tanstack/react-router"
import { libraryArtifactsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Library } from "../pages/library"
import { LibraryPending } from "../pages/library/library-skeleton"
import { libraryFeedParams } from "../pages/library/params"
import { parseLibrarySort } from "../pages/library/sort"
import type { LibrarySearch } from "../pages/library/types"

// The Feedback feed: /feedback — artifacts with an open thread that @mentions you or that
// you've commented on (the triage queue). A focused named feed the home surfaces as a
// single quiet line; keeping it its own route (not a home strip) is what lets the home be
// "your work," one job. Free-text ?query= search and the sort order compose on top. Path = the feed,
// query = how it's filtered (docs/decisions/0002).
export const Route = createFileRoute("/feedback")({
  beforeLoad: requireOnboarded,
  // Warm the EXACT list this feed renders, keyed the way LibraryBody keys it (one shared
  // builder — see pages/library/params.ts), so an intent hover on the rail's "Feedback"
  // paints the grid from cache on click instead of starting the request at mount. The
  // named feeds carried no loader at all, which meant the app's global
  // defaultPreload:"intent" had nothing to preload for four of its five library
  // destinations. loaderDeps keys on the search params, or every ?query=/?sort= variant
  // would look like the same match to the router.
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => {
    // prefetchQuery never throws; a failed warm just leaves the body's own query to run.
    void queryClient.prefetchInfiniteQuery(
      libraryArtifactsQuery(libraryFeedParams("feedback", deps)),
    )
  },
  pendingComponent: LibraryPending,
  validateSearch: (s: Record<string, unknown>): Pick<LibrarySearch, "query" | "sort"> => ({
    query: typeof s.query === "string" ? s.query : undefined,
    sort: parseLibrarySort(s.sort),
  }),
  component: () => <Library view="feedback" />,
})
