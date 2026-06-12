import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "@tanstack/react-router"
import { api, API_BASE, type Analytics, type Artifact as Art, type Comment, type Diff } from "../api"
import { Header, useToast } from "../components"
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

  const [art, setArt] = useState<Art | null>(null)
  const [failed, setFailed] = useState(false)
  const [comments, setComments] = useState<Comment[]>([])
  const [editing, setEditing] = useState(false)
  const [view, setView] = useState<"preview" | "diff">("preview")
  const [diff, setDiff] = useState<Diff | null>(null)
  const [viewers, setViewers] = useState<string[]>([])
  const [src, setSrc] = useState("")

  // Comments UI state.
  const [panel, setPanel] = useState<Panel>(loadPanel)
  const [sel, setSel] = useState<{ selector: Sel; top: number } | null>(null)
  const [composer, setComposer] = useState<{ anchor: Sel | null; top: number | null } | null>(null)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [hoverThread, setHoverThread] = useState<string | null>(null)

  // The anchor channel with the sandboxed iframe (see ANCHOR_CLIENT_JS).
  const frame = useRef<HTMLIFrameElement>(null)
  const [frameReady, setFrameReady] = useState(0)
  const [inDoc, setInDoc] = useState<Record<string, boolean>>({})
  const [anchorTops, setAnchorTops] = useState<Record<string, number>>({})
  const [scrollY, setScrollY] = useState(0)

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: "dock-host", ...msg }, "*")
  }, [])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (!d || d.source !== "dock") return
      if (d.type === "select") setSel(d.selector && d.rect ? { selector: d.selector, top: d.rect.top } : null)
      else if (d.type === "anchors-resolved") setInDoc(d.resolved ?? {})
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
    api.getArtifact(shortId).then((a) => { setArt(a); setFailed(false) }).catch(() => setFailed(true))
    api.listComments(shortId).then((r) => setComments(r.comments)).catch(() => {})
  }, [shortId])
  useEffect(load, [load])

  // live updates
  useEffect(() => {
    const ev = new EventSource(`${API_BASE}/v1/artifacts/${shortId}/events`, {
      withCredentials: true,
    })
    const refresh = () => api.listComments(shortId).then((r) => setComments(r.comments)).catch(() => {})
    ev.addEventListener("comment.created", refresh)
    ev.addEventListener("comment.resolved", refresh)
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
    const beat = () => api.heartbeat(shortId, name).then((r) => setViewers(r.viewers)).catch(() => {})
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

  // The diff view compares the shown version to the one before it.
  useEffect(() => {
    if (view !== "diff" || !art) return
    const cur = version ?? art.current_version
    if (cur <= 1) {
      setDiff(null)
      return
    }
    let alive = true
    api.diff(shortId, cur - 1, cur).then((d) => alive && setDiff(d)).catch(() => {})
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
          <button className="btn" onClick={() => nav({ to: "/" })}>Back to library</button>
        </div>
      </div>
    )
  if (!art) return <div style={{ minHeight: "100%" }}><Header /><div className="center" style={{ height: "60vh" }}><div className="spin" /></div></div>

  const shown = version ?? art.current_version
  const editable = art.kind === "file" && shown === art.current_version
  const rawSrc = `${API_BASE}/raw/${shortId}/v/${shown}/index.html`

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
      const a = await api.publishText(shortId, src, art.title ? `${art.short_id}.md` : "edit.md", "edited in browser")
      show(`Published v${a.current_version}`)
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
        anchor: opts?.threadId ? undefined : opts?.anchor ?? undefined,
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

  const asideWidth = panel === "open" ? 340 : panel === "rail" ? 50 : 0

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Header
        right={
          <>
            <Presence viewers={viewers} self={me?.name ?? me?.email ?? ""} />
            <Insights shortId={shortId} />
            <VersionMenu
              art={art}
              shown={shown}
              goTo={(n) => nav({ to: "/a/$ref", params: { ref: `${shortId}@v${n}` } })}
            />
            {editable && !editing && <button className="btn sm" onClick={startEdit}>Edit</button>}
            {panel !== "open" && (
              <button className="btn sm" onClick={() => setPanel("open")} style={{ gap: 6 }} title="Show comments (c)">
                💬 {openCount > 0 && <b style={{ fontWeight: 700 }}>{openCount}</b>}
              </button>
            )}
          </>
        }
      />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
          {editing ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--card)" }}>
              <div style={{ display: "flex", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--line-soft)", alignItems: "center" }}>
                <span className="mono muted" style={{ fontSize: 11 }}>editing source</span>
                <span style={{ flex: 1 }} />
                <button className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
                <button className="btn pri sm" onClick={publishEdit}>Publish new version</button>
              </div>
              <textarea
                className="mono"
                value={src}
                onChange={(e) => setSrc(e.target.value)}
                spellCheck={false}
                style={{ flex: 1, border: 0, resize: "none", padding: "16px 20px", fontSize: 13, lineHeight: 1.6, color: "var(--fg)", background: "var(--card)", outline: "none" }}
              />
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid var(--line-soft)", background: "var(--card)" }}>
                <div className="seg" style={{ display: "flex", gap: 2, background: "var(--card-2)", borderRadius: 7, padding: 2 }}>
                  <button className={`seg-b${view === "preview" ? " on" : ""}`} onClick={() => setView("preview")}>Preview</button>
                  <button
                    className={`seg-b${view === "diff" ? " on" : ""}`}
                    onClick={() => setView("diff")}
                    disabled={shown <= 1}
                    title={shown <= 1 ? "No earlier version to compare" : `Changes from v${shown - 1} to v${shown}`}
                  >
                    Diff
                  </button>
                </div>
                {view === "diff" && shown > 1 && (
                  <span className="mono muted" style={{ fontSize: 11 }}>v{shown - 1} → v{shown}</span>
                )}
                {view === "preview" && (
                  <span className="mono muted" style={{ marginLeft: "auto", fontSize: 10.5, opacity: 0.8 }}>
                    Select text to comment
                  </span>
                )}
              </div>
              {view === "diff" ? (
                <DiffView diff={diff} />
              ) : (
                <iframe
                  ref={frame}
                  onLoad={() => setFrameReady((n) => n + 1)}
                  title={art.title ?? shortId}
                  src={rawSrc}
                  sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
                  style={{ flex: 1, border: 0, background: "#fff" }}
                />
              )}
            </>
          )}
          {panel === "hidden" && (
            <button
              onClick={() => setPanel("open")}
              title="Show comments (c)"
              style={{
                position: "absolute", right: 18, bottom: 18, height: 44, borderRadius: 999, border: "1px solid var(--line)",
                background: "var(--card)", color: "var(--fg)", cursor: "pointer", boxShadow: "var(--shadow)",
                display: "flex", alignItems: "center", gap: 8, padding: "0 16px", fontWeight: 600, fontSize: 13,
              }}
            >
              <span style={{ fontSize: 15 }}>💬</span>
              {openCount > 0 ? `${openCount} comment${openCount === 1 ? "" : "s"}` : "Comments"}
            </button>
          )}
        </div>

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
            transition: "width .22s cubic-bezier(.4,0,.2,1), flex-basis .22s cubic-bezier(.4,0,.2,1)",
          }}
        >
          {panel === "rail" ? (
            <Rail
              pins={pinned}
              generalCount={general.length}
              active={activeThread}
              onExpand={() => setPanel("open")}
              onHide={() => setPanel("hidden")}
              onDot={(id) => { setPanel("open"); jumpTo(id) }}
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
              sel={sel}
              composer={composer}
              docLive={docLive}
              onMinimize={() => setPanel("rail")}
              onHide={() => setPanel("hidden")}
              onActivate={activate}
              onHover={setHoverThread}
              onResolve={toggleResolve}
              onReply={reply}
              onJump={jumpTo}
              onStartSelComment={startSelComment}
              onNewGeneral={() => { setComposer({ anchor: null, top: null }); setActiveThread(null) }}
              onSubmitNew={submitNew}
              onCancelNew={() => { setComposer(null); setSel(null) }}
            />
          )}
        </aside>
      </div>
      {toast}
    </div>
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
  sel: { selector: Sel; top: number } | null
  composer: { anchor: Sel | null; top: number | null } | null
  docLive: boolean
  onMinimize: () => void
  onHide: () => void
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string) => void
  onJump: (id: string) => void
  onStartSelComment: () => void
  onNewGeneral: () => void
  onSubmitNew: (text: string) => void
  onCancelNew: () => void
}) {
  const {
    openCount, pinned, general, resolved, activeThread, hoverThread, inDoc, sel, composer, docLive,
    onMinimize, onHide, onActivate, onHover, onResolve, onReply, onJump, onStartSelComment,
    onNewGeneral, onSubmitNew, onCancelNew,
  } = props
  const anchoredComposer = composer && composer.anchor && composer.top != null
  const generalComposer = composer && !composer.anchor
  const empty = openCount === 0 && resolved.length === 0 && !composer

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 8px 10px 14px", borderBottom: "1px solid var(--line-soft)" }}>
        <b style={{ fontSize: 13 }}>Comments</b>
        {openCount > 0 && (
          <span className="mono" style={{ fontSize: 10, color: "var(--cmt-tx)", background: "var(--cmt-bg)", borderRadius: 999, padding: "1px 8px", fontWeight: 700 }}>{openCount}</span>
        )}
        <span style={{ flex: 1 }} />
        <IconBtn title="New comment" onClick={onNewGeneral}>＋</IconBtn>
        <IconBtn title="Minimize to rail (c)" onClick={onMinimize}>⟩</IconBtn>
        <IconBtn title="Hide comments" onClick={onHide}>✕</IconBtn>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
        {/* Pinned margin — cards float beside their highlighted text. */}
        <PinnedZone
          pins={pinned}
          activeThread={activeThread}
          hoverThread={hoverThread}
          inDoc={inDoc}
          onActivate={onActivate}
          onHover={onHover}
          onResolve={onResolve}
          onReply={onReply}
          onJump={onJump}
        />

        {/* Floating "comment on selection" button, beside the selection. */}
        {docLive && sel && !anchoredComposer && (
          <button
            className="cmt-bubble"
            onClick={onStartSelComment}
            style={{ position: "absolute", right: 12, top: clamp(sel.top - 14, 6, 4000), zIndex: 8 }}
          >
            💬 Comment
          </button>
        )}

        {/* Anchored composer, pinned at the selection. */}
        {anchoredComposer && (
          <div style={{ position: "absolute", left: 10, right: 10, top: clamp((composer.top ?? 0) - 6, 6, 4000), zIndex: 9 }}>
            <Composer
              quote={composer.anchor?.exact ?? null}
              onSubmit={onSubmitNew}
              onCancel={onCancelNew}
            />
          </div>
        )}

        {/* Empty state. */}
        {empty && (
          <div className="center" style={{ position: "absolute", inset: 0, flexDirection: "column", gap: 8, padding: 24, textAlign: "center" }}>
            <div style={{ fontSize: 26, opacity: 0.5 }}>💬</div>
            <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              No comments yet.<br />Select text in the document to start one.
            </div>
          </div>
        )}
      </div>

      {/* General + resolved threads live in a scrollable footer drawer. */}
      {(generalComposer || general.length > 0 || resolved.length > 0) && (
        <div style={{ flex: "0 0 auto", maxHeight: "44%", overflow: "auto", borderTop: "1px solid var(--line-soft)", padding: 10 }}>
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
function PinnedZone({
  pins, activeThread, hoverThread, inDoc, onActivate, onHover, onResolve, onReply, onJump,
}: {
  pins: PinItem[]
  activeThread: string | null
  hoverThread: string | null
  inDoc: Record<string, boolean>
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onResolve: (c: Comment) => void
  onReply: (text: string, threadId: string) => void
  onJump: (id: string) => void
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

  const items = pins.map((p) => ({ id: p.thread[0].thread_id, desiredY: p.desiredY }))
  const pos = layoutPins(items, heights, activeThread, 12)

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {pins.map((p) => {
        const id = p.thread[0].thread_id
        const active = activeThread === id
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
function CommentCard({
  thread, active, hovered, present, onActivate, onHover, onResolve, onReply, onJump,
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
            onClick={(e) => { e.stopPropagation(); onJump(root.thread_id) }}
            title="Jump to the highlighted text"
            className="cmt-quote"
            style={{ borderLeft: "3px solid var(--ac)", background: "var(--ac-soft)", color: "var(--fg)", cursor: "pointer" }}
          >
            “{quote}”
          </button>
        ) : (
          <div
            title="The text this comment was attached to was edited or removed in this version"
            className="cmt-quote"
            style={{ borderLeft: "3px solid var(--line)", background: "var(--card-2)", color: "var(--fg-mut)" }}
          >
            “{quote}”
          </div>
        ))}

      {!active ? (
        // Compact: author, first line, reply count.
        <div style={{ padding: "9px 11px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
            <Avatar name={root.author} />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--cmt-tx)" }}>{root.author}</span>
            <span className="mono muted" style={{ marginLeft: "auto", fontSize: 9.5 }}>{ago(root.created_at)}</span>
          </div>
          <p className="cmt-clamp" style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45 }}>{root.body_md}</p>
          {replies > 0 && (
            <div className="mono" style={{ marginTop: 5, fontSize: 10, color: "var(--ac)", fontWeight: 700 }}>
              {replies} repl{replies === 1 ? "y" : "ies"}
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={{ maxHeight: 340, overflow: "auto" }}>
            {thread.map((c) => (
              <div key={c.id} style={{ padding: "10px 12px", borderBottom: "1px solid var(--line-soft)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, fontWeight: 700, color: "var(--cmt-tx)", marginBottom: 4 }}>
                  <Avatar name={c.author} />
                  {c.author}
                  <span className="mono muted" style={{ marginLeft: "auto", fontWeight: 400, fontSize: 9 }}>{ago(c.created_at)} · v{c.base_version}</span>
                </div>
                <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{c.body_md}</p>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, padding: "8px 12px", borderTop: "1px solid var(--line-soft)" }}>
            <input
              className="input"
              style={{ padding: "6px 9px", fontSize: 12 }}
              value={reply}
              placeholder="Reply…"
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && reply.trim()) { onReply(reply, root.thread_id); setReply("") } }}
            />
            <button className="btn sm" disabled={!reply.trim()} onClick={(e) => { e.stopPropagation(); if (reply.trim()) { onReply(reply, root.thread_id); setReply("") } }}>Reply</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 12px", background: "var(--card-2)" }}>
            <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: resolved ? "var(--good-bg)" : "var(--ac-soft)", color: resolved ? "var(--good)" : "var(--ac)" }}>
              {resolved ? "resolved" : "open"}
            </span>
            {quote && !textPresent && !resolved && (
              <span className="mono" title="The text this comment was attached to was edited or removed in this version" style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "var(--cmt-bg)", color: "var(--cmt-tx)" }}>
                text changed
              </span>
            )}
            <button className="btn sm" style={{ marginLeft: "auto" }} onClick={(e) => { e.stopPropagation(); onResolve(root) }}>
              {resolved ? "Reopen" : "Resolve"}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function ResolvedSection({
  threads, activeThread, hoverThread, onActivate, onHover, onResolve, onReply, onJump,
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
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", border: 0, background: "transparent", cursor: "pointer", color: "var(--fg-mut)", padding: "5px 2px", font: "700 9.5px ui-monospace,Menlo,monospace", letterSpacing: ".06em", textTransform: "uppercase" }}
      >
        <span style={{ transition: "transform .15s", transform: open ? "rotate(90deg)" : "none" }}>▸</span>
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
function Composer({ quote, onSubmit, onCancel }: { quote: string | null; onSubmit: (t: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    ref.current?.focus()
  }, [])
  const submit = () => {
    if (text.trim()) onSubmit(text)
  }
  return (
    <div className="card" style={{ boxShadow: "var(--shadow)", borderColor: "var(--ac)", overflow: "hidden" }}>
      {quote && (
        <div className="cmt-quote" style={{ borderLeft: "3px solid var(--ac)", background: "var(--ac-soft)", color: "var(--fg)", fontStyle: "italic" }}>
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
          <button className="btn pri sm" disabled={!text.trim()} onClick={submit} style={{ flex: 1, justifyContent: "center" }}>Comment</button>
          <button className="btn sm" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// Collapsed rail: a thin column of dots, each beside its comment's text.
function Rail({
  pins, generalCount, active, onExpand, onHide, onDot,
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
      <button onClick={onExpand} title="Expand comments (c)" className="rail-top" style={{ borderBottom: "1px solid var(--line-soft)" }}>
        <span style={{ fontSize: 13 }}>⟨</span>
        {total > 0 && <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, color: "var(--cmt-tx)", background: "var(--cmt-bg)", borderRadius: 999, padding: "1px 5px" }}>{total}</span>}
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
      <button onClick={onHide} title="Hide comments" className="rail-top" style={{ borderTop: "1px solid var(--line-soft)", color: "var(--fg-mut)" }}>
        ✕
      </button>
    </>
  )
}

function Avatar({ name }: { name: string }) {
  return (
    <span style={{ width: 17, height: 17, borderRadius: "50%", background: "var(--cmt-bg)", color: "var(--cmt-tx)", display: "grid", placeItems: "center", fontSize: 9, fontWeight: 700, fontFamily: "ui-monospace,Menlo,monospace", flex: "0 0 auto" }}>
      {(name || "?").slice(0, 2).toUpperCase()}
    </span>
  )
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{ width: 26, height: 26, display: "grid", placeItems: "center", border: 0, background: "transparent", color: "var(--fg-mut)", borderRadius: 7, cursor: "pointer", fontSize: 13 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--hover)"; e.currentTarget.style.color = "var(--fg)" }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--fg-mut)" }}
    >
      {children}
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono" style={{ fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--fg-mut)", padding: "2px 2px 6px" }}>
      {children}
    </div>
  )
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// Who is viewing right now. Live over the presence SSE channel; self listed
// first as "you". Hidden when you're the only one here.
function Presence({ viewers, self }: { viewers: string[]; self: string }) {
  const others = viewers.filter((v) => v !== self)
  if (others.length === 0) return null
  const ordered = [self, ...others].filter(Boolean)
  const shown = ordered.slice(0, 4)
  const extra = ordered.length - shown.length
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }} title={`${ordered.length} viewing: ${ordered.join(", ")}`}>
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
      <span className="mono muted" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
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
    if (open && !data && !off) api.analytics(shortId).then(setData).catch(() => setOff(true))
  }, [open, data, off, shortId])
  if (off) return null
  const max = data ? Math.max(1, ...data.daily.map((d) => d.count)) : 1
  const maxV = data ? Math.max(1, ...data.perVersion.map((v) => v.count)) : 1
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="btn sm" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }} style={{ gap: 6 }} title="View analytics">
        <span style={{ fontSize: 12 }}>👁</span>
        {data ? data.total.toLocaleString() : "Insights"}
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", right: 0, top: "calc(100% + 7px)", width: 300, padding: 14, boxShadow: "var(--shadow)", zIndex: 30 }}>
          {!data ? (
            <div className="center" style={{ height: 80 }}><div className="spin" /></div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 18, marginBottom: 12 }}>
                <div>
                  <div className="display" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{data.total.toLocaleString()}</div>
                  <div className="mono muted" style={{ fontSize: 10 }}>views</div>
                </div>
                <div>
                  <div className="display" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{data.unique.toLocaleString()}</div>
                  <div className="mono muted" style={{ fontSize: 10 }}>unique</div>
                </div>
              </div>
              <div className="mono muted" style={{ fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 5 }}>Last 30 days</div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40, marginBottom: 12 }}>
                {data.daily.length === 0 ? (
                  <span className="muted" style={{ fontSize: 11 }}>No views yet.</span>
                ) : (
                  data.daily.map((d) => (
                    <div key={d.day} title={`${d.day}: ${d.count}`} style={{ flex: 1, minWidth: 2, height: `${(d.count / max) * 100}%`, background: "var(--ac)", borderRadius: 2, opacity: 0.85 }} />
                  ))
                )}
              </div>
              {data.perVersion.length > 0 && (
                <>
                  <div className="mono muted" style={{ fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 5 }}>By version</div>
                  <div style={{ marginBottom: 12 }}>
                    {data.perVersion.map((v) => (
                      <div key={v.version} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                        <span className="mono" style={{ fontSize: 10.5, width: 22, color: "var(--fg-mut)" }}>v{v.version}</span>
                        <div style={{ flex: 1, height: 6, background: "var(--card-2)", borderRadius: 999, overflow: "hidden" }}>
                          <div style={{ width: `${(v.count / maxV) * 100}%`, height: "100%", background: "var(--ac)", borderRadius: 999 }} />
                        </div>
                        <span className="mono muted" style={{ fontSize: 10, width: 30, textAlign: "right" }}>{v.count}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {data.recent.length > 0 && (
                <>
                  <div className="mono muted" style={{ fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 5 }}>Recent viewers</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {data.recent.map((r) => (
                      <div key={r.viewer} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5 }}>
                        <span style={{ width: 17, height: 17, borderRadius: "50%", background: r.kind === "user" ? "var(--ac-soft)" : "var(--card-2)", color: "var(--fg-mut)", display: "grid", placeItems: "center", fontSize: 8, fontWeight: 700, fontFamily: "ui-monospace,Menlo,monospace" }}>
                          {r.kind === "user" ? (r.viewer || "?").slice(0, 2).toUpperCase() : "·"}
                        </span>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.kind === "user" ? r.viewer : "Anonymous"}
                        </span>
                        <span className="mono muted" style={{ fontSize: 9.5 }}>{ago(r.at)}</span>
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

function VersionMenu({ art, shown, goTo }: { art: Art; shown: number; goTo: (n: number) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("click", h)
    return () => document.removeEventListener("click", h)
  }, [])
  const versions = [...art.versions].sort((a, b) => b.n - a.n)
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="btn sm" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }} style={{ gap: 6 }}>
        v{shown}
        {shown !== art.current_version && <span className="mono muted" style={{ fontSize: 9.5 }}>of {art.current_version}</span>}
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", right: 0, top: "calc(100% + 7px)", width: 268, padding: 6, boxShadow: "var(--shadow)", zIndex: 30, maxHeight: 360, overflow: "auto" }}>
          <div className="mono" style={{ fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--fg-mut)", padding: "6px 8px 4px" }}>
            Version history
          </div>
          {versions.map((v) => {
            const cur = v.n === shown
            return (
              <button
                key={v.n}
                onClick={() => { goTo(v.n); setOpen(false) }}
                style={{ display: "block", width: "100%", textAlign: "left", border: 0, background: cur ? "var(--ac-soft)" : "transparent", borderRadius: 7, padding: "8px 9px", cursor: "pointer", marginBottom: 1 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: cur ? "var(--ac)" : "var(--fg)" }}>v{v.n}</span>
                  {v.n === art.current_version && (
                    <span className="mono" style={{ fontSize: 8.5, fontWeight: 700, padding: "1px 6px", borderRadius: 999, background: "var(--good-bg)", color: "var(--good)" }}>latest</span>
                  )}
                  <span className="mono muted" style={{ marginLeft: "auto", fontSize: 9.5 }}>{ago(v.created_at)}</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--fg-mut)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {v.message || <span className="muted">no message</span>}
                </div>
                <div className="mono muted" style={{ fontSize: 9.5, marginTop: 1 }}>{v.author}</div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DiffView({ diff }: { diff: Diff | null }) {
  if (!diff) return <div className="center" style={{ flex: 1 }}><div className="spin" /></div>
  const adds = diff.ops.filter((o) => o.t === "add").length
  const dels = diff.ops.filter((o) => o.t === "del").length
  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--card)" }}>
      <div style={{ display: "flex", gap: 12, padding: "8px 16px", borderBottom: "1px solid var(--line-soft)", fontSize: 12 }}>
        <span className="mono" style={{ color: "var(--good)" }}>+{adds}</span>
        <span className="mono" style={{ color: "var(--bad)" }}>−{dels}</span>
        <span className="mono muted">{diff.ops.length} lines</span>
      </div>
      <pre className="mono" style={{ margin: 0, padding: "10px 0", fontSize: 12.5, lineHeight: 1.6 }}>
        {diff.ops.map((o, i) => (
          <div
            key={i}
            style={{
              padding: "0 16px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: o.t === "add" ? "var(--good-bg)" : o.t === "del" ? "var(--cmt-bg)" : "transparent",
              color: o.t === "ctx" ? "var(--fg-mut)" : "var(--fg)",
            }}
          >
            <span style={{ userSelect: "none", color: o.t === "add" ? "var(--good)" : o.t === "del" ? "var(--bad)" : "var(--line)", marginRight: 10 }}>
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
