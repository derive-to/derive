import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react"
import type { Comment, Mention } from "@/api"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useFocusTrap } from "@/lib/use-focus-trap"
import { cn } from "@/lib/utils"
import {
  CommentCard,
  Composer,
  GeneralSection,
  PinnedZone,
  ResolvedSection,
} from "./comment-thread"
import { useCommentScope } from "./lib/comment-scope"
import { IconBtn } from "./rail-deck"
import { type PinItem, type Sel, selLabel } from "./types"

type Tab = "comments" | "personal"

const TabCount = ({ n }: { n: number }) => (
  <span className="rounded-full bg-accent px-1.5 font-mono text-2xs font-bold text-primary">
    {n}
  </span>
)

/** The Comments | Personal switch in a panel header — the shared shadcn Tabs control,
 *  so it matches Settings/Share. Personal is your private notes, visible only to you
 *  and the agents you've authed (the server enforces it); the parent owns which list
 *  shows, so there's no TabsContent here. */
function CommentTabs({
  tab,
  setTab,
  publicCount,
  personalCount,
}: {
  tab: Tab
  setTab: Dispatch<SetStateAction<Tab>>
  publicCount: number
  personalCount: number
}) {
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-w-0 flex-1">
      <TabsList className="h-7 w-full">
        <TabsTrigger value="comments" data-testid="comment-tab-comments" className="flex-1">
          Comments
          {publicCount > 0 && <TabCount n={publicCount} />}
        </TabsTrigger>
        <TabsTrigger value="personal" data-testid="comment-tab-personal" className="flex-1">
          <Icon name="lock" size={12} />
          Personal
          {personalCount > 0 && <TabCount n={personalCount} />}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

export function MobileComments({
  open,
  tab,
  setTab,
  personalCount,
  publicCount,
  openThreads,
  resolved,
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
  tab: Tab
  setTab: Dispatch<SetStateAction<Tab>>
  personalCount: number
  publicCount: number
  openThreads: Comment[][]
  resolved: Comment[][]
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
  // Two states only: peek (a slim "Comments (N)" bar — the default) and full (the
  // list). Composing overrides both with a compact composer bar pinned above the
  // keyboard (see the height + `kb` style below), so the box sits flush above the
  // keyboard with the document visible above — no awkward half-height middle state.
  const { canComment } = useCommentScope()
  const [size, setSize] = useState<"peek" | "full">("peek")
  const sheetRef = useRef<HTMLDivElement>(null)
  useFocusTrap(sheetRef, open)
  useEffect(() => {
    if (open) setSize("peek")
  }, [open])
  // iOS keeps `position: fixed` put when the keyboard opens, so a bottom sheet hides
  // behind it. Track the keyboard via visualViewport and pin the sheet into the
  // visible area above it. Measure against the layout viewport (clientHeight is
  // keyboard-stable on iOS); a >150px shrink is a real keyboard, which rules out the
  // ~60-115px Safari toolbar collapse that would otherwise false-trigger. rAF-
  // coalesced and change-guarded so the scroll/resize bursts don't thrash.
  const [kb, setKb] = useState<{ inset: number; height: number } | null>(null)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let raf = 0
    const measure = () => {
      const layoutH = document.documentElement.clientHeight
      const inset = Math.max(0, layoutH - vv.height - vv.offsetTop)
      const next = inset > 150 ? { inset: Math.round(inset), height: Math.round(vv.height) } : null
      setKb((prev) => {
        if (!prev && !next) return prev
        if (prev && next && prev.inset === next.inset && prev.height === next.height) return prev
        return next
      })
    }
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    measure()
    vv.addEventListener("resize", update)
    vv.addEventListener("scroll", update)
    return () => {
      cancelAnimationFrame(raf)
      vv.removeEventListener("resize", update)
      vv.removeEventListener("scroll", update)
    }
  }, [])
  // When the composer closes (submit/cancel), drop focus so iOS dismisses the
  // keyboard instead of leaving it up over an empty sheet (which would keep the
  // sheet pinned/shrunk via `kb`).
  useEffect(() => {
    if (!composer) (document.activeElement as HTMLElement | null)?.blur?.()
  }, [composer])
  const empty = openThreads.length === 0 && resolved.length === 0 && !composer
  // The grip toggles peek <-> full.
  const grip = () => setSize((s) => (s === "peek" ? "full" : "peek"))
  // Jumping to text: drop to the peek bar so the highlight is visible in the doc.
  const jumpToText = (id: string) => {
    setSize("peek")
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
        tabIndex={open && !composer && size === "full" ? 0 : -1}
        onClick={() => setSize("peek")}
        className={cn(
          "fixed inset-0 z-[60] bg-black/35 transition-opacity",
          open && !composer && size === "full" ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <div
        ref={sheetRef}
        className={cn(
          "fixed inset-x-0 bottom-0 z-[61] flex flex-col rounded-t-[18px] border-t border-border bg-card shadow-[0_-14px_44px_-18px_rgba(0,0,0,0.5)] duration-[260ms]",
          // Don't animate height while the keyboard repositions the sheet.
          kb ? "transition-transform" : "transition-[transform,height]",
          // Composing: a compact bar sized to its content (capped), so the box sits
          // flush above the keyboard rather than high up in a tall sheet.
          composer ? "max-h-[80vh]" : size === "full" ? "h-[88vh]" : "h-[74px]",
          open ? "translate-y-0" : "translate-y-full",
        )}
        // While the keyboard is up, lift the sheet's bottom to just above it and cap
        // its height to the visible band — so the half-height composer sits in view
        // (with a sliver of document above) instead of behind/under the keyboard.
        style={kb ? { bottom: kb.inset, maxHeight: kb.height } : undefined}
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
        <div className="flex items-center gap-2 border-b border-border-soft pb-3 pl-3 pr-2.5 pt-2">
          <CommentTabs
            tab={tab}
            setTab={setTab}
            publicCount={publicCount}
            personalCount={personalCount}
          />
          {canComment && (
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
          )}
          <IconBtn
            big
            title={size === "peek" ? "Expand" : "Collapse"}
            testId="comments-sheet-resize"
            onClick={() => setSize(size === "peek" ? "full" : "peek")}
          >
            <Icon name="caret" size={20} className={size === "peek" ? "rotate-180" : undefined} />
          </IconBtn>
          <IconBtn big title="Close comments" onClick={onClose}>
            <Icon name="close" size={20} />
          </IconBtn>
        </div>
        {composer ? (
          // Composing ("half open"): just the composer, so the sheet is a compact bar
          // pinned above the keyboard with the document visible above. The list
          // reappears once you send or cancel.
          <div className="overflow-auto p-3 pb-[max(14px,env(safe-area-inset-bottom))]">
            <Composer
              quote={selLabel(composer.anchor)}
              personal={tab === "personal"}
              // After posting, open the full list so the new comment is visible (the
              // sheet would otherwise drop back to the peek bar and hide it).
              onSubmit={(text, mentions) => {
                setSize("full")
                onSubmitNew(text, mentions)
              }}
              onCancel={onCancelNew}
            />
          </div>
        ) : size === "full" ? (
          <div className="min-h-0 flex-1 overflow-auto p-3 pb-[max(14px,env(safe-area-inset-bottom))]">
            {empty && (
              <div className="grid place-items-center gap-2 p-[34px] text-center">
                <div className="text-3xl opacity-50">{tab === "personal" ? "🔒" : "💬"}</div>
                <div className="text-sm leading-relaxed text-muted-foreground">
                  {tab === "personal" ? (
                    <>
                      No personal notes yet.
                      <br />
                      Only you and your agents can see these.
                    </>
                  ) : (
                    <>
                      No comments yet.
                      <br />
                      Select text in the document to start one.
                    </>
                  )}
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
        ) : null}
      </div>
    </>
  )
}

export function OpenPanel(props: {
  tab: Tab
  setTab: Dispatch<SetStateAction<Tab>>
  personalCount: number
  publicCount: number
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
    tab,
    setTab,
    personalCount,
    publicCount,
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
  const { canComment } = useCommentScope()
  const generalComposer = composer && !composer.anchor
  const empty = openCount === 0 && resolved.length === 0 && !composer

  return (
    <>
      <div className="flex items-center gap-1 border-b border-border-soft py-1.5 pl-2.5 pr-2">
        <CommentTabs
          tab={tab}
          setTab={setTab}
          publicCount={publicCount}
          personalCount={personalCount}
        />
        {canComment && (
          <IconBtn title="New comment" testId="comment-new" onClick={onNewGeneral}>
            ＋
          </IconBtn>
        )}
        <IconBtn title="Close comments (c)" onClick={onHide}>
          ✕
        </IconBtn>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* Pinned margin — cards (and a new-comment composer) float beside their
            highlighted text, sharing one overlap-free layout. */}
        <PinnedZone
          pins={pinned}
          personal={tab === "personal"}
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
            <div className="text-3xl opacity-50">{tab === "personal" ? "🔒" : "💬"}</div>
            <div className="text-sm leading-relaxed text-muted-foreground">
              {tab === "personal" ? (
                <>
                  No personal notes yet.
                  <br />
                  Jot one for yourself, or leave instructions your agents will pick up.
                </>
              ) : (
                <>
                  No comments yet.
                  <br />
                  Select text in the document to start one.
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* General + resolved threads live in a scrollable footer drawer. */}
      {(generalComposer || general.length > 0 || resolved.length > 0) && (
        <div className="max-h-[44%] shrink-0 overflow-auto border-t border-border-soft p-2.5">
          {generalComposer && (
            <div className="mb-2.5">
              <Composer
                quote={null}
                personal={tab === "personal"}
                onSubmit={onSubmitNew}
                onCancel={onCancelNew}
              />
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
