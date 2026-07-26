import { createFileRoute } from "@tanstack/react-router"
import { requireAuth } from "../lib/route-guards"
import { Welcome } from "../pages/welcome"

// First-run onboarding: a chrome-less full-screen step (no rail/top bar, like
// /login). requireAuth ONLY — never requireOnboarded — so an un-onboarded user
// landing here isn't redirected back to /welcome (no loop); an anon still goes to
// /login. Reachable any time at /welcome.
export const Route = createFileRoute("/welcome")({
  beforeLoad: requireAuth,
  component: Welcome,
})
