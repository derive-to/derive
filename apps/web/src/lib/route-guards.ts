import type { QueryClient } from "@tanstack/react-query"
import { redirect } from "@tanstack/react-router"
import { ONBOARDED_KEY } from "@/pages/welcome"
import { meQuery } from "./queries"

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

// requireAuth + the first-run onboarding gate: a signed-in user who hasn't set a
// profession (and hasn't finished/skipped onboarding) goes to /welcome. /welcome
// itself uses requireAuth ONLY, so it never redirects to itself — no loop.
export const requireOnboarded = async (args: GuardArgs) => {
  const { me } = await requireAuth(args)
  let onboarded = false
  try {
    onboarded = localStorage.getItem(ONBOARDED_KEY) === "1"
  } catch {
    /* private mode — the profession check still gates it */
  }
  if (!me.profession && !onboarded) throw redirect({ to: "/welcome" })
}
