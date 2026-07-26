import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api, type Collection } from "@/api"
import { Icon, type IconName } from "@/components/icons"
import { Logo } from "@/components/shared/logo"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAuth } from "@/ctx"
import { getMonogram } from "@/lib/initials"
import { prTitle } from "@/lib/pr"
import { collectionsQuery, summaryQuery, workspacesQuery } from "@/lib/queries"
import { useBrandprintCollectionIds } from "@/lib/use-brandprint-ids"
import { cn } from "@/lib/utils"
import type { LibrarySearch } from "@/pages/library/types"
import { GettingStarted } from "./getting-started"
import { NotificationBell } from "./notification-bell"
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

// The badge rides INSIDE the asChild link (so e2e text assertions on the row see
// the number), which means the primitive's peer-positioning can't fire — `top-1.5`
// re-centers the h-5 badge in the h-8 row. The mono register is baked into
// SidebarMenuBadge itself; only the muted tint is a call-site choice.
const COUNT_BADGE = "top-1.5 text-muted-foreground"

// The row's inner glyph — icon, label, and the ink-earning count badge — shared by
// FilterItem and NavItem below (a zero count is noise, so the badge only renders
// once it's nonzero).
function RowGlyph({ icon, label, count }: { icon: IconName; label: string; count?: number }) {
  return (
    <>
      <Icon name={icon} />
      <span>{label}</span>
      {(count ?? 0) > 0 && <SidebarMenuBadge className={COUNT_BADGE}>{count}</SidebarMenuBadge>}
    </>
  )
}

// The attributes every rail row's <Link> shares, regardless of where it points.
function useRowLinkProps(
  label: string,
  active: boolean,
  testId: string | undefined,
  count: number | undefined,
) {
  const { setOpenMobile } = useSidebar()
  return {
    "aria-label": label,
    "data-testid": testId,
    "aria-current": active ? ("page" as const) : undefined,
    onClick: () => setOpenMobile(false),
    className: cn(ROW_ICON, (count ?? 0) > 0 && "pr-7"),
  }
}

// One filter-nav row: sets the library filter via URL search.
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
  const linkProps = useRowLinkProps(label, active, testId, count)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={label}>
        <Link to="/" search={search} {...linkProps}>
          <RowGlyph icon={icon} label={label} count={count} />
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

// A fixed-feed nav row: navigates to a top-level ROUTE (a named feed like /favorites
// or /following, or the /people directory) rather than a library filter. The path IS
// the destination — the FilterItem counterpart for feeds that earned their own route
// (docs/decisions/0002).
function NavItem({
  icon,
  label,
  count,
  to,
  active,
  testId,
}: {
  icon: IconName
  label: string
  count?: number
  to: "/favorites" | "/following" | "/shared" | "/people" | "/contexts" | "/brandprint"
  active: boolean
  testId?: string
}) {
  const linkProps = useRowLinkProps(label, active, testId, count)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={label}>
        <Link to={to} {...linkProps}>
          <RowGlyph icon={icon} label={label} count={count} />
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

// A collection's leading glyph, chosen by kind: a repo mirror gets the folder-git
// glyph, a PR preview the pull-request glyph, and an ordinary (manual) collection a
// monochrome monogram tile — its initial in a neutral chip. The uniform folder icon
// is gone from manual collections: identical on every row, it differentiated nothing;
// the monogram gives each collection a leading letter that also survives the collapsed
// icon rail. Monochrome by design (see icons.tsx) — the chrome stays out of the way of
// the user's own coloured artifacts. The letter follows the same ink register as the
// sibling svg glyphs (ROW_ICON): muted at rest, re-inked on hover and on the active
// row, so a manual row's glyph doesn't read louder or dimmer than a repo/PR row's.
function CollectionGlyph({ col }: { col: Collection }) {
  if (col.kind === "repo") return <Icon name="repo" />
  if (col.kind === "pr") return <Icon name="review" />
  return (
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-sidebar-foreground/10 font-mono text-2xs font-medium text-muted-foreground group-hover/menu-button:text-foreground group-data-[active=true]/menu-button:text-foreground"
    >
      {getMonogram(col.title)}
    </span>
  )
}

// One collection row — the common case (a repo with nested PR previews takes the
// bespoke branch inline in NavRail). Mirrors FilterItem, but the glyph is kind-aware
// (CollectionGlyph) rather than a fixed IconName, and it carries a tooltip so the
// collapsed icon rail still names it.
function CollectionRow({ col, active }: { col: Collection; active: boolean }) {
  const linkProps = useRowLinkProps(col.title, active, `sidebar-collection-${col.id}`, col.count)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={col.title}>
        <Link to="/" search={{ collection: col.id }} {...linkProps}>
          <CollectionGlyph col={col} />
          <span>{col.title}</span>
          {col.count > 0 && (
            <SidebarMenuBadge className={COUNT_BADGE}>{col.count}</SidebarMenuBadge>
          )}
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
  const { isMobile, open, state, setOpenMobile } = useSidebar()
  const { setPaletteOpen } = useShell()
  return (
    <SidebarHeader>
      <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
        <Link
          to="/"
          // The prerendered SPA shell bakes this rail (via BootShell) at "/", so the
          // brand link is baked active; a cold load at any other route hydrates it
          // inactive. The diff is visually inert (the brand carries no active styling),
          // so suppress it — the route-agnostic boot frame hydrates without a warning.
          suppressHydrationWarning
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
          // Icon-only control: the hover hint is a real Tooltip (a title attr is
          // invisible to keyboard and touch); aria-label carries the name.
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarTrigger
                data-testid="library-menu"
                aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
                className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              />
            </TooltipTrigger>
            <TooltipContent side="right">
              Toggle sidebar <Kbd>⌘B</Kbd>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {showSearch && (
        // Tooltip only earns its keep in the collapsed icon strip, where the
        // launcher loses its visible label + ⌘K hint (the sidebar idiom).
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                setOpenMobile(false)
                setPaletteOpen(true)
              }}
              aria-label="Search (⌘K)"
              data-testid="open-command-palette"
              className="flex h-8 w-full items-center gap-2 rounded-lg bg-secondary px-2 text-left ring-1 ring-input ring-inset outline-none hover:ring-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:ring-0 group-data-[collapsible=icon]:hover:bg-sidebar-accent"
            >
              <Icon name="search" size={16} className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground group-data-[collapsible=icon]:hidden">
                Search
              </span>
              <Kbd className="group-data-[collapsible=icon]:hidden">⌘K</Kbd>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" hidden={state !== "collapsed" || isMobile}>
            Search <Kbd>⌘K</Kbd>
          </TooltipContent>
        </Tooltip>
      )}
    </SidebarHeader>
  )
}

// Deterministic silhouette widths (no Math.random → no per-render jitter / SSR mismatch).
const RAIL_SKELETON_ROWS = [
  { id: "r1", w: "72%" },
  { id: "r2", w: "58%" },
  { id: "r3", w: "64%" },
  { id: "r4", w: "50%" },
]
const RAIL_SKELETON_COLLECTIONS = [
  { id: "c1", w: "80%" },
  { id: "c2", w: "60%" },
  { id: "c3", w: "70%" },
]

// Cold-boot rail: shown while the session (me) is still resolving, so the rail
// never guesses anon-vs-authed and flashes the wrong one. The real Sidebar +
// RailHeader (both data-free) render exactly, with silhouette rows for the nav +
// collections and a skeleton pod at the foot. In-app navs have `me` cached, so
// this only ever appears on a genuine cold load. Exported so BootShell can render
// the identical silhouette in the pre-hydration frame (see chrome/boot-shell).
export function RailSkeleton() {
  return (
    <Sidebar collapsible="icon" variant="inset">
      <RailHeader showSearch />
      <SidebarContent>
        <span role="status" className="sr-only">
          Loading navigation…
        </span>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {RAIL_SKELETON_ROWS.map((r) => (
                <SidebarMenuSkeleton key={r.id} showIcon width={r.w} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Collections</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {RAIL_SKELETON_COLLECTIONS.map((r) => (
                <SidebarMenuSkeleton key={r.id} showIcon width={r.w} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex h-12 items-center gap-2 px-2">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5 group-data-[collapsible=icon]:hidden">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

// The persistent left nav — the app's only desktop chrome (there is no global
// top bar). Built on the official shadcn sidebar primitives (ui/sidebar):
// SidebarProvider (in app-shell) owns the collapse state; the desktop rail
// collapses to an icon strip (collapsible="icon"), and on mobile the whole
// sidebar renders inside the component's off-canvas Sheet. The rail is its own
// recessed surface (bg-sidebar, distinct from the content canvas); inactive rows
// sit dim and the active row lifts off it as a raised chip (ui/sidebar). Reads as
// calm tiers top to bottom: brand + search → primary nav → your library
// (collections + tags) → tools → account — separated by whitespace, not dividers.
export function NavRail() {
  const { switchWorkspace } = useShell()
  const { me, loading } = useAuth()
  const qc = useQueryClient()
  // Nav data read straight from react-query (deduped with the loaders that warm
  // it). enabled on a session so an anon never hits the authed endpoints.
  const { data: summary } = useQuery({ ...summaryQuery(), enabled: !!me })
  const { data: collections = [], isPending: collectionsPending } = useQuery({
    ...collectionsQuery(),
    enabled: !!me,
  })
  const { data: workspaces } = useQuery({ ...workspacesQuery(), enabled: !!me })
  // The pod subtitle: "Personal" for the auto-provisioned workspace (its stored
  // name is provisioning plumbing), else the summary's workspace name.
  const activeWs = workspaces?.workspaces.find((w) => w.id === workspaces.active)
  const workspaceLabel = activeWs?.personal ? "Personal" : (summary?.workspace ?? "")
  const { state, setOpenMobile } = useSidebar()
  const nav = useNavigate()
  const loc = useLocation()
  const search = loc.search as LibrarySearch
  const onLibrary = loc.pathname === "/"
  // Feeds are routes now; the home library reads "active > All" only when no tag/
  // collection filter narrows it. (A ?query= search doesn't change which feed you're in.)
  const isAll = onLibrary && !search.tag && !search.collection
  const isFav = loc.pathname === "/favorites"
  const onShared = loc.pathname === "/shared"
  // People + its Activity sub-view (the /following feed) are one tab; the row lights for both.
  const onPeople = loc.pathname === "/people" || loc.pathname === "/following"
  const onContexts = loc.pathname.startsWith("/contexts")
  const onBrandprint = loc.pathname === "/brandprint"
  const onSettings = loc.pathname.startsWith("/settings")
  const tags = summary?.tags ?? []

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

  // Brandprint-pointed collections are managed on /brandprint, not here — hiding
  // them keeps the docs and their options in one place (see use-brandprint-ids).
  const brandprintIds = useBrandprintCollectionIds()
  const visibleCollections = collections.filter((col) => !brandprintIds.has(col.id))

  // Nest PR-preview collections under their repo. A "pr" collection with a known
  // parentId becomes a child; everything else (repos, manual, orphaned PRs) stays
  // top-level. Children sort newest-PR-first.
  const childPrsByRepo = new Map<string, typeof collections>()
  const topCollections = visibleCollections.filter((col) => {
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
      qc.invalidateQueries({ queryKey: collectionsQuery().queryKey })
      setOpenMobile(false)
      nav({ to: "/", search: { collection: col.id } })
    } catch {
      /* surfaced on the library on next action */
    }
  }

  // One collection row. A repo with nested PRs keeps its bespoke collapsible row;
  // everything else is a flat CollectionRow.
  const renderCollection = (col: Collection) => {
    const childPrs = childPrsByRepo.get(col.id)
    const colActive = onLibrary && search.collection === col.id
    if (!childPrs || childPrs.length === 0)
      return <CollectionRow key={col.id} col={col} active={colActive} />
    const repoCollapsed = collapsedRepos.has(col.id)
    return (
      <SidebarMenuItem key={col.id}>
        <SidebarMenuButton asChild isActive={colActive} tooltip={col.title}>
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
            <CollectionGlyph col={col} />
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
  }

  // Collapsed icon rail: collections don't shrink to single letters (a letter alone is a
  // cheap object glyph). Instead one "Collections" icon opens a flyout listing them by
  // real name — full access without the letter tiles.
  const renderCollapsedCollections = () => (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip="Collections"
            data-testid="sidebar-collections-flyout"
            className="text-muted-foreground hover:text-foreground"
          >
            <Icon name="collections" />
            <span>Collections</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="max-h-96 w-56 overflow-auto">
          {topCollections.length === 0 && (
            <DropdownMenuItem disabled>No collections yet</DropdownMenuItem>
          )}
          {topCollections.map((col) => (
            <DropdownMenuItem
              key={col.id}
              data-testid={`flyout-collection-${col.id}`}
              onSelect={() => {
                closeMobile()
                nav({ to: "/", search: { collection: col.id } })
              }}
              className="gap-2"
            >
              <CollectionGlyph col={col} />
              <span className="min-w-0 flex-1 truncate">{col.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )

  // Session still resolving → the neutral rail silhouette, so we never flash the
  // anon rail before an authed user's data lands (in-app navs have `me` cached).
  if (loading) return <RailSkeleton />

  return (
    <Sidebar collapsible="icon" variant="inset">
      <RailHeader showSearch />
      <SidebarContent>
        {/* TIER 1 — primary navigation: the whole library at a glance, plus the
            people directory. The rail's home base; it carries no section label
            because it IS the top of the rail. */}
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
              <NavItem
                icon="favorites"
                label="Favorites"
                count={summary?.favorites}
                to="/favorites"
                active={isFav}
                testId="sidebar-favorites"
              />
              {/* Shared with you — a durable named feed (things others gave you access to),
                  a peer of the feeds above; not a home strip (that's the whole IA move). */}
              <NavItem
                icon="share"
                label="Shared with you"
                to="/shared"
                active={onShared}
                testId="nav-shared"
              />
              {/* People — who you follow, plus a way to find the people you work with.
                  Folds the old /following feed in as this tab's default (people you
                  follow); the artifact activity feed lives on at /following, unlinked. */}
              <NavItem
                icon="user"
                label="People"
                to="/people"
                active={onPeople}
                testId="nav-people"
              />
              <NavItem
                icon="context"
                label="Contexts"
                to="/contexts"
                active={onContexts}
                testId="nav-contexts"
              />
              <NavItem
                icon="brandprint"
                label="Brandprint"
                to="/brandprint"
                active={onBrandprint}
                testId="nav-brandprint"
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* TIER 2 — your library: the things you've organized. Each list carries a
            mono eyebrow, so the section labels do the tier-separating work (no
            divider needed between the eyebrowed groups). Collections stay in the
            collapsed icon rail (each row keeps its kind glyph + a tooltip), so you can
            still reach a collection with the rail collapsed — the primitive auto-hides
            the label, the + action, the counts, and any nested PR list in icon mode. */}
        <SidebarGroup>
          <SidebarGroupLabel>Collections</SidebarGroupLabel>
          {/* The + stays neutral, not the accent: create-in-rail isn't a sanctioned
              ink moment. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarGroupAction
                aria-label="New collection"
                data-testid="sidebar-new-collection"
                onClick={() => setCreating((v) => !v)}
                className="text-muted-foreground hover:text-foreground"
              >
                <Icon name="plus" />
              </SidebarGroupAction>
            </TooltipTrigger>
            <TooltipContent side="right">New collection</TooltipContent>
          </Tooltip>
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
                // No text-size override: Input's base keeps 16px on touch (iOS
                // no-zoom) and steps to 14px from sm up. Hidden in the collapsed icon
                // rail (the + that opens it is hidden there too — no way to reach it).
                className="mb-1 group-data-[collapsible=icon]:hidden"
              />
            )}
            <SidebarMenu>
              {/* Collapsed icon rail: a single Collections flyout (no letter tiles).
                    Expanded: the flat collection list. */}
              {state === "collapsed" ? (
                renderCollapsedCollections()
              ) : (
                <>
                  {/* First load only — a refetch keeps the current list (no data → no
                      isPending), so switching views never flashes the collections. */}
                  {collectionsPending &&
                    RAIL_SKELETON_COLLECTIONS.map((r) => (
                      <SidebarMenuSkeleton key={r.id} showIcon width={r.w} />
                    ))}
                  {topCollections.map((col) => renderCollection(col))}
                </>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {tags.length > 0 && (
          <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Tags</SidebarGroupLabel>
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

        {/* Tools — a running sync, notifications, Settings. Pinned to the foot of
            the scroll (mt-auto); the whitespace above sets them apart, no divider. */}
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

      {/* TIER 4 — account: the identity row, pinned below the scroll. It needs no
          divider of its own — the avatar + taller row already set it apart from the
          tools directly above it. */}
      <SidebarFooter>
        <SidebarMenu>
          {/* Onboarding as a state, not a memory: the pill rides above the account
              pod until the user has activated, then retires itself (getting-started). */}
          <GettingStarted />
          <SidebarMenuItem>
            <UserPod
              workspaceLabel={workspaceLabel}
              workspaces={workspaces ?? null}
              onSwitchWorkspace={switchWorkspace}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
