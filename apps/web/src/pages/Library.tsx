import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { API_BASE, type Artifact, api } from "../api"
import { Header, useIsMobile, useToast } from "../components"
import { useAuth } from "../ctx"

type Filter = { kind: "all" } | { kind: "favorites" } | { kind: "tag"; tag: string }
type TagCount = { tag: string; count: number }
type Summary = { total: number; favorites: number; tags: TagCount[] }

const RAIL_KEY = "dock.browse.rail"
const PAGE = 30

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
  const file = useRef<HTMLInputElement>(null)
  const { toast, show } = useToast()

  const [items, setItems] = useState<Artifact[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [fetching, setFetching] = useState(true)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)

  const [query, setQuery] = useState("")
  const [debouncedQ, setDebouncedQ] = useState("")
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

  // Debounce typing into a server query.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 280)
    return () => clearTimeout(t)
  }, [query])

  // Server-side search + filter + keyset pagination. Page 1 on every
  // query/filter change; `cursor` appends the next page.
  const load = useCallback(
    async (cursor?: string) => {
      cursor ? setMore(true) : setFetching(true)
      try {
        const r = await api.listArtifacts({
          q: debouncedQ || undefined,
          tag: filter.kind === "tag" ? filter.tag : undefined,
          favorite: filter.kind === "favorites" || undefined,
          cursor,
          limit: PAGE,
        })
        setItems((prev) => (cursor ? [...prev, ...r.artifacts] : r.artifacts))
        setNextCursor(r.next_cursor)
      } catch {
        if (!cursor) setItems([])
      } finally {
        setFetching(false)
        setMore(false)
      }
    },
    [debouncedQ, filter],
  )
  useEffect(() => {
    if (me) load()
  }, [me, load])

  const refreshSummary = useCallback(() => {
    api
      .browseSummary()
      .then(setSummary)
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (me) refreshSummary()
  }, [me, refreshSummary])

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

  // Star toggle is optimistic; in the Favorites view an un-star drops the card.
  const toggleFav = async (a: Artifact) => {
    const on = !a.favorite
    setItems((prev) => {
      const next = prev.map((x) => (x.short_id === a.short_id ? { ...x, favorite: on } : x))
      return filter.kind === "favorites" && !on
        ? next.filter((x) => x.short_id !== a.short_id)
        : next
    })
    try {
      await api.favorite(a.short_id, on)
      refreshSummary()
    } catch (e) {
      show((e as Error).message)
      load()
    }
  }

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
  const headingCount = debouncedQ
    ? items.length
    : filter.kind === "all"
      ? (summary?.total ?? items.length)
      : filter.kind === "favorites"
        ? (summary?.favorites ?? items.length)
        : (summary?.tags.find((t) => t.tag === filter.tag)?.count ?? items.length)

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
          total={summary?.total ?? 0}
          favCount={summary?.favorites ?? 0}
          tags={summary?.tags ?? []}
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
                placeholder="Search by title…"
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
                · {headingCount}
              </span>
            </h2>

            {fetching && items.length === 0 ? (
              <div className="center" style={{ height: 160 }}>
                <div className="spin" />
              </div>
            ) : items.length === 0 ? (
              <EmptyState filter={filter} query={debouncedQ} />
            ) : (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))",
                    gap: 13,
                  }}
                >
                  {items.map((a) => (
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
                {nextCursor && (
                  <div style={{ textAlign: "center", marginTop: 20 }}>
                    <button className="btn" onClick={() => load(nextCursor)} disabled={more}>
                      {more ? "Loading…" : "Load more"}
                    </button>
                  </div>
                )}
              </>
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
  tags: TagCount[]
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
          {tags.map(({ tag, count }) => (
            <button
              key={tag}
              className={`side-item${filter.kind === "tag" && filter.tag === tag ? " on" : ""}`}
              onClick={() => onPick({ kind: "tag", tag })}
              title={`#${tag}`}
            >
              <span className="ic">#</span>
              <span className="lbl" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {tag}
              </span>
              <span className="n">{count}</span>
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
