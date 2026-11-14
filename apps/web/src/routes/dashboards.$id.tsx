import { createFileRoute } from "@tanstack/react-router"
import { PageShell } from "@/components/shared/page-shell"
import { useDocumentTitle } from "@/lib/use-document-title"
import { DashboardView } from "@/pages/dashboards"

function DashboardPage() {
  const { id } = Route.useParams()
  useDocumentTitle("Dashboard")
  return (
    <PageShell width="wide">
      <DashboardView id={id} />
    </PageShell>
  )
}

export const Route = createFileRoute("/dashboards/$id")({
  component: DashboardPage,
})
