import { createFileRoute } from "@tanstack/react-router"
import { requireOnboarded } from "../lib/route-guards"
import { NewArtifact } from "../pages/new"

// Create a new artifact with the same editor as edit mode (SourceEditor).
export const Route = createFileRoute("/new")({
  beforeLoad: requireOnboarded,
  // `?start=deck` opens the editor on the canonical deck starter (the library's "Start a
  // deck"). A starter, not a mode: the editor behaves identically, it just isn't empty.
  validateSearch: (s: Record<string, unknown>): { start?: "deck" } =>
    s.start === "deck" ? { start: "deck" } : {},
  component: NewArtifact,
})
