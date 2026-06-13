import { useEffect, useState } from "react"
import { api, type Collection } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input, Textarea } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

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
      variant="outline"
      size="sm"
      onClick={toggle}
      disabled={busy}
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      aria-label="Toggle favorite"
      aria-pressed={favorite}
      data-testid="artifact-star"
      className={cn(favorite && "border-gold text-gold hover:text-gold")}
    >
      <Icon name="star" size={16} className={cn(!favorite && "text-muted-foreground")} />
    </Button>
  )
}

// Header report popover: anyone viewing can flag an artifact for moderation.
// A short reason is required; owners triage the queue in Settings.
export function ReportButton({
  shortId,
  onDone,
}: {
  shortId: string
  onDone: (msg: string) => void
}) {
  const [open, setOpen] = useState(false)
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
      onDone("Reported — thanks for flagging this")
    } catch (e) {
      onDone((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title="Report this artifact"
          aria-label="Report"
          data-testid="artifact-report"
        >
          <Icon name="report" size={16} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        {sent ? (
          <div className="text-sm leading-relaxed text-muted-foreground">
            Thanks — this has been flagged for review.
          </div>
        ) : (
          <>
            <div className="mb-2 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
              Report artifact
            </div>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What's wrong with this? (required)"
              rows={3}
              data-testid="report-reason"
              className="resize-none text-sm"
            />
            <div className="mt-2 flex justify-end gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={submit}
                disabled={!reason.trim() || busy}
                data-testid="report-submit"
              >
                {busy ? "Sending…" : "Report"}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

// Header collections popover: toggle this artifact in/out of collections, or
// create one on the fly. Adding to a shared collection grants its members their
// role on this artifact too.
export function CollectionsMenu({
  shortId,
  inCollections,
  onChange,
}: {
  shortId: string
  inCollections: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
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
    } catch {
      onChange(inCollections)
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
    } catch {
      /* ignore */
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          title="Collections"
          data-testid="artifact-collections"
        >
          <Icon name="collections" size={16} />
          {inCollections.length > 0 && <b className="font-bold">{inCollections.length}</b>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[340px] w-[248px] overflow-auto">
        <div className="mb-2 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
          Add to collection
        </div>
        {all.length === 0 && (
          <div className="mb-2 text-sm text-muted-foreground">
            No collections yet — create one below.
          </div>
        )}
        {all.length > 0 && (
          <div className="mb-2.5 flex flex-col gap-px">
            {all.map((col) => (
              <button
                key={col.id}
                type="button"
                onClick={() => toggle(col)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-hover",
                  inSet.has(col.id) && "bg-accent",
                )}
              >
                <span className="w-3.5 text-primary">{inSet.has(col.id) ? "✓" : ""}</span>
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
            className="h-8 text-sm"
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
      </PopoverContent>
    </Popover>
  )
}

// Header tags popover: view tags; editors add/remove. Writes replace the full
// set (the server normalizes: trim, lowercase, dedupe, cap).
export function TagsMenu({
  shortId,
  tags,
  canEdit,
  onChange,
}: {
  shortId: string
  tags: string[]
  canEdit: boolean
  onChange: (t: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const save = async (next: string[]) => {
    onChange(next)
    try {
      const r = await api.setTags(shortId, next)
      onChange(r.tags)
    } catch {
      /* keep the optimistic value */
    }
  }
  const add = () => {
    const v = draft.trim().toLowerCase()
    setDraft("")
    if (v && !tags.includes(v)) save([...tags, v])
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          title="Tags"
          data-testid="artifact-tags"
        >
          <Icon name="tag" size={16} />
          {tags.length > 0 && <b className="font-bold">{tags.length}</b>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[244px]">
        <div className="mb-2 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
          Tags
        </div>
        {tags.length === 0 && (
          <div className={cn("text-sm text-muted-foreground", canEdit && "mb-2")}>
            {canEdit ? "No tags yet — add one below." : "No tags."}
          </div>
        )}
        {tags.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", canEdit && "mb-2.5")}>
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 font-mono text-2xs text-primary"
              >
                #{t}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => save(tags.filter((x) => x !== t))}
                    aria-label={`Remove ${t}`}
                    className="leading-none text-primary"
                  >
                    ×
                  </button>
                )}
              </span>
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
              className="h-8 text-sm"
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
      </PopoverContent>
    </Popover>
  )
}

// Phones: a slide-up sheet over the document. The pinned document-margin is a
// desktop affordance (it needs a margin); here every open thread is a flat
// card with its quote, and tapping the quote jumps to the text + closes the
// sheet. Reuses CommentCard / Composer / ResolvedSection so behaviour (replies,
// reactions, edit/delete, resolve, re-anchoring) matches desktop exactly.
