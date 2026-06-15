import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useParams } from "@tanstack/react-router"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { toast } from "sonner"
import { API_BASE, ApiError, api, type Comment } from "@/api"
import { useIsMobile } from "@/components"
import { CursorButton } from "@/components/cursor/cursor-button"
import { Icon } from "@/components/icons"
import { useTopBarSlot } from "@/components/shell-context"
import { useAuth } from "@/ctx"
import { artifactQuery, commentsQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { artifactActions } from "./artifact-actions"
import { ArtifactComments } from "./artifact-comments"
import { ArtifactDocument } from "./artifact-document"
import {
  ArtifactLoadError,
  ArtifactLoading,
  ArtifactNotFound,
  ArtifactRemoved,
} from "./artifact-states"
import { ArtifactTopBar } from "./artifact-top-bar"
import { ActionsCtx } from "./comment-actions"
import { groupThreads, parseAnchor } from "./lib/layout"
import { parseRef } from "./parse-ref"
import { PasswordGate } from "./password-gate"
import { Presence } from "./rail-deck"
import { SourceEditor } from "./source-editor"
import type { PinItem, Sel } from "./types"
import { useArtifactFrame } from "./use-artifact-frame"
import { useArtifactLive } from "./use-artifact-live"
import { useCommentsPanel } from "./use-comments-panel"
import { useVersionDiff } from "./use-version-diff"

// Heavy on-demand surfaces — split out of the artifact route's initial chunk and
// loaded only when the user opens them (review proposals / insights / history).
const ReviewOverlay = lazy(() =>
  import("@/components/review").then((m) => ({ default: m.ReviewOverlay })),
)
const Insights = lazy(() => import("./insights-history").then((m) => ({ default: m.Insights })))
const HistoryDrawer = lazy(() =>
  import("./insights-history").then((m) => ({ default: m.HistoryDrawer })),
)

export function Artifact() {
  const { ref } = useParams({ from: "/a/$ref" })
  const { shortId, version } = parseRef(ref)
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const isMobile = useIsMobile()
  // The persistent shell exposes its top-bar region; this page's header actions
  // are portaled into it (the shell is mounted once, above the route Outlet).
  // Its own context, so the artifact page doesn't re-render on shell-state churn.
  const topBarSlot = useTopBarSlot()

  // Artifact metadata + comments come from React Query, so the route loader's
  // intent preload (ensureQueryData) warms exactly what we render here — the
  // click that follows a hover reads straight from cache. Optimistic edits and
  // the SSE live updates below write through the same client.
  const qc = useQueryClient()
  const { data: art, isError: failed, error, refetch } = useQuery(artifactQuery(shortId))
  const { data: comments = [] } = useQuery(commentsQuery(shortId))
  // A password artifact returns 401 until the visitor unlocks it — show the
  // password prompt rather than the not-found state or a bounce to login.
  const locked = failed && error instanceof ApiError && error.status === 401
  const [editing, setEditing] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  // Which "⋯ More" surface is open (large dialog / drawer).
  const [surface, setSurface] = useState<null | "insights" | "history">(null)
  const [proposeMsg, setProposeMsg] = useState("")
  const [message, setMessage] = useState("")
  const [restoring, setRestoring] = useState(false)
  const [src, setSrc] = useState("")
  // Editable title while editing (seeded from the artifact in startEdit); editors
  // can rename, and it republishes with the new name.
  const [editTitle, setEditTitle] = useState("")

  // Comments UI state shared across the page, the panel, and the iframe bridge.
  const [composer, setComposer] = useState<{ anchor: Sel | null; top: number | null } | null>(null)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [hoverThread, setHoverThread] = useState<string | null>(null)
  // The open/rail/hidden comments panel, with its persistence + `c`/Esc hotkeys.
  const { panel, setPanel } = useCommentsPanel(() => setComposer(null))

  // Server-truth refetch after a write or an SSE ping (defined up here so the
  // realtime hook + the iframe message bridge below can both lean on them).
  const load = useCallback(() => {
    qc.invalidateQueries({ queryKey: artifactQuery(shortId).queryKey })
    qc.invalidateQueries({ queryKey: commentsQuery(shortId).queryKey })
  }, [qc, shortId])
  const refetchComments = useCallback(() => {
    qc.invalidateQueries({ queryKey: commentsQuery(shortId).queryKey })
  }, [qc, shortId])

  // Presence, live multiplayer cursors, the SSE stream, and view recording — see
  // use-artifact-live. The page feeds pointer moves in (from the iframe bridge
  // below) and reads `viewers` + the `cursorLayer` overlay ref back out.
  const live = useArtifactLive({ shortId, onComment: refetchComments, onVersion: load })

  // The whole postMessage channel with the sandboxed iframe: text selection,
  // anchor geometry, scroll, deck position, and peer cursors in; highlight
  // anchors + deck/emphasis commands out. See use-artifact-frame.
  const {
    frame,
    presentWrap,
    onFrameLoad,
    post,
    scrollBy,
    deck,
    deckCmd,
    toggleFullscreen,
    sel,
    setSel,
    inDoc,
    anchorTops,
    scrollY,
    docH,
    viewH,
  } = useArtifactFrame({
    comments,
    shortId,
    version,
    hoverThread,
    onPointerMove: live.onPointerMove,
    onPointerLeave: live.onPointerLeave,
    onTap: live.onTap,
    setHoverThread,
    setActiveThread,
    setPanel,
  })

  // Preview vs. line-diff for the shown version, plus the fetched diff. See
  // use-version-diff.
  const { view, setView, diff } = useVersionDiff(art, shortId, version)

  // Feed our live iframe geometry to the cursor layer, so peers render at their
  // document position (mapped against our scroll) and scrolled-off peers collapse
  // into the top/bottom edge indicators.
  useEffect(() => {
    live.setGeom({ scrollY, docH, viewH })
  }, [live.setGeom, scrollY, docH, viewH])

  // biome-ignore lint/correctness/useExhaustiveDependencies: clears the active thread + composer when the artifact/version changes (the iframe bridge clears its own selection).
  useEffect(() => {
    setActiveThread(null)
    setComposer(null)
  }, [shortId, version])

  // Clicking a thread's quote scrolls the document to its highlight. On phones the
  // bottom ~half is covered by the comments sheet, so bias the scroll to drop the
  // highlight into the upper band rather than dead-center (behind the sheet).
  const jumpTo = (threadId: string) => {
    setActiveThread(threadId)
    post({ type: "focus-anchor", id: threadId, bias: isMobile ? 0.28 : undefined })
  }

  useEffect(() => {
    // Anonymous can view a public artifact (read-only, with a sign-up CTA). Bounce
    // to login ONLY when the artifact is genuinely gated (404/403) for a logged-out
    // visitor — then an account is required. A TRANSIENT failure (5xx/network) also
    // nulls `me` (the session check failed too), but must NOT eject the user to
    // login mid-outage — the recoverable error state below handles that, so the
    // page comes back cleanly once the server does.
    const gated = error instanceof ApiError && (error.status === 404 || error.status === 403)
    if (!loading && !me && failed && !locked && gated) nav({ to: "/login" })
  }, [loading, me, failed, locked, error, nav])

  // Deep link: ?c=<thread> opens the panel, activates that thread, and jumps to
  // its text. Runs once, after comments are in.
  const deepLinked = useRef(false)
  useEffect(() => {
    if (deepLinked.current || comments.length === 0) return
    deepLinked.current = true
    const cid = new URLSearchParams(window.location.search).get("c")
    if (cid && comments.some((c) => c.thread_id === cid)) {
      setPanel("open")
      setActiveThread(cid)
      setTimeout(() => post({ type: "focus-anchor", id: cid }), 320)
    }
  }, [comments, post, setPanel])

  if (locked) return <PasswordGate shortId={shortId} onUnlocked={() => refetch()} />
  if (failed) {
    // A genuine 404/403 is "not found / no access". Anything else (a 5xx, a
    // network blip, the server briefly unhealthy) is transient — the query already
    // auto-retried with backoff, so offer a clean "Try again" rather than a
    // dead-end. This is what made the outage look like a permanent failure.
    const status = error instanceof ApiError ? error.status : undefined
    return status === 404 || status === 403 ? (
      <ArtifactNotFound onBack={() => nav({ to: "/" })} />
    ) : (
      <ArtifactLoadError onRetry={() => refetch()} onBack={() => nav({ to: "/" })} />
    )
  }
  if (!art) return <ArtifactLoading />
  // Removed artifacts show a tombstone instead of the document — content is gone
  // (the server 410s the raw routes), but an owner can still reinstate.
  if (art.removed)
    return (
      <ArtifactRemoved
        canReinstate={art.my_role === "owner"}
        onReinstate={async () => {
          try {
            await api.reinstate(shortId)
            toast.success("Reinstated")
            load()
          } catch (e) {
            toast.error((e as Error).message)
          }
        }}
        onBack={() => nav({ to: "/" })}
      />
    )

  const shown = version ?? art.current_version
  const editable = art.kind === "file" && shown === art.current_version
  const rawSrc = `${API_BASE}/raw/${shortId}/v/${shown}/index.html`
  // Editors publish directly; commenters propose a candidate for review.
  const canPublish = art.my_role === "editor" || art.my_role === "owner"
  // md vs html drives syntax highlighting + how the live preview renders.
  const format: "md" | "html" =
    art.versions.find((v) => v.n === art.current_version)?.content_type === "text/markdown"
      ? "md"
      : "html"
  const canPropose = canPublish || art.my_role === "commenter"
  // A logged-out visitor on a public/link artifact: strictly view-only. They get
  // the document + live presence/cursors (Google-Docs style) and nothing else —
  // no favorite, tags, collections, share, report, comments, or version tools.
  // The API gates every one of those for anon (anonLocked); hiding them here keeps
  // the chrome honest so there's no dead/forbidden affordance to bump into.
  const isAnon = !me

  // Sort threads into pinned (anchored & present in this live doc), general
  // (unanchored or orphaned), and resolved. Pins drive both the margin cards
  // and the collapsed rail dots.
  const docLive = !editing && view === "preview"
  const all = groupThreads(comments)
  const openThreads = all.filter((t) => t[0]?.state === "open")
  const resolvedThreads = all.filter((t) => t[0]?.state === "resolved")
  const pinned: PinItem[] = []
  const general: Comment[][] = []
  for (const t of openThreads) {
    const head = t[0]
    if (!head) continue
    const id = head.thread_id
    const hasAnchor = !!parseAnchor(head.anchor)
    const present = inDoc[id] !== false
    if (docLive && hasAnchor && present) {
      const top = anchorTops[id]
      pinned.push({ thread: t, desiredY: top != null ? top - scrollY : 0, located: top != null })
    } else {
      general.push(t)
    }
  }
  const openCount = openThreads.length

  const {
    startEdit,
    publishEdit,
    proposeEdit,
    reply,
    submitNew,
    toggleResolve,
    activate,
    startSelComment,
    actions,
    restore,
  } = artifactActions({
    shortId,
    art,
    qc,
    me,
    src,
    title: editTitle,
    proposeMsg,
    message,
    format,
    composer,
    sel,
    post,
    load,
    refetchComments,
    onRestoredJump: () => nav({ to: "/a/$ref", params: { ref: shortId } }),
    setEditing,
    setSrc,
    setTitle: setEditTitle,
    setProposeMsg,
    setComposer,
    setSel,
    setActiveThread,
    setRestoring,
  })

  // On phones the comments live in a slide-up sheet, so the in-flow aside has
  // no width and the document gets the full screen.
  const asideWidth = isMobile ? 0 : panel === "open" ? 340 : panel === "rail" ? 50 : 0

  return (
    <>
      {topBarSlot &&
        createPortal(
          <>
            {!isMobile && <Presence viewers={live.viewers} selfId={me?.id} />}
            {!isMobile && <CursorButton />}
            {!isAnon && (
              <ArtifactTopBar
                shortId={shortId}
                myRole={art.my_role}
                visibility={art.visibility}
                favorite={!!art.favorite}
                tags={art.tags ?? []}
                collections={art.collections ?? []}
                canEditTags={art.my_role === "editor" || art.my_role === "owner"}
                openProposals={art.open_proposals ?? 0}
                proposalsTotal={art.proposals_total ?? 0}
                isMobile={isMobile}
                panelOpen={panel === "open"}
                openCount={openCount}
                showEdit={editable && canPropose && !editing && !art.managed}
                editLabel={canPublish ? "Edit source (dev)" : "Propose change (dev)"}
                onFavorite={(fav) =>
                  qc.setQueryData(artifactQuery(shortId).queryKey, (a) =>
                    a ? { ...a, favorite: fav } : a,
                  )
                }
                onTags={(tags) =>
                  qc.setQueryData(artifactQuery(shortId).queryKey, (a) => (a ? { ...a, tags } : a))
                }
                onCollections={(collections) =>
                  qc.setQueryData(artifactQuery(shortId).queryKey, (a) =>
                    a ? { ...a, collections } : a,
                  )
                }
                onInsights={() => setSurface("insights")}
                onHistory={() => setSurface("history")}
                onReview={() => setReviewing(true)}
                onStartEdit={startEdit}
                onShowComments={() => setPanel("open")}
              />
            )}
          </>,
          topBarSlot,
        )}
      <ActionsCtx.Provider value={actions}>
        {reviewing && (
          <Suspense fallback={null}>
            <ReviewOverlay
              shortId={shortId}
              currentVersion={art.current_version}
              myRole={art.my_role}
              meName={me?.name ?? me?.email ?? null}
              onClose={() => setReviewing(false)}
              onApplied={load}
            />
          </Suspense>
        )}
        {surface === "insights" && (
          <Suspense fallback={null}>
            <Insights
              shortId={shortId}
              title={art.title}
              open
              onOpenChange={(o) => setSurface(o ? "insights" : null)}
            />
          </Suspense>
        )}
        {surface === "history" && (
          <Suspense fallback={null}>
            <HistoryDrawer
              art={art}
              shown={shown}
              goTo={(n) =>
                nav({
                  to: "/a/$ref",
                  params: { ref: n === art.current_version ? shortId : `${shortId}@v${n}` },
                })
              }
              open
              onOpenChange={(o) => setSurface(o ? "history" : null)}
            />
          </Suspense>
        )}
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              // On phones, the comments sheet sits in the bottom half — reserve
              // that space so the document stays visible above it (and a
              // jumped-to highlight lands in view, not behind the sheet).
              "relative flex min-w-0 flex-1 flex-col transition-[padding] duration-[260ms]",
              isMobile && panel === "open" && "pb-[50vh]",
            )}
          >
            {editing ? (
              <SourceEditor
                canPublish={canPublish}
                title={canPublish ? editTitle : (art.title ?? shortId)}
                onTitle={canPublish ? setEditTitle : undefined}
                format={format}
                proposeMsg={proposeMsg}
                message={message}
                src={src}
                onProposeMsg={setProposeMsg}
                onMessage={setMessage}
                onSrc={setSrc}
                onCancel={() => setEditing(false)}
                onPublish={publishEdit}
                onPropose={proposeEdit}
              />
            ) : (
              <ArtifactDocument
                shown={shown}
                currentVersion={art.current_version}
                title={art.title ?? shortId}
                rawSrc={rawSrc}
                view={view}
                diff={diff}
                restoring={restoring}
                deck={deck}
                frameRef={frame}
                presentWrapRef={presentWrap}
                cursor={live.cursor}
                onScrollDoc={scrollBy}
                onFrameLoad={onFrameLoad}
                onToggleDiff={() => setView(view === "diff" ? "preview" : "diff")}
                onRestore={() => restore(shown)}
                onBackToCurrent={() => nav({ to: "/a/$ref", params: { ref: shortId } })}
                onDeckPrev={() => deckCmd("prev")}
                onDeckNext={() => deckCmd("next")}
                onFullscreen={toggleFullscreen}
              />
            )}
            {!isAnon && panel === "hidden" && (
              <button
                type="button"
                onClick={() => setPanel("open")}
                title="Show comments (c)"
                data-testid="artifact-comments-fab"
                className="absolute bottom-[18px] right-[18px] flex h-11 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground shadow-[var(--shadow)]"
              >
                <Icon name="comments" size={18} />
                {openCount > 0
                  ? `${openCount} comment${openCount === 1 ? "" : "s"}`
                  : "Show comments"}
              </button>
            )}
          </div>

          <ArtifactComments
            shortId={shortId}
            isMobile={isMobile}
            isAnon={isAnon}
            docLive={docLive}
            panel={panel}
            asideWidth={asideWidth}
            openCount={openCount}
            scrollY={scrollY}
            onScrollDoc={scrollBy}
            pinned={pinned}
            general={general}
            resolved={resolvedThreads}
            openThreads={openThreads}
            activeThread={activeThread}
            hoverThread={hoverThread}
            inDoc={inDoc}
            composer={composer}
            sel={sel}
            setPanel={setPanel}
            setComposer={setComposer}
            setSel={setSel}
            setActiveThread={setActiveThread}
            setHoverThread={setHoverThread}
            activate={activate}
            toggleResolve={toggleResolve}
            reply={reply}
            submitNew={submitNew}
            jumpTo={jumpTo}
            startSelComment={startSelComment}
          />
        </div>
      </ActionsCtx.Provider>
    </>
  )
}
