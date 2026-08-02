import type { SortMode } from "@derive/core"
import { useState } from "react"
import type { Artifact, Collection } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
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
  loading,
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
  /** The whole library feed. The page auto-paginates to exhaustion while this view is
   *  up (see the library body): grouping only the first page showed every collection
   *  whose artifacts were older than it as empty, which is a lie with a count next to
   *  it. */
  items: Artifact[]
  /** More pages still arriving — groups without their rows yet show a shimmer, never an
   *  empty claim. */
  loading: boolean
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

  // Starred shelves lead; a stable sort keeps the rest in their existing order.
  const ordered = [...collections].sort(
    (a, b) => Number(b.starred ?? false) - Number(a.starred ?? false),
  )

  return (
    <ListShell>
      <ListHeader sort={sort} onSort={onSort} />
      {ordered.map((c) => {
        const rows = byCollection.get(c.id) ?? []
        const count = c.count ?? rows.length
        return (
          <div key={c.id} data-testid={`collection-group-${c.id}`}>
            <ListGroupHeader
              testId={`collection-group-toggle-${c.id}`}
              title={c.title}
              // The collection's OWN count, not how many of it are on this page — a
              // number that shrank as you scrolled would be worse than none.
              count={count}
              // An empty collection is a 32px header and nothing else — the 0 already
              // says it, and a stack of "nothing filed here yet" lines was noise
              // shouting the same fact down the page.
              disclosable={count > 0}
              open={isOpen(c.id)}
              onToggle={() => toggle(c.id)}
              starred={c.starred}
              onStar={(next) => onStar(c.id, next)}
            />
            {isOpen(c.id) &&
              count > 0 &&
              (rows.length > 0 ? (
                rows.map(row)
              ) : loading ? (
                // Its artifacts haven't paged in yet. Never an empty claim while the
                // feed is still arriving.
                <div className="flex flex-col gap-2 border-b border-border-soft py-2.5 pl-12 pr-4">
                  <Skeleton className="h-3 w-52" />
                  <Skeleton className="h-3 w-40" />
                </div>
              ) : (
                // The count is live-artifact truth; the feed is what THIS viewer can
                // see. The gap is invite-only work inside a shelf you can open.
                <p className="border-b border-border-soft py-2 pl-12 font-mono text-2xs text-muted-foreground/70">
                  Nothing here is visible to you
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
