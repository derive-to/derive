import { type Dispatch, type ReactNode, type SetStateAction, useRef } from "react"
import type { Comment, DirUser, Mention } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { AskAgentButton } from "./ask-agent"
import { MobileComments, OpenPanel } from "./comment-panels"
import { CommentScopeProvider } from "./lib/comment-scope"
import { clamp } from "./lib/layout"
import { quoteChipClass } from "./quote-chip"
import {
  type AgentTarget,
  type AnchorConf,
  type ComposerState,
  type Panel,
  type PinItem,
  type Selection,
  selLabel,
} from "./types"

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
  reviewCard?: ReactNode
  docLive: boolean
  panel: Panel
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
  composer: ComposerState
  sel: Selection
  setPanel: Dispatch<SetStateAction<Panel>>
  setComposer: Dispatch<SetStateAction<ComposerState>>
  setSel: Dispatch<SetStateAction<Selection>>
  setActiveThread: Dispatch<SetStateAction<string | null>>
  setHoverThread: Dispatch<SetStateAction<string | null>>
  activate: (id: string) => void
  toggleResolve: (root: Comment) => void
  reply: (text: string, threadId: string, mentions?: Mention[]) => void
  submitNew: (text: string, mentions?: Mention[]) => void
  jumpTo: (threadId: string) => void
  startSelComment: () => void
  /** Open the composer as a revision request addressed to `agent`. */
  startSelAgent: (agent: AgentTarget) => void
  /** Agents this viewer can hand a revision to (empty ⇒ the affordance is hidden). */
  agents: DirUser[]
  /** Deck artifacts: the slide being viewed, and where each thread's text resolved.
   *  Used by comment cards to show a "Slide N" / "moved" badge. */
  currentSlide?: number | null
  landedSlides?: Record<string, number | null>
  /** Per-thread element-anchor resolution quality for the quiet "moved" marker. */
  anchorConf?: AnchorConf
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
        agentIds: new Set(p.agents.map((a) => a.id)),
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
              reviewCard={p.reviewCard}
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
          reviewCard={p.reviewCard}
        />
      )}
      {/* Desktop: the "comment on selection" pill floats beside the selection (the
          mouse can reach it and there is no native callout in the way). On phones
          this would land under iOS's own selection menu, so mobile uses the bottom
          bar below instead. Clicking opens the panel and starts a pinned composer. */}
      {!isMobile && canComment && p.docLive && sel && !p.composer && (
        // biome-ignore lint/a11y/noStaticElementInteractions: onMouseDown only prevents the pill from stealing the selection; the real controls inside are buttons.
        <div
          className="fixed z-50 flex items-center gap-1 rounded-full bg-card p-1 shadow-[var(--shadow)] ring-1 ring-border"
          onMouseDown={(e) => e.preventDefault()}
          style={{
            // Float just above the selection, centered on it, clamped into the
            // document column (left of the aside) and below the top header. A wider
            // half-width offset accounts for the two-action row (Comment · Ask agent).
            top: clamp(sel.vTop - 46, 64, window.innerHeight - 54),
            left: clamp(
              (sel.vLeft + sel.vRight) / 2 - 90,
              12,
              window.innerWidth - p.asideWidth - 210,
            ),
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            title="Comment on the selection"
            data-testid="comment-on-selection"
            onClick={() => {
              if (panel !== "open") p.setPanel("open")
              p.startSelComment()
            }}
          >
            <Icon name="comments" size={16} /> Comment
          </Button>
          {/* The agent-native moat: hand the selected span to an agent to revise. */}
          <AskAgentButton
            agents={p.agents}
            onPick={(agent) => {
              if (panel !== "open") p.setPanel("open")
              p.startSelAgent(agent)
            }}
          />
        </div>
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
          <AskAgentButton
            agents={p.agents}
            size="bar"
            onPick={(agent) => {
              primer.current?.focus()
              p.setPanel("open")
              p.startSelAgent(agent)
            }}
          />
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
