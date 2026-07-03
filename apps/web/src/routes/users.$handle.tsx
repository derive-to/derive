import { createFileRoute } from "@tanstack/react-router"
import { Profile } from "../pages/profile"

// Public profile by handle: /users/:handle (Profiles & Accounts v1). Rendered inside
// the shell; the shell treats /users/* as a public view, so a profile link is
// shareable without a session (the API endpoint omits email).
export const Route = createFileRoute("/users/$handle")({
  component: Profile,
})
