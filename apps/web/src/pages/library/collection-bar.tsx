import { useEffect, useState } from "react"
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
      <span className="text-xl">📁</span>
      {renaming ? (
        <Input
          value={draft}
          autoFocus
          aria-label="Collection name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename()
            if (e.key === "Escape") setRenaming(false)
          }}
          className="max-w-[280px] text-lg font-semibold"
        />
      ) : (
        <h2 className="font-display text-xl font-semibold">
          {title} <span className="text-sm font-normal text-muted-foreground">· {count}</span>
        </h2>
      )}
      <span className="flex-1" />
      <Button variant="primary" size="sm" onClick={onShare} title="Share this collection">
        🔗 Share
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => (renaming ? commitRename() : setRenaming(true))}
      >
        {renaming ? "Save" : "Rename"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
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
