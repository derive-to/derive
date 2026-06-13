import { useEffect, useState } from "react"
import type { Comment, Mention } from "@/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CommentCard, Composer, PinnedZone, ResolvedSection } from "./comment-thread"
import { IconBtn, SectionLabel } from "./rail-deck"
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
  // Half by default (document visible above). Reset to half each time it opens;
  // a composer wants room, so expand to full automatically.
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (open) setFull(false)
  }, [open])
  useEffect(() => {
    if (open && composer) setFull(true)
  }, [open, composer])
  const empty = openThreads.length === 0 && resolved.length === 0 && !composer
  // Jumping to text: collapse to half so the highlight lands in the visible doc.
  const jumpToText = (id: string) => {
    setFull(false)
    onJump(id)
  }
  return (
    <>
      {/* Backdrop only at full height (reading mode). At half the document above
          stays tappable/scrollable, so no dimming layer intercepts it. */}
      <button
        type="button"
        aria-label="Close comments"
        tabIndex={open && full ? 0 : -1}
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-[60] bg-black/35 transition-opacity",
          open && full ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <div
        className={cn(
          "fixed inset-x-0 bottom-0 z-[61] flex flex-col rounded-t-[18px] border-t border-border bg-card shadow-[0_-14px_44px_-18px_rgba(0,0,0,0.5)] transition-[transform,height] duration-[260ms]",
          full ? "h-[88vh]" : "h-[50vh]",
          open ? "translate-y-0" : "translate-y-full",
        )}
        role="dialog"
        aria-label="Comments"
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: grip toggles height; ✕ closes. */}
        <div
          className="mx-auto mb-1 mt-[9px] h-1 w-10 shrink-0 cursor-grab rounded-full bg-border"
          onClick={() => setFull((f) => !f)}
          title={full ? "Collapse" : "Expand"}
        />
        <div className="flex items-center gap-2 border-b border-border-soft pb-2.5 pl-3.5 pr-2.5 pt-1">
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
            onClick={() => {
              setFull(true)
              onNewGeneral()
            }}
          >
            ＋ New
          </Button>
          <IconBtn title={full ? "Collapse" : "Expand"} onClick={() => setFull((f) => !f)}>
            {full ? "▾" : "▴"}
          </IconBtn>
          <IconBtn title="Close comments" onClick={onClose}>
            ✕
          </IconBtn>
        </div>
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
          {openThreads.map((t) => (
            <div key={t[0].thread_id} className="mb-2.5">
              <CommentCard
                thread={t}
                active={activeThread === t[0].thread_id}
                hovered={false}
                present={inDoc[t[0].thread_id]}
                onActivate={onActivate}
                onHover={() => {}}
                onResolve={onResolve}
                onReply={onReply}
                onJump={jumpToText}
              />
            </div>
          ))}
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
      </div>
    </>
  )
}

export function OpenPanel(props: {
  openCount: number
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
        <IconBtn title="New comment" onClick={onNewGeneral}>
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
            <>
              <SectionLabel>General</SectionLabel>
              {general.map((t) => (
                <div key={t[0].thread_id} className="mb-2.5">
                  <CommentCard
                    thread={t}
                    active={activeThread === t[0].thread_id}
                    hovered={hoverThread === t[0].thread_id}
                    present={inDoc[t[0].thread_id]}
                    onActivate={onActivate}
                    onHover={onHover}
                    onResolve={onResolve}
                    onReply={onReply}
                    onJump={onJump}
                  />
                </div>
              ))}
            </>
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
