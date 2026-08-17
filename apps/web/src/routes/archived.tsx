import { createFileRoute } from "@tanstack/react-router"
import { libraryArtifactsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Library } from "../pages/library"
import { LibraryPending } from "../pages/library/library-skeleton"
import { libraryFeedParams } from "../pages/library/params"
import { parseLibrarySort } from "../pages/library/sort"
import type { LibrarySearch } from "../pages/library/types"

export const Route = createFileRoute("/archived")({
  beforeLoad: requireOnboarded,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => {
    void queryClient.prefetchInfiniteQuery(
      libraryArtifactsQuery(libraryFeedParams("archived", deps)),
    )
  },
  pendingComponent: LibraryPending,
  validateSearch: (s: Record<string, unknown>): Pick<LibrarySearch, "query" | "sort"> => ({
    query: typeof s.query === "string" ? s.query : undefined,
    sort: parseLibrarySort(s.sort),
  }),
  component: () => <Library view="archived" />,
})
