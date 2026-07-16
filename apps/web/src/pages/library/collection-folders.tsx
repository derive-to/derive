import { ChevronRight } from "lucide-react"
import { useState } from "react"
import { type Artifact, api, type Folder } from "@/api"
import { Icon } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { Count } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { collectionFoldersQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { cn } from "@/lib/utils"
import { ArtifactRow } from "./artifact-row"
import type { LibrarySelection } from "./use-library-selection"

interface RowHandlers {
  onOpen: (a: Artifact) => void
  onToggleFavorite: (a: Artifact) => void
  onPickTag: (tag: string) => void
  onPickAuthor: (login: string) => void
  onEditTags: (a: Artifact) => void
  onAddToCollection: (a: Artifact) => void
  onDelete: (a: Artifact) => void
  onPrefetch: (a: Artifact) => void
  selection?: LibrarySelection
}

const UNFILED = "__unfiled__"

// The "New folder" affordance (button → inline input). Shared by the grouped view below
// and the flat (no-folders-yet) collection grid, so both create folders one way.
export function NewFolderControl({
  collectionId,
  className,
}: {
  collectionId: string
  className?: string
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const create = useApiMutation({
    mutationFn: (n: string) => api.createFolder(collectionId, n),
    invalidate: [collectionFoldersQuery(collectionId).queryKey],
    onSuccess: () => {
      setCreating(false)
      setName("")
    },
  })
  const submit = () => (name.trim() ? create.mutate(name.trim()) : setCreating(false))
  if (creating)
    return (
      <Input
        autoFocus
        value={name}
        placeholder="Folder name…"
        aria-label="Folder name"
        data-testid="collection-new-folder-input"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit()
          if (e.key === "Escape") {
            setCreating(false)
            setName("")
          }
        }}
        onBlur={submit}
        className={cn("max-w-xs", className)}
      />
    )
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="collection-new-folder"
      onClick={() => setCreating(true)}
      className={cn("self-start", className)}
    >
      <Icon name="plus" size={16} />
      New folder
    </Button>
  )
}

/**
 * A manual collection's artifacts, grouped into its user folders (Collection → Folder →
 * artifacts). Folders come first (name order), then an "Unfiled" bucket; each section is
 * collapsible. Collection editors get a "New folder" affordance and a per-folder rename /
 * delete menu; filing artifacts is done from the multi-select bar's "Move to folder".
 * Sibling of `folder-groups.tsx` (the repo path-folder view), one level, alphabetical.
 */
export function CollectionFolders({
  collectionId,
  items,
  folders,
  assignments,
  canManage,
  hasNextPage,
  isFetchingNextPage,
  ...handlers
}: {
  collectionId: string
  items: Artifact[]
  folders: Folder[]
  /** artifact short_id → folder id (filed items only). */
  assignments: Record<string, string>
  canManage: boolean
  // The parent loads the whole collection when this view is active (folders need every
  // item to bucket + count), so there's no load-more button here — just a tail spinner
  // while those pages arrive.
  hasNextPage: boolean
  isFetchingNextPage: boolean
} & RowHandlers) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameName, setRenameName] = useState("")
  const [deleting, setDeleting] = useState<Folder | null>(null)
  const invalidate = [collectionFoldersQuery(collectionId).queryKey]

  const renameFolder = useApiMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameFolder(id, name),
    invalidate,
    onSuccess: () => {
      setRenaming(null)
      setRenameName("")
    },
  })
  const removeFolder = useApiMutation({
    mutationFn: (id: string) => api.deleteFolder(id),
    invalidate,
  })

  // Bucket the loaded artifacts by their folder; unfiled last.
  const byFolder = new Map<string, Artifact[]>()
  for (const a of items) {
    const key = assignments[a.short_id] ?? UNFILED
    const arr = byFolder.get(key)
    if (arr) arr.push(a)
    else byFolder.set(key, [a])
  }
  const sortedFolders = [...folders].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  )
  const unfiled = byFolder.get(UNFILED) ?? []

  return (
    <div className="flex flex-col gap-3">
      {canManage && <NewFolderControl collectionId={collectionId} />}

      {sortedFolders.map((f) => (
        <Section
          key={f.id}
          title={f.name}
          testId={`collection-folder-${f.id}`}
          items={byFolder.get(f.id) ?? []}
          menu={
            canManage ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Manage folder ${f.name}`}
                    data-testid={`collection-folder-${f.id}-menu`}
                    className="shrink-0 opacity-0 group-hover/folder:opacity-100 focus-visible:opacity-100"
                  >
                    <Icon name="more" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem
                    data-testid={`collection-folder-${f.id}-rename`}
                    onSelect={() => {
                      setRenameName(f.name)
                      setRenaming(f.id)
                    }}
                  >
                    <Icon name="pencil" className="mr-2 size-4 text-muted-foreground" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid={`collection-folder-${f.id}-delete`}
                    onSelect={() => setDeleting(f)}
                  >
                    <Icon name="delete" className="mr-2 size-4 text-muted-foreground" />
                    Delete folder
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : undefined
          }
          renameInput={
            renaming === f.id ? (
              <Input
                autoFocus
                value={renameName}
                aria-label="Folder name"
                data-testid={`collection-folder-${f.id}-rename-input`}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && renameName.trim())
                    renameFolder.mutate({ id: f.id, name: renameName.trim() })
                  if (e.key === "Escape") {
                    setRenaming(null)
                    setRenameName("")
                  }
                }}
                onBlur={() =>
                  renameName.trim()
                    ? renameFolder.mutate({ id: f.id, name: renameName.trim() })
                    : setRenaming(null)
                }
                className="max-w-xs"
              />
            ) : undefined
          }
          {...handlers}
        />
      ))}

      {unfiled.length > 0 && (
        <Section
          title="Unfiled"
          testId="collection-folder-unfiled"
          muted
          items={unfiled}
          {...handlers}
        />
      )}

      {(hasNextPage || isFetchingNextPage) && (
        <div className="flex justify-center py-2">
          <Spinner />
        </div>
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete folder “${deleting?.name ?? ""}”?`}
        description="The folder is removed and its artifacts become unfiled — they stay in the collection."
        confirmLabel="Delete folder"
        confirmTestId="collection-folder-delete-confirm"
        onConfirm={async () => {
          if (deleting) await removeFolder.mutateAsync(deleting.id)
          setDeleting(null)
        }}
      />
    </div>
  )
}

function Section({
  title,
  testId,
  items,
  menu,
  renameInput,
  muted,
  ...handlers
}: {
  title: string
  testId: string
  items: Artifact[]
  menu?: React.ReactNode
  renameInput?: React.ReactNode
  muted?: boolean
} & RowHandlers) {
  const [open, setOpen] = useState(true)
  if (renameInput) return <div>{renameInput}</div>
  return (
    <div className="group/folder">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`${testId}-toggle`}
          aria-expanded={open}
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
          {/* A folder — the single-folder glyph — for both a named folder and the Unfiled
              bucket; `muted` carries the Unfiled distinction through color, not a different
              icon (the plural stack reads as "many collections", wrong for one folder). */}
          <Icon name="collection" className="text-muted-foreground" />
          <span
            className={cn(
              "truncate text-sm font-medium",
              muted ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {title}
          </span>
          <Count>{items.length}</Count>
        </button>
        {menu}
      </div>
      {open && (
        <div className="mt-1.5 flex flex-col gap-2 pl-6">
          {items.map((a) => (
            <ArtifactRow
              key={a.short_id}
              artifact={a}
              onOpen={() => handlers.onOpen(a)}
              onToggleFavorite={() => handlers.onToggleFavorite(a)}
              onPickTag={handlers.onPickTag}
              onPickAuthor={handlers.onPickAuthor}
              onEditTags={() => handlers.onEditTags(a)}
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
