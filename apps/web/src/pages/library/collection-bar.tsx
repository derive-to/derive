import { useEffect, useState } from "react"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// The bar shown when viewing a collection: title, count, and the owner actions
// (share / rename / delete). Share is the headline — it grants the role on
// every artifact in the collection.
export function CollectionBar({
  title,
  count,
  onShare,
  onRename,
  onDelete,
}: {
  title: string
  count: number
  onShare: () => void
  onRename: (title: string) => void
  onDelete: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(title)
  useEffect(() => setDraft(title), [title])

  const commitRename = () => {
    if (draft.trim()) onRename(draft.trim())
    setRenaming(false)
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2.5 border-b border-border-soft pb-3.5">
      <Icon name="collection" size={18} className="text-muted-foreground" />
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
          className="max-w-[280px] text-lg font-medium"
        />
      ) : (
        // The collection's name is the user's content, not tool chrome — voice
        // register; the count rides along in the machine register.
        <h2 className="font-serif text-xl font-medium tracking-tight text-foreground">
          {title}{" "}
          <span className="font-mono text-xs font-normal tracking-normal text-muted-foreground tabular-nums">
            · {count}
          </span>
        </h2>
      )}
      <span className="flex-1" />
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
        onClick={() => {
          if (confirm(`Delete the collection “${title}”? The artifacts are not deleted.`))
            onDelete()
        }}
      >
        Delete
      </Button>
    </div>
  )
}
