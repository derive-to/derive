import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { Library } from "../pages/library"
import { LibraryPending } from "../pages/library/library-skeleton"
import { parseLibrarySort } from "../pages/library/sort"
import type { LibrarySearch } from "../pages/library/types"

// The Shared feed: /shared — artifacts others have explicitly shared with you (can span
// workspaces). A durable named feed and a peer of /favorites and /following (not a home
// strip), so it reads as the destination it is: shareable, deep-linkable, and reachable
// from the rail. Only free-text ?query= search composes on top. Path = the feed you're
// viewing, query = how it's filtered (docs/decisions/0002).
export const Route = createFileRoute("/shared")({
  beforeLoad: requireOnboarded,
  pendingComponent: LibraryPending,
  validateSearch: (s: Record<string, unknown>): Pick<LibrarySearch, "query" | "sort"> => ({
    query: typeof s.query === "string" ? s.query : undefined,
    sort: parseLibrarySort(s.sort),
  }),
  component: () => <Library view="shared" />,
})
