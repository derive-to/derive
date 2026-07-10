import { createFileRoute } from "@tanstack/react-router"
import { collectionsQuery, workspaceSettingsQuery } from "../lib/queries"
import { requireOnboarded } from "../lib/route-guards"
import { Brandprint, BrandprintPending } from "../pages/brandprint"

// Brandprint: /brandprint — the team's conventions destination (see pages/brandprint).
export const Route = createFileRoute("/brandprint")({
  beforeLoad: requireOnboarded,
  // Best-effort warm of what both sections read (collections for the pickers, the
  // workspace settings for the pointer); a failed preload must NOT blank the page
  // behind the route error boundary — the sections own their error states.
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(collectionsQuery()),
      context.queryClient.ensureQueryData(workspaceSettingsQuery()),
    ]).catch(() => {}),
  pendingComponent: BrandprintPending,
  component: Brandprint,
})
