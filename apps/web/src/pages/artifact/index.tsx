import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useBlocker, useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { Minimize2 } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { ApiError, api } from "@/api"
import { useShell } from "@/components/chrome/shell-context"
import { Icon } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { Kbd } from "@/components/ui/kbd"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { artifactTypeLabel, canEditArtifactDoc, canPublishArtifact, formatOf } from "@/lib/artifact"
import { guestPresenceId } from "@/lib/guest-id"
import { bareHotkey } from "@/lib/hotkey"
import {
  artifactAgentsQuery,
  artifactQuery,
  commentsQuery,
  rawArtifactUrl,
  workspaceSettingsQuery,
} from "@/lib/queries"
import { ago } from "@/lib/time"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { useCoarsePointer, useIsMobile } from "@/lib/use-is-mobile"
import { useKeyboardInset } from "@/lib/use-keyboard-inset"
import { cn } from "@/lib/utils"
import { useArtifactActions } from "./artifact-actions"
import { ArtifactBreadcrumb } from "./artifact-breadcrumb"
import { ArtifactChat, type RailTab } from "./artifact-chat"
import { ArtifactComments } from "./artifact-comments"
import { ArtifactDocument } from "./artifact-document"
import { ArtifactInspect } from "./artifact-inspect"
import {
  ArtifactLoadError,
  ArtifactNotFound,
  ArtifactRemoved,
  ArtifactWrongWorkspace,
} from "./artifact-states"
import { ArtifactTopBar } from "./artifact-top-bar"
import { BundleBar } from "./bundle-bar"
import { ActionsCtx } from "./comment-actions"
import { DerivedFromBanner } from "./derived-from-banner"
import { EditBar } from "./edit-bar"
import { FloatingControl } from "./floating-control"
import { InlineMentionMenu } from "./inline-mention-menu"
import { canCommentWithRole } from "./lib/comment-access"
import { bucketThreads } from "./lib/layout"
import { artifactLoginSearch } from "./lib/login-return"
import { useArtifactChat } from "./lib/use-artifact-chat"
import { takeUseIntent } from "./lib/use-intent"
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
import { unsavedEditsCopy, useInlineEdit } from "./use-inline-edit"
import { useVersionDiff } from "./use-version-diff"
import { WorkbenchSkeleton } from "./workbench-skeleton"

// Heavy on-demand surfaces — split out of the artifact route's initial chunk and
// loaded only when the user opens them (review proposals / insights / history).
const ReviewOverlay = lazy(() => import("./review").then((m) => ({ default: m.ReviewOverlay })))
const Insights = lazy(() => import("./insights-history").then((m) => ({ default: m.Insights })))
const HistoryDrawer = lazy(() =>
  import("./insights-history").then((m) => ({ default: m.HistoryDrawer })),
)

// The floating pill over the document (the signed-in comments toggle). The anon
// counterpart lives in PublicViewer on the same FloatingControl recipe.
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
  const { switchWorkspace } = useShell()
  const { ref } = useParams({ from: "/artifacts/$ref" })
  const search = useSearch({ from: "/artifacts/$ref" })
  const { shortId, version } = parseRef(ref)
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const isMobile = useIsMobile()
  // Thumb-sized targets and "tap" copy follow the POINTER, not the breakpoint: a
  // landscape phone is 844px wide and a tablet wider still, and both are fingers.
  const coarsePointer = useCoarsePointer()

  // Artifact metadata + comments come from React Query, so the route loader's
  // intent preload (ensureQueryData) warms exactly what we render here — the
  // click that follows a hover reads straight from cache. Optimistic edits and
  // the SSE live updates below write through the same client.
  const qc = useQueryClient()
  // Passing the client seeds the first paint from the clicked card's list row
  // (placeholderData in artifactQuery): the header renders on the first frame after
  // the click. `seeded` gates the content iframe below — a list row has no raw_token,
  // so starting the render from it would only restart the frame when the real record
  // lands a beat later.
  const {
    data: art,
    isPlaceholderData: seeded,
    isError: failed,
    error,
    refetch,
  } = useQuery(artifactQuery(shortId, qc))

  // Deferred use-as-template: the public viewer's "Make your own" sends a signed-out
  // clicker through login with `?use=1`, and the copy fires here, right after auth.
  // The same-tab marker gates it — `?use=1` alone is a shareable URL, and a pasted
  // link must not write into the clicker's workspace (see lib/use-intent.ts). Fired
  // at most once per mount; success replaces the URL with the copy's, anything else
  // (no marker, still anonymous, refused) strips the flag and shows the page as-is.
  const useFired = useRef(false)
  useEffect(() => {
    if (!search.use || loading || useFired.current) return
    useFired.current = true
    const strip = () =>
      nav({
        to: "/artifacts/$ref",
        params: { ref },
        search: (s) => ({ ...s, use: undefined }),
        replace: true,
      })
    if (!me || !takeUseIntent(shortId)) {
      strip()
      return
    }
    api
      .deriveArtifact(shortId)
      .then((r) =>
        nav({
          to: "/artifacts/$ref",
          params: { ref: refFor({ short_id: r.short_id, title: r.title }) },
          replace: true,
        }),
      )
      .catch(() => {
        toast.error("Couldn't copy this artifact into your workspace")
        strip()
      })
  }, [search.use, loading, me, shortId, ref, nav])
  // The tab is named after the document, like the workbench header (title, else id).
  useDocumentTitle(art ? (art.title ?? shortId) : null)
  // Comments are signed-in-only (the API 404s anon by design) — don't fire the
  // query just to watch it fail on every public view.
  const { data: comments = [] } = useQuery({ ...commentsQuery(shortId), enabled: !!me })
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      // Escape dismisses the TOPMOST layer, and this listener is the bottom one.
      // Radix (dialogs, menus, popovers — including this page's own confirms) binds
      // on document with capture and calls preventDefault without stopping
      // propagation, so without this check one press both closes the dialog and
      // re-runs the action that opened it: the discard confirm became impossible to
      // dismiss with Escape, and closing an unrelated ⋯ menu tore down edit mode.
      if (e.defaultPrevented) return
      if (focus) {
        setFocus(false)
        return
      }
      // Keyboard focus is often OUTSIDE the frame (the user just clicked the strip),
      // so the window listener owns Escape there; the frame forwards its own.
      inlineEditRef.current.requestExit()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [focus])

  // ⌘S / ⌘Enter with focus on the host chrome. The frame forwards the same keys when
  // the caret is inside the document, but the strip advertises the shortcut and focus
  // is on the HOST the moment you click anything in it — without this the browser's
  // Save-page dialog opens over the workbench instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.repeat) return
      if (e.key !== "s" && e.key !== "S" && e.key !== "Enter") return
      if (!inlineEditRef.current.active) return
      e.preventDefault()
      inlineEditRef.current.save()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  // `e` opens edit mode, the keyboard twin of the header's Edit button. No entry
  // point, no key: the ref carries whether the mode is even available, so this is
  // silent on a version you're reading, a bundle, or someone else's locked doc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!bareHotkey(e) || (e.key !== "e" && e.key !== "E")) return
      const { active, canEdit, start } = inlineEditRef.current
      if (active || !canEdit) return
      start()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  // The review overlay: null = closed. A ?review deep link (or a surface that knows
  // which proposal it means) opens it ON that proposal; the ⋯ menu opens it bare.
  const [reviewing, setReviewing] = useState<{ proposalId?: string } | null>(null)
  // Which "⋯ More" surface is open (large dialog / drawer).
  const [surface, setSurface] = useState<null | "insights" | "history">(null)
  const [proposeMsg, setProposeMsg] = useState("")
  const [message, setMessage] = useState("")
  const [src, setSrc] = useState("")
  // See the `rawSrc` construction below: pins the raw-content token per (shortId,
  // version) so a metadata refetch doesn't force the preview iframe to reload.
  const pinnedRawToken = useRef<{ shortId: string; version: number; token: string } | null>(null)
  // Phones: px the comment sheet occupies at the bottom, reported by MobileComments.
  // The document column reserves exactly this so nothing black is left beneath it.
  const [sheetInset, setSheetInset] = useState(0)
  // What the on-screen keyboard covers. Inline editing types INTO the document, so
  // the stage has to give back exactly this much or the line under the caret sits
  // behind the keyboard — the iframe can't discover that on its own (its own
  // viewport never shrinks; only the host's visual viewport does).
  const keyboard = useKeyboardInset()
  // Editable title while editing (seeded from the artifact in startEdit); editors
  // can rename, and it republishes with the new name.
  const [editTitle, setEditTitle] = useState("")

  // Comments UI state shared across the page, the panel, and the iframe bridge.
  // Reading is deliberately conversation-first: comments, then optional chat. Inspect
  // joins this rail only after an editor has entered an HTML edit session, so visual
  // controls never compete with review in the resting document state. Declared above
  // the loading returns so the hook order never changes between renders.
  const [rail, setRail] = useState<RailTab>("comments")
  // BETA: chat only renders where the workspace has opted in. The server refuses too —
  // this just avoids showing a tab that would 404 (see the chat-session route).
  const settings = useQuery({ ...workspaceSettingsQuery(), staleTime: 60_000 }).data
  const chatBeta = settings?.chatBeta === true
  // Automations are BETA the same way, read from the same fetch.
  const automateBeta = settings?.automateBeta === true
  const chat = useArtifactChat(shortId)
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
  // Same read-through-a-ref pattern for INLINE editing (set after the hook below):
  // while it's active the frame is version-frozen, so the live update must warn
  // instead of quietly swapping the document out from under typed text.
  // Holds the inline-edit API (not just a flag) so the SSE handler and the two
  // Escape listeners — all declared ABOVE the hook — can read live state and call
  // back into it without re-subscribing on every render.
  const inlineEditRef = useRef<{
    active: boolean
    canEdit: boolean
    dirty: number
    requestExit: () => void
    save: () => void
    start: () => void
  }>({
    active: false,
    canEdit: false,
    dirty: 0,
    requestExit: () => {},
    save: () => {},
    start: () => {},
  })
  const pinnedRef = useRef(version)
  pinnedRef.current = version
  const onVersionLive = useCallback(
    (n?: number) => {
      load()
      if (pinnedRef.current !== undefined) return
      const v = n !== undefined ? `v${n}` : "A new version"
      if (inlineEditRef.current.active) {
        toast.warning(`${v} was just published. Saving will re-check your edits against it.`, {
          id: `stale-edit-${shortId}`,
          duration: 8000,
        })
      } else if (editingRef.current) {
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
    // Our stable presence id: a signed-in user id, else the anon guest id (same one the
    // facepile uses). The cursor engine keys peers on it so "follow" lines up.
    selfId: me?.id ?? guestPresenceId(),
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
    present,
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
    onOpenComments: () => setRail("comments"),
    onNavigate: (ref, newTab) => {
      // Same-origin SPA route. A modified/middle click opens it un-sandboxed in a new
      // tab (the frame's own new tab would inherit the sandbox and break the app).
      if (newTab) window.open(`/artifacts/${ref}`, "_blank", "noopener")
      else nav({ to: "/artifacts/$ref", params: { ref } })
    },
    // Live read (the edit hook is declared below this one) so the host's arrow keys
    // stop driving the deck the moment an edit session opens.
    isEditing: () => inlineEditRef.current.active,
    // Presenting closes an open edit session first — but never over the top of
    // unsaved work: with edits pending, requestExit raises the discard confirm on
    // the page and present mode stays shut until that's answered.
    onPresent: () => {
      const ie = inlineEditRef.current
      setComposer(null)
      if (!ie.active) return true
      ie.requestExit()
      return !ie.dirty
    },
    // Escape typed INTO the sandboxed frame (a click into the doc moves keyboard
    // focus there, out of the window listeners' reach) — mirror what a window
    // Escape does on this page: exit focus mode, cancel a parked composer.
    onEsc: () => {
      setFocus(false)
      setComposer(null)
      // Escape is also "leave edit mode" — with unsaved edits the hook asks first
      // instead of throwing typing away.
      inlineEditRef.current.requestExit()
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

  // Deep link: ?present=1 opens a deck straight into present mode, once its slides
  // have been reported. Browsers only grant real fullscreen off a user gesture, so a
  // link-driven entry lands in the overlay — the deck still fills the viewport, and
  // the bar's own button (a gesture) takes it the rest of the way.
  const presentLinked = useRef(false)
  useEffect(() => {
    if (presentLinked.current || !deck || !search.present) return
    presentLinked.current = true
    present.enter()
  }, [deck, search.present, present.enter])

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
    onLoginBounce: () => nav({ to: "/login", search: artifactLoginSearch(window.location) }),
    onOpenReview: (proposalId: string) => setReviewing({ proposalId }),
    onOpenComments: () => setRail("comments"),
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
        // Same artifact — keep the search (the ?collection switcher context, deep links).
        search: (s) => s,
      }),
    onOpenReview: () => setReviewing({}),
    setEditing,
    setSrc,
    setTitle: setEditTitle,
    setProposeMsg,
    setComposer,
    setSel,
    setActiveThread,
  })

  // Inline (click-to-type) editing: the frame owns the caret and the diffs, this
  // hook owns the mode + save/propose. Entering clears any parked selection so the
  // comment grammar and the edit grammar never overlap; the raw source editor is
  // the fallback when a quote can't be applied (formatted spans).
  const inlineEdit = useInlineEdit({
    shortId,
    art,
    frameRef: frame,
    post,
    load,
    // Eligibility is decided BEFORE the mode's own state exists, so it reads the
    // URL's version rather than the shown one. The two differ only while the mode
    // is open (it freezes the view), and the mode can't be re-entered from inside.
    canEdit: canEditArtifactDoc(art, version ?? art?.current_version, editing),
    // The frame always contains rendered HTML, including for Markdown. Only an
    // HTML/deck source supports the opening-tag operation; Markdown keeps image
    // replacement but gets no resize handle.
    allowElementEdits:
      art?.current_content_type?.startsWith("text/html") === true ||
      art?.current_content_type === "text/x-derive-deck",
    onOpenSourceEditor: startEdit,
    onEnter: () => {
      setSel(null)
      setComposer(null)
      setActiveThread(null)
    },
  })
  inlineEditRef.current = {
    active: inlineEdit.active,
    canEdit: inlineEdit.canEdit,
    dirty: inlineEdit.dirty,
    requestExit: inlineEdit.requestExit,
    save: inlineEdit.save,
    start: inlineEdit.start,
  }

  // Inspect is an edit-mode companion, never a passive third destination. The existing
  // Edit entry point is the only way in; when it activates an editable HTML artifact,
  // put the visual guide beside the document automatically. Leaving the session returns
  // the rail to its reading default so an unavailable "inspect" selection cannot linger.
  const inspectSessionActive =
    inlineEdit.active &&
    inlineEdit.allowElementEdits &&
    (art?.my_role === "editor" || art?.my_role === "owner")
  const hadInspectSession = useRef(false)
  useEffect(() => {
    if (inspectSessionActive) {
      hadInspectSession.current = true
      setRail("inspect")
    } else if (hadInspectSession.current) {
      hadInspectSession.current = false
      setRail("comments")
    }
  }, [inspectSessionActive])

  // Unsaved inline edits live only in the frame's DOM — a route change unmounts it
  // and a reload throws it away, both silently. Guard BOTH: withResolver drives the
  // house ConfirmDialog for in-app navigation, enableBeforeUnload hands tab-close to
  // the browser's own prompt (the only thing that can stop it). Same shape as the
  // new-artifact draft guard in pages/new.tsx.
  const editBlocker = useBlocker({
    // Only a navigation that actually LEAVES this artifact. The route canonicalises
    // its own URL with `replace` (a rename by a collaborator is enough to trigger
    // it), and blocking that pops a discard dialog for a slug rewrite the user never
    // asked for — then re-pops it the moment they cancel, because the rewrite is
    // still pending. Same-artifact navigations carry no risk to unsaved edits: the
    // frame is not remounted.
    shouldBlockFn: ({ next }) => inlineEdit.blocking && !next.pathname.includes(shortId),
    enableBeforeUnload: () => inlineEdit.blocking,
    withResolver: true,
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
    if (error instanceof ApiError && error.code === "workspace_mismatch" && error.workspace) {
      const workspace = error.workspace
      const name = workspace.personal ? "Personal" : workspace.name
      return (
        <ArtifactWrongWorkspace
          workspaceName={name}
          onSwitch={() => switchWorkspace(workspace.id)}
          onBack={() => nav({ to: "/" })}
        />
      )
    }
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

  // While inline editing, the shown version stays frozen at the mode-entry head so
  // a concurrent publish can't reload the frame and wipe typed-but-unsaved text.
  const shown = version ?? inlineEdit.frozenVersion ?? art.current_version
  // The public-history gate, client half: an anonymous @vN link on an artifact whose
  // owner kept history private is a 404, not a downgrade — the server already
  // refuses the old version's bytes (raw.ts), so render the same not-found the
  // hand-typed-id case gets rather than a broken frame. Only once auth has
  // SETTLED anonymous: while it loads, `me` is null for signed-in users too,
  // and they must not flash a not-found for a version they can see.
  if (!loading && !me && shown !== art.current_version && !art.public_history)
    return <ArtifactNotFound onBack={() => nav({ to: "/" })} />
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
  // While the record is a list-row seed (placeholder), hold the frame: the seed has no
  // raw_token, and a tokenless load now would just be torn down and reloaded when the
  // real record lands ~a beat later. RenderStage shows its boot state meanwhile, so the
  // person sees real header + calm loading, never a double content flash.
  // rawArtifactUrl is SHARED with the prefetch (lib/queries) so the two can never build
  // different URLs again — when they did, hover prefetching warmed a response the frame
  // never requested.
  const rawSrc = seeded ? null : rawArtifactUrl(shortId, shown, rawToken)
  // Editors publish directly; commenters propose a candidate for review.
  const canPublish = art.my_role === "editor" || art.my_role === "owner"
  // md vs html drives syntax highlighting + how the live preview renders.
  const format = formatOf(art)
  // Lock: any editor can toggle it (advanced menu). While locked, even an editor
  // must propose — `effectiveCanPublish` flips the edit flow to the propose path.
  const canLock = canPublish
  const canMove = art.my_role === "owner"
  const isLocked = !!art.locked
  const effectiveCanPublish = canPublishArtifact(art)
  // The ONE eligibility base both edit affordances (inline + raw source) share, so
  // a new rule can't land in one and not the other; the deck test likewise has a
  // single spelling that the isDeck prop and the inline gate both read.
  const canEditDoc = canEditArtifactDoc(art, shown, editing)
  // Inspect intentionally stays narrower than inline text editing: it is an editor
  // capability for source-safe HTML element operations. A slide deck reaches the
  // same path because its stored source is HTML; there is no separate deck editor.
  const canInspect = canPublish && inlineEdit.allowElementEdits
  const inspectEnabled = canInspect && inlineEdit.active
  const isDeckLike = !!deck || art.current_content_type === "text/x-derive-deck"
  // A logged-out visitor on a public/link artifact: strictly view-only. They get
  // the document + live presence/cursors (Google-Docs style) and nothing else —
  // no favorite, collections, share, report, comments, or version tools.
  // The API gates every one of those for anon (anonLocked); hiding them here keeps
  // the chrome honest so there's no dead/forbidden affordance to bump into.
  const isAnon = !me
  // Commenting needs commenter+ (matches the API's `comment` gate). A signed-in viewer
  // reading via a view-only link sees comments but gets no write affordance. An
  // anonymous visitor never qualifies — PublicViewer carries their sign-in-to-comment
  // nudge (auth is the gate; see the access matrix).
  const canComment = canCommentWithRole(art.my_role)

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
      // While inline editing, the frozen view IS the working version: a concurrent
      // publish must not surface the past-version strip mid-session (its Restore
      // would publish over the head while edits are pending; the warning toast
      // already announced the new version). Treating shown as current hides it.
      currentVersion={inlineEdit.active ? shown : art.current_version}
      title={art.title ?? shortId}
      subject={shortId}
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
      // A frame (re)load while inline editing means the edit session's document is
      // gone — the hook exits and warns rather than letting a later Save silently
      // no-op over discarded edits.
      onFrameLoad={() => {
        onFrameLoad()
        inlineEdit.onFrameGone()
      }}
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
      presenting={present.presenting}
      presentOverlay={present.overlay}
      controlsIdle={present.idle}
      onPresent={present.toggle}
      anonView={isAnon}
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
        shown={shown}
        returnTo={`/artifacts/${ref}`}
        viewers={live.viewers}
        selfId={guestPresenceId()}
        isMobile={isMobile}
      >
        {documentEl}
      </PublicViewer>
    )

  const unsaved = unsavedEditsCopy(inlineEdit.dirty)

  return (
    <ActionsCtx.Provider value={actions}>
      {/* Leaving with unsaved inline edits — one wording, two doors. Navigation is
          intercepted by the router blocker; Escape/Done ask through the hook. */}
      <ConfirmDialog
        open={editBlocker.status === "blocked"}
        onOpenChange={(o) => {
          if (!o && editBlocker.status === "blocked") editBlocker.reset()
        }}
        title={unsaved.title}
        description={unsaved.description}
        confirmLabel={unsaved.confirmLabel}
        confirmTestId="inline-edit-leave-confirm"
        onConfirm={() => {
          if (editBlocker.status === "blocked") {
            inlineEdit.confirmExit()
            editBlocker.proceed()
          }
        }}
      />
      <ConfirmDialog
        open={inlineEdit.exitPrompt}
        onOpenChange={(o) => {
          if (!o) inlineEdit.cancelExit()
        }}
        title={unsaved.title}
        description={unsaved.description}
        confirmLabel={unsaved.confirmLabel}
        confirmTestId="inline-edit-exit-confirm"
        onConfirm={inlineEdit.confirmExit}
      />
      {reviewing && (
        <Suspense fallback={null}>
          <ReviewOverlay
            shortId={shortId}
            currentVersion={art.current_version}
            myRole={art.my_role}
            meName={me?.name ?? me?.email ?? null}
            initialProposalId={reviewing.proposalId}
            onClose={() => setReviewing(null)}
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
                // Same artifact, different version — preserve the ?collection context.
                search: (s) => s,
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
            <ArtifactBreadcrumb art={art} focusMode={focus} />
            <span className="truncate font-mono text-2xs tabular-nums text-muted-foreground">
              {artifactTypeLabel(art)} · v{art.current_version}
              {art.updated_at ? ` · updated ${ago(art.updated_at)}` : ""}
            </span>
          </div>
          {/* Collaboration — the presence facepile (rides even the phone header, compact,
              so multiplayer identity never vanishes on mobile) + the live-stream health
              cue. Live cursors need no control here: they're on by default, auto-tinted by
              identity, and opting out lives in the ⋯ menu ("Hide live cursors"). */}
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
          </div>
          {!isAnon && (
            <ArtifactTopBar
              shortId={shortId}
              artifactTitle={art.title ?? undefined}
              orgId={art.org_id}
              myRole={art.my_role}
              workspaceAccess={art.workspace_access}
              linkRole={art.link_role}
              listed={art.listed}
              passwordProtected={!!art.password_protected}
              publicHistory={!!art.public_history}
              favorite={!!art.favorite}
              collections={art.collections ?? []}
              collectionAccess={art.collection_access ?? []}
              openProposals={art.open_proposals ?? 0}
              proposalsTotal={art.proposals_total ?? 0}
              isMobile={isMobile}
              panelOpen={panel === "open"}
              openCount={openCount}
              // The source editor unmounts the iframe — mid-inline-session that
              // silently discards typed edits, so its entry hides while editing.
              showEdit={canEditDoc && !inlineEdit.active}
              // The raw-source fallback. It is not a dev tool (the inline editor's
              // own errors send people here by name), so it no longer says "(dev)".
              editLabel={effectiveCanPublish ? "Edit source" : "Propose a change"}
              // Inline editing: current version, single file, not GitHub-managed.
              // Commenters get the same affordance as a suggestion (it lands as a
              // proposal). Phones included: tap a block, type on the keyboard, save
              // from the bar. DECKS INCLUDED — a slide's headline is the most
              // typo-prone text Derive holds and the source editor was the only way
              // to fix one. What used to make a deck unsafe to edit (its own Space
              // and arrow keys flipping slides under the caret) is handled in the
              // frame: while a caret is in a block, the page's keyboard is off.
              showInlineEdit={canEditDoc && !inlineEdit.active}
              inlineEditLabel={effectiveCanPublish ? "Edit" : "Suggest edits"}
              onInlineEdit={() => inlineEdit.start()}
              isDeck={isDeckLike}
              canLock={canLock}
              canMove={canMove}
              automateBeta={automateBeta}
              locked={isLocked}
              onPresent={present.toggle}
              onLockToggle={() => lockMut.mutate(!isLocked)}
              onFavorite={(fav) =>
                qc.setQueryData(artifactQuery(shortId).queryKey, (a) =>
                  a ? { ...a, favorite: fav } : a,
                )
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
              onReview={() => setReviewing({})}
              onStartEdit={startEdit}
              onToggleComments={() => setPanel((pn) => (pn === "open" ? "hidden" : "open"))}
              onFocus={() => setFocus(true)}
            />
          )}
        </div>
        {/* The split row lives BELOW the full-width bar: the document stage on
                the left, the comments aside on the right, so the panel slides in
                under the toolbar rather than beside it. */}
        {/* `relative` so the rail's tab strip anchors HERE, below the toolbar, rather than
            resolving to a further ancestor and overlapping the workbench buttons. */}
        <div className="relative flex min-h-0 flex-1">
          <div
            className="relative flex min-w-0 flex-1 flex-col"
            // On phones the comments sheet sits at the bottom — reserve exactly the
            // space it occupies so the document stays visible above it (and a
            // jumped-to highlight lands in view, not behind the sheet), with no
            // black band below. `sheetInset` tracks the sheet's real height (peek
            // bar, full list, or keyboard-pinned composer), so this never over- or
            // under-reserves the way a fixed `pb-[50vh]` did.
            // Two things can occupy the bottom: the comments sheet and, while
            // editing, the on-screen keyboard. Reserve the taller — the sheet pins
            // ITSELF above the keyboard, so adding them would double-count.
            style={
              !focus && (keyboard || (isMobile && effectivePanel === "open"))
                ? {
                    paddingBottom: Math.max(
                      isMobile && effectivePanel === "open" ? sheetInset : 0,
                      inlineEdit.active ? (keyboard?.inset ?? 0) : 0,
                    ),
                  }
                : undefined
            }
          >
            {/* Remix provenance on a fresh copy: v1 only (the first publish makes the
                document its own), editors only, and never over the editing surfaces. */}
            {art.current_version === 1 && canEditDoc && !editing && !inlineEdit.active && (
              <DerivedFromBanner art={art} />
            )}
            {art.bundle && !editing && (
              <BundleBar bundle={art.bundle} shortId={shortId} version={shown} />
            )}
            {/* Inline edit mode's one piece of chrome: a slim band above the document
                (in flow, so it can never cover or swallow clicks on the text you came
                to fix). The document itself is the editor — click a block, type.
                Focus mode keeps it: focus hides the chrome you don't need to READ,
                and the band is the only thing on screen that says the page is
                editable and carries the way to save. Hiding it left a mode with
                unsaved work and no visible Save. */}
            {inlineEdit.active && !editing && (
              <EditBar
                dirty={inlineEdit.dirty}
                canPublish={effectiveCanPublish}
                saving={inlineEdit.saving}
                touch={coarsePointer}
                canUndo={inlineEdit.tools.canUndo}
                canRedo={inlineEdit.tools.canRedo}
                canFormat={inlineEdit.tools.canFormat}
                allowElementEdits={inlineEdit.allowElementEdits}
                onUndo={inlineEdit.undo}
                onRedo={inlineEdit.redo}
                onFormat={inlineEdit.format}
                onSave={inlineEdit.save}
                onDiscard={inlineEdit.discard}
                onDone={inlineEdit.done}
              />
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
                shortId={shortId}
              />
            ) : (
              documentEl
            )}
            {inlineEdit.mention && !editing && (
              <InlineMentionMenu menu={inlineEdit.mention} onChoose={inlineEdit.chooseMention} />
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
              rail={rail}
              onRail={setRail}
              chatBeta={chatBeta}
              chatPanel={
                <ArtifactChat
                  messages={chat.messages}
                  working={chat.working}
                  streaming={chat.streaming}
                  notice={chat.error ?? undefined}
                  onSend={(b) => chat.send(b, effectiveCanPublish)}
                  onPoll={chat.poll}
                />
              }
              inspectEnabled={inspectEnabled}
              inspectPanel={
                inspectEnabled ? (
                  <ArtifactInspect
                    dirty={inlineEdit.dirty}
                    saving={inlineEdit.saving}
                    canUndo={inlineEdit.tools.canUndo}
                    canRedo={inlineEdit.tools.canRedo}
                    canFormat={inlineEdit.tools.canFormat}
                    textActive={inlineEdit.tools.textActive}
                    textKind={inlineEdit.tools.textKind}
                    selectedText={inlineEdit.tools.selectedText}
                    onUndo={inlineEdit.undo}
                    onRedo={inlineEdit.redo}
                    onFormat={inlineEdit.format}
                    onSave={inlineEdit.save}
                    onDone={inlineEdit.done}
                  />
                ) : undefined
              }
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
              editing={inlineEdit.active}
              // The selection bar's Edit verb: opens the mode with the caret already
              // in the selected text, so a typo you just read costs one click.
              editLabel={canEditDoc ? (effectiveCanPublish ? "Edit" : "Suggest") : undefined}
              onEditSelection={
                canEditDoc ? () => inlineEdit.start({ fromSelection: true }) : undefined
              }
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
