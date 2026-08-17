import type { QueryKey } from "@tanstack/react-query"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { type Artifact, api, type Folder } from "@/api"
import { Icon } from "@/components/icons"
import { LoadError } from "@/components/shared/load-error"
import {
  CollectionToggleRow,
  canAddTo,
  pickableCollections,
  ROW_CLASS,
} from "@/components/shared/organize-dialogs"
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
import { artifactQuery, collectionFoldersQuery, collectionsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useBrandprintCollectionIds } from "@/lib/use-brandprint-ids"
import { cn } from "@/lib/utils"
import { summarize } from "./bulk-apply"

// The organize dialogs in their MANY-artifact form, opened from the selection bar. Same
// grammar and endpoints as the single-artifact dialog in shared/organize-dialogs, with one
// safeguard: adding to a collection never removes, so a mis-click on a 30-artifact
// selection costs a cleanup, not data. (Folders are single-valued and don't get that
// guarantee — see BulkFolderDialog.)

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
      className={cn(ROW_CLASS, target === id && "bg-accent")}
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
            File the selected artifacts under a folder in this collection. Folders organize the
            contents but do not change who can see them.
          </DialogDescription>
        </DialogHeader>
        {folders.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No folders yet. Create one from “New folder” in the collection.
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
  // Same offer policy as the single-artifact dialog (manual collections only, Brandprint
  // excluded), alphabetized — this list has no suggestion tier, so A–Z is the whole order.
  const brandprintIds = useBrandprintCollectionIds()
  const pickable = pickableCollections(all, brandprintIds).sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  )

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
          <LoadError
            title="Couldn’t load your collections"
            testId="bulk-collection-retry"
            onRetry={() => refetch()}
          />
        )}
        {!isError && pickable.length === 0 && (
          <div className="text-sm text-muted-foreground">No collections yet. Create one below.</div>
        )}
        {pickable.length > 0 && (
          <div className="flex max-h-64 flex-col gap-px overflow-auto">
            {pickable.map((col) => (
              <CollectionToggleRow
                key={col.id}
                col={col}
                checked={picked.includes(col.id)}
                disabled={!canAddTo(col)}
                hint={!canAddTo(col) ? "view only" : undefined}
                onSelect={() =>
                  setPicked((prev) =>
                    prev.includes(col.id) ? prev.filter((id) => id !== col.id) : [...prev, col.id],
                  )
                }
                testId={`bulk-collection-${col.id}`}
              />
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
