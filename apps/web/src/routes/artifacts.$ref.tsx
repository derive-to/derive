import { createFileRoute } from "@tanstack/react-router"
import { Artifact } from "../pages/artifact"
import { artifactRouteLoader, artifactRouteSearch } from "../pages/artifact/route-config"
import { WorkbenchSkeleton } from "../pages/artifact/workbench-skeleton"

export const Route = createFileRoute("/artifacts/$ref")({
  validateSearch: artifactRouteSearch,
  loader: artifactRouteLoader,
  // Shape-matched workbench frame while the loader warms the artifact (replaces the
  // generic route skeleton — this is a full-bleed workbench, not a page column).
  pendingComponent: WorkbenchSkeleton,
  // No minimum hold on that frame (see routes/index.tsx): the global
  // defaultPendingMinMs(300) floor delays ready content on a cold deep link, and the
  // shape-matched skeleton needs no smoothing to swap cleanly.
  pendingMinMs: 0,
  component: Artifact,
})
