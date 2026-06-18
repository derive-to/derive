import { ChevronRight, Folder } from "lucide-react"
import { useMemo, useState } from "react"
import type { Artifact } from "@/api"
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
        <FolderSection key={g.dir} dir={g.dir} items={g.items} {...handlers} />
      ))}
      {(hasNextPage || isFetchingNextPage) && (
        <div className="py-2 text-center text-sm text-muted-foreground">Loading the rest…</div>
      )}
    </div>
  )
}

function FolderSection({ dir, items, ...handlers }: { dir: string; items: Artifact[] } & Handlers) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button
        type="button"
        data-testid={`folder-toggle-${dir}`}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-md py-1.5 text-left hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
          aria-hidden
        />
        <Folder className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="truncate font-mono text-sm font-medium text-foreground">{dir}</span>
        <span className="font-mono text-xs text-muted-foreground">· {items.length}</span>
      </button>
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
