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

const LIBRARY_PAGE = 30

// The library list as an infinite query: each page is a keyset slice, and the
// next cursor drives infinite scroll. Keyed by the active filter (search / tag /
// collection / favorites) so each view caches independently.
export type LibraryParams = {
  q?: string
  tag?: string
  collection?: string
  favorite?: boolean
  // Narrow to artifacts last changed by this GitHub login.
  author?: string
  // The named-feed scopes, each its own route (see LibraryView):
  // "following" → the activity feed (followed authors + repo path prefixes);
  // "shared" → artifacts explicitly shared with you (can span workspaces);
  // "needs_feedback" → artifacts with an open thread you're tagged in or commented on;
  // "mine" → everything you've published by hand, any visibility included.
  scope?: "following" | "shared" | "needs_feedback" | "mine"
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
    queryFn: () =>
      api
        .listArtifacts({ limit: 100 })
        .then((r) => r.artifacts.filter((a) => a.current_content_type === "derive/skill")),
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

// The active-sync poll behind the rail's SyncChip. Fast cadence while a sync runs
// (smooth progress bar), relaxed when idle; unlike the app default this DOES refetch
// on focus, so returning to the tab surfaces a sync that started elsewhere.
export const activeSyncsQuery = () =>
  queryOptions({
    queryKey: ["sync-active"] as const,
    queryFn: () => api.activeSyncs(),
    refetchInterval: (q) => (q.state.data?.active.length ? 1500 : 8000),
    refetchOnWindowFocus: true,
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

// Warm the artifact's rendered HTML so its sandboxed iframe paints from the HTTP
// cache instead of a cold fetch on open. The raw route is version-explicit, so
// callers pass the version they intend to show. Idempotent per (id, version).
export function prefetchArtifactRaw(shortId: string, version: number) {
  if (typeof document === "undefined") return
  const key = `${shortId}@${version}`
  if (document.querySelector(`link[data-raw="${key}"]`)) return
  // A plain rel=prefetch (no `as`) warms the HTTP cache for the iframe's later
  // navigation. `as="document"` isn't a reflected destination in Chrome and can
  // stop the iframe from reusing the response, so we leave it off.
  const link = document.createElement("link")
  link.rel = "prefetch"
  link.href = `${API_BASE}/raw/${shortId}/v/${version}/index.html`
  link.dataset.raw = key
  document.head.appendChild(link)
}

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

// Per-workspace integration switches (email + GitHub mirroring + Slack posting)
// behind the Integrations section. The toggles flip this cache entry optimistically
// and roll it back on error.
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

// Slack connection status for the Integrations section (availability, connected
// team, default channel). Invalidated on disconnect; staleTime Infinity so a
// background refetch can't re-seed the editable channel field mid-edit.
export const slackQuery = () =>
  queryOptions({
    queryKey: ["slack"] as const,
    queryFn: () => api.getSlack(),
    staleTime: Number.POSITIVE_INFINITY,
  })

// The workspace's outbound webhooks. Invalidated on add / remove.
export const webhooksQuery = () =>
  queryOptions({
    queryKey: ["webhooks"] as const,
    queryFn: () => api.listWebhooks().then((r) => r.webhooks),
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

// Registered agents (scoped tokens that can @mention-reply + propose). Invalidated
// on create / delete.
export const agentsQuery = () =>
  queryOptions({
    queryKey: ["agents"] as const,
    queryFn: () => api.listAgents().then((r) => r.agents),
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
export const contextSessionsQuery = (id: string) =>
  queryOptions({
    queryKey: ["context-sessions", id] as const,
    queryFn: () => api.listContextSessions(id).then((r) => r.sessions),
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
