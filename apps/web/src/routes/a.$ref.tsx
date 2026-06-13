import { createFileRoute } from "@tanstack/react-router"
import { Artifact } from "../pages/artifact"

export const Route = createFileRoute("/a/$ref")({
  // `c` deep-links to a comment thread (opens the panel + focuses its anchor).
  validateSearch: (s: Record<string, unknown>): { c?: string } =>
    typeof s.c === "string" ? { c: s.c } : {},
  component: Artifact,
})
