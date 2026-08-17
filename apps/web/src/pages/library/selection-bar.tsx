import type { QueryKey } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import { type Artifact, api, type Folder } from "@/api"
import { Icon } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { collectionsQuery, summaryQuery } from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import { type ArtifactFeedData, removeArtifactsFromFeed } from "./artifact-feed-cache"
import { summarize } from "./bulk-apply"
import { BulkCollectionsDialog, BulkFolderDialog } from "./bulk-organize"

// Labels collapse below `sm`; aria-label keeps the icon-only controls accessible.
function BarAction({
  testId,
  icon,
  label,
  title,
  disabled,
  onClick,
  className,
}: {
  testId: string
  icon: ReactNode
  label: string
  title: string
  disabled: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid={testId}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn("shrink-0", className)}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  )
}

// Selections may mix writable and read-only artifacts. The server authorizes each item;
// the client uses roles only to avoid optimistic changes it already knows will be skipped.
export function SelectionBar({
  items,
  listKey,
  onClear,
  folderContext,
}: {
  // The selection, in feed order — already reconciled against the live feed, so every
  // artifact here is one the user can still see.
  items: Artifact[]
  // The active feed's list query, so a bulk write reconciles the grid it just changed.
  listKey: QueryKey
  onClear: () => void
  // Present only in a collection view whose folders the caller can manage — enables the
  // "Move to folder" action (folders are per-collection, so it needs that collection).
  folderContext?: { collectionId: string; folders: Folder[] }
}) {
  const [showCollections, setShowCollections] = useState(false)
  const [showFolder, setShowFolder] = useState(false)
  const [showDelete, setShowDelete] = useState(false)

  const n = items.length
  const shortIds = items.map((a) => a.short_id)
  // Drives the delete button's enabled state and the count in its confirm copy, nothing
  // more — the server re-authorizes every artifact and reports back what it skipped.
  const deletable = items.filter((a) => a.my_role === "owner")
  const archivable = items.filter(
    (a) => !a.removed && (a.my_role === "owner" || a.my_role === "editor"),
  )
  const archivableIds = new Set(archivable.map((a) => a.short_id))
  // All-starred → the star becomes the un-star (the card's own toggle, at scale).
  const allFavorite = n > 0 && items.every((a) => a.favorite)
  const allArchived = n > 0 && items.every((a) => a.archived)

  const favorite = useApiMutation({
    mutationFn: (on: boolean) => api.bulkFavorite(shortIds, on),
    invalidate: [listKey, summaryQuery().queryKey],
    success: (r) => summarize(allFavorite ? "Unstarred" : "Starred", r),
    onSuccess: onClear,
  })

  const remove = useApiMutation({
    // Send the whole selection; the server deletes what the caller owns and skips the rest.
    mutationFn: () => api.bulkDelete(shortIds),
    invalidate: [listKey, summaryQuery().queryKey, collectionsQuery().queryKey],
    success: (r) => summarize("Deleted", r),
    onSuccess: onClear,
  })

  const undoArchive = useApiMutation({
    mutationFn: ({ ids, on }: { ids: string[]; on: boolean }) => api.bulkArchive(ids, on),
    invalidate: [["artifacts"], summaryQuery().queryKey],
  })

  const archive = useApiMutation({
    mutationFn: (on: boolean) => api.bulkArchive(shortIds, on),
    optimistic: (_on, qc) => {
      const rollback = snapshot(qc, listKey)
      qc.setQueryData<ArtifactFeedData>(listKey, (old) =>
        removeArtifactsFromFeed(old, archivableIds),
      )
      return rollback
    },
    invalidate: [["artifacts"], summaryQuery().queryKey],
    onSuccess: (result, on) => {
      onClear()
      if (!on) {
        toast.success(summarize("Restored", result))
        return
      }
      toast(summarize("Archived", result), {
        action: {
          label: "Undo",
          onClick: () => undoArchive.mutate({ ids: shortIds, on: false }),
        },
      })
    },
  })

  const busy = favorite.isPending || archive.isPending || remove.isPending

  return (
    <>
      {/* Sticky positioning keeps the bar centered in the content column. */}
      <div className="pointer-events-none sticky bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 mt-4 flex justify-center sm:bottom-6">
        <div
          data-testid="library-selection-bar"
          // Labels collapse below `sm` so the bar fits a 320px viewport.
          className="pointer-events-auto flex max-w-[calc(100vw-1.5rem)] items-center gap-0.5 rounded-2xl bg-popover px-2 py-2 text-popover-foreground shadow-[var(--shadow-pop)] ring-1 ring-foreground/10 duration-state ease-out animate-in fade-in-0 slide-in-from-bottom-2 sm:gap-1 sm:px-3"
        >
          <div className="flex items-center gap-2 border-r border-border-soft pr-2 pl-1 sm:pr-3">
            <span
              data-testid="library-selection-count"
              className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground font-mono text-2xs font-semibold text-background tabular-nums"
            >
              {n}
            </span>
            <span className="hidden text-sm font-medium whitespace-nowrap text-muted-foreground sm:inline">
              selected
            </span>
          </div>

          <BarAction
            testId="library-selection-collections"
            icon={<Icon name="collections" size={16} />}
            label="Add to collection"
            disabled={busy}
            title="Add the selected artifacts to a collection"
            onClick={() => setShowCollections(true)}
          />

          {folderContext && (
            <BarAction
              testId="library-selection-folder"
              icon={<Icon name="collection" size={16} />}
              label="Move to folder"
              disabled={busy}
              title="File the selected artifacts under a folder in this collection"
              onClick={() => setShowFolder(true)}
            />
          )}

          <BarAction
            testId="library-selection-favorite"
            icon={
              <Icon
                name="star"
                size={16}
                weight={allFavorite ? "fill" : "regular"}
                className={allFavorite ? "text-primary" : undefined}
              />
            }
            label={allFavorite ? "Unstar" : "Star"}
            disabled={busy}
            title={allFavorite ? "Remove the star from all" : "Star the selected artifacts"}
            onClick={() => favorite.mutate(!allFavorite)}
          />

          <BarAction
            testId="library-selection-archive"
            icon={<Icon name="archive" size={16} />}
            label={allArchived ? "Restore" : "Archive"}
            disabled={busy || archivable.length === 0}
            title={
              archivable.length === 0
                ? "You can only archive live artifacts you can edit"
                : allArchived
                  ? "Restore the selected artifacts to the library"
                  : "Archive the selected artifacts"
            }
            onClick={() => archive.mutate(!allArchived)}
          />

          <BarAction
            testId="library-selection-delete"
            icon={<Icon name="delete" size={16} />}
            label="Delete"
            disabled={busy || deletable.length === 0}
            title={
              deletable.length === 0
                ? "You can only delete artifacts you own"
                : "Delete the selected artifacts"
            }
            onClick={() => setShowDelete(true)}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          />

          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="library-selection-clear"
            aria-label="Clear selection"
            title="Clear selection (Esc)"
            disabled={busy}
            onClick={onClear}
            className="ml-0.5 shrink-0"
          >
            <Icon name="close" size={16} />
          </Button>
        </div>
      </div>

      {showCollections && (
        <BulkCollectionsDialog
          items={items}
          listKey={listKey}
          open={showCollections}
          onOpenChange={setShowCollections}
          onDone={() => {
            setShowCollections(false)
            onClear()
          }}
        />
      )}
      {showFolder && folderContext && (
        <BulkFolderDialog
          items={items}
          collectionId={folderContext.collectionId}
          folders={folderContext.folders}
          listKey={listKey}
          open={showFolder}
          onOpenChange={setShowFolder}
          onDone={() => {
            setShowFolder(false)
            onClear()
          }}
        />
      )}
      <ConfirmDialog
        open={showDelete}
        onOpenChange={setShowDelete}
        title={`Delete ${deletable.length} ${deletable.length === 1 ? "artifact" : "artifacts"}?`}
        description={
          deletable.length < n
            ? `This permanently deletes them and their versions. ${n - deletable.length} you don’t own will be skipped. This cannot be undone.`
            : "This permanently deletes them and their versions. This cannot be undone."
        }
        confirmLabel="Delete"
        confirmTestId="library-selection-delete-confirm"
        // A bulk delete is the highest-stakes action the bar can take — many artifacts and
        // their whole version history, at once, unrecoverable — so it asks you to type the
        // word, not just click. (The card's own ⋯ menu keeps the one-click confirm.)
        confirmPhrase="delete"
        onConfirm={async () => {
          await remove.mutateAsync()
        }}
      />
    </>
  )
}
