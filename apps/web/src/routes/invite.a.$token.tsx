import { createFileRoute } from "@tanstack/react-router"
import { AcceptArtifactInvite } from "../pages/accept-invite"

// Redeem a per-artifact share invitation (the share dialog's emailed invites).
// Same contract as /invite/$token: the token in the path is the secret, the page
// gates the accept action behind sign-in, chrome-less shell.
export const Route = createFileRoute("/invite/a/$token")({
  component: AcceptArtifactInvite,
})
