import { createFileRoute } from "@tanstack/react-router"
import { Login } from "../pages/login"

// OAuth authorize params the oidc-provider appends when it bounces an
// unauthenticated /authorize to /login; preserved so login can resume the flow.
const OAUTH_KEYS = [
  "client_id",
  "response_type",
  "redirect_uri",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "state",
] as const

export const Route = createFileRoute("/login")({
  // `?signup` deep-links straight into the create-account form (the anon viral
  // CTA on a shared artifact links here). OAuth params ride through so an agent's
  // authorize request survives the login round-trip.
  validateSearch: (s: Record<string, unknown>): Record<string, string | boolean> => {
    const out: Record<string, string | boolean> = {}
    if (s.signup) out.signup = true
    // Set by the reset-password flow after a successful change, to show a "sign in with
    // your new password" confirmation.
    if (s.reset) out.reset = true
    // Where to land after sign-in (e.g. the shared artifact whose "sign in to comment"
    // CTA sent us here). Same-origin relative paths only — never `//host` or an absolute
    // URL — so it can't be weaponized into an open redirect.
    if (
      typeof s.return_to === "string" &&
      s.return_to.startsWith("/") &&
      !s.return_to.startsWith("//")
    )
      out.return_to = s.return_to
    for (const k of OAUTH_KEYS) if (typeof s[k] === "string") out[k] = s[k] as string
    return out
  },
  component: Login,
})
