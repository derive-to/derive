import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { api, type Collection, type Workspaces } from "@/api"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { useIsMobile } from "@/lib/use-is-mobile"
import { cn } from "@/lib/utils"
import { ONBOARDED_KEY } from "@/pages/welcome"
import { Icon } from "./icons"
import { NavRail } from "./nav-rail"
import { Logo } from "./shared/logo"
import { CenteredSpinner } from "./shared/spinner"
import { ShellCtx, type ShellValue, type Summary, TopBarSlotCtx } from "./shell-context"

// The ⌘K palette pulls in cmdk; it's only needed once the user opens it, so keep
// it (and cmdk) out of the shared bundle every route pays for. Loads on first open.
const CommandPalette = lazy(() =>
  import("./command-palette").then((m) => ({ default: m.CommandPalette })),
)

const COLLAPSE_KEY = STORAGE_KEYS.navCollapsed

// The persistent app frame: a slim top bar (toggle + brand left, page actions +
// bell right) over [nav rail | page]. Owns the rail collapse state (collapsed by
// default) and fetches the nav data (summary, collections, workspaces) once, so
// the rail + pod behave identically on every page.
export function AppShell({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth()
  const nav = useNavigate()
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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [collections, setCollections] = useState<Collection[]>([])
  const [workspaces, setWorkspaces] = useState<Workspaces | null>(null)
  // The top bar's right region; a page portals its actions here (see useTopBarSlot).
  const [topBarSlot, setTopBarSlot] = useState<HTMLElement | null>(null)

  // Public pages render for anonymous visitors too: artifact pages (/a/:ref,
  // read-only with a sign-up CTA — the viral path) and profiles (/u/:handle,
  // GitHub-style shareable). Every other route requires a session.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const publicView = pathname.startsWith("/a/") || pathname.startsWith("/u/")

  // Auth gate: bounce to /login on auth-only routes once we know there's no session.
  useEffect(() => {
    if (!loading && !me && !publicView) nav({ to: "/login" })
  }, [loading, me, publicView, nav])

  // First-run onboarding gate: a signed-in user who hasn't set a role yet (and
  // hasn't finished/skipped onboarding) gets the dedicated /welcome step. A role
  // being set, or the onboarded flag, clears it — so it shows once after signup,
  // never loops. Public views (/a, /u) are left alone.
  useEffect(() => {
    if (loading || !me || publicView) return
    let onboarded = false
    try {
      onboarded = localStorage.getItem(ONBOARDED_KEY) === "1"
    } catch {
      /* private mode — fall through, role check still gates it */
    }
    if (!me.profession && !onboarded) nav({ to: "/welcome" })
  }, [loading, me, publicView, nav])

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0")
    } catch {
      /* private mode */
    }
  }, [collapsed])

  // ⌘K / Ctrl+K toggles the command palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

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
  // Workspaces only change via create/switch, which both hard-reload the page —
  // so they can't go stale mid-session. Fetch once.
  useEffect(() => {
    if (me) refreshWorkspaces()
  }, [me, refreshWorkspaces])

  // Summary (rail counts) + collections refresh on every route change. The shell
  // is mounted once now (it no longer remounts per nav), so without this the
  // counts would freeze at their mount-time values after a publish / favorite /
  // collection edit. Keyed to the pathname, so in-page filter changes (search,
  // tag) on the library don't trigger a refetch. (pathname computed above.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is an intentional re-run trigger — the effect refetches on every route change, even though its body doesn't read pathname.
  useEffect(() => {
    if (me) {
      refreshSummary()
      refreshCollections()
    }
  }, [me, pathname, refreshSummary, refreshCollections])

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
  // Deleting may swap the active workspace (the server switches the cookie when you
  // delete the one you're in), so reload to pick up the new active context.
  const deleteWorkspace = useCallback(async (id: string) => {
    await api.deleteWorkspace(id)
    window.location.reload()
  }, [])

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), [])

  // Memoized so the provider gets a stable value object — consumers re-render
  // only when shell state actually changes, not on every AppShell render. The
  // action fns are already stable (useCallback / setState), so the volatile
  // deps are just the state. topBarSlot lives in its own context (below).
  const value = useMemo<ShellValue>(
    () => ({
      collapsed,
      toggleCollapsed,
      drawerOpen,
      setDrawerOpen,
      paletteOpen,
      setPaletteOpen,
      summary,
      collections,
      workspaces,
      refreshSummary,
      refreshCollections,
      refreshWorkspaces,
      switchWorkspace,
      createWorkspace,
      deleteWorkspace,
    }),
    // setDrawerOpen / setPaletteOpen are stable useState setters — intentionally
    // not listed (React guarantees their identity).
    [
      collapsed,
      toggleCollapsed,
      drawerOpen,
      paletteOpen,
      summary,
      collections,
      workspaces,
      refreshSummary,
      refreshCollections,
      refreshWorkspaces,
      switchWorkspace,
      createWorkspace,
      deleteWorkspace,
    ],
  )

  // Until the session resolves, hold the frame rather than flashing the rail
  // (and the redirect above handles the signed-out case). Public pages render for
  // anon visitors, so don't gate those on a session.
  if (loading || (!me && !publicView)) return <CenteredSpinner />

  // Note: profile setup isn't gated *inside* the shell — the onboarding effect
  // above redirects a new user to the dedicated /welcome step (handle + role +
  // connect-your-tools) instead, so the shell only ever renders for onboarded or
  // skipped users.

  return (
    <ShellCtx.Provider value={value}>
      <TopBarSlotCtx.Provider value={topBarSlot}>
        <div className="flex h-full flex-col">
          {/* Keyboard users land here first and can jump past the rail + top bar
              straight to the page. Visually hidden until focused. */}
          <a
            href="#main-content"
            className="sr-only rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[100]"
          >
            Skip to content
          </a>
          <header className="flex items-center gap-2.5 border-b border-border bg-card px-5.5 py-3 max-sm:flex-wrap max-sm:px-3.5 max-sm:py-2.5">
            <Button
              variant="outline"
              size="icon"
              data-testid="library-menu"
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
            <div
              ref={setTopBarSlot}
              className="ml-auto flex items-center gap-2 max-sm:flex-wrap max-sm:justify-end"
            />
          </header>

          <div className="flex min-h-0 flex-1">
            {isMobile && (
              <button
                type="button"
                data-testid="library-menu-backdrop"
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
            <main
              id="main-content"
              tabIndex={-1}
              className="flex min-w-0 flex-1 flex-col overflow-hidden outline-none"
            >
              {children}
            </main>
          </div>
        </div>
        {paletteOpen && (
          <Suspense fallback={null}>
            <CommandPalette />
          </Suspense>
        )}
      </TopBarSlotCtx.Provider>
    </ShellCtx.Provider>
  )
}
