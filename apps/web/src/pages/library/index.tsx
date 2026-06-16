import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { type Artifact, api } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { useShell } from "@/components/shell-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/ctx"
import { type LibraryParams, libraryArtifactsQuery, sharedArtifactsQuery } from "@/lib/queries"
import { usePrefetchArtifact } from "@/lib/use-prefetch-artifact"
import { ArtifactCard } from "./artifact-card"
import { ArtifactGrid } from "./artifact-grid"
import { CollectionBar } from "./collection-bar"
import { HowItWorks } from "./how-it-works"
import { LibrarySkeleton } from "./library-skeleton"
import { PublishCard } from "./publish-card"
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
  const { me } = useAuth()
  const { summary, collections, refreshSummary, workspaces } = useShell()
  const prefetch = usePrefetchArtifact()
  const qc = useQueryClient()
  // The library is the scroll container; the virtualized grid windows against it.
  const scrollRef = useRef<HTMLDivElement>(null)

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
  const { data, isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery(listQuery)
  const items = data?.pages.flatMap((p) => p.artifacts) ?? []

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

  // A personal header on the (otherwise bare) home view: lead with the user's
  // first name, falling back to their handle. Only on the unfiltered "all" list,
  // not while searching or inside a filter/collection.
  const firstName =
    me?.name?.trim().split(/\s+/)[0] ||
    (me?.username ? `@${me.username}` : me?.email?.split("@")[0]) ||
    "there"
  const totalCount = summary?.total ?? items.length
  const showGreeting = filter.kind === "all" && !debouncedQ
  const wsName = workspaces?.workspaces.find((w) => w.id === workspaces.active)?.name

  // "Shared with you": things explicitly shared, surfaced on the unfiltered home
  // above your own list. Only fetched there.
  const homeView = filter.kind === "all" && !debouncedQ
  const { data: sharedData } = useQuery({ ...sharedArtifactsQuery(), enabled: homeView })
  const sharedItems = homeView ? (sharedData ?? []) : []

  const openShared = async (a: Artifact) => {
    const on = !a.favorite
    qc.setQueryData(sharedArtifactsQuery().queryKey, (old) =>
      old?.map((x) => (x.short_id === a.short_id ? { ...x, favorite: on } : x)),
    )
    try {
      await api.favorite(a.short_id, on)
      refreshSummary()
    } catch (e) {
      toast.error((e as Error).message)
      qc.invalidateQueries({ queryKey: sharedArtifactsQuery().queryKey })
    }
  }

  // The "how it works" guide is for a truly blank slate: nothing of your own AND
  // nothing shared with you. If something's shared, that section carries the home.
  const emptyHome =
    homeView && !isPending && !isError && items.length === 0 && sharedItems.length === 0

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-5.5 pb-16 pt-5.5">
        {showGreeting && (
          <div
            className="mb-4 flex flex-wrap items-start justify-between gap-2"
            data-testid="library-greeting"
          >
            <div>
              <h1 className="font-display text-2xl font-semibold text-foreground">
                {totalCount === 0
                  ? `Welcome to Dock, ${firstName}.`
                  : `Welcome back, ${firstName}.`}
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Your artifacts live here. Publish one below, or run{" "}
                <code className="rounded bg-muted px-1.5 py-px font-mono text-[0.86em]">
                  dock publish
                </code>
                .
              </p>
            </div>
            {(me?.username || wsName) && (
              <div className="flex shrink-0 items-center gap-2 pt-1 text-2xs text-muted-foreground">
                {me?.username && (
                  <span className="font-medium text-foreground">@{me.username}</span>
                )}
                {wsName && (
                  <span className="rounded-full border border-border px-2 py-0.5">{wsName}</span>
                )}
              </div>
            )}
          </div>
        )}
        <div className="mb-[18px] flex flex-wrap items-center gap-2.5">
          <Input
            placeholder="Search by title…"
            aria-label="Search artifacts by title"
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

        {filter.kind !== "collection" && <PublishCard />}

        {sharedItems.length > 0 && (
          <section className="mb-6" data-testid="shared-with-you">
            <h2 className="mb-3.5 font-display text-lg font-semibold">
              Shared with you{" "}
              <span className="text-base font-normal text-muted-foreground">
                · {sharedItems.length}
              </span>
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3.5">
              {sharedItems.map((a) => (
                <ArtifactCard
                  key={a.short_id}
                  artifact={a}
                  onOpen={() => nav({ to: "/a/$ref", params: { ref: a.short_id } })}
                  onToggleFavorite={() => openShared(a)}
                  onPickTag={(tag) => nav({ to: "/", search: { tag } })}
                  onPrefetch={() => prefetch(a.short_id, a.current_version)}
                />
              ))}
            </div>
          </section>
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
          // Hide the "All artifacts · 0" heading on a brand-new empty home — the
          // visual guide carries it instead.
          !emptyHome && (
            <h2 className="mb-3.5 font-display text-lg font-semibold">
              {heading}{" "}
              <span className="text-base font-normal text-muted-foreground">· {headingCount}</span>
            </h2>
          )
        )}

        {isPending ? (
          <LibrarySkeleton />
        ) : isError ? (
          <EmptyState>
            <div className="flex flex-col items-center gap-3">
              <span>Couldn’t load the library. This is usually temporary.</span>
              <Button
                variant="outline"
                size="sm"
                data-testid="library-retry"
                onClick={() => refetch()}
              >
                Try again
              </Button>
            </div>
          </EmptyState>
        ) : items.length === 0 ? (
          emptyHome ? (
            <HowItWorks />
          ) : (
            <EmptyState>{emptyMessage}</EmptyState>
          )
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
