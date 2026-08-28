import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { useDocumentTitle } from "@/lib/use-document-title"
import { WorkspaceActivity } from "@/pages/activity"

// What is happening in the workspace, and what needs you — its own page beside
// Notifications. Not the Library (the grid is what that page is) and not the bell (what
// was addressed to you); the third question, answered in one place.
function ActivityPage() {
  useDocumentTitle("Activity")
  return (
    <PageShell width="wide" className="flex flex-col gap-5">
      <PageHeader
        title="Activity"
        subtitle="What needs you across the workspace, and what people and agents have done."
      />
      <WorkspaceActivity />
    </PageShell>
  )
}

export const Route = createFileRoute("/activity")({
  component: ActivityPage,
})
