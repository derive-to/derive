import { useNavigate } from "@tanstack/react-router"
import { Menu, Plus, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { type Artifact, api, type Collection, type Workspaces } from "@/api"
import { Header, useIsMobile, useToast } from "@/components"
import { EmptyState } from "@/components/shared/empty-state"
import { CenteredSpinner, Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/ctx"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { cn } from "@/lib/utils"
import { ArtifactCard } from "./artifact-card"
import { CollectionBar } from "./collection-bar"
import { ShareCollectionDialog } from "./share-collection-dialog"
import { Sidebar } from "./sidebar"
import type { Filter, Summary } from "./types"

const PAGE = 30

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
  const [workspaces, setWorkspaces] = useState<Workspaces | null>(null)

  const [query, setQuery] = useState("")
  const [debouncedQ, setDebouncedQ] = useState("")
  const [filter, setFilter] = useState<Filter>({ kind: "all" })
  const [rail, setRail] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.libraryRail) === "1"
    } catch {
      return false
    }
  })
  const [drawer, setDrawer] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.libraryRail, rail ? "1" : "0")
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
  const refreshWorkspaces = useCallback(() => {
    api
      .listWorkspaces()
      .then(setWorkspaces)
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (me) {
      refreshSummary()
      refreshCollections()
      refreshWorkspaces()
    }
  }, [me, refreshSummary, refreshCollections, refreshWorkspaces])

  // Switching or creating a workspace swaps the whole content context, so reload
  // the page rather than re-thread every list — a deliberate, infrequent action.
  const switchWorkspace = async (id: string) => {
    if (id === workspaces?.active) return
    try {
      await api.switchWorkspace(id)
      window.location.reload()
    } catch (e) {
      show((e as Error).message)
    }
  }
  const createWorkspace = async (name: string) => {
    try {
      await api.createWorkspace(name)
      window.location.reload()
    } catch (e) {
      show((e as Error).message)
    }
  }

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

  const emptyMessage = debouncedQ
    ? `No artifacts match “${debouncedQ}”.`
    : filter.kind === "favorites"
      ? "No favorites yet. Tap the ☆ on any artifact to star it."
      : filter.kind === "tag"
        ? `Nothing tagged #${filter.tag} yet.`
        : filter.kind === "collection"
          ? "This collection is empty. Open an artifact and add it from the 📁 menu."
          : "Nothing yet. Publish above, or run dock publish ./file."

  if (!me) return <CenteredSpinner />

  return (
    <div className="flex h-full flex-col">
      <Header
        left={
          isMobile ? (
            <Button
              variant="outline"
              size="icon"
              data-testid="library-menu"
              onClick={() => setDrawer(true)}
              title="Menu"
              aria-label="Open menu"
            >
              <Menu />
            </Button>
          ) : undefined
        }
      />
      <div className="flex min-h-0 flex-1">
        {isMobile && (
          <button
            type="button"
            data-testid="library-menu-backdrop"
            aria-label="Close menu"
            tabIndex={drawer ? 0 : -1}
            onClick={() => setDrawer(false)}
            className={cn(
              "fixed inset-0 z-[60] bg-black/35 transition-opacity",
              drawer ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          />
        )}
        <Sidebar
          rail={!isMobile && rail}
          drawer={isMobile}
          open={drawer}
          workspace={summary?.workspace ?? ""}
          workspaces={workspaces}
          total={summary?.total ?? 0}
          favCount={summary?.favorites ?? 0}
          tags={summary?.tags ?? []}
          collections={collections}
          filter={filter}
          onPick={pick}
          onCreateCollection={createCollection}
          onSwitchWorkspace={switchWorkspace}
          onCreateWorkspace={createWorkspace}
          onToggleRail={() => setRail((r) => !r)}
          onClose={() => setDrawer(false)}
          onSettings={() => {
            setDrawer(false)
            nav({ to: "/settings" })
          }}
        />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1000px] px-5.5 pb-16 pt-5.5">
            <div className="mb-[18px] flex flex-wrap items-center gap-2.5">
              <Input
                placeholder="Search by title…"
                data-testid="library-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-[200px] flex-1"
              />
              {filter.kind !== "all" && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="library-clear-filter"
                  onClick={() => setFilter({ kind: "all" })}
                >
                  {filter.kind === "favorites"
                    ? "★ Favorites"
                    : filter.kind === "tag"
                      ? `#${filter.tag}`
                      : `📁 ${filter.title}`}
                  <X />
                </Button>
              )}
            </div>

            {filter.kind !== "collection" && (
              <Card className="mb-5.5 flex flex-wrap items-center gap-3.5 p-4">
                <div className="min-w-[220px] flex-1">
                  <div className="font-display text-lg font-semibold">Publish an artifact</div>
                  <div className="text-sm text-muted-foreground">
                    Drop an HTML or Markdown file, or run{" "}
                    <code className="rounded bg-muted px-1.5 py-px font-mono text-[0.86em]">
                      dock publish
                    </code>
                    .
                  </div>
                </div>
                <input
                  ref={file}
                  type="file"
                  data-testid="library-file-input"
                  accept=".html,.htm,.md,.markdown,.zip"
                  className="max-w-[230px] text-sm text-muted-foreground"
                  onChange={publish}
                />
                <Button
                  variant="primary"
                  data-testid="library-publish"
                  onClick={publish}
                  disabled={busy}
                >
                  {busy ? (
                    "Publishing…"
                  ) : (
                    <>
                      <Plus /> Publish
                    </>
                  )}
                </Button>
              </Card>
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
              <h2 className="mb-3.5 font-display text-lg font-semibold">
                {heading}{" "}
                <span className="text-base font-normal text-muted-foreground">
                  · {headingCount}
                </span>
              </h2>
            )}

            {fetching && items.length === 0 ? (
              <div className="grid h-40 place-items-center">
                <Spinner />
              </div>
            ) : items.length === 0 ? (
              <EmptyState>{emptyMessage}</EmptyState>
            ) : (
              <>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                  {items.map((a) => (
                    <ArtifactCard
                      key={a.short_id}
                      artifact={a}
                      onOpen={() => nav({ to: "/a/$ref", params: { ref: a.short_id } })}
                      onToggleFavorite={() => toggleFav(a)}
                      onPickTag={(tag) => pick({ kind: "tag", tag })}
                    />
                  ))}
                </div>
                {nextCursor && (
                  <div className="mt-5 text-center">
                    <Button
                      variant="outline"
                      data-testid="library-load-more"
                      onClick={() => load(nextCursor)}
                      disabled={more}
                    >
                      {more ? "Loading…" : "Load more"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>
      {shareCol && (
        <ShareCollectionDialog
          collection={shareCol}
          show={show}
          onClose={() => setShareCol(null)}
        />
      )}
      {toast}
    </div>
  )
}
