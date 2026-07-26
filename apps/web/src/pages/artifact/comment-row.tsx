import { useLayoutEffect, useRef, useState } from "react"
import type { Comment } from "@/api"
import { Icon } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { getInitials } from "@/lib/initials"
import { agoShort } from "@/lib/time"
import { cn } from "@/lib/utils"
import { useActions } from "./comment-actions"
import { mdToHtml } from "./lib/markdown"
import { REACTION_EMOJI } from "./lib/reactions"

// A comment's rendered body. In a thread (not compact) a long body is clamped to
// a few lines with a "Show more" toggle, so one wall of text can't dominate the
// panel; the rail preview keeps its 2-line clamp. Height is measured after layout
// (scrollHeight reports the full content even while clamped).
function CommentBody({ html, compact }: { html: string; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const MAX_PX = 168
  useLayoutEffect(() => {
    const el = ref.current
    // Re-measure whenever the rendered body (html) or mode changes.
    if (compact || !html || !el) {
      setOverflows(false)
      return
    }
    setOverflows(el.scrollHeight > MAX_PX + 16)
  }, [html, compact])
  const clamped = !compact && overflows && !expanded
  return (
    <div>
      <div
        ref={ref}
        className={cn(
          "cmt-body text-sm [word-break:break-word]",
          compact && "line-clamp-2",
          clamped &&
            "max-h-42 overflow-hidden [mask-image:linear-gradient(to_bottom,#000_120px,transparent)]",
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: input is escaped first in mdToHtml.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {!compact && overflows && (
        <Button
          variant="link"
          size="xs"
          data-testid="comment-toggle-length"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          className="mt-1 px-0"
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  )
}

export function CommentRow({
  c,
  compact,
  grouped,
}: {
  c: Comment
  compact?: boolean
  /** A consecutive message from the SAME author: the identity header drops and
   *  the body continues in the text column — "Rob, Rob, Rob" collapses to one
   *  voice (the thread reads as conversation, not stacked row-cards). */
  grouped?: boolean
}) {
  const A = useActions()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(c.body_md)
  const [open, setOpen] = useState<null | "react" | "menu">(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const mine = !!A.meName && c.author === A.meName
  const reactions = c.reactions ?? {}

  if (c.deleted)
    return (
      <div className={cn("px-3 pt-1 pb-1.5", !grouped && "pt-2.5")}>
        <span className="pl-7 text-sm italic text-muted-foreground">Comment deleted</span>
      </div>
    )

  return (
    <div
      data-testid="comment-row"
      // An optimistic (not-yet-saved) comment carries a `temp-` id; dim it slightly
      // until the server row swaps in, so "sending" vs "sent" reads at a glance.
      // No divider between rows — the thread is one object; rhythm comes from
      // spacing (a grouped follow-up sits tight under its predecessor).
      className={cn(
        "group relative px-3 pb-1",
        grouped ? "pt-0.5" : "pt-2.5",
        c.id.startsWith("temp-") && "opacity-60",
      )}
    >
      {!grouped && (
        <div className="mb-0.5 flex items-center gap-2">
          <Avatar className="size-5">
            <AvatarFallback className="text-2xs">{getInitials(c.author)}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{c.author}</span>
          {/* Terse: "1h", not "1h ago" — repeated per row, the word is noise; the
              precise date is a hover away. */}
          <span
            title={new Date(c.created_at).toLocaleString()}
            className="font-mono text-2xs tabular-nums text-muted-foreground/80"
          >
            {agoShort(c.created_at)}
            {c.edited ? " · edited" : ""}
          </span>
        </div>
      )}

      {editing ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper, not an interactive control
        // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper, not an interactive control
        <div className="pl-7" onClick={(e) => e.stopPropagation()}>
          <Textarea
            value={draft}
            autoFocus
            data-testid="comment-edit-input"
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-14 resize-y"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setEditing(false)
                setDraft(c.body_md)
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
                void A.edit(c.id, draft)
                setEditing(false)
              }
            }}
          />
          <div className="mt-1.5 flex gap-1.5">
            <Button
              variant="default"
              size="sm"
              disabled={!draft.trim()}
              data-testid="comment-edit-save"
              onClick={async () => {
                await A.edit(c.id, draft)
                setEditing(false)
              }}
            >
              Save
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="comment-edit-cancel"
              onClick={() => {
                setEditing(false)
                setDraft(c.body_md)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        // The body lives in the TEXT COLUMN (past the avatar gutter), so every
        // line in the thread — names and prose alike — shares one left edge.
        <div className="pl-7">
          <CommentBody html={mdToHtml(c.body_md, c.mentions)} compact={compact} />
        </div>
      )}

      {Object.keys(reactions).length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1 pl-7">
          {Object.entries(reactions).map(([emoji, who]) => {
            const reacted = who.includes(A.meName)
            return (
              // The one sanctioned pill (Badge shape="pill", asChild button — the
              // library tag-chip pattern); the mono 2xs tabular count register is
              // baked into the pill. Reacted (toggled-on) = the neutral default
              // wash + re-inked text, per the selected-state rule — never an ink
              // tint; unreacted stays a quiet outline (hover brightens the hairline).
              <Badge
                key={emoji}
                asChild
                shape="pill"
                variant={reacted ? "default" : "outline"}
                className={reacted ? undefined : "hover:border-foreground/25 hover:text-foreground"}
              >
                <button
                  type="button"
                  data-testid={`reaction-pill-${emoji}`}
                  // title shows on mouse hover; aria-label carries the same reactor list to
                  // keyboard + touch (where title never appears), and aria-pressed exposes
                  // the toggle state.
                  title={who.join(", ")}
                  aria-label={`${emoji}, ${who.length}: ${who.join(", ")}`}
                  aria-pressed={reacted}
                  onClick={(e) => {
                    e.stopPropagation()
                    A.react(c.id, emoji)
                  }}
                >
                  {/* The emoji keeps its original glyph size; the count takes the pill's register. */}
                  <span className="text-xs">{emoji}</span>
                  <span>{who.length}</span>
                </button>
              </Badge>
            )
          })}
        </div>
      )}

      {!editing && (
        // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper around the action toolbar, not a control
        // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper around the action toolbar, not a control
        <div
          // Reveal via opacity only, never a pointer-events toggle (the
          // artifact-card ⋯ pattern): gating pointer-events on :hover leaves a
          // dead toolbar when the row remounts under a stationary pointer (the
          // comments refetch after an edit) — :hover isn't re-applied to a
          // replaced node until the mouse moves.
          // Straddles ITS row's top edge (each row is its own hover group), so
          // the actions visibly belong to the message under the pointer; flat
          // card language (bg-card + hairline), not popover chrome.
          className={cn(
            "-top-2 absolute right-3 z-6 flex rounded-md bg-card ring-1 ring-border transition-opacity",
            open
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Popover open={open === "react"} onOpenChange={(o) => setOpen(o ? "react" : null)}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Add reaction"
                data-testid="comment-react"
              >
                <Icon name="react" className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-1">
              <div className="grid grid-cols-4 gap-px">
                {REACTION_EMOJI.map((em) => (
                  <button
                    key={em}
                    type="button"
                    aria-label={`React with ${em}`}
                    data-testid={`react-emoji-${em}`}
                    onClick={() => {
                      A.react(c.id, em)
                      setOpen(null)
                    }}
                    className="grid size-7 place-items-center rounded-md text-lg outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    {em}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <DropdownMenu open={open === "menu"} onOpenChange={(o) => setOpen(o ? "menu" : null)}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Comment actions"
                data-testid="comment-more"
              >
                <Icon name="more" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {mine && (
                <DropdownMenuItem data-testid="comment-edit" onSelect={() => setEditing(true)}>
                  <Icon name="pencil" /> Edit
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                data-testid="comment-copy-link"
                onSelect={() => A.copyLink(c.thread_id)}
              >
                <Icon name="link" /> Copy link
              </DropdownMenuItem>
              {mine && (
                <DropdownMenuItem
                  variant="destructive"
                  data-testid="comment-delete"
                  onSelect={() => setConfirmDelete(true)}
                >
                  <Icon name="delete" /> Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this comment?"
        description="The comment is removed from the thread for everyone."
        confirmLabel="Delete"
        onConfirm={() => A.remove(c.id)}
        confirmTestId="comment-delete-confirm"
      />
    </div>
  )
}
