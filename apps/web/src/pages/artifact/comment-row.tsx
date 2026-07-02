import { useLayoutEffect, useRef, useState } from "react"
import type { Comment } from "@/api"
import { Icon } from "@/components/icons"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { getInitials } from "@/lib/initials"
import { ago } from "@/lib/time"
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
          "cmt-body text-sm leading-relaxed [word-break:break-word]",
          compact && "line-clamp-2",
          clamped &&
            "max-h-[168px] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_120px,transparent)]",
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: input is escaped first in mdToHtml.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {!compact && overflows && (
        <button
          type="button"
          data-testid="comment-toggle-length"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          className="mt-1 rounded-sm text-xs font-medium text-primary outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  )
}

// Stack a set of cards by desired Y without overlap. The active card is pinned
// to its exact anchor and its neighbours are pushed up/down to make room.
export function CommentRow({ c, compact }: { c: Comment; compact?: boolean }) {
  const A = useActions()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(c.body_md)
  const [open, setOpen] = useState<null | "react" | "menu">(null)
  const mine = !!A.meName && c.author === A.meName
  const reactions = c.reactions ?? {}

  if (c.deleted)
    return (
      <div className={cn("px-3 py-2.5", !compact && "border-b border-border-soft")}>
        <span className="text-sm italic text-muted-foreground">Comment deleted</span>
      </div>
    )

  return (
    <div
      data-testid="comment-row"
      // An optimistic (not-yet-saved) comment carries a `temp-` id; dim it slightly
      // until the server row swaps in, so "sending" vs "sent" reads at a glance.
      className={cn(
        "group relative px-3 py-2.5",
        !compact && "border-b border-border-soft",
        c.id.startsWith("temp-") && "opacity-60",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <Avatar className="size-5">
          <AvatarFallback className="text-2xs">{getInitials(c.author)}</AvatarFallback>
        </Avatar>
        <span className="text-xs font-medium text-foreground">{c.author}</span>
        <span className="ml-auto font-mono text-2xs text-muted-foreground">
          {ago(c.created_at)}
          {c.edited ? " · edited" : ""}
        </span>
      </div>

      {editing ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper, not an interactive control
        // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper, not an interactive control
        <div onClick={(e) => e.stopPropagation()}>
          <Textarea
            value={draft}
            autoFocus
            data-testid="comment-edit-input"
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[52px] resize-y text-sm"
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
        <CommentBody html={mdToHtml(c.body_md, c.mentions)} compact={compact} />
      )}

      {Object.keys(reactions).length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {Object.entries(reactions).map(([emoji, who]) => (
            <button
              key={emoji}
              type="button"
              data-testid={`reaction-pill-${emoji}`}
              // title shows on mouse hover; aria-label carries the same reactor list to
              // keyboard + touch (where title never appears), and aria-pressed exposes
              // the toggle state.
              title={who.join(", ")}
              aria-label={`${emoji}, ${who.length}: ${who.join(", ")}`}
              aria-pressed={who.includes(A.meName)}
              onClick={(e) => {
                e.stopPropagation()
                A.react(c.id, emoji)
              }}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                // Reacted = the sanctioned soft brand chip; unreacted stays neutral
                // (hover brightens the hairline, never an amber tint).
                who.includes(A.meName)
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:border-foreground/25",
              )}
            >
              <span>{emoji}</span>
              <span className="font-mono text-2xs tabular-nums">{who.length}</span>
            </button>
          ))}
        </div>
      )}

      {!editing && (
        // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper around the action toolbar, not a control
        // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper around the action toolbar, not a control
        <div
          className={cn(
            "absolute right-2 top-1.5 z-[6] flex gap-px rounded-lg bg-popover p-0.5 shadow-[var(--shadow)] ring-1 ring-foreground/10 transition-opacity",
            open
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Popover open={open === "react"} onOpenChange={(o) => setOpen(o ? "react" : null)}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                title="React"
                aria-label="Add reaction"
                data-testid="comment-react"
              >
                <Icon name="react" size={16} />
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
                    className="grid size-[30px] place-items-center rounded-md text-lg outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    {em}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Popover open={open === "menu"} onOpenChange={(o) => setOpen(o ? "menu" : null)}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                title="More"
                aria-label="Comment actions"
                data-testid="comment-more"
              >
                <Icon name="more" size={16} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto min-w-[132px] gap-0 p-1">
              {mine && (
                <button
                  type="button"
                  data-testid="comment-edit"
                  onClick={() => {
                    setEditing(true)
                    setOpen(null)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:bg-accent"
                >
                  <Icon name="pencil" size={16} /> Edit
                </button>
              )}
              <button
                type="button"
                data-testid="comment-copy-link"
                onClick={() => {
                  A.copyLink(c.thread_id)
                  setOpen(null)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <Icon name="link" size={16} /> Copy link
              </button>
              {mine && (
                <button
                  type="button"
                  data-testid="comment-delete"
                  onClick={() => {
                    A.remove(c.id)
                    setOpen(null)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm font-medium text-destructive outline-none hover:bg-destructive/10 focus-visible:bg-destructive/10"
                >
                  <Icon name="delete" size={16} /> Delete
                </button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  )
}
