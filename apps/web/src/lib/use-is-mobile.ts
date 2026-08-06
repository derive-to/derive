import { useCallback, useSyncExternalStore } from "react"

// Subscribe to a media query, answering it identically on the server and on the client's
// FIRST render — which is the part that is easy to get wrong.
//
// The obvious shape, `useState(() => matchMedia(q).matches)`, is SSR-safe (it guards
// `window`) but NOT hydration-safe: a lazy initializer runs on the client's first render,
// not after mount. So the prerender said "desktop" and a phone's first render said
// "mobile", React found a tree that did not match what it was hydrating, and threw the
// server-rendered shell away to rebuild it client-side. Measured: that happened on EVERY
// route at phone width and on none at desktop — a full re-render and a visible pop, on
// the device least able to afford either.
//
// useSyncExternalStore is the API for exactly this. `getServerSnapshot` is what hydration
// compares against, so returning a viewport-independent value there makes the first paint
// match by construction. The real answer arrives on the next tick, so the branch still
// settles immediately; it just does so as an ordinary update rather than a failed
// hydration.
const subscribe = (query: string) => (onChange: () => void) => {
  const mq = window.matchMedia(query)
  mq.addEventListener("change", onChange)
  return () => mq.removeEventListener("change", onChange)
}

/** The live answer on the client; `false` wherever there is no window to ask. */
function useMediaQuery(query: string): boolean {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `subscribe(query)` is the dep.
  const sub = useCallback(subscribe(query), [query])
  return useSyncExternalStore(
    sub,
    () => window.matchMedia(query).matches,
    // Hydration reads THIS. It must not consult the viewport, or the mismatch returns.
    () => false,
  )
}

// Matches a max-width breakpoint, reactively. Assumes desktop until the client hydrates.
// Drives the mobile layout branches across the app. 640 is Tailwind's `sm`, so JS branches
// and `max-sm:` utilities stay in lockstep.
export function useIsMobile(bp = 640): boolean {
  return useMediaQuery(`(max-width:${bp}px)`)
}

// Is the primary input a FINGER? Width is a proxy for "phone" and a bad proxy for
// "touch": a phone in landscape is 844px wide and a tablet is wider still, while a
// narrow desktop window is neither. Anything sized for thumbs (hit targets, "tap"
// rather than "click") should ask this instead of the breakpoint.
export function useCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)")
}
