import { Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Icon } from "@/components/icons"
import { Breadcrumb, CrumbSep, crumbClass } from "@/components/shared/breadcrumb"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { Count } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// The bar shown when viewing a collection: where you are, and the owner actions
// (share / rename / delete). Share is the headline — it grants the role on every
// artifact in the collection.
//
// The name is the LEAF of a breadcrumb, so the bar answers "where am I" and "how do I
// get back" in the line that was already showing the title. That replaces the `×
// Collection` chip that used to sit in the toolbar as the only way out — a second
// statement of the same fact, in a worse place for it.
export function CollectionBar({
  title,
  count,
  ancestors,
  onShare,
  starred,
  onStar,
  onRename,
  onDelete,
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
    <div className="mb-4 flex flex-wrap items-center gap-2.5 border-b border-border-soft pb-3.5">
      {!renaming && (
        <Breadcrumb>
          {ancestors.map((a, i) => (
            <span key={a.label} className="flex min-w-0 items-center gap-1.5">
              <Link
                to="/"
                search={a.collection ? { collection: a.collection } : {}}
                data-testid={`crumb-${i}`}
                title={`Back to ${a.label}`}
                className={crumbClass(ancestors.length > 1 && i < ancestors.length - 1)}
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
          className="max-w-70"
        />
      ) : (
        // The collection's name is the user's content, not tool chrome — voice
        // register; the count rides along in the machine register.
        <h2 className="font-serif text-xl font-medium tracking-tight text-foreground">
          {title} <Count className="font-normal tracking-normal">{count}</Count>
        </h2>
      )}
      <span className="flex-1" />
      {/* The star is the whole pinning mechanism — same verb as an artifact's, so there
          is one idea to learn rather than a separate "add to sidebar". Ghost, never
          filled: Share is this view's single ink moment. */}
      {onStar && (
        <Button
          variant="ghost"
          size="sm"
          data-testid="collection-star"
          aria-pressed={!!starred}
          title={starred ? "Unstar — remove from your sidebar" : "Star — pin to your sidebar"}
          onClick={() => onStar(!starred)}
        >
          <Icon
            name="star"
            size={16}
            weight={starred ? "fill" : "regular"}
            className={starred ? "text-primary" : undefined}
          />
          {starred ? "Starred" : "Star"}
        </Button>
      )}
      {/* Share is the collection view's one filled primary (the publish launcher
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
      <Button
        variant="outline"
        size="sm"
        data-testid="collection-rename"
        onClick={() => (renaming ? commitRename() : setRenaming(true))}
      >
        {renaming ? "Save" : "Rename"}
      </Button>
      <Button
        variant="destructive"
        size="sm"
        data-testid="collection-delete"
        onClick={() => setConfirmingDelete(true)}
      >
        Delete
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
