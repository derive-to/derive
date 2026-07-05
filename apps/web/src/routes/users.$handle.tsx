import { createFileRoute } from "@tanstack/react-router"
import { profileArtifactsQuery, profileQuery } from "../lib/queries"
import { Profile } from "../pages/profile"
import { ProfilePending } from "../pages/profile/skeleton"

// Public profile by handle: /users/:handle (Profiles & Accounts v1). Rendered inside
// the shell; the shell treats /users/* as a public view, so a profile link is
// shareable without a session (the API endpoint omits email).
export const Route = createFileRoute("/users/$handle")({
  // Warm the identity + first page of work so the header paints with REAL data on the
  // first frame (header-first) — and so a profile A→B navigation never shows person A's
  // details while B loads. prefetchQuery (not ensureQueryData) so a 404 caches as an
  // error the component renders as "No such profile", instead of throwing to the route
  // error boundary. Warm within staleTime → instant; cold → the shape-matched
  // ProfilePending covers the wait.
  loader: async ({ context: { queryClient }, params: { handle } }) => {
    await Promise.all([
      queryClient.prefetchQuery(profileQuery(handle)),
      queryClient.prefetchInfiniteQuery(profileArtifactsQuery(handle)),
    ])
  },
  // Shape-matched pending frame for the cold-load window (same skeleton the Profile
  // component shows in-component, so the two are seamless).
  pendingComponent: ProfilePending,
  component: Profile,
})
