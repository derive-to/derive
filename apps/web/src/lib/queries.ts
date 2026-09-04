import type { SortMode } from "@derive/core"
import {
  infiniteQueryOptions,
  keepPreviousData,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query"
import { API_BASE, type Artifact, api } from "@/api"

// The signed-in user (or null for an anon visitor). One key read by the thin
// AuthProvider (useQuery) AND the route guards (ensureQueryData) — they dedupe
// through this factory. staleTime Infinity: identity is session-stable, and
// login/logout mutate it explicitly via setMe(setQueryData). The queryFn returns
// null for anon (no error boundary) and only throws on a transient 5xx, so the
// query-client's default transient-retry self-heals a blip.
export const meQuery = () =>
  queryOptions({
    queryKey: ["me"] as const,
    queryFn: () => api.session(),
    staleTime: Number.POSITIVE_INFINITY,
    // Never persist the session — auth must re-resolve fresh on every boot so an expired
    // session can't restore as "logged in" (the route guards await a live one).
    meta: { persist: false },
  })

// Nav-rail data (counts + tag list, collections, workspaces). Warmed
// fire-and-forget by the authed routes' loaders and read via useQuery by the rail
// / library / command palette — one key each, so loader-warm and component-read
// dedupe. Kept fresh by explicit invalidation on the relevant mutations (create
// collection, publish, favorite, …) and on route change.
export const summaryQuery = () =>
  queryOptions({
    queryKey: ["summary"] as const,
    queryFn: () => api.browseSummary(),
  })

export const collectionsQuery = () =>
  queryOptions({
    queryKey: ["collections"] as const,
    queryFn: () => api.listCollections().then((r) => r.collections),
  })

// The picker's semantic Suggested tier (see CollectionsDialog). Neighbors only move
// when something similar is published, so a short staleTime just stops a close/reopen
// from re-running the vector lookup. No retry: the tier is best-effort garnish, and
// the picker reads a missing or failed answer as "no suggestions", never as an error.
export const collectionSuggestionsQuery = (shortId: string) =>
  queryOptions({
    queryKey: ["collection-suggestions", shortId] as const,
    queryFn: () => api.collectionSuggestions(shortId).then((r) => r.suggestions.map((s) => s.id)),
    staleTime: 5 * 60_000,
    retry: false,
  })

// A collection's folders (name order) + its artifact→folder assignment map — drives the
// collection view's folder grouping and management. Keyed by collection.
export const collectionFoldersQuery = (collectionId: string) =>
  queryOptions({
    queryKey: ["collection-folders", collectionId] as const,
    queryFn: () => api.collectionFolders(collectionId),
  })

// Workspaces only change via create/switch/delete — all of which hard-reload — so
// this is effectively fetch-once per session.
export const workspacesQuery = () =>
  queryOptions({
    queryKey: ["workspaces"] as const,
    queryFn: () => api.listWorkspaces(),
  })

export const LIBRARY_PAGE = 30

// The library list as an infinite query: each page is a keyset slice, and the
// next cursor drives infinite scroll. Keyed by the active filter (search /
// collection / favorites) so each view caches independently.
export type LibraryParams = {
  q?: string
  collection?: string
  favorite?: boolean
  // Narrow to artifacts last changed by this GitHub login.
  author?: string
  // The named-feed scopes, each its own route (see LibraryView):
  // "following" → the activity feed (followed authors + repo path prefixes);
  // "shared" → artifacts explicitly shared with you (can span workspaces);
  // "needs_feedback" → artifacts with an open thread you're tagged in or commented on;
  // "mine" → everything you've published by hand, any visibility included;
  // "archived" → the reversible archive shelf.
  scope?: "following" | "shared" | "needs_feedback" | "mine" | "archived"
  // Grid order; the query key already includes the whole params object, so each sort caches
  // independently. Absent ⇒ the API default (created); the library passes DEFAULT_SORT.
  sort?: SortMode
}
export const libraryArtifactsQuery = (params: LibraryParams) =>
  infiniteQueryOptions({
    queryKey: ["artifacts", params] as const,
    queryFn: ({ pageParam, signal }) =>
      api.listArtifacts(
        { ...params, cursor: pageParam || undefined, limit: LIBRARY_PAGE },
        { signal },
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    // Keep showing the current results while a new filter/search loads, so
    // switching views doesn't flash the skeleton.
    placeholderData: keepPreviousData,
    // Always revalidate when a view is (re)mounted — navigating back to a
    // collection must never strand a stale/empty cached page (the blank-collection
    // bug: a collection cached empty mid-sync, then shown empty on return).
    refetchOnMount: "always",
    // Deliberately NO maxPages: the keyset cursor is forward-only (next_cursor with no
    // previous-cursor twin), so a page cap would drop the TOP pages on a deep scroll
    // with no way to refetch them — the list would visibly lose its head. Bounding the
    // persisted-restore cost of a deep scroll needs bidirectional cursors first.
  })

// Artifacts that need YOUR feedback: an open comment thread you're tagged in or have
// commented on. Read as a COUNT for the home's quiet triage line (the full list is the
// /feedback feed, an infinite libraryArtifactsQuery({ scope: "needs_feedback" })). Kept a
// flat capped fetch — the home only needs "is there anything, and how much".
export const needsFeedbackArtifactsQuery = () =>
  queryOptions({
    queryKey: ["artifacts", "needs_feedback"] as const,
    queryFn: () =>
      api.listArtifacts({ scope: "needs_feedback", limit: 12 }).then((r) => r.artifacts),
  })

// The docs a Brandprint's collection holds, for the /brandprint page's managed list.
// Keyed under the ["artifacts"] prefix so the intake's settle-time invalidation
// refreshes this list the moment an upload lands. Flat and capped — a conventions
// collection is a handful of docs, not a feed.
export const brandprintDocsQuery = (collectionId: string) =>
  queryOptions({
    queryKey: ["artifacts", "brandprint-docs", collectionId] as const,
    queryFn: () =>
      api.listArtifacts({ collection: collectionId, limit: 100 }).then((r) => r.artifacts),
  })

// The artifacts in a collection, for the artifact header's sibling switcher (jump
// between explorations in the same collection). Flat and capped at 100 in the
// collection's own (recency) order — the switcher pages within that window; a rarely
// larger collection just isn't fully reachable via prev/next (the library is).
export const collectionSiblingsQuery = (collectionId: string) =>
  queryOptions({
    queryKey: ["artifacts", "siblings", collectionId] as const,
    queryFn: () =>
      api.listArtifacts({ collection: collectionId, limit: 100 }).then((r) => r.artifacts),
  })

// The active workspace's skills (bundles with a SKILL.md) — the shelf the Brandprint
// "Add a skill" picker chooses from. Skill-ness rides the denormalized content type,
// so this is a client-side narrow of the ordinary library listing.
export const workspaceSkillsQuery = () =>
  queryOptions({
    queryKey: ["artifacts", "workspace-skills"] as const,
    queryFn: () => api.listSkills().then((r) => r.skills),
  })

export const skillsQuery = (query = "") =>
  queryOptions({
    queryKey: ["skills", query] as const,
    queryFn: () => api.listSkills(query),
  })

export const skillGraphQuery = (shortId: string) =>
  queryOptions({
    queryKey: ["skills", shortId, "graph"] as const,
    queryFn: () => api.skillGraph(shortId),
  })

export const skillUsageQuery = (shortId: string) =>
  queryOptions({
    queryKey: ["skills", shortId, "usage"] as const,
    queryFn: () => api.skillUsage(shortId),
    // Installs arrive from the CLI and provenance can be written by an external
    // agent, so no in-app mutation exists to invalidate this cache. Always refresh
    // when the workbench mounts or regains focus; persisted 30s-old data made a hard
    // reload visibly contradict the API during acceptance testing.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  })

export const artifactSkillsQuery = (shortId: string) =>
  queryOptions({
    queryKey: ["artifacts", shortId, "skills"] as const,
    queryFn: () => api.artifactSkills(shortId),
  })

// The caller's own connected sources. NO UI CONSUMES THIS YET, on purpose: the Sources
// settings screen was removed because neither broker can produce a usable connection. The
// local broker reports `active` immediately and then echoes a tool's own arguments back
// instead of calling anything, and the Composio broker returns `pending` with no callback
// route to ever complete it — while toolsForRun only ever passes `active` connections to a
// run. So the screen said "connected" and meant nothing. Kept because the server half is
// real and the screen comes back the moment a connection can actually reach `active`.
export const connectionsQuery = () =>
  queryOptions({
    queryKey: ["connections"] as const,
    queryFn: () => api.connections(),
  })

/** Every connection an owner may bind to an automation, including workspace GitHub Apps.
 *  Keep this under the `connections` key so integration changes invalidate both views. */
export const automationConnectionsQuery = () =>
  queryOptions({
    queryKey: ["connections", "automation"] as const,
    queryFn: () => api.automationConnections(),
  })

// A small, flat slice of the Following feed — recent work from the people you follow —
// for the "Recent activity" preview on the People tab. The full feed lives at /following
// (the infinite libraryArtifactsQuery({ scope: "following" })); this is the peek.
export const followingPreviewQuery = () =>
  queryOptions({
    queryKey: ["artifacts", "following-preview"] as const,
    queryFn: () => api.listArtifacts({ scope: "following", limit: 6 }).then((r) => r.artifacts),
  })

// The OAuth clients (MCP agents) the CALLER has authorized to act as them — the
// honest "have I connected an agent yet" signal. Read by Security's revocation list
// and the connect-an-agent nudges (Brandprint, library empty state).
export const connectedAgentsQuery = () =>
  queryOptions({
    queryKey: ["connected-agents"] as const,
    queryFn: () => api.connectedAgents().then((r) => r.agents),
  })

// The activation signals for first-run onboarding + the getting-started checklist:
// whether an agent is connected and what it first published for you. The welcome
// screen polls this (refetchInterval at the call site) so connect + first-publish
// check themselves off live; the rail checklist reads it at normal staleness.
export const onboardingQuery = () =>
  queryOptions({
    queryKey: ["onboarding"] as const,
    queryFn: () => api.onboarding(),
  })

// The caller's follows (GitHub authors + repo path prefixes) for the active
// workspace. Drives the Following-feed empty state, the manage strip, and the
// isFollowing* sets that toggle the Follow buttons. One source of truth: every
// add/remove invalidates this key so the toggles + strip refetch.
export const followsQuery = () =>
  queryOptions({
    queryKey: ["follows"] as const,
    queryFn: () => api.listFollows().then((r) => r.follows),
  })

// A public profile by handle — identity card + stats + (for a signed-in viewer)
// followed_by_me. Keyed by handle; invalidated on any follow change so the stats +
// Follow button stay live. retry:false so a 404 (no such handle) renders immediately.
export const profileQuery = (handle: string) =>
  queryOptions({
    queryKey: ["profile", handle] as const,
    queryFn: () => api.profile(handle).then((r) => r.user),
    retry: false,
  })

// A person's work as an infinite query — public artifacts they authored, plus
// shared-workspace work for a signed-in viewer. Keyset cursor drives infinite scroll.
const PROFILE_PAGE = 24
export const profileArtifactsQuery = (handle: string) =>
  infiniteQueryOptions({
    queryKey: ["profile-artifacts", handle] as const,
    queryFn: ({ pageParam, signal }) =>
      api.profileArtifacts(handle, pageParam || undefined, PROFILE_PAGE, { signal }),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })

// The People directory search. Empty query browses everyone discoverable; a term
// searches (debounced by the caller). keepPreviousData holds results across
// keystrokes so the grid never flashes its skeleton mid-search.
export const peopleQuery = (query: string) =>
  queryOptions({
    queryKey: ["people", query] as const,
    // The ctx param is annotated (not inferred): people.tsx spreads these options to
    // add `enabled`, and TS's inference for a destructured context + keepPreviousData
    // through a spread collapses the data type into a union with the placeholder fn.
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.people(query || undefined, { signal }).then((r) => r.users),
    placeholderData: keepPreviousData,
  })

// Doc search for the automation-target picker: title search over the workspace's
// artifacts, small page, previous results held while typing so the list never
// flashes empty mid-keystroke.
export const targetPickerQuery = (q: string) =>
  queryOptions({
    queryKey: ["artifacts", "target-picker", q] as const,
    queryFn: ({ signal }) => api.listArtifacts({ q: q.trim() || undefined, limit: 8 }, { signal }),
    placeholderData: keepPreviousData,
  })

// Full workspace search for the /search results page — the same hybrid (lexical + dense/semantic)
// endpoint the ⌘K palette uses, but a deeper page (default 30 vs the palette's 6). Gated to ≥2
// chars (the server also requires a query); keepPreviousData holds the list across refinements so
// it never flashes empty mid-type.
export const searchQuery = (query: string, limit = 30) =>
  queryOptions({
    queryKey: ["search", query, limit] as const,
    queryFn: ({ signal }) => api.searchContent(query, limit, { signal }),
    enabled: query.trim().length >= 2,
    placeholderData: keepPreviousData,
  })

// The directory's "your workspaces" section — people you already work with,
// listed ahead of the global browse (and regardless of their discoverability).
export const workspacePeopleQuery = () =>
  queryOptions({
    // Not ["people", <query>] — a literal search for "workspace" must not
    // collide with this cache entry.
    queryKey: ["workspace-people"] as const,
    queryFn: () => api.workspacePeople().then((r) => r.users),
  })

// Every cache shape that lives under the ["artifacts"] key prefix: the library's
// infinite pages, the needs-feedback flat array, and the {artifacts} envelope the
// target-picker stores. The seed scanner below reads them all.
type ArtifactListCache =
  | Artifact[]
  | { artifacts?: Artifact[]; next_cursor?: string | null }
  | { pages?: { artifacts?: Artifact[] }[] }
  | undefined
export const artifactRowsOf = (data: ArtifactListCache): Artifact[] => {
  if (!data) return []
  if (Array.isArray(data)) return data
  if ("pages" in data && data.pages) return data.pages.flatMap((p) => p.artifacts ?? [])
  if ("artifacts" in data && data.artifacts) return data.artifacts
  return []
}

// Every artifact row the cache knows about, across all the list caches — the ⌘K
// palette's local search corpus. Cheap (a few array flattens over what is already
// in memory) and safe to call per keystroke.
export const cachedArtifactRows = (client: QueryClient): Artifact[] =>
  client
    .getQueriesData<ArtifactListCache>({ queryKey: ["artifacts"] })
    .flatMap(([, data]) => artifactRowsOf(data))

// Typed query options shared by route loaders (ensureQueryData, for intent
// preloading) and components (useQuery). One source of truth for keys +
// fetchers, so a preloaded route and the page that renders it resolve to the
// same cache entry — the preload warms exactly what the page reads.
//
// Pass the QueryClient (the component does; loaders don't need to) to seed the
// FIRST paint from any list row already in the cache: the card the person just
// clicked carries the title, author, version and tags, so the workbench header
// renders on the first frame after the click while the authoritative record
// loads. The seed is deliberately weaker than the record — a list row has no
// raw_token and may lack viewer-specific fields — so the page gates the content
// iframe on the REAL fetch (isPlaceholderData) and the seed never starts a
// render it would immediately restart.
export const artifactQuery = (shortId: string, client?: QueryClient) =>
  queryOptions({
    queryKey: ["artifact", shortId] as const,
    queryFn: () => api.getArtifact(shortId),
    // Detail responses contain a short-lived raw-content capability. Persisting the
    // whole record for 24 hours made an expired token the first value rendered after
    // boot; the background refresh arrived too late because the iframe had pinned it.
    // List rows are persisted and still seed the instant header paint below.
    meta: { persist: false },
    placeholderData: client
      ? () => {
          for (const [, data] of client.getQueriesData<ArtifactListCache>({
            queryKey: ["artifacts"],
          })) {
            const hit = artifactRowsOf(data).find((a) => a?.short_id === shortId)
            if (hit) return hit
          }
          return undefined
        }
      : undefined,
  })

// The bell's badge + panel — a real query rather than the raw fetch it replaced, so
// it dedupes with anything else that asks, persists (the badge paints warm on boot,
// before the network answers), and cancels a superseded fetch. The SSE "notification"
// event invalidates it, so staleness is only the fallback path.
export const notificationsQuery = () =>
  queryOptions({
    // Annotated ctx (not inferred): the bell spreads these options to add `enabled`,
    // the same inference collapse peopleQuery documents.
    queryKey: ["notifications"] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => api.notifications({ signal }),
  })

export const commentsQuery = (shortId: string) =>
  queryOptions({
    queryKey: ["comments", shortId] as const,
    queryFn: () => api.listComments(shortId).then((r) => r.comments),
  })

// The artifact's review rounds (the /derive loop): the pending one the reader should
// settle plus the history. The activity rail renders both; the SSE review.* events
// invalidate it, so an agent's re-request appears live rather than behind a reload.
export const reviewQuery = (shortId: string) =>
  queryOptions({
    queryKey: ["review", shortId] as const,
    queryFn: () => api.getReview(shortId),
    // Always confirm on mount: the pending round arms the rail's composer, and a persisted
    // copy restored across a reload can predate a publish that opened (or settled) one.
    staleTime: 0,
  })

/** A version's dynamic table and figure slots (see routes/dynamic-data.ts). Keyed under
 *  the artifact so a live `artifact.dynamic.updated` event can invalidate every version's
 *  read at once with the `["artifact", shortId, "dynamic"]` prefix. */
export const dynamicSlotsQuery = (shortId: string, version: number) =>
  queryOptions({
    queryKey: ["artifact", shortId, "dynamic", version] as const,
    queryFn: () => api.dynamicSlots(shortId, version),
    staleTime: 30_000,
  })

export const dynamicHistoryQuery = (shortId: string, name: string, version: number) =>
  queryOptions({
    queryKey: ["artifact", shortId, "dynamic", version, "history", name] as const,
    queryFn: () => api.dynamicHistory(shortId, name, version),
    staleTime: 30_000,
  })

/** The URL the sandboxed viewer loads for an artifact's rendered bytes. ONE builder,
 *  shared by the viewer and by the test that pins its shape, because there used to be
 *  two that disagreed. The token is the frame's proof of access (an opaque origin cannot
 *  send our cookie), so it is part of the URL and therefore part of the HTTP cache key —
 *  which is why it is minted on a time BUCKET (RAW_TOKEN_WINDOW_MS) rather than on `now`:
 *  a URL that changes every request can never hit the browser cache. */
export const rawArtifactUrl = (shortId: string, version: number, rawToken?: string) =>
  `${API_BASE}/raw/${shortId}/v/${version}${rawToken ? `/t/${rawToken}` : ""}/index.html`

// ---- Settings ---------------------------------------------------------------

// The active workspace: its name, the caller's role, and the member roster. One
// SHARED key read by BOTH the General section (name + lifecycle) and the Members
// section (roster + isAdmin), so the two panes dedupe into a single cache entry.
// Kept fresh by explicit setQueryData / invalidation on rename + membership edits;
// staleTime Infinity so a background refetch (e.g. on reconnect) never re-seeds the
// editable name field mid-edit — matching the section's prior fetch-once behavior.
export const workspaceQuery = () =>
  queryOptions({
    queryKey: ["workspace"] as const,
    queryFn: () => api.getWorkspace(),
    staleTime: Number.POSITIVE_INFINITY,
  })

// Pending workspace invitations (Admin-only view under Members). Refetched on
// invite/revoke; not preloaded, so it's a plain lazy query gated on being an Admin.
export const workspaceInvitesQuery = () =>
  queryOptions({
    queryKey: ["workspace", "invites"] as const,
    queryFn: () => api.listWorkspaceInvites().then((r) => r.invites),
  })

/** The deploy-wide model plus the catalog to choose from — operator-only, so its failure is
 *  also the signal that the person is not one. */
export const instanceChatModelQuery = () =>
  queryOptions({
    queryKey: ["instance-chat-model"] as const,
    queryFn: () => api.getInstanceChatModel(),
    retry: false,
  })

/** The whole model library — operator-only, so its failure is also the signal that the person is
 *  not one. NOT cached long: the page exists to be looked at while a provider is misbehaving, and
 *  a probe or a pin has to be visible the moment it lands. */
export const modelLibraryQuery = () =>
  queryOptions({
    queryKey: ["model-library"] as const,
    queryFn: () => api.modelLibrary(),
    retry: false,
  })

/** Whether the signed-in person is an INSTANCE operator (super-admin), by asking for something
 *  only an operator may read. Errors for everyone else, which is the signal; `retry: false` so a
 *  normal member's 403 costs one request and not four. */
export const operatorQuery = () =>
  queryOptions({
    queryKey: ["system-capabilities"] as const,
    queryFn: () => api.systemCapabilities(),
    retry: false,
    staleTime: 5 * 60_000,
  })

/** The deploy's model catalog. A capability of the instance, not of a workspace, so it is
 *  fetched once and kept — it changes only when the operator reconfigures providers. */
export const chatModelsQuery = () =>
  queryOptions({
    queryKey: ["chat-models"] as const,
    queryFn: () => api.chatModels(),
    staleTime: 5 * 60_000,
  })

export const workspaceSettingsQuery = () =>
  queryOptions({
    queryKey: ["workspace-settings"] as const,
    queryFn: () => api.getWorkspaceSettings(),
  })

// The workspace's billing truth (plan, Stripe status, seats, storage) behind the
// Billing section. Not preloaded; a plain lazy query read by owner and non-owner
// members alike (everyone sees the plan card, only an owner sees the buttons).
export const billingQuery = () =>
  queryOptions({
    queryKey: ["billing"] as const,
    queryFn: () => api.getBilling(),
  })

/** JUST the publishing-blocked verdict, for the app shell's banner.
 *
 *  Its own key because it is seeded by the boot batch (lib/bootstrap.ts) and therefore
 *  normally costs no request at all. The banner used to read `billingQuery`, which meant
 *  every authed page load called GET /v1/billing — 6 store calls and 676ms on the boot
 *  waterfall, the most expensive request there — to be told it is not blocked. The
 *  fallback queryFn is that same endpoint, so a failed boot batch degrades to exactly the
 *  old behavior rather than to a missing banner. */
export const blockedQuery = () =>
  queryOptions({
    queryKey: ["billing", "blocked"] as const,
    queryFn: () => api.getBilling().then((b) => b.blocked),
  })

// Slack connection status for the Integrations section. Keep it eligible for focus
// refetches so an OAuth flow completed in another tab updates the original settings
// page as soon as the user returns.
export const slackQuery = () =>
  queryOptions({
    queryKey: ["slack"] as const,
    queryFn: () => api.getSlack(),
    refetchOnWindowFocus: "always",
  })

// GitHub standard-integration status. The install callback returns to this page, and a
// GitHub-side repository selection change may happen in another tab, so refetch on focus.
export const githubQuery = () =>
  queryOptions({
    queryKey: ["github"] as const,
    queryFn: () => api.getGithub(),
    refetchOnWindowFocus: "always",
  })

// The workspace's Slack channel subscriptions, plus the event types one can carry (the server
// owns that list so the picker can't drift from it). Invalidated on add / edit / remove.
export const slackSubscriptionsQuery = () =>
  queryOptions({
    queryKey: ["slack-subscriptions"] as const,
    queryFn: () => api.listSlackSubscriptions(),
  })

// Public channels the Slack bot can see, for the subscribe picker. Fetched lazily (the caller
// gates it with `enabled`) and cached for a while — a workspace's channel list barely moves,
// and the call pages through the Slack API.
export const slackChannelsQuery = () =>
  queryOptions({
    queryKey: ["slack-channels"] as const,
    queryFn: () => api.listSlackChannels().then((r) => r.channels),
    staleTime: 5 * 60_000,
  })

// The workspace's outbound webhooks. Invalidated on add / remove.
// Keeps the whole response: `event_options` travels with the list so the picker offers exactly
// what the server accepts. The client used to carry its own three-entry copy of that list while
// the server emitted eleven, which silently made eight events unpickable from Settings.
export const webhooksQuery = () =>
  queryOptions({
    queryKey: ["webhooks"] as const,
    queryFn: () => api.listWebhooks(),
  })

// One webhook's recent delivery log, fetched lazily when its row's log opens
// (the caller gates it with `enabled`). Keyed by webhook id so each row caches
// apart; staleTime 0 so every open fetches a fresh log (as the old code did on
// each open), plus the explicit refetch after a test send.
export const webhookDeliveriesQuery = (id: string) =>
  queryOptions({
    queryKey: ["webhook-deliveries", id] as const,
    queryFn: () => api.webhookDeliveries(id).then((r) => r.deliveries),
    staleTime: 0,
  })

// This workspace's custom domains (Cloudflare for SaaS): whether the feature is on,
// the CNAME target, and the domain list. Invalidated on add / refresh / remove.
export const customDomainsQuery = () =>
  queryOptions({
    queryKey: ["custom-domains"] as const,
    queryFn: () => api.listWorkspaceDomains(),
  })

// Registered agents (scoped tokens that can @mention-reply + publish). Invalidated
// on create / delete.
export const agentsQuery = () =>
  queryOptions({
    queryKey: ["agents"] as const,
    queryFn: () => api.listAgents().then((r) => r.agents),
  })

export const workflowsQuery = () =>
  queryOptions({
    queryKey: ["workflows"] as const,
    queryFn: () => api.listWorkflows().then((r) => r.workflows),
  })

// Automations (standing agent jobs) + runs (their executions — the activity ledger).
// Invalidated on create / delete / run-now.
export const automationsQuery = () =>
  queryOptions({
    queryKey: ["automations"] as const,
    queryFn: () => api.listAutomations().then((r) => r.automations),
  })

// The caller's own connected model-plan credentials (hints only). Personal, so keyed plainly.
export const modelCredentialsQuery = () =>
  queryOptions({
    queryKey: ["model-credentials"] as const,
    queryFn: () => api.listModelCredentials().then((r) => r.credentials),
  })

// The workspace's shared model-plan pool (hints only, admin surface).
export const poolCredentialsQuery = () =>
  queryOptions({
    queryKey: ["pool-model-credentials"] as const,
    queryFn: () => api.listPoolCredentials().then((r) => r.credentials),
  })

/** The home's "Needs you" + "Recent activity", in one request so the sections paint
 *  once (the rail's lesson). Fresh on every visit — asks settle and work lands
 *  constantly — but the persisted copy paints a reload like a nav. */
/** A reader's stored position in an activity stream. Read at the start of a visit; the
 *  visit's own snapshot (use-seen-cursor) is what the marker is drawn from, so a refetch
 *  here never moves a line the reader is looking at. */
export const activitySeenQuery = (scope: string) =>
  queryOptions({
    queryKey: ["activity-seen", scope] as const,
    queryFn: () => api.activitySeen(scope),
    staleTime: 30_000,
  })

export const workspaceActivityQuery = () =>
  queryOptions({
    queryKey: ["workspace-activity"] as const,
    queryFn: () => api.workspaceActivity(),
    staleTime: 30_000,
  })

export const runsQuery = () =>
  queryOptions({
    queryKey: ["runs"] as const,
    queryFn: () => api.listRuns().then((r) => r.runs),
    // The ledger changes out-of-band (the executor writes runs the tab never saw),
    // so revalidate whenever the Automations view mounts — never strand a cached page
    // that predates the latest runs.
    refetchOnMount: "always",
  })

// The agents an artifact viewer may address (the "ask an agent to revise" flow). Read
// off the @mention directory (which any commenter can see, unlike /v1/agents which is
// owner-only), filtered to kind:"agent". Stable per artifact.
export const artifactAgentsQuery = (shortId: string) =>
  queryOptions({
    queryKey: ["artifact-agents", shortId] as const,
    queryFn: () =>
      api
        .users(undefined, shortId)
        .then((r) => r.users.filter((u) => u.kind === "agent" && u.name)),
  })

// ---- Contexts + sessions ------------------------------------------------------

// The workspace's askable contexts. Invalidated on create (deletion is
// API-only for now — no web surface).
export const contextsQuery = () =>
  queryOptions({
    queryKey: ["contexts"] as const,
    queryFn: () => api.listContexts().then((r) => r.contexts),
  })

export const contextQuery = (id: string) =>
  queryOptions({
    queryKey: ["context", id] as const,
    queryFn: () => api.getContext(id),
  })

// The caller's sessions on a context (the owner sees everyone's). Invalidated
// when a new session opens.
// Infinite: a context that has been run for months has more sessions than one page,
// and Activity is the record of ALL of them. Keyset cursor (`created_at|id`), so a
// session opening mid-scroll never repeats or hides a row the way an offset would.
export const contextSessionsQuery = (id: string) =>
  infiniteQueryOptions({
    queryKey: ["context-sessions", id] as const,
    queryFn: ({ pageParam }) => api.listContextSessions(id, pageParam || undefined),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })

// What a context has PRODUCED — one row per artifact with a run count, newest first.
// Invalidated alongside the sessions list: a run that binds a result changes both.
export const contextOutputsQuery = (id: string) =>
  queryOptions({
    queryKey: ["context-outputs", id] as const,
    queryFn: () => api.listContextOutputs(id).then((r) => r.outputs),
  })

// One session + transcript, polled the activeSyncsQuery way: fast while the
// runner owes a reply (`open`), off once the conversation is settled — the
// composer's send flips it back by invalidating this key.
export const sessionQuery = (id: string) =>
  queryOptions({
    queryKey: ["session", id] as const,
    queryFn: () => api.getSession(id),
    refetchInterval: (q) => (q.state.data?.session.state === "open" ? 1500 : false),
    refetchOnWindowFocus: true,
  })

// Open abuse reports for the active workspace — drives the owner-only Moderation
// nav item's visibility + the Reports section. Invalidated after a takedown / dismiss.
export const reportsQuery = () =>
  queryOptions({
    queryKey: ["reports"] as const,
    queryFn: () => api.listReports().then((r) => r.reports),
  })
