import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { Library } from "../pages/library"
import { LibraryPending } from "../pages/library/library-skeleton"
import { parseLibrarySort } from "../pages/library/sort"
import type { LibrarySearch } from "../pages/library/types"

// The Feedback feed: /feedback — artifacts with an open thread that @mentions you or that
// you've commented on (the triage queue). A focused named feed the home surfaces as a
// single quiet line; keeping it its own route (not a home strip) is what lets the home be
// "your work," one job. Only free-text ?query= search composes on top. Path = the feed,
// query = how it's filtered (docs/decisions/0002).
export const Route = createFileRoute("/feedback")({
  beforeLoad: requireOnboarded,
  pendingComponent: LibraryPending,
  validateSearch: (s: Record<string, unknown>): Pick<LibrarySearch, "query" | "sort"> => ({
    query: typeof s.query === "string" ? s.query : undefined,
    sort: parseLibrarySort(s.sort),
  }),
  component: () => <Library view="feedback" />,
})
