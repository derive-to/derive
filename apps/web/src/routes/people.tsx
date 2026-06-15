import { createFileRoute } from "@tanstack/react-router"
import { People } from "../pages/people"

// Find people by username/name (opt-in discoverability).
export const Route = createFileRoute("/people")({
  component: People,
})
