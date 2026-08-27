import {
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useRef,
  useState,
} from "react"
import type { Artifact, Comment, DirUser, Mention, ReviewRound } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ActivityPanel } from "./activity-panel"
import { type RailTab, RailTabs } from "./artifact-chat"
import { MobileComments } from "./comment-panels"
import { buildStream, type Lens } from "./lib/activity"
import { CommentScopeProvider } from "./lib/comment-scope"
import { type CommentTree, CommentTreeProvider } from "./lib/comment-tree"
import { quoteChipClass } from "./quote-chip"
import { SelectionMenu } from "./selection-menu"
import {
  type AnchorConf,
  type ComposerState,
  type FrameGeom,
  type Panel,
  type Selection,
  selLabel,
} from "./types"

/**
 * All the comment surfaces for an artifact, in one place: the desktop activity rail,
 * the phone slide-up sheet, and the floating "comment on the selection" affordance.
 * Hidden entirely for an anonymous visitor (read-only). The page owns the state +
 * mutations and threads them in.
 */
export function ArtifactComments(p: {
  shortId: string
  isMobile: boolean
  /** THE RAIL. Conversation remains the default: comments, then optional chat; the quieter
   *  editor-only Inspect tab comes last. Desktop aside and mobile peek bar share one control. */
  rail?: RailTab
  onRail?: (r: RailTab) => void
  /** Linked bundles add one native map inside the existing collaboration rail. */
  mapEnabled?: boolean
  mapPanel?: ReactNode
  visualPinAvailable?: boolean
  visualPinActive?: boolean
  onToggleVisualPin?: () => void
  /** Beta: chat is absent rather than visible-and-refused when the workspace has it off. */
  chatBeta?: boolean
  chatPanel?: ReactNode
  /** Inspect exists only while an editor is actively editing an HTML artifact — it never
   *  becomes a generic alternative to commenting or a deck-specific surface. */
  inspectEnabled?: boolean
  inspectPanel?: ReactNode
  isAnon: boolean
  /** May the caller create comments here (commenter+)? Gates every write affordance;
   *  reading stays open to any authenticated viewer. */
  canComment: boolean
  /** The suggestion / locked one-liners shown above the stream. */
  hints?: ReactNode
  /** What the activity stream is built from besides the comments: the versions (and
   *  the server's time-clustered sessions), the review rounds, and the reader's last
   *  visit. The page owns the version jump and the send-back write. */
  versions: Artifact["versions"]
  sessions?: Artifact["sessions"]
  currentVersion: number
  rounds: ReviewRound[]
  pendingRound: ReviewRound | null
  meId: string
  meName: string
  lastSeen: number | null
  onGoToVersion: (n: number) => void
  onSendBack: (note?: string) => void
  sendingBack: boolean
  /** Doc-absolute tops of the open anchored threads — "follow the document". */
  anchorTops: Record<string, number>
  /** Phones only: px the comment sheet occupies at the viewport bottom, so the page
   *  can reserve that under the document (0 when the sheet is closed). */
  onSheetHeight?: (px: number) => void
  docLive: boolean
  /** Inline edit mode is on — the comment empty states say so instead of telling
   *  the reader to select text (selection edits while editing). */
  editing?: boolean
  /** The selection bar's second verb. Absent ⇒ this viewer can't edit the doc. */
  editLabel?: string
  onEditSelection?: () => void
  panel: Panel
  asideWidth: number
  /** Every comment on the artifact — the stream groups them into threads itself. */
  comments: Comment[]
  openCount: number
  /** The rendered document's iframe — the selection pill measures its live
   *  position against it. */
  frameRef: RefObject<HTMLIFrameElement | null>
  /** Imperative scroll-geometry feed (see use-artifact-frame). */
  subscribeGeom: (cb: (g: FrameGeom) => void) => () => void
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
  /** The artifact's registered agents — used only to tag agent-authored comments
   *  (agentIds below); the selection composer no longer hands revisions to them. */
  agents: DirUser[]
  /** Deck artifacts: the slide being viewed, and where each thread's text resolved.
   *  Used by comment cards to show a "Slide N" / "moved" badge. */
  currentSlide?: number | null
  landedSlides?: Record<string, number | null>
  /** Per-thread element-anchor resolution quality for the quiet "moved" marker. */
  anchorConf?: AnchorConf
}) {
  const { isMobile, isAnon, canComment, panel, sel } = p
  const hasRailTabs = !!p.mapEnabled || !!p.chatBeta || !!p.inspectEnabled
  // THE STREAM, built once for both surfaces: the versions (grouped by the server's
  // sessions), the threads, the review rounds, and — after the reader's last visit —
  // the replies. The lens is rail state like `rail` itself.
  const [lens, setLens] = useState<Lens>("all")
  // Who did what is in the records themselves (a version's agent, a comment's author
  // kind, a round's requester) — nothing here is looked up by name.
  const items = buildStream({
    versions: p.versions,
    sessions: p.sessions,
    comments: p.comments,
    rounds: p.rounds,
    meId: p.meId,
    me: p.meName,
    lastSeen: p.lastSeen,
    lens,
    now: Date.now(),
  })
  // Focus primer: tapping "Comment" focuses this synchronously, inside the tap
  // gesture, so iOS raises the keyboard; the composer's autofocus then takes over
  // and the keyboard stays up. (iOS won't open the keyboard for a focus that lands
  // after the React commit, outside the gesture — that's why the box came up with
  // no keyboard.)
  const primer = useRef<HTMLTextAreaElement>(null)
  // The phone sheet's "New": a live composer state is what opens its composer bar.
  const newGeneral = () => {
    p.setComposer({ anchor: null, docTop: null })
    p.setActiveThread(null)
  }
  // The desktop rail's "New": its composer is always there, so this only drops a parked
  // quote and the active thread. A parked empty composer would hide the selection menu
  // (which yields while a composer is live) until Escape — the old drawer needed the
  // parked state to show a card; the docked composer does not.
  const newGeneralDesktop = () => {
    p.setComposer(null)
    p.setSel(null)
    p.setActiveThread(null)
  }
  const cancelNew = () => {
    p.setComposer(null)
    p.setSel(null)
  }

  // The interaction state + handlers every card reads directly (see CommentTree),
  // instead of drilling them through the rail / the stream / the sheet — so a card
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
              // overflow-clip: focus scrolling must never shift this box — the stream
              // owns its own scroll container.
              "flex min-h-0 shrink-0 grow-0 flex-col overflow-clip bg-card transition-[width,flex-basis] duration-state",
              panel !== "hidden" && "border-l border-border",
            )}
            style={{ width: p.asideWidth, flexBasis: p.asideWidth }}
          >
            {/* The strip sits INSIDE the aside, above whichever body is showing — the same
                control the mobile peek bar renders, just at the top of a column instead of
                the top of a sheet. The activity body takes the strip INTO its own header
                row (one row, not a strip over a heading that repeats the tab's name). */}
            {panel !== "hidden" && hasRailTabs && p.rail && p.rail !== "comments" && p.onRail && (
              <div className="flex shrink-0 items-center border-b border-border px-2 py-1.5">
                <RailTabs
                  tab={p.rail}
                  commentCount={p.openCount}
                  mapEnabled={p.mapEnabled}
                  chatEnabled={p.chatBeta}
                  inspectEnabled={p.inspectEnabled}
                  onTab={p.onRail}
                />
              </div>
            )}
            {panel !== "hidden" && p.rail === "map" && p.mapEnabled ? (
              p.mapPanel
            ) : panel !== "hidden" && p.rail === "chat" && p.chatBeta ? (
              p.chatPanel
            ) : panel !== "hidden" && p.rail === "inspect" && p.inspectEnabled ? (
              p.inspectPanel
            ) : panel !== "hidden" ? (
              <ActivityPanel
                tabs={
                  hasRailTabs && p.rail && p.onRail ? (
                    <RailTabs
                      tab={p.rail}
                      commentCount={p.openCount}
                      mapEnabled={p.mapEnabled}
                      chatEnabled={p.chatBeta}
                      inspectEnabled={p.inspectEnabled}
                      onTab={p.onRail}
                    />
                  ) : undefined
                }
                items={items}
                openCount={p.openCount}
                currentVersion={p.currentVersion}
                pendingRound={p.pendingRound}
                lens={lens}
                onLens={setLens}
                composer={p.composer}
                onNewGeneral={newGeneralDesktop}
                onSubmitNew={p.submitNew}
                onCancelNew={cancelNew}
                onHide={() => p.setPanel("hidden")}
                visualPinAvailable={p.visualPinAvailable}
                visualPinActive={p.visualPinActive}
                onToggleVisualPin={p.onToggleVisualPin}
                hints={p.hints}
                editing={p.editing}
                onGoToVersion={p.onGoToVersion}
                onSendBack={p.onSendBack}
                sendingBack={p.sendingBack}
                anchorTops={p.anchorTops}
                subscribeGeom={p.subscribeGeom}
              />
            ) : null}
          </aside>
        )}
        {/* Phones: comments live in a slide-up sheet that takes the bottom half, so
          the document stays visible above it. Tapping a quote scrolls the visible
          document to the highlight without closing the sheet. */}
        {isMobile && !isAnon && (
          <MobileComments
            editing={p.editing}
            open={panel === "open"}
            openThreads={p.openThreads}
            items={items}
            currentVersion={p.currentVersion}
            pendingRound={p.pendingRound}
            onGoToVersion={p.onGoToVersion}
            onSendBack={p.onSendBack}
            composer={p.composer}
            onNewGeneral={newGeneral}
            onSubmitNew={p.submitNew}
            onCancelNew={cancelNew}
            onHeightChange={p.onSheetHeight}
            // The peek bar IS the tab strip on a phone: always docked, so comments never
            // lose their entry point and chat is one thumb-reach away.
            rail={hasRailTabs ? p.rail : undefined}
            onRail={p.onRail}
            chatPanel={p.chatPanel}
            mapPanel={p.mapPanel}
            mapEnabled={p.mapEnabled}
            inspectPanel={p.inspectPanel}
            chatEnabled={p.chatBeta}
            inspectEnabled={p.inspectEnabled}
            openCount={p.openCount}
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
            onComment={() => {
              p.onRail?.("comments")
              if (panel !== "open") p.setPanel("open")
              p.startSelComment()
            }}
            editLabel={p.editLabel}
            onEdit={p.onEditSelection}
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
