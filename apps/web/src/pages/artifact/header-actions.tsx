import { useEffect, useState } from "react"
import { api, type Collection } from "@/api"
import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/sonner"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

// Favorite is the one property kept VISIBLE in the header — the filled star is a
// glanceable state (you see at a glance that this artifact is starred), and a
// sanctioned ink moment. Everything else (tags, collections, report) opens from the
// ⋯ menu as a dialog.
export function StarButton({
  shortId,
  favorite,
  onChange,
}: {
  shortId: string
  favorite: boolean
  onChange: (f: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    const next = !favorite
    onChange(next)
    setBusy(true)
    try {
      await api.favorite(shortId, next)
    } catch {
      onChange(!next)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      disabled={busy}
      // Icon-only chrome carries its label via aria-label + aria-pressed, not a
      // `title` (invisible to keyboard + touch) — the house chrome pattern.
      aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={favorite}
      data-testid="artifact-star"
    >
      <Icon
        name="star"
        size={16}
        weight={favorite ? "fill" : "regular"}
        className={favorite ? "text-primary" : "text-muted-foreground"}
      />
    </Button>
  )
}

// Report dialog: anyone viewing can flag an artifact for moderation. Opened from
// the ⋯ menu (a rare action). A short reason is required; owners triage the queue
// in Settings.
export function ReportDialog({
  shortId,
  open,
  onOpenChange,
}: {
  shortId: string
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [reason, setReason] = useState("")
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const r = reason.trim()
    if (!r || busy) return
    setBusy(true)
    try {
      await api.report(shortId, r)
      setSent(true)
      toast.success("Reported — thanks for flagging this")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report artifact</DialogTitle>
          <DialogDescription>
            Flag this for moderation. Owners triage reports in Settings.
          </DialogDescription>
        </DialogHeader>
        {sent ? (
          <div className="text-sm leading-relaxed text-muted-foreground">
            Thanks — this has been flagged for review.
          </div>
        ) : (
          <>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What's wrong with this? (required)"
              rows={3}
              data-testid="report-reason"
              className="resize-none"
            />
            <div className="flex justify-end gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                data-testid="report-cancel"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={submit}
                loading={busy}
                disabled={!reason.trim()}
                data-testid="report-submit"
              >
                {busy ? "Sending…" : "Report"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Collections dialog: toggle this artifact in/out of collections, or create one on
// the fly. Adding to a shared collection grants its members their role on this
// artifact too. Opened from the ⋯ menu (controlled).
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
  const inSet = new Set(inCollections)
  const toggle = async (col: Collection) => {
    const isIn = inSet.has(col.id)
    onChange(isIn ? inCollections.filter((id) => id !== col.id) : [...inCollections, col.id])
    try {
      if (isIn) await api.removeFromCollection(col.id, shortId)
      else await api.addToCollection(col.id, shortId)
    } catch (e) {
      onChange(inCollections)
      toast.error(e instanceof Error ? e.message : "Couldn't update collections")
    }
  }
  const create = async () => {
    const t = draft.trim()
    setDraft("")
    if (!t) return
    try {
      const col = await api.createCollection(t)
      await api.addToCollection(col.id, shortId)
      setAll((a) => [col, ...a])
      onChange([...inCollections, col.id])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create collection")
    }
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
        {all.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No collections yet — create one below.
          </div>
        )}
        {all.length > 0 && (
          <div className="flex max-h-64 flex-col gap-px overflow-auto">
            {all.map((col) => (
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

// Tags dialog: view tags; editors add/remove. Writes replace the full set (the
// server normalizes: trim, lowercase, dedupe, cap). Opened from the ⋯ menu.
export function TagsDialog({
  shortId,
  tags,
  canEdit,
  onChange,
  open,
  onOpenChange,
}: {
  shortId: string
  tags: string[]
  canEdit: boolean
  onChange: (t: string[]) => void
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [draft, setDraft] = useState("")
  const save = async (next: string[]) => {
    onChange(next)
    try {
      const r = await api.setTags(shortId, next)
      onChange(r.tags)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save tags")
    }
  }
  const add = () => {
    const v = draft.trim().toLowerCase()
    setDraft("")
    if (v && !tags.includes(v)) save([...tags, v])
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tags</DialogTitle>
          <DialogDescription>
            Workspace-wide labels for finding this artifact later.
          </DialogDescription>
        </DialogHeader>
        {tags.length === 0 && (
          <div className="text-sm text-muted-foreground">
            {canEdit ? "No tags yet — add one below." : "No tags."}
          </div>
        )}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <Badge key={t} variant="outline" className="gap-1">
                #{t}
                {canEdit && (
                  <button
                    type="button"
                    data-icon="inline-end"
                    data-testid={`tag-remove-${t}`}
                    onClick={() => save(tags.filter((x) => x !== t))}
                    aria-label={`Remove ${t}`}
                    className="rounded-sm outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </Badge>
            ))}
          </div>
        )}
        {canEdit && (
          <div className="flex gap-1.5">
            <Input
              value={draft}
              placeholder="Add a tag…"
              data-testid="tag-new-input"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add()
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={add}
              disabled={!draft.trim()}
              data-testid="tag-add"
            >
              Add
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
