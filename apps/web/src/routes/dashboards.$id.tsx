import { createFileRoute, Link } from "@tanstack/react-router"
import { Icon } from "@/components/icons"
import { PageShell } from "@/components/shared/page-shell"
import { useDocumentTitle } from "@/lib/use-document-title"
import { DashboardView } from "@/pages/dashboards"

function DashboardPage() {
  const { id } = Route.useParams()
  useDocumentTitle("Dashboard")
  return (
    <PageShell width="full">
      <Link
        to="/dashboards"
        data-testid="dashboard-index-link"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <Icon name="chevron-left" size={14} />
        Dashboards
      </Link>
      <DashboardView key={id} id={id} />
    </PageShell>
  )
}

export const Route = createFileRoute("/dashboards/$id")({
  component: DashboardPage,
})
