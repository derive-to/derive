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
// of the global error toast — for the few sites that render the failure inline (the
// login form, the share-access panel) from `mutation.error` instead of a toast.
// Augmenting react-query's Register makes `meta` typed everywhere a mutation is
// declared, so a typo like `errorTost` is a compile error, not a silent no-op.
export type AppMutationMeta = { errorToast?: boolean }

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: AppMutationMeta
  }
}

/** The single rule the mutation safety-net follows: toast every mutation error UNLESS
 *  it opted out to handle the failure inline. Pure + exported so it's unit-tested. */
export const shouldToastError = (meta: AppMutationMeta | undefined): boolean =>
  meta?.errorToast !== false

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

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: retryQuery,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
      refetchOnWindowFocus: false,
      staleTime: 30_000,
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
