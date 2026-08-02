import type { SortMode } from "@derive/core"
import { useState } from "react"
import type { Artifact, Collection } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { ArtifactListRow, ListGroupHeader, ListHeader, ListShell } from "./artifact-list"

// The Collections view's second answer.
//
// Shelves answer "which collection?" — you recognise one by its covers. This answers
// "what's in my workspace, and how is it filed?": the same artifact rows the library
// uses, under a header per collection. Neither is a worse version of the other, which is
// what makes the pair worth offering — the Grid/List toggle cut from this page last week
// was "shelf" and "worse shelf".
//
// An artifact filed in two collections appears under both. That IS the truth — membership
// isn't exclusive — and seeing it twice is how you notice.

/** Collapse state per collection, remembered. */
const readOpen = (): Record<string, boolean> => {
  if (typeof window === "undefined") return {}
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.collectionGroups) || "{}")
  } catch {
    return {}
  }
}

export function CollectionsList({
  collections,
  items,
  sort,
  onSort,
  onStar,
  onOpen,
  onToggleFavorite,
  onAddToCollection,
  onDelete,
  onPrefetch,
}: {
  collections: Collection[]
  /** The whole library page — grouped here rather than fetched per collection. */
  items: Artifact[]
  sort: SortMode
  onSort: (mode: SortMode) => void
  onStar: (id: string, next: boolean) => void
  onOpen: (a: Artifact) => void
  onToggleFavorite: (a: Artifact) => void
  onAddToCollection?: (a: Artifact) => void
  onDelete?: (a: Artifact) => void
  onPrefetch?: (a: Artifact) => void
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen)
  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = { ...prev, [id]: prev[id] === false }
      try {
        localStorage.setItem(STORAGE_KEYS.collectionGroups, JSON.stringify(next))
      } catch {
        /* private mode: the choice just doesn't persist */
      }
      return next
    })
  }
  const isOpen = (id: string) => open[id] !== false

  const byCollection = new Map<string, Artifact[]>()
  for (const c of collections) byCollection.set(c.id, [])
  const unfiled: Artifact[] = []
  for (const a of items) {
    const ids = (a.collections ?? []).filter((id) => byCollection.has(id))
    if (ids.length === 0) unfiled.push(a)
    for (const id of ids) byCollection.get(id)?.push(a)
  }

  if (collections.length === 0 && items.length === 0)
    return (
      <EmptyState
        icon={<Icon name="collections" strokeWidth={1.75} />}
        title="No collections yet."
        description="A collection groups related artifacts, and sharing one shares everything in it."
      />
    )

  const row = (a: Artifact) => (
    <ArtifactListRow
      key={a.short_id}
      artifact={a}
      indent
      onOpen={() => onOpen(a)}
      onToggleFavorite={() => onToggleFavorite(a)}
      onAddToCollection={onAddToCollection && (() => onAddToCollection(a))}
      onDelete={onDelete && (() => onDelete(a))}
      onPrefetch={onPrefetch && (() => onPrefetch(a))}
    />
  )

  return (
    <ListShell>
      <ListHeader sort={sort} onSort={onSort} />
      {collections.map((c) => {
        const rows = byCollection.get(c.id) ?? []
        return (
          <div key={c.id} data-testid={`collection-group-${c.id}`}>
            <ListGroupHeader
              testId={`collection-group-toggle-${c.id}`}
              title={c.title}
              // The collection's OWN count, not how many of it are on this page — a
              // number that shrank as you scrolled would be worse than none.
              count={c.count ?? rows.length}
              open={isOpen(c.id)}
              onToggle={() => toggle(c.id)}
              starred={c.starred}
              onStar={(next) => onStar(c.id, next)}
            />
            {isOpen(c.id) &&
              (rows.length > 0 ? (
                rows.map(row)
              ) : (
                <p className="border-b border-border-soft py-2 pl-9 font-mono text-2xs text-muted-foreground/70">
                  Nothing filed here yet
                </p>
              ))}
          </div>
        )
      })}
      {/* Last, and quieter. The unfiled pile is invisible today, and it's the first thing
          you want when you sit down to organise. */}
      {unfiled.length > 0 && (
        <div data-testid="collection-group-unfiled">
          <ListGroupHeader
            testId="collection-group-toggle-unfiled"
            title="Not in a collection"
            count={unfiled.length}
            open={isOpen("unfiled")}
            onToggle={() => toggle("unfiled")}
          />
          {isOpen("unfiled") && unfiled.map(row)}
        </div>
      )}
    </ListShell>
  )
}
