import { ChevronRight, Folder } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { Artifact } from "@/api"
import { cn } from "@/lib/utils"
import { ArtifactCard } from "./artifact-card"

const dirOf = (p: string): string => {
  const i = p.lastIndexOf("/")
  return i < 0 ? "" : p.slice(0, i)
}
const sortKey = (a: Artifact) => a.source_path ?? a.title ?? a.short_id

interface Handlers {
  onOpen: (a: Artifact) => void
  onToggleFavorite: (a: Artifact) => void
  onPickTag: (tag: string) => void
  onPrefetch: (a: Artifact) => void
}

/**
 * A mirrored repo is a file tree, so its collection renders grouped by folder
 * (from each artifact's `source_path`) rather than one flat grid. Folders are
 * collapsible; the whole collection is loaded up front so the grouping is
 * complete (collections are finite, and scoping keeps them small).
 */
export function FolderGroups({
  items,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  ...handlers
}: {
  items: Artifact[]
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
} & Handlers) {
  // Pull the remaining pages so every folder is fully populated.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) onLoadMore()
  }, [hasNextPage, isFetchingNextPage, onLoadMore])

  const groups = useMemo(() => {
    const m = new Map<string, Artifact[]>()
    for (const a of items) {
      const key = a.source_path ? dirOf(a.source_path) || "/" : "Other"
      const arr = m.get(key)
      if (arr) arr.push(a)
      else m.set(key, [a])
    }
    return [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, arts]) => ({
        dir,
        items: arts.sort((x, y) => sortKey(x).localeCompare(sortKey(y))),
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
        <div className="ml-6 mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {items.map((a) => (
            <ArtifactCard
              key={a.short_id}
              artifact={a}
              onOpen={() => handlers.onOpen(a)}
              onToggleFavorite={() => handlers.onToggleFavorite(a)}
              onPickTag={handlers.onPickTag}
              onPrefetch={() => handlers.onPrefetch(a)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
