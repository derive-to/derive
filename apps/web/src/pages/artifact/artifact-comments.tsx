import type { Dispatch, SetStateAction } from "react"
import type { Comment, Mention } from "@/api"
import { Icon } from "@/components/icons"
import { cn } from "@/lib/utils"
import { MobileComments, OpenPanel } from "./comment-panels"
import { CommentScopeProvider } from "./lib/comment-scope"
import { clamp } from "./lib/layout"
import { Rail } from "./rail-deck"
import type { Panel, PinItem, Sel } from "./types"

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
 * All the comment surfaces for an artifact, in one place: the desktop margin aside
 * (rail or open panel), the phone slide-up sheet, and the floating "comment on the
 * selection" affordance. Hidden entirely for an anonymous visitor (read-only). The
 * page owns the state + mutations and threads them in.
 */
export function ArtifactComments(p: {
  shortId: string
  isMobile: boolean
  isAnon: boolean
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
}) {
  const { isMobile, isAnon, panel, sel } = p
  const newGeneral = () => {
    p.setComposer({ anchor: null, top: null })
    p.setActiveThread(null)
  }
  const cancelNew = () => {
    p.setComposer(null)
    p.setSel(null)
  }

  return (
    <CommentScopeProvider value={{ shortId: p.shortId }}>
      {!isMobile && !isAnon && (
        <aside
          className={cn(
            "flex min-h-0 shrink-0 grow-0 flex-col overflow-hidden bg-card transition-[width,flex-basis] duration-200",
            panel !== "hidden" && "border-l border-border",
          )}
          style={{ width: p.asideWidth, flexBasis: p.asideWidth }}
        >
          {panel === "rail" ? (
            <Rail
              pins={p.pinned}
              generalCount={p.general.length}
              active={p.activeThread}
              onExpand={() => p.setPanel("open")}
              onHide={() => p.setPanel("hidden")}
              onDot={(id) => {
                p.setPanel("open")
                p.jumpTo(id)
              }}
            />
          ) : (
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
              onMinimize={() => p.setPanel("rail")}
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
          openThreads={p.openThreads}
          resolved={p.resolved}
          openCount={p.openCount}
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
      {/* The "comment on selection" affordance floats beside the selection in every
          panel state. Clicking it opens the panel if needed and starts a composer
          pinned to the selection. Logged-in only. */}
      {!isAnon && p.docLive && sel && !p.composer && (
        <button
          type="button"
          className="fixed z-50 inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-primary bg-card px-3.5 py-2 text-sm font-semibold text-primary shadow-[var(--shadow)] transition-colors hover:bg-primary hover:text-primary-foreground"
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
        </button>
      )}
    </CommentScopeProvider>
  )
}
