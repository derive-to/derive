import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { FolderTree, List } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { type Artifact, api } from "@/api"
import { Icon } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { SearchField } from "@/components/shared/search-field"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAuth } from "@/ctx"
import {
  collectionsQuery,
  type LibraryParams,
  libraryArtifactsQuery,
  needsFeedbackArtifactsQuery,
  sharedArtifactsQuery,
  summaryQuery,
} from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { useDelayedPending } from "@/lib/use-delayed-pending"
import { useFollows } from "@/lib/use-follows"
import { usePrefetchArtifact } from "@/lib/use-prefetch-artifact"
import { refFor } from "../artifact/parse-ref"
import { ArtifactCard } from "./artifact-card"
import { ArtifactGrid } from "./artifact-grid"
import { ArtifactRow, byRecency } from "./artifact-row"
import { CardGrid } from "./card-grid"
import { CollectionBar } from "./collection-bar"
import { FolderGroups } from "./folder-groups"
import { FollowingStrip } from "./following-strip"
import { HowItWorks } from "./how-it-works"
import { LibrarySkeleton } from "./library-skeleton"
import { PublishCard } from "./publish-card"
import { RepoPullRequests } from "./repo-pull-requests"
import { ShareCollectionDialog } from "./share-collection-dialog"
import type { Filter, LibrarySearch, LibraryView } from "./types"

// The library surface, shared by three routes: "/" (all artifacts), "/favorites",
// and "/following". The base feed comes from the route (the `view` prop); the
// filters + search come from the URL query. The persistent AppShell (mounted once
// around the router Outlet) owns the rail/pod and the auth gate, so this just
// renders the library body.
export function Library({ view }: { view: LibraryView }) {
  return <LibraryBody view={view} />
}

function LibraryBody({ view }: { view: LibraryView }) {
  const nav = useNavigate()
  // Read the query params loosely: this one body renders under three routes, so it
  // can't bind to a single route's search shape. The base feed is `view` (the route);
  // tag/collection/q/author are the filters that compose on top (docs/decisions/0002).
  const search = useSearch({ strict: false }) as LibrarySearch
  const { me } = useAuth()
  const { data: summary } = useQuery({ ...summaryQuery(), enabled: !!me })
  const { data: collections = [] } = useQuery({ ...collectionsQuery(), enabled: !!me })
  const prefetch = usePrefetchArtifact()
  const qc = useQueryClient()
  // The library is the scroll container; the virtualized grid windows against it.
  const scrollRef = useRef<HTMLDivElement>(null)

  const [shareCol, setShareCol] = useState<(typeof collections)[number] | null>(null)
  const [query, setQuery] = useState(search.query ?? "")
  const [debouncedQ, setDebouncedQ] = useState((search.query ?? "").trim())
  // Folder vs flat-list view (synced collections). Off by default (a flat,
  // most-recently-updated list is the default for a synced collection); remembered.
  const [showFolders, setShowFolders] = useState(
    () =>
      typeof window !== "undefined" && localStorage.getItem(STORAGE_KEYS.libraryFolders) === "1",
  )
  const toggleFolders = (on: boolean) => {
    setShowFolders(on)
    localStorage.setItem(STORAGE_KEYS.libraryFolders, on ? "1" : "0")
  }

  // The active filter = the base feed (from the route: `view`) unless it's the home
  // library, where a tag/collection query param narrows it. Favorites/Following are
  // their own routes now, so tag/collection (which live only on "/") can't apply.
  const filter: Filter =
    view === "favorites"
      ? { kind: "favorites" }
      : view === "following"
        ? { kind: "following" }
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
    favorite: view === "favorites" || undefined,
    author: search.author,
    scope: view === "following" ? "following" : undefined,
  }
  const listQuery = libraryArtifactsQuery(params)
  const { data, isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery(listQuery)
  // Hold the skeleton back ~150ms so a cache-warm / fast first load flashes nothing
  // (keepPreviousData already keeps the current grid across filter changes, so this
  // only ever gates the true first load).
  const showSkeleton = useDelayedPending(isPending)
  const items = data?.pages.flatMap((p) => p.artifacts) ?? []

  // A synced repo collection (artifacts carry a source_path) gets the folder/flat
  // treatment: a flat, most-recently-updated list by default, with an optional folder
  // view. Other lists (home, tags, favorites, hand-built collections) keep the grid.
  const isSyncedCollection = filter.kind === "collection" && items.some((a) => a.source_path)
  // Pull the whole collection so the sort + grouping see every doc (collections are
  // finite and scoping keeps them small) — same as the folder view always did.
  useEffect(() => {
    if (isSyncedCollection && hasNextPage && !isFetchingNextPage) fetchNextPage()
  }, [isSyncedCollection, hasNextPage, isFetchingNextPage, fetchNextPage])
  // Default order everywhere a synced collection renders: most recently updated first.
  const recencyItems = isSyncedCollection ? [...items].sort(byRecency) : items

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
      qc.invalidateQueries({ queryKey: summaryQuery().queryKey })
    } catch (e) {
      toast.error((e as Error).message)
      qc.invalidateQueries({ queryKey: listQuery.queryKey })
    }
  }

  const renameCollection = async (id: string, title: string) => {
    await api.renameCollection(id, title).catch((e) => toast.error((e as Error).message))
    qc.invalidateQueries({ queryKey: summaryQuery().queryKey })
    nav({ to: "/", search: { collection: id } })
  }
  const deleteCollection = async (id: string) => {
    await api.deleteCollection(id).catch((e) => toast.error((e as Error).message))
    nav({ to: "/", search: {} })
  }

  // Destructive intent is confirmed in the shared ConfirmDialog, never
  // window.confirm — rows only stage the artifact here.
  const [pendingDelete, setPendingDelete] = useState<Artifact | null>(null)
  const deleteArtifact = async (a: Artifact) => {
    qc.setQueryData(listQuery.queryKey, (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((pg) => ({
              ...pg,
              artifacts: pg.artifacts.filter((x) => x.short_id !== a.short_id),
            })),
          }
        : old,
    )
    try {
      await api.deleteArtifact(a.short_id)
      qc.invalidateQueries({ queryKey: summaryQuery().queryKey })
      toast.success("Artifact deleted")
    } catch (e) {
      toast.error((e as Error).message)
      qc.invalidateQueries({ queryKey: listQuery.queryKey })
    }
  }

  // Filter by author. Keep the collection context (you're narrowing the synced
  // repo you're already in) and drop it again via the clear pill.
  const pickAuthor = (login: string) => nav({ to: "/", search: { ...search, author: login } })
  const clearAuthor = () => {
    const { author: _drop, ...rest } = search
    nav({ to: "/", search: rest })
  }

  const activeCollection =
    filter.kind === "collection" ? collections.find((c) => c.id === filter.id) : undefined
  // The in-collection PR viewer. On a repo mirror it lists that repo's open PR
  // previews; on a PR preview it lists the siblings (so you can hop between PRs),
  // with the one you're viewing highlighted. parentId is the repo collection.
  const prParentId =
    activeCollection?.kind === "repo"
      ? activeCollection.id
      : activeCollection?.kind === "pr"
        ? activeCollection.parentId
        : undefined
  const repoPrs = prParentId
    ? collections
        .filter((c) => c.kind === "pr" && c.parentId === prParentId)
        .sort((a, b) => (b.prNumber ?? 0) - (a.prNumber ?? 0))
    : []
  // The collection's name from the sidebar list, falling back to the title the list
  // response carries — so a collection in another workspace still shows its real name
  // (not the generic "Collection") rather than relying on the active-workspace list.
  const collectionTitle =
    activeCollection?.title ?? data?.pages?.[0]?.collection?.title ?? "Collection"
  const heading =
    filter.kind === "all"
      ? "All artifacts"
      : filter.kind === "favorites"
        ? "Favorites"
        : filter.kind === "following"
          ? "Following"
          : filter.kind === "tag"
            ? `#${filter.tag}`
            : collectionTitle
  const headingCount = debouncedQ
    ? items.length
    : filter.kind === "all"
      ? (summary?.total ?? items.length)
      : filter.kind === "favorites"
        ? (summary?.favorites ?? items.length)
        : filter.kind === "tag"
          ? (summary?.tags.find((t) => t.tag === filter.tag)?.count ?? items.length)
          : filter.kind === "collection"
            ? (activeCollection?.count ?? items.length)
            : items.length

  const emptyProps = debouncedQ
    ? {
        icon: <Icon name="search" strokeWidth={1.75} />,
        title: `No artifacts match “${debouncedQ}”.`,
        description: "Try a different search.",
      }
    : filter.kind === "favorites"
      ? {
          icon: <Icon name="favorites" strokeWidth={1.75} />,
          title: "No favorites yet.",
          description: "Tap the star on any artifact to save it.",
        }
      : filter.kind === "following"
        ? {
            icon: <Icon name="following" strokeWidth={1.75} />,
            title: "Nothing from people you follow yet.",
            description: "Follow authors or folders to see their recent changes here.",
            action: (
              <Button
                variant="outline"
                size="sm"
                data-testid="library-empty-browse-people"
                onClick={() => nav({ to: "/people" })}
              >
                Browse people
              </Button>
            ),
          }
        : filter.kind === "tag"
          ? {
              icon: <Icon name="tag" strokeWidth={1.75} />,
              title: `Nothing tagged #${filter.tag} yet.`,
              description: "Tag artifacts to group them here.",
            }
          : filter.kind === "collection"
            ? {
                icon: <Icon name="collection" strokeWidth={1.75} />,
                title: "This collection is empty.",
                description: "Open an artifact and add it from its Collections menu.",
              }
            : {
                icon: <Icon name="all" strokeWidth={1.75} />,
                title: "Nothing yet.",
                description: "Publish above, or run derive publish ./file.",
                action: (
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="library-empty-write"
                    onClick={() => nav({ to: "/new" })}
                  >
                    Write or paste
                  </Button>
                ),
              }

  // A personal header on the (otherwise bare) home view: lead with the user's
  // first name, falling back to their handle. Only on the unfiltered "all" list,
  // not while searching or inside a filter/collection.
  const firstName =
    me?.name?.trim().split(/\s+/)[0] ||
    (me?.username ? `@${me.username}` : me?.email?.split("@")[0]) ||
    "there"
  const totalCount = summary?.total ?? items.length
  const showGreeting = filter.kind === "all" && !debouncedQ

  // "Shared with you": things explicitly shared, surfaced on the unfiltered home
  // above your own list. Only fetched there.
  const homeView = filter.kind === "all" && !debouncedQ
  const { data: sharedData } = useQuery({ ...sharedArtifactsQuery(), enabled: homeView })
  const sharedItems = homeView ? (sharedData ?? []) : []

  // "Needs your feedback": artifacts with an open thread you're tagged in or have
  // commented on — promoted to the very top of the home so you act on them first.
  const { data: feedbackData } = useQuery({ ...needsFeedbackArtifactsQuery(), enabled: homeView })
  const feedbackItems = homeView ? (feedbackData ?? []) : []
  const openFeedback = async (a: Artifact) => {
    const on = !a.favorite
    qc.setQueryData(needsFeedbackArtifactsQuery().queryKey, (old) =>
      old?.map((x) => (x.short_id === a.short_id ? { ...x, favorite: on } : x)),
    )
    try {
      await api.favorite(a.short_id, on)
      qc.invalidateQueries({ queryKey: summaryQuery().queryKey })
    } catch (e) {
      toast.error((e as Error).message)
      qc.invalidateQueries({ queryKey: needsFeedbackArtifactsQuery().queryKey })
    }
  }

  // The caller's follows: drives the Following feed's manage strip + empty state,
  // and the Follow/Following toggle on the active author-filter pill.
  const { follows, isFollowingAuthor, toggleAuthor, unfollow } = useFollows()
  const followingAuthor = !!search.author && isFollowingAuthor(search.author)

  const openShared = async (a: Artifact) => {
    const on = !a.favorite
    qc.setQueryData(sharedArtifactsQuery().queryKey, (old) =>
      old?.map((x) => (x.short_id === a.short_id ? { ...x, favorite: on } : x)),
    )
    try {
      await api.favorite(a.short_id, on)
      qc.invalidateQueries({ queryKey: summaryQuery().queryKey })
    } catch (e) {
      toast.error((e as Error).message)
      qc.invalidateQueries({ queryKey: sharedArtifactsQuery().queryKey })
    }
  }

  // The "how it works" guide is for a truly blank slate: nothing of your own AND
  // nothing shared with you. If something's shared, that section carries the home.
  const emptyHome =
    homeView &&
    !isPending &&
    !isError &&
    items.length === 0 &&
    sharedItems.length === 0 &&
    feedbackItems.length === 0

  return (
    <PageShell scrollRef={scrollRef} width="wide">
      {showGreeting && (
        // The home greeting is the voice headline — the shared PageHeader (one
        // register for every page title), not a hand-rolled clone of its class string.
        <PageHeader
          className="mb-4"
          titleTestId="library-greeting"
          title={
            totalCount === 0 ? `Welcome to Derive, ${firstName}.` : `Welcome back, ${firstName}.`
          }
          subtitle={
            <>
              Your artifacts live here. Publish one below, or run{" "}
              {/* The Kbd chip recipe (inline-flex mono 2xs on the muted wash) —
                  inline code is machine register, not body copy. */}
              <code className="inline-flex h-5 items-center rounded-sm bg-muted px-1 font-mono text-2xs font-medium text-foreground/70">
                derive publish
              </code>
              .
            </>
          }
        />
      )}
      <div className="mb-4.5 flex flex-wrap items-center gap-2.5">
        <SearchField
          value={query}
          onValueChange={setQuery}
          placeholder="Filter by title…"
          aria-label="Filter artifacts by title"
          testId="library-search"
          hotkey
          className="min-w-50 flex-1"
        />
        {/* The clear-filter pill is for the home library's filters (a tag or a
            collection) — a way back to All. Favorites/Following are their own routes
            (with their own active rail rows), not filters you "clear" here. */}
        {(filter.kind === "tag" || filter.kind === "collection") && (
          <Button
            variant="outline"
            size="sm"
            data-testid="library-clear-filter"
            onClick={() => nav({ to: "/", search: {} })}
          >
            {filter.kind === "tag" ? (
              `#${filter.tag}`
            ) : (
              <>
                <Icon name="collection" size={16} /> {collectionTitle}
              </>
            )}
            <Icon name="close" size={16} />
          </Button>
        )}
        {/* Active author filter — independent of the tag/collection filter, so it
              gets its own clearable pill, plus a Follow toggle for that author. */}
        {search.author && (
          <>
            <Button
              variant="outline"
              size="sm"
              data-testid="library-author-filter-clear"
              title={`Clear author filter: ${search.author}`}
              onClick={clearAuthor}
            >
              <Icon name="user" size={16} /> {search.author}
              <Icon name="close" size={16} />
            </Button>
            {/* Quiet by design: the page's one filled primary lives in PublishCard. */}
            <Button
              variant={followingAuthor ? "secondary" : "outline"}
              size="sm"
              data-testid={`library-follow-author-${search.author}`}
              aria-pressed={followingAuthor}
              title={
                followingAuthor
                  ? `Unfollow @${search.author}`
                  : `Follow @${search.author} to see their changes in your feed`
              }
              onClick={() => search.author && toggleAuthor(search.author)}
            >
              {followingAuthor ? (
                <>
                  <Icon name="check" size={16} /> Following
                </>
              ) : (
                <>
                  <Icon name="following" size={16} /> Follow @{search.author}
                </>
              )}
            </Button>
          </>
        )}
      </div>

      {/* Following feed: the manage strip of current follows (authors + paths),
            each unfollowable, sits above the heading so it reads as the feed's
            controls. Hidden (returns null) when you follow nothing. */}
      {filter.kind === "following" && (
        <FollowingStrip follows={follows} onUnfollow={(kind, target) => unfollow(kind, target)} />
      )}

      {filter.kind !== "collection" && filter.kind !== "following" && <PublishCard />}

      {feedbackItems.length > 0 && (
        <section className="mb-6" data-testid="needs-your-feedback">
          <SectionEyebrow
            className="mb-3.5"
            count={feedbackItems.length}
            icon={<Icon name="comments" size={12} />}
          >
            Needs your feedback
          </SectionEyebrow>
          <CardGrid>
            {feedbackItems.map((a) => (
              <ArtifactCard
                key={a.short_id}
                artifact={a}
                onOpen={() => nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } })}
                onToggleFavorite={() => openFeedback(a)}
                onPickTag={(tag) => nav({ to: "/", search: { tag } })}
                onPrefetch={() => prefetch(a.short_id, a.current_version)}
              />
            ))}
          </CardGrid>
        </section>
      )}

      {sharedItems.length > 0 && (
        <section className="mb-6" data-testid="shared-with-you">
          <SectionEyebrow className="mb-3.5" count={sharedItems.length}>
            Shared with you
          </SectionEyebrow>
          <CardGrid>
            {sharedItems.map((a) => (
              <ArtifactCard
                key={a.short_id}
                artifact={a}
                onOpen={() => nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } })}
                onToggleFavorite={() => openShared(a)}
                onPickTag={(tag) => nav({ to: "/", search: { tag } })}
                onPrefetch={() => prefetch(a.short_id, a.current_version)}
              />
            ))}
          </CardGrid>
        </section>
      )}

      {filter.kind === "collection" ? (
        <>
          <CollectionBar
            title={heading}
            count={headingCount}
            onShare={() => activeCollection && setShareCol(activeCollection)}
            onRename={(t) => renameCollection(filter.id, t)}
            onDelete={() => deleteCollection(filter.id)}
          />
          <RepoPullRequests prs={repoPrs} repo={activeCollection?.repo} activeId={filter.id} />
        </>
      ) : (
        // Hide the "All artifacts · 0" heading on a brand-new empty home — the
        // visual guide carries it instead.
        !emptyHome && (
          <SectionEyebrow className="mb-3.5" count={headingCount}>
            {heading}
          </SectionEyebrow>
        )
      )}

      {isPending ? (
        showSkeleton ? (
          <LibrarySkeleton />
        ) : null
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn’t load the library"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="library-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : items.length === 0 ? (
        emptyHome ? (
          <HowItWorks />
        ) : (
          <EmptyState {...emptyProps} />
        )
      ) : isSyncedCollection ? (
        // A mirrored repo. Default to a flat, most-recently-updated list; folders are
        // there as a toggle (off by default) so the tree is available but not forced.
        <div className="flex flex-col gap-3">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="View"
            className="self-end"
            value={showFolders ? "folders" : "list"}
            onValueChange={(v) => v && toggleFolders(v === "folders")}
          >
            <ToggleGroupItem value="list" aria-label="List" data-testid="library-view-list">
              <List aria-hidden />
              List
            </ToggleGroupItem>
            <ToggleGroupItem
              value="folders"
              aria-label="Folders"
              data-testid="library-view-folders"
            >
              <FolderTree aria-hidden />
              Folders
            </ToggleGroupItem>
          </ToggleGroup>
          {showFolders ? (
            <FolderGroups
              items={recencyItems}
              hasNextPage={!!hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              onLoadMore={() => fetchNextPage()}
              onOpen={(a) => nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } })}
              onToggleFavorite={toggleFav}
              onPickTag={(tag) => nav({ to: "/", search: { tag } })}
              onPickAuthor={pickAuthor}
              onPrefetch={(a) => prefetch(a.short_id, a.current_version)}
            />
          ) : (
            <div className="flex flex-col gap-2" data-testid="library-flat-list">
              {recencyItems.map((a) => (
                <ArtifactRow
                  key={a.short_id}
                  artifact={a}
                  onOpen={() => nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } })}
                  onToggleFavorite={() => toggleFav(a)}
                  onPickTag={(tag) => nav({ to: "/", search: { tag } })}
                  onPickAuthor={pickAuthor}
                  onDelete={() => setPendingDelete(a)}
                  onPrefetch={() => prefetch(a.short_id, a.current_version)}
                />
              ))}
              {(hasNextPage || isFetchingNextPage) && (
                <div className="flex justify-center py-2">
                  <Spinner />
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          <ArtifactGrid
            items={items}
            scrollRef={scrollRef}
            hasNextPage={!!hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onLoadMore={() => fetchNextPage()}
            onOpen={(a) => nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } })}
            onToggleFavorite={toggleFav}
            onPickTag={(tag) => nav({ to: "/", search: { tag } })}
            onDelete={setPendingDelete}
            onPrefetch={(a) => prefetch(a.short_id, a.current_version)}
          />
          {isFetchingNextPage && (
            <div className="flex justify-center py-2" data-testid="library-loading-more">
              <Spinner />
            </div>
          )}
        </>
      )}

      {shareCol && (
        <ShareCollectionDialog collection={shareCol} onClose={() => setShareCol(null)} />
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title={`Delete “${pendingDelete?.title ?? pendingDelete?.short_id ?? ""}”?`}
        description="This permanently deletes the artifact and its versions. This cannot be undone."
        confirmLabel="Delete"
        confirmTestId="library-delete-confirm"
        onConfirm={() => {
          if (pendingDelete) deleteArtifact(pendingDelete)
        }}
      />
    </PageShell>
  )
}
