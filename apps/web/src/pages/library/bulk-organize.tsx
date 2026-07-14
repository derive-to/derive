import type { QueryKey } from "@tanstack/react-query"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { type Artifact, api } from "@/api"
import { Icon } from "@/components/icons"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { artifactQuery, collectionsQuery, summaryQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useBrandprintCollectionIds } from "@/lib/use-brandprint-ids"
import { cn } from "@/lib/utils"
import { bulkApply, summarize } from "./bulk-apply"

// The two organize dialogs in their MANY-artifact form, opened from the selection bar.
// They mirror the single-artifact dialogs in components/shared/organize-dialogs (same
// grammar, same API calls) with one deliberate difference: they ADD, never replace.
// Applying "#q3" to eight artifacts must not flatten the tags the other seven already
// carry — so tags are merged per artifact, and collections are only ever added to.

// The artifacts a bulk write will touch, and the ones it will pass over. Every dialog
// states this up front: a bulk write should never be a surprise.
function ScopeLine({ count, skipped }: { count: number; skipped: number }) {
  if (skipped === 0) return null
  return (
    <p className="text-sm text-muted-foreground">
      {count} of {count + skipped} selected — {skipped} you can’t edit will be skipped.
    </p>
  )
}

export function BulkTagsDialog({
  items,
  skipped,
  listKey,
  onDone,
  open,
  onOpenChange,
}: {
  // Already narrowed to what the caller can tag (owner/editor).
  items: Artifact[]
  skipped: number
  listKey: QueryKey
  onDone: () => void
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [draft, setDraft] = useState("")
  const [adding, setAdding] = useState<string[]>([])

  const apply = useApiMutation({
    // setTags REPLACES an artifact's set, so the union is computed per artifact from the
    // tags already on its card. The server then normalizes (lowercase, dedupe, cap 20).
    mutationFn: (tags: string[]) =>
      bulkApply(
        items,
        (a) => api.setTags(a.short_id, [...new Set([...(a.tags ?? []), ...tags])]),
        skipped,
      ),
    invalidate: [
      listKey,
      summaryQuery().queryKey,
      ...items.map((a) => artifactQuery(a.short_id).queryKey),
    ],
    success: (r) => summarize("Tagged", r),
    onSuccess: onDone,
  })

  const stage = () => {
    const v = draft.trim().toLowerCase()
    setDraft("")
    if (v && !adding.includes(v)) setAdding((prev) => [...prev, v])
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add tags</DialogTitle>
          <DialogDescription>
            Tags are added to each artifact’s existing set — nothing is replaced.
          </DialogDescription>
        </DialogHeader>
        <ScopeLine count={items.length} skipped={skipped} />
        {adding.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {adding.map((t) => (
              <Badge key={t} variant="outline" className="gap-1">
                #{t}
                <button
                  type="button"
                  data-icon="inline-end"
                  data-testid={`bulk-tag-remove-${t}`}
                  onClick={() => setAdding((prev) => prev.filter((x) => x !== t))}
                  aria-label={`Remove ${t}`}
                  className="rounded-sm outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <Icon name="close" size={12} />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <Input
            value={draft}
            placeholder="Add a tag…"
            data-testid="bulk-tag-input"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") stage()
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={stage}
            disabled={!draft.trim()}
            data-testid="bulk-tag-stage"
          >
            Add
          </Button>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            data-testid="bulk-tag-cancel"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="bulk-tag-apply"
            disabled={adding.length === 0 || apply.isPending}
            onClick={() => apply.mutate(adding)}
          >
            {apply.isPending
              ? "Tagging…"
              : `Tag ${items.length} ${items.length === 1 ? "artifact" : "artifacts"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function BulkCollectionsDialog({
  items,
  listKey,
  onDone,
  open,
  onOpenChange,
}: {
  items: Artifact[]
  listKey: QueryKey
  onDone: () => void
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { data: all = [], isError, refetch } = useQuery({ ...collectionsQuery(), enabled: open })
  const [draft, setDraft] = useState("")
  const [picked, setPicked] = useState<string[]>([])
  // Brandprint-pointed collections take docs through /brandprint only — same exclusion
  // the single-artifact dialog makes.
  const brandprintIds = useBrandprintCollectionIds()
  const pickable = all.filter((col) => !brandprintIds.has(col.id))

  const apply = useApiMutation({
    // One unit of work per ARTIFACT (its collection adds run together), so the summary
    // counts artifacts moved, not requests made.
    mutationFn: (ids: string[]) =>
      bulkApply(items, (a) =>
        Promise.all(ids.map((colId) => api.addToCollection(colId, a.short_id))),
      ),
    invalidate: [
      listKey,
      collectionsQuery().queryKey,
      ...items.map((a) => artifactQuery(a.short_id).queryKey),
    ],
    success: (r) => summarize("Added", r),
    onSuccess: onDone,
  })

  // Create and pick in one gesture — the artifacts land when you hit Add.
  const createCol = useApiMutation({
    mutationFn: (title: string) => api.createCollection(title),
    invalidate: [collectionsQuery().queryKey],
    onSuccess: (col) => setPicked((prev) => [...prev, col.id]),
  })
  const create = () => {
    const t = draft.trim()
    setDraft("")
    if (t) createCol.mutate(t)
  }

  const busy = apply.isPending || createCol.isPending
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to collection</DialogTitle>
          <DialogDescription>
            Collections group related artifacts; sharing a collection shares its artifacts with its
            members.
          </DialogDescription>
        </DialogHeader>
        {/* A failed load is NOT "no collections yet" — saying so would invite you to
            create a duplicate of one you already have. */}
        {isError && (
          <StatusPanel
            tone="danger"
            title="Couldn’t load your collections"
            description="This is usually temporary."
            action={
              <Button
                variant="outline"
                size="sm"
                data-testid="bulk-collection-retry"
                onClick={() => refetch()}
              >
                Try again
              </Button>
            }
          />
        )}
        {!isError && pickable.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No collections yet — create one below.
          </div>
        )}
        {pickable.length > 0 && (
          <div className="flex max-h-64 flex-col gap-px overflow-auto">
            {pickable.map((col) => (
              <button
                key={col.id}
                type="button"
                data-testid={`bulk-collection-${col.id}`}
                aria-pressed={picked.includes(col.id)}
                onClick={() =>
                  setPicked((prev) =>
                    prev.includes(col.id) ? prev.filter((id) => id !== col.id) : [...prev, col.id],
                  )
                }
                className={cn(
                  // The menu-row recipe, shared with the single-artifact dialog.
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  picked.includes(col.id) && "bg-accent",
                )}
              >
                <span className="grid w-3.5 shrink-0 place-items-center">
                  {picked.includes(col.id) && <Icon name="check" size={16} />}
                </span>
                <span className="flex-1 truncate">{col.title}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <Input
            value={draft}
            placeholder="New collection…"
            data-testid="bulk-collection-new-input"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create()
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={create}
            disabled={!draft.trim() || busy}
            data-testid="bulk-collection-create"
          >
            Create
          </Button>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            data-testid="bulk-collection-cancel"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="bulk-collection-apply"
            disabled={picked.length === 0 || busy}
            onClick={() => apply.mutate(picked)}
          >
            {apply.isPending
              ? "Adding…"
              : `Add ${items.length} ${items.length === 1 ? "artifact" : "artifacts"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
