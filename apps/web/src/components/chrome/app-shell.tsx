import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouterState } from "@tanstack/react-router"
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAuth } from "@/ctx"
import { collectionsQuery, summaryQuery, workspacesQuery } from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { useIsMobile } from "@/lib/use-is-mobile"
import { NavRail } from "./nav-rail"
import { ShellCtx, type ShellValue } from "./shell-context"

// The ⌘K palette pulls in cmdk; it's only needed once the user opens it, so keep
// it (and cmdk) out of the shared bundle every route pays for. Loads on first open.
const CommandPalette = lazy(() =>
  import("./command-palette").then((m) => ({ default: m.CommandPalette })),
)

const COLLAPSE_KEY = STORAGE_KEYS.navCollapsed

// The persistent app frame — sidebar-first, one spatial model: the rail is the
// only persistent chrome; there is no global top bar, so pages own their headers
// and toolbars (the artifact workbench owns every pixel beside the rail). Built
// on the official shadcn sidebar: SidebarProvider owns the open/collapsed state
// (persisted to STORAGE_KEYS.navCollapsed, toggled by ⌘B and the header
// trigger), the rail collapses to an icon strip on desktop, and on mobile the
// whole sidebar lives in the component's off-canvas Sheet behind the sticky
// navbar's hamburger. Fetches the nav data (summary, collections, workspaces)
// once, so the rail + pod behave identically on every page.
export function AppShell({ children }: { children: ReactNode }) {
  const { me } = useAuth()
  const isMobile = useIsMobile()

  // The provider is controlled so the state round-trips through the app's
  // storage contract ("1" = collapsed, "0" = expanded; expanded by default)
  // instead of the component's cookie.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(COLLAPSE_KEY)
      return v === null ? true : v !== "1"
    } catch {
      return true
    }
  })
  const onSidebarOpenChange = useCallback((open: boolean) => {
    setSidebarOpen(open)
    try {
      localStorage.setItem(COLLAPSE_KEY, open ? "0" : "1")
    } catch {
      /* private mode */
    }
  }, [])

  const [paletteOpen, setPaletteOpen] = useState(false)
  const qc = useQueryClient()
  // Workspaces power the switcher's no-op check below; the rail + command palette
  // read their own copies of the nav queries (deduped by key). enabled on a
  // session so an anon visitor never fires the authed endpoints.
  const { data: workspaces } = useQuery({ ...workspacesQuery(), enabled: !!me })

  // An anonymous visitor on a shared artifact gets the chrome-light PublicViewer
  // (its own slim public header) — drop the app nav rail entirely so the render is
  // the whole page (the viral view; research: the render is the hero). Auth +
  // onboarding redirects for every other route now live in the routes' beforeLoad
  // guards (lib/route-guards), so an anon never renders authed chrome.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const bareArtifact = !me && pathname.startsWith("/artifacts/")

  // ⌘K / Ctrl+K opens the command palette from anywhere. "/" (outside inputs)
  // focuses the page's primary SearchField when one is registered
  // (data-slash-target, the GitHub idiom — typing replaces the selected query)
  // and falls back to the palette on pages without one. Never stack the palette
  // over an open dialog (share, delete confirm, …). ⌘B (the sidebar toggle) is
  // handled by SidebarProvider itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (document.querySelector('[role="dialog"]')) return
        const t = e.target as HTMLElement | null
        if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return
        e.preventDefault()
        const field = document.querySelector<HTMLInputElement>("input[data-slash-target]")
        if (field) {
          field.focus()
          field.select()
        } else {
          setPaletteOpen(true)
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Rail counts + collections stay live via react-query. The rail is mounted once
  // (it doesn't remount per nav), so a route change invalidates both keys — the
  // mounted rail queries then refetch — to pick up any publish / favorite /
  // collection edit. Keyed to the pathname, so in-page filter changes (search,
  // tag) don't refetch. Mutations also invalidate at their call site for an
  // immediate update; this is the catch-all so no count can silently go stale.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is an intentional re-run trigger — the effect invalidates on every route change, even though its body doesn't read pathname.
  useEffect(() => {
    if (me) {
      qc.invalidateQueries({ queryKey: summaryQuery().queryKey })
      qc.invalidateQueries({ queryKey: collectionsQuery().queryKey })
    }
  }, [me, pathname, qc])

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

  // Memoized so the provider gets a stable value object — consumers re-render only
  // when the palette state changes, not on every AppShell render (the nav data now
  // lives in react-query, not here). setPaletteOpen is a stable useState setter;
  // the workspace actions are useCallback-stable.
  const value = useMemo<ShellValue>(
    () => ({
      paletteOpen,
      setPaletteOpen,
      switchWorkspace,
      createWorkspace,
      deleteWorkspace,
    }),
    [paletteOpen, switchWorkspace, createWorkspace, deleteWorkspace],
  )

  // No full-screen hold: the known chrome renders immediately (the __root
  // AppFrame hydration gate covers the pre-hydration frame with AppBoot). The
  // rail's identity/nav atoms skeleton in during the me()/summary latency (see
  // NavRail's 3-state); a signed-out user on an auth-only route is bounced by the
  // route beforeLoad guards before this renders. `bareArtifact` keeps a
  // pending/anon `me` on the chrome-light artifact view — the rail enhances in
  // only once `me` resolves truthy (in-app navs have it cached, so no shift).

  // Note: profile setup isn't gated *inside* the shell — the onboarding effect
  // above redirects a new user to the dedicated /welcome step (handle + role +
  // connect-your-tools) instead, so the shell only ever renders for onboarded or
  // skipped users.

  // Chrome-light shell for an anon shared artifact: no rail, no mobile top bar —
  // the PublicViewer owns its own header/footer and the render fills the frame.
  if (bareArtifact)
    return (
      <ShellCtx.Provider value={value}>
        <TooltipProvider>
          <div id="main-content" className="isolate flex h-full min-h-0 flex-col outline-none">
            {children}
          </div>
        </TooltipProvider>
      </ShellCtx.Provider>
    )

  return (
    <ShellCtx.Provider value={value}>
      {/* Tooltips ride the sidebar's collapsed icon rows (the official
          menu-button tooltip pattern); Radix requires the provider. */}
      <TooltipProvider>
        <SidebarProvider
          open={sidebarOpen}
          onOpenChange={onSidebarOpenChange}
          // isolate: the app frame is its own stacking context, so in-page
          // z-indexes can never climb over portalled dialogs/popovers.
          className="isolate h-full min-h-0"
        >
          {/* Keyboard users land here first and can jump past the rail straight
              to the page. Visually hidden until focused. */}
          <a
            href="#main-content"
            className="sr-only rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-100"
          >
            Skip to content
          </a>
          <NavRail />
          {/* The page region. Viewport-locked scroll model: the inset never
              scrolls itself (overflow-hidden); pages own their scroll areas
              (library virtualizer, artifact iframe). */}
          <SidebarInset
            id="main-content"
            tabIndex={-1}
            className="min-h-0 min-w-0 overflow-hidden outline-none"
          >
            {/* Mobile navbar: the rail hides behind the drawer below sm, so the
                sticky bar answers "where am I" (current-page label) and keeps
                navigation + search reachable mid-scroll. Desktop has no top bar
                at all — the sidebar is the only persistent chrome. */}
            {isMobile && (
              <MobileTopBar pathname={pathname} onOpenPalette={() => setPaletteOpen(true)} />
            )}
            {children}
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      )}
    </ShellCtx.Provider>
  )
}

// The mobile sticky bar. Lives inside SidebarProvider so the hamburger can open
// the sidebar's off-canvas Sheet (the `library-menu` testid on mobile — the
// desktop trigger in the rail header doesn't render below sm, so it stays unique).
function MobileTopBar({
  pathname,
  onOpenPalette,
}: {
  pathname: string
  onOpenPalette: () => void
}) {
  const { setOpenMobile } = useSidebar()
  return (
    <header className="flex shrink-0 items-center gap-1.5 border-b border-border bg-background/95 px-2.5 py-2 backdrop-blur-sm">
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="library-menu"
        aria-label="Open navigation"
        onClick={() => setOpenMobile(true)}
      >
        <Icon name="sidebar" size={16} />
      </Button>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        <PageLabel pathname={pathname} />
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="Search" onClick={onOpenPalette}>
        <Icon name="search" size={16} />
      </Button>
    </header>
  )
}

// Where am I, for the mobile navbar (the sidebar is hidden behind the drawer).
// A pathname switch, not route metadata — labels are chrome, not content.
function PageLabel({ pathname }: { pathname: string }) {
  if (pathname === "/") return "Library"
  if (pathname === "/favorites") return "Favorites"
  if (pathname === "/following") return "Following"
  if (pathname === "/people") return "People"
  if (pathname === "/new") return "New artifact"
  if (pathname.startsWith("/settings")) return "Settings"
  if (pathname.startsWith("/artifacts/")) return "Artifact"
  if (pathname.startsWith("/users/")) return "Profile"
  return "Derive"
}
