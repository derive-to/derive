import { useIsFetching } from "@tanstack/react-query"
import { useRouterState } from "@tanstack/react-router"
import { useDelayedPending } from "@/lib/use-delayed-pending"
import { cn } from "@/lib/utils"

// The ONE global "something is loading" cue. The app serves cached data instantly and
// refetches in the background (router.tsx: "React Query owns staleness"), so a refresh or a
// stale-tab switch shows old data with NO skeleton — which reads as "nothing's happening"
// even while the truth is in flight. This thin top bar makes every background fetch AND cold
// nav legible app-wide, in one mount, so cached-and-refreshing never looks identical to
// settled. Gated by the shared PENDING timing (useDelayedPending): a cache-warm resolve under
// ~150ms flashes nothing, and once shown it holds long enough not to strobe.
export function GlobalProgress() {
  // Any query in flight (background refetch, prefetch, first load) OR a route transition
  // whose loader hasn't resolved. Either one means "the view you see may not be settled".
  const fetching = useIsFetching()
  const navigating = useRouterState({ select: (s) => s.status === "pending" })
  const busy = useDelayedPending(fetching > 0 || navigating)
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-100 h-0.5 overflow-hidden transition-opacity duration-300",
        busy ? "opacity-100" : "opacity-0",
      )}
    >
      {/* Faint full-width track — the static fallback that stays legible under reduced motion,
          where the sweep segment below freezes off-screen. */}
      <div className="h-full w-full bg-primary/20" />
      {/* The bright sweep segment riding over the track. */}
      <div className="absolute inset-y-0 left-0 w-1/3 animate-progress bg-primary" />
    </div>
  )
}
