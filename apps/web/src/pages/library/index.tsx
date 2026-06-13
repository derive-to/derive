import { useNavigate, useSearch } from "@tanstack/react-router"
import { Plus, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { type Artifact, api } from "@/api"
import { AppShell } from "@/components/app-shell"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { CenteredSpinner, Spinner } from "@/components/shared/spinner"
import { useShell } from "@/components/shell-context"
import { useToast } from "@/components/toast"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/ctx"
import { ArtifactCard } from "./artifact-card"
import { CollectionBar } from "./collection-bar"
import { ShareCollectionDialog } from "./share-collection-dialog"
import type { Filter } from "./types"

const PAGE = 30

// Route component for "/". Auth-gates, then renders the library inside the app
// shell (which owns the nav rail + pod). The filter lives in the URL, so the body
// reads it from search rather than local state.
export function Library() {
  const { me, loading } = useAuth()
  const nav = useNavigate()
  useEffect(() => {
    if (!loading && !me) nav({ to: "/login" })
  }, [loading, me, nav])
  if (!me) return <CenteredSpinner />
  return (
    <AppShell>
      <LibraryBody />
    </AppShell>
  )
}

function LibraryBody() {
  const nav = useNavigate()
  const search = useSearch({ from: "/" })
  const { summary, collections, refreshSummary } = useShell()
  const { toast, show } = useToast()
  const file = useRef<HTMLInputElement>(null)

  const [items, setItems] = useState<Artifact[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [fetching, setFetching] = useState(true)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [shareCol, setShareCol] = useState<(typeof collections)[number] | null>(null)
  const [query, setQuery] = useState(search.q ?? "")
  const [debouncedQ, setDebouncedQ] = useState((search.q ?? "").trim())

  // Derive the active filter from the URL search params.
  const filter: Filter =
    search.f === "favorites"
      ? { kind: "favorites" }
      : search.tag
        ? { kind: "tag", tag: search.tag }
        : search.collection
          ? {
              kind: "collection",
              id: search.collection,
              title: collections.find((c) => c.id === search.collection)?.title ?? "Collection",
            }
          : { kind: "all" }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 280)
    return () => clearTimeout(t)
  }, [query])

  // Server-side search + filter + keyset pagination. Page 1 on any query/filter
  // change; `cursor` appends the next page.
  const load = useCallback(
    async (cursor?: string) => {
      cursor ? setMore(true) : setFetching(true)
      try {
        const r = await api.listArtifacts({
          q: debouncedQ || undefined,
          tag: search.tag,
          collection: search.collection,
          favorite: search.f === "favorites" || undefined,
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
    [debouncedQ, search.f, search.tag, search.collection],
  )
  useEffect(() => {
    load()
  }, [load])

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

  const renameCollection = async (id: string, title: string) => {
    await api.renameCollection(id, title).catch((e) => show((e as Error).message))
    refreshSummary()
    nav({ to: "/", search: { collection: id } })
  }
  const deleteCollection = async (id: string) => {
    await api.deleteCollection(id).catch((e) => show((e as Error).message))
    nav({ to: "/", search: {} })
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
      ? "No favorites yet. Tap the star on any artifact to save it."
      : filter.kind === "tag"
        ? `Nothing tagged #${filter.tag} yet.`
        : filter.kind === "collection"
          ? "This collection is empty. Open an artifact and add it from its Collections menu."
          : "Nothing yet. Publish above, or run dock publish ./file."

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-5.5 pb-16 pt-5.5">
        <div className="mb-[18px] flex flex-wrap items-center gap-2.5">
          <Input
            placeholder="Search by title…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-[200px] flex-1"
          />
          {filter.kind !== "all" && (
            <Button variant="outline" size="sm" onClick={() => nav({ to: "/", search: {} })}>
              {filter.kind === "favorites" ? (
                <>
                  <Icon name="favorites" size={15} /> Favorites
                </>
              ) : filter.kind === "tag" ? (
                `#${filter.tag}`
              ) : (
                <>
                  <Icon name="collection" size={15} /> {filter.title}
                </>
              )}
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
              accept=".html,.htm,.md,.markdown,.zip"
              className="max-w-[230px] text-sm text-muted-foreground"
              onChange={publish}
            />
            <Button variant="primary" onClick={publish} disabled={busy}>
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
            <span className="text-base font-normal text-muted-foreground">· {headingCount}</span>
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
                  onPickTag={(tag) => nav({ to: "/", search: { tag } })}
                />
              ))}
            </div>
            {nextCursor && (
              <div className="mt-5 text-center">
                <Button variant="outline" onClick={() => load(nextCursor)} disabled={more}>
                  {more ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}

        {shareCol && (
          <ShareCollectionDialog
            collection={shareCol}
            show={show}
            onClose={() => setShareCol(null)}
          />
        )}
        {toast}
      </div>
    </div>
  )
}
