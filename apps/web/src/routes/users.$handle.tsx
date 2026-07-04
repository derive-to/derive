import { createFileRoute } from "@tanstack/react-router"
import { Profile } from "../pages/profile"
import { ProfilePending } from "../pages/profile-skeleton"

// Public profile by handle: /users/:handle (Profiles & Accounts v1). Rendered inside
// the shell; the shell treats /users/* as a public view, so a profile link is
// shareable without a session (the API endpoint omits email).
export const Route = createFileRoute("/users/$handle")({
  // Shape-matched pending frame for the cold-load window (same skeleton the Profile
  // component shows in-component, so the two are seamless).
  pendingComponent: ProfilePending,
  component: Profile,
})
