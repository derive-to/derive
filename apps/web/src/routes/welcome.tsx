import { createFileRoute } from "@tanstack/react-router"
import { Welcome } from "../pages/welcome"

// First-run onboarding: a chrome-less full-screen step (no rail/top bar, like
// /login). New users are redirected here after signup while their profile is
// incomplete (see app-shell.tsx); reachable any time at /welcome.
export const Route = createFileRoute("/welcome")({
  component: Welcome,
})
