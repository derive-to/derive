import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { NewArtifact } from "../pages/new"

// Create a new artifact with the same editor as edit mode (SourceEditor).
export const Route = createFileRoute("/new")({
  beforeLoad: requireOnboarded,
  component: NewArtifact,
})
