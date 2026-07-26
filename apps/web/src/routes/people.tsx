import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { People, PeoplePending } from "../pages/people"

// The People directory: /people — browse + search discoverable people and follow them.
// In-app (the shell + nav rail point here); the API requires a signed-in user.
export const Route = createFileRoute("/people")({
  beforeLoad: requireOnboarded,
  // Shape-matched pending frame for the cold-load auth window (same results skeleton
  // the People component shows in-component, so the two are seamless).
  pendingComponent: PeoplePending,
  component: People,
})
