import { type Dispatch, type ReactNode, type RefObject, type SetStateAction, useRef } from "react"
import type { Comment, DirUser, Mention } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { AskAgentButton } from "./ask-agent"
import { MobileComments, OpenPanel } from "./comment-panels"
import { CommentScopeProvider } from "./lib/comment-scope"
import { type CommentTree, CommentTreeProvider } from "./lib/comment-tree"
import { quoteChipClass } from "./quote-chip"
import { SelectionMenu } from "./selection-menu"
import {
  type AgentTarget,
  type AnchorConf,
  type ComposerState,
  type FrameGeom,
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
  /** Phones only: px the comment sheet occupies at the viewport bottom, so the page
   *  can reserve that under the document (0 when the sheet is closed). */
  onSheetHeight?: (px: number) => void
  docLive: boolean
  panel: Panel
  asideWidth: number
  openCount: number
  /** The rendered document's iframe — the pin layer and selection pill measure
   *  their live position against it. */
  frameRef: RefObject<HTMLIFrameElement | null>
  /** Imperative scroll-geometry feed (see use-artifact-frame). */
  subscribeGeom: (cb: (g: FrameGeom) => void) => () => void
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
    p.setComposer({ anchor: null, docTop: null })
    p.setActiveThread(null)
  }
  const cancelNew = () => {
    p.setComposer(null)
    p.setSel(null)
  }

  // The interaction state + handlers every card reads directly (see CommentTree),
  // instead of drilling them through OpenPanel / PinnedZone / the sheet — so a card
  // render site is just `<CommentCard thread={t} />`. This is a STRUCTURAL fold, not a
  // re-render optimization: the page rebuilds most of these handlers each render (they
  // close over changing deck/comment data), so the value is intentionally a fresh object
  // — no useMemo, which couldn't hit and would only add an empty dep check. Cards are
  // descendants that re-render with this component regardless, as they did when drilled.
  const tree: CommentTree = {
    activeThread: p.activeThread,
    hoverThread: p.hoverThread,
    inDoc: p.inDoc,
    onActivate: p.activate,
    onHover: p.setHoverThread,
    onResolve: p.toggleResolve,
    onReply: p.reply,
    onJump: p.jumpTo,
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
      <CommentTreeProvider value={tree}>
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
              // overflow-clip: focus scrolling must never shift this box — the pin
              // layer's transform math assumes its ancestors stay put.
              "flex min-h-0 shrink-0 grow-0 flex-col overflow-clip bg-card transition-[width,flex-basis] duration-200",
              panel !== "hidden" && "border-l border-border",
            )}
            style={{ width: p.asideWidth, flexBasis: p.asideWidth }}
          >
            {panel !== "hidden" && (
              <OpenPanel
                openCount={p.openCount}
                frameRef={p.frameRef}
                subscribeGeom={p.subscribeGeom}
                onScrollDoc={p.onScrollDoc}
                pinned={p.pinned}
                general={p.general}
                resolved={p.resolved}
                composer={p.composer}
                onHide={() => p.setPanel("hidden")}
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
            onClose={() => {
              p.setPanel("hidden")
              cancelNew()
            }}
            onNewGeneral={newGeneral}
            onSubmitNew={p.submitNew}
            onCancelNew={cancelNew}
            reviewCard={p.reviewCard}
            onHeightChange={p.onSheetHeight}
          />
        )}
        {/* Desktop: the anchored action menu above the selection (the mouse can
          reach it and there is no native callout in the way). On phones this
          would land under iOS's own selection menu, so mobile uses the bottom
          bar below instead. Choosing opens the panel and starts a pinned composer. */}
        {!isMobile && canComment && p.docLive && sel && !p.composer && (
          <SelectionMenu
            sel={sel}
            frameRef={p.frameRef}
            subscribeGeom={p.subscribeGeom}
            asideWidth={p.asideWidth}
            agents={p.agents}
            onComment={() => {
              if (panel !== "open") p.setPanel("open")
              p.startSelComment()
            }}
            onAgent={(agent) => {
              if (panel !== "open") p.setPanel("open")
              p.startSelAgent(agent)
            }}
          />
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
      </CommentTreeProvider>
    </CommentScopeProvider>
  )
}
