import { createRouter } from "@tanstack/react-router"
import { AppBoot } from "./components/shared/app-boot"
import { RouteError, RouteNotFound } from "./components/shared/route-error"
import { PENDING } from "./lib/pending"
import { queryClient } from "./lib/query-client"
import { routeTree } from "./routeTree.gen"

// TanStack Start calls getRouter() to build the client router. Route tree is
// generated from src/routes/* by the Start vite plugin.
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // Key scroll positions by the full href, not the pathname: every filtered library
    // ("/?tag=…", "/?collection=…") shares the "/" pathname, and one shared key means
    // switching filters inherits a stale offset. Each filter now keeps its own.
    getScrollRestorationKey: (location) => location.href,
    defaultPreload: "intent",
    // React Query owns staleness. Setting the router's preload stale time to 0
    // means an intent hover always reaches the loader, which dedupes through the
    // query client (so it's a cache read, not a refetch, within staleTime).
    defaultPreloadStaleTime: 0,
    // Debounce intent so a pointer brushing past a link doesn't fire the loader;
    // ~65ms is below the time it takes to settle on a target you actually want.
    defaultPreloadDelay: 65,
    // View transitions are deliberately OFF. With intent-preloading + shape-matched
    // skeletons most navs already swap cleanly, but a global cross-fade dissolves the
    // outgoing page THROUGH the pending skeleton on any cold nav — which reads as a
    // flash. Opt a specific navigation in per-link (viewTransition) if it ever earns
    // a deliberate transition.
    // Perceived-perf: hold the current page for delayMs before showing the pending
    // frame (most cache-warm navs resolve first, so nothing flashes), and once shown
    // keep it at least minShownMs so a just-too-slow load doesn't strobe. The same
    // PENDING numbers drive in-component first loads via useDelayedPending. The
    // default is the neutral branded AppBoot (the one place a generic frame is
    // right); the data routes each override it with a shape-matched skeleton
    // (LibraryPending, WorkbenchSkeleton, ProfilePending, …).
    defaultPendingMs: PENDING.delayMs,
    defaultPendingMinMs: PENDING.minShownMs,
    defaultPendingComponent: AppBoot,
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
