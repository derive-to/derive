import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react"
import { api } from "@/api"
import { BlockedBanner } from "@/components/billing/blocked-banner"
import { UpgradeDialog } from "@/components/billing/upgrade-dialog"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAuth } from "@/ctx"
import { readAuthHint } from "@/lib/auth-hint"
import { bareHotkey } from "@/lib/hotkey"
import { reloadAfterWorkspaceChange } from "@/lib/persist"
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
  const { me, loading } = useAuth()
  const isMobile = useIsMobile()
  // Read once — steers only the me()-loading window (the `bare` calc below), so a
  // returning user's cold load matches the rail the boot frame already reserved.
  const [authedHint] = useState(readAuthHint)

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
  const onSidebarOpenChange = (open: boolean) => {
    setSidebarOpen(open)
    try {
      localStorage.setItem(COLLAPSE_KEY, open ? "0" : "1")
    } catch {
      /* private mode */
    }
  }

  const [paletteOpen, setPaletteOpen] = useState(false)
  // Immersive (the artifact's focus mode): the rail + mobile top bar unmount and
  // the inset mat drops (see ShellValue.immersive). Ephemeral — never persisted.
  const [immersive, setImmersive] = useState(false)
  // A question handed to the palette by another surface (the rail row, a page's Ask button).
  // Transient by design: it is consumed on open, so reopening the palette later starts clean.
  const [pendingAsk, setPendingAsk] = useState<string | null>(null)
  const navigate = useNavigate()
  const qc = useQueryClient()
  // Workspaces power the switcher's no-op check below; the rail + command palette
  // read their own copies of the nav queries (deduped by key). enabled on a
  // session so an anon visitor never fires the authed endpoints.
  const { data: workspaces } = useQuery({ ...workspacesQuery(), enabled: !!me })

  // An anonymous visitor in the shell is always on a public view — a shared artifact
  // (its own PublicViewer) or a public profile (PublicFrame) — so drop the app rail
  // entirely and let the page's own chrome-light frame be the whole render (the viral
  // view; the render is the hero). Every non-public route redirects an anon to /login
  // via the routes' beforeLoad guards, so `me` is the signal. During the session's load
  // window defer to the boot hint, so a returning user keeps the rail (and an anon keeps
  // chrome-light) instead of popping when me() resolves.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const newSkill = useRouterState({ select: (s) => s.location.search.start === "skill" })
  const bare = !me && !(loading && authedHint)

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
      if (e.key === "/" && bareHotkey(e)) {
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
  // page rather than re-thread every list (a deliberate, infrequent action). The
  // reload rides reloadAfterWorkspaceChange: a plain location.reload() would restore
  // the OLD workspace's persisted query cache on boot, and any staleTime-Infinity
  // query (e.g. workspaceQuery) would then serve the wrong workspace's data forever
  // without ever refetching — including the switcher's own active check, which then
  // silently no-ops the switch. See persist.ts for why the cache drop happens at
  // boot, not here.
  const switchWorkspace = async (id: string) => {
    if (id === workspaces?.active) return
    try {
      await api.switchWorkspace(id)
      // Reload in place. If this is a private artifact from another workspace,
      // its detail request returns only a workspace-switch hint (never content),
      // so the page can offer a one-click return instead of dumping the person in
      // the library with no explanation.
      reloadAfterWorkspaceChange()
    } catch {
      /* surfaced elsewhere */
    }
  }
  const createWorkspace = async (name: string, invites: string[] = []) => {
    // createWorkspace switches the active-workspace cookie server-side, so the
    // invites that follow land in the NEW workspace. Per-email failures don't
    // abort the flow (a bad address shouldn't strand the workspace) — Members
    // shows the roster + pending list, so we land there when invites were sent.
    await api.createWorkspace(name)
    let invited = false
    for (const email of invites) {
      try {
        await api.inviteToWorkspace(email, "editor")
        invited = true
      } catch {
        /* re-addable from Members */
      }
    }
    reloadAfterWorkspaceChange(invited ? "/settings/members" : undefined)
  }
  // Deleting may swap the active workspace (the server switches the cookie when you
  // delete the one you're in), so reload to pick up the new active context.
  const deleteWorkspace = async (id: string) => {
    await api.deleteWorkspace(id)
    reloadAfterWorkspaceChange()
  }

  // THE ONE ASK ACTION, and the only place in the app that knows a phone has no dock.
  //
  // Callers pass a question or nothing. On a desktop that opens the dock beside the page; on a
  // phone the same ask becomes a navigation to /chat, which is a real route, so the phone's own
  // back gesture works and there is no bespoke sheet to dismiss. Keeping the branch here is what
  // lets every call site stay one line.
  const openAssistant = (text?: string) => {
    const question = text?.trim() ?? ""
    if (isMobile) {
      void navigate({
        to: "/chat",
        search: { ask: question || undefined, session: undefined, model: undefined },
      })
      return
    }
    setPendingAsk(question)
    setPaletteOpen(true)
  }

  // A plain value object — the React Compiler keeps it reference-stable across
  // renders, so consumers re-render only when the palette state or a workspace
  // action changes (the nav data now lives in react-query, not here).
  const value: ShellValue = {
    paletteOpen,
    setPaletteOpen,
    immersive,
    setImmersive,
    openAssistant,
    pendingAsk,
    clearPendingAsk: () => setPendingAsk(null),
    switchWorkspace,
    createWorkspace,
    deleteWorkspace,
  }

  // No full-screen hold: the known chrome renders immediately (the __root
  // AppFrame hydration gate covers the pre-hydration frame with BootShell). The
  // rail's identity/nav atoms skeleton in during the me()/summary latency (see
  // NavRail's 3-state); a signed-out user on an auth-only route is bounced by the
  // route beforeLoad guards before this renders. During the load window `bare` (above)
  // defers to the boot hint, so a returning user keeps the rail rather than flashing
  // the anon chrome-light view (in-app navs have `me` cached, so no shift either way).

  // Note: profile setup isn't gated *inside* the shell — the onboarding effect
  // above redirects a new user to the dedicated /welcome step (handle + role +
  // connect-your-tools) instead, so the shell only ever renders for onboarded or
  // skipped users.

  // Chrome-light shell for any anon public view: no rail, no mobile top bar — the
  // page's own frame (PublicViewer for an artifact, PublicFrame for a profile) owns
  // the header/footer and the render fills the frame.
  if (bare)
    return (
      <ShellCtx.Provider value={value}>
        <TooltipProvider>
          <div id="main-content" className="isolate flex h-full min-h-0 flex-col outline-none">
            {children}
          </div>
        </TooltipProvider>
        <UpgradeDialog />
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
          {/* Immersive (focus mode) unmounts the rail rather than collapsing it —
              with no sidebar peer, SidebarInset's mat (margins/rounding/ring) drops
              too, so the page runs edge-to-edge. The rail's open state lives above
              in this component, so it survives and restores untouched on exit. */}
          {!immersive && <NavRail />}
          {/* The page region. Viewport-locked scroll model: the inset never
              scrolls itself (overflow-hidden); pages own their scroll areas
              (library virtualizer, artifact iframe). */}
          <SidebarInset
            id="main-content"
            tabIndex={-1}
            className="min-h-0 min-w-0 overflow-hidden outline-none"
          >
            <BlockedBanner pathname={pathname} />
            {/* Mobile navbar: the rail hides behind the drawer below sm, so the
                sticky bar answers "where am I" (current-page label) and keeps
                navigation + search reachable mid-scroll. Desktop has no top bar
                at all — the sidebar is the only persistent chrome. */}
            {isMobile && !immersive && (
              <MobileTopBar
                pathname={pathname}
                newSkill={newSkill}
                onOpenPalette={() => setPaletteOpen(true)}
              />
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
      <UpgradeDialog />
    </ShellCtx.Provider>
  )
}

// The mobile sticky bar. Lives inside SidebarProvider so the hamburger can open
// the sidebar's off-canvas Sheet (the `library-menu` testid on mobile — the
// desktop trigger in the rail header doesn't render below sm, so it stays unique).
function MobileTopBar({
  pathname,
  newSkill,
  onOpenPalette,
}: {
  pathname: string
  newSkill: boolean
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
        <PageLabel pathname={pathname} newSkill={newSkill} />
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="Search" onClick={onOpenPalette}>
        <Icon name="search" size={16} />
      </Button>
    </header>
  )
}

// Where am I, for the mobile navbar (the sidebar is hidden behind the drawer).
// A pathname switch, not route metadata — labels are chrome, not content.
function PageLabel({ pathname, newSkill }: { pathname: string; newSkill: boolean }) {
  if (pathname === "/") return "Artifacts"
  if (pathname === "/favorites") return "Favorites"
  if (pathname === "/following") return "Following"
  if (pathname === "/archived") return "Archived"
  if (pathname === "/new") return newSkill ? "New skill" : "New artifact"
  if (pathname.startsWith("/templates")) return "Templates"
  if (pathname.startsWith("/template-libraries")) return "Template library"
  if (pathname.startsWith("/contexts") || pathname.startsWith("/agents")) return "Contexts"
  if (pathname.startsWith("/workflows")) return "Workflows"
  if (pathname === "/chat") return "Chat"
  if (pathname.startsWith("/settings")) return "Settings"
  if (pathname.startsWith("/artifacts/")) return "Artifact"
  if (pathname.startsWith("/users/")) return "Profile"
  return "Derive"
}
