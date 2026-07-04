// The one source of the app's pending timing, shared by the router
// (defaultPendingMs / defaultPendingMinMs in router.tsx) and in-component first
// loads (useDelayedPending). delayMs: hold before showing a loader so cache-warm
// resolves flash nothing; minShownMs: keep it on once shown so a just-too-slow
// load doesn't strobe. Perceived-perf numbers, not motion — they apply under
// reduced motion too.
export const PENDING = { delayMs: 150, minShownMs: 300 } as const
