import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query"
import { API_BASE, api } from "@/api"

// The signed-in user (or null for an anon visitor). One key read by the thin
// AuthProvider (useQuery) AND the route guards (ensureQueryData) — they dedupe
// through this factory. staleTime Infinity: identity is session-stable, and
// login/logout mutate it explicitly via setMe(setQueryData). The queryFn returns
// null for anon (no error boundary) and only throws on a transient 5xx, so the
// query-client's default transient-retry self-heals a blip.
export const meQuery = () =>
  queryOptions({
    queryKey: ["me"] as const,
    queryFn: () => api.session(),
    staleTime: Number.POSITIVE_INFINITY,
  })

// Nav-rail data (counts + tag list, collections, workspaces). Warmed
// fire-and-forget by the authed routes' loaders and read via useQuery by the rail
// / library / command palette — one key each, so loader-warm and component-read
// dedupe. Kept fresh by explicit invalidation on the relevant mutations (create
// collection, publish, favorite, …) and on route change.
export const summaryQuery = () =>
  queryOptions({
    queryKey: ["summary"] as const,
    queryFn: () => api.browseSummary(),
  })

export const collectionsQuery = () =>
  queryOptions({
    queryKey: ["collections"] as const,
    queryFn: () => api.listCollections().then((r) => r.collections),
  })

// Workspaces only change via create/switch/delete — all of which hard-reload — so
// this is effectively fetch-once per session.
export const workspacesQuery = () =>
  queryOptions({
    queryKey: ["workspaces"] as const,
    queryFn: () => api.listWorkspaces(),
  })

const LIBRARY_PAGE = 30

// The library list as an infinite query: each page is a keyset slice, and the
// next cursor drives infinite scroll. Keyed by the active filter (search / tag /
// collection / favorites) so each view caches independently.
export type LibraryParams = {
  q?: string
  tag?: string
  collection?: string
  favorite?: boolean
  // Narrow to artifacts last changed by this GitHub login.
  author?: string
  // "following" → the activity feed: artifacts in the active workspace matching
  // your follows (followed authors + repo path prefixes).
  scope?: "following"
}
export const libraryArtifactsQuery = (params: LibraryParams) =>
  infiniteQueryOptions({
    queryKey: ["artifacts", params] as const,
    queryFn: ({ pageParam }) =>
      api.listArtifacts({ ...params, cursor: pageParam || undefined, limit: LIBRARY_PAGE }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    // Keep showing the current results while a new filter/search loads, so
    // switching views doesn't flash the skeleton.
    placeholderData: keepPreviousData,
    // Always revalidate when a view is (re)mounted — navigating back to a
    // collection must never strand a stale/empty cached page (the blank-collection
    // bug: a collection cached empty mid-sync, then shown empty on return).
    refetchOnMount: "always",
  })

// "Shared with you": artifacts explicitly shared with the caller (can span
// workspaces). A flat first page (no infinite scroll) — the home section shows a
// handful; opening one is the deep path.
export const sharedArtifactsQuery = () =>
  queryOptions({
    queryKey: ["artifacts", "shared"] as const,
    queryFn: () => api.listArtifacts({ scope: "shared", limit: 12 }).then((r) => r.artifacts),
  })

// Artifacts that need YOUR feedback: an open comment thread you're tagged in or have
// commented on. Surfaced as a promoted strip at the top of the unfiltered home.
export const needsFeedbackArtifactsQuery = () =>
  queryOptions({
    queryKey: ["artifacts", "needs_feedback"] as const,
    queryFn: () =>
      api.listArtifacts({ scope: "needs_feedback", limit: 12 }).then((r) => r.artifacts),
  })

// The caller's follows (GitHub authors + repo path prefixes) for the active
// workspace. Drives the Following-feed empty state, the manage strip, and the
// isFollowing* sets that toggle the Follow buttons. One source of truth: every
// add/remove invalidates this key so the toggles + strip refetch.
export const followsQuery = () =>
  queryOptions({
    queryKey: ["follows"] as const,
    queryFn: () => api.listFollows().then((r) => r.follows),
  })

// A public profile by handle — identity card + stats + (for a signed-in viewer)
// followed_by_me. Keyed by handle; invalidated on any follow change so the stats +
// Follow button stay live. retry:false so a 404 (no such handle) renders immediately.
export const profileQuery = (handle: string) =>
  queryOptions({
    queryKey: ["profile", handle] as const,
    queryFn: () => api.profile(handle).then((r) => r.user),
    retry: false,
  })

// A person's work as an infinite query — public artifacts they authored, plus
// shared-workspace work for a signed-in viewer. Keyset cursor drives infinite scroll.
const PROFILE_PAGE = 24
export const profileArtifactsQuery = (handle: string) =>
  infiniteQueryOptions({
    queryKey: ["profile-artifacts", handle] as const,
    queryFn: ({ pageParam }) => api.profileArtifacts(handle, pageParam || undefined, PROFILE_PAGE),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })

// Typed query options shared by route loaders (ensureQueryData, for intent
// preloading) and components (useQuery). One source of truth for keys +
// fetchers, so a preloaded route and the page that renders it resolve to the
// same cache entry — the preload warms exactly what the page reads.
export const artifactQuery = (shortId: string) =>
  queryOptions({
    queryKey: ["artifact", shortId] as const,
    queryFn: () => api.getArtifact(shortId),
  })

export const commentsQuery = (shortId: string) =>
  queryOptions({
    queryKey: ["comments", shortId] as const,
    queryFn: () => api.listComments(shortId).then((r) => r.comments),
  })

// Warm the artifact's rendered HTML so its sandboxed iframe paints from the HTTP
// cache instead of a cold fetch on open. The raw route is version-explicit, so
// callers pass the version they intend to show. Idempotent per (id, version).
export function prefetchArtifactRaw(shortId: string, version: number) {
  if (typeof document === "undefined") return
  const key = `${shortId}@${version}`
  if (document.querySelector(`link[data-raw="${key}"]`)) return
  // A plain rel=prefetch (no `as`) warms the HTTP cache for the iframe's later
  // navigation. `as="document"` isn't a reflected destination in Chrome and can
  // stop the iframe from reusing the response, so we leave it off.
  const link = document.createElement("link")
  link.rel = "prefetch"
  link.href = `${API_BASE}/raw/${shortId}/v/${version}/index.html`
  link.dataset.raw = key
  document.head.appendChild(link)
}
