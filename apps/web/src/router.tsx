import { createRouter } from "@tanstack/react-router"
import { RouteError, RouteNotFound } from "./components/shared/route-error"
import { RouteSkeleton } from "./components/shared/route-skeleton"
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
    // Debounce intent so a pointer brushing past a link doesn't fire the loader;
    // ~65ms is below the time it takes to settle on a target you actually want.
    defaultPreloadDelay: 65,
    // Cross-fade route changes. The rail/top bar are mounted once above the
    // Outlet, so only the content visibly morphs. No-ops where the View
    // Transitions API is unavailable.
    defaultViewTransition: true,
    // Perceived-perf: hold the current page for 150ms before showing a skeleton
    // (most cache-warm navs resolve first, so nothing flashes), and once shown
    // keep it at least 300ms so a just-too-slow load doesn't strobe.
    defaultPendingMs: 150,
    defaultPendingMinMs: 300,
    defaultPendingComponent: RouteSkeleton,
    // A thrown loader/render error or a missing route renders inside the content
    // area (chrome stays mounted, so the user can always navigate away) instead
    // of a blank screen or a raw stack trace.
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
    context: { queryClient },
  })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
