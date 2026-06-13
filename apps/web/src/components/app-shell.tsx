import { Link } from "@tanstack/react-router"
import { type ReactNode, useCallback, useEffect, useState } from "react"
import { api, type Collection, type Workspaces } from "@/api"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { useIsMobile } from "@/lib/use-is-mobile"
import { cn } from "@/lib/utils"
import { Icon } from "./icons"
import { NavRail } from "./nav-rail"
import { Logo } from "./shared/logo"
import { ShellCtx, type ShellValue, type Summary } from "./shell-context"

const COLLAPSE_KEY = "dock.nav.collapsed"

// The persistent app frame: a slim top bar (toggle + brand left, page actions +
// bell right) over [nav rail | page]. Owns the rail collapse state (collapsed by
// default) and fetches the nav data (summary, collections, workspaces) once, so
// the rail + pod behave identically on every page.
export function AppShell({
  children,
  topBarActions,
}: {
  children: ReactNode
  topBarActions?: ReactNode
}) {
  const { me } = useAuth()
  const isMobile = useIsMobile()

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(COLLAPSE_KEY)
      return v === null ? true : v === "1"
    } catch {
      return true
    }
  })
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [collections, setCollections] = useState<Collection[]>([])
  const [workspaces, setWorkspaces] = useState<Workspaces | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0")
    } catch {
      /* private mode */
    }
  }, [collapsed])

  const refreshSummary = useCallback(() => {
    api
      .browseSummary()
      .then(setSummary)
      .catch(() => {})
  }, [])
  const refreshCollections = useCallback(() => {
    api
      .listCollections()
      .then((r) => setCollections(r.collections))
      .catch(() => {})
  }, [])
  const refreshWorkspaces = useCallback(() => {
    api
      .listWorkspaces()
      .then(setWorkspaces)
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (me) {
      refreshSummary()
      refreshCollections()
      refreshWorkspaces()
    }
  }, [me, refreshSummary, refreshCollections, refreshWorkspaces])

  // Switching/creating a workspace swaps the whole content context, so reload the
  // page rather than re-thread every list (a deliberate, infrequent action).
  const switchWorkspace = useCallback(
    async (id: string) => {
      if (id === workspaces?.active) return
      try {
        await api.switchWorkspace(id)
        window.location.reload()
      } catch {
        /* surfaced elsewhere */
      }
    },
    [workspaces],
  )
  const createWorkspace = useCallback(async (name: string) => {
    try {
      await api.createWorkspace(name)
      window.location.reload()
    } catch {
      /* surfaced elsewhere */
    }
  }, [])

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), [])

  const value: ShellValue = {
    collapsed,
    toggleCollapsed,
    drawerOpen,
    setDrawerOpen,
    summary,
    collections,
    workspaces,
    refreshSummary,
    refreshCollections,
    switchWorkspace,
    createWorkspace,
  }

  return (
    <ShellCtx.Provider value={value}>
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-2.5 border-b border-border bg-card px-5.5 py-3 max-sm:px-3.5 max-sm:py-2.5">
          <Button
            variant="outline"
            size="icon"
            data-testid="sidebar-toggle"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title="Toggle sidebar"
            onClick={() => (isMobile ? setDrawerOpen(true) : toggleCollapsed())}
          >
            <Icon name="sidebar" size={18} />
          </Button>
          <Link to="/" className="mr-auto flex items-center gap-2.5 text-foreground">
            <Logo />
            <span className="font-display text-lg font-semibold">Dock</span>
          </Link>
          {topBarActions && <div className="ml-auto flex items-center gap-2">{topBarActions}</div>}
        </header>

        <div className="flex min-h-0 flex-1">
          {isMobile && (
            <button
              type="button"
              aria-label="Close menu"
              tabIndex={drawerOpen ? 0 : -1}
              onClick={() => setDrawerOpen(false)}
              className={cn(
                "fixed inset-0 z-[60] bg-black/35 transition-opacity",
                drawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
              )}
            />
          )}
          <NavRail />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
        </div>
      </div>
    </ShellCtx.Provider>
  )
}
