import { useCallback, useEffect, useRef, useState } from "react"
import type { Comment, Mention } from "@/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Composer, MentionField } from "./comment-composer"
import { CommentRow } from "./comment-row"
import { anchorExact, COMPOSER_ID, layoutPins } from "./lib/layout"
import type { PinItem, Sel } from "./types"

// Composer is consumed by comment-panels via this module; re-export so its import
// path doesn't have to change now that the composer lives in its own file.
export { Composer }

export function PinnedZone({
  pins,
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
}: {
  pins: PinItem[]
  composer: { anchor: Sel | null; top: number | null } | null
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
      ? { top: composer.top, quote: composer.anchor.exact ?? null }
      : null
  const items = pins.flatMap((p) => {
    const head = p.thread[0]
    return head ? [{ id: head.thread_id, desiredY: p.desiredY }] : []
  })
  if (activeComposer) items.push({ id: COMPOSER_ID, desiredY: activeComposer.top })
  const activeId = activeComposer ? COMPOSER_ID : activeThread
  const pos = layoutPins(items, heights, activeId, 12)

  return (
    <div className="absolute inset-0 overflow-hidden">
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
            className="absolute inset-x-2.5 top-0 transition-transform duration-[180ms]"
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
          className="absolute inset-x-2.5 top-0 z-10 transition-transform duration-[180ms]"
          style={{
            transform: `translateY(${Math.round(pos[COMPOSER_ID] ?? activeComposer.top)}px)`,
          }}
        >
          <Composer quote={activeComposer.quote} onSubmit={onSubmitNew} onCancel={onCancelNew} />
        </div>
      )}
    </div>
  )
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
  const quote = anchorExact(root.anchor)
  const textPresent = present !== undefined ? present : root.anchored !== false
  const replies = thread.length - 1

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-activate convenience; the card's own buttons are keyboard-accessible
    // biome-ignore lint/a11y/useKeyWithClickEvents: click-to-activate convenience; the card's own buttons are keyboard-accessible
    <div
      data-testid="comment-card"
      onMouseEnter={() => onHover(root.thread_id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => !active && onActivate(root.thread_id)}
      className={cn(
        "animate-in fade-in slide-in-from-bottom-1 duration-200 overflow-hidden rounded-lg border bg-card transition-[box-shadow,border-color]",
        active
          ? "cursor-default border-primary shadow-[var(--shadow)]"
          : hovered
            ? "cursor-pointer border-primary/40 shadow-[0_4px_14px_-8px_rgba(0,0,0,0.45)]"
            : "cursor-pointer border-border",
        resolved && !active && "opacity-60",
      )}
    >
      {quote &&
        (textPresent && !resolved ? (
          <button
            type="button"
            data-testid={`comment-jump-${root.thread_id}`}
            onClick={(e) => {
              e.stopPropagation()
              onJump(root.thread_id)
            }}
            title="Jump to the highlighted text"
            className="block w-full cursor-pointer truncate border-l-[3px] border-primary bg-accent px-2.5 py-1.5 text-left text-xs italic text-foreground"
          >
            “{quote}”
          </button>
        ) : (
          <div
            title="The text this comment was attached to was edited or removed in this version"
            className="block w-full truncate border-l-[3px] border-border bg-secondary px-2.5 py-1.5 text-left text-xs italic text-muted-foreground"
          >
            “{quote}”
          </div>
        ))}

      {!active ? (
        <>
          <CommentRow c={root} compact />
          {replies > 0 && (
            <div className="px-3 pb-2.5 font-mono text-2xs font-bold text-primary">
              {replies} repl{replies === 1 ? "y" : "ies"}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="max-h-[360px] overflow-auto">
            {thread.map((c) => (
              <CommentRow key={c.id} c={c} />
            ))}
          </div>
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
          <div className="flex items-center gap-1.5 bg-secondary px-3 py-1.5">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-mono text-2xs font-bold",
                resolved ? "bg-success/15 text-success" : "bg-accent text-primary",
              )}
            >
              {resolved ? "resolved" : "open"}
            </span>
            {quote && !textPresent && !resolved && (
              <span
                title="The text this comment was attached to was edited or removed in this version"
                className="rounded-full bg-accent px-2 py-0.5 font-mono text-2xs font-bold text-primary"
              >
                text changed
              </span>
            )}
            <Button
              variant="outline"
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

export function ResolvedSection({
  threads,
  activeThread,
  hoverThread,
  onActivate,
  onHover,
  onResolve,
  onReply,
  onJump,
}: {
  threads: Comment[][]
  activeThread: string | null
  hoverThread: string | null
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string, mentions?: Mention[]) => void
  onJump: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="resolved-section-toggle"
        className="flex w-full items-center gap-1.5 px-0.5 py-1.5 font-mono text-2xs font-bold uppercase tracking-[0.06em] text-muted-foreground"
      >
        <span className={cn("transition-transform", open && "rotate-90")}>▸</span>
        Resolved ({threads.length})
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
