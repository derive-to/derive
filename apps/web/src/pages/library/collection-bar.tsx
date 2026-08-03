import { Link } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import { Icon } from "@/components/icons"
import { Breadcrumb, CrumbSep, crumbClass } from "@/components/shared/breadcrumb"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// The collection page's ONE chrome row: where you are on the left, what you can do on
// the right, and nothing louder than the name.
//
// What this replaced was three rows of chrome (~130px) whose loudest element was the
// filter input and whose row of four same-sized boxes gave Star, Share, Rename and
// Delete one visual weight for four different kinds of decision. The grammar now:
//
//   - Identity first, once. Breadcrumb + name + count; the count appears nowhere else.
//   - Rename IS the name: click the title (also in ⋯, for discoverability).
//   - One filled action — Share, the page's headline act (it grants the role on every
//     artifact in the collection). Star drops to a quiet icon.
//   - Destructive and occasional actions live behind ⋯: Rename, New folder, Delete
//     (with its confirm). Delete as permanent red furniture was an alarm that never
//     stopped ringing.
//
// `tools` is the slot for the page-level instruments the library owns (compact filter,
// ask, display) so the whole row composes in one place.
export function CollectionBar({
  title,
  count,
  ancestors,
  onShare,
  starred,
  onStar,
  onRename,
  onDelete,
  onNewFolder,
  tools,
}: {
  title: string
  count: number
  /** Links above this collection, outermost first: always the library, plus the parent
   *  repo when this is a pull-request preview. `collection` omitted = the library root. */
  ancestors: { label: string; collection?: string }[]
  onShare: () => void
  /** Null when the collection isn't loaded yet — the control hides rather than
   *  guessing a state it would then have to correct. */
  starred?: boolean
  onStar?: (next: boolean) => void
  onRename: (title: string) => void
  onDelete: () => void
  /** Present on manual collections the caller can manage — surfaces "New folder" in ⋯. */
  onNewFolder?: () => void
  /** The library's instruments (filter, ask, display), rendered between identity and
   *  actions. */
  tools?: ReactNode
}) {
  const [renaming, setRenaming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [draft, setDraft] = useState(title)
  useEffect(() => setDraft(title), [title])

  const commitRename = () => {
    if (draft.trim()) onRename(draft.trim())
    setRenaming(false)
  }

  return (
    <div className="mb-4 flex min-h-11 flex-wrap items-center gap-1.5 border-b border-border-soft pb-2">
      {!renaming && (
        <Breadcrumb>
          {ancestors.map((a, i) => (
            <span key={a.label} className="flex min-w-0 items-center gap-1.5">
              <Link
                to="/"
                search={a.collection ? { collection: a.collection } : {}}
                data-testid={`crumb-${i}`}
                title={`Back to ${a.label}`}
                // The leaf's exact face and size — the trail is one run of type, and
                // muted ink + regular weight alone say "ancestor".
                className={cn(
                  "font-serif text-lg tracking-tight",
                  crumbClass(ancestors.length > 1 && i < ancestors.length - 1),
                )}
              >
                {a.label}
              </Link>
              <CrumbSep />
            </span>
          ))}
        </Breadcrumb>
      )}
      {renaming ? (
        <Input
          value={draft}
          autoFocus
          data-testid="collection-rename-input"
          aria-label="Collection name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename()
            if (e.key === "Escape") setRenaming(false)
          }}
          onBlur={commitRename}
          className="max-w-70"
        />
      ) : (
        // The name is the page's loudest element, and it behaves like a name: click to
        // rename. The count rides in the machine register, one step under the crumb.
        <h2 className="flex min-w-0 items-baseline gap-2">
          <button
            type="button"
            data-testid="collection-rename"
            title="Rename"
            onClick={() => setRenaming(true)}
            className="min-w-0 cursor-text truncate rounded-sm text-left font-serif text-lg font-semibold tracking-tight text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {title}
          </button>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        </h2>
      )}
      <span className="min-w-4 flex-1" />
      {tools}
      {/* The star is the whole pinning mechanism — same verb as an artifact's. A quiet
          icon: Share holds this page's single ink moment. */}
      {onStar && (
        <button
          type="button"
          data-testid="collection-star"
          aria-pressed={!!starred}
          aria-label={starred ? "Unstar" : "Star"}
          title={starred ? "Unstar — remove from your sidebar" : "Star — pin to your sidebar"}
          onClick={() => onStar(!starred)}
          className="grid size-7 shrink-0 place-items-center rounded-md outline-none transition-colors duration-state hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          <Icon
            name="star"
            size={15}
            weight={starred ? "fill" : "regular"}
            className={starred ? "text-primary" : "text-muted-foreground"}
          />
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="collection-more"
            aria-label="More actions"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-state hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <Icon name="more" size={15} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid="collection-menu-rename" onSelect={() => setRenaming(true)}>
            <Icon name="edit" size={16} /> Rename
          </DropdownMenuItem>
          {onNewFolder && (
            <DropdownMenuItem data-testid="collection-new-folder" onSelect={onNewFolder}>
              <Icon name="collection" size={16} /> New folder
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="collection-delete"
            variant="destructive"
            onSelect={() => setConfirmingDelete(true)}
          >
            <Icon name="delete" size={16} /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Share is the collection page's one filled primary (the publish launcher
          doesn't render on this view). */}
      <Button
        variant="default"
        size="sm"
        data-testid="collection-share"
        onClick={onShare}
        title="Share this collection"
      >
        <Icon name="share" size={16} /> Share
      </Button>
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete “${title}”?`}
        description="The artifacts in it are not deleted."
        confirmLabel="Delete"
        confirmTestId="collection-delete-confirm"
        onConfirm={onDelete}
      />
    </div>
  )
}
