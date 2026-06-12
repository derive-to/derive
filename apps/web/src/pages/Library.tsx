import { useEffect, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { api, type Artifact } from "../api"
import { Header, useToast } from "../components"
import { useAuth } from "../ctx"

export function Library() {
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const [items, setItems] = useState<Artifact[] | null>(null)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const { toast, show } = useToast()

  useEffect(() => {
    if (!loading && !me) nav({ to: "/login" })
  }, [loading, me, nav])
  useEffect(() => {
    if (me) api.listArtifacts().then((r) => setItems(r.artifacts)).catch(() => setItems([]))
  }, [me])

  const publish = async () => {
    const f = file.current?.files?.[0]
    if (!f) {
      file.current?.click()
      return
    }
    setBusy(true)
    try {
      const a = await api.publish(f, { title: f.name.replace(/\.[^.]+$/, "") })
      nav({ to: "/a/$ref", params: { ref: a.short_id } })
    } catch (e) {
      show((e as Error).message)
      setBusy(false)
    }
  }

  if (!me) return <div className="center"><div className="spin" /></div>

  return (
    <div style={{ minHeight: "100%" }}>
      <Header />
      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "26px 22px 60px" }}>
        <div className="card" style={{ padding: 18, marginBottom: 24, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="display" style={{ fontWeight: 600, fontSize: 16 }}>
              Publish an artifact
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              Drop an HTML or Markdown file, or run <code className="mono">dock publish</code>.
            </div>
          </div>
          <input ref={file} type="file" accept=".html,.htm,.md,.markdown,.zip" style={{ maxWidth: 240, fontSize: 12 }} onChange={publish} />
          <button className="btn pri" onClick={publish} disabled={busy}>
            {busy ? "Publishing…" : "Publish"}
          </button>
        </div>

        <h2 className="display" style={{ fontSize: 18, margin: "0 0 14px" }}>
          Library <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>· {items?.length ?? 0}</span>
        </h2>
        {items === null ? (
          <div className="center" style={{ height: 160 }}><div className="spin" /></div>
        ) : items.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 40, border: "1px dashed var(--line)", borderRadius: 14 }}>
            Nothing yet. Publish above, or run <code className="mono">dock publish ./file</code>.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 13 }}>
            {items.map((a) => (
              <button
                key={a.short_id}
                onClick={() => nav({ to: "/a/$ref", params: { ref: a.short_id } })}
                className="card"
                style={{ textAlign: "left", padding: 15, cursor: "pointer", display: "flex", flexDirection: "column", gap: 8 }}
              >
                <div style={{ height: 64, borderRadius: 8, background: "linear-gradient(135deg,var(--ac-soft),var(--card-2))", border: "1px solid var(--line-soft)" }} />
                <div className="display" style={{ fontWeight: 600, fontSize: 15 }}>
                  {a.title ?? a.short_id}
                </div>
                <div className="mono muted" style={{ fontSize: 11, display: "flex", gap: 8 }}>
                  <span style={{ background: "var(--card-2)", border: "1px solid var(--line-soft)", borderRadius: 5, padding: "1px 6px" }}>{a.kind}</span>
                  <span>v{a.current_version}</span>
                  <span>{a.visibility}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
      {toast}
    </div>
  )
}
