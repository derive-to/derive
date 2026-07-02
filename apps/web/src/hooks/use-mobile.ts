// The shadcn sidebar imports this path. It must agree with the app's one mobile
// breakpoint (640px, Tailwind `sm` — see lib/use-is-mobile), not shadcn's
// default 768, so the sidebar's JS mobile branch and the app's `max-sm:`
// utilities/JS branches stay in lockstep. One source of truth, re-exported.
export { useIsMobile } from "@/lib/use-is-mobile"
