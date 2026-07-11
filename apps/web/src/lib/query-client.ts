import { MutationCache, QueryClient } from "@tanstack/react-query"
import { toast } from "@/components/ui/sonner"

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

// Mutation meta the app understands. `errorToast: false` opts a single mutation OUT
// of the global error toast — for the few sites that render the failure inline (e.g. the
// login form) from `mutation.error` instead of a toast.
// Augmenting react-query's Register makes `meta` typed everywhere a mutation is
// declared, so a typo like `errorTost` is a compile error, not a silent no-op.
export type AppMutationMeta = { errorToast?: boolean }

// Query meta the app understands. `persist: false` opts a query OUT of the IndexedDB cache
// (lib/persist.ts) — for the session (auth must re-resolve fresh) and for anything keyed by a
// secret/capability token (invite previews), which has no reason to sit on disk. Declarative +
// colocated with the query, so a new sensitive query opts out at its definition, not in a
// central list someone has to remember to update.
export type AppQueryMeta = { persist?: boolean }

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: AppMutationMeta
    queryMeta: AppQueryMeta
  }
}

/** The single rule the mutation safety-net follows: toast every mutation error UNLESS
 *  it opted out to handle the failure inline. Pure + exported so it's unit-tested. */
export const shouldToastError = (meta: AppMutationMeta | undefined): boolean =>
  meta?.errorToast !== false

/** Whether a query's data may be persisted to IndexedDB: yes UNLESS it opted out via
 *  `meta.persist: false`. Pure + exported so it's unit-tested. */
export const shouldPersistQuery = (meta: AppQueryMeta | undefined): boolean =>
  meta?.persist !== false

/** The user-facing text for a mutation failure. A server error (ApiError) carries a numeric
 *  `status` and a human message worth showing; a network/unknown failure throws a raw browser
 *  string ("Failed to fetch") or a non-Error — fall back to a friendly line rather than leak
 *  that (or raise a blank toast on an `Error` with no message). Pure + exported so it's tested. */
export const toastMessageFor = (err: unknown): string => {
  const status = (err as { status?: unknown })?.status
  return typeof status === "number" && err instanceof Error && err.message
    ? err.message
    : "Something went wrong. Check your connection and try again."
}

// How long the cache is persisted AND kept in memory. gcTime MUST equal (or exceed) the
// persister's maxAge (lib/persist.ts reuses this) — otherwise garbage collection evicts an
// inactive query from memory before its persisted copy expires, dropping it from the next
// dehydrate, so a reload wouldn't restore anything you hadn't touched in the last gcTime window.
export const CACHE_MAX_AGE = 1000 * 60 * 60 * 24

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: retryQuery,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      // Retain inactive queries long enough for the persisted cache to stay complete (see above)
      // — but ONLY in the browser. React Query's gc timer isn't unref'd, so a 24h timer scheduled
      // during the SSR/prerender build would keep the Node process alive and hang `vite build`
      // (the prerender never exits). SSR has no persistence, so a short gc there is harmless.
      gcTime: typeof window === "undefined" ? 5_000 : CACHE_MAX_AGE,
    },
    // Writes are never auto-retried: many are non-idempotent (publishing a version,
    // posting a comment), and a failed write must surface at once rather than
    // silently re-fire. Reads self-heal (retryQuery); writes stay explicit.
    mutations: { retry: false },
  },
  // The safety net. Every mutation that rejects raises a toast BY DEFAULT, so a
  // forgotten catch can never again fail silently the way the hand-rolled sites did.
  // A mutation opts out with `meta.errorToast: false` when it renders the error inline.
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      if (shouldToastError(mutation.meta)) toast.error(toastMessageFor(err))
    },
  }),
})
