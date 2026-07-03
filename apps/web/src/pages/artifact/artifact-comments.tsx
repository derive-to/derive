import { type Dispatch, type SetStateAction, useRef } from "react"
import type { Comment, Mention } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { MobileComments, OpenPanel } from "./comment-panels"
import { CommentScopeProvider } from "./lib/comment-scope"
import { clamp } from "./lib/layout"
import { quoteChipClass } from "./quote-chip"
import { type Panel, type PinItem, type Sel, selLabel } from "./types"

type Composer = { anchor: Sel | null; top: number | null } | null
type Selection = {
  selector: Sel
  top: number
  vTop: number
  vBottom: number
  vLeft: number
  vRight: number
} | null

/**
 * All the comment surfaces for an artifact, in one place: the desktop margin aside,
 * the phone slide-up sheet, and the floating "comment on the selection" affordance.
 * Hidden entirely for an anonymous visitor (read-only). The page owns the state +
 * mutations and threads them in.
 */
export function ArtifactComments(p: {
  shortId: string
  isMobile: boolean
  isAnon: boolean
  /** May the caller create comments here (commenter+)? Gates every write affordance;
   *  reading stays open to any authenticated viewer. */
  canComment: boolean
  docLive: boolean
  panel: Panel
  /** Active comment surface: public team thread vs your personal notes. */
  tab: "comments" | "personal"
  setTab: Dispatch<SetStateAction<"comments" | "personal">>
  personalCount: number
  publicCount: number
  asideWidth: number
  openCount: number
  scrollY: number
  onScrollDoc: (dy: number) => void
  pinned: PinItem[]
  general: Comment[][]
  resolved: Comment[][]
  openThreads: Comment[][]
  activeThread: string | null
  hoverThread: string | null
  inDoc: Record<string, boolean>
  composer: Composer
  sel: Selection
  setPanel: Dispatch<SetStateAction<Panel>>
  setComposer: Dispatch<SetStateAction<Composer>>
  setSel: Dispatch<SetStateAction<Selection>>
  setActiveThread: Dispatch<SetStateAction<string | null>>
  setHoverThread: Dispatch<SetStateAction<string | null>>
  activate: (id: string) => void
  toggleResolve: (root: Comment) => void
  reply: (text: string, threadId: string, mentions?: Mention[]) => void
  submitNew: (text: string, mentions?: Mention[]) => void
  jumpTo: (threadId: string) => void
  startSelComment: () => void
  /** Deck artifacts: the slide being viewed, and where each thread's text resolved.
   *  Used by comment cards to show a "Slide N" / "moved" badge. */
  currentSlide?: number | null
  landedSlides?: Record<string, number | null>
  /** Per-thread element-anchor resolution quality for the quiet "moved" marker. */
  anchorConf?: Record<string, { band: "high" | "medium" | "low"; confidence: number }>
}) {
  const { isMobile, isAnon, canComment, panel, sel } = p
  // Focus primer: tapping "Comment" focuses this synchronously, inside the tap
  // gesture, so iOS raises the keyboard; the composer's autofocus then takes over
  // and the keyboard stays up. (iOS won't open the keyboard for a focus that lands
  // after the React commit, outside the gesture — that's why the box came up with
  // no keyboard.)
  const primer = useRef<HTMLTextAreaElement>(null)
  const newGeneral = () => {
    p.setComposer({ anchor: null, top: null })
    p.setActiveThread(null)
  }
  const cancelNew = () => {
    p.setComposer(null)
    p.setSel(null)
  }

  return (
    <CommentScopeProvider
      value={{
        shortId: p.shortId,
        canComment,
        currentSlide: p.currentSlide,
        landedSlides: p.landedSlides,
        anchorConf: p.anchorConf,
      }}
    >
      {isMobile && canComment && (
        // Always mounted so the Comment tap can focus it synchronously (see `primer`).
        // text-base (16px) avoids iOS's zoom-on-focus.
        <textarea
          ref={primer}
          aria-hidden
          tabIndex={-1}
          data-testid="compose-primer"
          className="pointer-events-none fixed bottom-0 left-0 -z-10 size-px resize-none border-0 bg-transparent p-0 text-base opacity-0"
        />
      )}
      {!isMobile && !isAnon && (
        <aside
          className={cn(
            "flex min-h-0 shrink-0 grow-0 flex-col overflow-hidden bg-card transition-[width,flex-basis] duration-200",
            panel !== "hidden" && "border-l border-border",
          )}
          style={{ width: p.asideWidth, flexBasis: p.asideWidth }}
        >
          {panel !== "hidden" && (
            <OpenPanel
              tab={p.tab}
              setTab={p.setTab}
              personalCount={p.personalCount}
              publicCount={p.publicCount}
              openCount={p.openCount}
              scrollY={p.scrollY}
              onScrollDoc={p.onScrollDoc}
              pinned={p.pinned}
              general={p.general}
              resolved={p.resolved}
              activeThread={p.activeThread}
              hoverThread={p.hoverThread}
              inDoc={p.inDoc}
              composer={p.composer}
              onHide={() => p.setPanel("hidden")}
              onActivate={p.activate}
              onHover={p.setHoverThread}
              onResolve={p.toggleResolve}
              onReply={p.reply}
              onJump={p.jumpTo}
              onNewGeneral={newGeneral}
              onSubmitNew={p.submitNew}
              onCancelNew={cancelNew}
            />
          )}
        </aside>
      )}
      {/* Phones: comments live in a slide-up sheet that takes the bottom half, so
          the document stays visible above it. Tapping a quote scrolls the visible
          document to the highlight without closing the sheet. */}
      {isMobile && !isAnon && (
        <MobileComments
          open={panel === "open"}
          tab={p.tab}
          setTab={p.setTab}
          personalCount={p.personalCount}
          publicCount={p.publicCount}
          openThreads={p.openThreads}
          resolved={p.resolved}
          composer={p.composer}
          activeThread={p.activeThread}
          inDoc={p.inDoc}
          onClose={() => {
            p.setPanel("hidden")
            cancelNew()
          }}
          onNewGeneral={newGeneral}
          onActivate={p.activate}
          onResolve={p.toggleResolve}
          onReply={p.reply}
          onJump={p.jumpTo}
          onSubmitNew={p.submitNew}
          onCancelNew={cancelNew}
        />
      )}
      {/* Desktop: the "comment on selection" pill floats beside the selection (the
          mouse can reach it and there is no native callout in the way). On phones
          this would land under iOS's own selection menu, so mobile uses the bottom
          bar below instead. Clicking opens the panel and starts a pinned composer. */}
      {!isMobile && canComment && p.docLive && sel && !p.composer && (
        <Button
          variant="outline"
          className="fixed z-50 rounded-full bg-card shadow-[var(--shadow)]"
          title="Comment on the selection"
          data-testid="comment-on-selection"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (panel !== "open") p.setPanel("open")
            p.startSelComment()
          }}
          style={{
            // Float just above the selection, centered on it, clamped into the
            // document column (left of the aside) and below the top header.
            top: clamp(sel.vTop - 44, 64, window.innerHeight - 52),
            left: clamp(
              (sel.vLeft + sel.vRight) / 2 - 60,
              12,
              window.innerWidth - p.asideWidth - 132,
            ),
          }}
        >
          <Icon name="comments" size={16} /> Comment
        </Button>
      )}
      {/* Phones: a selection (drag) OR a tapped paragraph surfaces this bottom bar,
          pinned below iOS's own selection menu and big enough to thumb. It shows
          the quote so you know what you're attaching to; Comment opens the sheet
          composer, ✕ clears the selection. */}
      {isMobile && canComment && p.docLive && sel && !p.composer && (
        <div
          data-testid="mobile-comment-bar"
          className="fixed inset-x-0 bottom-0 z-62 flex items-center gap-2.5 border-t border-border bg-card px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-4 shadow-[var(--shadow-pop)]"
        >
          <span className={quoteChipClass({ className: "min-w-0 flex-1 truncate" })}>
            {sel.selector.type === "ElementSelector"
              ? selLabel(sel.selector)
              : `“${selLabel(sel.selector) ?? ""}”`}
          </span>
          <Button
            data-testid="mobile-comment-start"
            onClick={() => {
              primer.current?.focus()
              p.setPanel("open")
              p.startSelComment()
            }}
            className="shrink-0 rounded-full"
          >
            <Icon name="comments" size={16} /> Comment
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss selection"
            data-testid="mobile-comment-dismiss"
            onClick={() => p.setSel(null)}
            className="shrink-0"
          >
            <Icon name="close" className="size-4" />
          </Button>
        </div>
      )}
    </CommentScopeProvider>
  )
}
