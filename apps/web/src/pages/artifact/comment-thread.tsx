import {
  Box,
  Braces,
  ChartNoAxesColumn,
  ChevronRight,
  Clapperboard,
  Image as ImageGlyph,
  Link2,
  type LucideIcon,
  Table2,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Comment, Mention } from "@/api"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Composer, MentionField } from "./comment-composer"
import { CommentRow } from "./comment-row"
import { useCommentScope } from "./lib/comment-scope"
import { COMPOSER_ID, layoutPins, parseAnchor } from "./lib/layout"
import { quoteChipClass } from "./quote-chip"
import { type ComposerState, type ElementSnapshotLite, type PinItem, selLabel } from "./types"

export function PinnedZone({
  pins,
  scrollY,
  onScrollDoc,
  composer,
  activeThread,
  hoverThread,
  inDoc,
  onActivate,
  onHover,
  onResolve,
  onReply,
  onJump,
  onSubmitNew,
  onCancelNew,
  personal,
  topInset = 0,
}: {
  pins: PinItem[]
  scrollY: number
  /** Vertical gap between the pinned zone's top and the document's top (the panel
   *  header sitting above it). Cards are anchored from the document top, so this is
   *  subtracted to keep them lined up with their highlights. */
  topInset?: number
  onScrollDoc: (dy: number) => void
  composer: ComposerState
  personal?: boolean
  activeThread: string | null
  hoverThread: string | null
  inDoc: Record<string, boolean>
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string, mentions?: Mention[]) => void
  onJump: (id: string) => void
  onSubmitNew: (text: string, mentions?: Mention[]) => void
  onCancelNew: () => void
}) {
  const [heights, setHeights] = useState<Record<string, number>>({})
  const obs = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    obs.current = new ResizeObserver((entries) => {
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
    return () => obs.current?.disconnect()
  }, [])
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (el) obs.current?.observe(el)
  }, [])

  // A composer for a new anchored comment joins the same layout as a pinned
  // item that owns priority, so neighbouring cards flow around it instead of
  // colliding with it.
  // Narrow once so the render below needs no non-null assertions: this is set
  // exactly when there's an anchored composer with a resolved position.
  const activeComposer =
    composer?.anchor && composer.top != null
      ? { top: composer.top, quote: selLabel(composer.anchor) }
      : null
  // The pinned zone sits `topInset` px below the document's top (the panel header
  // above it), so a card at desiredY (measured from the document top) must render
  // that much higher to line up with its highlight. Clamp at 0 so cards anchored
  // near the very top bunch just under the header rather than scroll out of reach.
  const align = (y: number) => Math.max(0, y - topInset)
  const items = pins.flatMap((p) => {
    const head = p.thread[0]
    return head ? [{ id: head.thread_id, desiredY: align(p.desiredY) }] : []
  })
  if (activeComposer) items.push({ id: COMPOSER_ID, desiredY: align(activeComposer.top) })
  const activeId = activeComposer ? COMPOSER_ID : activeThread
  const pos = layoutPins(items, heights, activeId, 12)
  // Tallest card bottom in the relaxed stack. When a dense cluster pushes this
  // past the panel height, the panel scrolls to reveal the buried cards (the
  // document alone can't surface them — they all anchor to the same spot).
  const maxBottom = items.reduce(
    (m, it) => Math.max(m, (pos[it.id] ?? it.desiredY) + (heights[it.id] ?? 116)),
    0,
  )

  const zoneRef = useRef<HTMLDivElement>(null)
  // Wheel over the panel scrolls the document (so cards glide with their text),
  // but the panel consumes the gesture FIRST when it has its own overflow to show
  // — native scroll-chaining, except the document is a cross-origin iframe so the
  // hand-off is explicit. preventDefault needs a non-passive listener.
  useEffect(() => {
    const el = zoneRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const down = e.deltaY > 0
      const canConsume = down
        ? el.scrollTop + el.clientHeight < el.scrollHeight - 1
        : el.scrollTop > 0
      if (canConsume) return // let the panel scroll natively to the buried cards
      e.preventDefault()
      onScrollDoc(e.deltaY)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [onScrollDoc])
  // A document scroll re-pins every card to a fresh viewport position, so the
  // panel's own overflow scroll is no longer meaningful — snap it back to the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin only tracks scrollY changes.
  useEffect(() => {
    if (zoneRef.current) zoneRef.current.scrollTop = 0
  }, [scrollY])

  return (
    <div ref={zoneRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden">
      {/* Spacer gives the absolutely-placed cards a scrollable height. */}
      <div aria-hidden="true" style={{ height: maxBottom }} />
      {pins.map((p) => {
        const head = p.thread[0]
        if (!head) return null
        const id = head.thread_id
        const active = !activeComposer && activeThread === id
        const y = pos[id] ?? align(p.desiredY)
        return (
          <div
            key={id}
            ref={measure}
            data-pin={id}
            className="absolute inset-x-2.5 top-0 transition-transform duration-200"
            style={{
              transform: `translateY(${Math.round(y)}px)`,
              zIndex: active ? 6 : hoverThread === id ? 4 : 2,
              opacity: p.located ? 1 : 0,
            }}
          >
            <CommentCard
              thread={p.thread}
              active={active}
              hovered={hoverThread === id}
              present={inDoc[id]}
              onActivate={onActivate}
              onHover={onHover}
              onResolve={onResolve}
              onReply={onReply}
              onJump={onJump}
            />
          </div>
        )
      })}
      {activeComposer && (
        <div
          ref={measure}
          data-pin={COMPOSER_ID}
          className="absolute inset-x-2.5 top-0 z-10 transition-transform duration-200"
          style={{
            transform: `translateY(${Math.round(pos[COMPOSER_ID] ?? align(activeComposer.top))}px)`,
          }}
        >
          <Composer
            quote={activeComposer.quote}
            onSubmit={onSubmitNew}
            onCancel={onCancelNew}
            personal={personal}
          />
        </div>
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
      <button
        type="button"
        data-testid={`comment-jump-${threadId}`}
        onClick={(e) => {
          e.stopPropagation()
          onJump(threadId)
        }}
        title={relocated ? "Jump to the element (moved — approximate)" : "Jump to the element"}
        className="flex w-full items-center gap-1.5 border-l-[3px] border-foreground/25 bg-accent px-2.5 py-1.5 text-left text-sm font-medium text-foreground outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <Glyph aria-hidden className="size-4 shrink-0 text-muted-foreground" />
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
      className="flex w-full items-center gap-2 border-l-[3px] border-border bg-secondary px-2.5 py-1.5 text-left text-sm text-muted-foreground"
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
// thread, a reply box, and resolve controls.
export function CommentCard({
  thread,
  active,
  hovered,
  present,
  onActivate,
  onHover,
  onResolve,
  onReply,
  onJump,
}: {
  thread: Comment[]
  active: boolean
  hovered: boolean
  present?: boolean
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string, mentions?: Mention[]) => void
  onJump: (id: string) => void
}) {
  const { canComment, currentSlide, landedSlides, anchorConf } = useCommentScope()
  const [reply, setReply] = useState("")
  const [replyMentions, setReplyMentions] = useState<Mention[]>([])
  const root = thread[0]
  if (!root) return null
  const sendReply = (resolved: Mention[]) => {
    if (!reply.trim()) return
    onReply(reply, root.thread_id, resolved)
    setReply("")
    setReplyMentions([])
  }
  const resolved = root.state === "resolved"
  const outdated = root.state === "outdated"
  const addressed = root.state === "addressed"
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
      data-testid="comment-card"
      onMouseEnter={() => onHover(root.thread_id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => !active && onActivate(root.thread_id)}
      className={cn(
        "animate-in fade-in slide-in-from-bottom-1 duration-200 overflow-hidden rounded-lg border bg-card",
        // Active/hovered cards take neutral re-inked edges — never the accent
        // (the ink accent marks actions and brand moments, not selection).
        active
          ? "cursor-default border-foreground/25 shadow-[var(--shadow)]"
          : hovered
            ? " border-foreground/15 shadow-[var(--shadow-sm)]"
            : " border-border",
        resolved && !active && "opacity-60",
      )}
    >
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
      {isEl
        ? refLabel && (
            <ElementRef
              threadId={root.thread_id}
              label={refLabel}
              snapshot={snapshot}
              present={textPresent && !resolved}
              relocated={relocated}
              onJump={onJump}
            />
          )
        : refLabel &&
          (textPresent && !resolved ? (
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
                  "block w-full truncate outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
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

      {!active ? (
        <>
          <CommentRow c={root} compact />
          {replies > 0 && (
            <div className="px-3 pb-2.5 font-mono text-2xs font-medium tabular-nums text-muted-foreground">
              {replies} repl{replies === 1 ? "y" : "ies"}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="max-h-90 overflow-auto">
            {thread.map((c) => (
              <CommentRow key={c.id} c={c} />
            ))}
          </div>
          {canComment && (
            <div className="flex gap-1.5 border-t border-border-soft px-3 py-2">
              {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper, not an interactive control */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper, not an interactive control */}
              <div className="flex-1" onClick={(e) => e.stopPropagation()}>
                <MentionField
                  testId="comment-reply-input"
                  value={reply}
                  onChange={setReply}
                  mentions={replyMentions}
                  onMentions={setReplyMentions}
                  onSubmit={sendReply}
                  placeholder="Reply… (@ to mention)"
                  autoFocus
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!reply.trim()}
                data-testid="comment-reply-send"
                onClick={(e) => {
                  e.stopPropagation()
                  sendReply(replyMentions.filter((m) => reply.includes(`@${m.name}`)))
                }}
              >
                Reply
              </Button>
            </div>
          )}
          <div className="flex items-center gap-1.5 bg-secondary px-3 py-1.5">
            {/* Status tones are success/warning/neutral — the ink accent is reserved, so
                addressed and open both take the neutral wash; the label text and
                title tooltip carry the distinction. */}
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
              {resolved ? "resolved" : outdated ? "outdated" : addressed ? "addressed" : "open"}
            </Badge>
            {refLabel && !textPresent && !resolved && !outdated && !addressed && (
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
            {/* Resolve is a success affordance (the soft status fill, never a
                filled ink); Reopen goes back to a quiet outline. */}
            <Button
              variant={resolved ? "outline" : "success"}
              size="sm"
              className="ml-auto"
              data-testid="comment-resolve"
              onClick={(e) => {
                e.stopPropagation()
                onResolve(root)
              }}
            >
              {resolved ? "Reopen" : "Resolve"}
            </Button>
          </div>
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
  activeThread,
  hoverThread,
  onActivate,
  onHover,
  onResolve,
  onReply,
  onJump,
}: {
  label: string
  defaultOpen: boolean
  testId: string
  className?: string
  threads: Comment[][]
  activeThread: string | null
  hoverThread: string | null
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string, mentions?: Mention[]) => void
  onJump: (id: string) => void
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
              <CommentCard
                thread={t}
                active={activeThread === head.thread_id}
                hovered={hoverThread === head.thread_id}
                onActivate={onActivate}
                onHover={onHover}
                onResolve={onResolve}
                onReply={onReply}
                onJump={onJump}
              />
            </div>
          )
        })}
    </div>
  )
}
