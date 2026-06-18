import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query"
import { API_BASE, api } from "@/api"

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
