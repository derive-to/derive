import {
  Box,
  Braces,
  ChartNoAxesColumn,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clapperboard,
  Image as ImageGlyph,
  Link2,
  type LucideIcon,
  RotateCcw,
  Table2,
} from "lucide-react"
import { type RefObject, useCallback, useEffect, useRef, useState } from "react"
import type { Comment, Mention } from "@/api"
import { Icon } from "@/components/icons"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useActions } from "./comment-actions"
import { Composer, MentionField } from "./comment-composer"
import { CommentRow } from "./comment-row"
import { FloatingControl } from "./floating-control"
import { useCommentScope } from "./lib/comment-scope"
import { useCommentTree } from "./lib/comment-tree"
import { COMPOSER_ID, layoutPins } from "./lib/layout"
import { quoteChipClass } from "./quote-chip"
import {
  type ComposerState,
  type ElementSnapshotLite,
  type FrameGeom,
  type PinItem,
  parseAnchor,
  selLabel,
} from "./types"
import { usePinLayer } from "./use-pin-layer"

export function PinnedZone({
  pins,
  frameRef,
  subscribeGeom,
  onScrollDoc,
  composer,
  onSubmitNew,
  onCancelNew,
}: {
  pins: PinItem[]
  /** The rendered document's iframe — the datum (zone top vs iframe top) is
   *  MEASURED from it, so the review card / bundle bar / past-version banner can't
   *  silently misalign the pins the way the old assumed header-only inset did. */
  frameRef: RefObject<HTMLIFrameElement | null>
  subscribeGeom: (cb: (g: FrameGeom) => void) => () => void
  onScrollDoc: (dy: number) => void
  composer: ComposerState
  onSubmitNew: (text: string, mentions?: Mention[]) => void
  onCancelNew: () => void
}) {
  // The active/hover state drives this zone's layout math (which card is pinned to its
  // exact Y, z-order, opacity); it comes from the tree context, same as the cards read.
  // onJump powers the offscreen-pin pills ("N more ↓" → scroll the doc to the nearest).
  const { activeThread, hoverThread, onJump } = useCommentTree()
  const [heights, setHeights] = useState<Record<string, number>>({})
  // Created lazily in the ref callback (refs run during commit, BEFORE effects —
  // an effect-created observer would miss any card mounting in the zone's own
  // first commit). Disconnected on unmount.
  const obs = useRef<ResizeObserver | null>(null)
  useEffect(() => () => obs.current?.disconnect(), [])
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    obs.current ??= new ResizeObserver((entries) => {
      setHeights((h) => {
        let changed = false
        const next = { ...h }
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.pin
          if (!id) continue
          const hh = Math.round((e.target as HTMLElement).offsetHeight)
          if (next[id] !== hh) {
            next[id] = hh
            changed = true
          }
        }
        return changed ? next : h
      })
    })
    obs.current.observe(el)
    return () => {
      obs.current?.unobserve(el)
      // Drop the unmounted pin's height so the layout snapshot never grows stale ids.
      const id = el.dataset.pin
      if (id)
        setHeights((h) => {
          if (!(id in h)) return h
          const { [id]: _gone, ...rest } = h
          return rest
        })
    }
  }, [])

  // A composer for a new anchored comment joins the same layout as a pinned
  // item that owns priority, so neighbouring cards flow around it instead of
  // colliding with it.
  // Narrow once so the render below needs no non-null assertions: this is set
  // exactly when there's an anchored composer with a resolved position.
  const activeComposer =
    composer?.anchor && composer.docTop != null
      ? { docTop: composer.docTop, quote: selLabel(composer.anchor), agent: composer.agent }
      : null
  // Everything here is DOC-ABSOLUTE. The pin layer translates the whole stack by
  // `datum − scrollY − offset` imperatively (see use-pin-layer), so a scroll never
  // re-renders these cards — their translateY changes only when the layout itself
  // does, which is exactly when the 200ms transition should fire.
  const items = pins.flatMap((p) => {
    const head = p.thread[0]
    return head ? [{ id: head.thread_id, desiredY: p.desiredY }] : []
  })
  if (activeComposer) items.push({ id: COMPOSER_ID, desiredY: activeComposer.docTop })
  const activeId = activeComposer ? COMPOSER_ID : activeThread
  const pos = layoutPins(items, heights, activeId, 12)
  const maxBottom = items.reduce(
    (m, it) => Math.max(m, (pos[it.id] ?? it.desiredY) + (heights[it.id] ?? 116)),
    0,
  )
  const minY = items.reduce((m, it) => Math.min(m, pos[it.id] ?? it.desiredY), 0)
  const activeY = activeId != null ? (pos[activeId] ?? null) : null
  const located: Record<string, boolean> = { [COMPOSER_ID]: true }
  for (const p of pins) {
    const head = p.thread[0]
    if (head) located[head.thread_id] = p.located
  }

  const { zoneRef, layerRef, reveal, offscreen } = usePinLayer({
    frameRef,
    subscribeGeom,
    onScrollDoc,
    layout: { pos, heights, located, minY, maxBottom, activeY },
  })

  // Reveal the item the user just committed to. The composer reveals ONCE, at
  // open: its selection is on-screen by definition (no jump accompanies it), and
  // a delayed re-reveal would fight a user who scrolls right after opening it.
  // Activation reveals now AND once more after the jump-to-anchor scroll settles
  // (fastScrollTo runs 220ms) — a reveal computed mid-glide lands on stale
  // geometry. Either way it's a one-shot nudge, not a lock: the next doc scroll
  // unwinds any reveal offset (see use-pin-layer's clamp).
  const composerOpen = !!activeComposer
  useEffect(() => {
    if (composerOpen) reveal(COMPOSER_ID)
  }, [composerOpen, reveal])
  useEffect(() => {
    if (!activeThread) return
    reveal(activeThread)
    const t = setTimeout(() => reveal(activeThread), 350)
    return () => clearTimeout(t)
  }, [activeThread, reveal])

  return (
    // overflow-clip, not hidden: a clip box is not a scroll container, so focus
    // scrolling / scrollIntoView can't silently shift it out from under the layer
    // transform. use-pin-layer's reveal() is the sanctioned way in.
    <div ref={zoneRef} className="absolute inset-0 overflow-clip">
      <div ref={layerRef} className="absolute inset-x-2.5 top-0 will-change-transform">
        {pins.map((p) => {
          const head = p.thread[0]
          if (!head) return null
          const id = head.thread_id
          const active = !activeComposer && activeThread === id
          const y = pos[id] ?? p.desiredY
          return (
            <div
              key={id}
              ref={measure}
              data-pin={id}
              className="absolute inset-x-0 top-0 transition-transform duration-200"
              style={{
                transform: `translateY(${Math.round(y)}px)`,
                zIndex: active ? 6 : hoverThread === id ? 4 : 2,
                opacity: p.located ? 1 : 0,
              }}
            >
              <CommentCard thread={p.thread} inLayer />
            </div>
          )
        })}
        {activeComposer && (
          <div
            ref={measure}
            data-pin={COMPOSER_ID}
            className="absolute inset-x-0 top-0 z-10 transition-transform duration-200"
            style={{
              transform: `translateY(${Math.round(pos[COMPOSER_ID] ?? activeComposer.docTop)}px)`,
            }}
          >
            <Composer
              quote={activeComposer.quote}
              agent={activeComposer.agent}
              onSubmit={onSubmitNew}
              onCancel={onCancelNew}
            />
          </div>
        )}
      </div>
      {/* Comments outside the panel's view announce themselves at the edge they're
          past (Miro/Figma edge-indicator grammar — the cursor layer's offscreen
          peers work the same way). One click jumps the document to the nearest. */}
      {offscreen.above && (
        <FloatingControl
          size="sm"
          data-testid="pins-above-jump"
          title="Jump to the nearest comment above"
          onClick={() => offscreen.above && onJump(offscreen.above.id)}
          className="absolute left-1/2 top-2 z-20 -translate-x-1/2 tabular-nums"
        >
          <ChevronUp aria-hidden className="size-3.5" />
          {offscreen.above.count} more
        </FloatingControl>
      )}
      {offscreen.below && (
        <FloatingControl
          size="sm"
          data-testid="pins-below-jump"
          title="Jump to the nearest comment below"
          onClick={() => offscreen.below && onJump(offscreen.below.id)}
          className="absolute bottom-2 left-1/2 z-20 -translate-x-1/2 tabular-nums"
        >
          <ChevronDown aria-hidden className="size-3.5" />
          {offscreen.below.count} more
        </FloatingControl>
      )}
    </div>
  )
}

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
        title={relocated ? "Jump to the element (moved — approximate)" : "Jump to the element"}
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
  const { openReview } = useActions()
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
  const addressed = root.state === "addressed"
  // A "revision request" thread is a comment addressed to an agent (the moat flow). We
  // detect it from the root's mentions overlapping the known agent ids — no schema
  // change. Its lifecycle reads as a legible machine: Requested → Revision ready ·
  // Review (agent proposed → addressed) → Applied (approved → resolved). An `outdated`
  // request (its anchored text changed before the agent responded) falls through to the
  // normal "outdated" badge — "awaiting revision" would misread a stale request as live.
  const isAgentRequest = !!root.mentions?.some((m) => agentIds?.has(m.id))
  const requestStage: "requested" | "ready" | "applied" | null =
    !isAgentRequest || outdated ? null : resolved ? "applied" : addressed ? "ready" : "requested"
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
        // The house card register (rounded-xl, hairline, soft lift). No entrance
        // animation: cards appear constantly (panel open, refetch, scroll into
        // the margin) and motion there reads as churn, not delight — the pin
        // layer's transform transition already carries all deliberate movement.
        "overflow-hidden rounded-xl border bg-card shadow-[var(--shadow-sm)]",
        // Active/hovered cards take neutral re-inked edges — never the accent
        // (the ink accent marks actions and brand moments, not selection). Active
        // reads by the expanded thread + a re-inked edge + one shadow step, not
        // the popover-weight pop.
        active
          ? "cursor-default border-foreground/30 shadow-[var(--shadow)]"
          : hovered
            ? "border-foreground/15"
            : "border-border",
        resolved && !active && "opacity-60",
      )}
    >
      {/* Agent-revision request ribbon — the moat's status machine, read at a glance:
          Requested (waiting on the agent) → Revision ready (a proposal is in review) →
          Applied (approved). A quiet ink-tinted strip so it's clearly "an agent task",
          distinct from a plain comment. */}
      {requestStage && (
        <div
          data-testid={`agent-request-${requestStage}`}
          className={cn(
            "flex items-center gap-1.5 border-b px-2.5 py-1.5 text-sm font-medium",
            requestStage === "ready"
              ? "border-primary/25 bg-primary/10 text-foreground"
              : "border-border-soft bg-secondary text-muted-foreground",
          )}
          title={
            requestStage === "requested"
              ? "Sent to an agent — waiting for it to revise and propose a change"
              : requestStage === "ready"
                ? "The agent proposed a revision — open Review to see it and approve"
                : "The agent's revision was approved and applied"
          }
        >
          <Icon
            name="sparkles"
            size={14}
            className={requestStage === "ready" ? "text-primary" : "text-muted-foreground"}
          />
          <span className="min-w-0 flex-1 truncate">
            {requestStage === "requested"
              ? "Agent request · awaiting revision"
              : requestStage === "ready"
                ? "Revision ready"
                : "Revision applied"}
          </span>
          {/* Ready → the one click from "the agent proposed" to the review overlay that
              lets you approve it, closing the loop without hunting through the ⋯ menu. */}
          {requestStage === "ready" && canComment && (
            <Button
              variant="default"
              size="xs"
              data-testid="agent-request-review"
              onClick={(e) => {
                e.stopPropagation()
                openReview()
              }}
            >
              Review
            </Button>
          )}
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
                  present={textPresent && !resolved}
                  relocated={relocated}
                  onJump={onJump}
                />
              ) : textPresent && !resolved ? (
                <button
                  type="button"
                  data-testid={`comment-jump-${root.thread_id}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onJump(root.thread_id)
                  }}
                  title="Jump to the highlighted text"
                  className={quoteChipClass({
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={resolved ? "Reopen" : "Resolve"}
                  data-testid="comment-resolve"
                  onClick={(e) => {
                    e.stopPropagation()
                    onResolve(root)
                  }}
                  className={cn(
                    "-mr-1 -mt-0.5 shrink-0 text-muted-foreground",
                    resolved ? "hover:text-foreground" : "hover:bg-success/10 hover:text-success",
                  )}
                >
                  {resolved ? (
                    <RotateCcw aria-hidden className="size-4" />
                  ) : (
                    <Icon name="check" className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{resolved ? "Reopen" : "Resolve"}</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}

      {/* Status, only when it's NOT the default: "open" was a pill on every
          active card, labeling the ordinary state. An agent request shows its
          state in the ribbon above, so the plain badge is suppressed there too. */}
      {active &&
        (() => {
          const changed = refLabel && !textPresent && !resolved && !outdated && !addressed
          const statused = !requestStage && (resolved || outdated || addressed)
          if (!changed && !statused) return null
          return (
            <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
              {statused && (
                <Badge
                  shape="pill"
                  variant={resolved ? "success" : outdated ? "warning" : "default"}
                  title={
                    outdated
                      ? "The text this thread was attached to changed in a later version — this feedback may no longer apply"
                      : addressed
                        ? "A proposed revision addressing this thread is pending review"
                        : undefined
                  }
                >
                  {resolved ? "resolved" : outdated ? "outdated" : "addressed"}
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
          {/* The reply well carries its own send (↑, in-field) — nothing floats
              outside it to strand when the box grows. Enter sends too. */}
          {canComment && (
            // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper, not an interactive control
            // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper, not an interactive control
            <div className="border-t border-border-soft p-2" onClick={(e) => e.stopPropagation()}>
              <MentionField
                multiline
                testId="comment-reply-input"
                sendTestId="comment-reply-send"
                className="field-sizing-content min-h-8 max-h-32"
                value={reply}
                onChange={setReply}
                mentions={replyMentions}
                onMentions={setReplyMentions}
                onSubmit={sendReply}
                placeholder="Reply…"
                autoFocus
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// A collapsible group of comment cards (Resolved / General). `defaultOpen` sets the
// initial fold — resolved threads start collapsed (out of the way), general ones open.
export function CollapsibleThreadSection({
  label,
  defaultOpen,
  testId,
  className,
  threads,
}: {
  label: string
  defaultOpen: boolean
  testId: string
  className?: string
  threads: Comment[][]
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid={testId}
        className="flex w-full items-center gap-1.5 rounded-sm px-0.5 py-1.5 text-muted-foreground outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <Eyebrow as="span" className="tabular-nums">
          {label} ({threads.length})
        </Eyebrow>
      </button>
      {open &&
        threads.map((t) => {
          const head = t[0]
          if (!head) return null
          return (
            <div key={head.thread_id} className="mb-2.5">
              <CommentCard thread={t} />
            </div>
          )
        })}
    </div>
  )
}
