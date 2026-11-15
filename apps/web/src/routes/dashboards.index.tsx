import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { useDocumentTitle } from "@/lib/use-document-title"
import { DashboardsIndex } from "@/pages/dashboards"

// Numbers about the workspace, kept current: the built-in Publishing dashboard and any the
// workspace makes (derive-dashboards, on Postgres instances).
function DashboardsPage() {
  useDocumentTitle("Dashboards")
  return (
    <PageShell width="wide" className="flex flex-col gap-5">
      <PageHeader title="Dashboards" subtitle="Numbers about this workspace, kept up to date." />
      <DashboardsIndex />
    </PageShell>
  )
}

export const Route = createFileRoute("/dashboards/")({
  component: DashboardsPage,
})
