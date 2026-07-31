import { ChevronRight } from "lucide-react"
import { useState } from "react"
import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { Count } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import { dirOf } from "@/lib/artifact"
import { useFollows } from "@/lib/use-follows"
import { cn } from "@/lib/utils"
import { ArtifactRow } from "./artifact-row"
import type { LibrarySelection } from "./use-library-selection"

interface Handlers {
  onOpen: (a: Artifact) => void
  onToggleFavorite: (a: Artifact) => void
  onPickAuthor: (login: string) => void
  onAddToCollection: (a: Artifact) => void
  onDelete: (a: Artifact) => void
  onPrefetch: (a: Artifact) => void
  // Multi-select, threaded to every row — a folder view is exactly where selecting a
  // dozen docs at once earns its keep.
  selection?: LibrarySelection
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
  const groups = (() => {
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
  })()

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
        <div className="flex justify-center py-2">
          <Spinner />
        </div>
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
          <Icon name="collection" className="text-muted-foreground" />
          <span className="truncate font-mono text-sm font-medium text-foreground">{dir}</span>
          <Count>{items.length}</Count>
        </button>
        {followable && (
          // The followed state is a neutral wash (secondary) — the ink accent is reserved.
          // Same variant flip as the library's author-follow button.
          <Button
            variant={following ? "secondary" : "outline"}
            size="xs"
            data-testid={`folder-follow-${dir}`}
            aria-pressed={following}
            title={
              following ? `Unfollow ${dir}/` : `Follow ${dir}/ to see its changes in your feed`
            }
            onClick={onToggleFollow}
            className={cn(
              "shrink-0 transition-opacity",
              !following && "opacity-0 group-hover/folder:opacity-100 focus-visible:opacity-100",
            )}
          >
            <Icon name={following ? "check" : "following"} />
            {following ? "Following" : "Follow"}
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-1.5 flex flex-col gap-2 pl-6">
          {items.map((a) => (
            <ArtifactRow
              key={a.short_id}
              artifact={a}
              onOpen={() => handlers.onOpen(a)}
              onToggleFavorite={() => handlers.onToggleFavorite(a)}
              onPickAuthor={handlers.onPickAuthor}
              onAddToCollection={() => handlers.onAddToCollection(a)}
              onDelete={() => handlers.onDelete(a)}
              onPrefetch={() => handlers.onPrefetch(a)}
              selected={handlers.selection?.selected.has(a.short_id)}
              selectionActive={handlers.selection?.active}
              onSelect={
                handlers.selection
                  ? (shift) => handlers.selection?.toggle(a.short_id, shift)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}
