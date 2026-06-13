import { createRouter } from "@tanstack/react-router"
import { queryClient } from "./lib/query-client"
import { routeTree } from "./routeTree.gen"

// TanStack Start calls getRouter() to build the client router. Route tree is
// generated from src/routes/* by the Start vite plugin.
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    // React Query owns staleness. Setting the router's preload stale time to 0
    // means an intent hover always reaches the loader, which dedupes through the
    // query client (so it's a cache read, not a refetch, within staleTime).
    defaultPreloadStaleTime: 0,
    context: { queryClient },
  })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
