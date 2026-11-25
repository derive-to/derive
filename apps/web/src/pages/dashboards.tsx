import "derive-dashboards/react/theme.css"
import "derive-dashboards/charts-react/chart.css"
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router"
import { CHARTS_RENDERERS } from "derive-dashboards/charts-react"
import { type ViewState, withView } from "derive-dashboards/core"
import { decodeView } from "derive-dashboards/core/schema"
import {
  createDashboardsClient,
  Dashboard,
  DashboardList,
  DashboardsProvider,
  type LinkProps,
  type ViewChange,
} from "derive-dashboards/react"
import { type ReactNode, useEffect, useRef, useState } from "react"
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
        renderers={CHARTS_RENDERERS}
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
  const router = useRouter()
  const search = useLocation({ select: (location) => location.searchStr })
  const written = useRef(search)
  const [current, setCurrent] = useState(() => decodeView(new URLSearchParams(search)))

  // A new drill is held in React until the server returns its shareable path.
  // Back and Forward read the URL. Our own writes keep the in-flight drill intact.
  useEffect(() => {
    if (search === written.current) return
    written.current = search
    setCurrent(decodeView(new URLSearchParams(search)))
  }, [search])

  const onViewChange = (view: ViewState, { history }: ViewChange) => {
    setCurrent({ view, dropped: [] })
    const location = router.history.location
    const params = withView(location.search, view).toString()
    const nextSearch = params ? `?${params}` : ""
    if (history === "replace" && nextSearch === location.search) return
    written.current = nextSearch
    const href = `${location.pathname}${nextSearch}${location.hash}`
    if (history === "push") router.history.push(href)
    else router.history.replace(href)
  }

  return (
    <DashboardsShell>
      <Dashboard
        id={id}
        tiles="cards"
        view={current.view}
        onViewChange={onViewChange}
        linkDropped={current.dropped}
        filterBar={{ shortcuts: false }}
      />
    </DashboardsShell>
  )
}
