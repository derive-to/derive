import type { QueryClient } from "@tanstack/react-query"
import { redirect } from "@tanstack/react-router"
import { meQuery } from "./queries"
import { STORAGE_KEYS } from "./storage-keys"

// The beforeLoad fields the guards read. Kept structural so a guard doesn't depend
// on the full generated route types (any route's beforeLoad opts is assignable to
// this).
type GuardArgs = {
  context: { queryClient: QueryClient }
  location: { href: string }
}

// Resolve the session in the load phase — a cache hit after the first load / after
// login's setMe seeds it — and bounce an anon visitor to /login, preserving where
// they were headed (the /login route sanitizes return_to to a same-origin path).
// Throwing redirect() from beforeLoad is the supported, render-safe mechanism (we
// are NOT redirecting during render). Returns the Me so a caller can build on it.
export const requireAuth = async ({ context, location }: GuardArgs) => {
  const me = await context.queryClient.ensureQueryData(meQuery())
  if (!me) throw redirect({ to: "/login", search: { return_to: location.href } })
  return { me }
}

// The ONE first-run predicate — the single source of truth for "does this signed-in
// user still need /welcome". The server-authoritative flag (syncs across devices,
// survives a cleared cache) wins; otherwise fall back to the legacy signals so accounts
// from before the flag are never bounced back to /welcome — a claimed profession, or the
// per-browser localStorage cache. Both the route gate and the post-login redirect route
// off THIS, so they can't drift (a simpler onboarded-only check would send returning
// pre-flag users to /welcome after sign-in).
export const needsOnboarding = (me: { onboarded?: boolean; profession?: string | null }) => {
  if (me.onboarded) return false
  let cached = false
  try {
    cached = localStorage.getItem(STORAGE_KEYS.onboarded) === "1"
  } catch {
    /* private mode — the profession check still gates it */
  }
  return !me.profession && !cached
}

// requireAuth + the first-run onboarding gate: a signed-in user who still needs
// onboarding goes to /welcome. /welcome itself uses requireAuth ONLY, so it never
// redirects to itself — no loop.
export const requireOnboarded = async (args: GuardArgs) => {
  const { me } = await requireAuth(args)
  if (needsOnboarding(me)) throw redirect({ to: "/welcome" })
}
