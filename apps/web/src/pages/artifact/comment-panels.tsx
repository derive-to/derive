import { useEffect, useState } from "react"
import type { Comment, Mention } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  CommentCard,
  Composer,
  GeneralSection,
  PinnedZone,
  ResolvedSection,
} from "./comment-thread"
import { IconBtn } from "./rail-deck"
import type { PinItem, Sel } from "./types"

export function MobileComments({
  open,
  openThreads,
  resolved,
  openCount,
  composer,
  activeThread,
  inDoc,
  onClose,
  onNewGeneral,
  onActivate,
  onResolve,
  onReply,
  onJump,
  onSubmitNew,
  onCancelNew,
}: {
  open: boolean
  openThreads: Comment[][]
  resolved: Comment[][]
  openCount: number
  composer: { anchor: Sel | null; top: number | null } | null
  activeThread: string | null
  inDoc: Record<string, boolean>
  onClose: () => void
  onNewGeneral: () => void
  onActivate: (id: string) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string, mentions?: Mention[]) => void
  onJump: (id: string) => void
  onSubmitNew: (text: string, mentions?: Mention[]) => void
  onCancelNew: () => void
}) {
  // Three heights: peek (a slim bar you tap to reopen), half (document visible
  // above), full. Reset to half on each open; a composer wants room so it expands
  // to full; and tapping out (the full-height backdrop) collapses to the peek bar
  // rather than closing outright, so comments stay one tap away.
  const [size, setSize] = useState<"peek" | "half" | "full">("half")
  useEffect(() => {
    if (open) setSize("half")
  }, [open])
  // A composer must sit fully above the iOS keyboard, so derive "full" whenever one
  // is open instead of racing an effect (which could leave the sheet at half, behind
  // the keyboard, with the box out of view). The user's resize drives `size` after.
  const sheet = composer ? "full" : size
  // iOS keeps `position: fixed` put when the keyboard opens, so a bottom sheet hides
  // behind it. Track the keyboard via visualViewport and pin the sheet into the
  // visible area above it while one is up (ignore the small URL-bar shrink).
  const [kb, setKb] = useState<{ inset: number; height: number } | null>(null)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      setKb(inset > 80 ? { inset, height: vv.height } : null)
    }
    update()
    vv.addEventListener("resize", update)
    vv.addEventListener("scroll", update)
    return () => {
      vv.removeEventListener("resize", update)
      vv.removeEventListener("scroll", update)
    }
  }, [])
  const empty = openThreads.length === 0 && resolved.length === 0 && !composer
  // The grip taps bigger; full wraps back to half. The chevron handles peek.
  const grip = () => setSize((s) => (s === "peek" ? "half" : s === "half" ? "full" : "half"))
  // Jumping to text: drop to half so the highlight lands in the visible doc.
  const jumpToText = (id: string) => {
    setSize("half")
    onJump(id)
  }
  return (
    <>
      {/* Backdrop only at full height (reading mode). At half the document above
          stays tappable/scrollable, so no dimming layer intercepts it. */}
      <button
        type="button"
        data-testid="comments-sheet-backdrop"
        aria-label="Collapse comments"
        tabIndex={open && sheet === "full" ? 0 : -1}
        onClick={() => setSize("peek")}
        className={cn(
          "fixed inset-0 z-[60] bg-black/35 transition-opacity",
          open && sheet === "full" ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <div
        className={cn(
          "fixed inset-x-0 bottom-0 z-[61] flex flex-col rounded-t-[18px] border-t border-border bg-card shadow-[0_-14px_44px_-18px_rgba(0,0,0,0.5)] transition-[transform,height] duration-[260ms]",
          sheet === "full" ? "h-[88vh]" : sheet === "peek" ? "h-[74px]" : "h-[50vh]",
          open ? "translate-y-0" : "translate-y-full",
        )}
        // While the keyboard is up, pin the sheet into the visible area above it
        // (overrides bottom-0 + the height class) so the composer is never hidden.
        style={kb ? { bottom: kb.inset, height: kb.height } : undefined}
        role="dialog"
        aria-label="Comments"
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: grip resizes the sheet; ✕ closes. */}
        <div
          data-testid="comments-sheet-grip"
          className="mx-auto mb-1 mt-[9px] h-1 w-10 shrink-0 cursor-grab rounded-full bg-border"
          onClick={grip}
          title="Resize"
        />
        <div className="flex items-center gap-2 border-b border-border-soft pb-3 pl-3.5 pr-2.5 pt-2">
          <b className="text-base">Comments</b>
          {openCount > 0 && (
            <span className="rounded-full bg-accent px-2 py-px font-mono text-2xs font-bold text-primary">
              {openCount}
            </span>
          )}
          <span className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            data-testid="comments-sheet-new"
            onClick={() => {
              setSize("full")
              onNewGeneral()
            }}
          >
            ＋ New
          </Button>
          <IconBtn
            big
            title={size === "peek" ? "Expand" : "Collapse"}
            testId="comments-sheet-resize"
            onClick={() => setSize(size === "peek" ? "half" : "peek")}
          >
            <Icon name="caret" size={20} className={size === "peek" ? "rotate-180" : undefined} />
          </IconBtn>
          <IconBtn big title="Close comments" onClick={onClose}>
            <Icon name="close" size={20} />
          </IconBtn>
        </div>
        {sheet !== "peek" && (
          <div className="min-h-0 flex-1 overflow-auto p-3 pb-[max(14px,env(safe-area-inset-bottom))]">
            {composer && (
              <div className="mb-3">
                <Composer
                  quote={composer.anchor?.exact ?? null}
                  onSubmit={onSubmitNew}
                  onCancel={onCancelNew}
                />
              </div>
            )}
            {empty && (
              <div className="grid place-items-center gap-2 p-[34px] text-center">
                <div className="text-3xl opacity-50">💬</div>
                <div className="text-sm leading-relaxed text-muted-foreground">
                  No comments yet.
                  <br />
                  Select text in the document to start one.
                </div>
              </div>
            )}
            {openThreads.map((t) => {
              const head = t[0]
              if (!head) return null
              return (
                <div key={head.thread_id} className="mb-2.5">
                  <CommentCard
                    thread={t}
                    active={activeThread === head.thread_id}
                    hovered={false}
                    present={inDoc[head.thread_id]}
                    onActivate={onActivate}
                    onHover={() => {}}
                    onResolve={onResolve}
                    onReply={onReply}
                    onJump={jumpToText}
                  />
                </div>
              )
            })}
            {resolved.length > 0 && (
              <ResolvedSection
                threads={resolved}
                activeThread={activeThread}
                hoverThread={null}
                onActivate={onActivate}
                onHover={() => {}}
                onResolve={onResolve}
                onReply={onReply}
                onJump={jumpToText}
              />
            )}
          </div>
        )}
      </div>
    </>
  )
}

export function OpenPanel(props: {
  openCount: number
  scrollY: number
  onScrollDoc: (dy: number) => void
  pinned: PinItem[]
  general: Comment[][]
  resolved: Comment[][]
  activeThread: string | null
  hoverThread: string | null
  inDoc: Record<string, boolean>
  composer: { anchor: Sel | null; top: number | null } | null
  onMinimize: () => void
  onHide: () => void
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string, mentions?: Mention[]) => void
  onJump: (id: string) => void
  onNewGeneral: () => void
  onSubmitNew: (text: string, mentions?: Mention[]) => void
  onCancelNew: () => void
}) {
  const {
    openCount,
    scrollY,
    onScrollDoc,
    pinned,
    general,
    resolved,
    activeThread,
    hoverThread,
    inDoc,
    composer,
    onMinimize,
    onHide,
    onActivate,
    onHover,
    onResolve,
    onReply,
    onJump,
    onNewGeneral,
    onSubmitNew,
    onCancelNew,
  } = props
  const generalComposer = composer && !composer.anchor
  const empty = openCount === 0 && resolved.length === 0 && !composer

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border-soft py-2.5 pl-3.5 pr-2">
        <b className="text-sm">Comments</b>
        {openCount > 0 && (
          <span className="rounded-full bg-accent px-2 py-px font-mono text-2xs font-bold text-primary">
            {openCount}
          </span>
        )}
        <span className="flex-1" />
        <IconBtn title="New comment" testId="comment-new" onClick={onNewGeneral}>
          ＋
        </IconBtn>
        <IconBtn title="Minimize to rail (c)" onClick={onMinimize}>
          ⟩
        </IconBtn>
        <IconBtn title="Hide comments" onClick={onHide}>
          ✕
        </IconBtn>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* Pinned margin — cards (and a new-comment composer) float beside their
            highlighted text, sharing one overlap-free layout. */}
        <PinnedZone
          pins={pinned}
          scrollY={scrollY}
          onScrollDoc={onScrollDoc}
          composer={composer}
          activeThread={activeThread}
          hoverThread={hoverThread}
          inDoc={inDoc}
          onActivate={onActivate}
          onHover={onHover}
          onResolve={onResolve}
          onReply={onReply}
          onJump={onJump}
          onSubmitNew={onSubmitNew}
          onCancelNew={onCancelNew}
        />

        {/* Empty state. */}
        {empty && (
          <div className="absolute inset-0 grid place-items-center gap-2 p-6 text-center">
            <div className="text-3xl opacity-50">💬</div>
            <div className="text-sm leading-relaxed text-muted-foreground">
              No comments yet.
              <br />
              Select text in the document to start one.
            </div>
          </div>
        )}
      </div>

      {/* General + resolved threads live in a scrollable footer drawer. */}
      {(generalComposer || general.length > 0 || resolved.length > 0) && (
        <div className="max-h-[44%] shrink-0 overflow-auto border-t border-border-soft p-2.5">
          {generalComposer && (
            <div className="mb-2.5">
              <Composer quote={null} onSubmit={onSubmitNew} onCancel={onCancelNew} />
            </div>
          )}
          {general.length > 0 && (
            <GeneralSection
              threads={general}
              activeThread={activeThread}
              hoverThread={hoverThread}
              onActivate={onActivate}
              onHover={onHover}
              onResolve={onResolve}
              onReply={onReply}
              onJump={onJump}
            />
          )}
          {resolved.length > 0 && (
            <ResolvedSection
              threads={resolved}
              activeThread={activeThread}
              hoverThread={hoverThread}
              onActivate={onActivate}
              onHover={onHover}
              onResolve={onResolve}
              onReply={onReply}
              onJump={onJump}
            />
          )}
        </div>
      )}
    </>
  )
}

// Pinned margin: absolutely positions each thread card next to its highlight,
// measuring heights and relaxing overlaps so cards never stack on top of each
// other. The active card snaps to its true anchor; neighbours flow around it.
