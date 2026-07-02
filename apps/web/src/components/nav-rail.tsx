import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { useAuth } from "@/ctx"
import { prTitle } from "@/lib/pr"
import { useIsMobile } from "@/lib/use-is-mobile"
import { cn } from "@/lib/utils"
import type { LibrarySearch } from "@/pages/library/types"
import { Icon, type IconName } from "./icons"
import { ROW_ACTIVE, ROW_BASE, ROW_RAIL } from "./nav-row"
import { NotificationBell } from "./notification-bell"
import { Logo } from "./shared/logo"
import { useShell } from "./shell-context"
import {
  Sidebar,
  SidebarBody,
  SidebarFooter,
  SidebarHeader,
  SidebarHeading,
  SidebarItem,
  SidebarLabel,
  SidebarSection,
  SidebarSpacer,
} from "./sidebar"
import { SyncChip } from "./sync-chip"
import { UserPod } from "./user-pod"

// How many of a repo's PR previews to list inline in the sidebar before collapsing
// the rest behind a "+N more" link (which opens the repo's in-collection PR viewer).
// Keeps the rail readable when a repo has dozens of open PRs.
const MAX_SIDEBAR_PRS = 5

// One filter-nav row: sets the library filter via URL search. Expanded mode
// rides the SidebarItem primitive; collapsed (rail) mode drops the label +
// count and renders the icon-only row grammar from nav-row.ts (which keeps
// the tick override at the rail's p-2 gutter).
function SideItem({
  icon,
  label,
  count,
  search,
  active,
  collapsed,
  testId,
  onClick,
}: {
  icon: IconName
  label: string
  count?: number
  search: LibrarySearch
  active: boolean
  collapsed: boolean
  testId?: string
  onClick?: () => void
}) {
  if (collapsed)
    return (
      <Link
        to="/"
        search={search}
        title={label}
        aria-label={label}
        data-testid={testId}
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        className={cn(ROW_BASE, active && ROW_ACTIVE, ROW_RAIL)}
      >
        <Icon name={icon} size={18} />
      </Link>
    )
  return (
    <SidebarItem
      to="/"
      search={search}
      title={label}
      aria-label={label}
      data-testid={testId}
      current={active}
      onClick={onClick}
    >
      <Icon name={icon} />
      <SidebarLabel>{label}</SidebarLabel>
      {/* Zero is noise — a count earns its ink only once it's nonzero. */}
      {(count ?? 0) > 0 && (
        <span className="font-mono text-2xs tabular-nums text-muted-foreground">{count}</span>
      )}
    </SidebarItem>
  )
}

// The persistent left nav — the app's only desktop chrome (there is no global
// top bar). Rebuilt on the Catalyst sidebar primitives (./sidebar): a
// SidebarHeader (brand wordmark + collapse toggle + the ⌘K launcher), a
// SidebarBody — the ONE scroll region — of nav rows (All / Favorites /
// Following / People, collections with inline create, tags, then the utility
// rows — sync, notifications, Settings — spacer-pinned to the bottom), and a
// pinned SidebarFooter holding only the account/workspace pod. Collapses to an
// icon rail on desktop and becomes a floating off-canvas drawer card on mobile.
export function NavRail() {
  const {
    collapsed,
    toggleCollapsed,
    drawerOpen,
    setDrawerOpen,
    summary,
    collections,
    workspaces,
    switchWorkspace,
    refreshCollections,
    setPaletteOpen,
  } = useShell()
  const { me } = useAuth()
  const isMobile = useIsMobile()
  const nav = useNavigate()
  const loc = useLocation()
  const search = loc.search as LibrarySearch
  const onLibrary = loc.pathname === "/"
  const isAll = onLibrary && !search.f && !search.scope && !search.tag && !search.collection
  const isFav = onLibrary && search.f === "favorites"
  const isFollowing = onLibrary && search.scope === "following"
  const onPeople = loc.pathname === "/people"
  const tags = summary?.tags ?? []
  // Full content in the mobile drawer; only the avatar in the collapsed desktop rail.
  const railMode = collapsed && !isMobile

  // Picking a destination on mobile closes the drawer.
  const closeDrawer = () => setDrawerOpen(false)

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
      setDrawerOpen(false)
      nav({ to: "/", search: { collection: col.id } })
    } catch {
      /* surfaced on the library on next action */
    }
  }

  // Flush shell: the rail sits on the canvas itself, separated by the hairline.
  // The sidebar primitives own the internal anatomy — header/body/footer each
  // carry the gutter (p-4; p-2 in the rail), the body is the one scroll region
  // — so the active row's edge tick renders inside the body's own padding
  // gutter without being clipped, and the header + footer stay pinned.
  const asideClass = cn(
    "flex flex-col border-r border-border bg-background transition-[transform,flex-basis,width] duration-200",
    isMobile
      ? cn(
          // A floating drawer card. Sits BELOW the Radix overlay layer (z-50) so
          // menus opened from inside the drawer — the workspace switcher, the
          // command palette — render above it, not behind it. Still above page
          // content + the backdrop.
          "fixed inset-y-2 left-2 z-45 w-[266px] basis-[266px] rounded-xl shadow-[var(--shadow-pop)] ring-1 ring-foreground/10",
          drawerOpen ? "translate-x-0" : "-translate-x-[105%]",
        )
      : collapsed
        ? "w-[62px] shrink-0 basis-[62px]"
        : "w-64 shrink-0 basis-64",
  )

  // HEADER — shared by the signed-in and anon rails: the brand wordmark (the
  // app's one wordmark now that the top bar is gone), the collapse toggle
  // (desktop only — app-shell renders its own `library-menu` on mobile, and the
  // testid must exist exactly once), and the ⌘K launcher (signed-in only).
  const header = railMode ? (
    <SidebarHeader className="items-center gap-1 p-2">
      <Link
        to="/"
        title="Derive — home"
        aria-label="Derive — home"
        className="flex size-8 items-center justify-center rounded-lg text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Logo size={20} />
      </Link>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="library-menu"
        aria-label="Expand sidebar"
        title="Toggle sidebar"
        onClick={toggleCollapsed}
      >
        <Icon name="sidebar" size={16} />
      </Button>
      {/* The launcher collapses to a plain icon row in the rail. */}
      {me && (
        <button
          type="button"
          onClick={() => {
            setDrawerOpen(false)
            setPaletteOpen(true)
          }}
          title="Search (⌘K)"
          aria-label="Search (⌘K)"
          data-testid="open-command-palette"
          className={cn(ROW_BASE, ROW_RAIL)}
        >
          <Icon name="search" size={18} />
        </button>
      )}
    </SidebarHeader>
  ) : (
    <SidebarHeader>
      {/* Brand identity row, Nemonic-style air: px-2 pt-1 pb-3 inside the p-4
          gutter. The wordmark is the voice register: the mark stays
          currentColor; only the word itself is serif. */}
      <div className="flex items-center px-2 pt-1 pb-3">
        <Link
          to="/"
          onClick={closeDrawer}
          className="flex min-w-0 items-center gap-2.5 rounded-md text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Logo />
          <span className="font-serif text-lg font-medium tracking-tight">Derive</span>
        </Link>
        {!isMobile && (
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="library-menu"
            aria-label="Collapse sidebar"
            title="Toggle sidebar"
            onClick={toggleCollapsed}
            className="ml-auto"
          >
            <Icon name="sidebar" size={16} />
          </Button>
        )}
      </div>
      {/* The palette launcher reads as a search FIELD (Linear-style), not
          another nav row — the affordance is "type to find anything", with the
          shortcut on it. Absent for anon (nothing to search). */}
      {me && (
        <button
          type="button"
          onClick={() => {
            setDrawerOpen(false)
            setPaletteOpen(true)
          }}
          title="Search (⌘K)"
          aria-label="Search (⌘K)"
          data-testid="open-command-palette"
          className="flex h-8 w-full items-center gap-2 rounded-md bg-secondary px-2.5 text-left ring-1 ring-inset ring-input hover:bg-hover hover:ring-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Icon name="search" size={16} className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
      )}
    </SidebarHeader>
  )

  // Anonymous visitor on a shared public artifact. There's no workspace to
  // navigate, so the rail becomes the conversion surface — a single path to
  // making their own (Figma/Notion-style viral loop). The artifact itself stays
  // fully view-only; this is the only nav an anon ever sees.
  if (!me)
    return (
      <aside aria-label="Navigation" className={asideClass}>
        <Sidebar>
          {header}
          <SidebarBody className={railMode ? "p-2" : undefined}>
            {railMode ? (
              <Link
                to="/login"
                search={{ signup: true }}
                title="Sign up for Derive"
                data-testid="anon-signup"
                // The row grammar mutes icons at rest; this one is the amber
                // conversion moment, so re-ink the glyph explicitly.
                className={cn(ROW_BASE, ROW_RAIL, "text-primary [&_svg]:text-primary")}
              >
                <Icon name="plus" size={18} />
              </Link>
            ) : (
              <div className="flex flex-1 flex-col">
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
                    <Link to="/login" search={{ signup: true }} onClick={closeDrawer}>
                      Sign up free
                    </Link>
                  </Button>
                </div>
                <p className="mt-3 px-1 text-xs text-muted-foreground">
                  Already have an account?{" "}
                  <Link
                    to="/login"
                    onClick={closeDrawer}
                    data-testid="anon-login"
                    className="font-medium text-primary hover:underline"
                  >
                    Log in
                  </Link>
                </p>
              </div>
            )}
          </SidebarBody>
        </Sidebar>
      </aside>
    )

  return (
    <aside aria-label="Navigation" className={asideClass}>
      <Sidebar>
        {header}
        <SidebarBody className={railMode ? "p-2" : undefined}>
          <SidebarSection>
            <SideItem
              icon="all"
              label="All artifacts"
              count={summary?.total}
              search={{}}
              active={isAll}
              collapsed={railMode}
              testId="sidebar-all"
              onClick={closeDrawer}
            />
            <SideItem
              icon="favorites"
              label="Favorites"
              count={summary?.favorites}
              search={{ f: "favorites" }}
              active={isFav}
              collapsed={railMode}
              testId="sidebar-favorites"
              onClick={closeDrawer}
            />
            <SideItem
              icon="following"
              label="Following"
              search={{ scope: "following" }}
              active={isFollowing}
              collapsed={railMode}
              testId="nav-following"
              onClick={closeDrawer}
            />
            {/* People directory — a real route, not a library filter, so it's its
                own row (SideItem always links to "/"). Find + follow people. */}
            {railMode ? (
              <Link
                to="/people"
                title="People"
                aria-label="People"
                data-testid="nav-people"
                aria-current={onPeople ? "page" : undefined}
                onClick={closeDrawer}
                className={cn(ROW_BASE, onPeople && ROW_ACTIVE, ROW_RAIL)}
              >
                <Icon name="user" size={18} />
              </Link>
            ) : (
              <SidebarItem
                to="/people"
                title="People"
                aria-label="People"
                data-testid="nav-people"
                current={onPeople}
                onClick={closeDrawer}
              >
                <Icon name="user" />
                <SidebarLabel>People</SidebarLabel>
              </SidebarItem>
            )}
          </SidebarSection>

          {!railMode && (
            <SidebarSection>
              {/* The mono eyebrow with the create action beside it — the + stays
                  neutral, not amber: create-in-rail isn't a sanctioned amber
                  moment; the rail's only amber is the active tick + unread dot. */}
              <div className="mb-1 flex items-center px-2">
                <SidebarHeading className="mb-0 flex-1 px-0">Collections</SidebarHeading>
                <button
                  type="button"
                  data-testid="sidebar-new-collection"
                  onClick={() => setCreating((v) => !v)}
                  title="New collection"
                  aria-label="New collection"
                  className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <Icon name="plus" size={14} />
                </button>
              </div>
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
                  className="mx-1 mb-1 mt-0.5 h-8 text-sm"
                />
              )}
              {topCollections.map((col) => {
                const childPrs = childPrsByRepo.get(col.id)
                if (!childPrs || childPrs.length === 0)
                  return (
                    <SideItem
                      key={col.id}
                      icon="collection"
                      label={col.title}
                      count={col.count}
                      search={{ collection: col.id }}
                      active={onLibrary && search.collection === col.id}
                      collapsed={false}
                      testId={`sidebar-collection-${col.id}`}
                      onClick={closeDrawer}
                    />
                  )
                const repoCollapsed = collapsedRepos.has(col.id)
                return (
                  <div key={col.id} className="flex flex-col gap-0.5">
                    <div className="relative">
                      <SidebarItem
                        to="/"
                        search={{ collection: col.id }}
                        title={col.title}
                        aria-label={col.title}
                        data-testid={`sidebar-collection-${col.id}`}
                        current={onLibrary && search.collection === col.id}
                        onClick={closeDrawer}
                        // Clearance for the absolutely-positioned fold toggle.
                        className="pr-9"
                      >
                        <Icon name="collection" />
                        <SidebarLabel>{col.title}</SidebarLabel>
                        {col.count > 0 && (
                          <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                            {col.count}
                          </span>
                        )}
                      </SidebarItem>
                      <button
                        type="button"
                        onClick={() => toggleRepo(col.id)}
                        aria-expanded={!repoCollapsed}
                        aria-label={
                          repoCollapsed
                            ? `Show ${childPrs.length} pull request${childPrs.length === 1 ? "" : "s"}`
                            : "Hide pull requests"
                        }
                        data-testid={`sidebar-collection-${col.id}-toggle`}
                        className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <Icon
                          name="caret"
                          size={14}
                          className={cn("transition-transform", repoCollapsed && "-rotate-90")}
                        />
                      </button>
                    </div>
                    {!repoCollapsed && (
                      <>
                        {childPrs.slice(0, MAX_SIDEBAR_PRS).map((pr) => (
                          <div key={pr.id} className="pl-3.5">
                            <SideItem
                              icon="review"
                              label={
                                pr.prNumber
                                  ? `#${pr.prNumber} ${prTitle(pr.title, pr.prNumber)}`
                                  : prTitle(pr.title)
                              }
                              count={pr.count}
                              search={{ collection: pr.id }}
                              active={onLibrary && search.collection === pr.id}
                              collapsed={false}
                              testId={`sidebar-collection-${pr.id}`}
                              onClick={closeDrawer}
                            />
                          </div>
                        ))}
                        {childPrs.length > MAX_SIDEBAR_PRS && (
                          <SidebarItem
                            to="/"
                            search={{ collection: col.id }}
                            data-testid={`sidebar-collection-${col.id}-more-prs`}
                            onClick={closeDrawer}
                            // A de-emphasized meta row, not a full nav item —
                            // override both breakpoints of the base scale.
                            className="py-1.5 pl-9 text-xs font-medium text-muted-foreground hover:text-foreground sm:py-1.5 sm:text-xs"
                          >
                            +{childPrs.length - MAX_SIDEBAR_PRS} more pull request
                            {childPrs.length - MAX_SIDEBAR_PRS === 1 ? "" : "s"}
                          </SidebarItem>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </SidebarSection>
          )}

          {!railMode && tags.length > 0 && (
            <SidebarSection>
              <SidebarHeading>Tags</SidebarHeading>
              {tags.map(({ tag, count }) => (
                <SideItem
                  key={tag}
                  icon="tag"
                  label={tag}
                  count={count}
                  search={{ tag }}
                  active={onLibrary && search.tag === tag}
                  collapsed={false}
                  testId={`sidebar-tag-${tag}`}
                  onClick={closeDrawer}
                />
              ))}
            </SidebarSection>
          )}

          {/* Spacer: pins the utility rows (sync, notifications, Settings) to the
              bottom of the body when the nav is short, without pulling them out of
              the scroll flow when the nav is long. */}
          <SidebarSpacer />
          <SidebarSection>
            <SyncChip collapsed={railMode} />
            <NotificationBell collapsed={railMode} />
            {railMode ? (
              <Link
                to="/settings"
                data-testid="menu-settings"
                title="Settings"
                aria-current={loc.pathname === "/settings" ? "page" : undefined}
                onClick={closeDrawer}
                className={cn(ROW_BASE, loc.pathname === "/settings" && ROW_ACTIVE, ROW_RAIL)}
              >
                <Icon name="settings" size={18} />
              </Link>
            ) : (
              <SidebarItem
                to="/settings"
                data-testid="menu-settings"
                title="Settings"
                current={loc.pathname === "/settings"}
                onClick={closeDrawer}
              >
                <Icon name="settings" />
                <SidebarLabel>Settings</SidebarLabel>
              </SidebarItem>
            )}
          </SidebarSection>
        </SidebarBody>

        {/* FOOTER — pinned below the scroll: one calm identity row, nothing else
            (utility rows live pinned at the body's foot, above). */}
        <SidebarFooter className={railMode ? "p-2" : undefined}>
          <UserPod
            rail={railMode}
            workspaceLabel={summary?.workspace ?? ""}
            workspaces={workspaces}
            onSwitchWorkspace={switchWorkspace}
          />
        </SidebarFooter>
      </Sidebar>
    </aside>
  )
}
