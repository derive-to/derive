import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useParams } from "@tanstack/react-router"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { API_BASE, ApiError, api, type Comment } from "@/api"
import { CursorButton } from "@/components/cursor/cursor-button"
import { Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { artifactQuery, commentsQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { useIsMobile } from "@/lib/use-is-mobile"
import { cn } from "@/lib/utils"
import { artifactTypeLabel } from "../library/artifact-card"
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
import { PublicViewer } from "./public-viewer"
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

// The floating pill over the document (comments toggle / sign-in prompt) — one
// recipe on the Button primitive so both call sites can't drift apart.
function DocFab({
  title,
  testId,
  onClick,
  children,
}: {
  title: string
  testId: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      variant="outline"
      size="lg"
      title={title}
      data-testid={testId}
      onClick={onClick}
      // Floats over the white document, so the fill must stay opaque: the
      // outline variant's hover:bg-secondary is a ~4% wash meant to sit over a
      // surface, and over the iframe it would erase the pill. Composite the
      // neutral hover step into the opaque card instead (darkens in light,
      // lightens in dark — same ink direction as --secondary).
      className="absolute right-4.5 bottom-4.5 rounded-full bg-card tabular-nums shadow-[var(--shadow)] hover:bg-[color-mix(in_oklab,var(--card)_95%,var(--foreground))]"
    >
      <Icon name="comments" size={16} />
      {children}
    </Button>
  )
}

export function Artifact() {
  const { ref } = useParams({ from: "/artifacts/$ref" })
  const { shortId, version } = parseRef(ref)
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const isMobile = useIsMobile()

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
  // non-canonical ref (bare id, stale name, legacy order) to /artifacts/<name>-<shortId> so
  // the browser holds the readable URL. replace:true so Back doesn't bounce through
  // the old ref; preserves the @vN suffix and the current search.
  useEffect(() => {
    if (!art || art.removed) return
    const canonical = version
      ? `${refFor({ short_id: shortId, title: art.title })}@v${version}`
      : refFor({ short_id: shortId, title: art.title })
    if (ref !== canonical)
      nav({ to: "/artifacts/$ref", params: { ref: canonical }, search: (s) => s, replace: true })
  }, [art, ref, version, shortId, nav])

  // Comments UI state shared across the page, the panel, and the iframe bridge.
  const [composer, setComposer] = useState<{ anchor: Sel | null; top: number | null } | null>(null)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [hoverThread, setHoverThread] = useState<string | null>(null)
  // The open/hidden comments panel, with its persistence + `c`/Esc hotkeys.
  const { panel, setPanel } = useCommentsPanel(() => setComposer(null))
  // Which comment surface is showing: the public team thread, or your personal notes
  // (private to you + the agents you've authed). Two filtered views of one list. The
  // panel shows the active tab; the document highlights BOTH (shared lavender +
  // personal ink), and clicking a highlight switches to its tab.
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
      if (newTab) window.open(`/artifacts/${ref}`, "_blank", "noopener")
      else nav({ to: "/artifacts/$ref", params: { ref } })
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

  // Deep link: ?comment=<thread> opens the panel, activates that thread, and jumps to
  // its text. Runs once, after comments are in.
  const deepLinked = useRef(false)
  useEffect(() => {
    if (deepLinked.current || comments.length === 0) return
    deepLinked.current = true
    const cid = new URLSearchParams(window.location.search).get("comment")
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
      nav({
        to: "/artifacts/$ref",
        params: { ref: refFor({ short_id: shortId, title: art.title }) },
      }),
    setEditing,
    setSrc,
    setTitle: setEditTitle,
    setProposeMsg,
    setComposer,
    setSel,
    setActiveThread,
    setRestoring,
  })

  // Activating a thread from the panel: on a deck, first flip to the slide it
  // lives on so its highlight is visible, then open it.
  const activateThread = (id: string) => {
    goToCommentSlide(id)
    activate(id)
  }

  // On phones the comments live in a slide-up sheet, so the in-flow aside has
  // no width and the document gets the full screen.
  const asideWidth = isMobile ? 0 : panel === "open" ? 340 : 0

  // Anonymous visitor → the chrome-light public/viral viewer (the app shell has
  // dropped the rail). The render is the hero; a slim public header carries the
  // brand, the creator byline, presence, and the growth verbs. The comment/editor
  // chrome is absent — the API gates every write for anon anyway.
  if (isAnon)
    return (
      <PublicViewer
        art={art}
        returnTo={`/artifacts/${ref}`}
        viewers={live.viewers}
        isMobile={isMobile}
      >
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
              to: "/artifacts/$ref",
              params: { ref: refFor({ short_id: shortId, title: art.title }) },
            })
          }
          onDeckPrev={() => deckCmd("prev")}
          onDeckNext={() => deckCmd("next")}
          onFullscreen={toggleFullscreen}
        />
      </PublicViewer>
    )

  return (
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
                to: "/artifacts/$ref",
                params: { ref: n === art.current_version ? base : `${base}@v${n}` },
              })
            }}
            open
            onOpenChange={(o) => setSurface(o ? "history" : null)}
          />
        </Suspense>
      )}
      {/* data-artifact-view: while the workbench is mounted, globals.css drops the
          film-grain overlay so Derive's material steps back inside the author's document. */}
      <div data-artifact-view className="flex min-h-0 flex-1 flex-col">
        {/* The workbench bar — full-width now (sidebar-first shell), so the
              comments panel docks BELOW it instead of squeezing it into the
              remaining width. The page owns its toolbar: the artifact title (the
              Geist content register) on the left, presence/cursors + the header
              actions on the right. shrink-0 keeps the split row below it on the
              min-h-0 flex-1 height chain. */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 max-sm:flex-wrap max-sm:px-3">
          {/* Identity — a two-line document header, the reframe: the artifact title,
              then a machine-register state line (type · version · freshness). The
              bar's job is to say WHAT you're viewing and its state, not to be a run
              of icons — the actions collapse to the right. */}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h1
              className="truncate font-serif text-base font-medium leading-tight tracking-tight"
              title={art.title ?? shortId}
            >
              {art.title ?? shortId}
            </h1>
            <span className="truncate font-mono text-2xs tabular-nums text-muted-foreground">
              {artifactTypeLabel(art)} · v{art.current_version}
              {art.updated_at ? ` · updated ${ago(art.updated_at)}` : ""}
            </span>
          </div>
          {/* Collaboration — presence facepile + your cursor, one ambient cluster,
              held apart from the actions by spacing (no vertical rule). */}
          {!isMobile && (
            <div className="flex items-center gap-0.5">
              <Presence viewers={live.viewers} selfId={me?.id} />
              <CursorButton />
            </div>
          )}
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
              onToggleComments={() => setPanel((pn) => (pn === "open" ? "hidden" : "open"))}
            />
          )}
        </div>
        {/* The split row lives BELOW the full-width bar: the document stage on
                the left, the comments aside on the right, so the panel slides in
                under the toolbar rather than beside it. */}
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              // On phones, the comments sheet sits in the bottom half — reserve
              // that space so the document stays visible above it (and a
              // jumped-to highlight lands in view, not behind the sheet).
              "relative flex min-w-0 flex-1 flex-col transition-[padding] duration-200",
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
                    to: "/artifacts/$ref",
                    params: { ref: refFor({ short_id: shortId, title: art.title }) },
                  })
                }
                onDeckPrev={() => deckCmd("prev")}
                onDeckNext={() => deckCmd("next")}
                onFullscreen={toggleFullscreen}
              />
            )}
            {!isAnon && panel === "hidden" && (
              <DocFab
                title="Show comments (c)"
                testId="artifact-comments-fab"
                onClick={() => setPanel("open")}
              >
                {openCount > 0
                  ? `${openCount} comment${openCount === 1 ? "" : "s"}`
                  : "Show comments"}
              </DocFab>
            )}
            {/* Anonymous visitor on a comment-enabled link: commenting forces auth (anon
                stays view-only). Offer sign-in, returning here afterward. */}
            {promptSignInToComment && (
              <DocFab
                title="Sign in to comment"
                testId="sign-in-to-comment"
                onClick={() =>
                  nav({
                    to: "/login",
                    search: {
                      return_to: `/artifacts/${refFor({ short_id: shortId, title: art.title })}`,
                    },
                  })
                }
              >
                Sign in to comment
              </DocFab>
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
      </div>
    </ActionsCtx.Provider>
  )
}
