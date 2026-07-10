import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { FolderTree, List } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { type Artifact, api } from "@/api"
import { Icon } from "@/components/icons"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ConnectAgentButton } from "@/components/shared/connect-agent"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { SearchField } from "@/components/shared/search-field"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAuth } from "@/ctx"
import {
  artifactQuery,
  collectionsQuery,
  needsFeedbackArtifactsQuery,
  summaryQuery,
} from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDelayedPending } from "@/lib/use-delayed-pending"
import { useDocumentTitle } from "@/lib/use-document-title"
import { useFollows } from "@/lib/use-follows"
import { usePrefetchArtifact } from "@/lib/use-prefetch-artifact"
import { cn } from "@/lib/utils"
import { refFor } from "../artifact/parse-ref"
import { ArtifactGrid } from "./artifact-grid"
import { ArtifactRow, byRecency } from "./artifact-row"
import { BrandprintNudge } from "./brandprint-nudge"
import { CollectionBar } from "./collection-bar"
import { FolderGroups } from "./folder-groups"
import { FollowingStrip } from "./following-strip"
import { HowItWorks } from "./how-it-works"
import { LibrarySkeleton } from "./library-skeleton"
import { PublishCard } from "./publish-card"
import { LibraryCollectionsDialog, LibraryTagsDialog } from "./quick-organize"
import { RepoPullRequests } from "./repo-pull-requests"
import { ShareCollectionDialog } from "./share-collection-dialog"
import { TriageBar } from "./triage-bar"
import type { Filter, LibrarySearch, LibraryView } from "./types"
import { useLibraryFeed } from "./use-library-feed"

// The library surface, shared by five routes: "/" (your work), "/favorites",
// "/following", "/shared", and "/feedback". The base feed comes from the route (the
// `view` prop); the tag/collection/author filters + free-text search come from the URL
// query. The persistent AppShell owns the rail/pod + auth gate, so this renders the
// library body only. Reconceived from a 660-line god-component: the feed + its optimistic
// mutations live in useLibraryFeed; the promoted "needs feedback" / "shared" card-strips
// are their OWN routes now (a quiet triage line points at /feedback), so the home is one
// job — your work, most-recently-updated.
export function Library({ view }: { view: LibraryView }) {
  return <LibraryBody view={view} />
}

// Map a route view to the base library feed's scope param (all/favorites carry no scope;
// favorites rides the `favorite` flag). Kept beside deriveFilter so the two stay in step.
function scopeFor(view: LibraryView) {
  return view === "following"
    ? ("following" as const)
    : view === "shared"
      ? ("shared" as const)
      : view === "feedback"
        ? ("needs_feedback" as const)
        : undefined
}

// The active filter = the base feed (from the route: `view`) unless it's the home
// library, where a tag/collection query param narrows it. The named feeds are their own
// routes, so their filters (tag/collection) can't apply.
function deriveFilter(
  view: LibraryView,
  search: LibrarySearch,
  collections: { id: string; title: string }[],
): Filter {
  if (view === "favorites") return { kind: "favorites" }
  if (view === "following") return { kind: "following" }
  if (view === "shared") return { kind: "shared" }
  if (view === "feedback") return { kind: "feedback" }
  if (search.tab === "mine") return { kind: "mine" }
  if (search.tag) return { kind: "tag", tag: search.tag }
  if (search.collection)
    return {
      kind: "collection",
      id: search.collection,
      title: collections.find((c) => c.id === search.collection)?.title ?? "Collection",
    }
  return { kind: "all" }
}

function LibraryBody({ view }: { view: LibraryView }) {
  const nav = useNavigate()
  // Read the query params loosely: this one body renders under five routes, so it can't
  // bind to a single route's search shape.
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
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 280)
    return () => clearTimeout(t)
  }, [query])
  // "Searching" tracks the LIVE input, not the debounced value — so the greeting/publish/
  // triage collapse the instant you type, not 280 ms later (the old whole-header jump).
  // Results still key off the debounced value (network), so requests stay throttled.
  const isSearching = query.trim().length > 0

  const filter = deriveFilter(view, search, collections)

  // Server-side search + filter + keyset pagination, plus the optimistic star/delete —
  // all in the feed hook, keyed by the active filter.
  const params = {
    q: debouncedQ || undefined,
    tag: search.tag,
    collection: search.collection,
    favorite: view === "favorites" || undefined,
    author: search.author,
    scope: filter.kind === "mine" ? ("mine" as const) : scopeFor(view),
  }
  const { query: feed, items, listQuery, toggleFavorite, deleteArtifact } = useLibraryFeed(params)
  const { isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = feed
  // keepPreviousData holds the OLD grid while a new filter/tab/search loads. With the cache
  // persisted to IndexedDB (lib/persist.ts), a switch to a view you've already seen resolves
  // from cache instantly — the previous grid is simply replaced with no flash, no ceremony.
  // Hold the skeleton back ~150 ms so a cache-warm / fast first load flashes nothing.
  const showSkeleton = useDelayedPending(isPending)

  // A synced repo/PR collection gets the folder/flat treatment. Derive this from the
  // collection's KNOWN kind (collections are preloaded in the route loader), NOT from
  // whether a loaded item happens to carry a source_path — so the view can't render as a
  // grid and then flip to flat/folders once the first synced item lands.
  const activeCollection =
    filter.kind === "collection" ? collections.find((c) => c.id === filter.id) : undefined
  const isSyncedCollection = activeCollection?.kind === "repo" || activeCollection?.kind === "pr"
  // Pull the whole collection so the sort + grouping see every doc (collections are finite
  // and scoping keeps them small).
  useEffect(() => {
    if (isSyncedCollection && hasNextPage && !isFetchingNextPage) fetchNextPage()
  }, [isSyncedCollection, hasNextPage, isFetchingNextPage, fetchNextPage])
  const recencyItems = isSyncedCollection ? [...items].sort(byRecency) : items

  // Folder-vs-flat is remembered PER COLLECTION (a JSON map under the one storage key),
  // so opening a different synced repo starts at its own preference (flat by default)
  // instead of inheriting the last collection's toggle.
  const [folderPrefs, setFolderPrefs] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {}
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.libraryFolders) || "{}")
    } catch {
      return {}
    }
  })
  const showFolders = filter.kind === "collection" ? !!folderPrefs[filter.id] : false
  const setShowFolders = (on: boolean) => {
    if (filter.kind !== "collection") return
    setFolderPrefs((prev) => {
      const next = { ...prev, [filter.id]: on }
      try {
        localStorage.setItem(STORAGE_KEYS.libraryFolders, JSON.stringify(next))
      } catch {
        /* private mode — the in-memory pref still holds this session */
      }
      return next
    })
  }

  const renameCol = useApiMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.renameCollection(id, title),
    invalidate: [summaryQuery().queryKey, collectionsQuery().queryKey],
    onSuccess: (_data, { id }) => nav({ to: "/", search: { collection: id } }),
  })
  const renameCollection = (id: string, title: string) => renameCol.mutate({ id, title })
  const deleteCol = useApiMutation({
    mutationFn: (id: string) => api.deleteCollection(id),
    invalidate: [collectionsQuery().queryKey],
    onSuccess: () => nav({ to: "/", search: {} }),
  })
  const deleteCollection = (id: string) => deleteCol.mutate(id)

  // Destructive intent is confirmed in the shared ConfirmDialog — rows only stage here.
  const [pendingDelete, setPendingDelete] = useState<Artifact | null>(null)

  // Quick organize from the card ⋯ menu (edit tags / add to collection). The dialogs own
  // the API calls and report the result here; these handlers sync the caches that render
  // the artifact's tags/collections — the CURRENT view's feed page + the artifact detail —
  // plus the rail counts. The named-feed caches (/shared, /feedback) aren't synced: they're
  // not the visible view, and refetchOnMount:"always" makes them fresh on navigation.
  const [pendingTags, setPendingTags] = useState<Artifact | null>(null)
  const [pendingCollections, setPendingCollections] = useState<Artifact | null>(null)
  const tagsChanged = (shortId: string, tags: string[]) => {
    qc.setQueryData(listQuery.queryKey, (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((pg) => ({
              ...pg,
              artifacts: pg.artifacts.map((x) => (x.short_id === shortId ? { ...x, tags } : x)),
            })),
          }
        : old,
    )
    qc.setQueryData(artifactQuery(shortId).queryKey, (a) => (a ? { ...a, tags } : a))
    // Tag counts in the rail come from the summary.
    qc.invalidateQueries({ queryKey: summaryQuery().queryKey })
    if (filter.kind === "tag") qc.invalidateQueries({ queryKey: listQuery.queryKey })
  }
  const collectionsChanged = (shortId: string, ids: string[]) => {
    qc.setQueryData(artifactQuery(shortId).queryKey, (a) => (a ? { ...a, collections: ids } : a))
    // Collection counts in the rail.
    qc.invalidateQueries({ queryKey: collectionsQuery().queryKey })
    if (filter.kind === "collection") qc.invalidateQueries({ queryKey: listQuery.queryKey })
  }

  // Filter by author. Keep the collection context (you're narrowing the synced repo you're
  // already in) and drop it again via the clear pill.
  const pickAuthor = (login: string) => nav({ to: "/", search: { ...search, author: login } })
  const clearAuthor = () => {
    const { author: _drop, ...rest } = search
    nav({ to: "/", search: rest })
  }
  const { follows, isFollowingAuthor, toggleAuthor, unfollow } = useFollows()
  const followingAuthor = !!search.author && isFollowingAuthor(search.author)

  // The in-collection PR viewer: on a repo mirror it lists that repo's open PR previews;
  // on a PR preview it lists the siblings (so you can hop between PRs).
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
  const collectionTitle =
    activeCollection?.title ?? feed.data?.pages?.[0]?.collection?.title ?? "Collection"

  // The home greeting + publish launcher + the quiet triage line span BOTH home tabs
  // ("All artifacts" / "Created by me") — the tab only filters the grid, it doesn't
  // leave home. Searching or a tag/collection filter drops the home chrome.
  const homeView = (filter.kind === "all" || filter.kind === "mine") && !isSearching
  const { data: feedbackData } = useQuery({ ...needsFeedbackArtifactsQuery(), enabled: homeView })
  const feedbackCount = feedbackData?.length ?? 0

  // The greeting NEVER branches on a pending query: the count is preloaded in the "/"
  // route loader, so `summary` is present on the first paint. The `totalKnown` guard is
  // belt-and-suspenders — if the count were ever unresolved we show a neutral "Welcome,"
  // rather than mislabelling a returning user as brand-new.
  const firstName =
    me?.name?.trim().split(/\s+/)[0] ||
    (me?.username ? `@${me.username}` : me?.email?.split("@")[0]) ||
    "there"
  const totalKnown = summary !== undefined
  const greetingTitle = !totalKnown
    ? `Welcome, ${firstName}.`
    : summary.total === 0
      ? `Welcome to Derive, ${firstName}.`
      : `Welcome back, ${firstName}.`

  const heading =
    filter.kind === "all"
      ? "All artifacts"
      : filter.kind === "favorites"
        ? "Favorites"
        : filter.kind === "following"
          ? "Following"
          : filter.kind === "shared"
            ? "Shared with you"
            : filter.kind === "feedback"
              ? "Needs your feedback"
              : filter.kind === "mine"
                ? "Created by me"
                : filter.kind === "tag"
                  ? `#${filter.tag}`
                  : collectionTitle
  // The tab names the view — a tag, a collection, Favorites, Created by me… —
  // while the unfiltered home stays plain "Derive".
  useDocumentTitle(filter.kind === "all" ? null : heading)
  // Only the counts the server can state authoritatively (preloaded summary / the
  // collection's own count) get a number; the follow/shared/feedback feeds show none
  // rather than a misleading "loaded-so-far" count that grows as you scroll.
  const headingCount = isSearching
    ? items.length
    : filter.kind === "all"
      ? summary?.total
      : filter.kind === "favorites"
        ? summary?.favorites
        : filter.kind === "mine"
          ? summary?.mine
          : filter.kind === "tag"
            ? summary?.tags.find((t) => t.tag === filter.tag)?.count
            : filter.kind === "collection"
              ? activeCollection?.count
              : undefined

  const showPublish =
    !isSearching &&
    (filter.kind === "all" ||
      filter.kind === "mine" ||
      filter.kind === "tag" ||
      filter.kind === "favorites")

  const emptyProps = emptyStateFor(filter, isSearching, debouncedQ, nav)
  // The first-run guide is for a genuinely blank home (your work is empty and you're not
  // mid-search). Keyed to the "All artifacts" tab only — an empty "Created by me" tab
  // keeps its own empty state (the workspace may hold plenty you didn't create).
  const emptyHome = homeView && filter.kind === "all" && items.length === 0

  return (
    <PageShell scrollRef={scrollRef} width="wide">
      {/* The full "Activity" feed, reached from the People tab's Recent-activity peek
          ("View all"). The People page itself shows who you follow + a preview of this. */}
      {view === "following" && (
        <PageHeader
          className="mb-5"
          title="Activity"
          subtitle="Recent work from the people you follow."
        />
      )}
      {homeView && (
        <PageHeader
          className="mb-4"
          titleTestId="library-greeting"
          title={greetingTitle}
          subtitle={
            <>
              Your artifacts live here — most recently updated first. Publish one below, or run{" "}
              {/* Links to /welcome — reachable any time; its "Connect an agent" step
                  is the in-app guide to publishing over the CLI/MCP. */}
              <Link
                to="/welcome"
                data-testid="library-cli-guide"
                title="How to publish from the CLI or an agent (MCP)"
                className="inline-flex h-5 items-center rounded-sm bg-muted px-1 font-mono text-2xs font-medium text-foreground/70 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                derive publish
              </Link>
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

      {/* Following feed: the manage strip of current follows sits above the heading. */}
      {filter.kind === "following" && (
        <FollowingStrip follows={follows} onUnfollow={(kind, target) => unfollow(kind, target)} />
      )}

      {showPublish && <PublishCard />}

      {/* The quiet triage line — one entry point to the /feedback feed, home only. */}
      {homeView && feedbackCount > 0 && (
        <div className="mb-6">
          <TriageBar count={feedbackCount} />
        </div>
      )}

      {/* One-time, dismissible: the owner of a Brandprint-less workspace gets the
          "first on the team" setup nudge here (spec: Onboarding / Timing). */}
      {homeView && <BrandprintNudge />}

      {filter.kind === "collection" ? (
        <>
          <CollectionBar
            title={heading}
            count={headingCount ?? items.length}
            onShare={() => activeCollection && setShareCol(activeCollection)}
            onRename={(t) => renameCollection(filter.id, t)}
            onDelete={() => deleteCollection(filter.id)}
          />
          <RepoPullRequests prs={repoPrs} repo={activeCollection?.repo} activeId={filter.id} />
        </>
      ) : view === "all" && !isSearching ? (
        // Always both tabs, even over the first-run guide — an empty "Created
        // by me" tab is a fine place to land before you've published anything.
        <LibraryTabs
          active={filter.kind === "mine" ? "mine" : "all"}
          total={summary?.total}
          mine={summary?.mine}
        />
      ) : (
        // Hide the heading on a brand-new empty home — the visual guide carries it.
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
        <SyncedCollection
          items={recencyItems}
          showFolders={showFolders}
          onToggle={setShowFolders}
          hasNextPage={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
          onOpen={(a) => nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } })}
          onToggleFavorite={toggleFavorite}
          onPickTag={(tag) => nav({ to: "/", search: { tag } })}
          onPickAuthor={pickAuthor}
          onEditTags={setPendingTags}
          onAddToCollection={setPendingCollections}
          onDelete={setPendingDelete}
          onPrefetch={(a) => prefetch(a.short_id, a.current_version)}
        />
      ) : (
        <>
          <ArtifactGrid
            items={items}
            scrollRef={scrollRef}
            hasNextPage={!!hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onLoadMore={() => fetchNextPage()}
            onOpen={(a) => nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } })}
            onToggleFavorite={toggleFavorite}
            onPickTag={(tag) => nav({ to: "/", search: { tag } })}
            onEditTags={setPendingTags}
            onAddToCollection={setPendingCollections}
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
      {/* Quick-organize dialogs — opened from a card/row ⋯ menu (edit tags / collections). */}
      {pendingTags && (
        <LibraryTagsDialog
          artifact={pendingTags}
          onChange={tagsChanged}
          onClose={() => setPendingTags(null)}
        />
      )}
      {pendingCollections && (
        <LibraryCollectionsDialog
          artifact={pendingCollections}
          onChange={collectionsChanged}
          onClose={() => setPendingCollections(null)}
        />
      )}
    </PageShell>
  )
}

// A mirrored repo/PR collection: a flat, most-recently-updated list by default, with the
// folder tree available behind a toggle (off by default). Split out of the render switch
// so the body reads top-to-bottom.
function SyncedCollection({
  items,
  showFolders,
  onToggle,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onOpen,
  onToggleFavorite,
  onPickTag,
  onPickAuthor,
  onEditTags,
  onAddToCollection,
  onDelete,
  onPrefetch,
}: {
  items: Artifact[]
  showFolders: boolean
  onToggle: (on: boolean) => void
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
  onOpen: (a: Artifact) => void
  onToggleFavorite: (a: Artifact) => void
  onPickTag: (tag: string) => void
  onPickAuthor: (login: string) => void
  onEditTags: (a: Artifact) => void
  onAddToCollection: (a: Artifact) => void
  onDelete: (a: Artifact) => void
  onPrefetch: (a: Artifact) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-label="View"
        className="self-end"
        value={showFolders ? "folders" : "list"}
        onValueChange={(v) => v && onToggle(v === "folders")}
      >
        <ToggleGroupItem value="list" aria-label="List" data-testid="library-view-list">
          <List aria-hidden />
          List
        </ToggleGroupItem>
        <ToggleGroupItem value="folders" aria-label="Folders" data-testid="library-view-folders">
          <FolderTree aria-hidden />
          Folders
        </ToggleGroupItem>
      </ToggleGroup>
      {showFolders ? (
        <FolderGroups
          items={items}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={onLoadMore}
          onOpen={onOpen}
          onToggleFavorite={onToggleFavorite}
          onPickTag={onPickTag}
          onPickAuthor={onPickAuthor}
          onEditTags={onEditTags}
          onAddToCollection={onAddToCollection}
          onDelete={onDelete}
          onPrefetch={onPrefetch}
        />
      ) : (
        <div className="flex flex-col gap-2" data-testid="library-flat-list">
          {items.map((a) => (
            <ArtifactRow
              key={a.short_id}
              artifact={a}
              onOpen={() => onOpen(a)}
              onToggleFavorite={() => onToggleFavorite(a)}
              onPickTag={onPickTag}
              onPickAuthor={onPickAuthor}
              onEditTags={() => onEditTags(a)}
              onAddToCollection={() => onAddToCollection(a)}
              onDelete={() => onDelete(a)}
              onPrefetch={() => onPrefetch(a)}
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
  )
}

// The home library's two tabs: everything, and just what you created. Route
// stays "/", the tab rides ?tab=mine. `pending` counts your still-link-only
// docs — the "waiting on you to surface it" signal the old Drafts badge
// carried — shown as an accent pill beside the neutral total.
function LibraryTabs({
  active,
  total,
  mine,
}: {
  active: "all" | "mine"
  total?: number
  mine?: number
}) {
  const nav = useNavigate()
  const tab = (id: "all" | "mine", label: string, count?: number) => (
    <button
      type="button"
      data-testid={`library-tab-${id}`}
      aria-current={active === id ? "page" : undefined}
      onClick={() =>
        nav({ to: "/", search: (s) => ({ ...s, tab: id === "mine" ? "mine" : undefined }) })
      }
      className={cn(
        "flex items-center gap-1.5 border-b-2 pb-2 text-sm font-medium transition-colors",
        active === id
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      {count != null && (
        <span className="font-mono text-2xs tabular-nums text-muted-foreground">{count}</span>
      )}
    </button>
  )
  return (
    <div className="mb-3.5 flex items-center gap-5 border-b border-border-soft">
      {tab("all", "All artifacts", total)}
      {tab("mine", "Created by me", mine)}
    </div>
  )
}

// The empty state for each view/filter — three tones, never reused (research): searching
// = corrective ("no match, try another"); a named feed = an explanatory nudge; the
// inbox-zero /feedback = a positive "all caught up" with no CTA. The unfiltered empty
// home is handled separately (the HowItWorks first-run guide), so "all" never lands here.
function emptyStateFor(
  filter: Filter,
  isSearching: boolean,
  debouncedQ: string,
  nav: ReturnType<typeof useNavigate>,
) {
  if (isSearching)
    return {
      icon: <Icon name="search" strokeWidth={1.75} />,
      title: `No artifacts match “${debouncedQ}”.`,
      description: "Try a different search.",
    }
  switch (filter.kind) {
    case "favorites":
      return {
        icon: <Icon name="favorites" strokeWidth={1.75} />,
        title: "No favorites yet.",
        description: "Tap the star on any artifact to save it.",
      }
    case "following":
      return {
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
    case "shared":
      return {
        icon: <Icon name="share" strokeWidth={1.75} />,
        title: "Nothing shared with you yet.",
        description: "When someone shares an artifact with you, it shows up here.",
      }
    case "mine":
      return {
        icon: <Icon name="sparkles" strokeWidth={1.75} />,
        title: "Nothing you've created yet.",
        description:
          "Publish something, or connect an agent — everything you or your agents create shows up here, whatever its audience.",
        action: (
          // The shared ConnectAgent surface, right here in a dialog — this used to
          // land on Settings -> Agents (the workspace-bot token form), a different
          // concept that dead-ended the one activation moment.
          <ConnectAgentButton variant="outline" size="sm" testId="library-empty-connect-agent" />
        ),
      }
    case "feedback":
      // Inbox-zero: a positive tone, no action — you're done, not stuck.
      return {
        icon: <Icon name="check" strokeWidth={1.75} />,
        title: "You’re all caught up.",
        description: "Artifacts with an open thread that needs you show up here.",
      }
    case "tag":
      return {
        icon: <Icon name="tag" strokeWidth={1.75} />,
        title: `Nothing tagged #${filter.tag} yet.`,
        description: "Tag artifacts to group them here.",
      }
    case "collection":
      return {
        icon: <Icon name="collection" strokeWidth={1.75} />,
        title: "This collection is empty.",
        description: "Open an artifact and add it from its Collections menu.",
      }
    default:
      return {
        icon: <Icon name="all" strokeWidth={1.75} />,
        title: "Nothing yet.",
        description: "Publish above, or run derive publish ./file.",
      }
  }
}
