import { ChevronRight } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { type Artifact, api, type Folder } from "@/api"
import { Icon } from "@/components/icons"
import { CardGrid } from "@/components/shared/card-grid"
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
import { ArtifactCard } from "./artifact-card"
import type { LibrarySelection } from "./use-library-selection"

interface CardHandlers {
  onOpen: (a: Artifact) => void
  onToggleFavorite: (a: Artifact) => void
  onPickTag: (tag: string) => void
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
 * A manual collection's artifacts grouped into its user folders (Collection → Folder →
 * artifacts). Folders are collapsible SECTION HEADERS over the ordinary card grid — the
 * thumbnails never go away; the folder is only a divider. Folders come first (name
 * order), then an "Unfiled" bucket. Collection editors get a "New folder" affordance and
 * a per-folder rename / delete menu; filing is done from the multi-select "Move to
 * folder". Grouping is decoupled from presentation — the collection view's "Group by
 * folder" toggle flips between this and the flat card grid, both cards. One level.
 */
export function CollectionFolders({
  collectionId,
  items,
  folders,
  assignments,
  canManage,
  hasNextPage,
  isFetchingNextPage,
  scrollToFolderId,
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
  // A folder to scroll into view on open (the breadcrumb's `?folder=` anchor, already
  // consumed into transient state by the parent). The matching section scrolls once.
  scrollToFolderId?: string
} & CardHandlers) {
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
    // Between-folder space (gap-8, 32px) is the LARGEST interval in the layout — larger
    // than the 24px row gap inside a folder's card grid — so the eye reads "new group"
    // from the whitespace, not the reverse.
    <div className="flex flex-col gap-8">
      {canManage && <NewFolderControl collectionId={collectionId} />}

      {sortedFolders.map((f) => (
        <Section
          key={f.id}
          title={f.name}
          testId={`collection-folder-${f.id}`}
          items={byFolder.get(f.id) ?? []}
          canManage={canManage}
          scrollTo={scrollToFolderId === f.id}
          // Only scroll once EVERY page is in: the anchor fires against a settled layout,
          // not the thin page-1 grid that would put the target folder somewhere it won't
          // stay once later pages fill the earlier folders.
          loaded={!hasNextPage && !isFetchingNextPage}
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
  canManage,
  scrollTo,
  loaded,
  ...handlers
}: {
  title: string
  testId: string
  items: Artifact[]
  menu?: React.ReactNode
  renameInput?: React.ReactNode
  muted?: boolean
  canManage?: boolean
  scrollTo?: boolean
  // Every page of the collection is in — gates the anchor scroll so it lands on a settled
  // layout, not the thin first page.
  loaded?: boolean
} & CardHandlers) {
  const [open, setOpen] = useState(true)
  const ref = useRef<HTMLDivElement>(null)
  // Land on this folder when it's the breadcrumb's `?folder=` anchor — but only once the
  // whole collection has loaded (else earlier folders fill in and shove this one down).
  // Instant (not smooth) so it can't fight a reduced-motion preference; latched so it fires
  // exactly once per mount (a fresh navigation remounts the section and resets the latch).
  const anchored = useRef(false)
  useEffect(() => {
    if (!scrollTo || !loaded || anchored.current) return
    anchored.current = true
    ref.current?.scrollIntoView({ block: "start" })
  }, [scrollTo, loaded])
  if (renameInput) return <div>{renameInput}</div>
  return (
    <div ref={ref} className="group/folder scroll-mt-4">
      {/* A hairline under the header makes the group boundary read at a glance without
          shouting — the sanctioned section register, not file-manager chrome. */}
      <div className="flex items-center gap-2 border-b border-border-soft pb-1.5">
        <button
          type="button"
          data-testid={`${testId}-toggle`}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          {/* A named folder gets the folder glyph; the "Unfiled" leftover bucket gets NO
              icon and a lighter, non-medium label so it never reads as a folder someone
              literally named "Unfiled". */}
          {!muted && <Icon name="collection" className="text-muted-foreground" />}
          <span
            className={cn(
              "truncate text-sm",
              muted ? "font-normal text-muted-foreground" : "font-medium text-foreground",
            )}
          >
            {title}
          </span>
          <Count>{items.length}</Count>
        </button>
        {menu}
      </div>
      {open && items.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          No artifacts yet{canManage ? " — use “Move to folder” to file some here." : "."}
        </p>
      )}
      {open && items.length > 0 && (
        <div className="mt-3">
          <CardGrid>
            {items.map((a) => (
              <ArtifactCard
                key={a.short_id}
                artifact={a}
                onOpen={() => handlers.onOpen(a)}
                onToggleFavorite={() => handlers.onToggleFavorite(a)}
                onPickTag={handlers.onPickTag}
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
          </CardGrid>
        </div>
      )}
    </div>
  )
}
