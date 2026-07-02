import { ChevronRight, Folder } from "lucide-react"
import { useMemo, useState } from "react"
import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { useFollows } from "@/lib/use-follows"
import { cn } from "@/lib/utils"
import { ArtifactRow } from "./artifact-row"

const dirOf = (p: string): string => {
  const i = p.lastIndexOf("/")
  return i < 0 ? "" : p.slice(0, i)
}

interface Handlers {
  onOpen: (a: Artifact) => void
  onToggleFavorite: (a: Artifact) => void
  onPickTag: (tag: string) => void
  onPickAuthor: (login: string) => void
  onPrefetch: (a: Artifact) => void
}

/**
 * The opt-in folder view for a mirrored repo: artifacts grouped by their `source_path`
 * folder, the tree ordered alphabetically (a file-explorer mental model) while items
 * within a folder keep the incoming order (most-recently-updated first). Collapsible.
 * The parent loads the whole collection up front, so every folder is complete.
 */
export function FolderGroups({
  items,
  hasNextPage,
  isFetchingNextPage,
  ...handlers
}: {
  items: Artifact[]
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
} & Handlers) {
  // Follow state for the per-folder toggle: one query for the whole tree, derived
  // into the isFollowingPath check + the togglePath action each header drives.
  const { isFollowingPath, togglePath } = useFollows()
  const groups = useMemo(() => {
    const m = new Map<string, Artifact[]>()
    for (const a of items) {
      const key = a.source_path ? dirOf(a.source_path) || "/" : "Other"
      const arr = m.get(key)
      if (arr) arr.push(a)
      else m.set(key, [a])
    }
    // Folders alphabetical (structural tree); items keep the incoming recency order.
    return [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, arts]) => ({
        dir,
        items: arts,
      }))
  }, [items])

  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <FolderSection
          key={g.dir}
          dir={g.dir}
          items={g.items}
          following={isFollowingPath(g.dir)}
          onToggleFollow={() => togglePath(g.dir)}
          {...handlers}
        />
      ))}
      {(hasNextPage || isFetchingNextPage) && (
        <div className="py-2 text-center text-sm text-muted-foreground">Loading the rest…</div>
      )}
    </div>
  )
}

function FolderSection({
  dir,
  items,
  following,
  onToggleFollow,
  ...handlers
}: {
  dir: string
  items: Artifact[]
  following: boolean
  onToggleFollow: () => void
} & Handlers) {
  const [open, setOpen] = useState(true)
  // Only a real repo path prefix is followable — the "/" repo-root and the "Other"
  // bucket (non-synced artifacts) aren't path prefixes the feed can match.
  const followable = dir !== "/" && dir !== "Other"
  return (
    <div className="group/folder">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`folder-toggle-${dir}`}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 text-left outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono text-sm font-medium text-foreground">{dir}</span>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            · {items.length}
          </span>
        </button>
        {followable && (
          <button
            type="button"
            data-testid={`folder-follow-${dir}`}
            aria-pressed={following}
            title={
              following ? `Unfollow ${dir}/` : `Follow ${dir}/ to see its changes in your feed`
            }
            onClick={onToggleFollow}
            className={cn(
              // The followed state is a neutral wash — amber is reserved.
              "inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-mono text-2xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              following
                ? "border-border bg-accent text-foreground"
                : "border-border text-muted-foreground opacity-0 hover:text-foreground group-hover/folder:opacity-100 focus-visible:opacity-100",
            )}
          >
            <Icon name={following ? "check" : "following"} size={13} />
            {following ? "Following" : "Follow"}
          </button>
        )}
      </div>
      {open && (
        <div className="ml-6 mt-1.5 flex flex-col gap-2">
          {items.map((a) => (
            <ArtifactRow
              key={a.short_id}
              artifact={a}
              onOpen={() => handlers.onOpen(a)}
              onToggleFavorite={() => handlers.onToggleFavorite(a)}
              onPickTag={handlers.onPickTag}
              onPickAuthor={handlers.onPickAuthor}
              onPrefetch={() => handlers.onPrefetch(a)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
