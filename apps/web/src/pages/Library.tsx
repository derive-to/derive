import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  API_BASE,
  type Artifact,
  type ArtifactMember,
  api,
  type Collection,
  type Role,
} from "../api"
import { Header, useIsMobile, useToast } from "../components"
import { useAuth } from "../ctx"

type Filter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "tag"; tag: string }
  | { kind: "collection"; id: string; title: string }
type TagCount = { tag: string; count: number }
type Summary = { total: number; favorites: number; tags: TagCount[]; workspace: string }

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
  const [collections, setCollections] = useState<Collection[]>([])
  const [shareCol, setShareCol] = useState<Collection | null>(null)

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
          collection: filter.kind === "collection" ? filter.id : undefined,
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
  const refreshCollections = useCallback(() => {
    api
      .listCollections()
      .then((r) => setCollections(r.collections))
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (me) {
      refreshSummary()
      refreshCollections()
    }
  }, [me, refreshSummary, refreshCollections])

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
  const createCollection = async (title: string) => {
    try {
      const col = await api.createCollection(title)
      refreshCollections()
      pick({ kind: "collection", id: col.id, title: col.title })
    } catch (e) {
      show((e as Error).message)
    }
  }
  const renameCollection = async (id: string, title: string) => {
    await api.renameCollection(id, title).catch((e) => show((e as Error).message))
    refreshCollections()
    setFilter((f) => (f.kind === "collection" && f.id === id ? { ...f, title } : f))
  }
  const deleteCollection = async (id: string) => {
    await api.deleteCollection(id).catch((e) => show((e as Error).message))
    refreshCollections()
    setFilter({ kind: "all" })
  }

  const activeCollection =
    filter.kind === "collection" ? collections.find((c) => c.id === filter.id) : undefined
  const heading =
    filter.kind === "all"
      ? "All artifacts"
      : filter.kind === "favorites"
        ? "Favorites"
        : filter.kind === "tag"
          ? `#${filter.tag}`
          : filter.title
  const headingCount = debouncedQ
    ? items.length
    : filter.kind === "all"
      ? (summary?.total ?? items.length)
      : filter.kind === "favorites"
        ? (summary?.favorites ?? items.length)
        : filter.kind === "tag"
          ? (summary?.tags.find((t) => t.tag === filter.tag)?.count ?? items.length)
          : (activeCollection?.count ?? items.length)

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
          workspace={summary?.workspace ?? ""}
          total={summary?.total ?? 0}
          favCount={summary?.favorites ?? 0}
          tags={summary?.tags ?? []}
          collections={collections}
          filter={filter}
          onPick={pick}
          onCreateCollection={createCollection}
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
                  {filter.kind === "favorites"
                    ? "★ Favorites"
                    : filter.kind === "tag"
                      ? `#${filter.tag}`
                      : `📁 ${filter.title}`}{" "}
                  ✕
                </button>
              )}
            </div>

            {filter.kind !== "collection" && (
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
                    Drop an HTML or Markdown file, or run <code className="mono">dock publish</code>
                    .
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
            )}

            {filter.kind === "collection" ? (
              <CollectionBar
                title={heading}
                count={headingCount}
                onShare={() => activeCollection && setShareCol(activeCollection)}
                onRename={(t) => renameCollection(filter.id, t)}
                onDelete={() => deleteCollection(filter.id)}
              />
            ) : (
              <h2 className="display" style={{ fontSize: 17, margin: "0 0 14px" }}>
                {heading}{" "}
                <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
                  · {headingCount}
                </span>
              </h2>
            )}

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
                  {items.map((a) => {
                    const open = () => nav({ to: "/a/$ref", params: { ref: a.short_id } })
                    return (
                      <div key={a.short_id} className="card browse-card">
                        <div className="browse-thumb">
                          <Thumb id={a.short_id} v={a.current_version} />
                          <button
                            type="button"
                            className={`star${a.favorite ? " on" : ""}`}
                            title={a.favorite ? "Remove from favorites" : "Add to favorites"}
                            aria-label="Toggle favorite"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleFav(a)
                            }}
                          >
                            {a.favorite ? "★" : "☆"}
                          </button>
                        </div>
                        {/* The button's ::after is stretched over the whole card, so a
                            click anywhere (thumbnail included) opens the artifact; the
                            star + tag chips sit above it and stay independently clickable. */}
                        <button
                          type="button"
                          className="card-open"
                          onClick={open}
                          aria-label={`Open ${a.title ?? a.short_id}`}
                        >
                          <span className="display card-title">{a.title ?? a.short_id}</span>
                          <span className="mono card-meta">
                            <span className="card-kind">{a.kind}</span>
                            <span>v{a.current_version}</span>
                            {a.views !== undefined && a.views > 0 && (
                              <span className="card-views" title={`${a.views} viewers`}>
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
                                type="button"
                                className="tagchip"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  pick({ kind: "tag", tag: t })
                                }}
                              >
                                #{t}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
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
      {shareCol && (
        <CollectionShareDialog
          collection={shareCol}
          show={show}
          onClose={() => setShareCol(null)}
        />
      )}
      {toast}
    </div>
  )
}

// The bar shown when viewing a collection: title, count, and the owner actions
// (share / rename / delete). Share is the headline — it grants the role on
// every artifact in the collection.
function CollectionBar({
  title,
  count,
  onShare,
  onRename,
  onDelete,
}: {
  title: string
  count: number
  onShare: () => void
  onRename: (title: string) => void
  onDelete: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(title)
  useEffect(() => setDraft(title), [title])
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        margin: "0 0 16px",
        paddingBottom: 14,
        borderBottom: "1px solid var(--line-soft)",
      }}
    >
      <span style={{ fontSize: 19 }}>📁</span>
      {renaming ? (
        <input
          className="input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              onRename(draft.trim())
              setRenaming(false)
            }
            if (e.key === "Escape") setRenaming(false)
          }}
          style={{ maxWidth: 280, fontSize: 16, fontWeight: 600 }}
        />
      ) : (
        <h2 className="display" style={{ fontSize: 19, margin: 0 }}>
          {title}{" "}
          <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
            · {count}
          </span>
        </h2>
      )}
      <span style={{ flex: 1 }} />
      <button className="btn sm pri" onClick={onShare} title="Share this collection">
        🔗 Share
      </button>
      <button
        className="btn sm"
        onClick={() =>
          renaming ? (onRename(draft.trim()), setRenaming(false)) : setRenaming(true)
        }
      >
        {renaming ? "Save" : "Rename"}
      </button>
      <button
        className="btn sm"
        style={{ color: "var(--bad)" }}
        onClick={() => {
          if (confirm(`Delete the collection “${title}”? The artifacts are not deleted.`))
            onDelete()
        }}
      >
        Delete
      </button>
    </div>
  )
}

// Share a collection: add people by email at a role. A member's role applies to
// every artifact in the collection (the headline of collection-level sharing).
function CollectionShareDialog({
  collection,
  show,
  onClose,
}: {
  collection: Collection
  show: (m: string) => void
  onClose: () => void
}) {
  const [members, setMembers] = useState<ArtifactMember[]>([])
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    api
      .listCollectionMembers(collection.id)
      .then((r) => setMembers(r.members))
      .catch(() => {})
  }, [collection.id])
  useEffect(() => {
    load()
  }, [load])
  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const addr = email.trim()
    if (!addr) return
    setBusy(true)
    try {
      await api.setCollectionMember(collection.id, addr, role)
      setEmail("")
      load()
    } catch (x) {
      show((x as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (m: ArtifactMember) => {
    await api.removeCollectionMember(collection.id, m.user_id).catch(() => {})
    load()
  }
  const ROLES: Role[] = ["viewer", "commenter", "editor", "owner"]
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismissal mirrors the ✕ button.
    <div
      className="sheet-backdrop show"
      style={{ display: "grid", placeItems: "center", padding: 18 }}
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stop click-through to the backdrop. */}
      <div
        className="card"
        style={{ width: 380, maxWidth: "100%", padding: 18, boxShadow: "var(--shadow)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <b className="display" style={{ fontSize: 15 }}>
            Share “{collection.title}”
          </b>
          <span style={{ flex: 1 }} />
          <button
            className="btn sm"
            onClick={onClose}
            aria-label="Close"
            style={{ padding: "4px 9px" }}
          >
            ✕
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
          People here get this role on <b>every artifact</b> in the collection.
        </p>
        <form onSubmit={add} style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <input
            className="input"
            type="email"
            placeholder="teammate@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ flex: 1, padding: "7px 9px", fontSize: 13 }}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="input"
            style={{ width: 104, padding: "7px 6px", fontSize: 12 }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button className="btn pri sm" type="submit" disabled={busy}>
            {busy ? "…" : "Add"}
          </button>
        </form>
        {members.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No one shared yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {members.map((m) => (
              <div key={m.user_id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {m.name ?? m.email ?? m.user_id}
                  </div>
                  {m.name && m.email && (
                    <div className="muted" style={{ fontSize: 10.5 }}>
                      {m.email}
                    </div>
                  )}
                </div>
                <span className="mono muted" style={{ fontSize: 11 }}>
                  {m.role}
                </span>
                <button
                  className="lnk"
                  onClick={() => remove(m)}
                  title="Remove"
                  style={{ textDecoration: "none", fontSize: 14 }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Sidebar({
  rail,
  drawer,
  open,
  workspace,
  total,
  favCount,
  tags,
  collections,
  filter,
  onPick,
  onCreateCollection,
  onToggleRail,
  onClose,
  onSettings,
}: {
  rail: boolean
  drawer: boolean
  open: boolean
  workspace: string
  total: number
  favCount: number
  tags: TagCount[]
  collections: Collection[]
  filter: Filter
  onPick: (f: Filter) => void
  onCreateCollection: (title: string) => void
  onToggleRail: () => void
  onClose: () => void
  onSettings: () => void
}) {
  const cls = drawer ? `side side-drawer${open ? " open" : ""}` : `side${rail ? " rail" : ""}`
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const submit = () => {
    const t = name.trim()
    if (t) onCreateCollection(t)
    setName("")
    setCreating(false)
  }
  return (
    <aside className={cls} aria-label="Browse">
      {!rail && workspace && (
        <button
          className="side-item"
          onClick={onSettings}
          title="Workspace settings"
          style={{ fontWeight: 600 }}
        >
          <span className="ic">◆</span>
          <span className="lbl" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {workspace}
          </span>
        </button>
      )}
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

      <div className="side-lbl" style={{ display: "flex", alignItems: "center" }}>
        <span className="lbl" style={{ flex: 1 }}>
          Collections
        </span>
        <button
          className="lbl"
          onClick={() => setCreating((v) => !v)}
          title="New collection"
          style={{
            border: 0,
            background: "transparent",
            color: "var(--accent-ink, var(--ac))",
            cursor: "pointer",
            fontSize: 13,
            padding: 0,
          }}
        >
          ＋
        </button>
      </div>
      {creating && (
        <input
          className="input lbl"
          value={name}
          autoFocus
          placeholder="Collection name…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit()
            if (e.key === "Escape") {
              setCreating(false)
              setName("")
            }
          }}
          onBlur={submit}
          style={{ margin: "2px 4px 6px", padding: "6px 9px", fontSize: 13 }}
        />
      )}
      {collections.map((col) => (
        <button
          key={col.id}
          className={`side-item${filter.kind === "collection" && filter.id === col.id ? " on" : ""}`}
          onClick={() => onPick({ kind: "collection", id: col.id, title: col.title })}
          title={col.title}
        >
          <span className="ic">📁</span>
          <span className="lbl" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {col.title}
          </span>
          <span className="n">{col.count}</span>
        </button>
      ))}

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
        : filter.kind === "collection"
          ? "This collection is empty. Open an artifact and add it from the 📁 menu."
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
