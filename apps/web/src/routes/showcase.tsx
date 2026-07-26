import { createFileRoute, lazyRouteComponent, notFound } from "@tanstack/react-router"

// /showcase — the design-system reference (tokens + primitives). A design canvas, not a
// product surface: it 404s in production, and its ~1300-line harness is lazy so it never
// ships in the production entry bundle. Renders chrome-less (see AppFrame in __root).
export const Route = createFileRoute("/showcase")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound()
  },
  component: lazyRouteComponent(() => import("../components/showcase/showcase"), "Showcase"),
})
