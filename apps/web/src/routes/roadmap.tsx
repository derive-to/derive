import { createFileRoute } from "@tanstack/react-router"
import { Roadmap } from "../pages/roadmap"

// /roadmap — the public living-roadmap page. No auth guard (anyone can read it),
// and chrome-less (no nav rail; see lib/chrome-routes). Deliberately not linked
// from the nav or login yet — reachable directly at /roadmap.
export const Route = createFileRoute("/roadmap")({
  component: Roadmap,
})
