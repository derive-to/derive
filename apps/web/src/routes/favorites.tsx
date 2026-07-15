import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { Library } from "../pages/library"
import { LibraryPending } from "../pages/library/library-skeleton"
import { parseLibrarySort } from "../pages/library/sort"
import type { LibrarySearch } from "../pages/library/types"

// The Favorites feed: /favorites — the artifacts you've starred. A fixed, named feed
// earns its own path (not a ?param on "/"), so it reads as the destination it is:
// shareable, deep-linkable, and a peer of /following and /people in the rail. Only
// free-text search (?query=) composes on top; the tag/collection filters belong to the
// home library, not this feed. Path = the feed you're viewing, query = how it's
// filtered (docs/decisions/0002).
export const Route = createFileRoute("/favorites")({
  beforeLoad: requireOnboarded,
  pendingComponent: LibraryPending,
  validateSearch: (s: Record<string, unknown>): Pick<LibrarySearch, "query" | "sort"> => ({
    query: typeof s.query === "string" ? s.query : undefined,
    sort: parseLibrarySort(s.sort),
  }),
  component: () => <Library view="favorites" />,
})
