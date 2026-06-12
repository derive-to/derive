import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "@tanstack/react-router"
import { api, API_BASE, type Artifact as Art, type Comment, type Diff } from "../api"
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
  const [src, setSrc] = useState("")
  const [body, setBody] = useState("")
  const [anchor, setAnchor] = useState<{ type?: string; exact: string; prefix?: string; suffix?: string } | null>(null)

  // Selections inside the sandboxed artifact post a quote selector to us.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (d && d.source === "dock" && d.type === "select") setAnchor(d.selector ?? null)
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

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
    return () => ev.close()
  }, [shortId, load])

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

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Header
        right={
          <>
            <VersionMenu
              art={art}
              shown={shown}
              goTo={(n) => nav({ to: "/a/$ref", params: { ref: `${shortId}@v${n}` } })}
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
              </div>
              {view === "diff" ? (
                <DiffView diff={diff} />
              ) : (
                <iframe
                  title={art.title ?? shortId}
                  src={rawSrc}
                  sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
                  style={{ flex: 1, border: 0, background: "#fff" }}
                />
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
              threads.map((t) => <Thread key={t[0].thread_id} thread={t} onReply={addComment} onResolve={toggleResolve} />)
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

function Thread({ thread, onReply, onResolve }: { thread: Comment[]; onReply: (t: string, tid: string) => void; onResolve: (c: Comment) => void }) {
  const [reply, setReply] = useState("")
  const root = thread[0]
  const resolved = root.state === "resolved"
  return (
    <div className="card" style={{ marginBottom: 11, overflow: "hidden", opacity: resolved ? 0.62 : 1 }}>
      {thread.map((c) => (
        <div key={c.id} style={{ padding: "10px 12px", borderBottom: "1px solid var(--line-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, fontWeight: 700, color: "var(--cmt-tx)", marginBottom: 4 }}>
            <span style={{ width: 17, height: 17, borderRadius: "50%", background: "var(--cmt-bg)", display: "grid", placeItems: "center", fontSize: 9 }}>
              {(c.author || "?").slice(0, 2).toUpperCase()}
            </span>
            {c.author}
            <span className="mono muted" style={{ marginLeft: "auto", fontWeight: 400, fontSize: 9 }}>base v{c.base_version}</span>
          </div>
          {anchorExact(c.anchor) && (
            <div className="mono" style={{ fontSize: 9.5, color: "var(--cmt-tx)", background: "var(--card-2)", borderRadius: 5, padding: "2px 6px", display: "inline-block", marginBottom: 5, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              “{anchorExact(c.anchor)}”
            </div>
          )}
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{c.body_md}</p>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 12px", background: "var(--card-2)" }}>
        <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: resolved ? "var(--good-bg)" : "var(--ac-soft)", color: resolved ? "var(--good)" : "var(--ac)" }}>
          {resolved ? "resolved" : "open"}
        </span>
        {root.anchored === false && (
          <span className="mono" title="The anchored text changed in a newer version" style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "var(--cmt-bg)", color: "var(--cmt-tx)" }}>
            orphaned
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

function anchorExact(a: string | null): string | null {
  if (!a) return null
  try {
    return (JSON.parse(a) as { exact?: string }).exact ?? null
  } catch {
    return null
  }
}

function groupThreads(comments: Comment[]): Comment[][] {
  const map = new Map<string, Comment[]>()
  for (const c of comments) {
    if (!map.has(c.thread_id)) map.set(c.thread_id, [])
    map.get(c.thread_id)!.push(c)
  }
  return [...map.values()]
}
