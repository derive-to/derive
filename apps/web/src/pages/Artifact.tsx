import { useCallback, useEffect, useState } from "react"
import { useNavigate, useParams } from "@tanstack/react-router"
import { api, API_BASE, type Artifact as Art, type Comment } from "../api"
import { Header, useToast } from "../components"
import { useAuth } from "../ctx"

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
            <div style={{ display: "flex", gap: 5 }}>
              {art.versions.map((v) => (
                <button
                  key={v.n}
                  className={`chip${v.n === shown ? " on" : ""}`}
                  onClick={() => nav({ to: "/a/$ref", params: { ref: `${shortId}@v${v.n}` } })}
                  title={v.message ?? ""}
                >
                  v{v.n}
                </button>
              ))}
            </div>
            {editable && !editing && <button className="btn sm" onClick={startEdit}>Edit</button>}
          </>
        }
      />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, display: "flex", minWidth: 0 }}>
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
            <iframe
              title={art.title ?? shortId}
              src={rawSrc}
              sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
              style={{ flex: 1, border: 0, background: "#fff" }}
            />
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
