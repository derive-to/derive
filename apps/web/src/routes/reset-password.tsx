import { createFileRoute } from "@tanstack/react-router"
import { ResetPassword } from "../pages/reset-password"

// The password-recovery page. One route, two states, keyed on the query:
//   · no token        → request a reset link ("forgot password")
//   · ?token=…        → set a new password (where the emailed link lands)
//   · ?error=INVALID… → the link was expired/invalid; offer to request another
// Chrome-less like /login (see AppFrame in __root). Reached from the login page's
// "Forgot password?" affordance and from the reset email.
export const Route = createFileRoute("/reset-password")({
  validateSearch: (s: Record<string, unknown>): { token?: string; error?: string } => ({
    token: typeof s.token === "string" ? s.token : undefined,
    error: typeof s.error === "string" ? s.error : undefined,
  }),
  component: ResetPassword,
})
