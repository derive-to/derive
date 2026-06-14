import { QueryClient } from "@tanstack/react-query"

// One client for the app: route loaders warm it via ensureQueryData / prefetch,
// components read it via useQuery, so an intent-preloaded route serves its data
// from cache on the click that follows. Focus refetches are off (matches the prior
// hand-rolled fetches); a 30s staleTime lets a preload stay warm long enough to be
// consumed.
//
// Retry is the resilience seam. A 4xx (auth, not-found, conflict) won't fix itself,
// so fail fast. But a transient failure — a network blip, a 5xx, the server briefly
// unhealthy mid-deploy — SHOULD self-heal, so retry those a few times with backoff
// instead of dead-ending the UI. Status is read by duck-typing (ApiError carries a
// numeric `status`; a network failure throws without one), so this file needn't
// import from the api module.
/** A 4xx (auth, not-found, conflict) won't fix itself; anything else — a 5xx or a
 *  network/unknown failure (which throws without a numeric status) — is transient
 *  and worth retrying. */
export const isTransient = (err: unknown): boolean => {
  const status = (err as { status?: unknown })?.status
  return !(typeof status === "number" && status >= 400 && status < 500)
}

/** Retry transient failures up to 3 times; fail fast on client errors. */
export const retryQuery = (failureCount: number, err: unknown): boolean =>
  failureCount < 3 && isTransient(err)

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: retryQuery,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
})
