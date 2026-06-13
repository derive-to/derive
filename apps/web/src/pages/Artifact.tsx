import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "@tanstack/react-router"
import { api, API_BASE, type Analytics, type Artifact as Art, type Comment, type Diff } from "../api"
import { Header, useToast } from "../components"
import { useAuth } from "../ctx"

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
  const [restoring, setRestoring] = useState(false)
  const [viewers, setViewers] = useState<string[]>([])
  const [src, setSrc] = useState("")
  const [body, setBody] = useState("")
  const [anchor, setAnchor] = useState<{ type?: string; exact: string; prefix?: string; suffix?: string } | null>(null)

  // The anchor channel with the sandboxed iframe (see SELECTION_SCRIPT).
  const frame = useRef<HTMLIFrameElement>(null)
  const presentWrap = useRef<HTMLDivElement>(null)
  const [frameReady, setFrameReady] = useState(0)
  const [inDoc, setInDoc] = useState<Record<string, boolean>>({})
  const [activeThread, setActiveThread] = useState<string | null>(null)
  // Set when the artifact announces itself as a deck (dock-deck protocol).
  const [deck, setDeck] = useState<{ i: number; total: number } | null>(null)
  const threadEls = useRef(new Map<string, HTMLDivElement>())

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
      if (d.type === "select") setAnchor(d.selector ?? null)
      // which threads' text exists in the shown version (truth for highlights + badges)
      else if (d.type === "anchors-resolved") setInDoc(d.resolved ?? {})
      // clicking a highlight in the document focuses its thread
      else if (d.type === "anchor-click") {
        setActiveThread(d.id)
        threadEls.current.get(d.id)?.scrollIntoView({ behavior: "smooth", block: "center" })
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

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

  useEffect(() => setActiveThread(null), [shortId, version])

  // Clicking a thread's quote scrolls the document to its highlight.
  const jumpTo = (threadId: string) => {
    setActiveThread(threadId)
    frame.current?.contentWindow?.postMessage({ source: "dock-host", type: "focus-anchor", id: threadId }, "*")
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
    api.diff(shortId, shownN, art.current_version).then((d) => alive && setDiff(d)).catch(() => {})
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
  const threads = groupThreads(comments)
  const openCount = threads.filter((t) => t[0].state === "open").length

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
  const addComment = async (text: string, threadId?: string) => {
    if (!text.trim()) return
    await api
      .comment(shortId, { body_md: text, thread_id: threadId, anchor: !threadId ? anchor ?? undefined : undefined })
      .catch((e) => show((e as Error).message))
    if (!threadId) {
      setBody("")
      setAnchor(null)
    }
    api.listComments(shortId).then((r) => setComments(r.comments))
  }
  const toggleResolve = async (root: Comment) => {
    await api.resolve(shortId, root.id, root.state === "open" ? "resolved" : "open")
    api.listComments(shortId).then((r) => setComments(r.comments))
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

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Header
        right={
          <>
            <Presence viewers={viewers} self={me?.name ?? me?.email ?? ""} />
            <Insights shortId={shortId} />
            <HistoryMenu
              art={art}
              shown={shown}
              goTo={(n) => nav({ to: "/a/$ref", params: { ref: n === art.current_version ? shortId : `${shortId}@v${n}` } })}
            />
            {editable && !editing && <button className="btn sm" onClick={startEdit}>Edit</button>}
          </>
        }
      />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
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
              {/* History-viewing banner: only when looking at a past version.
                  The current version just shows the artifact, no version chrome. */}
              {shown !== art.current_version && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderBottom: "1px solid var(--line-soft)", background: "var(--ac-soft)", fontSize: 12.5 }}>
                  <span style={{ color: "var(--ac)", fontWeight: 600 }}>Viewing an earlier version</span>
                  <span className="muted">·</span>
                  <button className="lnk" onClick={() => setView(view === "diff" ? "preview" : "diff")}>
                    {view === "diff" ? "Hide changes" : "Show changes since this"}
                  </button>
                  <span style={{ flex: 1 }} />
                  <button className="btn sm" onClick={() => restore(shown)} disabled={restoring}>
                    {restoring ? "Restoring…" : "Restore this version"}
                  </button>
                  <button className="btn pri sm" onClick={() => nav({ to: "/a/$ref", params: { ref: shortId } })}>
                    Back to current
                  </button>
                </div>
              )}
              {view === "diff" && shown !== art.current_version ? (
                <DiffView diff={diff} fromLabel={`v${shown}`} toLabel="current" />
              ) : (
                <div ref={presentWrap} style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, position: "relative", background: "#fff" }}>
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
        </div>

        <aside style={{ width: 320, flex: "0 0 320px", borderLeft: "1px solid var(--line)", background: "var(--card)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", borderBottom: "1px solid var(--line-soft)" }}>
            <b style={{ fontSize: 13 }}>Comments</b>
            <span className="mono" style={{ fontSize: 10, color: "var(--cmt-tx)", background: "var(--cmt-bg)", borderRadius: 999, padding: "1px 8px", fontWeight: 700 }}>{openCount}</span>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
            {threads.length === 0 ? (
              <div className="muted" style={{ textAlign: "center", fontSize: 12, padding: "26px 12px" }}>No comments yet.</div>
            ) : (
              threads.map((t) => (
                <Thread
                  key={t[0].thread_id}
                  thread={t}
                  onReply={addComment}
                  onResolve={toggleResolve}
                  active={activeThread === t[0].thread_id}
                  inDoc={inDoc[t[0].thread_id]}
                  onJump={() => jumpTo(t[0].thread_id)}
                  refEl={(el) => {
                    if (el) threadEls.current.set(t[0].thread_id, el)
                    else threadEls.current.delete(t[0].thread_id)
                  }}
                />
              ))
            )}
          </div>
          <div style={{ borderTop: "1px solid var(--line-soft)", padding: 11 }}>
            {anchor && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7, fontSize: 11, color: "var(--cmt-tx)", background: "var(--cmt-bg)", border: "1px solid var(--cmt-bd)", borderRadius: 7, padding: "5px 9px" }}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>“{anchor.exact}”</span>
                <button onClick={() => setAnchor(null)} style={{ border: 0, background: "transparent", color: "var(--cmt-tx)", cursor: "pointer" }}>✕</button>
              </div>
            )}
            <textarea className="input" value={body} onChange={(e) => setBody(e.target.value)} placeholder={anchor ? "Comment on the selection…" : "Add a comment…"} style={{ minHeight: 50, resize: "vertical" }} />
            <button className="btn pri sm" onClick={() => addComment(body)} style={{ marginTop: 7, width: "100%", justifyContent: "center" }}>Comment</button>
          </div>
        </aside>
      </div>
      {toast}
    </div>
  )
}

function Thread({
  thread,
  onReply,
  onResolve,
  active,
  inDoc,
  onJump,
  refEl,
}: {
  thread: Comment[]
  onReply: (t: string, tid: string) => void
  onResolve: (c: Comment) => void
  active?: boolean
  /** Whether the anchored text exists in the version being shown (from the iframe). */
  inDoc?: boolean
  onJump?: () => void
  refEl?: (el: HTMLDivElement | null) => void
}) {
  const [reply, setReply] = useState("")
  const root = thread[0]
  const resolved = root.state === "resolved"
  const quote = anchorExact(root.anchor)
  // The iframe's answer is the truth for the shown version; the server flag
  // (computed against the latest version) is the fallback before it arrives.
  const textPresent = inDoc !== undefined ? inDoc : root.anchored !== false
  return (
    <div
      ref={refEl}
      className="card"
      style={{
        marginBottom: 11,
        overflow: "hidden",
        opacity: resolved ? 0.62 : 1,
        scrollMarginTop: 12,
        outline: active ? "2px solid var(--ac)" : undefined,
        outlineOffset: 1,
        transition: "outline-color .2s",
      }}
    >
      {quote &&
        (textPresent && !resolved ? (
          <button
            onClick={onJump}
            title="Jump to the highlighted text"
            style={{ display: "block", width: "100%", textAlign: "left", border: 0, borderLeft: "3px solid var(--ac)", background: "var(--ac-soft)", color: "var(--fg)", padding: "6px 10px", fontSize: 11.5, lineHeight: 1.4, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontStyle: "italic" }}
          >
            “{quote}”
          </button>
        ) : (
          <div
            title="The text this comment was attached to was edited or removed in this version"
            style={{ borderLeft: "3px solid var(--line)", background: "var(--card-2)", color: "var(--fg-mut)", padding: "6px 10px", fontSize: 11.5, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontStyle: "italic" }}
          >
            “{quote}”
          </div>
        ))}
      {thread.map((c) => (
        <div key={c.id} style={{ padding: "10px 12px", borderBottom: "1px solid var(--line-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, fontWeight: 700, color: "var(--cmt-tx)", marginBottom: 4 }}>
            <span style={{ width: 17, height: 17, borderRadius: "50%", background: "var(--cmt-bg)", display: "grid", placeItems: "center", fontSize: 9 }}>
              {(c.author || "?").slice(0, 2).toUpperCase()}
            </span>
            {c.author}
            <span className="mono muted" style={{ marginLeft: "auto", fontWeight: 400, fontSize: 9 }}>on v{c.base_version}</span>
          </div>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{c.body_md}</p>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 12px", background: "var(--card-2)" }}>
        <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: resolved ? "var(--good-bg)" : "var(--ac-soft)", color: resolved ? "var(--good)" : "var(--ac)" }}>
          {resolved ? "resolved" : "open"}
        </span>
        {quote && !textPresent && !resolved && (
          <span className="mono" title="The text this comment was attached to was edited or removed in this version" style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "var(--cmt-bg)", color: "var(--cmt-tx)" }}>
            text changed
          </span>
        )}
        <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => onResolve(root)}>
          {resolved ? "Reopen" : "Resolve"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, padding: "8px 12px", borderTop: "1px solid var(--line-soft)" }}>
        <input className="input" style={{ padding: "6px 9px", fontSize: 12 }} value={reply} placeholder="Reply…"
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { onReply(reply, root.thread_id); setReply("") } }} />
        <button className="btn sm" onClick={() => { onReply(reply, root.thread_id); setReply("") }}>Reply</button>
      </div>
    </div>
  )
}

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
      <button style={btn} onClick={onPrev} disabled={deck.i <= 0} aria-label="Previous slide">‹</button>
      <span className="mono" style={{ fontSize: 12, color: "var(--fg-mut)", minWidth: 52, textAlign: "center" }}>
        {deck.i + 1} / {deck.total}
      </span>
      <button style={btn} onClick={onNext} disabled={deck.i >= deck.total - 1} aria-label="Next slide">›</button>
      <button style={{ ...btn, marginLeft: 4 }} onClick={onFullscreen} title="Present (fullscreen)" aria-label="Present fullscreen">⛶</button>
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
      .map((v) => ({ n: v.n, from_n: v.n, count: 1, author: v.author, name: v.name, created_at: v.created_at }))
  const latest = sessions[0]
  let lastDay = ""
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="btn sm" onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }} style={{ gap: 6 }} title="Version history">
        {latest ? `Edited ${ago(latest.created_at)}` : "History"}
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", right: 0, top: "calc(100% + 7px)", width: 286, padding: 6, boxShadow: "var(--shadow)", zIndex: 30, maxHeight: 400, overflow: "auto" }}>
          <div className="mono" style={{ fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--fg-mut)", padding: "6px 8px 4px" }}>
            Version history
          </div>
          {sessions.map((s) => {
            const cur = s.n === shown
            const day = dayLabel(s.created_at)
            const header = day !== lastDay ? ((lastDay = day), day) : null
            return (
              <div key={s.n}>
                {header && (
                  <div className="mono muted" style={{ fontSize: 9, letterSpacing: ".05em", textTransform: "uppercase", padding: "8px 9px 3px" }}>{header}</div>
                )}
                <button
                  onClick={() => { goTo(s.n); setOpen(false) }}
                  style={{ display: "block", width: "100%", textAlign: "left", border: 0, background: cur ? "var(--ac-soft)" : "transparent", borderRadius: 7, padding: "7px 9px", cursor: "pointer", marginBottom: 1 }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ color: s.name ? "var(--ac)" : "var(--fg-mut)", fontSize: 11 }}>{s.name ? "★" : "●"}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: cur ? "var(--ac)" : "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.name ?? clock(s.created_at)}
                    </span>
                    {s.n === art.current_version && (
                      <span className="mono" style={{ fontSize: 8.5, fontWeight: 700, padding: "1px 6px", borderRadius: 999, background: "var(--good-bg)", color: "var(--good)" }}>current</span>
                    )}
                    {s.count > 1 && (
                      <span className="mono muted" style={{ marginLeft: "auto", fontSize: 9.5 }}>{s.count} edits</span>
                    )}
                  </div>
                  <div className="mono muted" style={{ fontSize: 9.5, marginTop: 2, paddingLeft: 18 }}>{s.author}</div>
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DiffView({ diff, fromLabel, toLabel }: { diff: Diff | null; fromLabel?: string; toLabel?: string }) {
  if (!diff) return <div className="center" style={{ flex: 1 }}><div className="spin" /></div>
  const adds = diff.ops.filter((o) => o.t === "add").length
  const dels = diff.ops.filter((o) => o.t === "del").length
  return (
    <div style={{ flex: 1, overflow: "auto", background: "var(--card)" }}>
      <div style={{ display: "flex", gap: 12, padding: "8px 16px", borderBottom: "1px solid var(--line-soft)", fontSize: 12, alignItems: "center" }}>
        {fromLabel && toLabel && (
          <span className="mono muted" style={{ marginRight: "auto" }}>{fromLabel} → {toLabel}</span>
        )}
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
