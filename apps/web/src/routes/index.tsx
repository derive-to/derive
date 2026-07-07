import { createFileRoute } from "@tanstack/react-router"
import { needsFeedbackArtifactsQuery, summaryQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Library } from "../pages/library"
import { LibraryPending } from "../pages/library/library-skeleton"
import type { LibrarySearch } from "../pages/library/types"

export const Route = createFileRoute("/")({
  // Auth + first-run onboarding gate (anon → /login, un-onboarded → /welcome).
  beforeLoad: requireOnboarded,
  // Preload the two data the home BRANCHES on, so both paint deterministically on the
  // first frame: the summary count decides the greeting ("Welcome back" vs "Welcome to
  // Derive" — a pending query would flash the new-user copy at every returning user), and
  // the feedback count decides the triage line. Awaiting them here (they're small, and
  // warm within staleTime → instant) also means the grid below never gets pushed down by
  // a late-landing header, which would drift the virtualizer's scrollMargin. The
  // shape-matched LibraryPending covers the cold-load window while this resolves.
  loader: async ({ context: { queryClient } }) => {
    // Best-effort: warm the cache for a deterministic first paint, but never let a failed
    // preload BLOCK the home behind the route error boundary — the greeting/triage are
    // non-critical (a failed summary just falls back to a neutral "Welcome," and the
    // in-component useQuery retries), while the artifact list has its own error handling.
    await Promise.all([
      queryClient.ensureQueryData(summaryQuery()).catch(() => {}),
      queryClient.ensureQueryData(needsFeedbackArtifactsQuery()).catch(() => {}),
    ])
  },
  // Shape-matched pending frame for the cold-load auth/loader window.
  pendingComponent: LibraryPending,
  // The home library. Its filters + free-text search live in the URL (LibrarySearch)
  // so the nav rail can drive them from anywhere and a filtered/searched library is
  // shareable. The named feeds (Favorites, Following) are their OWN routes, not params
  // here — path = the feed you're viewing, query = how it's filtered (docs/decisions/0002).
  validateSearch: (s: Record<string, unknown>): LibrarySearch => ({
    tag: typeof s.tag === "string" ? s.tag : undefined,
    collection: typeof s.collection === "string" ? s.collection : undefined,
    query: typeof s.query === "string" ? s.query : undefined,
    author: typeof s.author === "string" ? s.author : undefined,
    // "drafts" is the tab's retired name — old bookmarks and agent-emitted
    // links keep landing on the same view.
    tab: s.tab === "mine" || s.tab === "drafts" ? "mine" : undefined,
  }),
  component: () => <Library view="all" />,
})
