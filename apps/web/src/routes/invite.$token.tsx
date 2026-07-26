import { createFileRoute } from "@tanstack/react-router"
import { AcceptInvite } from "../pages/accept-invite"

// Redeem a workspace invitation. The token in the path is the secret (possession
// authorizes), so this route is reachable by anyone with the link; the page itself gates
// the accept action behind sign-in. Chrome-less, like /login and /reset-password.
export const Route = createFileRoute("/invite/$token")({
  component: AcceptInvite,
})
