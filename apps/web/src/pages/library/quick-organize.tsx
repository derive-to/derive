import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import type { Artifact } from "@/api"
import { CollectionsDialog, TagsDialog } from "@/components/shared/organize-dialogs"
import { artifactQuery } from "@/lib/queries"

// Library-level mounts for the card ⋯ menu's organize actions. The shared
// dialogs own the API calls; these wrappers own the state the dialogs render
// from, and report changes up so LibraryBody can sync its caches. Mounted only
// while staged (`{pending && <…/>}`).

// Close by letting Radix finish first: the dialog holds a pointer-events lock
// on <body> until its exit transition ends, and unmounting it mid-close leaks
// the lock — the page keeps rendering but stops accepting clicks. So flip
// `open` (Radix animates out and releases), THEN unmount.
function useDialogClose(onClose: () => void) {
  const [open, setOpen] = useState(true)
  const onOpenChange = (o: boolean) => {
    if (o) return
    setOpen(false)
    window.setTimeout(onClose, 200)
  }
  return { open, onOpenChange }
}

export function LibraryTagsDialog({
  artifact,
  onChange,
  onClose,
}: {
  artifact: Artifact
  onChange: (shortId: string, tags: string[]) => void
  onClose: () => void
}) {
  const close = useDialogClose(onClose)
  // Tags ride on the list payload; local state keeps the dialog's chips live
  // across its optimistic + server-normalized onChange calls.
  const [tags, setTags] = useState(artifact.tags ?? [])
  return (
    <TagsDialog
      shortId={artifact.short_id}
      tags={tags}
      canEdit={artifact.my_role === "owner" || artifact.my_role === "editor"}
      onChange={(t) => {
        setTags(t)
        onChange(artifact.short_id, t)
      }}
      {...close}
    />
  )
}

export function LibraryCollectionsDialog({
  artifact,
  onChange,
  onClose,
}: {
  artifact: Artifact
  onChange: (shortId: string, ids: string[]) => void
  onClose: () => void
}) {
  const close = useDialogClose(onClose)
  // Collection membership rides only on the detail payload, so fetch it on
  // open — one cached request, usually already warmed by the card-hover
  // prefetch. Until the first toggle, membership reads straight off the query.
  const { data } = useQuery(artifactQuery(artifact.short_id))
  const [ids, setIds] = useState<string[] | null>(null)
  return (
    <CollectionsDialog
      shortId={artifact.short_id}
      inCollections={ids ?? data?.collections ?? []}
      onChange={(next) => {
        setIds(next)
        onChange(artifact.short_id, next)
      }}
      {...close}
    />
  )
}
