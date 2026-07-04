import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { Library } from "../pages/library"
import { LibraryPending } from "../pages/library/library-skeleton"
import type { LibrarySearch } from "../pages/library/types"

// The Following feed: /following — recent work from the authors and folders you
// follow (the activity feed the follow graph powers; see lib/use-follows). Like
// /favorites, a fixed named feed earns its own path; only ?query= search composes on
// top. Path = the feed you're viewing, query = how it's filtered (docs/decisions/0002).
export const Route = createFileRoute("/following")({
  beforeLoad: requireOnboarded,
  pendingComponent: LibraryPending,
  validateSearch: (s: Record<string, unknown>): Pick<LibrarySearch, "query"> => ({
    query: typeof s.query === "string" ? s.query : undefined,
  }),
  component: () => <Library view="following" />,
})
