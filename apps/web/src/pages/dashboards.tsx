import "derive-dashboards/react/theme.css"
import { useNavigate, useRouter } from "@tanstack/react-router"
import {
  createDashboardsClient,
  Dashboard,
  DashboardList,
  DashboardsProvider,
  type LinkProps,
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

/**
 * Every link the library draws (a list row, a drill item) goes through Derive's router: a plain
 * click navigates in place; a modified click, or a middle click, opens as a link always does.
 */
function RouterLink({ href, className, children, onClick }: LinkProps) {
  const router = useRouter()
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        onClick?.(event)
        const plain =
          event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
        if (event.defaultPrevented || !plain) return
        event.preventDefault()
        router.history.push(href)
      }}
    >
      {children}
    </a>
  )
}

/** The library's components, on Derive's tokens (`.dd-host` in globals.css) and session. */
function DashboardsShell({ children }: { children: ReactNode }) {
  const { me } = useAuth()
  return (
    <div className="dd-host">
      <DashboardsProvider
        client={dashboardsClient}
        renderers={RECHARTS_RENDERERS}
        link={RouterLink}
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

/** One dashboard: its tiles, its drill-ins (items link where the server says), and edit mode. */
export function DashboardView({ id }: { id: string }) {
  return (
    <DashboardsShell>
      <Dashboard id={id} />
    </DashboardsShell>
  )
}
