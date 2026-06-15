import { createFileRoute } from "@tanstack/react-router"
import { Profile } from "../pages/profile"

// Public profile by handle: /u/:handle (Profiles & Accounts v1). Rendered inside
// the shell; the shell treats /u/* as a public view, so a profile link is
// shareable without a session (the API endpoint omits email).
export const Route = createFileRoute("/u/$handle")({
  component: Profile,
})
