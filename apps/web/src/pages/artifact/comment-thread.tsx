import {
  Box,
  Braces,
  ChartNoAxesColumn,
  Clapperboard,
  Image as ImageGlyph,
  Link2,
  type LucideIcon,
  RotateCcw,
  Table2,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { Comment, Mention } from "@/api"
import { Icon } from "@/components/icons"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"
import { useActions } from "./comment-actions"
import { MentionField } from "./comment-composer"
import { CommentRow } from "./comment-row"
import { useCommentScope } from "./lib/comment-scope"
import { useCommentTree } from "./lib/comment-tree"
import { quoteChipClass } from "./quote-chip"
import { type ElementSnapshotLite, parseAnchor } from "./types"

// A small glyph standing in for an element's role on the comment card (lucide
// only — no emoji in chrome).
const ROLE_GLYPH: Record<string, LucideIcon> = {
  image: ImageGlyph,
  chart: ChartNoAxesColumn,
  media: Clapperboard,
  embed: Link2,
  table: Table2,
  code: Braces,
  figure: ImageGlyph,
  block: Box,
}

/**
 * The reference chip for an element anchor. When the element is present, it's a
 * jump button (scroll to + flash the outline). When it's gone — edited or removed
 * in this version — it falls back to the preserved SNAPSHOT (a thumbnail for
 * images, else a tag chip) so the orphaned comment still shows what it pointed at.
 */
function ElementRef({
  threadId,
  label,
  snapshot,
  present,
  relocated,
  onJump,
}: {
  threadId: string
  label: string
  snapshot?: ElementSnapshotLite
  present: boolean
  /** The element resolved, but at less than full confidence — it likely moved. */
  relocated?: boolean
  onJump: (id: string) => void
}) {
  const Glyph = ROLE_GLYPH[snapshot?.tag === "table" ? "table" : roleGuess(snapshot, label)] ?? Box
  if (present) {
    return (
      // Same quiet edge-marked grammar as the text quote (see quoteChipClass) —
      // a reference line, not a filled band; hover re-inks to say "jumpable".
      <button
        type="button"
        data-testid={`comment-jump-${threadId}`}
        onClick={(e) => {
          e.stopPropagation()
          onJump(threadId)
        }}
        title={relocated ? "Jump to the element (approximate location)" : "Jump to the element"}
        className="flex w-full items-center gap-1.5 border-l-2 border-foreground/25 py-0.5 pl-2.5 pr-2 text-left text-sm font-medium text-muted-foreground outline-none hover:border-foreground/60 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <Glyph aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
        {relocated && (
          // A minor, muted "moved" marker — a small dot + word, not an alarm.
          <Badge shape="pill" data-testid={`comment-moved-${threadId}`} className="ml-auto">
            <span aria-hidden className="size-1.5 rounded-full bg-primary/60" />
            moved
          </Badge>
        )}
      </button>
    )
  }
  // Orphaned: show the snapshot so the comment keeps its referent. The src is
  // comment-author-controlled and this card renders in the trusted host app (not the
  // sandboxed iframe), so only render an http(s) thumbnail — never data:/blob:/
  // javascript: or a protocol-relative URL — falling back to the role glyph otherwise.
  const thumb = isSafeThumb(snapshot?.src) ? snapshot?.src : undefined
  return (
    <div
      title="The element this comment was attached to was edited or removed in this version"
      data-testid={`comment-orphan-${threadId}`}
      className="flex w-full items-center gap-2 border-l-2 border-border py-0.5 pl-2.5 pr-2 text-left text-sm text-muted-foreground"
    >
      {thumb ? (
        <img
          src={thumb}
          alt=""
          className="size-9 shrink-0 rounded object-cover outline-1 -outline-offset-1 outline-foreground/10"
          onError={(e) => {
            e.currentTarget.style.display = "none"
          }}
        />
      ) : (
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded border border-border bg-card"
        >
          <Glyph className="size-4" />
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium italic text-foreground">{label}</span>
        <span className="block font-mono text-2xs">removed in this version</span>
      </span>
    </div>
  )
}

// Only a plain http(s) URL is safe to render as a thumbnail in the host app — the
// snapshot src is comment-author-controlled, so reject data:/blob:/javascript:/
// protocol-relative and anything that isn't an absolute http(s) URL.
function isSafeThumb(src: string | undefined): boolean {
  if (!src) return false
  try {
    return /^https?:$/.test(new URL(src).protocol)
  } catch {
    return false
  }
}

// Best-effort role from a snapshot tag (for the glyph) without re-deriving the role.
function roleGuess(snapshot: ElementSnapshotLite | undefined, label: string): string {
  const tag = snapshot?.tag ?? ""
  if (tag === "img" || tag === "picture") return "image"
  if (tag === "svg" || tag === "canvas") return "chart"
  if (tag === "video" || tag === "audio") return "media"
  if (tag === "iframe" || tag === "embed" || tag === "object") return "embed"
  if (tag === "table") return "table"
  if (tag === "pre" || tag === "code") return "code"
  if (tag === "figure") return "figure"
  return /chart|graph|plot/i.test(label) ? "chart" : "block"
}

// One comment thread. Compact until activated; the active card shows the full
// thread, a reply box, and resolve controls. Its interaction state (active/hovered/
// present) and handlers come from the CommentTree context — the card is the leaf, so a
// render site is just `<CommentCard thread={t} />` with no drilled props.
export function CommentCard({ thread, inLayer }: { thread: Comment[]; inLayer?: boolean }) {
  const { canComment, currentSlide, landedSlides, anchorConf, agentIds } = useCommentScope()
  const { activeThread, hoverThread, inDoc, onActivate, onHover, onResolve, onReply, onJump } =
    useCommentTree()
  const { meName } = useActions()
  const [reply, setReply] = useState("")
  const [replyMentions, setReplyMentions] = useState<Mention[]>([])
  const root = thread[0]
  const active = !!root && activeThread === root.thread_id
  const cardRef = useRef<HTMLDivElement>(null)
  // Becoming active scrolls the card into view in the general/resolved drawer
  // (an unanchored thread has no doc position to jump to). Selecting a comment
  // should always land it in view, not just flip a state you have to go hunting
  // for. Pinned cards opt OUT (`inLayer`): their zone is overflow-clip and its
  // ancestors could still be shifted by scrollIntoView, silently breaking the
  // layer transform — the pin layer's reveal() handles them instead.
  useEffect(() => {
    // Instant, not smooth: the document's own jump-to-anchor scroll is already
    // animating (fastScrollTo, anchor-client.ts) — a second, slower smooth
    // scroll running here at the same time is exactly the "dragging" feel to
    // avoid.
    if (active && !inLayer) cardRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" })
  }, [active, inLayer])
  if (!root) return null
  const hovered = hoverThread === root.thread_id
  const present = inDoc[root.thread_id]
  const sendReply = (resolved: Mention[]) => {
    if (!reply.trim()) return
    onReply(reply, root.thread_id, resolved)
    setReply("")
    setReplyMentions([])
  }
  const resolved = root.state === "resolved"
  const outdated = root.state === "outdated"
  // A "revision request" thread is a comment addressed to an agent (the moat flow). We
  // detect it from the root's mentions overlapping the known agent ids — no schema
  // change. Its lifecycle reads as a legible machine: Requested (waiting on the agent) →
  // Applied (the agent's publish resolved this thread). An `outdated` request (its
  // anchored text changed before the agent responded) falls through to the normal
  // "outdated" badge — "awaiting revision" would misread a stale request as live.
  const isAgentRequest = !!root.mentions?.some((m) => agentIds?.has(m.id))
  const requestStage: "requested" | "applied" | null =
    !isAgentRequest || outdated ? null : resolved ? "applied" : "requested"
  const parsed = parseAnchor(root.anchor)
  const isEl = !!parsed?.element
  // The reference label: a text quote, or an element's snapshot label.
  const refLabel = parsed?.exact ?? parsed?.label ?? null
  const snapshot = parsed?.element?.snapshot
  const textPresent = present !== undefined ? present : root.anchored !== false
  // An element that resolved at less than full confidence relocated — show a quiet
  // "moved" marker on its chip. High-confidence (or text) anchors show nothing.
  const elBand = isEl ? anchorConf?.[root.thread_id]?.band : undefined
  const relocated = isEl && textPresent && (elBand === "low" || elBand === "medium")
  const replies = thread.length - 1
  // Deck context (from CommentScope): the slide this comment belongs to — where its
  // text resolved (landed), else the slide it was written on — and whether the text
  // has since moved to a different slide than it was anchored on.
  const onDeck = currentSlide != null
  const recordedSlide = parsed?.slide
  const landedSlide = landedSlides?.[root.thread_id]
  const slideNum = landedSlide != null ? landedSlide : recordedSlide
  const slideMoved = recordedSlide != null && landedSlide != null && landedSlide !== recordedSlide

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-activate convenience; the card's own buttons are keyboard-accessible
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-to-activate convenience; the card's own buttons are keyboard-accessible
    <div
      ref={cardRef}
      data-testid="comment-card"
      onMouseEnter={() => onHover(root.thread_id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => !active && onActivate(root.thread_id)}
      className={cn(
        // Tight radius, the QUIETEST edge that still separates: in light the
        // soft hairline + shadow carry the lift; dark has no shadows and the
        // panel shares the card fill, so the standard hairline stays there.
        // No entrance animation: cards appear constantly (panel open, refetch,
        // scroll into the margin) and motion there reads as churn — the pin
        // layer's transform transition carries all deliberate movement.
        "overflow-hidden rounded-lg border bg-card shadow-[var(--shadow-sm)]",
        // Active/hovered cards take neutral re-inked edges — never the accent
        // (the ink accent marks actions and brand moments, not selection).
        active
          ? "cursor-default border-foreground/25 shadow-[var(--shadow)]"
          : hovered
            ? "border-foreground/15"
            : "border-border-soft dark:border-border",
        resolved && !active && "opacity-60",
      )}
    >
      {/* Agent-revision request ribbon — the moat's status machine, read at a glance:
          Requested (waiting on the agent) → Applied (the revision landed). A quiet
          ink-tinted strip so it's clearly "an agent task", distinct from a plain
          comment. */}
      {requestStage && (
        <div
          data-testid={`agent-request-${requestStage}`}
          className="flex items-center gap-1.5 border-b border-border-soft bg-secondary px-2.5 py-1.5 text-sm font-medium text-muted-foreground"
          title={
            requestStage === "requested"
              ? "Sent to an agent. Waiting for the revision."
              : "The agent's revision was published and resolved this thread"
          }
        >
          <Icon name="sparkles" size={14} className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {requestStage === "requested"
              ? "Agent request · awaiting revision"
              : root.resolution?.version != null
                ? `Revision applied in v${root.resolution.version}`
                : "Revision applied"}
          </span>
        </div>
      )}
      {onDeck && slideNum != null && (
        <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-1.5">
          <Badge shape="pill" data-testid={`comment-slide-${root.thread_id}`}>
            Slide {slideNum + 1}
          </Badge>
          {slideMoved && (
            <Badge
              shape="pill"
              data-testid={`comment-moved-${root.thread_id}`}
              title="The text this comment anchors to moved to a different slide since it was written"
            >
              moved
            </Badge>
          )}
        </div>
      )}
      {/* The card's title bar: the anchored reference (inset — a full-bleed band
          here made every card lead with a gray slab) and, when the thread is
          open, its ONE state action: the resolve check, quiet at rest, success
          on hover. The footer below stays purely about replying. */}
      {(refLabel || active) && (
        <div className="flex items-center gap-1.5 px-3 pt-2.5">
          <div className="min-w-0 flex-1">
            {refLabel &&
              (isEl ? (
                <ElementRef
                  threadId={root.thread_id}
                  label={refLabel}
                  snapshot={snapshot}
                  present={textPresent}
                  relocated={relocated}
                  onJump={onJump}
                />
              ) : textPresent ? (
                // Jumpable whenever the text still exists — RESOLVED included
                // (its anchor rides to the frame as a quiet, unpainted one):
                // settled feedback still has a place in the document, muted at
                // rest, re-inking on hover.
                <button
                  type="button"
                  data-testid={`comment-jump-${root.thread_id}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onJump(root.thread_id)
                  }}
                  title={
                    resolved ? "Jump to the text this was about" : "Jump to the highlighted text"
                  }
                  className={quoteChipClass({
                    muted: resolved,
                    className:
                      "block w-full truncate outline-none hover:border-foreground/60 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  })}
                >
                  “{refLabel}”
                </button>
              ) : (
                <div
                  title="The text this comment was attached to was edited or removed in this version"
                  className={quoteChipClass({ muted: true, className: "block w-full truncate" })}
                >
                  “{refLabel}”
                </div>
              ))}
          </div>
          {active && (
            // Labeled, not icon-only: at launch, "Resolve" has to teach itself.
            // Still quiet in the title bar (ghost, muted → success on hover) —
            // the verb carries the meaning, no tooltip needed.
            <Button
              variant="ghost"
              size="xs"
              data-testid="comment-resolve"
              onClick={(e) => {
                e.stopPropagation()
                onResolve(root)
              }}
              className={cn(
                "-my-1 -mr-1.5 shrink-0 text-muted-foreground",
                resolved ? "hover:text-foreground" : "hover:bg-success/10 hover:text-success",
              )}
            >
              {resolved ? (
                <RotateCcw aria-hidden className="size-3.5" />
              ) : (
                <Icon name="check" className="size-3.5" />
              )}
              {resolved ? "Reopen" : "Resolve"}
            </Button>
          )}
        </div>
      )}

      {/* Status, only when it's NOT the default: "open" was a pill on every
          active card, labeling the ordinary state. An agent request shows its
          state in the ribbon above, so the plain badge is suppressed there too. */}
      {active &&
        (() => {
          const changed = refLabel && !textPresent && !resolved && !outdated
          const statused = !requestStage && (resolved || outdated)
          if (!changed && !statused) return null
          return (
            <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
              {statused && (
                <Badge
                  shape="pill"
                  variant={resolved ? "success" : outdated ? "warning" : "default"}
                  title={
                    outdated
                      ? "The text for this thread changed in a later version. This feedback may no longer apply."
                      : undefined
                  }
                >
                  {resolved ? "resolved" : "outdated"}
                </Badge>
              )}
              {changed && (
                <Badge
                  shape="pill"
                  variant="warning"
                  title={
                    isEl
                      ? "The element this comment was attached to was edited or removed in this version"
                      : "The text this comment was attached to was edited or removed in this version"
                  }
                >
                  {isEl ? "element changed" : "text changed"}
                </Badge>
              )}
            </div>
          )
        })()}

      {!active ? (
        <>
          <CommentRow c={root} compact />
          {replies > 0 ? (
            // In the text column, like everything else in the thread.
            <div className="px-3 pb-2 pt-0.5 font-mono text-2xs font-medium tabular-nums text-muted-foreground">
              <span className="block pl-7">
                {replies} repl{replies === 1 ? "y" : "ies"}
              </span>
            </div>
          ) : (
            <div aria-hidden className="pb-1.5" />
          )}
        </>
      ) : (
        <>
          {/* No dividers between rows: consecutive same-author messages drop
              their header entirely, so a run reads as one voice — the thread is
              conversation, not stacked row-cards. */}
          <div className="max-h-90 overflow-auto pb-1.5">
            {thread.map((c, i) => (
              <CommentRow key={c.id} c={c} grouped={i > 0 && thread[i - 1]?.author === c.author} />
            ))}
          </div>
          {/* The reply line: BARE — the card is the container, so the field draws
              no box of its own (a bordered well under a divider inside a bordered
              card stacked three edges in twenty pixels). It sits in the text
              column like every other line; the ↑ send appears with the first
              character, and Enter sends too. */}
          {canComment && (
            // YOUR avatar leads the reply line — the row grammar completes
            // (every line in the thread is avatar + text, and this one is you),
            // and the empty gutter earns its keep. The field's text lands on
            // the same column as the messages above.
            // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper, not an interactive control
            // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper, not an interactive control
            <div className="flex gap-2 px-3 pb-1.5" onClick={(e) => e.stopPropagation()}>
              <Avatar className="mt-1 size-5 shrink-0">
                <AvatarFallback className="text-2xs">{getInitials(meName)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <MentionField
                  multiline
                  bare
                  testId="comment-reply-input"
                  sendTestId="comment-reply-send"
                  className="field-sizing-content max-h-32 min-h-8 resize-none px-1.5"
                  value={reply}
                  onChange={setReply}
                  mentions={replyMentions}
                  onMentions={setReplyMentions}
                  onSubmit={sendReply}
                  placeholder="Reply…"
                  autoFocus
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
