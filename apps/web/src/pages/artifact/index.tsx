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
import { BundleBar } from "./bundle-bar"
import { ActionsCtx } from "./comment-actions"
import { canCommentWithRole, shouldPromptSignInToComment } from "./lib/comment-access"
import { groupThreads, parseAnchor } from "./lib/layout"
import { parseRef, refFor } from "./parse-ref"
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
  const [reader, setReader] = useState(false)
  const [src, setSrc] = useState("")
  // Editable title while editing (seeded from the artifact in startEdit); editors
  // can rename, and it republishes with the new name.
  const [editTitle, setEditTitle] = useState("")

  // Canonicalise the URL client-side: once the artifact is loaded, rewrite any
  // non-canonical ref (bare id, stale name, legacy order) to /a/<name>-<shortId> so
  // the browser holds the readable URL. replace:true so Back doesn't bounce through
  // the old ref; preserves the @vN suffix and the current search.
  useEffect(() => {
    if (!art || art.removed) return
    const canonical = version
      ? `${refFor({ short_id: shortId, title: art.title })}@v${version}`
      : refFor({ short_id: shortId, title: art.title })
    if (ref !== canonical)
      nav({ to: "/a/$ref", params: { ref: canonical }, search: (s) => s, replace: true })
  }, [art, ref, version, shortId, nav])

  // Comments UI state shared across the page, the panel, and the iframe bridge.
  const [composer, setComposer] = useState<{ anchor: Sel | null; top: number | null } | null>(null)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [hoverThread, setHoverThread] = useState<string | null>(null)
  // The open/rail/hidden comments panel, with its persistence + `c`/Esc hotkeys.
  const { panel, setPanel } = useCommentsPanel(() => setComposer(null))
  // Which comment surface is showing: the public team thread, or your personal notes
  // (private to you + the agents you've authed). Two filtered views of one list. The
  // panel shows the active tab; the document highlights BOTH (shared lavender +
  // personal amber), and clicking a highlight switches to its tab.
  const [commentTab, setCommentTab] = useState<"comments" | "personal">("comments")
  const personalComments = comments.filter((c) => c.visibility === "personal")
  const publicComments = comments.filter((c) => c.visibility !== "personal")
  const activeComments = commentTab === "personal" ? personalComments : publicComments
  // Stable so the iframe message listener subscribes once (it lives in onAnchorTab's deps).
  const onAnchorTab = useCallback(
    (personal: boolean) => setCommentTab(personal ? "personal" : "comments"),
    [],
  )

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
    landedSlides,
    anchorConf,
    anchorTops,
    scrollY,
    docH,
    viewH,
  } = useArtifactFrame({
    // Paint BOTH the shared and your personal anchors in the doc (the server already
    // limits personal ones to you), color-differentiated; a click jumps to the right
    // tab. The panel itself stays scoped to the active tab.
    comments,
    onAnchorTab,
    shortId,
    version,
    hoverThread,
    onPointerMove: live.onPointerMove,
    onPointerLeave: live.onPointerLeave,
    onTap: live.onTap,
    setHoverThread,
    setActiveThread,
    setPanel,
    onNavigate: (ref, newTab) => {
      // Same-origin SPA route. A modified/middle click opens it un-sandboxed in a new
      // tab (the frame's own new tab would inherit the sandbox and break the app).
      if (newTab) window.open(`/a/${ref}`, "_blank", "noopener")
      else nav({ to: "/a/$ref", params: { ref } })
    },
  })

  // Preview vs. line-diff for the shown version, plus the fetched diff. See
  // use-version-diff.
  const {
    view,
    setView,
    diff,
    failed: diffFailed,
    retry: retryDiff,
  } = useVersionDiff(art, shortId, version)

  // Feed our live iframe geometry to the cursor layer, so peers render at their
  // document position (mapped against our scroll) and scrolled-off peers collapse
  // into the top/bottom edge indicators.
  useEffect(() => {
    live.setGeom({ scrollY, docH, viewH })
  }, [live.setGeom, scrollY, docH, viewH])

  // Tell the cursor layer which slide we're viewing, so peers on other slides are
  // hidden. null on a plain document → everyone shows (no filtering).
  useEffect(() => {
    live.setViewSlide(deck?.i ?? null)
  }, [live.setViewSlide, deck?.i])

  // biome-ignore lint/correctness/useExhaustiveDependencies: clears the active thread + composer when the artifact/version changes (the iframe bridge clears its own selection).
  useEffect(() => {
    setActiveThread(null)
    setComposer(null)
  }, [shortId, version])

  // Navigate the deck to the slide a comment lives on: its resolved slide, falling
  // back to the slide it was made on. No-op off a deck or already on that slide.
  const goToCommentSlide = (threadId: string) => {
    if (!deck) return
    const a = parseAnchor(comments.find((c) => c.thread_id === threadId)?.anchor ?? null)
    const landed = landedSlides[threadId]
    const target = landed != null ? landed : a?.slide
    if (target != null && target !== deck.i) deckCmd("goto", target)
  }

  // Clicking a thread's quote scrolls the document to its highlight (on a deck, first
  // flips to its slide). On phones the bottom ~half is covered by the comments sheet,
  // so bias the scroll to drop the highlight into the upper band (not behind it).
  const jumpTo = (threadId: string) => {
    goToCommentSlide(threadId)
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
    const target = cid ? comments.find((c) => c.thread_id === cid) : undefined
    if (target) {
      // Open the tab the thread lives on, or its anchor won't be live in the doc.
      setCommentTab(target.visibility === "personal" ? "personal" : "comments")
      setPanel("open")
      setActiveThread(target.thread_id)
      setTimeout(() => post({ type: "focus-anchor", id: target.thread_id }), 320)
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
  // Reader view re-renders a non-responsive HTML artifact clean + mobile-friendly
  // (server applies it on `?reader=1`). Off by default; the top-bar toggle flips it.
  const rawSrc = `${API_BASE}/raw/${shortId}/v/${shown}/index.html${reader ? "?reader=1" : ""}`
  // Editors publish directly; commenters propose a candidate for review.
  const canPublish = art.my_role === "editor" || art.my_role === "owner"
  // md vs html drives syntax highlighting + how the live preview renders.
  const format: "md" | "html" =
    art.versions.find((v) => v.n === art.current_version)?.content_type === "text/markdown"
      ? "md"
      : "html"
  const canPropose = canPublish || art.my_role === "commenter"
  // Lock: any editor can toggle it (advanced menu). While locked, even an editor
  // must propose — `effectiveCanPublish` flips the edit flow to the propose path.
  const canLock = canPublish
  const isLocked = !!art.locked
  const effectiveCanPublish = canPublish && !isLocked
  // A logged-out visitor on a public/link artifact: strictly view-only. They get
  // the document + live presence/cursors (Google-Docs style) and nothing else —
  // no favorite, tags, collections, share, report, comments, or version tools.
  // The API gates every one of those for anon (anonLocked); hiding them here keeps
  // the chrome honest so there's no dead/forbidden affordance to bump into.
  const isAnon = !me
  // Commenting needs commenter+ (matches the API's `comment` gate). A signed-in viewer
  // reading via a view-only link sees comments but gets no write affordance. An
  // anonymous visitor never qualifies — on a comment-enabled link they get a "sign in
  // to comment" prompt instead (auth is the gate; see the access matrix).
  const canComment = canCommentWithRole(art.my_role)
  const promptSignInToComment = shouldPromptSignInToComment(isAnon, art.general_role, !!art.removed)

  // Sort threads into pinned (anchored & present in this live doc), general
  // (unanchored or orphaned), and resolved. Pins drive both the margin cards
  // and the collapsed rail dots.
  const docLive = !editing && view === "preview"
  // Per-tab open-thread counts for the tab badges (the split itself + the active
  // set are computed up top, before the iframe hook, so the doc can scope to it).
  const openCountOf = (cs: Comment[]) =>
    groupThreads(cs).filter((t) => t[0] && t[0].state !== "resolved").length
  const personalCount = openCountOf(personalComments)
  const publicCount = openCountOf(publicComments)
  const all = groupThreads(activeComments)
  // `outdated` threads (their quoted text changed in a later version) stay in the
  // active list, not the resolved drawer — their anchor no longer resolves, so
  // they fall into the general/orphaned bucket below and stay visible to triage.
  const openThreads = all.filter((t) => t[0] && t[0].state !== "resolved")
  const resolvedThreads = all.filter((t) => t[0]?.state === "resolved")
  const pinned: PinItem[] = []
  const general: Comment[][] = []
  const pinHere = (t: Comment[], id: string) => {
    const top = anchorTops[id]
    pinned.push({ thread: t, desiredY: top != null ? top - scrollY : 0, located: top != null })
  }
  for (const t of openThreads) {
    const head = t[0]
    if (!head) continue
    const id = head.thread_id
    const a = parseAnchor(head.anchor)
    // Does this thread's anchor resolve in the live doc? The frame reports `inDoc`
    // for the anchors it was sent (open/addressed). An `outdated` thread is NOT sent
    // to the frame, so `inDoc[id]` is undefined — fall back to the server's `anchored`
    // flag rather than defaulting to "present" (which would pin it invisibly at
    // opacity 0 instead of showing it as an orphan in the general list).
    const present = id in inDoc ? inDoc[id] !== false : head.anchored !== false
    if (deck && a) {
      // Deck: a comment belongs to the slide its text actually resolved on (landed),
      // or, until that's known, the slide it was made on (recorded). Pin it only on
      // that slide; otherwise it waits in the drawer with a "Slide N" badge.
      const landed = landedSlides[id]
      const effSlide = landed != null ? landed : a.slide
      if (effSlide != null && effSlide !== deck.i) general.push(t)
      else if (docLive && present) pinHere(t, id)
      else general.push(t)
    } else if (docLive && a && present) {
      pinHere(t, id)
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
    tab: commentTab,
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
    onRestoredJump: () =>
      nav({ to: "/a/$ref", params: { ref: refFor({ short_id: shortId, title: art.title }) } }),
    setEditing,
    setSrc,
    setTitle: setEditTitle,
    setProposeMsg,
    setComposer,
    setSel,
    setActiveThread,
    setRestoring,
  })

  // Activating a thread from the panel/rail: on a deck, first flip to the slide it
  // lives on so its highlight is visible, then open it.
  const activateThread = (id: string) => {
    goToCommentSlide(id)
    activate(id)
  }

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
                generalRole={art.general_role}
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
                editLabel={effectiveCanPublish ? "Edit source (dev)" : "Propose change (dev)"}
                isDeck={!!deck || art.current_content_type === "text/x-derive-deck"}
                // Reader only helps non-responsive HTML — not markdown (already responsive)
                // or decks (slides). Hidden while viewing a diff.
                showReader={
                  format === "html" &&
                  !deck &&
                  art.current_content_type !== "text/x-derive-deck" &&
                  view !== "diff"
                }
                reader={reader}
                onReaderToggle={() => setReader((r) => !r)}
                canLock={canLock}
                locked={isLocked}
                onPresent={toggleFullscreen}
                onLockToggle={async () => {
                  const next = !isLocked
                  // Optimistic flip; roll back if the server rejects.
                  qc.setQueryData(artifactQuery(shortId).queryKey, (a) =>
                    a ? { ...a, locked: next } : a,
                  )
                  try {
                    await api.setLocked(shortId, next)
                  } catch (e) {
                    qc.setQueryData(artifactQuery(shortId).queryKey, (a) =>
                      a ? { ...a, locked: !next } : a,
                    )
                    toast.error((e as Error).message)
                  }
                }}
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
              goTo={(n) => {
                const base = refFor({ short_id: shortId, title: art.title })
                nav({
                  to: "/a/$ref",
                  params: { ref: n === art.current_version ? base : `${base}@v${n}` },
                })
              }}
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
            {art.bundle && !editing && (
              <BundleBar bundle={art.bundle} shortId={shortId} version={shown} />
            )}
            {editing ? (
              <SourceEditor
                canPublish={effectiveCanPublish}
                title={effectiveCanPublish ? editTitle : (art.title ?? shortId)}
                onTitle={effectiveCanPublish ? setEditTitle : undefined}
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
                diffFailed={diffFailed}
                onDiffRetry={retryDiff}
                restoring={restoring}
                deck={deck}
                frameRef={frame}
                presentWrapRef={presentWrap}
                cursor={live.cursor}
                onScrollDoc={scrollBy}
                onFrameLoad={onFrameLoad}
                onToggleDiff={() => setView(view === "diff" ? "preview" : "diff")}
                onRestore={() => restore(shown)}
                onBackToCurrent={() =>
                  nav({
                    to: "/a/$ref",
                    params: { ref: refFor({ short_id: shortId, title: art.title }) },
                  })
                }
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
            {/* Anonymous visitor on a comment-enabled link: commenting forces auth (anon
                stays view-only). Offer sign-in, returning here afterward. */}
            {promptSignInToComment && (
              <button
                type="button"
                onClick={() =>
                  nav({
                    to: "/login",
                    search: { return_to: `/a/${refFor({ short_id: shortId, title: art.title })}` },
                  })
                }
                title="Sign in to comment"
                data-testid="sign-in-to-comment"
                className="absolute bottom-[18px] right-[18px] flex h-11 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground shadow-[var(--shadow)]"
              >
                <Icon name="comments" size={18} />
                Sign in to comment
              </button>
            )}
          </div>

          <ArtifactComments
            shortId={shortId}
            isMobile={isMobile}
            isAnon={isAnon}
            canComment={canComment}
            docLive={docLive}
            panel={panel}
            tab={commentTab}
            setTab={setCommentTab}
            personalCount={personalCount}
            publicCount={publicCount}
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
            activate={activateThread}
            toggleResolve={toggleResolve}
            reply={reply}
            submitNew={submitNew}
            jumpTo={jumpTo}
            startSelComment={startSelComment}
            currentSlide={deck?.i ?? null}
            landedSlides={landedSlides}
            anchorConf={anchorConf}
          />
        </div>
      </ActionsCtx.Provider>
    </>
  )
}
