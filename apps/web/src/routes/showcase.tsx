import { createFileRoute } from "@tanstack/react-router"
import { Showcase } from "../components/showcase/showcase"

// /showcase — the design-system reference (tokens + primitives). A design canvas,
// not a product surface, so it renders chrome-less (see AppFrame in __root).
export const Route = createFileRoute("/showcase")({
  component: Showcase,
})
