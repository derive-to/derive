import { queryOptions } from "@tanstack/react-query"
import { API_BASE, api } from "@/api"

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
