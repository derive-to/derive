import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { SearchPending, SearchResults } from "../pages/search"

// Full workspace search results: /search?q= — the deep, browsable view over the same hybrid
// (lexical + dense/semantic) endpoint the ⌘K palette peeks at. In-app; requires a signed-in user.
export const Route = createFileRoute("/search")({
  beforeLoad: requireOnboarded,
  pendingComponent: SearchPending,
  // `q` is the search term; anything else is ignored so a shared link stays clean.
  validateSearch: (s: Record<string, unknown>): { q?: string } => ({
    q: typeof s.q === "string" && s.q.trim() ? s.q : undefined,
  }),
  component: SearchResults,
})
