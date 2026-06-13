import { QueryClient } from "@tanstack/react-query"

// One client for the app: route loaders warm it via ensureQueryData / prefetch,
// components read it via useQuery, so an intent-preloaded route serves its data
// from cache on the click that follows. retry is off (the API is auth-gated — a
// 401/404 should fail fast, not retry three times), focus refetches are off
// (matches the prior hand-rolled fetches), and a 30s staleTime lets a preload
// stay warm long enough to be consumed.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
})
