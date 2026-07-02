import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { useAuth } from "@/ctx"
import { prTitle } from "@/lib/pr"
import { cn } from "@/lib/utils"
import type { LibrarySearch } from "@/pages/library/types"
import { Icon, type IconName } from "./icons"
import { NotificationBell } from "./notification-bell"
import { Logo } from "./shared/logo"
import { useShell } from "./shell-context"
import { SyncChip } from "./sync-chip"
import { UserPod } from "./user-pod"

// How many of a repo's PR previews to list inline in the sidebar before collapsing
// the rest behind a "+N more" link (which opens the repo's in-collection PR viewer).
// Keeps the rail readable when a repo has dozens of open PRs.
const MAX_SIDEBAR_PRS = 5

// Icons carry the muted register at rest; hover and the active row re-ink them
// (the label itself is always full-strength — sidebar-foreground).
const ROW_ICON =
  "[&_svg]:text-muted-foreground hover:[&_svg]:text-foreground data-active:[&_svg]:text-foreground"

// Counts are the machine register: mono, tabular, muted. `top-1.5` centers the
// h-5 badge in the h-8 menu button (the badge rides INSIDE the asChild link so
// e2e text assertions on the row see the number).
const COUNT_BADGE = "top-1.5 font-mono text-2xs tabular-nums text-muted-foreground"

// Mono eyebrow register for group labels.
const GROUP_LABEL = "font-mono text-2xs uppercase tracking-wide"

// One filter-nav row: sets the library filter via URL search. A zero count is
// noise — the badge earns its ink only once it's nonzero.
function FilterItem({
  icon,
  label,
  count,
  search,
  active,
  testId,
}: {
  icon: IconName
  label: string
  count?: number
  search: LibrarySearch
  active: boolean
  testId?: string
}) {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={label}>
        <Link
          to="/"
          search={search}
          aria-label={label}
          data-testid={testId}
          aria-current={active ? "page" : undefined}
          onClick={() => setOpenMobile(false)}
          className={cn(ROW_ICON, (count ?? 0) > 0 && "pr-7")}
        >
          <Icon name={icon} />
          <span>{label}</span>
          {(count ?? 0) > 0 && <SidebarMenuBadge className={COUNT_BADGE}>{count}</SidebarMenuBadge>}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

// The brand header shared by the signed-in and anon rails: wordmark (the app's
// one wordmark — there is no top bar on desktop), the collapse trigger (desktop
// only; app-shell renders its own `library-menu` hamburger on mobile, and the
// testid must exist exactly once), and the ⌘K launcher (signed-in only — it
// reads as a search FIELD, Linear-style, collapsing to a plain icon in the rail).
function RailHeader({ showSearch }: { showSearch: boolean }) {
  const { isMobile, open, setOpenMobile } = useSidebar()
  const { setPaletteOpen } = useShell()
  return (
    <SidebarHeader>
      <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
        <Link
          to="/"
          onClick={() => setOpenMobile(false)}
          aria-label="Derive — home"
          className="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <Logo size={20} />
          <span className="truncate font-serif text-lg font-medium tracking-tight group-data-[collapsible=icon]:hidden">
            Derive
          </span>
        </Link>
        {!isMobile && (
          <SidebarTrigger
            data-testid="library-menu"
            aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
            title="Toggle sidebar"
            className="text-muted-foreground hover:text-foreground"
          />
        )}
      </div>
      {showSearch && (
        <button
          type="button"
          onClick={() => {
            setOpenMobile(false)
            setPaletteOpen(true)
          }}
          title="Search (⌘K)"
          aria-label="Search (⌘K)"
          data-testid="open-command-palette"
          className="flex h-8 w-full items-center gap-2 rounded-md bg-secondary px-2 text-left ring-1 ring-input ring-inset outline-none hover:bg-hover hover:ring-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:ring-0 group-data-[collapsible=icon]:hover:bg-sidebar-accent"
        >
          <Icon name="search" size={16} className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground group-data-[collapsible=icon]:hidden">
            Search
          </span>
          <Kbd className="group-data-[collapsible=icon]:hidden">⌘K</Kbd>
        </button>
      )}
    </SidebarHeader>
  )
}

// The persistent left nav — the app's only desktop chrome (there is no global
// top bar). Built on the official shadcn sidebar primitives (ui/sidebar):
// SidebarProvider (in app-shell) owns the collapse state; the desktop rail
// collapses to an icon strip (collapsible="icon"), and on mobile the whole
// sidebar renders inside the component's off-canvas Sheet. Anatomy: header
// (brand + trigger + ⌘K launcher) → content (primary filters, collections with
// PR sub-menus, tags, then the utility rows — sync, notifications, Settings —
// pinned to the foot with mt-auto) → footer (the account/workspace pod).
export function NavRail() {
  const { summary, collections, workspaces, switchWorkspace, refreshCollections } = useShell()
  const { me } = useAuth()
  const { state, isMobile, setOpenMobile } = useSidebar()
  const nav = useNavigate()
  const loc = useLocation()
  const search = loc.search as LibrarySearch
  const onLibrary = loc.pathname === "/"
  const isAll = onLibrary && !search.f && !search.scope && !search.tag && !search.collection
  const isFav = onLibrary && search.f === "favorites"
  const isFollowing = onLibrary && search.scope === "following"
  const onPeople = loc.pathname === "/people"
  const onSettings = loc.pathname === "/settings"
  const tags = summary?.tags ?? []
  // The icon strip shows only glyph rows; content that has no icon form (the
  // collections/tags lists, the anon conversion card) hides behind this.
  const iconMode = state === "collapsed" && !isMobile

  // Picking a destination on mobile closes the drawer (no-op on desktop).
  const closeMobile = () => setOpenMobile(false)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  // Repo collections whose nested PR previews are collapsed. Default-expanded, so the
  // set holds only the ones the user has folded shut.
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set())
  const toggleRepo = (id: string) =>
    setCollapsedRepos((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  // Nest PR-preview collections under their repo. A "pr" collection with a known
  // parentId becomes a child; everything else (repos, manual, orphaned PRs) stays
  // top-level. Children sort newest-PR-first.
  const childPrsByRepo = new Map<string, typeof collections>()
  const topCollections = collections.filter((col) => {
    if (col.kind === "pr" && col.parentId && collections.some((p) => p.id === col.parentId)) {
      const arr = childPrsByRepo.get(col.parentId) ?? []
      arr.push(col)
      childPrsByRepo.set(col.parentId, arr)
      return false
    }
    return true
  })
  for (const arr of childPrsByRepo.values())
    arr.sort((a, b) => (b.prNumber ?? 0) - (a.prNumber ?? 0))
  const submitCollection = async () => {
    const t = newName.trim()
    setNewName("")
    setCreating(false)
    if (!t) return
    try {
      const col = await api.createCollection(t)
      refreshCollections()
      setOpenMobile(false)
      nav({ to: "/", search: { collection: col.id } })
    } catch {
      /* surfaced on the library on next action */
    }
  }

  // Anonymous visitor on a shared public artifact. There's no workspace to
  // navigate, so the rail becomes the conversion surface — a single path to
  // making their own (Figma/Notion-style viral loop). The artifact itself stays
  // fully view-only; this is the only nav an anon ever sees.
  if (!me)
    return (
      <Sidebar collapsible="icon">
        <RailHeader showSearch={false} />
        <SidebarContent>
          {iconMode ? (
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip="Sign up for Derive">
                      {/* The rail's rows mute their icons; this one is the amber
                          conversion moment, so it keeps the brand ink. */}
                      <Link
                        to="/login"
                        search={{ signup: true }}
                        aria-label="Sign up for Derive"
                        data-testid="anon-signup"
                        className="text-primary [&_svg]:text-primary"
                      >
                        <Icon name="plus" />
                        <span>Sign up free</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : (
            <SidebarGroup>
              <SidebarGroupContent className="flex flex-col gap-3">
                {/* The one card in the rail — a conversion moment that must lift off
                    the flush canvas; its headline is a voice moment (serif). */}
                <div className="rounded-xl border border-border bg-card p-3.5">
                  <div className="flex items-center gap-2">
                    <Logo size={22} />
                    <span className="font-serif text-base font-medium tracking-tight text-foreground">
                      Create your own
                    </span>
                  </div>
                  <p className="mt-2 text-pretty text-sm text-muted-foreground">
                    Give your AI artifacts a permanent home: versions, comments, and one link to
                    share.
                  </p>
                  <Button
                    asChild
                    variant="default"
                    size="sm"
                    className="mt-3 w-full"
                    data-testid="anon-signup"
                  >
                    <Link to="/login" search={{ signup: true }} onClick={closeMobile}>
                      Sign up free
                    </Link>
                  </Button>
                </div>
                <p className="px-1 text-xs text-muted-foreground">
                  Already have an account?{" "}
                  <Link
                    to="/login"
                    onClick={closeMobile}
                    data-testid="anon-login"
                    className="font-medium text-primary hover:underline"
                  >
                    Log in
                  </Link>
                </p>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>
      </Sidebar>
    )

  return (
    <Sidebar collapsible="icon">
      <RailHeader showSearch />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <FilterItem
                icon="all"
                label="All artifacts"
                count={summary?.total}
                search={{}}
                active={isAll}
                testId="sidebar-all"
              />
              <FilterItem
                icon="favorites"
                label="Favorites"
                count={summary?.favorites}
                search={{ f: "favorites" }}
                active={isFav}
                testId="sidebar-favorites"
              />
              <FilterItem
                icon="following"
                label="Following"
                search={{ scope: "following" }}
                active={isFollowing}
                testId="nav-following"
              />
              {/* People directory — a real route, not a library filter (FilterItem
                  always links to "/"). Find + follow people. */}
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={onPeople} tooltip="People">
                  <Link
                    to="/people"
                    aria-label="People"
                    data-testid="nav-people"
                    aria-current={onPeople ? "page" : undefined}
                    onClick={closeMobile}
                    className={ROW_ICON}
                  >
                    <Icon name="user" />
                    <span>People</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel className={GROUP_LABEL}>Collections</SidebarGroupLabel>
          {/* The + stays neutral, not amber: create-in-rail isn't a sanctioned
              amber moment. */}
          <SidebarGroupAction
            title="New collection"
            aria-label="New collection"
            data-testid="sidebar-new-collection"
            onClick={() => setCreating((v) => !v)}
            className="text-muted-foreground hover:text-foreground"
          >
            <Icon name="plus" />
          </SidebarGroupAction>
          <SidebarGroupContent>
            {creating && (
              <Input
                autoFocus
                value={newName}
                placeholder="Collection name…"
                aria-label="Collection name"
                data-testid="sidebar-new-collection-input"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCollection()
                  if (e.key === "Escape") {
                    setCreating(false)
                    setNewName("")
                  }
                }}
                onBlur={submitCollection}
                className="mb-1 h-8 text-sm"
              />
            )}
            <SidebarMenu>
              {topCollections.map((col) => {
                const childPrs = childPrsByRepo.get(col.id)
                const colActive = onLibrary && search.collection === col.id
                if (!childPrs || childPrs.length === 0)
                  return (
                    <FilterItem
                      key={col.id}
                      icon="collection"
                      label={col.title}
                      count={col.count}
                      search={{ collection: col.id }}
                      active={colActive}
                      testId={`sidebar-collection-${col.id}`}
                    />
                  )
                const repoCollapsed = collapsedRepos.has(col.id)
                return (
                  <SidebarMenuItem key={col.id}>
                    <SidebarMenuButton asChild isActive={colActive}>
                      <Link
                        to="/"
                        search={{ collection: col.id }}
                        aria-label={col.title}
                        data-testid={`sidebar-collection-${col.id}`}
                        aria-current={colActive ? "page" : undefined}
                        onClick={closeMobile}
                        // pr-12 clears both the count and the fold action.
                        className={cn(ROW_ICON, col.count > 0 && "pr-12")}
                      >
                        <Icon name="collection" />
                        <span>{col.title}</span>
                        {col.count > 0 && (
                          <SidebarMenuBadge className={cn(COUNT_BADGE, "right-7")}>
                            {col.count}
                          </SidebarMenuBadge>
                        )}
                      </Link>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      onClick={() => toggleRepo(col.id)}
                      aria-expanded={!repoCollapsed}
                      aria-label={
                        repoCollapsed
                          ? `Show ${childPrs.length} pull request${childPrs.length === 1 ? "" : "s"}`
                          : "Hide pull requests"
                      }
                      data-testid={`sidebar-collection-${col.id}-toggle`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Icon
                        name="caret"
                        className={cn("transition-transform", repoCollapsed && "-rotate-90")}
                      />
                    </SidebarMenuAction>
                    {!repoCollapsed && (
                      <SidebarMenuSub>
                        {childPrs.slice(0, MAX_SIDEBAR_PRS).map((pr) => {
                          const prActive = onLibrary && search.collection === pr.id
                          return (
                            <SidebarMenuSubItem key={pr.id}>
                              <SidebarMenuSubButton asChild isActive={prActive}>
                                <Link
                                  to="/"
                                  search={{ collection: pr.id }}
                                  data-testid={`sidebar-collection-${pr.id}`}
                                  aria-current={prActive ? "page" : undefined}
                                  onClick={closeMobile}
                                  className={cn(ROW_ICON, pr.count > 0 && "pr-7")}
                                >
                                  <Icon name="review" />
                                  <span className="min-w-0 flex-1 truncate">
                                    {pr.prNumber
                                      ? `#${pr.prNumber} ${prTitle(pr.title, pr.prNumber)}`
                                      : prTitle(pr.title)}
                                  </span>
                                  {pr.count > 0 && (
                                    <SidebarMenuBadge className={cn(COUNT_BADGE, "top-1")}>
                                      {pr.count}
                                    </SidebarMenuBadge>
                                  )}
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          )
                        })}
                        {childPrs.length > MAX_SIDEBAR_PRS && (
                          <SidebarMenuSubItem>
                            {/* A de-emphasized meta row, not a full nav item. */}
                            <SidebarMenuSubButton
                              asChild
                              size="sm"
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <Link
                                to="/"
                                search={{ collection: col.id }}
                                data-testid={`sidebar-collection-${col.id}-more-prs`}
                                onClick={closeMobile}
                              >
                                <span>
                                  +{childPrs.length - MAX_SIDEBAR_PRS} more pull request
                                  {childPrs.length - MAX_SIDEBAR_PRS === 1 ? "" : "s"}
                                </span>
                              </Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        )}
                      </SidebarMenuSub>
                    )}
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {tags.length > 0 && (
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel className={GROUP_LABEL}>Tags</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {tags.map(({ tag, count }) => (
                  <FilterItem
                    key={tag}
                    icon="tag"
                    label={tag}
                    count={count}
                    search={{ tag }}
                    active={onLibrary && search.tag === tag}
                    testId={`sidebar-tag-${tag}`}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Utility rows pinned to the foot of the scroll region: a running sync,
            notifications, Settings. mt-auto pins without leaving the scroll flow. */}
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SyncChip />
              <NotificationBell />
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={onSettings} tooltip="Settings">
                  <Link
                    to="/settings"
                    data-testid="menu-settings"
                    aria-current={onSettings ? "page" : undefined}
                    onClick={closeMobile}
                    className={ROW_ICON}
                  >
                    <Icon name="settings" />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* FOOTER — pinned below the scroll: one calm identity row, nothing else. */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <UserPod
              workspaceLabel={summary?.workspace ?? ""}
              workspaces={workspaces}
              onSwitchWorkspace={switchWorkspace}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
