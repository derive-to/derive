import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { requireAuth } from "@/lib/route-guards"
import { useDocumentTitle } from "@/lib/use-document-title"
import { DashboardsIndex } from "@/pages/dashboards"

// The workspace’s built-in and custom dashboards.
function DashboardsPage() {
  useDocumentTitle("Dashboards")
  return (
    <PageShell width="wide" className="flex flex-col gap-5">
      <PageHeader
        title="Dashboards"
        subtitle="See what your workspace publishes, reads, and runs."
      />
      <DashboardsIndex />
    </PageShell>
  )
}

export const Route = createFileRoute("/dashboards/")({
  beforeLoad: requireAuth,
  component: DashboardsPage,
})
