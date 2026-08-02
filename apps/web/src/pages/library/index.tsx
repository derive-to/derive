import type { SortMode } from "@derive/core"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { FolderTree, List } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { type Artifact, api } from "@/api"
import { useShell } from "@/components/chrome/shell-context"
import { Icon } from "@/components/icons"
import { AskButton } from "@/components/shared/ask-button"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ConnectAgentButton } from "@/components/shared/connect-agent"
import { EmptyState } from "@/components/shared/empty-state"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { SearchField } from "@/components/shared/search-field"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAuth } from "@/ctx"
import { useBootGate } from "@/lib/bootstrap"
import {
  artifactQuery,
  collectionFoldersQuery,
  collectionsQuery,
  needsFeedbackArtifactsQuery,
  summaryQuery,
} from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useBrandprintCollectionIds } from "@/lib/use-brandprint-ids"
import { useDelayedPending } from "@/lib/use-delayed-pending"
import { useDocumentTitle } from "@/lib/use-document-title"
import { useFollows } from "@/lib/use-follows"
import { usePrefetchArtifact } from "@/lib/use-prefetch-artifact"
import { refFor } from "../artifact/parse-ref"
import { ArtifactGrid } from "./artifact-grid"
import { ArtifactListRow, ListShell } from "./artifact-list"
import { BrandprintNudge } from "./brandprint-nudge"
import { CollectionBar } from "./collection-bar"
import { CollectionFolders, NewFolderControl } from "./collection-folders"
import { CollectionsList } from "./collections-list"
import { CollectionsView } from "./collections-view"
import { ConnectNudge, useConnectNudge } from "./connect-nudge"
import { DisplayMenu } from "./display-menu"
import { FilterMenu } from "./filter-menu"
import { FolderGroups } from "./folder-groups"
import { FollowingStrip } from "./following-strip"
import { HowItWorks } from "./how-it-works"
import { LibrarySkeleton } from "./library-skeleton"
import { NewArtifactButton } from "./new-artifact-button"
import { libraryFeedParams } from "./params"
import { LibraryCollectionsDialog } from "./quick-organize"
import { byRecency } from "./recency"
import { RepoPullRequests } from "./repo-pull-requests"
import { SelectionBar } from "./selection-bar"
import { ShareCollectionDialog } from "./share-collection-dialog"
import { DEFAULT_SORT } from "./sort"
import type { Filter, LibrarySearch, LibraryView } from "./types"
import { useLibraryFeed } from "./use-library-feed"
import { type LibrarySelection, useLibrarySelection } from "./use-library-selection"
import { ViewSwitch } from "./view-switch"

// The library surface, shared by five routes: "/" (your work), "/favorites",
// "/following", "/shared", and "/feedback". The base feed comes from the route (the
// `view` prop); the collection/author filters + free-text search come from the URL
// query. The persistent AppShell owns the rail/pod + auth gate, so this renders the
// library body only. Reconceived from a 660-line god-component: the feed + its optimistic
// mutations live in useLibraryFeed; the promoted "needs feedback" / "shared" card-strips
// are their OWN routes now (a quiet triage line points at /feedback), so the home is one
// job — your work, most-recently-updated.
export function Library({ view }: { view: LibraryView }) {
  return <LibraryBody view={view} />
}

// The active filter = the base feed (from the route: `view`) unless it's the home
// library, where the `filter` menu and a collection query param narrow it. The named
// feeds are their own routes, so neither applies there.
function deriveFilter(
  view: LibraryView,
  search: LibrarySearch,
  collections: { id: string; title: string }[],
): Filter {
  if (view === "favorites") return { kind: "favorites" }
  if (view === "following") return { kind: "following" }
  if (view === "shared") return { kind: "shared" }
  if (view === "feedback") return { kind: "feedback" }
  if (search.filter === "needs-you") return { kind: "feedback" }
  if (search.filter === "mine") return { kind: "mine" }
  if (search.filter === "shared") return { kind: "shared" }
  if (search.filter === "starred") return { kind: "favorites" }
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
  // Boot-batch gated (same keys the NavRail reads — one seed serves both).
  const bootGate = useBootGate()
  const { data: summary } = useQuery({ ...summaryQuery(), enabled: !!me && bootGate })
  const { data: collections = [] } = useQuery({ ...collectionsQuery(), enabled: !!me && bootGate })
  // The Collections view is home-only and never shows while a shelf is open — opening
  // one IS the `collection` filter, so the switch would be offering you the place you
  // are already standing.
  const showCollections = view === "all" && search.view === "collections" && !search.collection
  // Brandprint-pointed collections take artifacts through Settings, not the shelves.
  const brandprintIds = useBrandprintCollectionIds()
  const visibleCollections = collections.filter((c) => !brandprintIds.has(c.id))
  const prefetch = usePrefetchArtifact()
  const qc = useQueryClient()
  // The library is the scroll container; the virtualized grid windows against it.
  const scrollRef = useRef<HTMLDivElement>(null)

  const { openAssistant } = useShell()
  // ⌘↵ in the filter box and the Ask button beside it are one action, so they go through one
  // call: whatever is typed, handed to the agent (empty simply opens the conversation).
  const askFromField = (v: string) => openAssistant(v.trim() || undefined)

  const [shareCol, setShareCol] = useState<(typeof collections)[number] | null>(null)
  const [query, setQuery] = useState(search.query ?? "")
  const [debouncedQ, setDebouncedQ] = useState((search.query ?? "").trim())
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 280)
    return () => clearTimeout(t)
  }, [query])
  // Reflect the SETTLED search in the URL so a filtered library is shareable/deep-linkable —
  // the field seeds FROM ?query= above but must also write back. `replace` so keystrokes
  // don't stack history; the guard skips a no-op nav (and its re-render loop). Keeps the
  // current route (one of five feeds) and the other params (collection/author).
  useEffect(() => {
    if (debouncedQ === (search.query ?? "").trim()) return
    nav({
      to: ".",
      search: (prev) => ({ ...prev, query: debouncedQ || undefined }),
      replace: true,
    })
  }, [debouncedQ, search.query, nav])
  // "Searching" tracks the LIVE input, not the debounced value — so the greeting/publish/
  // triage collapse the instant you type, not 280 ms later (the old whole-header jump).
  // Results still key off the debounced value (network), so requests stay throttled.
  const isSearching = query.trim().length > 0

  const filter = deriveFilter(view, search, collections)

  // Server-side search + filter + keyset pagination, plus the optimistic star/delete —
  // all in the feed hook, keyed by the active filter.
  // Same builder every library route's loader uses, so an intent hover warms the exact
  // key this body reads (see ./params.ts).
  const params = libraryFeedParams(view, search, debouncedQ)
  const { query: feed, items, listQuery, toggleFavorite, deleteArtifact } = useLibraryFeed(params)
  const { isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = feed
  // Multi-select, scoped to THIS feed: the params are the feed's identity, so changing
  // the tab, filter, or search drops the selection rather than carrying ids off-screen
  // into a bulk write.
  const selection = useLibrarySelection(items, JSON.stringify(params))
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
  // In-collection folders (manual collections only; repos use the path-based FolderGroups).
  // Fetch the folder list + artifact→folder assignment map so the view can group.
  const isManualCollection = filter.kind === "collection" && !isSyncedCollection
  const { data: colFolders } = useQuery({
    ...collectionFoldersQuery(filter.kind === "collection" ? filter.id : ""),
    enabled: !!me && isManualCollection,
  })
  const folders = colFolders?.folders ?? []
  const folderAssignments = colFolders?.assignments ?? {}
  // Managing a collection's folders needs the collection's editor role.
  const canManageFolders =
    isManualCollection &&
    (activeCollection?.my_role === "editor" || activeCollection?.my_role === "owner")
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
  // Opened from the toolbar's one New button; the Collections view renders the field.
  const [newCollection, setNewCollection] = useState<string | null>(null)
  // Grid or list, remembered per browser and applied everywhere. Previously the route
  // decided: cards at home, rows in a synced repo, a third arrangement under the folder
  // toggle.
  const [layout, setLayoutState] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.libraryLayout) === "list" ? "list" : "grid"
    } catch {
      return "grid"
    }
  })
  const setLayout = (next: "grid" | "list") => {
    setLayoutState(next)
    try {
      localStorage.setItem(STORAGE_KEYS.libraryLayout, next)
    } catch {
      /* private mode: the choice just doesn't persist */
    }
  }
  // Opening an artifact from a collection carries that collection as list context, so
  // the artifact header can page between its siblings (the sibling switcher). Other
  // feeds pass nothing — a direct/feed open has no single collection to page within.
  // Sort has two controls now — the Display menu and the list's column headers — so the
  // write lives in one place rather than being spelled out at each.
  const setSort = (mode: SortMode) =>
    nav({
      to: ".",
      search: (prev) => ({ ...prev, sort: mode === DEFAULT_SORT ? undefined : mode }),
      replace: true,
    })
  const openContext = filter.kind === "collection" ? { collection: filter.id } : {}
  const showFolders = filter.kind === "collection" ? !!folderPrefs[filter.id] : false
  // A manual collection that HAS folders defaults to the grouped folder view; the
  // "Group by folder" (per-collection pref, same storage as the synced view's toggle);
  // default on when folders exist.
  const showManualFolders = filter.kind === "collection" ? (folderPrefs[filter.id] ?? true) : true
  // A `?folder=` anchor (from the artifact breadcrumb's folder segment) is a ONE-SHOT: read
  // it into transient state and strip it from the URL on mount, so it forces grouping for
  // THIS visit and scrolls the folder into view WITHOUT rewriting the saved pref or pinning
  // the view (a stale id can't get stuck, and the toggle always wins).
  const [folderAnchor, setFolderAnchor] = useState<string | undefined>(search.folder)
  const anchorStripped = useRef(false)
  useEffect(() => {
    if (anchorStripped.current) return
    anchorStripped.current = true
    if (search.folder) nav({ to: ".", search: (p) => ({ ...p, folder: undefined }), replace: true })
  }, [search.folder, nav])
  const foldersView =
    isManualCollection && folders.length > 0 && (showManualFolders || !!folderAnchor)
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
  // Toggle grouping from the Display menu. Persist the pref; when turning OFF, also drop any
  // transient folder anchor so the toggle wins over an anchored landing.
  const setGrouped = (on: boolean) => {
    setShowFolders(on)
    if (!on) setFolderAnchor(undefined)
  }
  // Pull the WHOLE collection when the sort + grouping need every doc: always for a synced
  // repo/PR, and for a manual collection while its folder view is active (so buckets +
  // counts reflect every item, not just the first page). Collections are finite and
  // scoping keeps them small.
  // The grouped Collections list joins the pull-everything club: it groups the feed
  // client-side, and grouping one page showed every collection whose artifacts were
  // older than it as empty — a lie with a count beside it.
  const groupedCollections = showCollections && layout === "list"
  useEffect(() => {
    if (
      (isSyncedCollection || foldersView || groupedCollections) &&
      hasNextPage &&
      !isFetchingNextPage
    )
      fetchNextPage()
  }, [
    isSyncedCollection,
    foldersView,
    groupedCollections,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  ])

  const renameCol = useApiMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.renameCollection(id, title),
    invalidate: [summaryQuery().queryKey, collectionsQuery().queryKey],
    onSuccess: (_data, { id }) => nav({ to: "/", search: { collection: id } }),
  })
  const renameCollection = (id: string, title: string) => renameCol.mutate({ id, title })

  // Creating a shelf belongs where you can see the ones you already have — the rail's
  // permanent inline form is the thing this replaces.
  const createCol = useApiMutation({
    mutationFn: (title: string) => api.createCollection(title),
    invalidate: [collectionsQuery().queryKey],
    onSuccess: (col) => nav({ to: "/", search: { collection: col.id } }),
  })
  const deleteCol = useApiMutation({
    mutationFn: (id: string) => api.deleteCollection(id),
    invalidate: [collectionsQuery().queryKey],
    onSuccess: () => nav({ to: "/", search: {} }),
  })
  const deleteCollection = (id: string) => deleteCol.mutate(id)

  // Starring is optimistic: it is personal, reversible, and the sidebar should move the
  // instant you click. The primitive rolls back and toasts if the write fails.
  const starCol = useApiMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api.starCollection(id, on),
    optimistic: ({ id, on }) => {
      const key = collectionsQuery().queryKey
      const prev = qc.getQueryData(key)
      qc.setQueryData(key, (old) => old?.map((c) => (c.id === id ? { ...c, starred: on } : c)))
      return () => qc.setQueryData(key, prev)
    },
    invalidate: [collectionsQuery().queryKey],
  })

  // Destructive intent is confirmed in the shared ConfirmDialog — rows only stage here.
  const [pendingDelete, setPendingDelete] = useState<Artifact | null>(null)

  // Quick organize from the card ⋯ menu. The dialog owns the API call and reports the
  // result here; this syncs what a membership change affects — the artifact detail, and
  // the rail's per-collection counts. Feed cards don't render collections, so the list
  // caches are left alone.
  const [pendingCollections, setPendingCollections] = useState<Artifact | null>(null)
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
  // Where this collection sits. A PR preview genuinely nests under its repo mirror, so
  // the trail says so; everything else is one level under the library.
  const parentRepo =
    activeCollection?.kind === "pr" && activeCollection.parentId
      ? collections.find((c) => c.id === activeCollection.parentId)
      : undefined
  const collectionAncestors = [
    { label: "Library" },
    ...(parentRepo ? [{ label: parentRepo.title, collection: parentRepo.id }] : []),
  ]

  const collectionTitle =
    activeCollection?.title ?? feed.data?.pages?.[0]?.collection?.title ?? "Collection"

  // The home greeting + publish launcher + the quiet triage line span BOTH home tabs
  // ("All artifacts" / "Created by me") — the tab only filters the grid, it doesn't
  // leave home. Searching or a collection filter drops the home chrome.
  const homeView = (filter.kind === "all" || filter.kind === "mine") && !isSearching
  const { data: feedbackData } = useQuery({ ...needsFeedbackArtifactsQuery(), enabled: homeView })
  const feedbackCount = feedbackData?.length ?? 0

  // The greeting NEVER branches on a pending query. The "/" loader prefetches the count
  // without awaiting it (awaiting gated the whole grid behind this header, ~450ms on a
  // cold boot), so on cold boots `summary` can be briefly unresolved — the `totalKnown`
  // guard is the primary defense now, not belt-and-suspenders: neutral "Welcome," until
  // the count says returning or new, never the wrong copy on a guess. Warm boots hit the
  // cache and paint the full greeting on the first frame, exactly as before.
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
                : collectionTitle
  // The tab names the view — a collection, Favorites, Created by me… —
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
          : filter.kind === "collection"
            ? activeCollection?.count
            : undefined

  const connectNudge = useConnectNudge()
  // One prompt at a time. The connect card's "publish" stage already says "publish your
  // first document"; the drop-zone directly beneath it saying "Publish an artifact" is
  // the same instruction twice, and the one asking for less always loses. The nudges
  // themselves are already exclusive of each other (connect wins over Brandprint), so
  // this is the last overlap.
  const showPublish =
    !isSearching &&
    connectNudge.stage === null &&
    (filter.kind === "all" || filter.kind === "mine" || filter.kind === "favorites")

  const emptyProps = emptyStateFor(filter, isSearching, debouncedQ, nav)
  // The first-run guide is for a genuinely blank home (your work is empty and you're not
  // mid-search). Keyed to the "All artifacts" tab only — an empty "Created by me" tab
  // keeps its own empty state (the workspace may hold plenty you didn't create).
  const emptyHome = homeView && filter.kind === "all" && items.length === 0

  // The activation card's state — read here so the Brandprint nudge can yield to it
  // (one onboarding surface per screen; connecting an agent comes first).

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

      <div className="mb-4.5 flex flex-wrap items-center gap-2.5">
        {/* Home only: the named feeds ARE a filter, so offering another would let you ask
            for "Shared with me" inside "Needs your feedback" and get something nobody
            meant. Same for the view switch — a feed has no shelves. */}
        {view === "all" && !search.collection && (
          <ViewSwitch
            value={showCollections ? "collections" : "artifacts"}
            onChange={(next) =>
              nav({
                to: "/",
                search: { ...search, view: next === "collections" ? "collections" : undefined },
              })
            }
          />
        )}
        {view === "all" && !showCollections && (
          <FilterMenu
            needsYou={feedbackCount}
            value={search.filter ?? "all"}
            onChange={(next) =>
              nav({
                to: "/",
                // Keep where you are (collection, search, sort) and change only the facet
                // — the whole point of a filter over three separate routes.
                search: { ...search, filter: next === "all" ? undefined : next },
              })
            }
          />
        )}
        <SearchField
          value={query}
          onValueChange={setQuery}
          // The box filters the list by TITLE; Enter escalates to full-text + semantic search
          // over the whole workspace on the /search page (the reach titles alone can't).
          onEnter={(v) => nav({ to: "/search", search: { q: v } })}
          placeholder="Filter by title, or ↵ to search everything…"
          aria-label="Filter artifacts by title, or press Enter to search all content"
          testId="library-search"
          hotkey
          onAsk={(v) => askFromField(v)}
          className="min-w-50 flex-1"
        />
        {/* The third gear on the same box: typing filters, ↵ searches, this asks. A visible
            control rather than only ⌘↵, because the whole point of putting it here is that
            somebody who has never opened the chat finds it while doing something else. */}
        <AskButton text={query} testId="library-ask" />
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
        {showCollections ? (
          <Button size="sm" data-testid="collections-new" onClick={() => setNewCollection("")}>
            <Icon name="plus" size={16} /> New collection
          </Button>
        ) : (
          showPublish && <NewArtifactButton />
        )}
        {showCollections ? (
          // Layout only. Shelves answer "which collection" and the grouped list answers
          // "what's in my workspace and how is it filed" — two questions, so the toggle
          // earns its place (unlike the shelf-vs-worse-shelf pair cut earlier). Sort
          // lives on the list's own column headers.
          <DisplayMenu layout={layout} onLayout={setLayout} />
        ) : (
          <DisplayMenu
            layout={layout}
            onLayout={setLayout}
            sort={search.sort ?? DEFAULT_SORT}
            onSort={setSort}
            // The grouping knob lives here too, but only where grouping is possible.
            group={
              isManualCollection && folders.length > 0
                ? { on: foldersView, onChange: setGrouped }
                : undefined
            }
          />
        )}
      </div>

      {/* Following feed: the manage strip of current follows sits above the heading. */}
      {filter.kind === "following" && (
        <FollowingStrip follows={follows} onUnfollow={(kind, target) => unfollow(kind, target)} />
      )}

      {/* The core loop's front door: connect your agent (or make the first ask),
          live on the page people actually land on. Above the publish card — the
          agent path leads; hand-publishing stays one row below. */}
      {homeView && <ConnectNudge nudge={connectNudge} />}

      {/* One-time, dismissible: the owner of a Brandprint-less workspace gets the
          "first on the team" setup nudge here (spec: Onboarding / Timing). */}
      {homeView && connectNudge.stage === null && <BrandprintNudge />}

      {showCollections ? (
        layout === "list" ? (
          <CollectionsList
            collections={visibleCollections}
            items={items}
            loading={isPending || !!hasNextPage || isFetchingNextPage}
            sort={search.sort ?? DEFAULT_SORT}
            onSort={setSort}
            onStar={(id, next) => starCol.mutate({ id, on: next })}
            onOpen={(a) => nav({ to: "/artifacts/$ref", params: { ref: refFor(a) } })}
            onToggleFavorite={toggleFavorite}
            onAddToCollection={setPendingCollections}
            onDelete={setPendingDelete}
            onPrefetch={(a) => prefetch(a.short_id)}
          />
        ) : (
          <CollectionsView
            collections={visibleCollections}
            onStar={(id, next) => starCol.mutate({ id, on: next })}
            onCreate={(title) => createCol.mutate(title)}
            draft={newCollection}
            setDraft={setNewCollection}
          />
        )
      ) : filter.kind === "collection" ? (
        <>
          <CollectionBar
            title={heading}
            count={headingCount ?? items.length}
            ancestors={collectionAncestors}
            onShare={() => activeCollection && setShareCol(activeCollection)}
            starred={activeCollection?.starred}
            onStar={
              activeCollection
                ? (next) => starCol.mutate({ id: activeCollection.id, on: next })
                : undefined
            }
            onRename={(t) => renameCollection(filter.id, t)}
            onDelete={() => deleteCollection(filter.id)}
          />
          <RepoPullRequests prs={repoPrs} repo={activeCollection?.repo} activeId={filter.id} />
        </>
      ) : null}

      {/* The artifact body. Absent in the Collections view — that view IS the page, and
          rendering the grid underneath it put shelves and artifacts on one screen. */}
      {!showCollections && (
        <>
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
              onOpen={(a) =>
                nav({ to: "/artifacts/$ref", params: { ref: refFor(a) }, search: openContext })
              }
              onToggleFavorite={toggleFavorite}
              onPickAuthor={pickAuthor}
              onAddToCollection={setPendingCollections}
              onDelete={setPendingDelete}
              onPrefetch={(a) => prefetch(a.short_id)}
              selection={selection}
            />
          ) : isManualCollection && folders.length > 0 ? (
            // An organized manual collection. Grouping is DECOUPLED from presentation: the
            // Display menu's "Group by folder" flips grouping on/off, and BOTH states are the
            // card grid — grouping never costs you the thumbnails. Default grouped.
            foldersView ? (
              <CollectionFolders
                collectionId={filter.id}
                items={items}
                folders={folders}
                assignments={folderAssignments}
                canManage={!!canManageFolders}
                hasNextPage={!!hasNextPage}
                isFetchingNextPage={isFetchingNextPage}
                scrollToFolderId={folderAnchor}
                onOpen={(a) =>
                  nav({ to: "/artifacts/$ref", params: { ref: refFor(a) }, search: openContext })
                }
                onToggleFavorite={toggleFavorite}
                onAddToCollection={setPendingCollections}
                onDelete={setPendingDelete}
                onPrefetch={(a) => prefetch(a.short_id)}
                selection={selection}
              />
            ) : (
              <>
                <ArtifactGrid
                  layout={layout}
                  sort={search.sort ?? DEFAULT_SORT}
                  onSort={setSort}
                  onPickAuthor={pickAuthor}
                  items={items}
                  scrollRef={scrollRef}
                  hasNextPage={!!hasNextPage}
                  isFetchingNextPage={isFetchingNextPage}
                  onLoadMore={() => fetchNextPage()}
                  onOpen={(a) =>
                    nav({ to: "/artifacts/$ref", params: { ref: refFor(a) }, search: openContext })
                  }
                  onToggleFavorite={toggleFavorite}
                  onAddToCollection={setPendingCollections}
                  onDelete={setPendingDelete}
                  onPrefetch={(a) => prefetch(a.short_id)}
                  selection={selection}
                />
                {isFetchingNextPage && (
                  <div className="flex justify-center py-2" data-testid="library-loading-more">
                    <Spinner />
                  </div>
                )}
              </>
            )
          ) : (
            <>
              {/* No folders yet on a manual collection → keep the card grid; an editor gets a
                "New folder" to start organizing (the view flips to folders once one exists). */}
              {filter.kind === "collection" && canManageFolders && (
                <NewFolderControl collectionId={filter.id} className="mb-3" />
              )}
              <ArtifactGrid
                layout={layout}
                sort={search.sort ?? DEFAULT_SORT}
                onSort={setSort}
                onPickAuthor={pickAuthor}
                items={items}
                scrollRef={scrollRef}
                hasNextPage={!!hasNextPage}
                isFetchingNextPage={isFetchingNextPage}
                onLoadMore={() => fetchNextPage()}
                onOpen={(a) =>
                  nav({ to: "/artifacts/$ref", params: { ref: refFor(a) }, search: openContext })
                }
                onToggleFavorite={toggleFavorite}
                onAddToCollection={setPendingCollections}
                onDelete={setPendingDelete}
                onPrefetch={(a) => prefetch(a.short_id)}
                selection={selection}
              />
              {isFetchingNextPage && (
                <div className="flex justify-center py-2" data-testid="library-loading-more">
                  <Spinner />
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* The bulk-action bar — the only surface multi-select adds. It rides at the end of
          the page content (sticky), so it pins above the fold while you scroll and never
          overlaps the rail. */}
      {selection.selectedItems.length > 0 && (
        <SelectionBar
          items={selection.selectedItems}
          listKey={listQuery.queryKey}
          onClear={selection.clear}
          folderContext={
            filter.kind === "collection" && canManageFolders
              ? { collectionId: filter.id, folders }
              : undefined
          }
        />
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
      {/* Quick-organize dialog — opened from a card/row ⋯ menu. */}
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
  onPickAuthor,
  onAddToCollection,
  onDelete,
  onPrefetch,
  selection,
}: {
  items: Artifact[]
  showFolders: boolean
  onToggle: (on: boolean) => void
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
  onOpen: (a: Artifact) => void
  onToggleFavorite: (a: Artifact) => void
  onPickAuthor: (login: string) => void
  onAddToCollection: (a: Artifact) => void
  onDelete: (a: Artifact) => void
  onPrefetch: (a: Artifact) => void
  selection?: LibrarySelection
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
          onPickAuthor={onPickAuthor}
          onAddToCollection={onAddToCollection}
          onDelete={onDelete}
          onPrefetch={onPrefetch}
          selection={selection}
        />
      ) : (
        <ListShell>
          <div data-testid="library-flat-list">
            {items.map((a) => (
              <ArtifactListRow
                key={a.short_id}
                artifact={a}
                onOpen={() => onOpen(a)}
                onToggleFavorite={() => onToggleFavorite(a)}
                onAddToCollection={() => onAddToCollection(a)}
                onDelete={() => onDelete(a)}
                onPrefetch={() => onPrefetch(a)}
                selected={selection?.selected.has(a.short_id)}
                selectionActive={selection?.active}
                onSelect={selection ? (shift) => selection.toggle(a.short_id, shift) : undefined}
              />
            ))}
          </div>
          {(hasNextPage || isFetchingNextPage) && (
            <div className="flex justify-center py-2">
              <Spinner />
            </div>
          )}
        </ListShell>
      )}
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
            onClick={() => nav({ to: "/settings/$section", params: { section: "people" } })}
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
