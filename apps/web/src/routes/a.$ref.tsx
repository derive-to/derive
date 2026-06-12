import { createFileRoute } from "@tanstack/react-router"
import { Artifact } from "../pages/Artifact"

export const Route = createFileRoute("/a/$ref")({
  component: Artifact,
})
