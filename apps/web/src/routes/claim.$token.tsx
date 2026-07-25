import { createFileRoute } from "@tanstack/react-router"
import { ClaimDraft } from "../pages/claim-draft"

// Claim an anonymous expiring draft into a workspace. The token in the path is the
// secret (possession authorizes), so this route is reachable by anyone with the link;
// the page itself gates the claim action behind sign-in. Chrome-less, like /invite/$token.
export const Route = createFileRoute("/claim/$token")({
  component: ClaimDraft,
})
