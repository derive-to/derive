import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { Plus, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { type Artifact, api } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { useShell } from "@/components/shell-context"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { type LibraryParams, libraryArtifactsQuery } from "@/lib/queries"
import { usePrefetchArtifact } from "@/lib/use-prefetch-artifact"
import { cn } from "@/lib/utils"
import { ArtifactGrid } from "./artifact-grid"
import { CollectionBar } from "./collection-bar"
import { LibrarySkeleton } from "./library-skeleton"
import { ShareCollectionDialog } from "./share-collection-dialog"
import type { Filter } from "./types"

// Route component for "/". The persistent AppShell (mounted once around the
// router Outlet) owns the rail/pod and the auth gate, so this just renders the
// library body. The filter lives in the URL, so the body reads it from search
// rather than local state.
export function Library() {
  return <LibraryBody />
}

function LibraryBody() {
  const nav = useNavigate()
  const search = useSearch({ from: "/" })
  const { summary, collections, refreshSummary } = useShell()
  const prefetch = usePrefetchArtifact()
  const qc = useQueryClient()
  const file = useRef<HTMLInputElement>(null)
  // The library is the scroll container; the virtualized grid windows against it.
  const scrollRef = useRef<HTMLDivElement>(null)

  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
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

  // Server-side search + filter + keyset pagination, as one infinite query keyed
  // by the active filter. Scrolling to the end pulls the next page.
  const params: LibraryParams = {
    q: debouncedQ || undefined,
    tag: search.tag,
    collection: search.collection,
    favorite: search.f === "favorites" || undefined,
  }
  const listQuery = libraryArtifactsQuery(params)
  const { data, isPending, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery(listQuery)
  const items = data?.pages.flatMap((p) => p.artifacts) ?? []

  // One publish path, fed by either a drag-drop or the native picker.
  const publishFile = async (f: File) => {
    setBusy(true)
    try {
      const a = await api.publish(f, { title: f.name.replace(/\.[^.]+$/, "") })
      nav({ to: "/a/$ref", params: { ref: a.short_id } })
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }
  // The "Publish" button opens the OS picker; choosing a file uploads immediately.
  const pickFile = () => file.current?.click()

  // Star toggle is optimistic across every cached page; in the Favorites view an
  // un-star drops the card. Reconcile against the server on failure.
  const toggleFav = async (a: Artifact) => {
    const on = !a.favorite
    const drop = filter.kind === "favorites" && !on
    qc.setQueryData(listQuery.queryKey, (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((pg) => ({
              ...pg,
              artifacts: pg.artifacts.flatMap((x) =>
                x.short_id !== a.short_id ? [x] : drop ? [] : [{ ...x, favorite: on }],
              ),
            })),
          }
        : old,
    )
    try {
      await api.favorite(a.short_id, on)
      refreshSummary()
    } catch (e) {
      toast.error((e as Error).message)
      qc.invalidateQueries({ queryKey: listQuery.queryKey })
    }
  }

  const renameCollection = async (id: string, title: string) => {
    await api.renameCollection(id, title).catch((e) => toast.error((e as Error).message))
    refreshSummary()
    nav({ to: "/", search: { collection: id } })
  }
  const deleteCollection = async (id: string) => {
    await api.deleteCollection(id).catch((e) => toast.error((e as Error).message))
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
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
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
              onClick={() => nav({ to: "/", search: {} })}
            >
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
          // The whole card is the drop target; the button opens the picker. One
          // affordance each — no stray native "Browse… no file selected" input.
          <Card
            className={cn(
              "mb-5.5 flex flex-wrap items-center gap-3.5 border-dashed p-4 transition-colors",
              dragging && "border-primary bg-primary/5",
            )}
            onDragOver={(e) => {
              e.preventDefault()
              if (!dragging) setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              const f = e.dataTransfer.files?.[0]
              if (f) publishFile(f)
            }}
          >
            <div className="min-w-[220px] flex-1">
              <div className="font-display text-lg font-semibold">Publish an artifact</div>
              <div className="text-sm text-muted-foreground">
                Drop an HTML or Markdown file here, or run{" "}
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
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) publishFile(f)
              }}
            />
            <Button
              variant="primary"
              data-testid="library-publish"
              onClick={pickFile}
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
            <span className="text-base font-normal text-muted-foreground">· {headingCount}</span>
          </h2>
        )}

        {isPending ? (
          <LibrarySkeleton />
        ) : isError ? (
          <EmptyState>Couldn’t load the library. Check your connection and try again.</EmptyState>
        ) : items.length === 0 ? (
          <EmptyState>{emptyMessage}</EmptyState>
        ) : (
          <>
            <ArtifactGrid
              items={items}
              scrollRef={scrollRef}
              hasNextPage={!!hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              onLoadMore={() => fetchNextPage()}
              onOpen={(a) => nav({ to: "/a/$ref", params: { ref: a.short_id } })}
              onToggleFavorite={toggleFav}
              onPickTag={(tag) => nav({ to: "/", search: { tag } })}
              onPrefetch={(a) => prefetch(a.short_id, a.current_version)}
            />
            {isFetchingNextPage && (
              <div
                className="mt-4 text-center text-sm text-muted-foreground"
                data-testid="library-loading-more"
              >
                Loading more…
              </div>
            )}
          </>
        )}

        {shareCol && (
          <ShareCollectionDialog collection={shareCol} onClose={() => setShareCol(null)} />
        )}
      </div>
    </div>
  )
}
