import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { Library } from "../pages/library"
import { LibraryPending } from "../pages/library/library-skeleton"
import type { LibrarySearch } from "../pages/library/types"

// The Unlisted feed: /unlisted — your own agent drafts (unlisted artifacts you
// own). They're hidden from every other listing on purpose, so this named feed is
// the ONE place to find them without the link. Same route-as-feed contract as
// /favorites: only free-text search composes on top (docs/decisions/0002).
export const Route = createFileRoute("/unlisted")({
  beforeLoad: requireOnboarded,
  pendingComponent: LibraryPending,
  validateSearch: (s: Record<string, unknown>): Pick<LibrarySearch, "query"> => ({
    query: typeof s.query === "string" ? s.query : undefined,
  }),
  component: () => <Library view="unlisted" />,
})
