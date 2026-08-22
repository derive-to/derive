import { createFileRoute } from "@tanstack/react-router"
import { Artifact } from "../pages/artifact"
import { artifactRouteLoader, artifactRouteSearch } from "../pages/artifact/route-config"
import { WorkbenchSkeleton } from "../pages/artifact/workbench-skeleton"

// A template's public page: the artifact route under a second address, which the page
// presents with the template strip and footer.
export const Route = createFileRoute("/templates/$ref")({
  validateSearch: artifactRouteSearch,
  loader: artifactRouteLoader,
  pendingComponent: WorkbenchSkeleton,
  pendingMinMs: 0,
  component: () => <Artifact template />,
})
