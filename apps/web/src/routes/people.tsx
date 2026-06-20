import { createFileRoute } from "@tanstack/react-router"
import { People } from "../pages/people"

// The People directory: /people — browse + search discoverable people and follow them.
// In-app (the shell + nav rail point here); the API requires a signed-in user.
export const Route = createFileRoute("/people")({
  component: People,
})
