import { createFileRoute } from "@tanstack/react-router"
import { JoinWorkspace } from "../pages/join-workspace"

// Join a workspace through its shareable link. The token in the path is the secret
// (possession authorizes), so this route is reachable by anyone with the link; the page
// gates the join behind sign-in. Chrome-less, like /invite/$token. `?go=1` rides return_to
// through the auth hand-off so the join the person already asked for finishes without a
// second click (the /claim/$token pattern). A plain visit never joins anyone.
export const Route = createFileRoute("/join/$token")({
  validateSearch: (s: Record<string, unknown>) => ({
    ...(s.go === true || s.go === "1" || s.go === "true" ? { go: true } : {}),
  }),
  component: JoinWorkspace,
})
