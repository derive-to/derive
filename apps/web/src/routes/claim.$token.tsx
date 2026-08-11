import { createFileRoute } from "@tanstack/react-router"
import { ClaimDraft } from "../pages/claim-draft"

// Claim an anonymous expiring draft into a workspace. The token in the path is the
// secret (possession authorizes), so this route is reachable by anyone with the link;
// the page itself gates the claim action behind sign-in. Chrome-less, like /invite/$token.
// `?go=1` rides return_to through the auth hand-off so the claim the user already
// asked for finishes without a second click (the artifacts.$ref `?use=1` pattern).
export const Route = createFileRoute("/claim/$token")({
  validateSearch: (s: Record<string, unknown>) => ({
    ...(s.go === true || s.go === "1" || s.go === "true" ? { go: true } : {}),
  }),
  component: ClaimDraft,
})
