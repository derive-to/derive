import { useEffect, useState } from "react"
import { api, type Collection } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { artifactQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useBrandprintCollectionIds } from "@/lib/use-brandprint-ids"
import { cn } from "@/lib/utils"

// The "organize" dialog, shared by the artifact workbench's ⋯ menu and the library
// cards' quick-actions menu (controlled by both): toggle this artifact in/out of
// collections, or create one on the fly. Adding to a shared collection grants its members
// their role on this artifact too. Owns its API calls and reports the new state through
// `onChange`; the caller keeps the cache writes.
export function CollectionsDialog({
  shortId,
  inCollections,
  onChange,
  open,
  onOpenChange,
}: {
  shortId: string
  inCollections: string[]
  onChange: (ids: string[]) => void
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [all, setAll] = useState<Collection[]>([])
  const [draft, setDraft] = useState("")
  useEffect(() => {
    if (open)
      api
        .listCollections()
        .then((r) => setAll(r.collections))
        .catch(() => {})
  }, [open])
  // Brandprint-pointed collections take docs through /brandprint only, not from
  // an artifact's organize menu.
  const brandprintIds = useBrandprintCollectionIds()
  const pickable = all.filter((col) => !brandprintIds.has(col.id))
  const inSet = new Set(inCollections)
  // Toggle membership optimistically (via onChange); the primitive rolls it back and
  // toasts if the write fails. The settle-time invalidation reconciles the artifact
  // detail (`collections` AND the server-computed `collection_access` disclosure rows)
  // against the server once the write lands — never during the optimistic phase, where
  // a refetch would race the in-flight PUT and repaint pre-mutation state.
  const toggleCol = useApiMutation({
    mutationFn: ({ col, isIn }: { col: Collection; isIn: boolean }) =>
      isIn ? api.removeFromCollection(col.id, shortId) : api.addToCollection(col.id, shortId),
    optimistic: ({ col, isIn }) => {
      const prev = inCollections
      onChange(isIn ? inCollections.filter((id) => id !== col.id) : [...inCollections, col.id])
      return () => onChange(prev)
    },
    invalidate: [artifactQuery(shortId).queryKey],
  })
  const toggle = (col: Collection) => toggleCol.mutate({ col, isIn: inSet.has(col.id) })
  // Create a collection and drop this artifact into it in one gesture.
  const createCol = useApiMutation({
    mutationFn: async (title: string) => {
      const col = await api.createCollection(title)
      await api.addToCollection(col.id, shortId)
      return col
    },
    onSuccess: (col) => {
      setAll((a) => [col, ...a])
      onChange([...inCollections, col.id])
    },
    invalidate: [artifactQuery(shortId).queryKey],
  })
  const create = () => {
    const t = draft.trim()
    setDraft("")
    if (t) createCol.mutate(t)
  }
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
        {pickable.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No collections yet — create one below.
          </div>
        )}
        {pickable.length > 0 && (
          <div className="flex max-h-64 flex-col gap-px overflow-auto">
            {pickable.map((col) => (
              <button
                key={col.id}
                type="button"
                data-testid={`collections-menu-${col.id}`}
                onClick={() => toggle(col)}
                className={cn(
                  // Menu-row grammar (the dropdown item recipe): rounded-lg,
                  // neutral bg-accent hover — never a second wash token.
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  inSet.has(col.id) && "bg-accent",
                )}
              >
                <span className="grid w-3.5 shrink-0 place-items-center">
                  {inSet.has(col.id) && <Icon name="check" size={16} />}
                </span>
                <span className="flex-1 truncate">{col.title}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <Input
            value={draft}
            placeholder="New collection…"
            data-testid="collection-new-input"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create()
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={create}
            disabled={!draft.trim()}
            data-testid="collection-add"
          >
            Add
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
