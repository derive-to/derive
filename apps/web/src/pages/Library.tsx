import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { API_BASE, type Artifact, api } from "../api"
import { Header, useIsMobile, useToast } from "../components"
import { useAuth } from "../ctx"

type Filter = { kind: "all" } | { kind: "favorites" } | { kind: "tag"; tag: string }

const RAIL_KEY = "dock.browse.rail"

// A live, scaled-down render of the artifact's current version. Sandboxed and
// non-interactive (clicks fall through to the card); lazy so off-screen cards
// don't fetch. The gradient shows through until the frame paints.
function Thumb({ id, v }: { id: string; v: number }) {
  return (
    <div
      style={{
        height: 116,
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid var(--line-soft)",
        background: "linear-gradient(135deg,var(--ac-soft),var(--card-2))",
        position: "relative",
      }}
    >
      <iframe
        title=""
        aria-hidden
        tabIndex={-1}
        loading="lazy"
        src={`${API_BASE}/raw/${id}/v/${v}/index.html`}
        sandbox="allow-scripts"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "250%",
          height: "250%",
          transform: "scale(.4)",
          transformOrigin: "top left",
          border: 0,
          background: "#fff",
          pointerEvents: "none",
        }}
      />
    </div>
  )
}

export function Library() {
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const isMobile = useIsMobile()
  const [items, setItems] = useState<Artifact[] | null>(null)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const { toast, show } = useToast()

  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>({ kind: "all" })
  const [rail, setRail] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === "1"
    } catch {
      return false
    }
  })
  const [drawer, setDrawer] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, rail ? "1" : "0")
    } catch {
      /* private mode */
    }
  }, [rail])

  useEffect(() => {
    if (!loading && !me) nav({ to: "/login" })
  }, [loading, me, nav])
  useEffect(() => {
    if (me)
      api
        .listArtifacts()
        .then((r) => setItems(r.artifacts))
        .catch(() => setItems([]))
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

  // Star toggle is optimistic: reflect immediately, reconcile/revert on error.
  const toggleFav = async (a: Artifact) => {
    const on = !a.favorite
    const flip = (val: boolean) =>
      setItems((p) => p?.map((x) => (x.short_id === a.short_id ? { ...x, favorite: val } : x)) ?? p)
    flip(on)
    try {
      await api.favorite(a.short_id, on)
    } catch (e) {
      show((e as Error).message)
      flip(!on)
    }
  }

  const all = items ?? []
  const favCount = all.filter((a) => a.favorite).length
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of all) for (const t of a.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
    return [...m.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
  }, [all])

  const filtered = useMemo(() => {
    let list = all
    if (filter.kind === "favorites") list = list.filter((a) => a.favorite)
    else if (filter.kind === "tag") list = list.filter((a) => (a.tags ?? []).includes(filter.tag))
    const q = query.trim().toLowerCase()
    if (q)
      list = list.filter(
        (a) =>
          (a.title ?? a.short_id).toLowerCase().includes(q) ||
          (a.tags ?? []).some((t) => t.includes(q)),
      )
    return list
  }, [all, filter, query])

  const pick = (f: Filter) => {
    setFilter(f)
    setDrawer(false)
  }
  const heading =
    filter.kind === "all"
      ? "All artifacts"
      : filter.kind === "favorites"
        ? "Favorites"
        : `#${filter.tag}`

  if (!me)
    return (
      <div className="center">
        <div className="spin" />
      </div>
    )

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Header
        left={
          isMobile ? (
            <button
              className="btn sm"
              onClick={() => setDrawer(true)}
              title="Menu"
              aria-label="Open menu"
              style={{ padding: "5px 10px", fontSize: 15 }}
            >
              ☰
            </button>
          ) : undefined
        }
      />
      <div className="browse">
        {isMobile && (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop mirrors the close button.
          <div
            className={`drawer-backdrop${drawer ? " show" : ""}`}
            onClick={() => setDrawer(false)}
            aria-hidden
          />
        )}
        <Sidebar
          rail={!isMobile && rail}
          drawer={isMobile}
          open={drawer}
          total={all.length}
          favCount={favCount}
          tags={tagCounts}
          filter={filter}
          onPick={pick}
          onToggleRail={() => setRail((r) => !r)}
          onClose={() => setDrawer(false)}
          onSettings={() => {
            setDrawer(false)
            nav({ to: "/settings" })
          }}
        />
        <main className="browse-main">
          <div style={{ maxWidth: 1000, margin: "0 auto", padding: "22px 22px 64px" }}>
            <div className="searchbar">
              <input
                className="input"
                placeholder="Search by title or tag…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ flex: 1, minWidth: 200 }}
              />
              {filter.kind !== "all" && (
                <button className="btn sm" onClick={() => setFilter({ kind: "all" })}>
                  {filter.kind === "favorites" ? "★ Favorites" : `#${filter.tag}`} ✕
                </button>
              )}
            </div>

            <div
              className="card"
              style={{
                padding: 16,
                marginBottom: 22,
                display: "flex",
                alignItems: "center",
                gap: 14,
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="display" style={{ fontWeight: 600, fontSize: 15 }}>
                  Publish an artifact
                </div>
                <div className="muted" style={{ fontSize: 13 }}>
                  Drop an HTML or Markdown file, or run <code className="mono">dock publish</code>.
                </div>
              </div>
              <input
                ref={file}
                type="file"
                accept=".html,.htm,.md,.markdown,.zip"
                style={{ maxWidth: 230, fontSize: 12 }}
                onChange={publish}
              />
              <button className="btn pri" onClick={publish} disabled={busy}>
                {busy ? "Publishing…" : "Publish"}
              </button>
            </div>

            <h2 className="display" style={{ fontSize: 17, margin: "0 0 14px" }}>
              {heading}{" "}
              <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
                · {filtered.length}
              </span>
            </h2>

            {items === null ? (
              <div className="center" style={{ height: 160 }}>
                <div className="spin" />
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState filter={filter} query={query} />
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))",
                  gap: 13,
                }}
              >
                {filtered.map((a) => (
                  <div key={a.short_id} className="card browse-card">
                    <div style={{ position: "relative" }}>
                      <Thumb id={a.short_id} v={a.current_version} />
                      <button
                        className={`star${a.favorite ? " on" : ""}`}
                        title={a.favorite ? "Remove from favorites" : "Add to favorites"}
                        aria-label="Toggle favorite"
                        onClick={() => toggleFav(a)}
                      >
                        {a.favorite ? "★" : "☆"}
                      </button>
                    </div>
                    <button
                      className="card-open"
                      onClick={() => nav({ to: "/a/$ref", params: { ref: a.short_id } })}
                    >
                      <span className="display" style={{ fontWeight: 600, fontSize: 15 }}>
                        {a.title ?? a.short_id}
                      </span>
                      <span
                        className="mono muted"
                        style={{ fontSize: 11, display: "flex", gap: 8, alignItems: "center" }}
                      >
                        <span
                          style={{
                            background: "var(--card-2)",
                            border: "1px solid var(--line-soft)",
                            borderRadius: 5,
                            padding: "1px 6px",
                          }}
                        >
                          {a.kind}
                        </span>
                        <span>v{a.current_version}</span>
                        {a.views !== undefined && a.views > 0 && (
                          <span style={{ marginLeft: "auto" }} title={`${a.views} views`}>
                            👁 {a.views > 999 ? `${(a.views / 1000).toFixed(1)}k` : a.views}
                          </span>
                        )}
                      </span>
                    </button>
                    {(a.tags ?? []).length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {(a.tags ?? []).slice(0, 6).map((t) => (
                          <button
                            key={t}
                            className="tagchip"
                            onClick={() => pick({ kind: "tag", tag: t })}
                          >
                            #{t}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
      {toast}
    </div>
  )
}

function Sidebar({
  rail,
  drawer,
  open,
  total,
  favCount,
  tags,
  filter,
  onPick,
  onToggleRail,
  onClose,
  onSettings,
}: {
  rail: boolean
  drawer: boolean
  open: boolean
  total: number
  favCount: number
  tags: [string, number][]
  filter: Filter
  onPick: (f: Filter) => void
  onToggleRail: () => void
  onClose: () => void
  onSettings: () => void
}) {
  const cls = drawer ? `side side-drawer${open ? " open" : ""}` : `side${rail ? " rail" : ""}`
  return (
    <aside className={cls} aria-label="Browse">
      <div className="side-lbl">Library</div>
      <button
        className={`side-item${filter.kind === "all" ? " on" : ""}`}
        onClick={() => onPick({ kind: "all" })}
        title="All artifacts"
      >
        <span className="ic">⊞</span>
        <span className="lbl">All artifacts</span>
        <span className="n">{total}</span>
      </button>
      <button
        className={`side-item${filter.kind === "favorites" ? " on" : ""}`}
        onClick={() => onPick({ kind: "favorites" })}
        title="Favorites"
      >
        <span className="ic">★</span>
        <span className="lbl">Favorites</span>
        <span className="n">{favCount}</span>
      </button>

      {tags.length > 0 && (
        <>
          <div className="side-lbl">Tags</div>
          {tags.map(([t, n]) => (
            <button
              key={t}
              className={`side-item${filter.kind === "tag" && filter.tag === t ? " on" : ""}`}
              onClick={() => onPick({ kind: "tag", tag: t })}
              title={`#${t}`}
            >
              <span className="ic">#</span>
              <span className="lbl" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {t}
              </span>
              <span className="n">{n}</span>
            </button>
          ))}
        </>
      )}

      <div
        style={{
          marginTop: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 1,
          paddingTop: 8,
        }}
      >
        <button className="side-item" onClick={onSettings} title="Settings">
          <span className="ic">⚙</span>
          <span className="lbl">Settings</span>
        </button>
        {drawer ? (
          <button className="side-toggle" onClick={onClose}>
            <span className="ic">✕</span>
            <span className="lbl">Close</span>
          </button>
        ) : (
          <button
            className="side-toggle"
            onClick={onToggleRail}
            title={rail ? "Expand sidebar" : "Collapse sidebar"}
          >
            <span className="ic">{rail ? "»" : "«"}</span>
            <span className="lbl">Collapse</span>
          </button>
        )}
      </div>
    </aside>
  )
}

function EmptyState({ filter, query }: { filter: Filter; query: string }) {
  const msg = query
    ? `No artifacts match “${query}”.`
    : filter.kind === "favorites"
      ? "No favorites yet. Tap the ☆ on any artifact to star it."
      : filter.kind === "tag"
        ? `Nothing tagged #${filter.tag} yet.`
        : "Nothing yet. Publish above, or run dock publish ./file."
  return (
    <div
      className="muted"
      style={{
        textAlign: "center",
        padding: 40,
        border: "1px dashed var(--line)",
        borderRadius: 14,
      }}
    >
      {msg}
    </div>
  )
}
