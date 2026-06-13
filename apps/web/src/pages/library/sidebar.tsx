import type { ReactNode } from "react"
import { useState } from "react"
import type { Collection, Workspaces } from "@/api"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { Filter, TagCount } from "./types"
import { WorkspaceSwitcher } from "./workspace-switcher"

// A navigation row: icon + label + optional count. In rail (collapsed) mode the
// label and count are dropped and the icon centers.
function SideItem({
  icon,
  label,
  count,
  active,
  rail,
  title,
  onClick,
  testId,
}: {
  icon: ReactNode
  label: string
  count?: number
  active?: boolean
  rail?: boolean
  title?: string
  onClick: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={title ?? label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 whitespace-nowrap rounded-[9px] px-2.5 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-hover",
        active && "bg-accent text-accent-foreground hover:bg-accent",
        rail && "justify-center px-0 py-2.5",
      )}
    >
      <span className="w-[18px] shrink-0 text-center text-sm">{icon}</span>
      {!rail && <span className="overflow-hidden text-ellipsis">{label}</span>}
      {!rail && count !== undefined && (
        <span
          className={cn(
            "ml-auto font-mono text-2xs text-muted-foreground",
            active && "text-accent-foreground",
          )}
        >
          {count}
        </span>
      )}
    </button>
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

export function Sidebar({
  rail,
  drawer,
  open,
  workspace,
  workspaces,
  total,
  favCount,
  tags,
  collections,
  filter,
  onPick,
  onCreateCollection,
  onSwitchWorkspace,
  onCreateWorkspace,
  onToggleRail,
  onClose,
  onSettings,
}: {
  rail: boolean
  drawer: boolean
  open: boolean
  workspace: string
  workspaces: Workspaces | null
  total: number
  favCount: number
  tags: TagCount[]
  collections: Collection[]
  filter: Filter
  onPick: (f: Filter) => void
  onCreateCollection: (title: string) => void
  onSwitchWorkspace: (id: string) => void
  onCreateWorkspace: (name: string) => void
  onToggleRail: () => void
  onClose: () => void
  onSettings: () => void
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const submit = () => {
    const t = name.trim()
    if (t) onCreateCollection(t)
    setName("")
    setCreating(false)
  }

  return (
    <aside
      aria-label="Browse"
      className={cn(
        "flex flex-col gap-px overflow-y-auto border-r border-border bg-card py-3.5 transition-[transform,flex-basis,width] duration-200",
        drawer
          ? cn(
              "fixed inset-y-0 left-0 z-[61] w-[266px] basis-[266px] px-2.5 shadow-[0_0_44px_-10px_rgba(0,0,0,0.45)]",
              open ? "translate-x-0" : "-translate-x-[105%]",
            )
          : rail
            ? "shrink-0 basis-[62px] w-[62px] px-[9px]"
            : "shrink-0 basis-56 w-56 px-2.5",
      )}
    >
      {!rail && workspace && (
        <WorkspaceSwitcher
          label={workspace}
          workspaces={workspaces}
          onSwitch={onSwitchWorkspace}
          onCreate={onCreateWorkspace}
          onSettings={onSettings}
        />
      )}

      {!rail && <SideLabel>Library</SideLabel>}
      <SideItem
        icon="⊞"
        label="All artifacts"
        count={total}
        rail={rail}
        active={filter.kind === "all"}
        testId="sidebar-all"
        onClick={() => onPick({ kind: "all" })}
      />
      <SideItem
        icon="★"
        label="Favorites"
        count={favCount}
        rail={rail}
        active={filter.kind === "favorites"}
        testId="sidebar-favorites"
        onClick={() => onPick({ kind: "favorites" })}
      />

      {!rail && (
        <SideLabel
          action={
            <button
              type="button"
              data-testid="sidebar-new-collection"
              onClick={() => setCreating((v) => !v)}
              title="New collection"
              aria-label="New collection"
              className="cursor-pointer text-sm text-primary"
            >
              ＋
            </button>
          }
        >
          Collections
        </SideLabel>
      )}
      {!rail && creating && (
        <Input
          value={name}
          autoFocus
          data-testid="sidebar-new-collection-input"
          placeholder="Collection name…"
          aria-label="Collection name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit()
            if (e.key === "Escape") {
              setCreating(false)
              setName("")
            }
          }}
          onBlur={submit}
          className="mx-1 mb-1.5 mt-0.5 h-auto px-2.5 py-1.5 text-sm"
        />
      )}
      {collections.map((col) => (
        <SideItem
          key={col.id}
          icon="📁"
          label={col.title}
          count={col.count}
          rail={rail}
          active={filter.kind === "collection" && filter.id === col.id}
          testId={`sidebar-collection-${col.id}`}
          onClick={() => onPick({ kind: "collection", id: col.id, title: col.title })}
        />
      ))}

      {tags.length > 0 && (
        <>
          {!rail && <SideLabel>Tags</SideLabel>}
          {tags.map(({ tag, count }) => (
            <SideItem
              key={tag}
              icon="#"
              label={tag}
              count={count}
              rail={rail}
              active={filter.kind === "tag" && filter.tag === tag}
              testId={`sidebar-tag-${tag}`}
              onClick={() => onPick({ kind: "tag", tag })}
            />
          ))}
        </>
      )}

      <div className="mt-auto flex flex-col gap-px pt-2">
        <SideItem
          icon="⚙"
          label="Settings"
          rail={rail}
          testId="sidebar-settings"
          onClick={onSettings}
        />
        {drawer ? (
          <SideItem icon="✕" label="Close" testId="sidebar-close" onClick={onClose} />
        ) : (
          <SideItem
            icon={rail ? "»" : "«"}
            label="Collapse"
            rail={rail}
            title={rail ? "Expand sidebar" : "Collapse sidebar"}
            testId="sidebar-collapse"
            onClick={onToggleRail}
          />
        )}
      </div>
    </aside>
  )
}
