import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import { api } from "@/api"
import { Input } from "@/components/ui/input"
import { useIsMobile } from "@/lib/use-is-mobile"
import { cn } from "@/lib/utils"
import type { LibrarySearch } from "@/pages/library/types"
import { Icon, type IconName } from "./icons"
import { NotificationBell } from "./notification-bell"
import { useShell } from "./shell-context"
import { UserPod } from "./user-pod"

// Shared nav-row look (also used by NotificationBell + the Settings link so the
// whole rail reads as one list).
export const ROW_BASE =
  "flex w-full items-center gap-2.5 whitespace-nowrap rounded-[9px] px-2.5 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-hover"
export const ROW_ACTIVE = "bg-accent text-accent-foreground hover:bg-accent"
export const ROW_RAIL = "justify-center px-0 py-2.5"

// One filter-nav row: a Link that sets the library filter via URL search. In
// collapsed (rail) mode it drops the label + count and centers the icon.
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
  return (
    <Link
      to="/"
      search={search}
      title={label}
      data-testid={testId}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(ROW_BASE, active && ROW_ACTIVE, collapsed && ROW_RAIL)}
    >
      <span className="flex w-[18px] shrink-0 items-center justify-center">
        <Icon name={icon} size={18} />
      </span>
      {!collapsed && <span className="overflow-hidden text-ellipsis">{label}</span>}
      {!collapsed && count !== undefined && (
        <span
          className={cn(
            "ml-auto font-mono text-2xs text-muted-foreground",
            active && "text-accent-foreground",
          )}
        >
          {count}
        </span>
      )}
    </Link>
  )
}

function SideLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center px-2 pb-1.5 pt-3 font-mono text-2xs uppercase tracking-[0.07em] text-muted-foreground">
      <span className="flex-1">{children}</span>
      {action}
    </div>
  )
}

// The persistent left nav: All / Favorites always visible (so you can jump to a
// favorite from anywhere), collections (with inline create) + tags when expanded,
// then a foot group of Notifications + Settings + the account/workspace pod.
// Collapses to an icon rail on desktop and becomes an off-canvas drawer on mobile.
export function NavRail() {
  const {
    collapsed,
    drawerOpen,
    setDrawerOpen,
    summary,
    collections,
    workspaces,
    switchWorkspace,
    createWorkspace,
    refreshCollections,
    setPaletteOpen,
  } = useShell()
  const isMobile = useIsMobile()
  const nav = useNavigate()
  const loc = useLocation()
  const search = loc.search as LibrarySearch
  const onLibrary = loc.pathname === "/"
  const isAll = onLibrary && !search.f && !search.tag && !search.collection
  const isFav = onLibrary && search.f === "favorites"
  const tags = summary?.tags ?? []
  // Full content in the mobile drawer; only the avatar in the collapsed desktop rail.
  const railMode = collapsed && !isMobile

  // Picking a destination on mobile closes the drawer.
  const closeDrawer = () => setDrawerOpen(false)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
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

  return (
    <aside
      aria-label="Navigation"
      className={cn(
        "flex flex-col gap-px overflow-y-auto border-r border-border bg-card py-3.5 transition-[transform,flex-basis,width] duration-200",
        isMobile
          ? cn(
              "fixed inset-y-0 left-0 z-[61] w-[266px] basis-[266px] px-2.5 shadow-[0_0_44px_-10px_rgba(0,0,0,0.45)]",
              drawerOpen ? "translate-x-0" : "-translate-x-[105%]",
            )
          : collapsed
            ? "w-[62px] shrink-0 basis-[62px] px-[9px]"
            : "w-56 shrink-0 basis-56 px-2.5",
      )}
    >
      <div className="flex flex-1 flex-col gap-px">
        <button
          type="button"
          onClick={() => {
            setDrawerOpen(false)
            setPaletteOpen(true)
          }}
          title="Search (⌘K)"
          data-testid="open-command-palette"
          className={cn(ROW_BASE, railMode && ROW_RAIL)}
        >
          <span className="flex w-[18px] shrink-0 items-center justify-center">
            <Icon name="search" size={18} />
          </span>
          {!railMode && <span className="flex-1 overflow-hidden text-ellipsis">Search</span>}
          {!railMode && (
            <kbd className="rounded border border-border-soft bg-muted px-1.5 py-px font-mono text-2xs text-muted-foreground">
              ⌘K
            </kbd>
          )}
        </button>
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

        {!railMode && (
          <SideLabel
            action={
              <button
                type="button"
                data-testid="sidebar-new-collection"
                onClick={() => setCreating((v) => !v)}
                title="New collection"
                aria-label="New collection"
                className="cursor-pointer text-primary"
              >
                <Icon name="plus" size={14} />
              </button>
            }
          >
            Collections
          </SideLabel>
        )}
        {!railMode && creating && (
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
        {!railMode &&
          collections.map((col) => (
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
          ))}

        {!railMode && tags.length > 0 && <SideLabel>Tags</SideLabel>}
        {!railMode &&
          tags.map(({ tag, count }) => (
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
      </div>

      <div className="mt-auto flex flex-col gap-px border-t border-border-soft pt-2">
        <NotificationBell collapsed={railMode} />
        <Link
          to="/settings"
          data-testid="menu-settings"
          title="Settings"
          aria-current={loc.pathname === "/settings" ? "page" : undefined}
          onClick={closeDrawer}
          className={cn(ROW_BASE, loc.pathname === "/settings" && ROW_ACTIVE, railMode && ROW_RAIL)}
        >
          <span className="flex w-[18px] shrink-0 items-center justify-center">
            <Icon name="settings" size={18} />
          </span>
          {!railMode && <span className="overflow-hidden text-ellipsis">Settings</span>}
        </Link>
        <UserPod
          rail={railMode}
          workspaceLabel={summary?.workspace ?? ""}
          workspaces={workspaces}
          onSwitchWorkspace={switchWorkspace}
          onCreateWorkspace={createWorkspace}
        />
      </div>
    </aside>
  )
}
