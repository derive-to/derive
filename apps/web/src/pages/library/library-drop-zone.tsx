import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { collectionsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

// The whole library is the drop target.
//
// The old publish card carried a drop zone as one card's affordance; when the card
// went, drag-and-drop went with it. This restores it at the size the gesture actually
// has: you're holding a file over the app — the app, not a 60px strip of it, should
// say "drop it". Invisible until a file drag enters the window, so it costs the page
// nothing at rest; on a collection page the drop also files the artifact there, which
// is what dropping "into" a collection should obviously mean.
//
// Deliberately NOT a paste target and NOT text-drag aware — files only. Text belongs
// in the editor.
const MAX_FILES = 10

export function LibraryDropZone({
  collection,
  collectionTitle,
}: {
  /** Present on a collection page: dropped files are filed here after publishing. */
  collection?: string
  collectionTitle?: string
}) {
  const qc = useQueryClient()
  // Depth-counted: dragenter/dragleave fire for every child the cursor crosses, and a
  // boolean flickers the overlay off at each boundary.
  const depth = useRef(0)
  const [over, setOver] = useState(false)

  const publish = useApiMutation({
    mutationFn: async (files: File[]) => {
      const batch = files.slice(0, MAX_FILES)
      for (const f of batch) {
        const a = await api.publish(f, { title: f.name.replace(/\.[^.]+$/, "") })
        if (collection) await api.addToCollection(collection, a.short_id)
      }
      return batch.length
    },
    invalidate: [collectionsQuery().queryKey],
    success: (n) => (n === 1 ? "Published" : `Published ${n} artifacts`),
    onSuccess: () => {
      // Every feed variant lives under the ["artifacts"] prefix (see lib/queries) —
      // the drop can land on any of them, so invalidate the prefix, not one key.
      qc.invalidateQueries({ queryKey: ["artifacts"] })
    },
  })

  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files")
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current += 1
      setOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    }
    // preventDefault on dragover is what makes the window a legal drop target at all —
    // without it the browser navigates to the file.
    const overWin = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      depth.current = 0
      setOver(false)
      if (!hasFiles(e)) return
      e.preventDefault()
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length > 0) publish.mutate(files)
    }
    // A drag abandoned outside the window never fires dragleave.
    const end = () => {
      depth.current = 0
      setOver(false)
    }
    window.addEventListener("dragenter", enter)
    window.addEventListener("dragleave", leave)
    window.addEventListener("dragover", overWin)
    window.addEventListener("drop", drop)
    window.addEventListener("dragend", end)
    return () => {
      window.removeEventListener("dragenter", enter)
      window.removeEventListener("dragleave", leave)
      window.removeEventListener("dragover", overWin)
      window.removeEventListener("drop", drop)
      window.removeEventListener("dragend", end)
    }
  }, [publish.mutate])

  if (!over) return null
  return (
    <div
      data-testid="library-drop-overlay"
      // The overlay never handles events itself — the window listeners do — so it can't
      // steal the drop from its own edges.
      className="pointer-events-none fixed inset-0 z-50 bg-background/85 p-6"
    >
      <div className="grid h-full place-items-center rounded-2xl border-2 border-dashed border-foreground/30">
        <div className="flex flex-col items-center gap-2 text-center">
          <Icon name="collections" size={28} className="text-muted-foreground" aria-hidden />
          <p className="font-serif text-lg font-semibold tracking-tight text-foreground">
            Drop to publish
          </p>
          <p className="font-mono text-2xs text-muted-foreground">
            {collection && collectionTitle
              ? `Files land in ${collectionTitle}`
              : "Each file becomes an artifact"}
          </p>
        </div>
      </div>
    </div>
  )
}
