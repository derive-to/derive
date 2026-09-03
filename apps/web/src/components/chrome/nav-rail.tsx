import { useQuery } from "@tanstack/react-query"
import { Link, useLocation } from "@tanstack/react-router"
import type { Collection } from "@/api"
import { Icon, type IconName } from "@/components/icons"
import { Logo } from "@/components/shared/logo"
import { Kbd } from "@/components/ui/kbd"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAuth } from "@/ctx"
import { useBootGate } from "@/lib/bootstrap"
import { getMonogram } from "@/lib/initials"
import {
  collectionsQuery,
  summaryQuery,
  workspaceActivityQuery,
  workspaceSettingsQuery,
  workspacesQuery,
} from "@/lib/queries"
import { useBrandprintCollectionIds } from "@/lib/use-brandprint-ids"
import { cn } from "@/lib/utils"
import type { LibrarySearch } from "@/pages/library/types"
import { GettingStarted } from "./getting-started"
import { NotificationBell } from "./notification-bell"
import { useShell } from "./shell-context"
import { UserPod } from "./user-pod"

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
/** The Activity page's row, beside Notifications: the count is the reviews waiting on
 *  this person across the workspace — the one number that is an ask, not news. */
function ActivityRow() {
  const loc = useLocation()
  const { me } = useAuth()
  const { setOpenMobile } = useSidebar()
  const { data } = useQuery({ ...workspaceActivityQuery(), enabled: !!me })
  const waiting = me
    ? (data?.rounds.filter((r) => r.state === "pending" && r.requested_for === me.id).length ?? 0)
    : 0
  const active = loc.pathname === "/activity"
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip="Activity">
        <Link
          to="/activity"
          data-testid="menu-activity"
          aria-current={active ? "page" : undefined}
          onClick={() => setOpenMobile(false)}
          className={ROW_ICON}
        >
          <RowGlyph icon="history" label="Activity" count={waiting || undefined} />
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

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

// A fixed-route nav row. Unlike FilterItem, these destinations are separate product
// surfaces rather than ways to narrow the library.
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
  to: "/following" | "/contexts" | "/skills" | "/workflows" | "/templates" | "/chat"
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

// A collection's leading glyph is a monochrome monogram tile. It differentiates
// shelves without turning the navigation into a second file browser.
function CollectionGlyph({ col }: { col: Collection }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-sidebar-foreground/10 font-mono text-2xs font-medium text-muted-foreground group-hover/menu-button:text-foreground group-data-[active=true]/menu-button:text-foreground"
    >
      {getMonogram(col.title)}
    </span>
  )
}

// One collection row. It carries a tooltip so the collapsed icon rail still names it.
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
          aria-label="Derive home"
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
// (collections) → tools → account — separated by whitespace, not dividers.
export function NavRail() {
  const { switchWorkspace } = useShell()
  const { me } = useAuth()
  // Nav data read straight from react-query (deduped with the loaders that warm
  // it). enabled on a session so an anon never hits the authed endpoints.
  // Gated on the boot batch: /v1/bootstrap seeds these caches in ONE request with the
  // sidebar's whole read set; the gate opens the moment the batch settles either way,
  // so a failed batch just means these run themselves (the pre-batch behavior).
  // `workspaces` below is NOT in the batch (token/grant-bound semantics differ) and
  // keeps its own timing.
  const bootGate = useBootGate()
  const { data: summary } = useQuery({ ...summaryQuery(), enabled: !!me && bootGate })
  const { data: collections = [] } = useQuery({
    ...collectionsQuery(),
    enabled: !!me && bootGate,
  })
  const { data: workspaces } = useQuery({ ...workspacesQuery(), enabled: !!me })
  // Seeded by the same boot batch as the counts above, so the Chat row costs no extra request.
  const { data: settings } = useQuery({
    ...workspaceSettingsQuery(),
    enabled: !!me && bootGate,
  })
  // The pod subtitle: "Personal" for the auto-provisioned workspace (its stored
  // name is provisioning plumbing), else the summary's workspace name.
  const activeWs = workspaces?.workspaces.find((w) => w.id === workspaces.active)
  const workspaceLabel = activeWs?.personal ? "Personal" : (summary?.workspace ?? "")
  const { setOpenMobile } = useSidebar()
  const loc = useLocation()
  const search = loc.search as LibrarySearch
  const onLibrary = loc.pathname === "/"
  // Feeds are routes now; the home library reads "active > All" only when no collection
  // filter narrows it. (A ?query= search doesn't change which feed you're in.)
  const isAll = onLibrary && !search.collection
  const onContexts = loc.pathname.startsWith("/contexts") || loc.pathname.startsWith("/agents")
  const onWorkflows = loc.pathname.startsWith("/workflows")
  const onSkills = loc.pathname.startsWith("/skills")
  const onTemplates = loc.pathname.startsWith("/templates")
  const onSettings = loc.pathname.startsWith("/settings")
  const onChat = loc.pathname.startsWith("/chat")
  // Chat is on by default, so the row hides only once settings have RESOLVED and said otherwise
  // — `undefined` (still loading, or the read failed) keeps the row rather than blinking it out
  // and back on every cold boot. It rides the boot batch the rail already waits for, so this
  // costs no request of its own.
  const chatOn = settings ? settings.chatBeta === true : true

  // Picking a destination on mobile closes the drawer (no-op on desktop).
  const closeMobile = () => setOpenMobile(false)

  // Brandprint-pointed collections are managed in Settings → Brandprint, not here — hiding
  // them keeps the docs and their options in one place (see use-brandprint-ids).
  const brandprintIds = useBrandprintCollectionIds()
  const visibleCollections = collections.filter((col) => !brandprintIds.has(col.id))

  // Only starred collections reach the rail; the rest live in the Artifacts page's
  // Collections view. Every collection used to be listed here, which grew unbounded.
  //
  const starredCollections = visibleCollections.filter((col) => col.starred)

  // Collapsed icon rail: collections don't shrink to single letters (a letter alone is a
  // cheap object glyph). Instead one "Collections" icon opens a flyout listing them by
  // real name — full access without the letter tiles.

  return (
    <Sidebar collapsible="icon" variant="inset">
      <RailHeader showSearch />
      <SidebarContent>
        {/* TIER 1 — primary navigation. The rail's home base carries no section
            label because it is the top of the rail. */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <FilterItem
                icon="all"
                label="Artifacts"
                count={summary?.total}
                search={{}}
                active={isAll}
                testId="sidebar-all"
              />
              <NavItem
                icon="templates"
                label="Templates"
                to="/templates"
                active={onTemplates}
                testId="nav-templates"
              />
              <NavItem
                icon="skill"
                label="Skills"
                to="/skills"
                active={onSkills}
                testId="nav-skills"
              />
              <NavItem
                icon="context"
                label="Contexts"
                to="/contexts"
                active={onContexts}
                testId="nav-contexts"
              />
              <NavItem
                icon="workflow"
                label="Workflows"
                to="/workflows"
                active={onWorkflows}
                testId="nav-workflows"
              />
              {/* CHAT CLOSES THE TIER. A real route, like every other row here — it goes straight
                  to the full conversation (history, Stop, model choice) instead of the palette's
                  lightweight answer view, which is the AskButton's surface (search boxes), not
                  this row's. It sits after the feeds rather than above them, where it would push
                  the library itself down a line. Hidden only once settings have actually said
                  chat is off; chat defaults on, so an unresolved read must not blink the row out
                  and back. */}
              {chatOn && (
                <NavItem
                  icon="sparkles"
                  label="Chat"
                  to="/chat"
                  active={onChat}
                  testId="nav-chat"
                />
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Starred — the shelves you pinned, and the rail's ONLY collection list. Every
            collection used to be enumerated here, which grew until the navigation was a
            file browser; they live in the library's Collections view now, and this is
            the handful you chose. Absent entirely until you star something, so an
            empty heading never consumes space. */}
        {starredCollections.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel data-testid="sidebar-starred">Starred</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {starredCollections.map((col) => (
                  <CollectionRow
                    key={col.id}
                    col={col}
                    active={onLibrary && search.collection === col.id}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Tools — notifications and Settings. Pinned to the foot of
            the scroll (mt-auto); the whitespace above sets them apart, no divider. */}
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <NotificationBell />
              <ActivityRow />
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
