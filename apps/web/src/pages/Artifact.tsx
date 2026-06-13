import { useNavigate, useParams } from "@tanstack/react-router"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  type Analytics,
  API_BASE,
  type Artifact as Art,
  api,
  type Comment,
  type Diff,
} from "../api"
import { Header, useIsMobile, useToast } from "../components"
import { ReviewOverlay } from "../components/ReviewOverlay"
import { ShareButton } from "../components/ShareDialog"
import { useAuth } from "../ctx"

type Sel = { type?: string; exact: string; prefix?: string; suffix?: string }
type Panel = "open" | "rail" | "hidden"

const PANEL_KEY = "dock.comments.panel"
const loadPanel = (): Panel => {
  try {
    const v = localStorage.getItem(PANEL_KEY)
    return v === "rail" || v === "hidden" ? v : "open"
  } catch {
    return "open"
  }
}

const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const parseRef = (ref: string) => {
  const m = ref.match(/^([0-9a-z]{6,12})(?:-[a-z0-9-]*?)?(?:@v(\d+))?$/)
  return { shortId: m?.[1] ?? ref, version: m?.[2] ? Number(m[2]) : undefined }
}

export function Artifact() {
  const { ref } = useParams({ from: "/a/$ref" })
  const { shortId, version } = parseRef(ref)
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const { toast, show } = useToast()
  const isMobile = useIsMobile()

  const [art, setArt] = useState<Art | null>(null)
  const [failed, setFailed] = useState(false)
  const [comments, setComments] = useState<Comment[]>([])
  const [editing, setEditing] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [view, setView] = useState<"preview" | "diff">("preview")
  const [diff, setDiff] = useState<Diff | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [viewers, setViewers] = useState<string[]>([])
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
          const ft = frame.current?.getBoundingClientRect().top ?? 0
          setSel({
            selector: d.selector,
            top: d.rect.top,
            vTop: ft + d.rect.top,
            vBottom: ft + d.rect.bottom,
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
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

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
  const deckCmd = (action: "next" | "prev" | "goto", n?: number) =>
    frame.current?.contentWindow?.postMessage({ source: "dock-host", type: "deck", action, n }, "*")
  const toggleFullscreen = () => {
    const el = presentWrap.current
    if (!el) return
    if (document.fullscreenElement) document.exitFullscreen()
    else el.requestFullscreen?.()
  }
  // Reset deck state when the artifact/version changes (re-announced on load).
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
  }, [deck])

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
  useEffect(() => {
    sendAnchors()
  }, [sendAnchors, frameReady])

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
    if (!loading && !me) nav({ to: "/login" })
  }, [loading, me, nav])

  const load = useCallback(() => {
    api
      .getArtifact(shortId)
      .then((a) => {
        setArt(a)
        setFailed(false)
      })
      .catch(() => setFailed(true))
    api
      .listComments(shortId)
      .then((r) => setComments(r.comments))
      .catch(() => {})
  }, [shortId])
  useEffect(load, [load])

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

  // live updates
  useEffect(() => {
    const ev = new EventSource(`${API_BASE}/v1/artifacts/${shortId}/events`, {
      withCredentials: true,
    })
    const refresh = () =>
      api
        .listComments(shortId)
        .then((r) => setComments(r.comments))
        .catch(() => {})
    ev.addEventListener("comment.created", refresh)
    ev.addEventListener("comment.resolved", refresh)
    ev.addEventListener("comment.reacted", refresh)
    ev.addEventListener("comment.updated", refresh)
    ev.addEventListener("version.published", load)
    ev.addEventListener("presence", (e) => {
      try {
        setViewers((JSON.parse((e as MessageEvent).data).viewers as string[]) ?? [])
      } catch {
        /* ignore malformed frames */
      }
    })
    return () => ev.close()
  }, [shortId, load])

  // Announce we're viewing, and keep the heartbeat alive (TTL is 45s server-side).
  useEffect(() => {
    if (!me) return
    const name = me.name ?? me.email
    const beat = () =>
      api
        .heartbeat(shortId, name)
        .then((r) => setViewers(r.viewers))
        .catch(() => {})
    beat()
    const t = setInterval(beat, 20_000)
    return () => clearInterval(t)
  }, [shortId, me])

  // Record one view per artifact open.
  const recorded = useRef("")
  useEffect(() => {
    if (recorded.current === shortId) return
    recorded.current = shortId
    api.recordView(shortId).catch(() => {})
  }, [shortId])

  // Switching versions returns to the rendered preview.
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

  if (failed)
    return (
      <div style={{ minHeight: "100%" }}>
        <Header />
        <div className="center" style={{ height: "60vh", flexDirection: "column", gap: 10 }}>
          <div className="muted">Artifact not found, or you don't have access.</div>
          <button className="btn" onClick={() => nav({ to: "/" })}>
            Back to library
          </button>
        </div>
      </div>
    )
  if (!art)
    return (
      <div style={{ minHeight: "100%" }}>
        <Header />
        <div className="center" style={{ height: "60vh" }}>
          <div className="spin" />
        </div>
      </div>
    )

  const shown = version ?? art.current_version
  const editable = art.kind === "file" && shown === art.current_version
  const rawSrc = `${API_BASE}/raw/${shortId}/v/${shown}/index.html`
  // Editors publish directly; commenters propose a candidate for review.
  const canPublish = art.my_role === "editor" || art.my_role === "owner"
  const canPropose = canPublish || art.my_role === "commenter"

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

  const startEdit = async () => {
    setEditing(true)
    setSrc(await api.getContent(shortId))
  }
  const publishEdit = async () => {
    try {
      const a = await api.publishText(
        shortId,
        src,
        art.title ? `${art.short_id}.md` : "edit.md",
        "edited in browser",
      )
      show(`Published v${a.current_version}`)
      setEditing(false)
      load()
    } catch (e) {
      show((e as Error).message)
    }
  }
  // A commenter can't publish; their edit becomes a proposal for review.
  const proposeEdit = async () => {
    try {
      await api.propose(
        shortId,
        src,
        art.title ? `${art.short_id}.md` : "edit.md",
        "proposed change",
      )
      show("Proposed — sent for review")
      setEditing(false)
      load()
    } catch (e) {
      show((e as Error).message)
    }
  }
  const addComment = async (text: string, opts?: { threadId?: string; anchor?: Sel | null }) => {
    if (!text.trim()) return
    await api
      .comment(shortId, {
        body_md: text,
        thread_id: opts?.threadId,
        anchor: opts?.threadId ? undefined : (opts?.anchor ?? undefined),
      })
      .catch((e) => show((e as Error).message))
    api.listComments(shortId).then((r) => setComments(r.comments))
  }
  const reply = (text: string, threadId: string) => addComment(text, { threadId })
  const submitNew = async (text: string) => {
    await addComment(text, { anchor: composer?.anchor ?? null })
    setComposer(null)
    setSel(null)
  }
  const toggleResolve = async (root: Comment) => {
    await api.resolve(shortId, root.id, root.state === "open" ? "resolved" : "open")
    api.listComments(shortId).then((r) => setComments(r.comments))
  }
  const activate = (id: string) => {
    setActiveThread((cur) => (cur === id ? cur : id))
    post({ type: "emphasize", id })
  }
  const startSelComment = () => {
    if (!sel) return
    setComposer({ anchor: sel.selector, top: sel.top })
    setActiveThread(null)
  }
  const refetch = () =>
    api
      .listComments(shortId)
      .then((r) => setComments(r.comments))
      .catch(() => {})
  const actions: CommentActions = {
    meName: me?.name ?? me?.email ?? "",
    react: (commentId, emoji) => {
      // Optimistic: reflect the toggle immediately, reconcile on the response.
      setComments((cs) =>
        cs.map((c) =>
          c.id === commentId ? toggleReaction(c, emoji, me?.name ?? me?.email ?? "anonymous") : c,
        ),
      )
      api.react(shortId, commentId, emoji).then(refetch).catch(refetch)
    },
    edit: async (commentId, body) => {
      await api.editComment(shortId, commentId, body).catch((e) => show((e as Error).message))
      refetch()
    },
    remove: (commentId) => {
      api
        .deleteComment(shortId, commentId)
        .then(refetch)
        .catch((e) => show((e as Error).message))
    },
    copyLink: (threadId) => {
      const url = `${window.location.origin}${window.location.pathname}?c=${threadId}`
      navigator.clipboard
        ?.writeText(url)
        .then(() => show("Link copied"))
        .catch(() => show(url))
    },
  }
  const restore = async (n: number) => {
    setRestoring(true)
    try {
      const a = await api.restore(shortId, n)
      show(`Restored as v${a.current_version}`)
      nav({ to: "/a/$ref", params: { ref: shortId } }) // jump to the new current
      load()
    } catch (e) {
      show((e as Error).message)
    } finally {
      setRestoring(false)
    }
  }

  // On phones the comments live in a slide-up sheet, so the in-flow aside has
  // no width and the document gets the full screen.
  const asideWidth = isMobile ? 0 : panel === "open" ? 340 : panel === "rail" ? 50 : 0

  return (
    <ActionsCtx.Provider value={actions}>
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        {reviewing && (
          <ReviewOverlay
            shortId={shortId}
            currentVersion={art.current_version}
            myRole={art.my_role}
            meName={me?.name ?? me?.email ?? null}
            onClose={() => setReviewing(false)}
            onApplied={load}
          />
        )}
        <Header
          right={
            <>
              {!isMobile && <Presence viewers={viewers} self={me?.name ?? me?.email ?? ""} />}
              <StarButton
                shortId={shortId}
                favorite={!!art.favorite}
                onChange={(fav) => setArt((a) => (a ? { ...a, favorite: fav } : a))}
              />
              <TagsMenu
                shortId={shortId}
                tags={art.tags ?? []}
                canEdit={art.my_role === "editor" || art.my_role === "owner"}
                onChange={(tags) => setArt((a) => (a ? { ...a, tags } : a))}
              />
              <ShareButton shortId={shortId} myRole={art.my_role} />
              <Insights shortId={shortId} />
              <HistoryMenu
                art={art}
                shown={shown}
                goTo={(n) =>
                  nav({
                    to: "/a/$ref",
                    params: { ref: n === art.current_version ? shortId : `${shortId}@v${n}` },
                  })
                }
              />
              {!!art.open_proposals && art.open_proposals > 0 && (
                <button
                  className="btn sm"
                  onClick={() => setReviewing(true)}
                  style={{ gap: 6, borderColor: "var(--ac)", color: "var(--ac)" }}
                  title="Review proposed changes"
                >
                  Review <b style={{ fontWeight: 700 }}>{art.open_proposals}</b>
                </button>
              )}
              {editable && canPropose && !editing && (
                <button className="btn sm" onClick={startEdit}>
                  {canPublish ? "Edit" : "Propose"}
                </button>
              )}
              {/* On phones the bottom-right FAB opens comments, so the header
                button would just be a redundant extra wrap-row. */}
              {!isMobile && panel !== "open" && (
                <button
                  className="btn sm"
                  onClick={() => setPanel("open")}
                  style={{ gap: 6 }}
                  title="Show comments (c)"
                >
                  💬 {openCount > 0 && <b style={{ fontWeight: 700 }}>{openCount}</b>}
                </button>
              )}
            </>
          }
        />
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              position: "relative",
              // On phones, the comments sheet sits in the bottom half — reserve
              // that space so the document stays visible above it (and a
              // jumped-to highlight lands in view, not behind the sheet).
              paddingBottom: isMobile && panel === "open" ? "50vh" : undefined,
              transition: "padding-bottom .26s cubic-bezier(.4,0,.2,1)",
            }}
          >
            {editing ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  background: "var(--card)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "8px 12px",
                    borderBottom: "1px solid var(--line-soft)",
                    alignItems: "center",
                  }}
                >
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    editing source
                  </span>
                  <span style={{ flex: 1 }} />
                  <button className="btn sm" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                  {canPublish ? (
                    <button className="btn pri sm" onClick={publishEdit}>
                      Publish new version
                    </button>
                  ) : (
                    <button className="btn pri sm" onClick={proposeEdit}>
                      Propose change
                    </button>
                  )}
                </div>
                <textarea
                  className="mono"
                  value={src}
                  onChange={(e) => setSrc(e.target.value)}
                  spellCheck={false}
                  style={{
                    flex: 1,
                    border: 0,
                    resize: "none",
                    padding: "16px 20px",
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: "var(--fg)",
                    background: "var(--card)",
                    outline: "none",
                  }}
                />
              </div>
            ) : (
              <>
                {/* History-viewing banner: only when looking at a past version.
                  The current version just shows the artifact, no version chrome. */}
                {shown !== art.current_version && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      rowGap: 6,
                      gap: 10,
                      padding: "8px 14px",
                      borderBottom: "1px solid var(--line-soft)",
                      background: "var(--ac-soft)",
                      fontSize: 12.5,
                    }}
                  >
                    <span style={{ color: "var(--ac)", fontWeight: 600 }}>
                      Viewing an earlier version
                    </span>
                    <span className="muted">·</span>
                    <button
                      className="lnk"
                      onClick={() => setView(view === "diff" ? "preview" : "diff")}
                    >
                      {view === "diff" ? "Hide changes" : "Show changes since this"}
                    </button>
                    <span style={{ flex: 1 }} />
                    <button className="btn sm" onClick={() => restore(shown)} disabled={restoring}>
                      {restoring ? "Restoring…" : "Restore this version"}
                    </button>
                    <button
                      className="btn pri sm"
                      onClick={() => nav({ to: "/a/$ref", params: { ref: shortId } })}
                    >
                      Back to current
                    </button>
                  </div>
                )}
                {view === "diff" && shown !== art.current_version ? (
                  <DiffView diff={diff} fromLabel={`v${shown}`} toLabel="current" />
                ) : (
                  <div
                    ref={presentWrap}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      minHeight: 0,
                      position: "relative",
                      background: "#fff",
                    }}
                  >
                    <iframe
                      ref={frame}
                      onLoad={() => setFrameReady((n) => n + 1)}
                      title={art.title ?? shortId}
                      src={rawSrc}
                      allow="fullscreen"
                      sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
                      style={{ flex: 1, border: 0, background: "#fff" }}
                    />
                    {deck && (
                      <DeckBar
                        deck={deck}
                        onPrev={() => deckCmd("prev")}
                        onNext={() => deckCmd("next")}
                        onFullscreen={toggleFullscreen}
                      />
                    )}
                  </div>
                )}
              </>
            )}
            {panel === "hidden" && (
              <button
                onClick={() => setPanel("open")}
                title="Show comments (c)"
                style={{
                  position: "absolute",
                  right: 18,
                  bottom: 18,
                  height: 44,
                  borderRadius: 999,
                  border: "1px solid var(--line)",
                  background: "var(--card)",
                  color: "var(--fg)",
                  cursor: "pointer",
                  boxShadow: "var(--shadow)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0 16px",
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                <span style={{ fontSize: 15 }}>💬</span>
                {openCount > 0 ? `${openCount} comment${openCount === 1 ? "" : "s"}` : "Comments"}
              </button>
            )}
          </div>

          {!isMobile && (
            <aside
              style={{
                width: asideWidth,
                flex: `0 0 ${asideWidth}px`,
                borderLeft: panel === "hidden" ? "none" : "1px solid var(--line)",
                background: "var(--card)",
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
                overflow: "hidden",
                transition:
                  "width .22s cubic-bezier(.4,0,.2,1), flex-basis .22s cubic-bezier(.4,0,.2,1)",
              }}
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
        {isMobile && (
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
          the panel if needed and starts a composer pinned to the selection. */}
        {docLive && sel && !composer && (
          <button
            className="cmt-bubble"
            title="Comment on the selection"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (panel !== "open") setPanel("open")
              startSelComment()
            }}
            style={{
              position: "fixed",
              top: clamp((sel.vTop + sel.vBottom) / 2 - 15, 64, window.innerHeight - 46),
              right: asideWidth + 12,
              zIndex: 50,
            }}
          >
            💬 Comment
          </button>
        )}
        {toast}
      </div>
    </ActionsCtx.Provider>
  )
}

// Header star: toggle this artifact as a personal favorite. Optimistic.
function StarButton({
  shortId,
  favorite,
  onChange,
}: {
  shortId: string
  favorite: boolean
  onChange: (f: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    const next = !favorite
    onChange(next)
    setBusy(true)
    try {
      await api.favorite(shortId, next)
    } catch {
      onChange(!next)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      className="btn sm"
      onClick={toggle}
      disabled={busy}
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      aria-label="Toggle favorite"
      style={{
        color: favorite ? "#e0a93a" : undefined,
        borderColor: favorite ? "#e0a93a" : undefined,
      }}
    >
      {favorite ? "★" : "☆"}
    </button>
  )
}

// Header tags popover: view tags; editors add/remove. Writes replace the full
// set (the server normalizes: trim, lowercase, dedupe, cap).
function TagsMenu({
  shortId,
  tags,
  canEdit,
  onChange,
}: {
  shortId: string
  tags: string[]
  canEdit: boolean
  onChange: (t: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("click", h)
    return () => document.removeEventListener("click", h)
  }, [])
  const save = async (next: string[]) => {
    onChange(next)
    try {
      const r = await api.setTags(shortId, next)
      onChange(r.tags)
    } catch {
      /* keep the optimistic value */
    }
  }
  const add = () => {
    const v = draft.trim().toLowerCase()
    setDraft("")
    if (v && !tags.includes(v)) save([...tags, v])
  }
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn sm"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        style={{ gap: 6 }}
        title="Tags"
      >
        🏷 {tags.length > 0 && <b style={{ fontWeight: 700 }}>{tags.length}</b>}
      </button>
      {open && (
        <div
          className="card"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 7px)",
            width: 244,
            padding: 12,
            boxShadow: "var(--shadow)",
            zIndex: 30,
          }}
        >
          <div
            className="mono muted"
            style={{
              fontSize: 9.5,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Tags
          </div>
          {tags.length === 0 && (
            <div className="muted" style={{ fontSize: 12, marginBottom: canEdit ? 9 : 0 }}>
              {canEdit ? "No tags yet — add one below." : "No tags."}
            </div>
          )}
          {tags.length > 0 && (
            <div
              style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: canEdit ? 10 : 0 }}
            >
              {tags.map((t) => (
                <span key={t} className="tagchip" style={{ cursor: "default" }}>
                  #{t}
                  {canEdit && (
                    <button
                      onClick={() => save(tags.filter((x) => x !== t))}
                      aria-label={`Remove ${t}`}
                      style={{
                        border: 0,
                        background: "transparent",
                        color: "inherit",
                        cursor: "pointer",
                        padding: 0,
                        marginLeft: 2,
                        fontSize: 13,
                        lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {canEdit && (
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="input"
                value={draft}
                placeholder="Add a tag…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add()
                }}
                style={{ padding: "6px 9px", fontSize: 12.5 }}
              />
              <button className="btn sm" onClick={add} disabled={!draft.trim()}>
                Add
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Phones: a slide-up sheet over the document. The pinned document-margin is a
// desktop affordance (it needs a margin); here every open thread is a flat
// card with its quote, and tapping the quote jumps to the text + closes the
// sheet. Reuses CommentCard / Composer / ResolvedSection so behaviour (replies,
// reactions, edit/delete, resolve, re-anchoring) matches desktop exactly.
function MobileComments({
  open,
  openThreads,
  resolved,
  openCount,
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
  openThreads: Comment[][]
  resolved: Comment[][]
  openCount: number
  composer: { anchor: Sel | null; top: number | null } | null
  activeThread: string | null
  inDoc: Record<string, boolean>
  onClose: () => void
  onNewGeneral: () => void
  onActivate: (id: string) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string) => void
  onJump: (id: string) => void
  onSubmitNew: (text: string) => void
  onCancelNew: () => void
}) {
  // Half by default (document visible above). Reset to half each time it opens;
  // a composer wants room, so expand to full automatically.
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (open) setFull(false)
  }, [open])
  useEffect(() => {
    if (open && composer) setFull(true)
  }, [open, composer])
  const empty = openThreads.length === 0 && resolved.length === 0 && !composer
  // Jumping to text: collapse to half so the highlight lands in the visible doc.
  const jumpToText = (id: string) => {
    setFull(false)
    onJump(id)
  }
  return (
    <>
      {/* Backdrop only at full height (reading mode). At half the document above
          stays tappable/scrollable, so no dimming layer intercepts it. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismissal mirrors the ✕ button. */}
      <div
        className={`sheet-backdrop${open && full ? " show" : ""}`}
        onClick={onClose}
        aria-hidden
      />
      <div
        className={`sheet ${full ? "full" : "half"}${open ? " show" : ""}`}
        role="dialog"
        aria-label="Comments"
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: grip toggles height; ✕ closes. */}
        <div
          className="sheet-grip"
          onClick={() => setFull((f) => !f)}
          title={full ? "Collapse" : "Expand"}
        />
        <div className="sheet-head">
          <b style={{ fontSize: 14 }}>Comments</b>
          {openCount > 0 && (
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--cmt-tx)",
                background: "var(--cmt-bg)",
                borderRadius: 999,
                padding: "1px 8px",
                fontWeight: 700,
              }}
            >
              {openCount}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            className="btn sm"
            onClick={() => {
              setFull(true)
              onNewGeneral()
            }}
          >
            ＋ New
          </button>
          <IconBtn title={full ? "Collapse" : "Expand"} onClick={() => setFull((f) => !f)}>
            {full ? "▾" : "▴"}
          </IconBtn>
          <IconBtn title="Close comments" onClick={onClose}>
            ✕
          </IconBtn>
        </div>
        <div className="sheet-body">
          {composer && (
            <div style={{ marginBottom: 12 }}>
              <Composer
                quote={composer.anchor?.exact ?? null}
                onSubmit={onSubmitNew}
                onCancel={onCancelNew}
              />
            </div>
          )}
          {empty && (
            <div
              className="center"
              style={{ flexDirection: "column", gap: 8, padding: 34, textAlign: "center" }}
            >
              <div style={{ fontSize: 28, opacity: 0.5 }}>💬</div>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
                No comments yet.
                <br />
                Select text in the document to start one.
              </div>
            </div>
          )}
          {openThreads.map((t) => (
            <div key={t[0].thread_id} style={{ marginBottom: 10 }}>
              <CommentCard
                thread={t}
                active={activeThread === t[0].thread_id}
                hovered={false}
                present={inDoc[t[0].thread_id]}
                onActivate={onActivate}
                onHover={() => {}}
                onResolve={onResolve}
                onReply={onReply}
                onJump={jumpToText}
              />
            </div>
          ))}
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
      </div>
    </>
  )
}

type PinItem = { thread: Comment[]; desiredY: number; located: boolean }

// ---------------------------------------------------------------------------
// The open comments panel: header, the pinned margin, and the general/resolved
// lists below it.
// ---------------------------------------------------------------------------
function OpenPanel(props: {
  openCount: number
  pinned: PinItem[]
  general: Comment[][]
  resolved: Comment[][]
  activeThread: string | null
  hoverThread: string | null
  inDoc: Record<string, boolean>
  composer: { anchor: Sel | null; top: number | null } | null
  onMinimize: () => void
  onHide: () => void
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string) => void
  onJump: (id: string) => void
  onNewGeneral: () => void
  onSubmitNew: (text: string) => void
  onCancelNew: () => void
}) {
  const {
    openCount,
    pinned,
    general,
    resolved,
    activeThread,
    hoverThread,
    inDoc,
    composer,
    onMinimize,
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
  const generalComposer = composer && !composer.anchor
  const empty = openCount === 0 && resolved.length === 0 && !composer

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 8px 10px 14px",
          borderBottom: "1px solid var(--line-soft)",
        }}
      >
        <b style={{ fontSize: 13 }}>Comments</b>
        {openCount > 0 && (
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--cmt-tx)",
              background: "var(--cmt-bg)",
              borderRadius: 999,
              padding: "1px 8px",
              fontWeight: 700,
            }}
          >
            {openCount}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <IconBtn title="New comment" onClick={onNewGeneral}>
          ＋
        </IconBtn>
        <IconBtn title="Minimize to rail (c)" onClick={onMinimize}>
          ⟩
        </IconBtn>
        <IconBtn title="Hide comments" onClick={onHide}>
          ✕
        </IconBtn>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
        {/* Pinned margin — cards (and a new-comment composer) float beside their
            highlighted text, sharing one overlap-free layout. */}
        <PinnedZone
          pins={pinned}
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
          <div
            className="center"
            style={{
              position: "absolute",
              inset: 0,
              flexDirection: "column",
              gap: 8,
              padding: 24,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 26, opacity: 0.5 }}>💬</div>
            <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              No comments yet.
              <br />
              Select text in the document to start one.
            </div>
          </div>
        )}
      </div>

      {/* General + resolved threads live in a scrollable footer drawer. */}
      {(generalComposer || general.length > 0 || resolved.length > 0) && (
        <div
          style={{
            flex: "0 0 auto",
            maxHeight: "44%",
            overflow: "auto",
            borderTop: "1px solid var(--line-soft)",
            padding: 10,
          }}
        >
          {generalComposer && (
            <div style={{ marginBottom: 10 }}>
              <Composer quote={null} onSubmit={onSubmitNew} onCancel={onCancelNew} />
            </div>
          )}
          {general.length > 0 && (
            <>
              <SectionLabel>General</SectionLabel>
              {general.map((t) => (
                <div key={t[0].thread_id} style={{ marginBottom: 9 }}>
                  <CommentCard
                    thread={t}
                    active={activeThread === t[0].thread_id}
                    hovered={hoverThread === t[0].thread_id}
                    present={inDoc[t[0].thread_id]}
                    onActivate={onActivate}
                    onHover={onHover}
                    onResolve={onResolve}
                    onReply={onReply}
                    onJump={onJump}
                  />
                </div>
              ))}
            </>
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
const COMPOSER_ID = "__composer__"

function PinnedZone({
  pins,
  composer,
  activeThread,
  hoverThread,
  inDoc,
  onActivate,
  onHover,
  onResolve,
  onReply,
  onJump,
  onSubmitNew,
  onCancelNew,
}: {
  pins: PinItem[]
  composer: { anchor: Sel | null; top: number | null } | null
  activeThread: string | null
  hoverThread: string | null
  inDoc: Record<string, boolean>
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string) => void
  onJump: (id: string) => void
  onSubmitNew: (text: string) => void
  onCancelNew: () => void
}) {
  const [heights, setHeights] = useState<Record<string, number>>({})
  const obs = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    obs.current = new ResizeObserver((entries) => {
      setHeights((h) => {
        let changed = false
        const next = { ...h }
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.pin
          if (!id) continue
          const hh = Math.round((e.target as HTMLElement).offsetHeight)
          if (next[id] !== hh) {
            next[id] = hh
            changed = true
          }
        }
        return changed ? next : h
      })
    })
    return () => obs.current?.disconnect()
  }, [])
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (el) obs.current?.observe(el)
  }, [])

  // A composer for a new anchored comment joins the same layout as a pinned
  // item that owns priority, so neighbouring cards flow around it instead of
  // colliding with it.
  const composing = !!(composer?.anchor && composer?.top != null)
  const items = pins.map((p) => ({ id: p.thread[0].thread_id, desiredY: p.desiredY }))
  if (composing) items.push({ id: COMPOSER_ID, desiredY: composer!.top! })
  const activeId = composing ? COMPOSER_ID : activeThread
  const pos = layoutPins(items, heights, activeId, 12)

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {pins.map((p) => {
        const id = p.thread[0].thread_id
        const active = !composing && activeThread === id
        const y = pos[id] ?? p.desiredY
        return (
          <div
            key={id}
            ref={measure}
            data-pin={id}
            style={{
              position: "absolute",
              left: 10,
              right: 10,
              top: 0,
              transform: `translateY(${Math.round(y)}px)`,
              transition: "transform .18s cubic-bezier(.4,0,.2,1)",
              zIndex: active ? 6 : hoverThread === id ? 4 : 2,
              opacity: p.located ? 1 : 0,
            }}
          >
            <CommentCard
              thread={p.thread}
              active={active}
              hovered={hoverThread === id}
              present={inDoc[id]}
              onActivate={onActivate}
              onHover={onHover}
              onResolve={onResolve}
              onReply={onReply}
              onJump={onJump}
            />
          </div>
        )
      })}
      {composing && (
        <div
          ref={measure}
          data-pin={COMPOSER_ID}
          style={{
            position: "absolute",
            left: 10,
            right: 10,
            top: 0,
            transform: `translateY(${Math.round(pos[COMPOSER_ID] ?? composer!.top!)}px)`,
            transition: "transform .18s cubic-bezier(.4,0,.2,1)",
            zIndex: 10,
          }}
        >
          <Composer
            quote={composer!.anchor?.exact ?? null}
            onSubmit={onSubmitNew}
            onCancel={onCancelNew}
          />
        </div>
      )}
    </div>
  )
}

// Stack a set of cards by desired Y without overlap. The active card is pinned
// to its exact anchor and its neighbours are pushed up/down to make room.
function layoutPins(
  items: { id: string; desiredY: number }[],
  heights: Record<string, number>,
  activeId: string | null,
  gap: number,
): Record<string, number> {
  const sorted = [...items].sort((a, b) => a.desiredY - b.desiredY)
  const h = (id: string) => heights[id] ?? 116
  const pos: Record<string, number> = {}
  let prevBottom = -1e9
  for (const it of sorted) {
    const y = Math.max(it.desiredY, prevBottom + gap)
    pos[it.id] = y
    prevBottom = y + h(it.id)
  }
  const idx = activeId ? sorted.findIndex((s) => s.id === activeId) : -1
  if (idx >= 0) {
    const act = sorted[idx]
    pos[act.id] = act.desiredY
    let limit = act.desiredY
    for (let i = idx - 1; i >= 0; i--) {
      const it = sorted[i]
      if (pos[it.id] + h(it.id) + gap > limit) pos[it.id] = limit - gap - h(it.id)
      limit = pos[it.id]
    }
    let top = act.desiredY + h(act.id)
    for (let i = idx + 1; i < sorted.length; i++) {
      const it = sorted[i]
      if (pos[it.id] < top + gap) pos[it.id] = top + gap
      top = pos[it.id] + h(it.id)
    }
  }
  return pos
}

// One comment thread. Compact until activated; the active card shows the full
// thread, a reply box, and resolve controls.
// ---- Rich comment actions: reactions, edit, delete, copy-link --------------
// Threaded through one context so the deep card tree doesn't re-pass them.
type CommentActions = {
  meName: string
  react: (commentId: string, emoji: string) => void
  edit: (commentId: string, body: string) => Promise<void> | void
  remove: (commentId: string) => void
  copyLink: (threadId: string) => void
}
const NOOP_ACTIONS: CommentActions = {
  meName: "",
  react: () => {},
  edit: () => {},
  remove: () => {},
  copyLink: () => {},
}
const ActionsCtx = createContext<CommentActions | null>(null)
const useActions = (): CommentActions => useContext(ActionsCtx) ?? NOOP_ACTIONS

const REACTION_EMOJI = ["👍", "❤️", "🎉", "😄", "👀", "🙏", "🚀", "👎"]

// Optimistic local toggle that mirrors the server's react logic.
function toggleReaction(c: Comment, emoji: string, who: string): Comment {
  const reactions: Record<string, string[]> = { ...(c.reactions ?? {}) }
  const arr = [...(reactions[emoji] ?? [])]
  const i = arr.indexOf(who)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(who)
  if (arr.length) reactions[emoji] = arr
  else delete reactions[emoji]
  return { ...c, reactions }
}

// Tiny, XSS-safe inline markdown: escape first, then a few transforms. Covers
// bold, italic, inline code, links/autolinks, and line breaks.
const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string,
  )
function mdToHtml(src: string): string {
  let h = esc(src)
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>")
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
  h = h.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  )
  h = h.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
  )
  return h.replace(/\n/g, "<br/>")
}

// Stable per-author tint, so people are recognisable across avatars + threads.
const AUTHOR_TINTS = [
  "#7c6cbd",
  "#3c6e2f",
  "#a04425",
  "#2f6e6e",
  "#9a5fb0",
  "#b08322",
  "#4a63b8",
  "#9a4a6b",
]
function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AUTHOR_TINTS[h % AUTHOR_TINTS.length]
}

function ColoredAvatar({ name, size = 17 }: { name: string; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: colorFor(name),
        color: "#fff",
        display: "grid",
        placeItems: "center",
        fontSize: Math.round(size * 0.5),
        fontWeight: 700,
        fontFamily: "ui-monospace,Menlo,monospace",
        flex: "0 0 auto",
      }}
    >
      {(name || "?").slice(0, 2).toUpperCase()}
    </span>
  )
}

// Small popover that closes on an outside click.
function Popover({
  children,
  onClose,
  style,
}: {
  children: React.ReactNode
  onClose: () => void
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const t = setTimeout(() => document.addEventListener("mousedown", h), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener("mousedown", h)
    }
  }, [onClose])
  return (
    <div ref={ref} className="cmt-pop" style={style} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  )
}

// One comment: avatar, author, markdown body (or an inline editor), reaction
// pills, and a hover toolbar (react · more → edit/delete/copy-link).
function CommentRow({ c, compact }: { c: Comment; compact?: boolean }) {
  const A = useActions()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(c.body_md)
  const [open, setOpen] = useState<null | "react" | "menu">(null)
  const mine = !!A.meName && c.author === A.meName
  const reactions = c.reactions ?? {}
  const close = () => setOpen(null)

  if (c.deleted)
    return (
      <div
        style={{
          padding: "9px 12px",
          borderBottom: compact ? "none" : "1px solid var(--line-soft)",
        }}
      >
        <span className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>
          Comment deleted
        </span>
      </div>
    )

  return (
    <div
      className="cmt-row"
      style={{
        padding: "10px 12px",
        borderBottom: compact ? "none" : "1px solid var(--line-soft)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
        <ColoredAvatar name={c.author} />
        <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--cmt-tx)" }}>{c.author}</span>
        <span className="mono muted" style={{ marginLeft: "auto", fontSize: 9 }}>
          {ago(c.created_at)}
          {c.edited ? " · edited" : ""}
        </span>
      </div>

      {editing ? (
        <div onClick={(e) => e.stopPropagation()}>
          <textarea
            className="input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            style={{ minHeight: 52, fontSize: 12.5, resize: "vertical" }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setEditing(false)
                setDraft(c.body_md)
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
                void A.edit(c.id, draft)
                setEditing(false)
              }
            }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              className="btn pri sm"
              disabled={!draft.trim()}
              onClick={async () => {
                await A.edit(c.id, draft)
                setEditing(false)
              }}
            >
              Save
            </button>
            <button
              className="btn sm"
              onClick={() => {
                setEditing(false)
                setDraft(c.body_md)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`cmt-body${compact ? " cmt-clamp" : ""}`}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: input is escaped first in mdToHtml.
          dangerouslySetInnerHTML={{ __html: mdToHtml(c.body_md) }}
        />
      )}

      {Object.keys(reactions).length > 0 && (
        <div className="cmt-pills">
          {Object.entries(reactions).map(([emoji, who]) => (
            <button
              key={emoji}
              className={`cmt-pill${who.includes(A.meName) ? " on" : ""}`}
              title={who.join(", ")}
              onClick={(e) => {
                e.stopPropagation()
                A.react(c.id, emoji)
              }}
            >
              <span>{emoji}</span>
              <span className="n">{who.length}</span>
            </button>
          ))}
        </div>
      )}

      {!editing && (
        <div className={`cmt-actions${open ? " pin" : ""}`} onClick={(e) => e.stopPropagation()}>
          <button
            className="cmt-act"
            title="React"
            onClick={() => setOpen(open === "react" ? null : "react")}
          >
            😊
          </button>
          <button
            className="cmt-act"
            title="More"
            onClick={() => setOpen(open === "menu" ? null : "menu")}
          >
            ⋯
          </button>
          {open === "react" && (
            <Popover onClose={close} style={{ top: 30, right: 0 }}>
              <div className="cmt-emoji">
                {REACTION_EMOJI.map((em) => (
                  <button
                    key={em}
                    onClick={() => {
                      A.react(c.id, em)
                      close()
                    }}
                  >
                    {em}
                  </button>
                ))}
              </div>
            </Popover>
          )}
          {open === "menu" && (
            <Popover onClose={close} style={{ top: 30, right: 0, minWidth: 132 }}>
              <div className="cmt-menu">
                {mine && (
                  <button
                    onClick={() => {
                      setEditing(true)
                      close()
                    }}
                  >
                    ✎ Edit
                  </button>
                )}
                <button
                  onClick={() => {
                    A.copyLink(c.thread_id)
                    close()
                  }}
                >
                  🔗 Copy link
                </button>
                {mine && (
                  <button
                    className="danger"
                    onClick={() => {
                      A.remove(c.id)
                      close()
                    }}
                  >
                    🗑 Delete
                  </button>
                )}
              </div>
            </Popover>
          )}
        </div>
      )}
    </div>
  )
}

// One comment thread. Compact until activated; the active card shows the full
// thread, a reply box, and resolve controls.
function CommentCard({
  thread,
  active,
  hovered,
  present,
  onActivate,
  onHover,
  onResolve,
  onReply,
  onJump,
}: {
  thread: Comment[]
  active: boolean
  hovered: boolean
  present?: boolean
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string) => void
  onJump: (id: string) => void
}) {
  const [reply, setReply] = useState("")
  const root = thread[0]
  const resolved = root.state === "resolved"
  const quote = anchorExact(root.anchor)
  const textPresent = present !== undefined ? present : root.anchored !== false
  const replies = thread.length - 1

  return (
    <div
      onMouseEnter={() => onHover(root.thread_id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => !active && onActivate(root.thread_id)}
      className="card cmt-card"
      style={{
        overflow: "hidden",
        cursor: active ? "default" : "pointer",
        opacity: resolved && !active ? 0.62 : 1,
        borderColor: active ? "var(--ac)" : hovered ? "var(--cmt-bd)" : "var(--line)",
        boxShadow: active ? "var(--shadow)" : hovered ? "0 4px 14px -8px rgba(0,0,0,.45)" : "none",
        transition: "box-shadow .15s, border-color .15s",
      }}
    >
      {quote &&
        (textPresent && !resolved ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onJump(root.thread_id)
            }}
            title="Jump to the highlighted text"
            className="cmt-quote"
            style={{
              borderLeft: "3px solid var(--ac)",
              background: "var(--ac-soft)",
              color: "var(--fg)",
              cursor: "pointer",
            }}
          >
            “{quote}”
          </button>
        ) : (
          <div
            title="The text this comment was attached to was edited or removed in this version"
            className="cmt-quote"
            style={{
              borderLeft: "3px solid var(--line)",
              background: "var(--card-2)",
              color: "var(--fg-mut)",
            }}
          >
            “{quote}”
          </div>
        ))}

      {!active ? (
        <>
          <CommentRow c={root} compact />
          {replies > 0 && (
            <div
              className="mono"
              style={{ padding: "0 12px 9px", fontSize: 10, color: "var(--ac)", fontWeight: 700 }}
            >
              {replies} repl{replies === 1 ? "y" : "ies"}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ maxHeight: 360, overflow: "auto" }}>
            {thread.map((c) => (
              <CommentRow key={c.id} c={c} />
            ))}
          </div>
          <div
            style={{
              display: "flex",
              gap: 6,
              padding: "8px 12px",
              borderTop: "1px solid var(--line-soft)",
            }}
          >
            <input
              className="input"
              style={{ padding: "6px 9px", fontSize: 12 }}
              value={reply}
              placeholder="Reply…"
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && reply.trim()) {
                  onReply(reply, root.thread_id)
                  setReply("")
                }
              }}
            />
            <button
              className="btn sm"
              disabled={!reply.trim()}
              onClick={(e) => {
                e.stopPropagation()
                if (reply.trim()) {
                  onReply(reply, root.thread_id)
                  setReply("")
                }
              }}
            >
              Reply
            </button>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "7px 12px",
              background: "var(--card-2)",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: 999,
                background: resolved ? "var(--good-bg)" : "var(--ac-soft)",
                color: resolved ? "var(--good)" : "var(--ac)",
              }}
            >
              {resolved ? "resolved" : "open"}
            </span>
            {quote && !textPresent && !resolved && (
              <span
                className="mono"
                title="The text this comment was attached to was edited or removed in this version"
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "var(--cmt-bg)",
                  color: "var(--cmt-tx)",
                }}
              >
                text changed
              </span>
            )}
            <button
              className="btn sm"
              style={{ marginLeft: "auto" }}
              onClick={(e) => {
                e.stopPropagation()
                onResolve(root)
              }}
            >
              {resolved ? "Reopen" : "Resolve"}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function ResolvedSection({
  threads,
  activeThread,
  hoverThread,
  onActivate,
  onHover,
  onResolve,
  onReply,
  onJump,
}: {
  threads: Comment[][]
  activeThread: string | null
  hoverThread: string | null
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string) => void
  onJump: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          border: 0,
          background: "transparent",
          cursor: "pointer",
          color: "var(--fg-mut)",
          padding: "5px 2px",
          font: "700 9.5px ui-monospace,Menlo,monospace",
          letterSpacing: ".06em",
          textTransform: "uppercase",
        }}
      >
        <span style={{ transition: "transform .15s", transform: open ? "rotate(90deg)" : "none" }}>
          ▸
        </span>
        Resolved ({threads.length})
      </button>
      {open &&
        threads.map((t) => (
          <div key={t[0].thread_id} style={{ marginBottom: 9 }}>
            <CommentCard
              thread={t}
              active={activeThread === t[0].thread_id}
              hovered={hoverThread === t[0].thread_id}
              onActivate={onActivate}
              onHover={onHover}
              onResolve={onResolve}
              onReply={onReply}
              onJump={onJump}
            />
          </div>
        ))}
    </div>
  )
}

// New-comment composer (anchored or general).
function Composer({
  quote,
  onSubmit,
  onCancel,
}: {
  quote: string | null
  onSubmit: (t: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    ref.current?.focus()
  }, [])
  const submit = () => {
    if (text.trim()) onSubmit(text)
  }
  return (
    <div
      className="card"
      style={{ boxShadow: "var(--shadow)", borderColor: "var(--ac)", overflow: "hidden" }}
    >
      {quote && (
        <div
          className="cmt-quote"
          style={{
            borderLeft: "3px solid var(--ac)",
            background: "var(--ac-soft)",
            color: "var(--fg)",
            fontStyle: "italic",
          }}
        >
          “{quote}”
        </div>
      )}
      <div style={{ padding: 9 }}>
        <textarea
          ref={ref}
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={quote ? "Comment on the selection…" : "Add a comment…"}
          style={{ minHeight: 56, resize: "vertical", fontSize: 12.5 }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit()
            if (e.key === "Escape") onCancel()
          }}
        />
        <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
          <button
            className="btn pri sm"
            disabled={!text.trim()}
            onClick={submit}
            style={{ flex: 1, justifyContent: "center" }}
          >
            Comment
          </button>
          <button className="btn sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// Collapsed rail: a thin column of dots, each beside its comment's text.
function Rail({
  pins,
  generalCount,
  active,
  onExpand,
  onHide,
  onDot,
}: {
  pins: PinItem[]
  generalCount: number
  active: string | null
  onExpand: () => void
  onHide: () => void
  onDot: (id: string) => void
}) {
  const [h, setH] = useState(600)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el) setH(el.clientHeight)
  }, [])
  const total = pins.length + generalCount
  return (
    <>
      <button
        onClick={onExpand}
        title="Expand comments (c)"
        className="rail-top"
        style={{ borderBottom: "1px solid var(--line-soft)" }}
      >
        <span style={{ fontSize: 13 }}>⟨</span>
        {total > 0 && (
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              color: "var(--cmt-tx)",
              background: "var(--cmt-bg)",
              borderRadius: 999,
              padding: "1px 5px",
            }}
          >
            {total}
          </span>
        )}
      </button>
      <div ref={ref} style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {pins.map((p) => {
          const id = p.thread[0].thread_id
          const isActive = active === id
          return (
            <button
              key={id}
              onClick={() => onDot(id)}
              title={p.thread[0].body_md}
              style={{
                position: "absolute",
                left: "50%",
                top: clamp(p.desiredY + 6, 10, h - 14),
                transform: "translateX(-50%)",
                width: isActive ? 14 : 10,
                height: isActive ? 14 : 10,
                borderRadius: "50%",
                border: "2px solid var(--card)",
                background: "var(--ac)",
                cursor: "pointer",
                padding: 0,
                boxShadow: isActive ? "0 0 0 3px var(--ac-soft)" : "none",
                transition: "width .12s, height .12s, transform .18s",
                opacity: p.located ? 1 : 0.4,
              }}
            />
          )
        })}
      </div>
      <button
        onClick={onHide}
        title="Hide comments"
        className="rail-top"
        style={{ borderTop: "1px solid var(--line-soft)", color: "var(--fg-mut)" }}
      >
        ✕
      </button>
    </>
  )
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        display: "grid",
        placeItems: "center",
        border: 0,
        background: "transparent",
        color: "var(--fg-mut)",
        borderRadius: 7,
        cursor: "pointer",
        fontSize: 13,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--hover)"
        e.currentTarget.style.color = "var(--fg)"
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent"
        e.currentTarget.style.color = "var(--fg-mut)"
      }}
    >
      {children}
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 9.5,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        color: "var(--fg-mut)",
        padding: "2px 2px 6px",
      }}
    >
      {children}
    </div>
  )
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// Who is viewing right now. Live over the presence SSE channel; self listed
// first as "you". Hidden when you're the only one here.
// Host presentation bar — shown when the artifact is a slide deck. Drives the
// deck over postMessage and fullscreens the wrapper (controls stay reachable).
function DeckBar({
  deck,
  onPrev,
  onNext,
  onFullscreen,
}: {
  deck: { i: number; total: number }
  onPrev: () => void
  onNext: () => void
  onFullscreen: () => void
}) {
  const btn: React.CSSProperties = {
    width: 30,
    height: 30,
    borderRadius: 8,
    border: "1px solid var(--line)",
    background: "var(--card)",
    color: "var(--fg)",
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
    fontSize: 15,
  }
  return (
    <div
      style={{
        position: "absolute",
        bottom: 14,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: 6,
        borderRadius: 999,
        background: "var(--card)",
        border: "1px solid var(--line)",
        boxShadow: "var(--shadow)",
        zIndex: 5,
      }}
    >
      <button style={btn} onClick={onPrev} disabled={deck.i <= 0} aria-label="Previous slide">
        ‹
      </button>
      <span
        className="mono"
        style={{ fontSize: 12, color: "var(--fg-mut)", minWidth: 52, textAlign: "center" }}
      >
        {deck.i + 1} / {deck.total}
      </span>
      <button
        style={btn}
        onClick={onNext}
        disabled={deck.i >= deck.total - 1}
        aria-label="Next slide"
      >
        ›
      </button>
      <button
        style={{ ...btn, marginLeft: 4 }}
        onClick={onFullscreen}
        title="Present (fullscreen)"
        aria-label="Present fullscreen"
      >
        ⛶
      </button>
    </div>
  )
}

function Presence({ viewers, self }: { viewers: string[]; self: string }) {
  const others = viewers.filter((v) => v !== self)
  if (others.length === 0) return null
  const ordered = [self, ...others].filter(Boolean)
  const shown = ordered.slice(0, 4)
  const extra = ordered.length - shown.length
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 7 }}
      title={`${ordered.length} viewing: ${ordered.join(", ")}`}
    >
      <div style={{ display: "flex" }}>
        {shown.map((name, i) => (
          <span
            key={name}
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: name === self ? "var(--ac)" : "var(--cmt-bg)",
              color: name === self ? "var(--ac-fg)" : "var(--cmt-tx)",
              border: "2px solid var(--card)",
              marginLeft: i === 0 ? 0 : -7,
              display: "grid",
              placeItems: "center",
              fontSize: 9,
              fontWeight: 700,
              fontFamily: "ui-monospace,Menlo,monospace",
            }}
          >
            {(name || "?").slice(0, 2).toUpperCase()}
          </span>
        ))}
      </div>
      <span
        className="mono muted"
        style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}
      >
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--good)" }} />
        {ordered.length} viewing{extra > 0 ? ` (+${extra})` : ""}
      </span>
    </div>
  )
}

// View analytics popover: totals, a 30-day sparkline, per-version split, and the
// most-recent viewers. Lazy — fetched when opened. Hidden if analytics is off.
function Insights({ shortId }: { shortId: string }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Analytics | null>(null)
  const [off, setOff] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("click", h)
    return () => document.removeEventListener("click", h)
  }, [])
  useEffect(() => {
    if (open && !data && !off)
      api
        .analytics(shortId)
        .then(setData)
        .catch(() => setOff(true))
  }, [open, data, off, shortId])
  if (off) return null
  const max = data ? Math.max(1, ...data.daily.map((d) => d.count)) : 1
  const maxV = data ? Math.max(1, ...data.perVersion.map((v) => v.count)) : 1
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn sm"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        style={{ gap: 6 }}
        title="View analytics"
      >
        <span style={{ fontSize: 12 }}>👁</span>
        {data ? data.total.toLocaleString() : "Insights"}
      </button>
      {open && (
        <div
          className="card"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 7px)",
            width: 300,
            padding: 14,
            boxShadow: "var(--shadow)",
            zIndex: 30,
          }}
        >
          {!data ? (
            <div className="center" style={{ height: 80 }}>
              <div className="spin" />
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 18, marginBottom: 12 }}>
                <div>
                  <div className="display" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>
                    {data.total.toLocaleString()}
                  </div>
                  <div className="mono muted" style={{ fontSize: 10 }}>
                    views
                  </div>
                </div>
                <div>
                  <div className="display" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>
                    {data.unique.toLocaleString()}
                  </div>
                  <div className="mono muted" style={{ fontSize: 10 }}>
                    unique
                  </div>
                </div>
              </div>
              <div
                className="mono muted"
                style={{
                  fontSize: 9.5,
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                  marginBottom: 5,
                }}
              >
                Last 30 days
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 2,
                  height: 40,
                  marginBottom: 12,
                }}
              >
                {data.daily.length === 0 ? (
                  <span className="muted" style={{ fontSize: 11 }}>
                    No views yet.
                  </span>
                ) : (
                  data.daily.map((d) => (
                    <div
                      key={d.day}
                      title={`${d.day}: ${d.count}`}
                      style={{
                        flex: 1,
                        minWidth: 2,
                        height: `${(d.count / max) * 100}%`,
                        background: "var(--ac)",
                        borderRadius: 2,
                        opacity: 0.85,
                      }}
                    />
                  ))
                )}
              </div>
              {data.perVersion.length > 0 && (
                <>
                  <div
                    className="mono muted"
                    style={{
                      fontSize: 9.5,
                      letterSpacing: ".06em",
                      textTransform: "uppercase",
                      marginBottom: 5,
                    }}
                  >
                    By version
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    {data.perVersion.map((v) => (
                      <div
                        key={v.version}
                        style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}
                      >
                        <span
                          className="mono"
                          style={{ fontSize: 10.5, width: 22, color: "var(--fg-mut)" }}
                        >
                          v{v.version}
                        </span>
                        <div
                          style={{
                            flex: 1,
                            height: 6,
                            background: "var(--card-2)",
                            borderRadius: 999,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${(v.count / maxV) * 100}%`,
                              height: "100%",
                              background: "var(--ac)",
                              borderRadius: 999,
                            }}
                          />
                        </div>
                        <span
                          className="mono muted"
                          style={{ fontSize: 10, width: 30, textAlign: "right" }}
                        >
                          {v.count}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {data.recent.length > 0 && (
                <>
                  <div
                    className="mono muted"
                    style={{
                      fontSize: 9.5,
                      letterSpacing: ".06em",
                      textTransform: "uppercase",
                      marginBottom: 5,
                    }}
                  >
                    Recent viewers
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {data.recent.map((r) => (
                      <div
                        key={r.viewer}
                        style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5 }}
                      >
                        <span
                          style={{
                            width: 17,
                            height: 17,
                            borderRadius: "50%",
                            background: r.kind === "user" ? "var(--ac-soft)" : "var(--card-2)",
                            color: "var(--fg-mut)",
                            display: "grid",
                            placeItems: "center",
                            fontSize: 8,
                            fontWeight: 700,
                            fontFamily: "ui-monospace,Menlo,monospace",
                          }}
                        >
                          {r.kind === "user" ? (r.viewer || "?").slice(0, 2).toUpperCase() : "·"}
                        </span>
                        <span
                          style={{
                            flex: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.kind === "user" ? r.viewer : "Anonymous"}
                        </span>
                        <span className="mono muted" style={{ fontSize: 9.5 }}>
                          {ago(r.at)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Quiet, Docs-style history: the header shows only "Edited {ago}". The dropdown
// lists time-grouped sessions (named checkpoints pinned with a star), not every
// raw revision — version chrome stays out of the way.
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
const dayLabel = (iso: string): string => {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return "Today"
  if (same(d, y)) return "Yesterday"
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function HistoryMenu({ art, shown, goTo }: { art: Art; shown: number; goTo: (n: number) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("click", h)
    return () => document.removeEventListener("click", h)
  }, [])
  const sessions =
    art.sessions ??
    [...art.versions]
      .sort((a, b) => b.n - a.n)
      .map((v) => ({
        n: v.n,
        from_n: v.n,
        count: 1,
        author: v.author,
        name: v.name,
        created_at: v.created_at,
      }))
  const latest = sessions[0]
  let lastDay = ""
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn sm"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        style={{ gap: 6 }}
        title="Version history"
      >
        {latest ? `Edited ${ago(latest.created_at)}` : "History"}
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div
          className="card"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 7px)",
            width: 286,
            padding: 6,
            boxShadow: "var(--shadow)",
            zIndex: 30,
            maxHeight: 400,
            overflow: "auto",
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--fg-mut)",
              padding: "6px 8px 4px",
            }}
          >
            Version history
          </div>
          {sessions.map((s) => {
            const cur = s.n === shown
            const day = dayLabel(s.created_at)
            const header = day !== lastDay ? day : null
            if (header !== null) lastDay = day
            return (
              <div key={s.n}>
                {header && (
                  <div
                    className="mono muted"
                    style={{
                      fontSize: 9,
                      letterSpacing: ".05em",
                      textTransform: "uppercase",
                      padding: "8px 9px 3px",
                    }}
                  >
                    {header}
                  </div>
                )}
                <button
                  onClick={() => {
                    goTo(s.n)
                    setOpen(false)
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    border: 0,
                    background: cur ? "var(--ac-soft)" : "transparent",
                    borderRadius: 7,
                    padding: "7px 9px",
                    cursor: "pointer",
                    marginBottom: 1,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ color: s.name ? "var(--ac)" : "var(--fg-mut)", fontSize: 11 }}>
                      {s.name ? "★" : "●"}
                    </span>
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: cur ? "var(--ac)" : "var(--fg)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.name ?? clock(s.created_at)}
                    </span>
                    {s.n === art.current_version && (
                      <span
                        className="mono"
                        style={{
                          fontSize: 8.5,
                          fontWeight: 700,
                          padding: "1px 6px",
                          borderRadius: 999,
                          background: "var(--good-bg)",
                          color: "var(--good)",
                        }}
                      >
                        current
                      </span>
                    )}
                    {s.count > 1 && (
                      <span className="mono muted" style={{ marginLeft: "auto", fontSize: 9.5 }}>
                        {s.count} edits
                      </span>
                    )}
                  </div>
                  <div
                    className="mono muted"
                    style={{ fontSize: 9.5, marginTop: 2, paddingLeft: 18 }}
                  >
                    {s.author}
                  </div>
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DiffView({
  diff,
  fromLabel,
  toLabel,
}: {
  diff: Diff | null
  fromLabel?: string
  toLabel?: string
}) {
  if (!diff)
    return (
      <div className="center" style={{ flex: 1 }}>
        <div className="spin" />
      </div>
    )
  const adds = diff.ops.filter((o) => o.t === "add").length
  const dels = diff.ops.filter((o) => o.t === "del").length
  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--card)" }}>
      <div
        style={{
          display: "flex",
          gap: 12,
          padding: "8px 16px",
          borderBottom: "1px solid var(--line-soft)",
          fontSize: 12,
          alignItems: "center",
        }}
      >
        {fromLabel && toLabel && (
          <span className="mono muted" style={{ marginRight: "auto" }}>
            {fromLabel} → {toLabel}
          </span>
        )}
        <span className="mono" style={{ color: "var(--good)" }}>
          +{adds}
        </span>
        <span className="mono" style={{ color: "var(--bad)" }}>
          −{dels}
        </span>
        <span className="mono muted">{diff.ops.length} lines</span>
      </div>
      <pre
        className="mono"
        style={{ margin: 0, padding: "10px 0", fontSize: 12.5, lineHeight: 1.6 }}
      >
        {diff.ops.map((o, i) => (
          <div
            key={i}
            style={{
              padding: "0 16px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background:
                o.t === "add" ? "var(--good-bg)" : o.t === "del" ? "var(--cmt-bg)" : "transparent",
              color: o.t === "ctx" ? "var(--fg-mut)" : "var(--fg)",
            }}
          >
            <span
              style={{
                userSelect: "none",
                color: o.t === "add" ? "var(--good)" : o.t === "del" ? "var(--bad)" : "var(--line)",
                marginRight: 10,
              }}
            >
              {o.t === "add" ? "+" : o.t === "del" ? "−" : " "}
            </span>
            {o.line || "​"}
          </div>
        ))}
      </pre>
    </div>
  )
}

function parseAnchor(a: string | null): { exact: string; prefix?: string; suffix?: string } | null {
  if (!a) return null
  try {
    const s = JSON.parse(a) as { exact?: string; prefix?: string; suffix?: string }
    return s.exact ? { exact: s.exact, prefix: s.prefix, suffix: s.suffix } : null
  } catch {
    return null
  }
}

const anchorExact = (a: string | null): string | null => parseAnchor(a)?.exact ?? null

function groupThreads(comments: Comment[]): Comment[][] {
  const map = new Map<string, Comment[]>()
  for (const c of comments) {
    if (!map.has(c.thread_id)) map.set(c.thread_id, [])
    map.get(c.thread_id)!.push(c)
  }
  return [...map.values()]
}
