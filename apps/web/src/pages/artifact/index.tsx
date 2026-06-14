import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useParams } from "@tanstack/react-router"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { API_BASE, api, type Comment, type Diff } from "@/api"
import { useIsMobile, useToast } from "@/components"
import { Icon } from "@/components/icons"
import { useTopBarSlot } from "@/components/shell-context"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { artifactQuery, commentsQuery } from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { cn } from "@/lib/utils"
import { artifactActions } from "./artifact-actions"
import { ArtifactDocument } from "./artifact-document"
import { ArtifactLoading, ArtifactNotFound, ArtifactRemoved } from "./artifact-states"
import { ArtifactTopBar } from "./artifact-top-bar"
import { ActionsCtx } from "./comment-actions"
import { MobileComments, OpenPanel } from "./comment-panels"
import { clamp, groupThreads, parseAnchor } from "./lib/layout"
import { parseRef } from "./parse-ref"
import { Presence, Rail } from "./rail-deck"
import { SourceEditor } from "./source-editor"
import type { Panel, PinItem, Sel } from "./types"
import { useArtifactLive } from "./use-artifact-live"

// Heavy on-demand surfaces — split out of the artifact route's initial chunk and
// loaded only when the user opens them (review proposals / insights / history).
const ReviewOverlay = lazy(() =>
  import("@/components/review").then((m) => ({ default: m.ReviewOverlay })),
)
const Insights = lazy(() => import("./insights-history").then((m) => ({ default: m.Insights })))
const HistoryDrawer = lazy(() =>
  import("./insights-history").then((m) => ({ default: m.HistoryDrawer })),
)

const PANEL_KEY = STORAGE_KEYS.commentsPanel
const loadPanel = (): Panel => {
  try {
    const v = localStorage.getItem(PANEL_KEY)
    return v === "rail" || v === "hidden" ? v : "open"
  } catch {
    return "open"
  }
}

export function Artifact() {
  const { ref } = useParams({ from: "/a/$ref" })
  const { shortId, version } = parseRef(ref)
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const { toast, show } = useToast()
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
  const { data: art, isError: failed } = useQuery(artifactQuery(shortId))
  const { data: comments = [] } = useQuery(commentsQuery(shortId))
  const [editing, setEditing] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  // Which "⋯ More" surface is open (large dialog / drawer).
  const [surface, setSurface] = useState<null | "insights" | "history">(null)
  const [proposeMsg, setProposeMsg] = useState("")
  const [view, setView] = useState<"preview" | "diff">("preview")
  const [diff, setDiff] = useState<Diff | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [src, setSrc] = useState("")

  // Comments UI state. On phones the panel is a slide-up sheet that starts
  // closed (document-first); on desktop it restores the saved rail/open state.
  const [panel, setPanel] = useState<Panel>(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width:640px)").matches
      ? "hidden"
      : loadPanel(),
  )
  const [sel, setSel] = useState<{
    selector: Sel
    top: number
    vTop: number
    vBottom: number
    vLeft: number
    vRight: number
  } | null>(null)
  const [composer, setComposer] = useState<{ anchor: Sel | null; top: number | null } | null>(null)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [hoverThread, setHoverThread] = useState<string | null>(null)

  // The anchor channel with the sandboxed iframe (see ANCHOR_CLIENT_JS).
  const frame = useRef<HTMLIFrameElement>(null)
  const presentWrap = useRef<HTMLDivElement>(null)
  const [frameReady, setFrameReady] = useState(0)
  const [inDoc, setInDoc] = useState<Record<string, boolean>>({})
  const [anchorTops, setAnchorTops] = useState<Record<string, number>>({})
  const [scrollY, setScrollY] = useState(0)
  // Set when the artifact announces itself as a deck (dock-deck protocol).
  const [deck, setDeck] = useState<{ i: number; total: number } | null>(null)

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: "dock-host", ...msg }, "*")
  }, [])

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
  const live = useArtifactLive({ shortId, me, onComment: refetchComments, onVersion: load })

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (!d) return
      // A slide deck reporting its position (any HTML that speaks the protocol).
      if (d.source === "dock-deck" && d.type === "state") {
        setDeck({ i: d.i ?? 0, total: d.total ?? 1 })
        return
      }
      if (d.source !== "dock") return
      if (d.type === "select") {
        if (d.selector && d.rect) {
          const fr = frame.current?.getBoundingClientRect()
          const ft = fr?.top ?? 0
          const fl = fr?.left ?? 0
          setSel({
            selector: d.selector,
            top: d.rect.top,
            vTop: ft + d.rect.top,
            vBottom: ft + d.rect.bottom,
            // left/right are sent by the current anchor client; guard against a
            // stale-cached client posting only top/bottom so we never get NaN.
            vLeft: fl + (d.rect.left ?? 0),
            vRight: fl + (d.rect.right ?? d.rect.left ?? 0),
          })
        } else setSel(null)
      } else if (d.type === "anchors-resolved") setInDoc(d.resolved ?? {})
      else if (d.type === "anchor-rects") {
        setAnchorTops(d.tops ?? {})
        if (typeof d.scrollY === "number") setScrollY(d.scrollY)
      } else if (d.type === "scroll") {
        if (typeof d.scrollY === "number") setScrollY(d.scrollY)
      } else if (d.type === "anchor-hover") setHoverThread(d.id ?? null)
      else if (d.type === "anchor-click") {
        setActiveThread(d.id)
        setPanel((p) => (p === "open" ? p : "open"))
      } else if (d.type === "cursor" && typeof d.x === "number" && typeof d.y === "number") {
        live.onPointerMove(d.x, d.y)
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [live])

  // Persist the collapse state.
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, panel)
    } catch {
      /* private mode — ignore */
    }
  }, [panel])

  // Keyboard: 'c' toggles the panel open/closed; Escape cancels a composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.key === "Escape") {
        setComposer(null)
        return
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (el && /^(input|textarea|select)$/i.test(el.tagName)) return
      if (e.key === "c" || e.key === "C") setPanel((p) => (p === "open" ? "rail" : "open"))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Two-way hover: emphasize the highlight in the doc when a card is hovered.
  useEffect(() => {
    post({ type: "emphasize", id: hoverThread })
  }, [hoverThread, post])

  // Drive the deck from the host bar; fullscreen wraps the iframe + bar so the
  // controls stay reachable while presenting.
  const deckCmd = useCallback(
    (action: "next" | "prev" | "goto", n?: number) =>
      frame.current?.contentWindow?.postMessage(
        { source: "dock-host", type: "deck", action, n },
        "*",
      ),
    [],
  )
  const toggleFullscreen = () => {
    const el = presentWrap.current
    if (!el) return
    if (document.fullscreenElement) document.exitFullscreen()
    else el.requestFullscreen?.()
  }
  // Reset deck state when the artifact/version changes (re-announced on load).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the artifact/version change, not to anything the callback reads.
  useEffect(() => setDeck(null), [shortId, version])
  // Arrow keys drive the deck from the host (when not typing in a field).
  useEffect(() => {
    if (!deck) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return
      if (e.key === "ArrowRight") deckCmd("next")
      else if (e.key === "ArrowLeft") deckCmd("prev")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [deck, deckCmd])

  // Paint highlights for open, anchored threads whenever the doc or comments change.
  const sendAnchors = useCallback(() => {
    const w = frame.current?.contentWindow
    if (!w) return
    const anchors = groupThreads(comments)
      .filter((t) => t[0].state === "open")
      .map((t) => ({ id: t[0].thread_id, sel: parseAnchor(t[0].anchor) }))
      .filter((x): x is { id: string; sel: NonNullable<ReturnType<typeof parseAnchor>> } => !!x.sel)
      .map((x) => ({ id: x.id, exact: x.sel.exact, prefix: x.sel.prefix, suffix: x.sel.suffix }))
    w.postMessage({ source: "dock-host", type: "anchors", anchors }, "*")
  }, [comments])
  // biome-ignore lint/correctness/useExhaustiveDependencies: frameReady is an intentional repaint trigger (re-send anchors when the iframe reloads).
  useEffect(() => {
    sendAnchors()
  }, [sendAnchors, frameReady])

  // biome-ignore lint/correctness/useExhaustiveDependencies: clears transient selection when the artifact/version changes.
  useEffect(() => {
    setActiveThread(null)
    setComposer(null)
    setSel(null)
  }, [shortId, version])

  // Clicking a thread's quote scrolls the document to its highlight.
  const jumpTo = (threadId: string) => {
    setActiveThread(threadId)
    post({ type: "focus-anchor", id: threadId })
  }

  useEffect(() => {
    // Anonymous can view a public artifact (read-only, with a sign-up CTA). Only
    // bounce to login when it isn't readable for them (private / 404) — then an
    // account is required. A signed-in user with no access bounces the same way.
    if (!loading && !me && failed) nav({ to: "/login" })
  }, [loading, me, failed, nav])

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
  }, [comments, post])

  // Switching versions returns to the rendered preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets the view on a version/artifact change.
  useEffect(() => setView("preview"), [version, shortId])

  // In history mode, "show changes" diffs the version being viewed against the
  // current one — what's changed since this older version.
  useEffect(() => {
    if (view !== "diff" || !art) return
    const shownN = version ?? art.current_version
    if (shownN >= art.current_version) {
      setDiff(null)
      return
    }
    setDiff(null)
    let alive = true
    api
      .diff(shortId, shownN, art.current_version)
      .then((d) => alive && setDiff(d))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [view, version, art, shortId])

  if (failed) return <ArtifactNotFound onBack={() => nav({ to: "/" })} />
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
            show("Reinstated")
            load()
          } catch (e) {
            show((e as Error).message)
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
  const openThreads = all.filter((t) => t[0].state === "open")
  const resolvedThreads = all.filter((t) => t[0].state === "resolved")
  const pinned: PinItem[] = []
  const general: Comment[][] = []
  for (const t of openThreads) {
    const id = t[0].thread_id
    const hasAnchor = !!parseAnchor(t[0].anchor)
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
    addComment,
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
    proposeMsg,
    composer,
    sel,
    post,
    load,
    refetchComments,
    show,
    onRestoredJump: () => nav({ to: "/a/$ref", params: { ref: shortId } }),
    setEditing,
    setSrc,
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
            {!isMobile && <Presence viewers={live.viewers} self={me?.name ?? me?.email ?? ""} />}
            {!isAnon && (
              <ArtifactTopBar
                shortId={shortId}
                myRole={art.my_role}
                favorite={!!art.favorite}
                tags={art.tags ?? []}
                collections={art.collections ?? []}
                canEditTags={art.my_role === "editor" || art.my_role === "owner"}
                openProposals={art.open_proposals ?? 0}
                proposalsTotal={art.proposals_total ?? 0}
                isMobile={isMobile}
                panelOpen={panel === "open"}
                openCount={openCount}
                showEdit={editable && canPropose && !editing}
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
                onReport={show}
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
                title={art.title ?? shortId}
                proposeMsg={proposeMsg}
                src={src}
                onProposeMsg={setProposeMsg}
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
                cursorLayerRef={live.cursorLayer}
                onFrameLoad={() => setFrameReady((n) => n + 1)}
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

          {!isMobile && !isAnon && (
            <aside
              className={cn(
                "flex min-h-0 shrink-0 grow-0 flex-col overflow-hidden bg-card transition-[width,flex-basis] duration-200",
                panel !== "hidden" && "border-l border-border",
              )}
              style={{ width: asideWidth, flexBasis: asideWidth }}
            >
              {panel === "rail" ? (
                <Rail
                  pins={pinned}
                  generalCount={general.length}
                  active={activeThread}
                  onExpand={() => setPanel("open")}
                  onHide={() => setPanel("hidden")}
                  onDot={(id) => {
                    setPanel("open")
                    jumpTo(id)
                  }}
                />
              ) : (
                <OpenPanel
                  openCount={openCount}
                  pinned={pinned}
                  general={general}
                  resolved={resolvedThreads}
                  activeThread={activeThread}
                  hoverThread={hoverThread}
                  inDoc={inDoc}
                  composer={composer}
                  onMinimize={() => setPanel("rail")}
                  onHide={() => setPanel("hidden")}
                  onActivate={activate}
                  onHover={setHoverThread}
                  onResolve={toggleResolve}
                  onReply={reply}
                  onJump={jumpTo}
                  onNewGeneral={() => {
                    setComposer({ anchor: null, top: null })
                    setActiveThread(null)
                  }}
                  onSubmitNew={submitNew}
                  onCancelNew={() => {
                    setComposer(null)
                    setSel(null)
                  }}
                />
              )}
            </aside>
          )}
        </div>
        {/* Phones: comments live in a slide-up sheet that takes the bottom half,
          so the document stays visible above it. A flat thread list (no document
          margin); tapping a quote scrolls the visible document to the highlight
          without closing the sheet. The grip expands it to full for reading. */}
        {isMobile && !isAnon && (
          <MobileComments
            open={panel === "open"}
            openThreads={openThreads}
            resolved={resolvedThreads}
            openCount={openCount}
            composer={composer}
            activeThread={activeThread}
            inDoc={inDoc}
            onClose={() => {
              setPanel("hidden")
              setComposer(null)
              setSel(null)
            }}
            onNewGeneral={() => {
              setComposer({ anchor: null, top: null })
              setActiveThread(null)
            }}
            onActivate={activate}
            onResolve={toggleResolve}
            onReply={reply}
            onJump={jumpTo}
            onSubmitNew={submitNew}
            onCancelNew={() => {
              setComposer(null)
              setSel(null)
            }}
          />
        )}
        {/* The "comment on selection" affordance floats beside the selection in
          every panel state — minimized or hidden included. Clicking it opens
          the panel if needed and starts a composer pinned to the selection.
          Hidden for anon (commenting is logged-in only). */}
        {!isAnon && docLive && sel && !composer && (
          <button
            type="button"
            className="fixed z-50 inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-primary bg-card px-3.5 py-2 text-sm font-semibold text-primary shadow-[var(--shadow)] transition-colors hover:bg-primary hover:text-primary-foreground"
            title="Comment on the selection"
            data-testid="comment-on-selection"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (panel !== "open") setPanel("open")
              startSelComment()
            }}
            style={{
              // Float just above the selection, horizontally centered on it, so it
              // lands where the user is actually reading. Clamp into the document
              // column (left of the aside) and below the top header.
              top: clamp(sel.vTop - 44, 64, window.innerHeight - 52),
              left: clamp(
                (sel.vLeft + sel.vRight) / 2 - 60,
                12,
                window.innerWidth - asideWidth - 132,
              ),
            }}
          >
            <Icon name="comments" size={16} /> Comment
          </button>
        )}
        {toast}
      </ActionsCtx.Provider>
    </>
  )
}
