import "derive-dashboards/react/theme.css"
import { useNavigate } from "@tanstack/react-router"
import {
  createDashboardsClient,
  Dashboard,
  DashboardList,
  DashboardsProvider,
} from "derive-dashboards/react"
import { RECHARTS_RENDERERS } from "derive-dashboards/recharts"
import type { ReactNode } from "react"
import { useAuth } from "@/ctx"
import { DASHBOARDS_BASE } from "@/lib/dashboards"

/** The dashboards client: the same cookies as every other API call. */
const dashboardsClient = createDashboardsClient({
  baseURL: DASHBOARDS_BASE,
  fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
})

/** The library's components, on Derive's tokens (`.dd-host` in globals.css) and session. */
function DashboardsShell({ children }: { children: ReactNode }) {
  const { me } = useAuth()
  return (
    <div className="dd-host">
      <DashboardsProvider
        client={dashboardsClient}
        renderers={RECHARTS_RENDERERS}
        viewerKey={me?.id ?? "signed-out"}
      >
        {children}
      </DashboardsProvider>
    </div>
  )
}

/** Every dashboard this person can open: the built-in ones, the workspace's, their drafts. */
export function DashboardsIndex() {
  const navigate = useNavigate()
  return (
    <DashboardsShell>
      <DashboardList
        onOpen={(id) => void navigate({ to: "/dashboards/$id", params: { id } })}
        linkFor={(id) => `${window.location.origin}/dashboards/${encodeURIComponent(id)}`}
      />
    </DashboardsShell>
  )
}

/** One dashboard: its filters, tiles, and edit mode for those who may edit. */
export function DashboardView({ id }: { id: string }) {
  return (
    <DashboardsShell>
      <Dashboard id={id} />
    </DashboardsShell>
  )
}
