import type { QueryKey } from "@tanstack/react-query"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { type Artifact, api, type Folder } from "@/api"
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
import {
  artifactQuery,
  collectionFoldersQuery,
  collectionsQuery,
  summaryQuery,
} from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useBrandprintCollectionIds } from "@/lib/use-brandprint-ids"
import { cn } from "@/lib/utils"
import { summarize } from "./bulk-apply"

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
  // The full selection — the server authorizes each artifact and skips what the caller
  // can't edit. `skipped` is the caller's own pre-action estimate for the preview line.
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
    // One call over the whole selection: the server ADDS the tags to each artifact's
    // existing set (computing the union itself, so the client sends only the tags to add)
    // and authorizes every artifact on its own — anything the caller can't edit comes back
    // in `skipped`. Normalization (lowercase, dedupe, cap 20) is the server's too.
    mutationFn: (tags: string[]) =>
      api.bulkTags(
        items.map((a) => a.short_id),
        tags,
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

// Move the selected artifacts INTO a folder of the current collection (or unfile them).
// One target folder for the whole selection; applies per item (folder membership is
// per-collection, so this only touches the current collection's memberships).
export function BulkFolderDialog({
  items,
  collectionId,
  folders,
  listKey,
  onDone,
  open,
  onOpenChange,
}: {
  items: Artifact[]
  collectionId: string
  folders: Folder[]
  listKey: QueryKey
  onDone: () => void
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  // undefined = nothing picked yet; null = "Unfiled"; string = a folder id.
  const [target, setTarget] = useState<string | null | undefined>(undefined)
  const sorted = [...folders].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  )

  const apply = useApiMutation({
    // One PUT per item (no bulk endpoint yet). `allSettled` so a single rejection can't
    // abort the rest and leave a silent partial move — count the failures and report them
    // like the other bulk actions' `summarize`. All-failed throws so it surfaces as an
    // error toast rather than a green "Moved 0".
    mutationFn: async (folderId: string | null) => {
      const results = await Promise.allSettled(
        items.map((a) => api.setItemFolder(collectionId, a.short_id, folderId)),
      )
      const failed = results.filter((r) => r.status === "rejected").length
      if (failed === items.length) throw new Error("Couldn’t move any of the selected artifacts.")
      return failed
    },
    invalidate: [listKey, collectionFoldersQuery(collectionId).queryKey],
    success: (failed) => {
      const moved = items.length - failed
      const base = `Moved ${moved} ${moved === 1 ? "artifact" : "artifacts"}`
      return failed > 0 ? `${base} · ${failed} couldn’t be moved` : base
    },
    onSuccess: onDone,
  })

  const row = (id: string | null, label: string, testId: string) => (
    <button
      key={testId}
      type="button"
      data-testid={testId}
      aria-pressed={target === id}
      onClick={() => setTarget(id)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        target === id && "bg-accent",
      )}
    >
      <span className="grid w-3.5 shrink-0 place-items-center">
        {target === id && <Icon name="check" size={16} />}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to folder</DialogTitle>
          <DialogDescription>
            File the selected artifacts under a folder in this collection. Folders organize a
            collection’s contents — they don’t change who can see them.
          </DialogDescription>
        </DialogHeader>
        {folders.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No folders yet — create one from “New folder” in the collection.
          </div>
        )}
        <div className="flex max-h-64 flex-col gap-px overflow-auto">
          {sorted.map((f) => row(f.id, f.name, `bulk-folder-${f.id}`))}
          {row(null, "Unfiled (remove from folder)", "bulk-folder-unfile")}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            data-testid="bulk-folder-cancel"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            data-testid="bulk-folder-apply"
            disabled={target === undefined || apply.isPending}
            onClick={() => target !== undefined && apply.mutate(target)}
          >
            {apply.isPending
              ? "Moving…"
              : `Move ${items.length} ${items.length === 1 ? "artifact" : "artifacts"}`}
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
    // One call: the server folds the whole selection into every picked collection,
    // authorizing each artifact for "share" (adding to a shared collection re-shares it),
    // so the summary counts artifacts added and reports the rest as skipped.
    mutationFn: (ids: string[]) =>
      api.bulkAddToCollections(
        items.map((a) => a.short_id),
        ids,
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
