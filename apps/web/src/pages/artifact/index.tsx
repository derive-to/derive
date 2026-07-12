import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useParams } from "@tanstack/react-router"
import { Minimize2 } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { API_BASE, ApiError, api } from "@/api"
import { useShell } from "@/components/chrome/shell-context"
import { Icon } from "@/components/icons"
import { Kbd } from "@/components/ui/kbd"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { artifactTypeLabel } from "@/lib/artifact"
import { artifactAgentsQuery, artifactQuery, commentsQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { useIsMobile } from "@/lib/use-is-mobile"
import { cn } from "@/lib/utils"
import { useArtifactActions } from "./artifact-actions"
import { ArtifactComments } from "./artifact-comments"
import { ArtifactDocument } from "./artifact-document"
import { ArtifactLoadError, ArtifactNotFound, ArtifactRemoved } from "./artifact-states"
import { ArtifactTopBar } from "./artifact-top-bar"
import { BundleBar } from "./bundle-bar"
import { ActionsCtx } from "./comment-actions"
import { CursorButton } from "./cursors/cursor-button"
import { FloatingControl } from "./floating-control"
import { canCommentWithRole, shouldPromptSignInToComment } from "./lib/comment-access"
import { bucketThreads } from "./lib/layout"
import { parseRef, refFor } from "./parse-ref"
import { PasswordGate } from "./password-gate"
import { PublicViewer } from "./public-viewer"
import { Presence } from "./rail-deck"
import { ReviewCard } from "./review-card"
import { SourceEditor } from "./source-editor"
import { type ComposerState, parseAnchor } from "./types"
import { useArtifactFrame } from "./use-artifact-frame"
import { useArtifactLive } from "./use-artifact-live"
import { useArtifactRoute } from "./use-artifact-route"
import { useCommentsPanel } from "./use-comments-panel"
import { useVersionDiff } from "./use-version-diff"
import { WorkbenchSkeleton } from "./workbench-skeleton"

// Heavy on-demand surfaces — split out of the artifact route's initial chunk and
// loaded only when the user opens them (review proposals / insights / history).
const ReviewOverlay = lazy(() => import("./review").then((m) => ({ default: m.ReviewOverlay })))
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
    <FloatingControl
      size="lg"
      title={title}
      data-testid={testId}
      onClick={onClick}
      className="absolute right-4.5 bottom-4.5 tabular-nums"
    >
      <Icon name="comments" size={16} />
      {children}
    </FloatingControl>
  )
}

// Focus mode is immersive: the shell unmounts the nav rail (and mobile top bar)
// entirely and the inset mat drops, so the render runs edge-to-edge — not the old
// icon-strip collapse that left a 3rem rail beside "focus". The rail is the
// shell's, not the page's, so this authed-only helper drives it through the shell
// context; the cleanup restores the chrome if the page unmounts mid-focus, and the
// rail's own open/collapsed preference is never touched.
function FocusShellSync({ focus }: { focus: boolean }) {
  const { setImmersive } = useShell()
  useEffect(() => {
    setImmersive(focus)
    return () => setImmersive(false)
  }, [focus, setImmersive])
  return null
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
  // The tab is named after the document, like the workbench header (title, else id).
  useDocumentTitle(art ? (art.title ?? shortId) : null)
  const { data: comments = [] } = useQuery(commentsQuery(shortId))
  // Agents this viewer can hand a revision to (the "ask an agent" flow). Empty for
  // an anon viewer (the query is authed) or a workspace with no agents — then the
  // affordance simply doesn't appear.
  const { data: agents = [] } = useQuery({ ...artifactAgentsQuery(shortId), enabled: !!me })
  // A password artifact returns 401 until the visitor unlocks it — show the
  // password prompt rather than the not-found state or a bounce to login.
  const locked = failed && error instanceof ApiError && error.status === 401
  const [editing, setEditing] = useState(false)
  // Focus/hero mode — strip the workbench chrome to just the matted render (Esc exits).
  const [focus, setFocus] = useState(false)
  useEffect(() => {
    if (!focus) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocus(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [focus])
  const [reviewing, setReviewing] = useState(false)
  // Which "⋯ More" surface is open (large dialog / drawer).
  const [surface, setSurface] = useState<null | "insights" | "history">(null)
  const [proposeMsg, setProposeMsg] = useState("")
  const [message, setMessage] = useState("")
  const [reader, setReader] = useState(false)
  const [src, setSrc] = useState("")
  // See the `rawSrc` construction below: pins the raw-content token per (shortId,
  // version) so a metadata refetch doesn't force the preview iframe to reload.
  const pinnedRawToken = useRef<{ shortId: string; version: number; token: string } | null>(null)
  // Phones: px the comment sheet occupies at the bottom, reported by MobileComments.
  // The document column reserves exactly this so nothing black is left beneath it.
  const [sheetInset, setSheetInset] = useState(0)
  // Editable title while editing (seeded from the artifact in startEdit); editors
  // can rename, and it republishes with the new name.
  const [editTitle, setEditTitle] = useState("")

  // Comments UI state shared across the page, the panel, and the iframe bridge.
  const [composer, setComposer] = useState<ComposerState>(null)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [hoverThread, setHoverThread] = useState<string | null>(null)
  // The open/hidden comments panel, with its persistence + `c`/Esc hotkeys.
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

  // Round churn (requested / sent back / approved) bumps a tick the review card
  // refetches on — an agent's re-request appears live, never behind a reload.
  const [reviewTick, setReviewTick] = useState(0)
  const onReview = useCallback(() => setReviewTick((t) => t + 1), [])

  // A version published while we're LOOKING refetches (the unpinned render swaps
  // in place) and gets a cue, so the repaint reads as an update, not a glitch:
  // a quiet toast normally, a WARNING while editing (this edit started from the
  // old version — publishing it replaces the newer one). Pinned views (@vN) get
  // neither: their version bar already carries "you're on an old version", and the
  // refetch keeps it truthful. Read through refs so the SSE stream doesn't
  // resubscribe every time the user opens the editor.
  const editingRef = useRef(editing)
  editingRef.current = editing
  const pinnedRef = useRef(version)
  pinnedRef.current = version
  const onVersionLive = useCallback(
    (n?: number) => {
      load()
      if (pinnedRef.current !== undefined) return
      const v = n !== undefined ? `v${n}` : "A new version"
      if (editingRef.current) {
        toast.warning(`${v} was just published — publishing this edit will replace it.`, {
          id: `stale-edit-${shortId}`,
          duration: 8000,
        })
      } else {
        toast(`Updated to ${v === "A new version" ? "the newest version" : v}.`, {
          id: `live-version-${shortId}`,
        })
      }
    },
    [load, shortId],
  )

  // Presence, live multiplayer cursors, the SSE stream, and view recording — see
  // use-artifact-live. The page feeds pointer moves in (from the iframe bridge
  // below) and reads `viewers` + the `cursorLayer` overlay ref back out.
  // onResync closes coverage gaps (hidden tab return, SSE reconnect) silently.
  const live = useArtifactLive({
    shortId,
    onComment: refetchComments,
    onVersion: onVersionLive,
    onReview,
    onResync: load,
  })

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
    subscribeGeom,
  } = useArtifactFrame({
    // Paint the open/addressed thread anchors in the doc; a click focuses the thread.
    comments,
    shortId,
    version,
    hoverThread,
    activeThread,
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
    // Escape typed INTO the sandboxed frame (a click into the doc moves keyboard
    // focus there, out of the window listeners' reach) — mirror what a window
    // Escape does on this page: exit focus mode, cancel a parked composer.
    onEsc: () => {
      setFocus(false)
      setComposer(null)
    },
    // A non-bundle link clicked inside the frame. The href is untrusted artifact
    // HTML — allowlist the scheme (a hostile doc could post javascript:). The
    // app's own /artifacts/… links SPA-navigate (same as data-derive-nav links);
    // everything else opens a clean tab, never the frame.
    onOpenExternal: (href) => {
      let u: URL
      try {
        u = new URL(href)
      } catch {
        return
      }
      if (!["http:", "https:", "mailto:"].includes(u.protocol)) return
      const m =
        u.origin === window.location.origin ? u.pathname.match(/^\/artifacts\/([^/]+)$/) : null
      if (m?.[1]) nav({ to: "/artifacts/$ref", params: { ref: decodeURIComponent(m[1]) } })
      else window.open(u.href, "_blank", "noopener,noreferrer")
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
  // into the top/bottom edge indicators. Imperative (setGeom is a ref write) —
  // geometry changes per scroll frame and must never re-render the page.
  useEffect(() => subscribeGeom(live.setGeom), [subscribeGeom, live.setGeom])

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

  // URL canonicalisation, the anon-bounce gate, and the ?comment deep link — the
  // page's routing side-effects. `nav` stays here; the hook takes decoupled callbacks.
  useArtifactRoute({
    art,
    ref,
    shortId,
    version,
    comments,
    authed: !!me,
    loading,
    failed,
    locked,
    error,
    onCanonical: (canonical) =>
      nav({ to: "/artifacts/$ref", params: { ref: canonical }, search: (s) => s, replace: true }),
    onLoginBounce: () => nav({ to: "/login" }),
    post,
    setPanel,
    setActiveThread,
  })

  // Every mutating action the page drives, each routed through the governed mutation
  // primitive. Called ABOVE the load guards below — a hook can't sit under an early
  // return — so it takes the artifact as possibly-undefined; the handlers only ever fire
  // from the loaded workbench, where it's present.
  const {
    startEdit,
    publishEdit,
    proposeEdit,
    reply,
    submitNew,
    toggleResolve,
    activate,
    startSelComment,
    startSelAgent,
    actions,
    restore,
    publishing,
    restoring,
  } = useArtifactActions({
    shortId,
    art,
    me,
    src,
    title: editTitle,
    proposeMsg,
    message,
    composer,
    sel,
    post,
    load,
    refetchComments,
    onRestoredJump: () =>
      nav({
        to: "/artifacts/$ref",
        params: { ref: refFor({ short_id: shortId, title: art?.title }) },
      }),
    onOpenReview: () => setReviewing(true),
    setEditing,
    setSrc,
    setTitle: setEditTitle,
    setProposeMsg,
    setComposer,
    setSel,
    setActiveThread,
  })

  // Reinstate a removed artifact (owner-only, from the tombstone) and lock/unlock the
  // current version — page-level writes, hoisted above the load guards like the actions
  // hook so the primitive can govern them.
  const reinstate = useApiMutation({
    mutationFn: () => api.reinstate(shortId),
    success: "Reinstated",
    onSuccess: () => load(),
  })
  const lockMut = useApiMutation({
    mutationFn: (next: boolean) => api.setLocked(shortId, next),
    optimistic: (next, client) => {
      const rollback = snapshot(client, artifactQuery(shortId).queryKey)
      client.setQueryData(artifactQuery(shortId).queryKey, (a) => (a ? { ...a, locked: next } : a))
      return rollback
    },
    // Reconcile on settle: the whole-artifact snapshot rollback could otherwise clobber a
    // concurrent edit to the same key (a favorite/tag toggle) that landed mid-flight.
    invalidate: [artifactQuery(shortId).queryKey],
  })

  if (locked) return <PasswordGate shortId={shortId} onUnlocked={() => refetch()} />
  // `failed && !art`: only show the full error page when there's NO artifact to show. A
  // background-refetch failure sets isError while react-query keeps `art` (e.g. a blip right
  // after a publish invalidates the query) — keep the loaded workbench, don't flash the error.
  if (failed && !art) {
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
  if (!art) return <WorkbenchSkeleton />
  // Removed artifacts show a tombstone instead of the document — content is gone
  // (the server 410s the raw routes), but an owner can still reinstate.
  if (art.removed)
    return (
      <ArtifactRemoved
        canReinstate={art.my_role === "owner"}
        onReinstate={() => reinstate.mutate()}
        onBack={() => nav({ to: "/" })}
      />
    )

  const shown = version ?? art.current_version
  const editable = art.kind === "file" && shown === art.current_version
  // Reader view re-renders a non-responsive HTML artifact clean + mobile-friendly
  // (server applies it on `?reader=1`). Off by default; the top-bar toggle flips it.
  //
  // The `t/:raw_token` segment is the sandboxed iframe's own proof of access: it has no
  // `allow-same-origin` (by design — the content must never touch our cookies/storage),
  // so it has no origin to send our session cookie back on, and Chrome refuses to attach
  // cookies to opaque-origin requests at all, even same-site (Safari is more lenient) —
  // every sub-resource in a non-public bundle silently 404s there without this. Falls
  // back to the plain cookie-authorized URL if a token isn't available yet (e.g. the
  // detail fetch hasn't resolved) or on a legacy cached response missing the field.
  //
  // The token is freshly signed on EVERY artifact-detail fetch (a favorite toggle, a
  // tag edit, a background refetch — none of which change the rendered content), but
  // `rawSrc` feeds the iframe's `src`: a new value forces a full reload. Pin the first
  // token seen for this (shortId, version) in a ref and keep using it — even after the
  // query refetches and `art.raw_token` changes underneath — so the mounted preview
  // only ever reloads for a reason (a real version change), not a coincidental refetch.
  if (
    art.raw_token &&
    (!pinnedRawToken.current ||
      pinnedRawToken.current.shortId !== shortId ||
      pinnedRawToken.current.version !== shown)
  )
    pinnedRawToken.current = { shortId, version: shown, token: art.raw_token }
  const rawToken =
    pinnedRawToken.current?.shortId === shortId && pinnedRawToken.current.version === shown
      ? pinnedRawToken.current.token
      : undefined
  const rawBase = rawToken
    ? `${API_BASE}/raw/${shortId}/v/${shown}/t/${rawToken}`
    : `${API_BASE}/raw/${shortId}/v/${shown}`
  const rawSrc = `${rawBase}/index.html${reader ? "?reader=1" : ""}`
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
  const canMove = art.my_role === "owner"
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
  const promptSignInToComment = shouldPromptSignInToComment(isAnon, art.link_role, !!art.removed)

  // Sort threads into pinned (anchored & present in this live doc), general
  // (unanchored / orphaned / off-slide), and resolved — pure, from the frame's
  // reported geometry. Pins carry DOC-ABSOLUTE Ys; the pin layer maps them to the
  // screen imperatively, so this (and the page) never recomputes on scroll.
  const docLive = !editing && view === "preview"
  const { openThreads, resolvedThreads, pinned, general, openCount } = bucketThreads({
    comments,
    docLive,
    deck,
    inDoc,
    landedSlides,
    anchorTops,
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

  // Mobile has no hidden state: the sheet's peek bar is always docked (it IS the
  // entry point — there's no top-bar toggle or `c` key on a phone, and a hidden
  // panel made comments unreachable). Computed here rather than in the panel hook
  // so a desktop→mobile resize with a persisted "hidden" can't strand a phone.
  const effectivePanel = isMobile && !isAnon ? "open" : panel

  // The rendered artifact frame — identical for the anon public viewer and the authed
  // workbench, so build it once and place it in both branches (no prop drift).
  const documentEl = (
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
  )

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
        {documentEl}
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
        <FocusShellSync focus={focus} />
        {/* The workbench bar — full-width now (sidebar-first shell), so the
              comments panel docks BELOW it instead of squeezing it into the
              remaining width. The page owns its toolbar: the artifact title (the
              Geist content register) on the left, presence/cursors + the header
              actions on the right. shrink-0 keeps the split row below it on the
              min-h-0 flex-1 height chain. */}
        {/* The header stays mounted but hidden in focus mode — unmounting it while
            its ⋯ menu is mid-close trips a Radix ref-composition loop. */}
        <div
          className={cn(
            "flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 max-sm:flex-wrap max-sm:px-3",
            focus && "hidden",
          )}
        >
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
          {/* Collaboration — presence facepile + your cursor. Presence rides even the
              phone header (compact) so multiplayer identity never vanishes on mobile;
              the cursor picker stays desktop-only (no hovering cursor to style on touch). */}
          <div className="flex items-center gap-0.5">
            {/* Live-stream health: surfaced ONLY while disconnected, so a dropped connection
                reads as "reconnecting" instead of a silently-frozen collaborative view.
                Comments/presence self-heal on reconnect (use-artifact-live's onResync). */}
            {!live.connected && (
              <span
                data-testid="live-reconnecting"
                title="Reconnecting to live updates — comments and presence may be briefly out of date"
                className="mr-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground"
              >
                <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70" />
                <span className="hidden sm:inline">Reconnecting…</span>
              </span>
            )}
            <Presence viewers={live.viewers} selfId={me?.id} compact={isMobile} />
            {!isMobile && <CursorButton />}
          </div>
          {!isAnon && (
            <ArtifactTopBar
              shortId={shortId}
              orgId={art.org_id}
              myRole={art.my_role}
              workspaceAccess={art.workspace_access}
              linkRole={art.link_role}
              listed={art.listed}
              passwordProtected={!!art.password_protected}
              favorite={!!art.favorite}
              tags={art.tags ?? []}
              collections={art.collections ?? []}
              collectionAccess={art.collection_access ?? []}
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
              canMove={canMove}
              locked={isLocked}
              onPresent={toggleFullscreen}
              onLockToggle={() => lockMut.mutate(!isLocked)}
              onFavorite={(fav) =>
                qc.setQueryData(artifactQuery(shortId).queryKey, (a) =>
                  a ? { ...a, favorite: fav } : a,
                )
              }
              onTags={(tags) =>
                qc.setQueryData(artifactQuery(shortId).queryKey, (a) => (a ? { ...a, tags } : a))
              }
              onCollections={(collections) =>
                // Pure cache write — CollectionsDialog calls this during its OPTIMISTIC
                // phase, so no refetch here (it would race the in-flight write); the
                // dialog itself reconciles collection_access on settle.
                qc.setQueryData(artifactQuery(shortId).queryKey, (a) =>
                  a ? { ...a, collections } : a,
                )
              }
              onInsights={() => setSurface("insights")}
              onHistory={() => setSurface("history")}
              onReview={() => setReviewing(true)}
              onStartEdit={startEdit}
              onToggleComments={() => setPanel((pn) => (pn === "open" ? "hidden" : "open"))}
              onFocus={() => setFocus(true)}
            />
          )}
        </div>
        {/* The split row lives BELOW the full-width bar: the document stage on
                the left, the comments aside on the right, so the panel slides in
                under the toolbar rather than beside it. */}
        <div className="flex min-h-0 flex-1">
          <div
            className="relative flex min-w-0 flex-1 flex-col"
            // On phones the comments sheet sits at the bottom — reserve exactly the
            // space it occupies so the document stays visible above it (and a
            // jumped-to highlight lands in view, not behind the sheet), with no
            // black band below. `sheetInset` tracks the sheet's real height (peek
            // bar, full list, or keyboard-pinned composer), so this never over- or
            // under-reserves the way a fixed `pb-[50vh]` did.
            style={
              isMobile && !focus && effectivePanel === "open"
                ? { paddingBottom: sheetInset }
                : undefined
            }
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
                publishing={publishing}
              />
            ) : (
              documentEl
            )}
            {/* On desktop, only when there ARE open comments — a zero-count pill is
                noise there, since the top-bar Comments toggle (and `c`) already opens
                the empty panel. On mobile NEITHER exists (the toggle is desktop-only,
                there's no keyboard), so the FAB is the sole entry point and must show
                even at zero — otherwise a comment-less doc has no way into comments. */}
            {!isAnon && !focus && !isMobile && panel === "hidden" && openCount > 0 && (
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
            {/* Focus mode: the one way back (the header is hidden). Esc also exits. */}
            {focus && (
              <FloatingControl
                size="sm"
                data-testid="artifact-focus-exit"
                aria-label="Exit focus mode"
                onClick={() => setFocus(false)}
                className="absolute top-3 right-3 z-10"
              >
                <Minimize2 className="size-4" aria-hidden />
                Exit focus
                <Kbd className="max-sm:hidden">Esc</Kbd>
              </FloatingControl>
            )}
          </div>

          {!focus && (
            <ArtifactComments
              shortId={shortId}
              isMobile={isMobile}
              isAnon={isAnon}
              canComment={canComment}
              reviewCard={
                // Top of the comments rail, not its own pane; members who can act only.
                canComment ? <ReviewCard shortId={shortId} refreshKey={reviewTick} /> : undefined
              }
              onSheetHeight={setSheetInset}
              docLive={docLive}
              panel={effectivePanel}
              asideWidth={asideWidth}
              openCount={openCount}
              frameRef={frame}
              subscribeGeom={subscribeGeom}
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
              startSelAgent={startSelAgent}
              agents={agents}
              currentSlide={deck?.i ?? null}
              landedSlides={landedSlides}
              anchorConf={anchorConf}
            />
          )}
        </div>
      </div>
    </ActionsCtx.Provider>
  )
}
