/**
 * Core owns the ports; packages/db and packages/storage provide the adapters.
 * Everything here must run on Node AND Cloudflare Workers — no Node APIs.
 */
import type { LinkRole, Listed, Role, WorkspaceAccess } from "./roles"
import type { SharedStateAction } from "./shared-state"
import type { SortMode } from "./sort"

export interface BlobStore {
  /** Content-addressed put; returns the sha256 hex key. Idempotent. */
  put(data: Uint8Array): Promise<string>
  get(key: string): Promise<Uint8Array | null>
  /** Cheap existence check (a stat/HEAD, never a body read). OPTIONAL and additive so
   *  existing stores keep compiling; a caller that needs it (publish lint's
   *  broken-embed check) treats absence as "can't check here" and skips — it never
   *  falls back to a full get. */
  has?(key: string): Promise<boolean>
}

/**
 * An optional SEMANTIC search index — the dense (embedding) arm of workspace search,
 * paired with the lexical FTS the MetaStore already provides ({@link MetaStore.searchArtifactIds}).
 * Unset ⇒ search stays lexical-only; otherwise the edge and a Postgres self-host both inject a
 * pgvector adapter (embeddings from Workers AI or a local model). The caller fuses these with the
 * lexical ones
 * (reciprocal-rank fusion) and re-applies visibility through `listArtifacts({ ids })`, so this
 * port — exactly like the FTS — has NO visibility knowledge and can never widen what a viewer
 * sees. Runs on Node AND Workers (no Node APIs), same as every other port here.
 *
 * Every method is BEST-EFFORT from the caller's side: an index hiccup must never fail a publish,
 * and a stale row (a delete/move/takedown the caller didn't propagate) is a findability/cost
 * concern only — the visibility gate drops it, so it can never leak content. Eventual
 * consistency in the backend (a just-upserted vector isn't instantly queryable) is likewise
 * invisible to users: the synchronous FTS arm answers read-your-writes; the dense arm catches up.
 */
export interface SearchIndex {
  /** Upsert an artifact's current text (chunked + embedded internally, one vector per passage),
   *  scoped by org. Driven by the same publish/restore/approve chokepoint as the FTS index. */
  indexArtifact(id: string, orgId: string, title: string | null, text: string): Promise<void>
  /** Batch variant of {@link indexArtifact} for the backfill sweep: embed + upsert a page in
   *  sub-batches — far fewer embed calls + vector-store writes than one call per artifact.
   *  Single publishes still use indexArtifact. Best-effort like the rest. */
  indexArtifacts(
    items: { id: string; orgId: string; title: string | null; text: string }[],
  ): Promise<void>
  /** Drop an artifact's vectors (hard delete). Best-effort; the gate covers a miss. Named to
   *  match its lexical sibling {@link MetaStore.unindexArtifact}. */
  unindexArtifact(id: string): Promise<void>
  /** The most semantically-relevant artifact ids in ONE org for `query`, ranked (higher
   *  score = more relevant), with NO visibility filter — the caller re-applies visibility
   *  via `listArtifacts({ ids })`. `chunk` is the best-matching passage: the evidence/snippet
   *  a caller shows for a semantic match the literal grep-confirm pass won't reproduce. `score`
   *  is returned for a future score-weighted fusion / relevance threshold; today's caller fuses
   *  by rank (RRF) and doesn't read it. */
  search(
    orgId: string,
    query: string,
    limit: number,
  ): Promise<{ id: string; score: number; chunk: string }[]>
  /** The most semantically-similar OTHER artifacts to one already-indexed artifact,
   *  ranked like {@link search} and with the same NO-visibility-filter contract. Reads
   *  the artifact's stored lead vector — no embed call at query time — so it's cheap
   *  enough for interactive surfaces (the collection picker's "filed with similar
   *  work" suggestions). Empty when the artifact has no vector yet (never indexed, or
   *  the dense arm was down at publish). Optional: a lexical-only install has no
   *  vectors to compare. */
  similar?(
    orgId: string,
    artifactId: string,
    limit: number,
  ): Promise<{ id: string; score: number; chunk: string }[]>
}

/**
 * Turns text into embedding vectors — the generation half of the dense arm, split from the
 * storage half ({@link SearchIndex}) so the two vary independently: a deployment pairs whatever
 * embedder it can run (Cloudflare Workers AI on the edge, a local ONNX model or the Workers AI REST
 * API on a self-host box) with the pgvector store. A `SearchIndex` adapter that needs to embed
 * composes an `Embedder`; the two MUST agree on `dimensions`.
 *
 * `model` + `dimensions` identify the vector space: a corpus embedded with one model can't be
 * queried with another (the geometry differs), so an embedder change is a full re-backfill, never an
 * in-place mix. The pgvector store guards this by DIMENSION (its column is `vector(dimensions)`, and
 * ensureSchema refuses a differently-sized swap) — enough today because the embedders differ in
 * dimension (bge-m3 1024, bge-small 384); a same-dimension swap would need the old vectors dropped
 * manually. Runs on Node AND Workers (no Node APIs in the interface itself).
 */
export interface Embedder {
  /** Stable model id, e.g. `@cf/baai/bge-m3`. Pinned — never "latest". */
  readonly model: string
  /** Output vector length (e.g. 1024 for bge-m3, 384 for bge-small). The vector store's column
   *  type / index is sized to this; a change forces a new index + re-backfill. */
  readonly dimensions: number
  /** Minimum cosine similarity for a dense hit to count as relevant — the noise floor BELOW which
   *  matches are dropped. Model-specific: different embedders have different cosine geometries (a
   *  bge-m3 "relevant" ~0.55 is a bge-small ~0.6), so the floor rides the embedder, not a shared
   *  constant. Calibrate per model against real vs off-target queries. */
  readonly minScore: number
  /** Embed a batch of texts, returning one vector per input IN ORDER. Implementations cap the
   *  batch to their backend's ceiling internally; callers may pass any length. Throws if the
   *  backend returns a count that doesn't match the input (no silent misalignment). */
  embed(texts: string[]): Promise<number[][]>
}

export type ArtifactKind = "file" | "bundle"

/** A platform subdomain (`name.derived.app`) or a customer's own domain. */
export type DomainKind = "subdomain" | "custom"

/** Serving status of a host. Subdomains are `active` immediately; a custom domain
 *  is `pending` until its TLS cert + ownership validate (then `active`), or `error`. */
export type DomainStatus = "active" | "pending" | "error"

export interface ArtifactRecord {
  id: string
  short_id: string
  org_id: string
  slug: string | null
  title: string | null
  /** Does the artifact's workspace get access at each member's SEAT role.
   *  `member` = every signed-in member opens at their own workspace role;
   *  `none` = only explicit shares and the world link apply. See access-model.md. */
  workspace_access: WorkspaceAccess
  /** The WORLD link: what anyone merely holding the URL gets (non-member, public,
   *  anon — anon always clamped to `viewer`). `none` = inert. A teammate with the
   *  link is NOT this (that's `workspace_access`). */
  link_role: LinkRole
  /** Discovery only — where it surfaces: `none` / `workspace` (library) / `public`
   *  (directory). Carries NO access. */
  listed: Listed
  /** Salted hash of the unlock password locking the world link; null otherwise. */
  password_hash: string | null
  kind: ArtifactKind
  spa: 0 | 1
  /** Locked: publishes are rejected until unlocked — suggest changes as comments. */
  locked: 0 | 1
  current_version: number
  /** Denormalized from the current version row — updated on every publish. */
  current_content_type: string | null
  created_at: string
  /** Set on every new version; null until first versioned (read it as
   *  `updated_at ?? created_at`). Drives "most recently updated" sort + the label. */
  updated_at: string | null
  /** A takedown tombstone: when set, the content is gone (410) but the record stays. */
  removed_at: string | null
  /** Reversible library archive. Archived artifacts stay readable by direct URL, but
   *  are excluded from ordinary discovery until restored. */
  archived_at: string | null
  /** Expiring anonymous draft (the claim flow): ISO instant after which the draft is
   *  served 410 and swept. Null for every ordinary artifact; cleared on claim. */
  expires_at: string | null
  /** When the first non-author view landed (the activation moment — recordView
   *  stamps it once; owner self-views were already excluded upstream). Null until
   *  someone else has actually seen the work. */
  first_foreign_view_at: string | null
  /** Owner opt-in: the ANONYMOUS public page shows version history (dropdown + old
   *  versions). Falsy = anon sees the current version only; signed-in readers always
   *  keep workbench history (auth is the gate, like comments). */
  public_history: 0 | 1 | null
  /** Historical import metadata retained on existing records for data compatibility.
   *  New integrations do not mirror repository files or write this field. */
  source_path: string | null
  /** The CURRENT (last) author, denormalized from the latest version row for list views.
   *  The GitHub fields are retained for historical imported versions; new GitHub
   *  integrations do not publish artifacts or write them. */
  author_name: string | null
  author_login: string | null
  author_avatar: string | null
  author_gh_id: string | null
  /** The Derive user who last published this artifact (the signed-in publisher).
   *  Null for historical imports, bare static-token publishes, and legacy rows. */
  author_id: string | null
  /** Remix lineage: the artifact id this one was derived from ("use as template").
   *  Null for ordinary artifacts. Not an FK — the copy outlives a deleted source. */
  derived_from: string | null
}

export interface ListArtifactsOpts {
  limit?: number
  /**
   * Keyset cursor — return artifacts strictly past this `(key, id)` pair, where `key` is the
   * value of the active sort's ordering expression (see `sort`). The `id` tiebreak keeps
   * pagination correct when many rows share a key (sub-millisecond bulk inserts, or a shared
   * title). Encode/decode via `@derive/core`'s `encodeCursor`/`decodeCursor`.
   */
  cursor?: { key: string; id: string }
  /** How to order the page. Omitted ⇒ `created` (newest-created first) — the historical
   *  default every non-library caller relies on. The library passes `updated` and the rest.
   *  `listArtifacts` honors this; `listUserWorks`/`countUserWorks` ignore it and always order
   *  created-desc. */
  sort?: SortMode
  /** Case-insensitive metadata search across artifact titles, tags, and collection titles. */
  q?: string
  /** Which user's accessible collections may contribute collection-title matches.
   * `undefined` trusts the caller and searches every collection (operator/internal jobs);
   * `null` searches no collection titles. Artifact-title and tag matching are unaffected. */
  collectionSearchViewerId?: string | null
  /** Restrict to these artifact ids (tag / favorite filters resolve to ids). Empty ⇒ none. */
  ids?: string[]
  /** Only artifacts carrying this browse tag (case-insensitive). Matched in the query, so
   *  it composes with `sort`, `limit`, and the visibility gates in one read; resolving the
   *  tag to `ids` first would cap the candidates, not the result. */
  tag?: string
  /** Scope to a collection by JOINing its membership rather than materializing every
   *  member id into an `IN (...)`. A large collection (hundreds of items) would blow
   *  D1's 100-bound-parameter cap and 500 — the join binds one parameter regardless. */
  collectionId?: string
  /** Scope to one workspace (multi-workspace). Omitted ⇒ every workspace. */
  orgId?: string
  /** Only `public` artifacts. Set for anonymous / non-member callers so a workspace
   *  listing never leaks `org`/`link`/`password` titles to someone who can't open them. */
  publicOnly?: boolean
  /** Who is reading the list. `private` artifacts only appear for their explicit
   *  members, so the query needs the viewer to check membership against. Omitted ⇒
   *  a trusted caller (the operator token / internal jobs) that sees everything. */
  viewerId?: string
  /** Profile work-list visibility gate: a row is included when it is `public` OR its
   *  `org_id` is in this set (the workspaces the viewer shares with the profile owner).
   *  An empty/omitted set with a profile query ⇒ public-only. Used by `listUserWorks`
   *  so a person's profile never leaks non-public work the viewer can't open. */
  visibleOrgIds?: string[]
  /** Drop taken-down (`removed_at` set) rows. OFF by default because a plain listing
   *  (the feed) deliberately keeps them to render a tombstone card — it never exposes
   *  their content. Search MUST set this: it reads the live blob, so a surviving index
   *  row for a moderated artifact would otherwise let its text be grepped out, bypassing
   *  the read path's 410 tombstone. `listArtifacts` alone is therefore NOT a complete
   *  visibility gate for content — this flag closes the tombstone hole. */
  excludeRemoved?: boolean
  /** Archive shelf. Omitted/`exclude` is the ordinary live library; `only` powers
   *  the Archived view; `include` is for trusted maintenance reads. */
  archived?: "exclude" | "only" | "include"
  /** Restrict to one stored content type via the denormalized `current_content_type`
   *  column — e.g. `derive/skill` for a workspace's skills — so a typed listing
   *  filters in the store instead of paging the whole library. */
  contentType?: string
}

/** The browse sidebar's summary — see `ArtifactQueryStore.workspaceSummary`. */
export interface WorkspaceSummary {
  total: number
  /** Artifacts on the reversible archive shelf. */
  archived: number
  tags: { tag: string; count: number }[]
  /** The workspace's display name, or null when there is no workspace row. */
  workspace: string | null
  /** Favorited artifacts in THIS workspace (0 for an anonymous caller). */
  favorites: number
  /** Artifacts the caller owns here — the "Created by me" badge. */
  mine: number
  /** …of those, the ones not surfaced anywhere yet (`listed = none`). */
  minePrivate: number
}

export interface ArtifactDetailOpts {
  artifactId: string
  /** The artifact's workspace — settings are keyed on it. */
  orgId: string
  /** The signed-in viewer, or null (anonymous). Null skips the favorite lookup. */
  viewerId: string | null
}

/** One page's worth of artifact-detail context — see `ArtifactQueryStore.artifactDetail`. */
export interface ArtifactDetail {
  versions: VersionRecord[]
  /** The live rows behind every `author_id` on this artifact and its versions, so a
   *  byline frozen with an agent-client name self-heals on read WITHOUT its own round
   *  trip. Same shape and purpose as `ListEnrichment.bylines`; the route maps both
   *  through `bylinesFrom`. */
  bylines: { id: string; name: string | null; username: string | null }[]
  tags: string[]
  /** Ids of the collections containing this artifact. */
  collectionIds: string[]
  /** Distinct OPEN comment threads on this artifact (the public viewer's pill count). */
  openThreads: number
  favorite: boolean
  settings: OrgSettings
}

export interface ListEnrichmentOpts {
  /** The page of artifact ids being decorated. */
  ids: string[]
  /** Distinct `author_gh_id`s on the page, to resolve to Derive handles. */
  ghIds: string[]
  /** Distinct `author_id`s on the page, to resolve to live bylines. */
  authorIds: string[]
  /** Comment signals are computed for this viewer; null skips them (anon listing). */
  viewerId: string | null
  /** Share roles are looked up for this member key; null skips them. */
  memberId: string | null
  /** Include view counts (the list gates this on the analytics setting). */
  views: boolean
}

/** What `listPage` needs beyond the list query itself: the same three viewer-scoped
 *  knobs `listEnrichment` takes. `ghIds`/`authorIds` are absent on purpose — the page's
 *  own author columns drive those joins, so they no longer make a round trip out to the
 *  caller and back. */
export interface ListPageOpts {
  list: ListArtifactsOpts
  viewerId: string | null
  memberId: string | null
  views: boolean
}

/** One page's worth of list decoration — see `ArtifactQueryStore.listEnrichment`. */
export interface ListEnrichment {
  views: Record<string, number>
  tags: Record<string, string[]>
  /** Collection ids each row belongs to — what the library's grouped-by-collection list
   *  groups on. An arm of the same batched read, NOT a second call: the detail route has
   *  always had this (`collectionIdsForArtifact`), but per-row on a listing it would be
   *  one round trip per artifact. Empty for a row in no collection. */
  collections: Record<string, string[]>
  previews: Record<string, boolean>
  /** gh_id → Derive username rows (the subset of `usersByGithubIds` the list needs). */
  handles: { gh_id: string; username: string | null }[]
  /** Live user-directory rows for the page's authors (the subset of `getUsers` the
   *  byline self-heal needs). */
  bylines: { id: string; name: string | null; username: string | null }[]
  signals: Record<string, CommentSignals>
  shareRoles: Record<string, Role>
  /** Which of `ids` the viewer has starred. Page-scoped on purpose: a listing only ever
   *  asks "is THIS row a favorite", and the route used to answer it by fetching the
   *  viewer's ENTIRE favorite list in a round trip of its own, taken before the list
   *  query had even run. Empty for an anonymous viewer. */
  favorites: string[]
}

export type PreviewStatus = "pending" | "ready" | "failed"

export type RenderJobStatus = "pending" | "done" | "dead"
export interface RenderJobRecord {
  id: string
  artifact_id: string
  version_n: number
  status: RenderJobStatus
  attempts: number
  last_error: string | null
  next_attempt_at: string
  created_at: string
}
export interface NewRenderJob {
  id: string
  artifact_id: string
  version_n: number
}

export interface VersionRecord {
  id: string
  artifact_id: string
  n: number
  blob_key: string
  content_type: string
  /** Byte length of the uploaded payload, summed per workspace for storage quotas. */
  size_bytes: number
  author: string
  /** Historical imported-author metadata. New integrations do not write these fields. */
  author_login: string | null
  author_avatar: string | null
  author_gh_id: string | null
  /** The Derive user who published this version; null for imports/anon/legacy. */
  author_id: string | null
  /** Which surface created this version — the onboarding/analytics stamp. Null for
   *  versions predating the column and for paths that don't stamp (restore, PR preview). */
  source: VersionSource | null
  message: string | null
  /** A named checkpoint (Docs-style). Null = an ordinary auto-saved revision. */
  name: string | null
  /** Blob key of the rendered PNG preview of this version; null until generated. */
  preview_key: string | null
  /** Lifecycle of the preview render; null = never queued. */
  preview_status: PreviewStatus | null
  /** Short failure reason when preview_status === "failed". */
  preview_error: string | null
  /** The whole page as authored (fullPage:true), agent-facing only — never the
   *  og:image/unfurl crop above. Catches below-the-fold breakage the 1200x630 OG
   *  crop can't. Same nullable lifecycle as the OG triple; best-effort, computed
   *  after it in the same publish job (see previews.ts). */
  preview_full_key: string | null
  preview_full_status: PreviewStatus | null
  preview_full_error: string | null
  /** The full-page render again, with the region map's @N refs drawn on it (see
   *  marks-script.ts) — the richest agent verify+navigate view. */
  preview_marked_key: string | null
  preview_marked_status: PreviewStatus | null
  preview_marked_error: string | null
  /** What this version SAYS, in a sentence or two, generated at publish. Every unfurl
   *  surface otherwise describes an artifact as "Markdown · 3 versions · 7 comments" —
   *  which answers "what is this?" rather than "what is it about?".
   *
   *  Null is the normal resting state, not an error: no model bound (self-host), a
   *  non-text version, or a failed generation all leave it null and every consumer falls
   *  back to that inventory line. UNTRUSTED — it is derived from document content, so it
   *  is sanitized at write and must still be escaped by any surface that interpolates it
   *  into markup. */
  summary: string | null
  /** Hash of the exact text `summary` was generated from. Exists to make the common case
   *  free: agents republish constantly and most publishes do not change what a document is
   *  about, so an unchanged hash copies the previous summary forward rather than paying a
   *  model for an identical one. */
  summary_src_hash: string | null
  created_at: string
}

export interface NewArtifact {
  id: string
  short_id: string
  org_id: string
  slug: string | null
  title: string | null
  /** The access triple. Omitted values are fail-closed at the store — `none`
   *  workspace access, `none` link, `none` listing — a caller that wants reach
   *  must say so. `publish()` always resolves and stamps them (explicit request >
   *  the org's defaults > the factory default: workspace_access `member`, link
   *  `none`, listed `none`) before `createArtifact`, so the optionality is a
   *  store-level safety net, not the product default. The orphaned `visibility` /
   *  `general_role` columns take their DB defaults and are never set here. */
  workspace_access?: WorkspaceAccess
  link_role?: LinkRole
  listed?: Listed
  /** Salted unlock-password hash locking the world link; null/omitted otherwise. */
  password_hash?: string | null
  kind: ArtifactKind
  spa: 0 | 1
  /** Expiring anonymous draft: ISO expiry instant. Omit for ordinary artifacts. */
  expires_at?: string | null
  /** Remix lineage: the artifact id this one was derived from ("use as template").
   *  Omit for ordinary artifacts; never an FK — the copy outlives its source. */
  derived_from?: string | null
}

/** Which surface created a version: the web app, the MCP publish tool, the HTTP API
 *  (agent tokens / OAuth bearers, incl. the CLI), or a historical GitHub import. */
export type VersionSource = "web" | "mcp" | "api" | "sync"

export interface NewVersion {
  id: string
  blob_key: string
  content_type: string
  size_bytes?: number
  author: string
  /** Historical import compatibility; new integrations do not set these fields. */
  author_login?: string | null
  author_avatar?: string | null
  author_gh_id?: string | null
  /** The Derive user who published this version; null/omitted for imports/anon. */
  author_id?: string | null
  /** Which surface created this version; omitted for paths that don't stamp. */
  source?: VersionSource | null
  message: string | null
  name?: string | null
}

/** One structured facts extracted from a version's source (see @derive/core
 *  data-facts). The natural key is (artifact_id, n, slot); `json` is the block's stored
 *  text, `gen` marks which extraction rules produced it. Rows are written once when a
 *  version goes live and never mutated — a version is immutable, so its facts are too. */
export interface VersionDataRecord {
  id: string
  artifact_id: string
  n: number
  slot: string
  json: string
  size_bytes: number
  gen: number
  created_at: string
}

export interface NewVersionData {
  id: string
  slot: string
  json: string
  size_bytes: number
  gen: number
}

export interface ArtifactStore {
  createArtifact(a: NewArtifact): Promise<ArtifactRecord>
  /** Change an artifact's access: workspace access (member seats vs none), the
   *  world link role, the listing, and the password hash locking the world link
   *  (null clears). See access-model.md. */
  setAccess(
    artifactId: string,
    workspaceAccess: WorkspaceAccess,
    listed: Listed,
    linkRole: LinkRole,
    passwordHash: string | null,
  ): Promise<void>
  /** Toggle the change-lock: when locked, direct publishes are rejected. */
  setLocked(artifactId: string, locked: 0 | 1): Promise<void>
  /** Owner opt-in: the anonymous public page shows version history. */
  setPublicHistory(artifactId: string, on: 0 | 1): Promise<void>
  getByShortId(shortId: string): Promise<ArtifactRecord | null>
  /** Resolve many short ids at once. Bulk operations resolved one artifact per short id in
   *  a loop; on the edge tier that is a ~80ms round trip each, up to BULK_MAX of them.
   *  Order is unspecified and unknown ids are simply absent — callers key by `short_id`. */
  getByShortIds(shortIds: string[]): Promise<ArtifactRecord[]>
  /** An artifact plus its workspace's settings, in one call. The settings are keyed on the
   *  `org_id` the artifact carries, so fetching them separately is an FK chain — not the
   *  same-key shape most batches here use, but a join answers it in one round trip all the
   *  same. Settings fall back to the parsed defaults when the workspace has no row, exactly
   *  as `getOrgSettings` does. Null artifact ⇒ null (and default settings). */
  artifactWithSettings(
    shortId: string,
  ): Promise<{ artifact: ArtifactRecord | null; settings: OrgSettings }>
  /** Load an artifact by its internal id (used by domain mode's host lookup). */
  getArtifactById(id: string): Promise<ArtifactRecord | null>
  /** Batch-load artifacts by internal id in ONE query (id ∈ ids). Order is unspecified;
   *  callers key by `id`. Empty ids ⇒ []. Use this over a per-row getArtifactById loop. */
  getArtifactsByIds(ids: string[]): Promise<ArtifactRecord[]>
  /** Appends the next version and bumps current_version. */
  addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord>
  /**
   * Replaces the current working version without changing its number.
   *
   * The compare-and-swap keys prevent a concurrent publish from being overwritten.
   * Returns null when either the version number or blob key is no longer current.
   */
  replaceCurrentVersion(
    artifactId: string,
    expected: { n: number; blobKey: string },
    v: NewVersion,
  ): Promise<VersionRecord | null>
  listVersions(artifactId: string): Promise<VersionRecord[]>
  getVersion(artifactId: string, n: number): Promise<VersionRecord | null>
  /** What an unfurl/embed card needs for one artifact: its version and comment COUNTS,
   *  its current version row, and that version's facts, in one query. The share-link
   *  SSR path computed the two counts by fetching the artifact's entire version list and
   *  entire comment list and taking `.length` — two whole-table reads for two integers, on
   *  the most-trafficked anonymous surface, plus a trip each for the version row and the
   *  slots. `facts` carries only what factSummary reads (slot + json), ordered by slot. */
  unfurlInfo(
    artifactId: string,
    versionN: number,
  ): Promise<{
    versionCount: number
    commentCount: number
    version: VersionRecord | null
    facts: { slot: string; json: string }[]
  }>
  /** Each artifact's CURRENT version, for a set of artifacts, keyed by artifact id — one
   *  query instead of a `getVersion(id, current_version)` per artifact. Workspace search
   *  grep-confirms up to 30 candidates and was fetching each one's version separately;
   *  on the edge tier that is 30 sequential ~80ms round trips inside one request, and a
   *  `Promise.all` around them cannot help (see edge-pg.ts). Artifacts with no current
   *  version are simply absent from the result. */
  currentVersions(artifactIds: string[]): Promise<Record<string, VersionRecord>>
  /** Replace a version's stored facts with `rows` (delete-then-insert, so a
   *  re-extraction is idempotent). Empty `rows` clears them. Keyed by the immutable
   *  (artifact, n); called best-effort from the version-bump chain. */
  setVersionData(artifactId: string, n: number, rows: NewVersionData[]): Promise<void>
  /**
   * Replace only the DERIVED (`$`) rows of a version, leaving asserted rows untouched.
   *
   * The two lifecycles share one table, and they have two different writers: extraction
   * and backfill write asserted rows, lazy derivation writes derived ones. Doing the
   * derived write as read-then-{@link setVersionData} would make it a read-modify-write
   * over rows another writer owns, and the interleaving is a silent data loss: the
   * backfill adds an author's fact to an old version between a lazy fill's read and its
   * write, and the lazy fill's stale union deletes it. Nothing would ever restore it,
   * because the next publish sees that fact already tracked and never re-walks.
   *
   * Scoping the delete to the `$` prefix removes the hazard by construction rather than
   * narrowing the window: the derived write cannot express "remove an asserted row", so
   * no ordering exists in which it does. This is the same predicate the rollback story
   * rests on (`DELETE FROM version_data WHERE slot LIKE '$%'`), which is not a
   * coincidence — it is what "recomputable cache in the same table" means.
   */
  setDerivedVersionData(artifactId: string, n: number, rows: NewVersionData[]): Promise<void>
  /** A version's facts: one named `slot`, or all of them (slot omitted), in slot
   *  order. Empty when the version carries none. */
  getVersionData(artifactId: string, n: number, slot?: string): Promise<VersionDataRecord[]>
  /** One slot's value across a RANGE of versions, oldest first — the trend read. ONE
   *  indexed query, never a per-version loop: a thirty-version series must cost one round
   *  trip, which is the entire point of facts. Versions in the range carrying no such slot
   *  are simply absent from the result (they predate facts, or omitted the block), so the
   *  caller reports coverage rather than inventing gaps. `limit` caps the rows returned so
   *  a thousand-version artifact can never answer with an unbounded payload. */
  getVersionDataSeries(
    artifactId: string,
    slot: string,
    from: number,
    to: number,
    limit: number,
  ): Promise<VersionDataRecord[]>
  /** One slot's CURRENT value across every artifact in a workspace that carries it — the
   *  cross-artifact read. `getVersionDataSeries` answers "how did this ONE page change over
   *  time"; this answers "where does this metric stand everywhere", which is what a
   *  workspace of nightly reports actually gets asked. Optionally narrowed by browse tag,
   *  since a tag is already how a set of artifacts is named. ONE query, joined to each
   *  artifact's current version so it can never report a superseded row. */
  /** The workspace's slot VOCABULARY as RAW (slot, artifact) rows over current versions:
   *  the discovery half of cross-artifact reads, since you cannot query a fact whose name
   *  you do not know and nothing else in the surface lists them.
   *
   *  Deliberately NOT pre-aggregated. Both slot readers scope by org, and an org is not a
   *  read permission: an artifact can be invite-only WITHIN its own workspace. The caller
   *  must therefore narrow these rows through the visibility gate (api lib/visibility.ts)
   *  before counting them. Aggregating here would hand back a count already computed over
   *  artifacts the caller may not see, with the evidence needed to correct it discarded. */
  listWorkspaceFacts(
    orgId: string,
    opts?: { limit?: number },
  ): Promise<{ slot: string; artifact_id: string; at: string }[]>
  /** Carries `id` for that same reason: the caller gates on it, then drops it. */
  listFactAcrossArtifacts(
    orgId: string,
    slot: string,
    opts?: { tag?: string; limit?: number },
  ): Promise<
    { id: string; short_id: string; title: string | null; n: number; json: string; at: string }[]
  >
  /** The BACKLINK scan: artifacts whose current version's `$links` mentions `ref`. Every
   *  index above is per artifact; this is the inversion of one, which is the shape a corpus
   *  question actually takes ("what points here"). Same join, one more predicate.
   *
   *  CANDIDATES, not answers. The `LIKE` narrows to the few rows that could contain the ref
   *  and the CALLER CONFIRMS by parsing `json` — a substring match is not proof (the same
   *  reasoning as any substring-narrowed index). The caller must then gate the
   *  rows through api lib/visibility.ts before counting or returning them: these are the
   *  LINKING artifacts, reached by content rather than by id, so the org scope is not a read
   *  permission here either.
   *
   *  Each row carries `id` to gate on, `json` to confirm with, `gen` so the caller can say
   *  the index is older than the deriver, and `at` = the CURRENT VERSION's publish time.
   *  Never version_data.created_at: a lazily derived row's timestamp is when the host got
   *  round to indexing, not when the link was made. */
  listArtifactsLinkingTo(
    orgId: string,
    ref: string,
    opts?: { tag?: string; limit?: number },
  ): Promise<
    {
      id: string
      short_id: string
      title: string | null
      current_content_type: string | null
      n: number
      json: string
      gen: number
      at: string
    }[]
  >
  /** Correct a version's stored content_type in place (no new version). Also
   *  updates the artifact's current_content_type when n is the current version.
   *  Used to repair mis-classified content (e.g. HTML that was tagged markdown). */
  reclassifyVersion(artifactId: string, n: number, contentType: string): Promise<void>
  /** Set a version's preview render result (blob key + status + error). Partial;
   *  only given fields are written. */
  setVersionPreview(
    artifactId: string,
    n: number,
    fields: {
      preview_key?: string | null
      preview_status?: PreviewStatus | null
      preview_error?: string | null
    },
  ): Promise<void>
  /** Set a version's generated summary and the hash of the text it came from. Partial;
   *  only given fields are written. Separate from `setVersionPreview` for the same reason
   *  the render variants are: both are best-effort derived content on the same row, and
   *  one failing must never overwrite the other. */
  setVersionSummary(
    artifactId: string,
    n: number,
    fields: { summary?: string | null; summary_src_hash?: string | null },
  ): Promise<void>
  /** Set the full-page or marked-render variant's result (blob key + status + error).
   *  Partial; only given fields are written. Separate from `setVersionPreview` (the
   *  OG crop) because these two variants are best-effort and written independently —
   *  one failing must never block or overwrite the other, or the OG image unfurls
   *  already depend on. */
  setVersionPreviewVariant(
    artifactId: string,
    n: number,
    variant: "full" | "marked",
    fields: {
      key?: string | null
      status?: PreviewStatus | null
      error?: string | null
    },
  ): Promise<void>
  // ---- Render-job queue (screenshot rendering outbox) --------------------
  /** Enqueue a new render job (status defaults to "pending", attempts to 0). */
  enqueueRenderJob(j: NewRenderJob): Promise<void>
  /**
   * Atomically claim up to `limit` pending render jobs whose next_attempt_at has
   * passed: increments their attempt count and leases them (sets next_attempt_at
   * to `leaseUntil`), then returns the claimed rows.
   */
  claimDueRenderJobs(now: string, limit: number, leaseUntil: string): Promise<RenderJobRecord[]>
  /**
   * Up to `limit` live artifacts whose CURRENT version has never been rendered
   * (preview_status is null) and has no pending render job. Feeds the self-heal
   * sweep: publishes that predate the render pipeline — or that slipped past the
   * enqueue (a crashed request, a code path that missed notifyRender) — get their
   * screenshot on the next tick instead of never. Versions that already ran and
   * failed ("failed"/dead-lettered) are excluded: they had their retries.
   */
  versionsMissingPreview(limit: number): Promise<Array<{ artifact_id: string; n: number }>>
  updateRenderJob(
    id: string,
    fields: {
      status: RenderJobStatus
      attempts: number
      last_error: string | null
      next_attempt_at: string
    },
  ): Promise<void>
}

export interface CommentStore {
  createComment(c: NewComment): Promise<CommentRecord>
  /** Comments on an artifact, oldest-first; optionally filtered by thread state. */
  listComments(artifactId: string, opts?: CommentListOpts): Promise<CommentRecord[]>
  /** The comment rail's whole payload: an artifact's comments AND the version their
   *  anchors are re-checked against, in one call. Both are keyed on the same artifact,
   *  so on the edge tier issuing them separately paid two ~80ms round trips for one
   *  panel. `version` is null when the artifact has no such version yet. */
  commentsPage(
    artifactId: string,
    versionN: number,
    opts?: CommentListOpts,
  ): Promise<{ comments: CommentRecord[]; version: VersionRecord | null }>
  getComment(id: string): Promise<CommentRecord | null>
  /** Patch a single comment's body, meta (reactions, edited, deleted), and/or
   *  anchor (the re-anchor sweep self-heals an element anchor it recovered across
   *  versions by rewriting the root comment's selector). */
  updateComment(
    id: string,
    fields: { body_md?: string; meta?: string | null; anchor?: string | null },
  ): Promise<CommentRecord | null>
  /** Flips every comment in a thread to a state; returns the count updated. */
  setThreadState(artifactId: string, threadId: string, state: CommentState): Promise<number>
  /** Hard-remove an entire comment thread and everything keyed to it — its comments,
   *  notifications, agent mentions, and Slack link. Called when a delete leaves the
   *  thread with no surviving comment, so no "Comment deleted" ghost (nor its orphaned
   *  document highlight or dangling notification) is left behind. */
  deleteThread(artifactId: string, threadId: string): Promise<void>
  /** Per-artifact comment signals for `userId` over a set of artifact ids, in one
   *  query: open-thread count plus whether the viewer is tagged in or has authored an
   *  open thread (drives the "needs your feedback" featuring). A null userId gets
   *  counts only. */
  commentSignals(
    artifactIds: string[],
    userId: string | null,
  ): Promise<Record<string, CommentSignals>>
  /** Artifact ids in `orgId` with an open thread the user is tagged in or authored —
   *  the "needs your feedback" set the home section is built from. */
  artifactIdsNeedingFeedback(userId: string, orgId: string): Promise<string[]>
  /** DISTINCT author ids on an artifact's comments. The @mention directory needs only this,
   *  and was reading every comment ROW — bodies and all — to collect them. */
  commentAuthorIds(artifactId: string): Promise<string[]>
}

export interface ArtifactQueryStore {
  /**
   * Newest-first artifact page. `cursor` is keyset pagination on created_at
   * (rows strictly older than it); `q` is a case-insensitive metadata search across
   * artifact titles, tags, and collection titles visible to `collectionSearchViewerId`;
   * `ids` restricts to a set (tag / favorite filters resolve to ids) — an empty
   * `ids` array matches nothing.
   */
  listArtifacts(opts?: ListArtifactsOpts): Promise<ArtifactRecord[]>
  /**
   * Everything the artifact DETAIL response needs about one artifact, in ONE store call:
   * its versions, tags, the collections it sits in, its open-thread count,
   * whether the viewer has favorited it, and its workspace's settings. Same motivation
   * as `listEnrichment` — these were seven
   * sequential ~80ms round trips on the edge tier, all keyed on the same artifact (or its
   * org). `viewerId` null skips the favorite check (anonymous readers can't have one).
   *
   * `favorite` is answered as a boolean about THIS artifact rather than by fetching the
   * user's whole favorite list and calling `.includes()`.
   */
  artifactDetail(opts: ArtifactDetailOpts): Promise<ArtifactDetail>
  /**
   * Everything the library list decorates a page of rows with, in ONE store call:
   * view counts, tags, preview readiness, author handle + byline directory rows,
   * the viewer's comment signals, and the viewer's per-artifact
   * share roles. Each piece is a trivial lookup keyed on the same page of ids, but on
   * the edge tier a Postgres round trip costs ~80ms no matter how little it fetches
   * (one serialized `pg.Client` per invocation — see edge-pg.ts), so issuing them as
   * seven separate calls made every listing pay seven trips for one page. Postgres
   * answers this in a single round trip; the embedded drivers compose it from the
   * individual queries (their round trips are free). Gates mirror the list route's:
   * `views` only when analytics is on, a null `viewerId` skips signals (anon listing),
   * a null `memberId` skips share roles.
   */
  listEnrichment(opts: ListEnrichmentOpts): Promise<ListEnrichment>
  /** Full-text search index over an artifact's current visible text (+ title), keyed by
   *  id and scoped by org — the substrate that lifts workspace search past a live-grep of
   *  the N most-recent artifacts to the whole corpus. `indexArtifact` upserts (call on every
   *  publish/move with the new current text); `unindexArtifact` drops it (on delete).
   *  `searchArtifactIds` returns the best-matching ids in ONE org, ranked (higher = more
   *  relevant, dialect-normalized), with NO visibility filter — the caller re-applies
   *  visibility via `listArtifacts({ ids })` so that rule lives in exactly one place. */
  indexArtifact(id: string, orgId: string, title: string | null, text: string): Promise<void>
  unindexArtifact(id: string): Promise<void>
  searchArtifactIds(
    orgId: string,
    query: string,
    limit: number,
  ): Promise<{ id: string; rank: number }[]>
  /** Artifact ids carrying a tag (server-side tag filtering). */
  artifactIdsByTag(tag: string): Promise<string[]>
  /** Artifact ids in a workspace whose current author_login matches `login`
   *  (case-insensitive) — the author list-filter. Empty when nothing matches. */
  artifactIdsByAuthor(orgId: string, login: string): Promise<string[]>
  /** Artifact ids in a workspace this user holds an OWNER member row on — the
   *  library's "Created by me" filter, any visibility. Keyed on the roster (one
   *  row, written at creation for the human behind the publish), NOT the
   *  `author_id` denorm: every republish rewrites that to the newest version's
   *  author — null for a token publish — so it can't anchor "yours". */
  artifactIdsOwnedBy(orgId: string, userId: string): Promise<string[]>
  /** Total artifact count, scoped to a workspace when orgId is given. */
  countArtifacts(orgId?: string): Promise<number>
  /** Count on the reversible archive shelf in one workspace. */
  countArchivedArtifacts(orgId: string): Promise<number>
  /** Count of the artifacts `artifactIdsOwnedBy` would return — the "Created by
   *  me" badge. `listed` narrows to one discovery state (e.g. `none` = the
   *  not-in-any-feed pending count). */
  countOwnedBy(orgId: string, userId: string, listed?: Listed): Promise<number>
  /**
   * The storage-quota meter for one workspace: bytes counted once per distinct
   * blob (content is content-addressed, so republishes/restores of identical
   * bytes don't double-count), scoped to the given org.
   */
  storageBytes(orgId: string): Promise<number>
  /** Tag → usage count, scoped to a workspace when orgId is given (browse sidebar). */
  tagCounts(orgId?: string): Promise<{ tag: string; count: number }[]>
  /**
   * The browse sidebar's whole summary for one workspace, in ONE store call: total
   * artifacts, tag→count, the workspace's name, and — for a signed-in caller — their
   * favorite count, owned count, and not-yet-surfaced owned count. Six calls all keyed
   * on the same org (or org+user), which on the edge tier was six ~80ms round trips to
   * render one sidebar. `userId` null ⇒ the three per-user counts come back 0.
   *
   * `favorites` is a COUNT: the route it replaces fetched the user's whole favorite id
   * list and used only `.length`.
   */
  workspaceSummary(orgId: string, userId: string | null): Promise<WorkspaceSummary>
  /** The signed-in boot read: everything the app shell asks for in its first breath —
   *  sidebar summary, collections + the caller's collection roles,
   *  workspace settings, and the notifications page — as ONE store call, so the
   *  hosted tier answers it in one Postgres round trip instead of four requests'
   *  worth of sequential reads. Embedded drivers compose it from the underlying
   *  methods (composeBootstrap): they pay no wire trips, so parity here is the
   *  SHAPE, not the statement count. Deliberately excludes /v1/me/onboarding
   *  (its grants read is try/catch-optional and must not poison the batch). */
  bootstrap(
    orgId: string,
    userId: string,
    notifLimit: number,
    viewer: Omit<CollectionsViewer, "userId">,
  ): Promise<BootstrapRead>

  /** Append a view event. */
  recordView(v: NewView): Promise<void>
  /** Promote this viewer's view to a confirmed read, if it landed before
   *  `viewedBeforeIso`. Idempotent: at most one read per (artifact, viewer), and a
   *  no-op when they have no view row yet. Driven by the presence heartbeat, so
   *  surviving the delay is what separates a reader from a one-shot fetch. */
  confirmRead(artifactId: string, viewer: string, viewedBeforeIso: string): Promise<void>
  /** Has this viewer already seen this version since `sinceIso`? (open de-dup) */
  viewedSince(
    artifactId: string,
    viewer: string,
    version: number,
    sinceIso: string,
  ): Promise<boolean>
  /** Delete view rows older than `cutoffIso`; returns the count removed (retention). */
  pruneViews(cutoffIso: string): Promise<number>
  /** Reap abandoned anonymous OAuth clients: registered without a user, never
   *  consented, holding no tokens, older than the cutoff. Caps open-DCR spam. */
  pruneStaleOAuthClients(cutoffIso: string): Promise<number>
  /** Delete user-kind view rows whose viewer is in the set (owner self-view cleanup). */
  pruneViewsByViewers(viewers: string[]): Promise<number>
  /** Aggregated view analytics for one artifact. */
  viewStats(artifactId: string): Promise<ViewStats>
  /** Total view counts for many artifacts at once (no N+1). */
  viewCounts(artifactIds: string[]): Promise<Record<string, number>>
  /** For each artifact id, true iff its CURRENT version has a ready preview render.
   *  Batched (one query); missing ids may be omitted. */
  previewReady(artifactIds: string[]): Promise<Record<string, boolean>>
}

export interface WebhookStore {
  // ---- Webhooks + outbox -------------------------------------------------
  createWebhook(w: NewWebhook): Promise<WebhookRecord>
  listWebhooks(orgId: string): Promise<WebhookRecord[]>
  getWebhook(id: string, orgId: string): Promise<WebhookRecord | null>
  deleteWebhook(id: string, orgId: string): Promise<void>
  /** Active webhooks for this artifact's workspace (incl. that workspace's global,
   *  artifact_id null, hooks). Scoped by org so a hook never fires for another tenant. */
  activeWebhooks(artifactId: string, orgId: string): Promise<WebhookRecord[]>
  /** Enqueue a delivery into the outbox (target is denormalized for durability). */
  enqueueDelivery(d: NewDelivery): Promise<void>
  /** Insert a delivery, or replace its payload only while the same id is still pending. */
  enqueueCoalescedDelivery(d: NewDelivery): Promise<void>
  /** Enqueue the whole subscriber fan-out for one event in ONE insert. Empty ⇒ no-op.
   *  Use over a per-subscriber enqueueDelivery loop. */
  enqueueDeliveries(rows: NewDelivery[]): Promise<void>
  /**
   * Atomically claim up to `limit` pending deliveries whose next_attempt_at has
   * passed: increments their attempt count and leases them (sets next_attempt_at
   * to `leaseUntil`, hiding them from other workers until the lease expires), then
   * returns the claimed rows. Postgres uses `FOR UPDATE SKIP LOCKED` so concurrent
   * instances never grab the same row — without this the outbox double-delivers
   * under the multi-instance topology. A crash mid-delivery is recovered when the
   * lease lapses; a persistently-crashing (poison) delivery dead-letters because
   * each claim still counts an attempt.
   */
  claimDueDeliveries(now: string, limit: number, leaseUntil: string): Promise<DeliveryRecord[]>
  updateDelivery(
    id: string,
    fields: {
      status: DeliveryStatus
      attempts: number
      last_error: string | null
      next_attempt_at: string
    },
  ): Promise<void>
  /** Recent deliveries for a webhook (for the settings log). */
  recentDeliveries(webhookId: string, limit: number): Promise<DeliveryRecord[]>
}

export interface WorkspaceStore {
  // ---- Permissions: workspace membership + per-artifact shares -----------
  /** The workspace's display name + metadata (one row per org_id). */
  getWorkspace(orgId: string): Promise<WorkspaceRecord | null>
  /** Insert or rename the workspace. */
  setWorkspace(orgId: string, name: string): Promise<WorkspaceRecord>
  /** Delete the workspace row + all its memberships. The caller guarantees it is
   *  empty (no artifacts) — this does not cascade artifacts/blobs. */
  deleteWorkspace(orgId: string): Promise<void>
  /** Every workspace a user belongs to, with their role, oldest first (the switcher). */
  listWorkspaces(userId: string): Promise<(WorkspaceRecord & { role: Role })[]>
  /** listWorkspaces(userId) + getOAuthClientWorkspaces(userId, clientId) as ONE round
   *  trip — `bound` is already a subset of `mine` (a LEFT JOIN on the Postgres driver, so
   *  a workspace the grant names but the user has since left never appears). Empty
   *  clientId ⇒ bound is always []. The oauth-agent default-workspace resolution is the
   *  only caller — reach for listWorkspaces / getOAuthClientWorkspaces directly elsewhere. */
  workspacesAndOauthBinding(
    userId: string,
    clientId: string,
  ): Promise<{ mine: (WorkspaceRecord & { role: Role })[]; bound: string[] }>
  getMembership(orgId: string, userId: string): Promise<MembershipRecord | null>
  listMemberships(orgId: string): Promise<MembershipRecord[]>
  /** Every membership across a set of orgs in ONE query (org_id ∈ orgIds); callers group
   *  by `org_id`. Empty orgIds ⇒ []. Use this over a per-org listMemberships loop. */
  listMembershipsForOrgs(orgIds: string[]): Promise<MembershipRecord[]>
  countMemberships(orgId: string): Promise<number>
  /** Insert or update a member's workspace role. */
  setMembership(m: NewMembership): Promise<MembershipRecord>
  /** Owned resources that would have no remaining workspace member able to
   *  own them if this membership were removed. Used to make offboarding fail safe
   *  instead of silently marooning workspace-bound ownership. */
  workspaceOwnershipBlockers(
    orgId: string,
    userId: string,
  ): Promise<{ artifacts: number; collections: number }>
  /** Remove a member from the workspace. */
  removeMembership(orgId: string, userId: string): Promise<void>

  getArtifactMember(artifactId: string, userId: string): Promise<ArtifactMemberRecord | null>
  listArtifactMembers(artifactId: string): Promise<ArtifactMemberRecord[]>
  /** Artifact ids explicitly shared with a user at a portable collaborator role
   *  (viewer/commenter/editor) — the "Shared with you" set; can span workspaces.
   *  Owner rows are workspace-bound ownership, not shares, and are excluded. */
  artifactIdsSharedWith(userId: string): Promise<string[]>
  /** Insert or update a per-artifact role override (a share). */
  setArtifactMember(m: NewArtifactMember): Promise<ArtifactMemberRecord>
  removeArtifactMember(artifactId: string, userId: string): Promise<void>
}

export interface SocialStore {
  // ---- Favorites (per-user stars) + tags (browse metadata) ---------------
  /** Artifact ids this user has starred. With `orgId`, scoped to that workspace's
   *  live (non-removed) artifacts — for the workspace-scoped favorites count. */
  listUserFavoriteIds(userId: string, orgId?: string): Promise<string[]>
  setFavorite(artifactId: string, userId: string): Promise<void>
  removeFavorite(artifactId: string, userId: string): Promise<void>
  /** Collections this user starred — org-scoped so a star does not survive a workspace
   *  switch. The rail renders these beside starred artifacts as ONE list. */
  listUserFavoriteCollectionIds(userId: string, orgId?: string): Promise<string[]>
  setCollectionFavorite(collectionId: string, userId: string): Promise<void>
  removeCollectionFavorite(collectionId: string, userId: string): Promise<void>
  /** Collections this user has WORKED IN since `sinceIso` — derived from acts that
   *  already leave a row: a version they authored, a comment they wrote, or a membership
   *  they were granted. Reading is deliberately not among them; nothing records it, and
   *  a per-user read log is a different decision from this one. Org-scoped. */
  collectionsWorkedIn(
    userId: string,
    orgId: string,
    sinceIso: string,
  ): Promise<{ id: string; at: string }[]>
  /** The most recently updated artifacts in each of these collections — the filmstrip
   *  the Collections view renders. Capped per collection: this is a preview strip, not a
   *  listing, so a 200-artifact shelf costs the same as a 3-artifact one. */
  collectionPreviews(
    collectionIds: string[],
    perCollection: number,
  ): Promise<Record<string, CollectionPreview[]>>

  // ---- Follows (per-user: track people) -------------------------------
  /** Record a follow (idempotent on (user, org, kind, target)); returns the row. */
  addFollow(f: NewFollow): Promise<FollowRecord>
  removeFollow(userId: string, orgId: string, kind: FollowKind, target: string): Promise<void>
  /** A user's global people follows, newest first. */
  listFollows(userId: string, orgId: string): Promise<FollowRecord[]>
  /** Artifact ids (not removed) surfaced by this user's follows — the activity feed.
   *  People follows match a followed person's PUBLIC work in any workspace. Following
   *  someone never exposes their private cross-workspace work. */
  followedArtifactIds(userId: string, orgId: string): Promise<string[]>
  /** How many people follow this user (kind='user', target=userId). */
  countFollowers(userId: string): Promise<number>
  /** How many people this user follows (kind='user', user_id=userId). */
  countFollowing(userId: string): Promise<number>
  /** People who follow this user, as public profiles, newest follow first. */
  listFollowers(userId: string, limit: number): Promise<UserProfile[]>
  /** People this user follows, as public profiles, newest follow first. */
  listFollowing(userId: string, limit: number): Promise<UserProfile[]>
  /** Tags per artifact, batched (no N+1). Missing ids map to no entry. */
  tagsForArtifacts(artifactIds: string[]): Promise<Record<string, string[]>>
  /** Collection ids per artifact, in ONE query (artifact_id ∈ ids) — the batched face of
   *  `collectionIdsForArtifact`, for a whole listing page. Ids in no collection are
   *  absent. Empty ids ⇒ {}. */
  collectionsForArtifacts(artifactIds: string[]): Promise<Record<string, string[]>>
  /** The user's per-artifact share roles across a page of artifacts, one query —
   *  lets a listing fold shares into `my_role` without a per-row member lookup. */
  artifactRolesFor(userId: string, artifactIds: string[]): Promise<Record<string, Role>>
  /** Replace an artifact's full tag set (deduped, trimmed, lowercased upstream). */
  setArtifactTags(artifactId: string, tags: string[]): Promise<void>
}

export interface CollectionStore {
  // ---- Collections (shareable groups; a member's role propagates to items) -
  createCollection(c: NewCollection): Promise<CollectionRecord>
  getCollection(id: string): Promise<CollectionRecord | null>
  /** Batch-load collections by id in ONE query (id ∈ ids); callers key by `id`. Empty
   *  ids ⇒ []. Use this over a per-id getCollection loop. */
  getCollections(ids: string[]): Promise<CollectionRecord[]>
  updateCollection(id: string, fields: { title?: string }): Promise<CollectionRecord | null>
  /** Change a collection's share experience (see CollectionRecord.workspace_access). */
  setCollectionAccess(
    id: string,
    workspaceAccess: WorkspaceAccess,
    linkRole?: LinkRole,
    passwordHash?: string | null,
  ): Promise<void>
  /** Remove a collection and its items + member rows. */
  deleteCollection(id: string): Promise<void>
  /** Collections with their item counts, newest first; scoped to a workspace when orgId is given. */
  listCollections(orgId?: string): Promise<(CollectionRecord & { count: number })[]>
  /** The collection list and its per-user decoration in one read. Pass `viewer` for
   *  the Collections view's stars, the
   *  worked-in set, and each shelf's preview strip — rides the same statement. Those are
   *  three more reads a route must NOT make separately: on the edge tier each is ~80ms
   *  (see apps/api/test/round-trip-budget.test.ts). Omit it and the per-user fields come
   *  back empty. */
  collectionsOverview(orgId: string, viewer?: CollectionsViewer): Promise<CollectionsOverviewRead>
  /** Artifact ids in a collection (drives ?collection= browse). */
  collectionArtifactIds(collectionId: string): Promise<string[]>
  /** Collection ids containing an artifact (for the artifact's "add to" UI). */
  collectionIdsForArtifact(artifactId: string): Promise<string[]>
  /** Collections containing an artifact, in one join. Authorization uses their
   *  already-gated world links as inherited grants on the artifact. */
  collectionsForArtifact(artifactId: string): Promise<CollectionRecord[]>
  addCollectionItem(collectionId: string, artifactId: string): Promise<void>
  removeCollectionItem(collectionId: string, artifactId: string): Promise<void>
  getCollectionMember(collectionId: string, userId: string): Promise<CollectionMemberRecord | null>
  listCollectionMembers(collectionId: string): Promise<CollectionMemberRecord[]>
  /** Explicit member-row counts for a set of collections in ONE query (id ∈ ids);
   *  ids with no member rows are absent from the map. Empty ids ⇒ {}. Drives the
   *  share dialog's collection-disclosure rows ("n collection members"). */
  collectionMemberCounts(collectionIds: string[]): Promise<Record<string, number>>
  /** One user's role per collection over a set of collections (explicit member rows
   *  + the workspace seat on workspace-open collections, higher wins) — the batched
   *  face of context.ts's collectionRole for artifact disclosure rows. Set
   *  `includeWorkspaceSeats` false outside the active workspace. The caller still
   *  folds in created_by (workspace-bound owner) and the static token. Ids with no
   *  role are absent. */
  collectionRolesForUser(
    collectionIds: string[],
    userId: string,
    opts?: { includeWorkspaceSeats?: boolean },
  ): Promise<Record<string, Role>>
  setCollectionMember(m: NewCollectionMember): Promise<CollectionMemberRecord>
  removeCollectionMember(collectionId: string, userId: string): Promise<void>
  /** This user's collection roles over collections containing the artifact — folded
   *  into their effective artifact role. Set `includeWorkspaceSeats` false when the
   *  artifact's workspace is not active: only portable explicit collection shares
   *  are returned; workspace-open collection seats are workspace-bound. */
  collectionRolesForArtifact(
    artifactId: string,
    userId: string,
    opts?: { includeWorkspaceSeats?: boolean },
  ): Promise<Role[]>

  /**
   * OPTIONAL FAST PATH: every grant one user holds over one artifact, in ONE round trip.
   *
   * Narrowing a principal to an Actor needs the workspace membership, the per-artifact share and
   * the collection shares — `getMembership` + `getArtifactMember` +
   * `collectionRolesForArtifact` — and that last one is itself two queries. Four round trips to
   * decide one boolean, on every authorize.
   *
   * Affordable when the database is local, ruinous when it is a region away: on the hosted edge
   * each trip measured ~100-900ms, and one chat request spent most of a second on permission
   * rows alone. A store that can answer this in a single statement implements it; one that
   * cannot omits it and context.ts falls back to the four calls, so implementing it is always
   * optional.
   *
   * It never changes the ANSWER. `can()` remains the only place a decision is made; this only
   * changes how its inputs arrive. Returns exactly what the four calls would: the org role (null
   * when not a member), every artifact-level role, and the portable subset (explicit non-owner
   * artifact/collection shares, with seats and owners removed). Both role arrays are unreduced,
   * so the caller folds them with maxRole as before.
   */
  artifactGrants?(
    artifactId: string,
    orgId: string,
    userId: string,
  ): Promise<{ orgRole: Role | null; artifactRoles: Role[]; portableArtifactRoles: Role[] }>

  /**
   * `getByShortId` + `artifactGrants`, keyed on the SHORT ID, in one statement.
   *
   * The same optional-fast-path contract as `artifactGrants`, one level up. The document
   * open is gated on GET /v1/artifacts/:shortId — measured on the preview at 457ms of a
   * 481ms open, essentially the whole journey — and it opened with two strictly serial
   * reads: fetch the artifact to learn its id and org, then fetch the caller's grants on
   * it. The second cannot start until the first lands, so on the edge tier that ordering
   * costs a full ~80ms round trip, every open.
   *
   * Resolving the artifact INSIDE the grants query removes the dependency. Null when no
   * artifact has that short id. It never changes the answer: `can()` is still the only
   * place a decision is made, and the store contract runs this against the read-by-read
   * path over the same fixtures and requires them to agree.
   */
  /**
   * `listArtifacts` + `listEnrichment` in one statement, for a store that can.
   *
   * The two are strictly serial — the decoration keys on the ids the list returns — so on
   * the edge tier they cost two round trips for one page. This request is the cold boot's
   * critical path (measured 389ms, first card 566ms right behind it), which is what makes
   * the second trip worth removing.
   *
   * Optional, like the other fast paths: a store without it takes the two calls unchanged,
   * and the embedded drivers deliberately do (a local round trip costs nothing). The pg
   * implementation inlines the SAME list-query builder `listArtifacts` runs, so the
   * visibility predicate is reused rather than restated, and the store contract requires
   * this to agree with the read-by-read pair over the same fixtures.
   */
  listPage?(
    opts: ListPageOpts,
  ): Promise<{ artifacts: ArtifactRecord[]; enrichment: ListEnrichment }>

  /**
   * The workspace row, its membership roster, and the user directory for that roster —
   * one statement, for a store that can.
   *
   * GET /v1/workspace was four round trips (measured 447ms), three of them keyed on the
   * same org, and the last strictly after the others because it needs the member ids the
   * roster returns. It is the Settings > Members page's entire cost.
   *
   * The `users` arm is best-effort in the same way the list's byline arm is: the Better
   * Auth tables can be absent on a fresh self-host, and there the roster must still come
   * back rather than fail the page.
   */
  /**
   * How many ids this store will take in one `ids:` filter.
   *
   * The shared visibility gate chunks its candidate list to stay inside a dialect's
   * parameter cap, and it had no way to ask — so it used the SMALLEST cap any driver has
   * (D1 binds each id separately and caps a statement at 100). Postgres binds an array as
   * ONE parameter and tops out at 65535, so it was splitting a 200-candidate search into
   * three sequential round trips to respect a limit it does not have.
   *
   * Absent means "assume the conservative default" — so a driver that says nothing keeps
   * exactly the old behaviour.
   *
   * A METHOD, not a plain property, and that is load-bearing. Wrappers around this port
   * assume every member is an async method — the pg test store is a Proxy whose get trap
   * returns a function for ANY key — so a number-valued property comes back as a function
   * instead. That is not a type error anywhere; it made the chunk size NaN, `slice(0, NaN)`
   * empty, and workspace search return "no matches" on Postgres only. Callers must still
   * validate what they get back rather than trust the shape.
   */
  idsPerQuery?(): Promise<number> | number

  workspaceWithMembers?(orgId: string): Promise<{
    workspace: WorkspaceRecord | null
    members: MembershipRecord[]
    users: UserDir[]
  }>

  artifactWithGrants?(
    shortId: string,
    userId: string,
  ): Promise<{
    artifact: ArtifactRecord
    orgRole: Role | null
    artifactRoles: Role[]
    portableArtifactRoles: Role[]
  } | null>

  // ---- Folders (organize a collection's artifacts; inherit its access, grant nothing) --
  createFolder(f: NewFolder): Promise<FolderRecord>
  /** The folders belonging to a collection. Name order is a view concern. */
  listFolders(collectionId: string): Promise<FolderRecord[]>
  getFolder(id: string): Promise<FolderRecord | null>
  updateFolder(id: string, fields: { name?: string }): Promise<FolderRecord | null>
  /** Delete a folder and un-file its items within the collection (collection_item.folder_id
   *  → null) — the artifacts stay in the collection. */
  deleteFolder(id: string): Promise<void>
  /** File an artifact (within a collection) under a folder, or null to unfile. Scoped to
   *  the membership row, so the same artifact can sit in different folders per collection. */
  setItemFolder(collectionId: string, artifactId: string, folderId: string | null): Promise<void>
  /** Map of artifact SHORT-ID → folder_id for a collection's FILED items (unfiled ones
   *  absent). Keyed by short_id so the web (which works in short_ids) can group directly. */
  collectionItemFolders(collectionId: string): Promise<Record<string, string>>
}

export interface IntegrationStore {
  // ---- GitHub App (instance credentials + per-workspace installations) -----
  /** The instance's GitHub App credentials, or null before the manifest setup. */
  getGithubApp(): Promise<GitHubAppRecord | null>
  /** Upsert the single instance App row (id = "default"). */
  setGithubApp(a: GitHubAppRecord): Promise<void>
  /** Record (or refresh) a workspace's App installation. */
  upsertGithubInstallation(i: GitHubInstallationRecord): Promise<GitHubInstallationRecord>
  getGithubInstallation(installationId: string): Promise<GitHubInstallationRecord | null>
  /** A workspace's installations, newest first. */
  listGithubInstallations(orgId: string): Promise<GitHubInstallationRecord[]>
  // ---- Workspace integration settings (enable/disable each channel) --------
  /** The workspace's integration preferences, merged over defaults (so a workspace
   *  that never saved any returns all-enabled). */
  getOrgSettings(orgId: string): Promise<OrgSettings>
  /** getOrgSettings(orgId) + getUserBrandprint(userId) as ONE round trip — the pg driver
   *  batches (a UNION ALL, falling back to settings-alone on an older user table with no
   *  brandprint column); embedded composes. userId null ⇒ personalBrandprint always null
   *  (that read is skipped entirely). resolveActorBrandprint (MCP connect, context
   *  runner, rework endpoint) is the only caller. */
  orgContext(
    orgId: string,
    userId: string | null,
  ): Promise<{ settings: OrgSettings; personalBrandprint: string | null }>
  /** Persist the workspace's integration preferences (full object; upsert by org). */
  setOrgSettings(orgId: string, settings: OrgSettings): Promise<void>
  /** Persist settings only when the stored settings revision still matches. The compare and
   *  write are atomic; callers retry from a fresh read when false. This is the write primitive
   *  for deploy-wide settings whose operators may act concurrently. */
  setOrgSettingsIfRevision(
    orgId: string,
    expectedRevision: number,
    settings: OrgSettings,
  ): Promise<boolean>
  /** The workspace's cached Stripe subscription, absent ⇒ null (free). */
  getSubscription(orgId: string): Promise<SubscriptionRecord | null>
  /** Webhook resolution fallback when metadata.org_id is missing. */
  getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<SubscriptionRecord | null>
  upsertSubscription(s: SubscriptionRecord): Promise<void>
  // ---- Slack App (connected workspace + thread links) ---------------------
  /** The Slack workspace connected to this Derive workspace, or null. */
  getSlackInstall(orgId: string): Promise<SlackInstallRecord | null>
  /** Upsert (connect / reconnect) the Slack install for a workspace. */
  setSlackInstall(s: SlackInstallRecord): Promise<void>
  /** Every install for a Slack team. Inbound Slack events identify the workspace by `team_id`
   *  only (never our org id), so the install-lifecycle handler needs this direction; a plural
   *  return because two Derive workspaces may connect the same Slack team. Unindexed scan —
   *  one row per workspace, and this runs only on app_uninstalled / tokens_revoked. */
  listSlackInstallsByTeam(teamId: string): Promise<SlackInstallRecord[]>
  /** Disconnect Slack for a workspace. */
  deleteSlackInstall(orgId: string): Promise<void>
  // ---- Slack channel subscriptions ---------------------------------------
  /** Every subscription for a workspace, newest first. */
  listSlackSubscriptions(orgId: string): Promise<SlackSubscriptionRecord[]>
  /** Create a subscription, or update the existing one for the same (org, channel, scope). */
  upsertSlackSubscription(sub: NewSlackSubscription): Promise<SlackSubscriptionRecord>
  /** Partial update, org-scoped so a caller can't reach across tenants. Null on no match. */
  updateSlackSubscription(
    id: string,
    orgId: string,
    fields: {
      events?: string
      authors?: SlackAuthorFilter
      active?: 0 | 1
      channel_name?: string | null
    },
  ): Promise<SlackSubscriptionRecord | null>
  /** Remove a subscription, org-scoped. */
  deleteSlackSubscription(id: string, orgId: string): Promise<void>
  /** Remove every subscription pointing at a channel (used by `/derive unsubscribe`). */
  deleteSlackSubscriptionsByChannel(orgId: string, channelId: string): Promise<void>
  // ---- Per-user model-plan credentials -----------------------------------
  /** A user's own model credential for a provider (encrypted `secret`), or null. */
  getModelCredential(
    orgId: string,
    userId: string,
    provider: string,
  ): Promise<ModelCredentialRecord | null>
  /** Upsert a user's model credential (keyed org+user+provider). */
  setModelCredential(c: ModelCredentialRecord): Promise<void>
  /** Remove a user's model credential for a provider. */
  deleteModelCredential(orgId: string, userId: string, provider: string): Promise<void>
  /** A user's connected credentials (all providers) — for the settings hint list. */
  listModelCredentials(orgId: string, userId: string): Promise<ModelCredentialRecord[]>
  /** The Slack message a Derive thread is mirrored to (for threading replies), or null. */
  /** The Slack message mirroring a Derive thread INTO one channel, or null. A thread mirrors
   *  into every channel subscribed to its artifact, so the channel is part of the key. */
  getSlackThreadLink(threadId: string, channel: string): Promise<SlackThreadLinkRecord | null>
  /** Every channel a Derive thread has been mirrored into. No production caller today — the
   *  senders and the interactivity handler all resolve a specific (thread, channel) — but it is
   *  what the contract tests and the fan-out tests assert against, and the natural query for
   *  anything that needs to show or clean up a thread's mirrors. */
  listSlackThreadLinksByThread(threadId: string): Promise<SlackThreadLinkRecord[]>
  /** The Derive thread a Slack message maps to (for reply-back), or null. */
  getSlackThreadLinkByTs(channel: string, ts: string): Promise<SlackThreadLinkRecord | null>
  /** Record the Slack message ↔ Derive thread mapping (idempotent on thread_id). */
  setSlackThreadLink(l: SlackThreadLinkRecord): Promise<void>
  /**
   * Resolve a Slack user (team + user id) to the Derive user who linked it, or null.
   *
   * NEVER returns a `miss` row. Every caller of this treats a non-null result as a real
   * Derive user — one of them DMs `user_id` directly — so a miss leaking through here would
   * be a message sent to an id that does not exist. Ask `getSlackIdentityState` when you
   * actually want to know whether we have looked before.
   *
   * IT RETURNS BOTH `oauth` AND `email` ROWS, and every Slack-originated authority in the
   * product rests on that. Worth stating plainly, because the two are not the same claim: an
   * `oauth` row means somebody completed Slack sign-in and proved control of the Derive
   * account; an `email` row means their Slack profile address matched a member (lib/
   * slack-mention.ts, which introduced it so that answering in Slack would not require a
   * detour through Settings).
   *
   * The accepted policy is that BOTH are identities, workspace-wide. It is not an accident of
   * this filter, and code should not quietly assume otherwise. Membership and role are checked
   * separately in every case, so resolving an identity grants nothing on its own — a matched
   * email with no seat is nobody. What it does mean is that an actor able to set a Slack
   * profile email can act as the matching member: normally that requires verifying the address
   * (so, control of their mailbox — at which point Derive's own password reset is open too),
   * and the residual path is a workspace admin setting emails through SCIM without one.
   *
   * If that trade is ever revisited, revisit it HERE and for every lane at once. Tightening one
   * caller alone would be incoherent while the chat turn — which already acts as the asker's
   * seat with `publish` and `comment` in its tool surface — accepts the same row: somebody
   * refused at a button could simply ask the agent to do it instead.
   */
  getSlackUserLinkBySlackId(
    teamId: string,
    slackUserId: string,
  ): Promise<SlackUserLinkRecord | null>
  /** The Slack identity a Derive user linked for a team, or null. Also never a `miss`. */
  getSlackUserLinkByUser(teamId: string, userId: string): Promise<SlackUserLinkRecord | null>
  /** The raw row INCLUDING a `miss`, for the one lane that needs to know whether resolving
   *  this Slack user has already been tried and failed. */
  getSlackIdentityState(teamId: string, slackUserId: string): Promise<SlackUserLinkRecord | null>
  /** Link a Derive user to a Slack identity (idempotent on (team_id, slack_user_id)). */
  setSlackUserLink(l: SlackUserLinkRecord): Promise<void>
  /** Remove a Derive user's Slack link for a team. */
  deleteSlackUserLink(teamId: string, userId: string): Promise<void>
  /** A user's notification preferences in a workspace, or null (⇒ defaults). */
  getUserNotificationPref(orgId: string, userId: string): Promise<UserNotificationPrefRecord | null>
  /** Upsert a user's notification preferences (idempotent on workspace + user). */
  setUserNotificationPref(p: UserNotificationPrefRecord): Promise<void>
  // ---- Domain mode: a hostname serving artifact(s) at its own origin ------
  // A domain row is either bound to one artifact (`artifact_id` set: a vanity
  // subdomain today, a per-artifact custom domain later — served at the host root)
  // or a workspace domain (`artifact_id` null, `org_id` set — the workspace's
  // artifacts served at `<host>/<ref>`).
  /** The domain record for a host, or null. The hot path for host dispatch. */
  getDomain(host: string): Promise<DomainRecord | null>
  /** Claim a host. Returns null if it's already taken (globally unique). */
  setDomain(d: NewDomain): Promise<DomainRecord | null>
  /** Hosts bound to a specific artifact (subdomains; per-artifact customs later). */
  getArtifactDomains(artifactId: string): Promise<DomainRecord[]>
  /** A workspace's own custom domains (artifact_id null), for the settings UI. */
  getWorkspaceDomains(orgId: string): Promise<DomainRecord[]>
  /** Update a custom domain's validation status + the records to display — or, on a
   *  draft claim, unbind the artifact and turn the host into a 302 (`artifact_id:
   *  null` + `redirect_to`). */
  updateDomain(
    host: string,
    fields: {
      status?: DomainStatus
      verification?: string | null
      artifact_id?: string | null
      redirect_to?: string | null
    },
  ): Promise<DomainRecord | null>
  /** Release a hostname, scoped to its owning workspace. */
  deleteDomain(host: string, orgId: string): Promise<void>
  /** Set or clear an artifact's draft expiry (cleared on claim). */
  setArtifactExpiry(artifactId: string, expiresAt: string | null): Promise<void>
  /** Expired drafts due for the sweep: artifacts whose expires_at is past `nowIso`. */
  listExpiredArtifacts(nowIso: string, limit: number): Promise<ArtifactRecord[]>
}

export interface ReviewStore {
  // ---- Review rounds (the agent↔human review loop) ----------------------
  /** Open a review round for a person, replacing their existing pending round on
   *  this artifact (one pending per (artifact, requested_for)). */
  createReviewRound(r: NewReviewRound): Promise<ReviewRoundRecord>
  /** This person's pending round on the artifact, if any. Omit `requestedFor` to
   *  get any pending round (whichever was created first). */
  getPendingRound(artifactId: string, requestedFor?: string): Promise<ReviewRoundRecord | null>
  /** All rounds on an artifact, newest first (the audit trail). */
  listReviewRounds(artifactId: string): Promise<ReviewRoundRecord[]>
  /** Settle a round (`sent_back`), stamping resolved_at + note. */
  /** Settle the pending round as sent back — the loop's one settling gesture.
   *  Returns null when the round is not pending (someone else settled it first). */
  resolveReviewRound(
    id: string,
    fields: {
      note?: string | null
      resolved_by?: string | null
      resolved_by_name?: string | null
    },
  ): Promise<ReviewRoundRecord | null>
}

export interface ContextStore {
  // ---- Contexts + sessions (ask a context; its runner answers) -----------
  createContext(x: NewContext): Promise<ContextRecord>
  getContext(id: string): Promise<ContextRecord | null>
  /** A workspace's contexts, newest first. */
  listContexts(orgId: string): Promise<ContextRecord[]>
  /** `listContexts` with each row's manifest artifact resolved to its `short_id` — the
   *  list route's second query (`getArtifactsByIds` over the ids the first one returned)
   *  folded into a LEFT JOIN. Not the same-key shape the other batches use: this is a
   *  genuine FK dependency, which SQL can still answer in one round trip. `manifest_short_id`
   *  is null when the manifest artifact is missing. */
  contextsWithManifests(
    orgId: string,
  ): Promise<(ContextRecord & { manifest_short_id: string | null })[]>
  /** Remove a context and its sessions + messages, scoped to its workspace. */
  deleteContext(id: string, orgId: string): Promise<void>
  /** Stamp `runner_seen_at` (the queue route's liveness mark). The caller decides
   *  WHEN — the write throttle lives there, next to the poll cadence it paces. */
  touchContextSeen(id: string, at: string): Promise<void>
  /** Set who may ask (workspace | invited). Does not touch the roster. */
  setContextAskPolicy(id: string, policy: "workspace" | "invited"): Promise<void>
  /** Replace the context's bound connections (a JSON array of ids, or null for none).
   *  Whole-list semantics: the caller has already checked every id is attachable. */
  setContextConnections(id: string, connectionIds: string | null): Promise<void>
  /** The invited-asker roster for a context (only consulted when ask_policy = invited). */
  listContextAskers(contextId: string): Promise<ContextAskerRecord[]>
  /** Is this user on the context's asker roster? (Membership is checked separately.) */
  getContextAsker(contextId: string, userId: string): Promise<ContextAskerRecord | null>
  /** Add a user to the roster (idempotent on the unique (context, user)). The
   *  route validates workspace membership before calling — the store does not. */
  addContextAsker(a: NewContextAsker): Promise<ContextAskerRecord>
  /** Remove a user from the roster; a no-op if they weren't on it. */
  removeContextAsker(contextId: string, userId: string): Promise<void>
  createSession(s: NewSession): Promise<SessionRecord>
  /**
   * Open a session AND write its first message AND set the resulting state, in one call.
   * Chat's enqueue did these as three sequential statements — on the edge tier that is
   * three ~80ms round trips (see edge-pg.ts) for one logical act. Postgres does all three
   * in a single statement with a CTE chain, which also makes them ATOMIC: three loose
   * statements outside a transaction can leave a session with no first message if the
   * isolate dies between them, and nothing reopens that.
   */
  createSessionWithMessage(
    s: NewSession,
    m: Omit<NewSessionMessage, "session_id">,
    state: SessionState,
  ): Promise<{ session: SessionRecord; message: SessionMessageRecord }>
  getSession(id: string): Promise<SessionRecord | null>
  /** Sessions on a context, newest first; `askerId` narrows to one person's.
   *  `cursor` pages further back: a `(created_at, id)` keyset, exclusive. The id
   *  tiebreak is load-bearing, not defensive — sessions ARE created in the same
   *  millisecond (a script recording a batch of local runs), and a cursor on the
   *  timestamp alone would silently drop every row sharing the boundary. Encode
   *  and decode it with `encodeCursor`/`decodeCursor`, like `listArtifacts`. */
  listSessions(
    contextId: string,
    opts?: { askerId?: string; limit?: number; cursor?: { key: string; id: string } },
  ): Promise<SessionRecord[]>
  /** What this context has PRODUCED: its sessions' bound result artifacts, GROUPED —
   *  one row per artifact however many runs bound it, so a report republished nightly is
   *  one output carrying a run count, not fifty rows of the same short id. Newest run
   *  first. Sessions that bound nothing (a plain question) are simply absent.
   *
   *  Returns short ids only, deliberately: the caller resolves them through
   *  `listArtifacts({ ids })`, so the visibility gate is the same one the library uses
   *  and this can never widen what a viewer sees. */
  contextOutputs(contextId: string, limit?: number): Promise<ContextOutput[]>
  /** One person's CONTEXTLESS sessions in a workspace, newest first — the chat history
   *  picker. Contextless IS the filter: a session with no context is one nobody packaged,
   *  which is exactly what the chat surfaces open. `listSessions` cannot answer this (it
   *  keys on a context id, which these do not have). Scoped to the asker: a chat session
   *  is private to the person who opened it, including from the workspace's owners. */
  listChatSessions(orgId: string, askerId: string, limit?: number): Promise<SessionRecord[]>
  /** The runner's queue: `open` sessions on a context, oldest first. A plain
   *  polling read that does NOT claim — `claimPendingSessions` is the
   *  concurrency-safe path (it leases rows so overlapping runners can't
   *  double-run one). Kept for read-only queue views. */
  pendingSessions(contextId: string, limit: number): Promise<SessionRecord[]>
  /** Atomically claim up to `limit` runnable sessions on a context, oldest first:
   *  a session is runnable when `open`, or `working` with a lapsed `lease_until`
   *  (crash recovery). Flips each to `working`, stamps `started_at`, and leases it
   *  to `leaseUntil`; returns the claimed rows. Mirrors the webhook_delivery /
   *  render_job lease claim (single-writer UPDATE…IN(SELECT) on sqlite/d1, FOR
   *  UPDATE SKIP LOCKED on Postgres). */
  claimPendingSessions(
    contextId: string,
    limit: number,
    leaseUntil: string,
  ): Promise<SessionRecord[]>
  /** How many sessions are currently `working` on a context — the per-context
   *  concurrency cap (the route claims min(limit, max_concurrency - working)). */
  countWorkingSessions(contextId: string): Promise<number>
  /** Sessions awaiting an executor across the selected workspaces (all when omitted), capped
   *  oldest first — the hosted tick's ask-lane scan, the twin of listDueQueuedRuns. Runnable
   *  means `open`, or `working` with a lapsed lease (a dead executor's session self-heals).
   *  Read-only: dispatch never claims, the booted executor does. */
  listDueOpenSessions(
    now: string,
    limit?: number,
    orgIds?: readonly string[],
  ): Promise<SessionRecord[]>
  /** Claim EXACTLY one session for one agent (the capability-token path: a dispatched substrate
   *  serves its one session, never a batch). open|lapsed-working → `working` under the same
   *  lease, so a double-booted substrate loses the race and exits clean. Null when it isn't
   *  claimable (missing, foreign agent, or already live). */
  claimSessionById(id: string, agentId: string, leaseUntil: string): Promise<SessionRecord | null>
  /** The newest still-live session (`open` or `working`) matching a dedupe key for a
   *  given asker on a context, or null — the ask idempotency join. Scoped to the asker so
   *  a shared key never joins one asker onto another's private session. */
  findInflightSession(
    contextId: string,
    askerId: string,
    dedupeKey: string,
  ): Promise<SessionRecord | null>
  /** Record the artifact a run produced (its short_id) on a session + bump updated_at. */
  setResultArtifact(sessionId: string, artifactShortId: string): Promise<void>
  /** Extend a claimed session's lease (a streaming runner's heartbeat) — keeps a
   *  slow-but-live run from being re-served/double-run at max_concurrency > 1. */
  renewSessionLease(sessionId: string, leaseUntil: string): Promise<void>
  /** Status-guarded claim for a CONTEXTLESS (chat) session, which has no agent to check
   *  ownership through. Returns the row only if this caller won: `open`, or `working` with a
   *  lapsed lease (crash recovery). Two tabs sending at once therefore run ONE turn, and a
   *  process that dies mid-turn leaves a lease that lapses instead of a session stuck forever. */
  claimAttendedSession(id: string, leaseUntil: string): Promise<SessionRecord | null>
  /** Append an asker follow-up and reopen the session ATOMICALLY (compare-and-set): a
   *  `working` session stays working (don't vacate the active claim); a settled/open one
   *  goes to `open` (reclaimable), and a settled one drops its dedupe key so it can't collide
   *  with a newer same-key session. The CAS closes the settle-vs-reopen race a read-then-write
   *  would strand `working` with no runner. */
  appendFollowupReopen(m: NewSessionMessage): Promise<SessionMessageRecord>
  /** Set a session's state and bump updated_at; null if the session is unknown. */
  setSessionState(id: string, state: SessionState): Promise<SessionRecord | null>
  /** Append a message and set the session's state in the same call (the turn flip:
   *  an asker message re-opens; an agent message settles to answered/escalated).
   *  The caller decides the state — the store just applies both writes. */
  addSessionMessage(m: NewSessionMessage, state: SessionState): Promise<SessionMessageRecord>
  /** A session's transcript, oldest first. */
  listSessionMessages(sessionId: string): Promise<SessionMessageRecord[]>
  /** Transcripts for a set of sessions in ONE query (session_id ∈ sessionIds), oldest
   *  first; callers group by `session_id`. Empty ⇒ []. Use over a per-session loop. */
  listSessionMessagesFor(sessionIds: string[]): Promise<SessionMessageRecord[]>
  /**
   * The most recent AGENT answers across every session, newest first — the sample the
   * operator's model timings are computed from.
   *
   * DELIBERATELY UNSCOPED, and the only unscoped read of a transcript in this interface. It
   * answers a question about the DEPLOY ("how is each model performing"), not about a
   * workspace, and there is no workspace whose answer would be the right one. That makes it
   * operator-only at the route. The projection deliberately excludes `body_md`: timing a model
   * must not transfer 500 full answers only to discard them in memory.
   *
   * Bounded by `limit` rather than by time. A quiet deploy still has a sample, a busy one does
   * not pay for a window it will never read past, and either way the cost of the query is a
   * constant the caller picked.
   */
  listRecentAgentMessages(
    limit: number,
  ): Promise<Pick<SessionMessageRecord, "session_id" | "author_kind" | "created_at" | "meta">[]>
}

/**
 * A template library is a named collection of reusable, version-pinned starters.
 *
 * `private` is visible only to its creator; `workspace` is visible to members of
 * its workspace; `public` is intentionally world-readable. Entries hold a
 * snapshot of an artifact version rather than a live pointer, so adopting a
 * template is deterministic and later edits to the source cannot silently alter
 * another person's starting point.
 */
export const TEMPLATE_LIBRARY_SCOPES = ["private", "workspace", "public"] as const
export const TEMPLATE_ENTRY_KINDS = ["artifact", "context"] as const
export const TEMPLATE_ENTRY_FORMATS = ["md", "html"] as const

export type TemplateLibraryScope = (typeof TEMPLATE_LIBRARY_SCOPES)[number]
export type TemplateEntryKind = (typeof TEMPLATE_ENTRY_KINDS)[number]
export type TemplateEntryFormat = (typeof TEMPLATE_ENTRY_FORMATS)[number]

export interface TemplateLibraryRecord {
  id: string
  org_id: string
  title: string
  description: string
  scope: TemplateLibraryScope
  created_by: string
  created_at: string
  updated_at: string | null
  /** Short-lived server-side mutex for scope/entry mutations. Never serialized. */
  mutation_token: string | null
  mutation_started_at: string | null
}

/** The durable, independently-readable starter stored in one library. */
export interface TemplateLibraryEntryRecord {
  id: string
  library_id: string
  /** The artifact this entry was made from; provenance only, never dereferenced for use. */
  source_artifact_id: string
  /** The source artifact version captured when the entry was published. */
  source_version: number
  /** Exact version bytes, retained as the entry's stable starter snapshot. */
  source_blob_key: string
  source_content_type: string
  kind: TemplateEntryKind
  category: string
  format: TemplateEntryFormat
  title: string
  description: string
  outcome: string
  sections_json: string
  inputs_json: string
  tags_json: string
  created_by: string
  created_at: string
}

export interface NewTemplateLibrary {
  id: string
  org_id: string
  title: string
  description?: string
  scope?: TemplateLibraryScope
  created_by: string
}

export interface NewTemplateLibraryEntry {
  id: string
  library_id: string
  source_artifact_id: string
  source_version: number
  source_blob_key: string
  source_content_type: string
  kind: TemplateEntryKind
  category: string
  format: TemplateEntryFormat
  title: string
  description: string
  outcome: string
  sections_json: string
  inputs_json: string
  tags_json: string
  created_by: string
}

export interface TemplateLibraryStore {
  createTemplateLibrary(x: NewTemplateLibrary): Promise<TemplateLibraryRecord>
  getTemplateLibrary(id: string): Promise<TemplateLibraryRecord | null>
  /** Narrow filters compose with AND; callers combine queries for access unions. */
  listTemplateLibraries(opts?: {
    orgId?: string
    scope?: TemplateLibraryScope
    createdBy?: string
    query?: string
    before?: { createdAt: string; id: string }
    limit?: number
  }): Promise<TemplateLibraryRecord[]>
  updateTemplateLibrary(
    id: string,
    fields: { title?: string; description?: string; scope?: TemplateLibraryScope },
  ): Promise<TemplateLibraryRecord | null>
  /** Serialize mutations whose validation depends on the library's current
   * scope and entries. A stale holder may be replaced after `staleBefore`. */
  acquireTemplateLibraryMutation(id: string, token: string, staleBefore: string): Promise<boolean>
  /** Refresh only the current holder's lease immediately before its protected write. */
  renewTemplateLibraryMutation(id: string, token: string): Promise<boolean>
  releaseTemplateLibraryMutation(id: string, token: string): Promise<void>
  deleteTemplateLibrary(id: string): Promise<void>
  createTemplateLibraryEntry(x: NewTemplateLibraryEntry): Promise<TemplateLibraryEntryRecord>
  getTemplateLibraryEntry(id: string): Promise<TemplateLibraryEntryRecord | null>
  listTemplateLibraryEntries(libraryId: string): Promise<TemplateLibraryEntryRecord[]>
  /** Search entry + library metadata under the caller's discoverable access union. */
  searchTemplateLibraryEntries(opts: {
    orgId: string
    ownerId: string | null
    query?: string
    limit: number
  }): Promise<Array<{ library: TemplateLibraryRecord; entry: TemplateLibraryEntryRecord }>>
  countTemplateLibraryEntries(libraryIds: string[]): Promise<Record<string, number>>
  deleteTemplateLibraryEntry(id: string): Promise<void>
}

export interface DirectoryStore {
  // ---- User directory (reads Better Auth's `user` table) ----------------
  findUserByEmail(email: string): Promise<UserDir | null>
  getUsers(ids: string[]): Promise<UserDir[]>
  /** Instance-wide authority is bound to Better Auth's immutable user id, never
   *  to a submitted email address. The offline bootstrap command is the normal
   *  writer; the verified-email migration path may also bind a legacy operator. */
  isInstanceOperator(userId: string): Promise<boolean>
  hasInstanceOperators(): Promise<boolean>
  addInstanceOperator(userId: string): Promise<void>
  /** Map GitHub numeric user ids (as strings) to the Derive accounts that signed in with
   *  GitHub — joins Better Auth's `account` (providerId='github', accountId IN ids) to
   *  `user`. Lets a synced artifact's commit author resolve to a Derive profile/handle.
   *  Returns [] for empty input or when the auth tables are absent. */
  usersByGithubIds(ghIds: string[]): Promise<GithubUserMapping[]>
  /** The GitHub numeric user ids (account.accountId, as strings) a Derive user has linked
   *  via Better Auth's `account` (providerId='github'). Inverse of `usersByGithubIds`.
   *  Returns [] when none or the auth tables are absent. */
  githubIdsForUser(userId: string): Promise<string[]>
  /** A Derive user's GitHub login, derived from any artifact whose `author_gh_id` is one of
   *  their linked GitHub ids (we don't store the login on `account`). Null when unknown —
   *  used only to show a GitHub link on the profile. */
  githubLoginForUser(userId: string, ghIds: string[]): Promise<string | null>
  /** Org ids where BOTH users hold a membership — the shared-workspace set that widens a
   *  viewer's profile visibility beyond public. Empty for an anonymous viewer. */
  sharedOrgIds(viewerId: string, targetUserId: string): Promise<string[]>
  /** A person's work for their profile: artifacts (not removed) authored by them — either
   *  `author_id = userId` OR `author_gh_id ∈ ghIds` (their linked GitHub commits) — gated
   *  by `visibleOrgIds` (public OR a shared workspace). Newest first, keyset-paginated via
   *  `opts.cursor`/`opts.limit`. */
  listUserWorks(userId: string, ghIds: string[], opts: ListArtifactsOpts): Promise<ArtifactRecord[]>
  /** Count of a person's visible work (same predicate as `listUserWorks`) for the stats row. */
  countUserWorks(userId: string, ghIds: string[], opts: ListArtifactsOpts): Promise<number>
  /** Resolve a public profile by its handle (username); null if unclaimed. */
  getUserByUsername(username: string): Promise<UserProfile | null>
  /** Claim or replace a user's handle. Returns "taken" when another account
   *  already holds it (the unique index is the hard backstop on a race). */
  setUsername(userId: string, username: string): Promise<"ok" | "taken">
  /** Set a user's avatar URL (image column on Better Auth's user table). */
  setUserImage(userId: string, image: string): Promise<void>
  /** Opt a user in/out of people search (discoverable column). */
  setUserDiscoverable(userId: string, discoverable: boolean): Promise<void>
  /** Mark first-run onboarding finished/skipped (onboarded column). Server-authoritative,
   *  so the /welcome gate syncs across devices instead of trusting per-browser storage. */
  setUserOnboarded(userId: string, onboarded: boolean): Promise<void>
  /** Purge a user's Derive-domain data on account deletion: remove their association rows
   *  (memberships, artifact/collection members, follows, favorites, notifications), ANONYMIZE
   *  their authorship (author_id → null on artifacts/versions/comments, so others'
   *  threads survive), null the nullable back-references keyed to them (agent.created_by,
   *  invitation.invited_by), and drop their personal workspace row. Better Auth removes the
   *  account itself + its sessions/passkeys/2FA.
   *
   *  NOT hard-deleted: artifact/collection content is anonymized + orphaned (a GC concern),
   *  and NON-nullable historical metadata that merely records a past action (a review
   *  round's requester, an audit-log actor, a repo/collection creator)
   *  keeps the raw id. That id is safe: once Better Auth removes the user row it resolves to
   *  nothing (getUsers → []), so it's an unresolvable tombstone, not recoverable identity —
   *  the same shape as an orphaned git author. */
  deleteUserData(userId: string): Promise<void>
  /** Set a user's team role + "what you do" blurb (profession/about) + their personal
   *  Brandprint (a JSON string). An undefined field is left untouched; null clears it. */
  setUserProfile(
    userId: string,
    fields: { profession?: string | null; about?: string | null; brandprint?: string | null },
  ): Promise<void>
  /** A user's personal Brandprint as the stored JSON string (or null). Read for the
   *  profile layer in agent context resolution. */
  getUserBrandprint(userId: string): Promise<string | null>
  /** People search: opted-in (discoverable) profiles matching `q` on username or
   *  name, capped to `limit`. Empty `q` returns nothing (no full enumeration). */
  searchDiscoverableUsers(q: string, limit: number): Promise<UserProfile[]>
  /** Browse the people directory: opted-in (discoverable) profiles with a claimed handle,
   *  ordered by handle, capped to `limit`. The browse counterpart to
   *  searchDiscoverableUsers — powers the People page's default view. */
  listDiscoverableUsers(limit: number): Promise<UserProfile[]>
  /** Distinct people sharing any workspace with `userId` (themselves excluded) —
   *  the People page's "your workspaces" section. Membership already implies you
   *  can see each other, so `discoverable` doesn't apply here. */
  listWorkspaceMates(userId: string, limit: number): Promise<UserProfile[]>

  // ---- Notifications (in-app, one row per recipient) --------------------
  createNotification(n: NewNotification): Promise<void>
  /** Insert many notification rows in ONE statement — the recipient fan-out for a publish
   *  (followers), a comment (thread participants + owners), or a mention. Empty ⇒ no-op.
   *  Use over a per-recipient createNotification loop. */
  createNotifications(rows: NewNotification[]): Promise<void>
  listNotifications(userId: string, limit: number): Promise<NotificationRecord[]>
  unreadNotificationCount(userId: string): Promise<number>
  /** The bell's whole payload — the page of notifications AND the total unread count
   *  (over every notification the user has, not just this page) — in one call. On the
   *  edge tier `listNotifications`+`unreadNotificationCount` are two round trips for the
   *  same `user_id`; a store that can answer both from one query should. */
  notificationsPage(userId: string, limit: number): Promise<NotificationsPage>
  /** Mark the given ids read, or all of the user's notifications when "all". */
  markNotificationsRead(userId: string, ids: string[] | "all"): Promise<void>
}

/** See `DirectoryStore.notificationsPage`. */
/** One collections read — see MetaStore.collectionsOverview. */
export interface CollectionsOverviewRead {
  collections: (CollectionRecord & { count: number })[]
  /** Collection ids the viewer starred. Empty when no `viewer` was passed. */
  starred: string[]
  /** The collections the viewer worked in since `activeSince`, each with THEIR latest
   *  touch (publish or comment; being added by someone else counts, creating doesn't) —
   *  the Collections digest orders "your shelves" by this. Empty without a viewer. */
  workedIn: { id: string; at: string }[]
  /** Newest-first covers per collection id. Empty without a viewer; a collection with
   *  nothing in it is absent rather than mapped to []. */
  previews: Record<string, CollectionPreview[]>
  /** Live user-directory rows for the previews' authors — the byline self-heal, same
   *  contract as ListEnrichment.bylines. Best-effort: empty when the auth tables are
   *  absent (fresh self-host), and the denormalized name stands in. */
  previewBylines: { id: string; name: string | null; username: string | null }[]
}

/** One round trip's worth of app-shell boot data — see MetaStore.bootstrap. */
export interface BootstrapRead {
  summary: WorkspaceSummary
  collections: (CollectionRecord & { count: number })[]
  /** The viewer's stars / worked-in set / preview strips — see CollectionsOverviewRead. */
  starred: string[]
  workedIn: { id: string; at: string }[]
  previews: Record<string, CollectionPreview[]>
  previewBylines: { id: string; name: string | null; username: string | null }[]
  /** The caller's explicit per-collection roles (creator-ownership is applied by the route). */
  collectionRoles: Record<string, Role>
  settings: OrgSettings
  notifications: NotificationsPage
  /** The two inputs a publishing-blocked verdict needs, so the app shell's banner does
   *  not have to call GET /v1/billing on every boot to learn it is not blocked. That
   *  endpoint is six store calls (subscription, seats, stored bytes, asset bytes, plus
   *  the workspace preamble) and it was the single most expensive request on the boot
   *  waterfall — 676ms measured — to render a strip that is normally invisible. */
  billing: { subscription: SubscriptionRecord | null; billableSeats: number }
}

export interface NotificationsPage {
  notifications: NotificationRecord[]
  unread: number
}

export interface AgentStore {
  // ---- Agents (mentionable principals that act via a scoped token) -------
  createAgent(a: NewAgent): Promise<AgentRecord>
  /** Replace the agent's token hash (org-scoped). The old bearer dies at once;
   *  identity, role, hosting, and attribution are untouched. Null = not found. */
  rotateAgentToken(id: string, orgId: string, tokenHash: string): Promise<AgentRecord | null>
  /** Stamp `runs_seen_at` (the claim route's liveness mark). Caller throttles. */
  touchAgentRunsSeen(id: string, at: string): Promise<void>
  listAgents(orgId: string): Promise<AgentRecord[]>
  /** Flip whether Derive's managed executor serves this agent. Workspace-scoped by
   *  (id, org) like deleteAgent; null when the agent isn't in this workspace. */
  setAgentHosted(id: string, orgId: string, hosted: 0 | 1): Promise<AgentRecord | null>
  // ---- Automations + runs (the generic agent-work primitive) -------------
  /** Create an automation (a standing agent job). */
  createAutomation(a: NewAutomation): Promise<AutomationRecord>
  /** One automation by id, or null. */
  getAutomation(id: string): Promise<AutomationRecord | null>
  /** Batch-load automations by id in ONE query (id ∈ ids). Order is unspecified; callers
   *  key by `id`. Empty ids ⇒ []. Use this over a per-id getAutomation loop. */
  getAutomationsByIds(ids: string[]): Promise<AutomationRecord[]>
  /** A workspace's automations, newest first. Default 100. */
  listAutomations(orgId: string, limit?: number): Promise<AutomationRecord[]>
  /** `listAutomations` with each row's agent's `runs_seen_at` folded in (the honesty badge
   *  — null means no executor has ever polled). The list route used to fetch automations
   *  and the workspace's whole agent roster as two separate round trips and join them in
   *  memory; same org, same page, one query. */
  automationsWithExecutors(
    orgId: string,
    limit?: number,
  ): Promise<(AutomationRecord & { executor_seen_at: string | null })[]>
  /** Partial update, org-scoped (id + orgId must both match). Undefined fields are
   *  untouched; refs null clears. Returns the updated row, or null when not found. */
  updateAutomation(
    id: string,
    orgId: string,
    fields: {
      agent_id?: string
      trigger?: string
      instruction?: string
      provider?: import("./execution").ExecutionProvider
      refs?: string | null
      context_id?: string | null
      /** JSON array of connection ids this automation may spend; null clears them all. */
      connection_ids?: string | null
      enabled?: 0 | 1
    },
  ): Promise<AutomationRecord | null>
  /** Remove an automation and cancel its still-queued runs, org-scoped so a caller can't
   *  reach across tenants. Running/finished runs stay as history. */
  deleteAutomation(id: string, orgId: string): Promise<void>
  /** Enqueue or record a run. status defaults to "queued" (pending work); pass a terminal
   *  status to record an already-finished run straight into the ledger. */
  createRun(r: NewRun): Promise<RunRecord>
  /** One run by id, or null. Resolves a run's initiator for the model-credential endpoint, its
   *  automation for the tool endpoint, and its liveness when a capability token is presented. */
  getRun(id: string): Promise<RunRecord | null>
  /** One agent by id — resolves a run capability token to its agent principal. */
  getAgent(id: string): Promise<AgentRecord | null>
  /** Atomically claim due queued runs for one agent: status "queued" with scheduled_for ≤
   *  now, flipped to "running" (started_at = now) under a row lock so concurrent executors
   *  never double-run one. Returns the claimed rows, oldest-scheduled first. */
  claimDueRuns(agentId: string, now: string, limit?: number): Promise<RunRecord[]>
  /** Claim EXACTLY one run by id for one agent (the capability-token path: a dispatched
   *  substrate executes its one run, never a batch). Same queued→running flip under the same
   *  race safety; null when the run isn't claimable (missing, foreign, or already claimed —
   *  a double-booted substrate loses this race and exits clean). */
  claimRunById(id: string, agentId: string, now: string): Promise<RunRecord | null>
  /** Send a RUNNING run back to the queue for a later retry, scoped to the claiming agent.
   *  The transient-failure counterpart to finishRun: instead of a terminal row the run becomes
   *  `queued` again with `scheduled_for` in the future (the backoff) and its attempt count in
   *  meta. Returns the updated row, or null when the run isn't this agent's or isn't running —
   *  OR when `expectedStartedAt` is given and no longer matches. That fence is what makes this
   *  safe against a STALE claim: a run-scoped work token authorizes (run, agent, org) for its
   *  whole TTL with no notion of WHICH claim episode minted it, so once a run is re-claimed,
   *  the superseded executor's still-valid token could otherwise requeue — or, via finishRun,
   *  outright SETTLE — a run a newer claim now owns, with no signal to either side. Passing the
   *  started_at the caller's OWN claim began with closes that: a newer claim changes it, so a
   *  late request from an old one matches nothing and is refused rather than silently honored.
   *  Optional for callers with no claim identity to fence on (a human retry, a migration). */
  requeueRun(
    id: string,
    agentId: string,
    /** `costMicroUsd` banks the FAILED attempt's spend before the row goes back on the queue: a
     *  retry reuses this same run row, so a cost not recorded here is lost for good when the run
     *  eventually settles. Accumulates onto whatever the column already holds. */
    fields: { scheduledFor: string; meta?: string | null; costMicroUsd?: number | null },
    expectedStartedAt?: string | null,
  ): Promise<RunRecord | null>
  /** The reclaim sweep: runs stuck `running` since before `cutoffIso` (their substrate died)
   *  go back to `queued` for re-dispatch, with an attempt count kept in meta; a run past
   *  `maxAttempts` is finished failed (outcome "lost") instead of looping forever. */
  reclaimStaleRuns(
    cutoffIso: string,
    maxAttempts?: number,
    orgIds?: readonly string[],
  ): Promise<{ requeued: number; failed: number }>
  /** Every enabled automation across the selected workspaces (all when omitted), capped — the
   *  hosted tick scans these to materialize due schedule runs. Fine at self-host scale; revisit
   *  if it ever shows up. */
  listEnabledAutomations(limit?: number, orgIds?: readonly string[]): Promise<AutomationRecord[]>
  /** Queued runs due now across the selected workspaces (all when omitted), capped oldest first
   *  — the hosted tick's dispatch scan. Read-only: dispatch does NOT claim; the booted substrate
   *  claims. */
  listDueQueuedRuns(now: string, limit?: number, orgIds?: readonly string[]): Promise<RunRecord[]>
  /** Terminate a run: set the terminal status, finished_at, and (optional) cost + meta.
   *  Scoped to (id, agent) so only the claiming agent settles it. `expectedStartedAt`, when
   *  given, fences it to THIS caller's own claim — see requeueRun's doc for why: without it, a
   *  stale-but-unexpired token from a claim a newer one has already superseded can settle a
   *  run out from under the executor actually working it, overwriting its eventual real
   *  outcome (or reporting one before the real work even finished). */
  finishRun(
    id: string,
    agentId: string,
    fields: {
      status: RunStatus
      finishedAt: string
      costMicroUsd?: number | null
      meta?: string | null
    },
    expectedStartedAt?: string | null,
  ): Promise<RunRecord | null>
  /** The workspace's recent runs, newest first (the activity view / ledger). Default 50. */
  listRuns(orgId: string, limit?: number): Promise<RunRecord[]>
  /** The newest run for an automation by scheduled_for (any status), or null. The schedule tick
   *  reads it to decide whether the current cron occurrence has already been materialized — so a
   *  runner polling several times inside one cron window enqueues exactly one run.
   *
   *  `reason` narrows to one kind of firing, and the tick MUST pass "schedule". Without it any
   *  other run poisons the dedupe, because they all write a scheduled_for: a Run now and a fire
   *  stamp `now`, and a retry stamps now+backoff, which is in the FUTURE. Each therefore reads
   *  as "this window is already materialized" and silently swallows the cron occurrence — one
   *  click of Run now at 10:05 makes the 10:00 hourly run never exist. */
  latestRunForAutomation(automationId: string, reason?: string): Promise<RunRecord | null>
  /** The newest still-queued run for an automation whose scheduled_for ≤ cutoff — the
   *  coalescing target when a burst of webhook fires arrives close together. Null when none
   *  is open, so the caller enqueues a fresh run. */
  findCoalescibleRun(automationId: string, cutoffIso: string): Promise<RunRecord | null>
  /** Append a payload into a STILL-QUEUED run's `meta.payloads[]`, guarded so it applies only
   *  while the run is queued and its meta is unchanged since the read (optimistic concurrency).
   *  Returns the updated row, or null if the run left the queue, was appended concurrently, or
   *  would exceed maxMetaBytes — in every null case the caller enqueues a fresh run, so a
   *  payload is never lost (at worst an extra run is created under contention). */
  appendRunPayload(runId: string, payload: unknown, maxMetaBytes: number): Promise<RunRecord | null>
  // ---- Plans (bring-your-own model + broker credentials) -----------------
  /** Attach a plan. */
  createPlan(p: NewPlan): Promise<PlanRecord>
  /** One plan by id, or null. */
  getPlan(id: string): Promise<PlanRecord | null>
  /** A workspace's plans, newest first (personal + pool). */
  listPlans(orgId: string): Promise<PlanRecord[]>
  /** Remove a plan, org-scoped so a caller can't reach across tenants. */
  deletePlan(id: string, orgId: string): Promise<void>
  /** The effective plan for (org, user, kind): the user's personal plan if any, else the
   *  workspace-pool plan (user_id null), else null. Money falls back; the caller treats null
   *  as the loud-failure case (no meter available). */
  resolvePlan(orgId: string, userId: string | null, kind: PlanKind): Promise<PlanRecord | null>
  /** Sum of cost_micro_usd across the org's runs at/after an ISO cutoff — backs the budget
   *  check at enqueue (spend this month vs a plan's monthlyMicroUsd limit). */
  sumRunCostSince(orgId: string, sinceIso: string): Promise<number>
  // ---- Connections (per-user connected external accounts) ----------------
  /** Record a connected account. */
  createConnection(cn: NewConnection): Promise<ConnectionRecord>
  /** One connection by id, or null. */
  getConnection(id: string): Promise<ConnectionRecord | null>
  /** Batch-load connections by id in ONE query — backs the least-privilege toolsFor: a run
   *  resolves ONLY its bound connection ids, never the workspace's whole list. Empty ⇒ []. */
  getConnectionsByIds(ids: string[]): Promise<ConnectionRecord[]>
  /** A workspace's connections, newest first. userId narrows to one person's rows;
   *  scope narrows to personal/workspace rows; combine for "my personal connections". */
  listConnections(
    orgId: string,
    userId?: string,
    scope?: ConnectionScope,
  ): Promise<ConnectionRecord[]>
  /** Flip a connection's status (activate on authorize, revoke on teardown), org-scoped. */
  setConnectionStatus(
    id: string,
    orgId: string,
    status: ConnectionStatus,
  ): Promise<ConnectionRecord | null>
  /**
   * Rewrite a connection's stored credential, and optionally its ref and status — the one
   * mutation the table never had.
   *
   * It exists for OAuth, where the credential is not final at connect: the row is created
   * `pending` before the redirect, and the callback later writes the token, pins the tool list
   * into `broker_ref`, and flips it `active`. A refresh then rewrites the same field again,
   * repeatedly, for the life of the connection. Without it there is nowhere to put a rotated
   * token, which is why a pasted key could never be rotated either.
   *
   * `expectSecretEnc` is a COMPARE-AND-SWAP on the credential, and it is not optional politeness:
   * two runs can hit an expired access token in the same second, both refresh, and the slower
   * reply would otherwise overwrite the newer token with an older one — invalidating a grant that
   * was working. A mismatch returns null and the caller re-reads instead of guessing. The same
   * guard the model-credential PUT already uses, for the same reason.
   */
  updateConnectionCredential(
    id: string,
    orgId: string,
    fields: {
      secret_enc?: string | null
      broker_ref?: string
      status?: ConnectionStatus
      scopes_label?: string | null
    },
    expectSecretEnc?: string | null,
  ): Promise<ConnectionRecord | null>
  /** Resolve an agent from its bearer token (the agent's identity). */
  getAgentByToken(token: string): Promise<AgentRecord | null>
  /** Resolve a live OAuth access token (by its stored hash) to its grant. */
  getOAuthGrant(tokenHash: string): Promise<OAuthGrant | null>
  /** The display name of a registered OAuth client (for the consent screen). */
  getOAuthClientName(clientId: string): Promise<string | null>
  /** Does this client_id still have a row? Backs the /authorize self-heal: a client_id an
   *  agent is holding can go stale (reaped by pruneStaleOAuthClients, or any other loss of
   *  the row) without the agent knowing, so /authorize checks this before trusting it. */
  oauthClientExists(clientId: string): Promise<boolean>
  /** The agents a USER has authorized via the browser consent (one per client), so they can
   *  review + revoke what may act on their behalf. Reads Better Auth's oauth-provider tables;
   *  empty when they aren't present. */
  listUserGrants(userId: string): Promise<OAuthGrantSummary[]>
  /** The first artifact an agent produced for this user — a direct MCP publish
   *  (version.source='mcp', attributed to them). The onboarding "published via
   *  agent" signal. */
  firstAgentPublish(userId: string): Promise<{ short_id: string; title: string | null } | null>
  /** Revoke a user's grant to one OAuth client: drop the consent + every live access/refresh
   *  token, so the agent loses access immediately and must re-consent. */
  revokeUserGrant(userId: string, clientId: string): Promise<void>
  /** Replace the SET of workspaces this user scopes an OAuth client's grants to (the
   *  consent screen's workspace multi-select). Empty array clears it → "all workspaces". */
  setOAuthClientWorkspaces(userId: string, clientId: string, orgIds: string[]): Promise<void>
  /** The workspaces a user scoped an OAuth client to. Empty array = "all workspaces"
   *  (unscoped) — the grant reaches every workspace the user belongs to. */
  getOAuthClientWorkspaces(userId: string, clientId: string): Promise<string[]>
  deleteAgent(id: string, orgId: string): Promise<void>

  // ---- Workspace invitations (invite-by-email → accept) ------------------
  /** Create a pending invitation. Any existing pending invite for the same
   *  (org, email) should be replaced by the caller first (a fresh token supersedes). */
  createInvitation(i: NewInvitation): Promise<InvitationRecord>
  /** Resolve an invite by its hashed token (for the accept flow); null if unknown. */
  getInvitationByToken(tokenHash: string): Promise<InvitationRecord | null>
  /** Pending (unaccepted) invitations for a workspace — the Admin's pending list. */
  listPendingInvitations(orgId: string): Promise<InvitationRecord[]>
  /** Drop any pending invite for this (org, email) — used to supersede on re-invite
   *  and to clear it once the person becomes a member. */
  deletePendingInvitationsFor(orgId: string, email: string): Promise<void>
  /** Revoke a specific pending invitation (Admin), scoped to its workspace. */
  deleteInvitation(id: string, orgId: string): Promise<void>
  /** Atomically spend a still-live invite. Exactly one concurrent caller wins. */
  consumeInvitation(id: string, now: string): Promise<boolean>

  // ---- Artifact invitations (share-by-email → accept) ---------------------
  /** Create a pending per-artifact invite. Any prior pending invite for the same
   *  (artifact, email) should be replaced by the caller first. */
  createArtifactInvite(i: NewArtifactInvite): Promise<ArtifactInviteRecord>
  /** Resolve by hashed token (accept flow); null if unknown. */
  getArtifactInviteByToken(tokenHash: string): Promise<ArtifactInviteRecord | null>
  /** Pending (unaccepted) invites on an artifact — the share dialog's pending rows. */
  listPendingArtifactInvites(artifactId: string): Promise<ArtifactInviteRecord[]>
  /** Drop any pending invite for this (artifact, email) — supersede on re-invite,
   *  and clear once the person holds a real membership. */
  deletePendingArtifactInvitesFor(artifactId: string, email: string): Promise<void>
  /** Revoke one pending invite, scoped to its artifact. */
  deleteArtifactInvite(id: string, artifactId: string): Promise<void>
  /** Atomically spend a still-live invite. Exactly one concurrent caller wins. */
  consumeArtifactInvite(id: string, now: string): Promise<boolean>

  // ---- Collection invitations (share-by-email → accept) -------------------
  createCollectionInvite(i: NewCollectionInvite): Promise<CollectionInviteRecord>
  getCollectionInviteByToken(tokenHash: string): Promise<CollectionInviteRecord | null>
  listPendingCollectionInvites(collectionId: string): Promise<CollectionInviteRecord[]>
  deletePendingCollectionInvitesFor(collectionId: string, email: string): Promise<void>
  deleteCollectionInvite(id: string, collectionId: string): Promise<void>
  consumeCollectionInvite(id: string, now: string): Promise<boolean>

  // ---- Signup attribution (which surface sourced a signup) -----------------
  /** Record where a signup came from, once per user — a duplicate hook fire is a
   *  no-op (first write wins; the attribution of record is the one at signup). */
  recordSignupAttribution(a: NewSignupAttribution): Promise<void>
  /** The recorded source for a user, or null for an organic signup. */
  getSignupAttribution(userId: string): Promise<SignupAttributionRecord | null>

  /** Queue a mention into an agent's pull inbox. */
  createAgentMention(m: NewAgentMention): Promise<void>
  /** Pending (unhandled) mentions for an agent, oldest first. */
  listPendingAgentMentions(agentId: string, limit: number): Promise<AgentMentionRecord[]>
  /** Mark a mention handled; false if it isn't this agent's or doesn't exist. */
  ackAgentMention(agentId: string, id: string): Promise<boolean>
}

export interface ModerationStore {
  // ---- Moderation: abuse reports, takedown, audit log --------------------
  createReport(r: NewReport): Promise<ReportRecord>
  /** One report by id, scoped to a workspace (or any, super-admin orgId undefined). */
  getReport(id: string, orgId?: string): Promise<ReportRecord | null>
  /** Reports for one workspace, or — for a super-admin operator, orgId undefined
   *  — every workspace's (the global moderation queue). */
  listReports(
    orgId: string | undefined,
    opts?: { state?: ReportState; limit?: number },
  ): Promise<ReportRecord[]>
  countOpenReports(orgId: string | undefined): Promise<number>
  setReportState(id: string, state: ReportState, orgId?: string): Promise<void>
  /** Hard-delete an artifact and all its dependent rows (versions, comments,
   *  memberships, favorites, tags, collection items, domains, etc.).
   *  Ownership check is the caller's responsibility. For moderation takedowns
   *  use setArtifactRemoved() instead — that tombstones without deleting. */
  deleteArtifact(id: string, orgId: string): Promise<void>
  /** Move an artifact to a different workspace: updates org_id, drops it from any
   *  collections (org-scoped groupings), and detaches any org-scoped webhook that
   *  targeted it specifically (falls back to org-wide). Ownership + destination
   *  membership checks are the caller's responsibility. */
  moveArtifactOrg(artifactId: string, targetOrgId: string): Promise<void>
  /** Set or clear an artifact's takedown tombstone (the record is never deleted). */
  setArtifactRemoved(id: string, removedAt: string | null): Promise<void>
  /** Tombstone many artifacts at once (id ∈ ids) in ONE update — the PR-preview
   *  teardown. Empty ids ⇒ no-op. Use over a per-id setArtifactRemoved loop. */
  setArtifactsRemoved(ids: string[], removedAt: string | null): Promise<void>
  /** Set or clear the reversible archive timestamp. Unlike `removed_at`, this never
   *  changes direct-read behavior or serves a tombstone. */
  setArtifactArchived(id: string, archivedAt: string | null): Promise<void>
  /** Batch twin used by MCP cleanup. Empty ids ⇒ no-op. */
  setArtifactsArchived(ids: string[], archivedAt: string | null): Promise<void>
  /** Take an artifact down atomically: tombstone the artifact, resolve every open
   *  report against it (→ actioned), and write the audit entry — all in one
   *  transaction so a crash mid-way can't leave a half-applied takedown (removed
   *  but reports still open, or no audit trail). Replaces the route's
   *  read-loop-write, which was both non-atomic and N+1 in the open-report count. */
  takedownArtifact(input: TakedownInput): Promise<void>
  /** Rename. Pass `slug` to re-derive the URL name with it: the ref is
   *  `<slug>-<short_id>` and `parseRef` resolves on the trailing short id, so an old
   *  link keeps working while a renamed doc stops advertising its former title. */
  setArtifactTitle(id: string, title: string, slug?: string | null): Promise<void>
  /** Test/maintenance helper for ordering and migration paths. */
  setArtifactUpdatedAt(id: string, updatedAt: string): Promise<void>
  /** One-shot, idempotent: fill `artifact.author_id` for rows that predate the column,
   *  where the artifact's `author_gh_id` maps to a Derive account (Better Auth `account`,
   *  providerId='github'). Only touches rows with a null author_id and a known mapping;
   *  a no-op once applied. Returns the number of rows updated. Best-effort (0 if the auth
   *  tables are absent). Pre-feature hand-published work without a GitHub identity has no
   *  recoverable author and is left null. */
  backfillAuthorIds(): Promise<number>
  createAuditLog(a: NewAuditLog): Promise<void>
  /** Moderation history, newest first. One workspace's, or — super-admin, orgId
   *  undefined — the whole instance's. Optionally narrowed to one artifact. */
  listAuditLog(
    orgId: string | undefined,
    opts?: { artifactId?: string; limit?: number },
  ): Promise<AuditLogRecord[]>
}

/**
 * The full metadata store: the composition of every feature sub-store above. Every
 * adapter (packages/db) implements this whole surface; a consumer that needs only one
 * area can depend on the narrower sub-store instead. Splitting the definition keeps a
 * change to one feature from visually touching the others.
 */
export interface AssetRecord {
  /** The blob's sha256 hex — same key as BlobStore.put/get, and the exact
   *  `asset:<hash>` handle the client already has. */
  hash: string
  org_id: string
  content_type: string
  size_bytes: number
  /** Pixel dimensions, read from the image header at upload. Null for fonts, for an image
   *  whose header couldn't be read, and for rows predating the columns. Bytes alone never
   *  say whether an upload is big because it carries detail or because it was exported at
   *  twice the density it needed — and pixel count is the lever that would change it. */
  width: number | null
  height: number | null
  created_at: string
}
export interface NewAsset {
  hash: string
  org_id: string
  content_type: string
  size_bytes: number
  /** Omitted for fonts and unreadable headers; nullable so the columns ALTER ADD cleanly. */
  width?: number | null
  height?: number | null
}

export interface AssetStore {
  // ---- Standalone image assets (POST /v1/assets), servable at GET /blob/:hash ----
  /** Record a staged upload's metadata. Content-addressed: re-uploading the same
   *  bytes is a no-op (ON CONFLICT DO NOTHING) — the row already describes them. */
  createAsset(a: NewAsset): Promise<AssetRecord>
  /** One asset by hash, org-unscoped — `/blob/:hash` is a public capability URL
   *  (unguessable, not access-gated), so serving it never needs the caller's org. */
  getAsset(hash: string): Promise<AssetRecord | null>
  /** Distinct bytes staged by an org's uploads (whether or not they've been
   *  embedded anywhere yet) — folded into storageBytes so a permanent public
   *  URL counts against quota from the moment it exists, not just once referenced. */
  assetStorageBytes(orgId: string): Promise<number>
}

/** One JSON collection owned by an artifact. The runtime presents this as
 * `derive.shared(key, initial)`; the version is the compare-and-swap guard that
 * keeps concurrent interactions from overwriting each other. */
export interface SharedStateRecord {
  id: string
  artifact_id: string
  key: string
  json: string
  version: number
  updated_by_id: string
  updated_by_name: string
  updated_at: string
}

/** Append-only attribution for an interaction. Identity is always stamped by
 * the API from the authenticated principal, never accepted from artifact code. */
export interface SharedStateActivityRecord {
  id: string
  artifact_id: string
  key: string
  version: number
  action: SharedStateAction
  item_id: string
  actor_id: string
  actor_name: string
  created_at: string
}

export interface SharedStateWrite {
  id: string
  artifact_id: string
  key: string
  json: string
  expected_version: number
  updated_by_id: string
  updated_by_name: string
  updated_at: string
}

export interface NewSharedStateActivity {
  id: string
  artifact_id: string
  key: string
  version: number
  action: SharedStateAction
  item_id: string
  actor_id: string
  actor_name: string
  created_at: string
}

export interface SharedStateStore {
  getSharedState(artifactId: string, key: string): Promise<SharedStateRecord | null>
  countSharedStateKeys(artifactId: string): Promise<number>
  /** Insert when expected_version is 0, otherwise update only the matching
   * version. Null means another interaction won the race and the caller retries. */
  putSharedState(write: SharedStateWrite): Promise<SharedStateRecord | null>
  /** Append one attributed version and retain the bounded recent activity feed. */
  appendSharedStateActivity(activity: NewSharedStateActivity): Promise<void>
  listSharedStateActivity(
    artifactId: string,
    key: string,
    limit: number,
  ): Promise<SharedStateActivityRecord[]>
}

export interface MetaStore
  extends ArtifactStore,
    CommentStore,
    ArtifactQueryStore,
    WebhookStore,
    WorkspaceStore,
    SocialStore,
    CollectionStore,
    IntegrationStore,
    ReviewStore,
    ContextStore,
    TemplateLibraryStore,
    DirectoryStore,
    AgentStore,
    ModerationStore,
    AssetStore,
    SharedStateStore {}

/** What a user follows: another Derive person (`target` = their user id). */
export type FollowKind = "user"
/** Sentinel org_id for people follows — they are global, not workspace-scoped,
 *  so a person's work surfaces regardless of which workspace the follower is viewing. */
export const GLOBAL_FOLLOW_ORG = "*"
/** A per-user follow — the same shape of relation as a favorite, but keyed on a
 *  (kind, target) pair instead of an artifact id. Drives the "following" feed. */
export interface FollowRecord {
  id: string
  org_id: string
  user_id: string
  kind: FollowKind
  /** The followed Derive user id (verbatim). */
  target: string
  created_at: string
}
export interface NewFollow {
  id: string
  org_id: string
  user_id: string
  kind: FollowKind
  target: string
}

export type ReportState = "open" | "actioned" | "dismissed"
/** An abuse report against a public artifact. Anyone can file one. */
export interface ReportRecord {
  id: string
  org_id: string
  artifact_id: string
  artifact_short_id: string
  reason: string
  detail: string | null
  /** The reporter's IP (best-effort) or null; reports can be anonymous. */
  reporter: string | null
  state: ReportState
  created_at: string
}
export interface NewReport {
  id: string
  org_id: string
  artifact_id: string
  artifact_short_id: string
  reason: string
  detail?: string | null
  reporter?: string | null
}

/** A live OAuth access token resolved to its grant (Better Auth oidc-provider):
 *  who authorized it, the client, the granted scopes, and when it expires. */
export interface OAuthGrant {
  userId: string
  userEmail: string
  userName: string | null
  clientId: string
  clientName: string
  scopes: string[]
  expiresAt: Date
}

/** One authorized agent from a user's point of view — what they see in "Connected agents"
 *  to review + revoke. Keyed by client (a user grants a client once; tokens rotate under it). */
export interface OAuthGrantSummary {
  clientId: string
  clientName: string
  scopes: string[]
  /** When the grant was last (re)authorized — ISO. */
  grantedAt: string
}

export type AuditAction = "report" | "takedown" | "reinstate" | "dismiss"
/** An immutable moderation-action record. */
export interface AuditLogRecord {
  id: string
  org_id: string
  action: AuditAction
  artifact_id: string | null
  /** Who acted: a user/agent display name, or "system" for an anonymous report. */
  actor: string
  detail: string | null
  created_at: string
}
export interface NewAuditLog {
  id: string
  org_id: string
  action: AuditAction
  artifact_id?: string | null
  actor: string
  detail?: string | null
}

/** One cover in a collection's preview strip: enough to render a captioned thumbnail,
 *  order the strip, and attribute the work — and nothing more. */
export interface CollectionPreview {
  id: string
  short_id: string
  title: string | null
  current_version: number
  updated_at: string
  /** Whether the current version has a ready static render, so the strip can serve a
   *  PNG instead of mounting an iframe (the same choice artifact cards make). */
  has_preview: boolean
  /** Who last touched it — the denormalized byline the artifact row already carries,
   *  plus the author's user id so the caller can heal the name to the person's CURRENT
   *  one (the denormalized name is the publishing client — "Claude Code (derive)" — for
   *  agent publishes; the id is the human it acted for). */
  author_id: string | null
  author_name: string | null
  author_login: string | null
  author_avatar: string | null
}

/** Who is looking, for the per-user arms of the collections read: the star list, the
 *  worked-in window, and the preview strip. Passing it is what folds three extra round
 *  trips into the one statement the overview already runs. */
export interface CollectionsViewer {
  userId: string
  /** ISO cutoff for "recently worked in" (see collectionsWorkedIn). */
  activeSince: string
  /** Covers per collection. */
  previewPer: number
}

/** A whole takedown as one unit: the artifact + workspace it targets, the
 *  tombstone timestamp, and the audit entry to record — applied atomically by
 *  {@link MetaStore.takedownArtifact}. */
export interface TakedownInput {
  artifactId: string
  orgId: string
  removedAt: string
  audit: NewAuditLog
}

/**
 * A registered agent: a mentionable principal that acts through a scoped token.
 * Default role is commenter, so an agent can read and comment but never publish
 * directly. Treated like a member of the workspace.
 */
export interface AgentRecord {
  id: string
  org_id: string
  name: string
  token: string
  role: Role
  /** The user who registered the agent — who it publishes on behalf of.
   *  Null for pre-column agents (they publish as themselves). */
  created_by: string | null
  /** 1 = served by Derive's managed executor. Hosting changes where the agent
   *  runs, never its principal, role cap, or attribution. */
  hosted: 0 | 1
  /** 1 = auto-minted for one context at creation — the context's Derive access,
   *  not a user-named persona. Hidden from the roster UI. */
  managed: 0 | 1
  /** Runs-lane liveness (twin of ContextRecord.runner_seen_at): when this agent's
   *  bearer last polled the run claim endpoint. Null = no executor, ever — the
   *  honesty signal behind the "No executor" badge. */
  runs_seen_at: string | null
  created_at: string
}
export interface NewAgent {
  id: string
  org_id: string
  name: string
  token: string
  role: Role
  created_by?: string | null
  hosted?: 0 | 1
  managed?: 0 | 1
}

// ---- Automations + runs: the generic agent-work primitive --------------
// Two tables, industry-standard: a DEFINITION (what to run, and the rule for when) and its
// EXECUTIONS (each firing, with state + result — the queue and the ledger in one table,
// pg-boss's model). Living-doc refresh, a scheduled digest, an event-driven update, an
// ad-hoc "run once" are all rows here with different triggers and instructions.

export type TriggerKind = "manual" | "schedule" | "event"

/** How an automation fires. Open-ended JSON on the row — a new kind adds no columns. */
export interface AutomationTrigger {
  kind: TriggerKind
  /** schedule: a 5-field cron. */
  cron?: string
  /** schedule: an IANA timezone. */
  tz?: string
  /** event: the event name (e.g. "comment.opened", "upstream.published", "webhook"). */
  on?: string
  /** event/webhook: sha256 of the fire secret. The raw secret rides only the create
   *  response that mints it; the fire endpoint verifies a presented bearer against this
   *  hash. Never surfaced on read — redacted to a boolean when an automation is presented. */
  secret_hash?: string
}

/** A standing agent job: WHAT to do (instruction), WHO does it (agent), and the rule for
 *  WHEN (trigger). The definition only — every firing is a `run`. A "living artifact" is
 *  just an automation whose instruction is "keep this current" with a ref to the doc. */
export interface AutomationRecord {
  id: string
  org_id: string
  /** The agent that runs it — the runs act as this principal. */
  agent_id: string
  /** Serialized AutomationTrigger (JSON text); parse with parseTrigger. */
  trigger: string
  /** Free-form: what the agent should do. */
  instruction: string
  /** The coding-agent runtime this automation executes with. */
  provider: import("./execution").ExecutionProvider
  /** Serialized inputs/targets (artifact ids, urls, arbitrary), or null. */
  refs: string | null
  /** Serialized JSON array of bound connection ids — the SOURCES a run may read from. A run
   *  gets the tools of these connections only (least privilege); null = no sources. */
  connection_ids: string | null
  /** The context this automation runs AS, or null. Bound, the run materializes that context's
   *  manifest + skills — a scheduled use(context, instruction). */
  context_id: string | null
  enabled: 0 | 1
  created_at: string
}

export interface NewAutomation {
  id: string
  org_id: string
  agent_id: string
  trigger: string
  instruction: string
  provider?: import("./execution").ExecutionProvider
  refs?: string | null
  connection_ids?: string | null
  context_id?: string | null
  enabled?: 0 | 1
}

/** How a run's work landed — the semantic outcome, kept in the run's meta blob (not a
 *  column). A run writes (`published`) or answers; `escalated` is the ask lane's
 *  hand-to-a-human terminal. */
export type RunOutcome = "answered" | "published" | "escalated"

/** A run's execution state. queued = pending work in the queue; a terminal state = history
 *  in the ledger. The same table serves both. */
export type RunStatus = "queued" | "running" | "succeeded" | "failed"

/** One execution of an automation (or an ad-hoc one-off). The queue and the ledger in one
 *  table: a worker claims the oldest queued run due now, runs it, and finishes it. Cost is
 *  snapshotted at finish (micro-USD, integer). */
export interface RunRecord {
  id: string
  org_id: string
  /** The automation that produced it, or null for an ad-hoc run. */
  automation_id: string | null
  agent_id: string
  /** What fired it: "manual:<userId>", "schedule", "event:<name>" (free text). */
  reason: string
  /** The person whose action fired it — the WALLET key (their plan bills the run).
   *  Null = a clock or event started it (no person), which resolves to the
   *  registrant today and the workspace pool once it lands. First-class on
   *  purpose: `reason` is display text, never a resolution key. */
  initiated_by: string | null
  status: RunStatus
  /** When it should run (queue time); claimed once this is <= now. Null = as soon as possible. */
  scheduled_for: string | null
  started_at: string | null
  finished_at: string | null
  cost_micro_usd: number | null
  /** Serialized meta (model, tokens, outcome, refs, anything), or null. */
  meta: string | null
  created_at: string
}

export interface NewRun {
  id: string
  org_id: string
  automation_id?: string | null
  agent_id: string
  reason: string
  /** The initiating person (wallet key); omit for clock/event runs. */
  initiated_by?: string | null
  /** Defaults to "queued". */
  status?: RunStatus
  scheduled_for?: string | null
  started_at?: string | null
  finished_at?: string | null
  cost_micro_usd?: number | null
  meta?: string | null
}

/** What a plan pays for: the model (thinking) or the tool broker (hands). */
export type PlanKind = "model" | "broker"

/** A bring-your-own plan: an owner attaches their own model or broker credential, and runs
 *  meter against it. `user_id` set = a person's personal plan; null = the workspace pool
 *  (the fallback when a run's owner has no personal plan of that kind). The platform holds
 *  the gate and the ledger, never the meter. */
export interface PlanRecord {
  id: string
  org_id: string
  /** Owner of a personal plan, or null for the workspace pool. */
  user_id: string | null
  kind: PlanKind
  /** Provider slug, e.g. "anthropic" | "openai" | "composio". */
  provider: string
  /** The API key/secret, encrypted at rest. Never surfaced on read. */
  secret_enc: string
  /** Serialized limits (JSON), e.g. {"monthlyMicroUsd":N}, or null for unmetered. */
  limits: string | null
  created_at: string
}

export interface NewPlan {
  id: string
  org_id: string
  user_id?: string | null
  kind: PlanKind
  provider: string
  secret_enc: string
  limits?: string | null
}

/** A connected external account's lifecycle. active once authorized; pending during the OAuth
 *  round trip; revoked when torn down. */
export type ConnectionStatus = "active" | "pending" | "revoked"

/** Who a connection belongs to. "personal" = one person's account, only they may bind it
 *  to a context/automation, and it stops resolving the moment they leave the workspace.
 *  "workspace" = org infrastructure (admin-managed), survives any one member leaving. */
export type ConnectionScope = "personal" | "workspace"

/** How a connection authenticates. Everything but "oauth" is DIRECT: Derive holds the
 *  credential and makes the call itself, so a run only ever sees tool names.
 *
 *  oauth       a broker-side connected account; broker_ref points at the vendor.
 *  secret      a pasted API key / bearer token, encrypted at rest and write-only after.
 *  github_app  no stored credential — broker_ref is the App installation id, and a
 *              least-privilege short-lived token is minted per call.
 *  slack       no stored credential — the workspace's existing bot install provides it.
 */
/** How a connection authenticates, and therefore who spends its credential.
 *
 *  `mcp` is the odd one out and deliberately so: it is broker-executed like `oauth`, but it
 *  carries its own server URL in its ref and its own bearer in `secret_enc`, so it needs no
 *  vendor account and no broker plan. It is NOT a direct kind — Derive does not make its HTTP
 *  call itself — and it has no vendor side to revoke. */
export type ConnectionKind = "oauth" | "secret" | "github_app" | "slack" | "mcp"

/** A per-user connected external account (WO3): the owner authorized Derive's broker to act on
 *  their Gmail/Stripe/GitHub/etc. Always bound to ONE person (identity never falls back), and
 *  scoped least-privilege per toolkit. A hosted run sees the tools of its bound connections
 *  only; the BYO path never touches these. */
export interface ConnectionRecord {
  id: string
  org_id: string
  /** Who ADDED it. For scope "personal" this is the owner (identity never falls back);
   *  for scope "workspace" it is provenance only ("added by Rob") — the credential is
   *  the workspace's and is admin-managed. */
  user_id: string
  /** personal (default) = act-as-me, owner-bound. workspace = org infrastructure. */
  scope: ConnectionScope
  /** oauth (default) = broker-connected account; secret = pasted credential. */
  kind: ConnectionKind
  /** kind "secret" only: the credential, AES-GCM encrypted. Never presented by any route —
   *  it is spent server-side by the tool proxy and read nowhere else. */
  secret_enc: string | null
  /** kind "secret" only: the HTTPS base every tool call resolves under, and is confined to. */
  base_url: string | null
  /** Broker provider slug: "local" | "composio". */
  broker: string
  /** Toolkit slug, e.g. "gmail" | "stripe" | "github". */
  toolkit: string
  /** Broker-side connected-account id. */
  broker_ref: string
  /** Human label of the granted scopes, or null. Display only — for kind "secret" it doubles
   *  as the credential hint (the pasted key's last 4), which is all a read ever gets. */
  scopes_label: string | null
  status: ConnectionStatus
  created_at: string
}

export interface NewConnection {
  id: string
  org_id: string
  user_id: string
  scope?: ConnectionScope
  kind?: ConnectionKind
  secret_enc?: string | null
  base_url?: string | null
  broker: string
  toolkit: string
  broker_ref: string
  scopes_label?: string | null
  status?: ConnectionStatus
}

export type AgentMentionState = "pending" | "done"
/** Why an agent was woken. A direct mention is an explicit request; a thread reply is the
 * answer to work the agent already started. Keeping the distinction lets a client resume the
 * right turn without guessing from prose. */
export type AgentMentionKind = "mention" | "thread_reply"
/** A queued request for an agent's pull inbox (denormalized for a cheap read). */
export interface AgentMentionRecord {
  id: string
  agent_id: string
  artifact_id: string
  artifact_short_id: string
  comment_id: string
  thread_id: string
  /** The body of the comment that mentioned the agent. */
  body: string
  /** Who mentioned it. */
  author: string
  kind: AgentMentionKind
  state: AgentMentionState
  created_at: string
}
export interface NewAgentMention {
  id: string
  agent_id: string
  artifact_id: string
  artifact_short_id: string
  comment_id: string
  thread_id: string
  body: string
  author: string
  /** Omitted by old callers; the store default preserves the pre-thread-reply meaning. */
  kind?: AgentMentionKind
}

/**
 * A pending workspace invitation: an email invited to join a workspace at a role,
 * redeemable via an emailed link before it expires. Distinct from a membership (which
 * requires an existing account) — this is how you bring in someone who hasn't signed up
 * yet. The token is stored hashed (like agent tokens); accepting it creates the membership.
 */
export interface InvitationRecord {
  id: string
  org_id: string
  /** Normalized (lowercased) invitee email. */
  email: string
  role: Role
  /** SHA-256 of the redeem token (the raw token only ever rides the emailed link). */
  token: string
  /** The Admin who sent it; null if their account was later removed. */
  invited_by: string | null
  created_at: string
  expires_at: string
  /** Set once redeemed; a non-null value means the invite is spent. */
  accepted_at: string | null
}
export interface NewInvitation {
  id: string
  org_id: string
  email: string
  role: Role
  token: string
  invited_by?: string | null
  expires_at: string
}

/**
 * Where a signup came from. One row per user, recorded by the
 * short, explicit signup URL handoff; first write wins. Organic signups have no row.
 */
export interface SignupAttributionRecord {
  id: string
  /** The Better Auth user this attribution belongs to (no FK; auth owns its tables). */
  user_id: string
  /** The explicit account handoff: a public CTA (badge, comment_wall,
   *  make_your_own), sign-in link, or campaign token (hn-launch, …). */
  source_kind: string
  /** The artifact (short id) the sourcing surface lived on, when known. */
  source_artifact: string | null
  /** Coarse path of the public surface that linked to signup. */
  landing_path: string | null
  /** Referrer host at stamp time. */
  referrer: string | null
  created_at: string
}

export type NewSignupAttribution = Omit<SignupAttributionRecord, "created_at">

/** One workspace's Stripe subscription state, webhook-fed; Stripe is the source
 *  of truth and this row is the local cache the request-path gate reads. A row
 *  with a null stripe_subscription_id and status "incomplete" is a checkout
 *  stub (customer created, nothing paid yet) and grants nothing. */
export interface SubscriptionRecord {
  org_id: string
  stripe_customer_id: string
  stripe_subscription_id: string | null
  tier: "team" | "business"
  billing_interval: "month" | "year"
  /** Stripe's subscription status, verbatim (active, trialing, past_due, canceled, ...). */
  status: string
  quantity: number
  current_period_end: string | null
  created_at: string
  updated_at: string
}

/**
 * A pending per-artifact share invitation: an email invited to one artifact at a
 * role, redeemable via an emailed link before it expires. The share-to-a-stranger
 * path — a per-artifact membership needs an existing account, so this carries the
 * grant until they sign up. Token stored hashed; accepting creates the
 * artifact_member row (never a workspace membership).
 */
export interface ArtifactInviteRecord {
  id: string
  artifact_id: string
  /** Normalized (lowercased) invitee email. */
  email: string
  role: Role
  /** SHA-256 of the redeem token (the raw token only ever rides the emailed link). */
  token: string
  /** Who sent it; null if their account was later removed. */
  invited_by: string | null
  created_at: string
  expires_at: string
  /** Set once redeemed; a non-null value means the invite is spent. */
  accepted_at: string | null
}
export interface NewArtifactInvite {
  id: string
  artifact_id: string
  email: string
  role: Role
  token: string
  invited_by?: string | null
  expires_at: string
}

/** Collection counterpart to ArtifactInviteRecord. Separate storage preserves
 *  each subject's foreign-key lifecycle; the API/UI share the invite behavior. */
export interface CollectionInviteRecord {
  id: string
  collection_id: string
  email: string
  role: Role
  token: string
  invited_by: string | null
  created_at: string
  expires_at: string
  accepted_at: string | null
}
export interface NewCollectionInvite {
  id: string
  collection_id: string
  email: string
  role: Role
  token: string
  invited_by?: string | null
  expires_at: string
}

/** A review round's lifecycle. `pending` = the agent asked and is waiting;
 *  `sent_back` = the human returned their answers (the poll target — a note that
 *  reads "good to go" IS the go-signal). One pending round per person. */
export type ReviewRoundState = "pending" | "sent_back"

export interface ReviewRoundRecord {
  id: string
  artifact_id: string
  /** The version the review was requested on. */
  version: number
  /** Stable id of the requester (the agent). */
  requested_by: string
  /** The user asked to review (the grant owner for an OAuth agent). */
  requested_for: string
  state: ReviewRoundState
  /** Optional message from the requester, or the human's send-back note. */
  note: string | null
  /** Stable identity of the human who settled the round. */
  resolved_by: string | null
  /** Snapshot name of the resolver, retained so history stays legible. */
  resolved_by_name: string | null
  created_at: string
  resolved_at: string | null
}

export interface NewReviewRound {
  id: string
  artifact_id: string
  version: number
  requested_by: string
  requested_for: string
  note?: string | null
}

/**
 * A context: a named, askable agent setup — the registered agent that runs it
 * linked to the manifest artifact that defines it (instructions, referenced docs,
 * connection definitions). The manifest is a normal versioned artifact, so
 * sharing, review, and history come from the artifact machinery; v1's ask grant
 * is "viewer on the manifest". Credentials are never part of a context — they
 * live wherever its runner executes.
 */
export interface ContextRecord {
  id: string
  org_id: string
  name: string
  /** The registered agent that answers this context's sessions (plain column —
   *  an agent row may be deleted out from under a context; the queue just goes
   *  quiet until a new agent is wired). */
  agent_id: string
  /** The versioned definition. Hard FK: a context cannot outlive its manifest. */
  manifest_artifact_id: string
  created_by: string
  created_at: string
  /** When the runner last polled the queue (ISO), throttle-stamped there — the
   *  console's liveness signal. Null = never polled (or a pre-column row). */
  runner_seen_at: string | null
  /** Who in the workspace may ASK — `workspace` (any member) or `invited` (the
   *  context_asker roster + the creator). NEVER the manifest's artifact access:
   *  a context is workspace-scoped by construction, with no world-link/public
   *  path. Workspace membership is the hard floor regardless (the ask gate). */
  ask_policy: "workspace" | "invited"
  /** Per-run wall-clock budget in ms; null = the server's default run budget. */
  max_run_ms: number | null
  /** How many sessions the runner may work in parallel on this context (>= 1). */
  max_concurrency: number
  /** Opaque JSON sidecar, parsed only at the route layer (like session_message.meta)
   *  — the store never reads it. Null until the owner sets one. */
  config: string | null
  /** Connections this context may use, as a JSON array of ids (same shape as
   *  automation.connection_ids). Null = no tools. */
  connection_ids: string | null
}
export interface NewContext {
  id: string
  org_id: string
  name: string
  agent_id: string
  manifest_artifact_id: string
  created_by: string
  /** Defaults to `invited` (creator-only) when omitted (the store default). */
  ask_policy?: "workspace" | "invited"
  /** Per-run budget in ms; omitted → the server default (stored null). */
  max_run_ms?: number | null
  /** Parallel sessions the runner may work; omitted → 1 (the column default). */
  max_concurrency?: number
  /** Opaque JSON sidecar; omitted → null. */
  config?: string | null
  /** JSON array of connection ids the context may use; omitted → null. */
  connection_ids?: string | null
}
export interface ContextAskerRecord {
  id: string
  context_id: string
  user_id: string
  added_by: string
  created_at: string
}
export interface NewContextAsker {
  id: string
  context_id: string
  user_id: string
  added_by: string
}

/** A session's lifecycle. `state` also encodes whose turn it is: `open` means the
 *  runner owes a reply (the queue predicate); `working` = a runner has claimed and
 *  is answering it (leased, so overlapping runners don't double-run); an asker
 *  follow-up on an `answered` session flips it back to `open`. `escalated` = the
 *  runner filed its draft for the owner's approval; `failed` = the run crashed
 *  (surfaced, never auto-retried); `closed` = the asker or owner ended it. */
export type SessionState = "open" | "working" | "answered" | "escalated" | "failed" | "closed"

/** Who wrote a session message: the human asking, or the context's agent. */
export type SessionMessageAuthor = "asker" | "agent"

/** One ask-conversation with a context, on behalf of one asker. Private to the
 *  asker and the context owner — session content is bounded by whatever the
 *  runner's credentials can reach, so it never gets artifact-style visibility. */
export interface SessionRecord {
  id: string
  /** The packaged agent answering, or NULL when the default agent is (chat with a document
   *  needs no context). A context is how you opt INTO a packaged agent. */
  context_id: string | null
  org_id: string
  asker_id: string
  /** The manifest version the session started against (provenance); null with no context. */
  context_version: number | null
  state: SessionState
  created_at: string
  /** Bumped on every message/state change; null until then (read as ?? created_at). */
  updated_at: string | null
  /** When a runner first claimed this session (ISO); null while still `open`. */
  started_at: string | null
  /** The claim lease expiry (ISO); once it lapses another claim may reclaim a
   *  `working` session (crash recovery). Null while unclaimed. */
  lease_until: string | null
  /** The short_id of the artifact the run produced, if any (soft ref — the
   *  artifact may be deleted out from under the session). Null until set. */
  result_artifact_id: string | null
  /** Optional idempotency key; the partial-unique index keeps at most one live
   *  (open|working) session per (context, dedupe_key). Null = not deduped. */
  dedupe_key: string | null
  /** What this session is ABOUT, as a JSON-encoded `Selector` — the same shape
   *  `automation.refs` stores, so one address type serves both lanes. Read it with
   *  `parseSubject`. Null = a plain ask with no subject, which is every session
   *  opened before this column existed. */
  subject_ref: string | null
}

/** One artifact a context has produced, grouped across every session that bound it —
 *  the row behind the console's Output tab. Carries no title or version on purpose:
 *  those come from resolving `short_id` through the normal visibility-gated artifact
 *  read, so an output can never show a viewer a document they cannot open. */
export interface ContextOutput {
  short_id: string
  /** How many of this context's sessions bound this artifact as their result. */
  runs: number
  /** The most recent of those sessions' last activity (its `updated_at`). */
  last_run_at: string
}

export interface NewSession {
  id: string
  context_id?: string | null
  org_id: string
  asker_id: string
  context_version?: number | null
  /** Optional idempotency key; when set, a matching in-flight session is reused. */
  dedupe_key?: string | null
  /** JSON-encoded `Selector`; null/absent for a plain ask. */
  subject_ref?: string | null
}

export interface SessionMessageRecord {
  id: string
  session_id: string
  author_kind: SessionMessageAuthor
  /** The asker's user id, or the agent's id — stable identity, like comment.author_id. */
  author_id: string
  body_md: string
  /** JSON blob: the runner's { query?, confidence?, caveats?, escalation_reason?,
   *  artifacts? } plus the server-stamped `stale` (an answer superseded by a
   *  mid-run follow-up — the runner's re-serve filter keys on it). TEXT like
   *  comment.meta — parsed at the route layer, never by the store. */
  meta: string | null
  created_at: string
}
export interface NewSessionMessage {
  id: string
  session_id: string
  author_kind: SessionMessageAuthor
  author_id: string
  body_md: string
  meta?: string | null
}

/** A GitHub commit author, denormalized onto an artifact / stored per version.
 *  `name` is the display name; `login`/`avatar` are the GitHub handle + avatar URL;
 *  `ghId` is the numeric GitHub user id as a string (matches account.accountId). Any
 *  field may be null when GitHub can't map the commit email to an account. */
export interface GithubAuthor {
  name: string | null
  login: string | null
  avatar: string | null
  ghId: string | null
}

/** A GitHub numeric user id resolved to the Derive account that signed in with it
 *  (Better Auth `account` joined to `user`). `username` is the public handle. */
export interface GithubUserMapping {
  gh_id: string
  id: string
  name: string | null
  image: string | null
  username: string | null
}

/** A person, as needed for sharing UIs. Sourced from Better Auth's user table. */
export interface UserDir {
  id: string
  /** Internal only (server-side @mention search by email prefix). Never serialize
   *  to clients — surfaces identify people by `username`, not email. */
  email: string
  /** Public handle. Every account has one (auto-assigned at creation); null only
   *  for a legacy row not yet backfilled. This is what the API exposes. */
  username: string | null
  name: string | null
  /** Profile picture URL (set by OAuth providers; null for password signups). */
  image: string | null
  /** Coarse team role (Product / Engineering / Design / Marketing / …); null if unset. */
  profession?: string | null
  /** One-line "what you do" blurb; null if unset. */
  about?: string | null
}

/** A public profile, keyed by handle. Email is intentionally absent — it stays
 *  private; the handle is the public identifier (Profiles & Accounts v1). */
export interface UserProfile {
  id: string
  username: string
  name: string | null
  image: string | null
  /** Coarse team role; null if unset. Shown on the public profile + people search. */
  profession?: string | null
  /** One-line "what you do" blurb; null if unset. */
  about?: string | null
  /** Findable in the People directory AND profile-visible to strangers. False hides
   *  the profile from everyone but workspace-mates; unset/null reads as true (the
   *  pre-column accounts). SQLite/D1 store it as 0/1, so number rides along. */
  discoverable?: boolean | number | null
}

/** `mention`/`comment`/`share` are artifact-anchored. `follow` (someone followed you)
 *  and `publish` (someone you follow published) are the social kinds — `follow` carries
 *  no artifact (its artifact_* fields are ""), `publish` points at the new artifact.
 *  `review` is the /derive loop: your agent published and asked for your review. */
export type NotificationKind = "mention" | "comment" | "share" | "follow" | "publish" | "review"
export interface NotificationRecord {
  id: string
  user_id: string
  actor: string
  kind: NotificationKind
  artifact_id: string
  artifact_short_id: string
  artifact_title: string | null
  thread_id: string
  comment_id: string
  preview: string
  read: 0 | 1
  created_at: string
}
export interface NewNotification {
  id: string
  user_id: string
  actor: string
  kind: NotificationKind
  artifact_id: string
  artifact_short_id: string
  artifact_title: string | null
  thread_id: string
  comment_id: string
  preview: string
}

/** The workspace itself — a display name keyed by org_id (one row). */
export interface WorkspaceRecord {
  id: string
  name: string
  created_at: string
}

export interface MembershipRecord {
  id: string
  org_id: string
  user_id: string
  role: Role
  created_at: string
}
export interface NewMembership {
  id: string
  org_id: string
  user_id: string
  role: Role
}

export interface CollectionRecord {
  id: string
  org_id: string
  title: string
  created_by: string
  created_at: string
  /** The collection's own share experience — same vocabulary as an artifact's
   *  workspace_access, no link_role/listed (a collection isn't individually
   *  link-servable content). `member` = every workspace member reaches it at
   *  their seat role; `none` = invite-only (collectionMember rows only). */
  workspace_access: WorkspaceAccess
  /** What merely holding the canonical collection URL grants. */
  link_role: LinkRole
  /** Salted hash that gates only the collection's world-link grant. */
  password_hash: string | null
  /** The org-shared folder this collection is filed under (null = ungrouped). Pure
   *  organization — never consulted by any auth path. See FolderRecord. */
  folder_id: string | null
}
export interface NewCollection {
  id: string
  org_id: string
  title: string
  created_by: string
  /** Omitted falls to the store's column default (`member`, unlike an artifact's
   *  fail-closed `none` — see CollectionRecord.workspace_access). */
  workspace_access?: WorkspaceAccess
  link_role?: LinkRole
  password_hash?: string | null
}

/** A folder that organizes ONE collection's artifacts (Collection → Folder → artifacts).
 *  It inherits the collection's access and grants nothing of its own — never in any auth
 *  path. Items are filed via collection_item.folder_id. `collection_id` is app-required
 *  (nullable at the DB only for an additive migration). */
export interface FolderRecord {
  id: string
  org_id: string
  collection_id: string | null
  name: string
  created_by: string
  created_at: string
}
export interface NewFolder {
  id: string
  org_id: string
  collection_id: string
  name: string
  created_by: string
}
export interface DomainRecord {
  host: string
  /** The artifact this host serves at its root; null for a workspace domain. */
  artifact_id: string | null
  org_id: string
  kind: DomainKind
  status: DomainStatus
  /** The Cloudflare custom-hostname id, for status refresh + teardown (custom only). */
  cf_hostname_id: string | null
  /** JSON-encoded DNS records the customer must add to validate (custom, while pending). */
  verification: string | null
  /** When set, the host answers 302 → this absolute URL instead of serving content
   *  (a claimed draft's derive.page URL forwarding to its permanent home). */
  redirect_to: string | null
  created_at: string
}
export interface NewDomain {
  host: string
  /** Bind to an artifact (subdomain / per-artifact custom); omit for a workspace domain. */
  artifact_id?: string | null
  org_id: string
  kind: DomainKind
  status?: DomainStatus
  cf_hostname_id?: string | null
  verification?: string | null
}
export interface CollectionMemberRecord {
  id: string
  collection_id: string
  user_id: string
  role: Role
  created_at: string
}
export interface NewCollectionMember {
  id: string
  collection_id: string
  user_id: string
  role: Role
}

/** The instance's GitHub App credentials (single row, id = "default"), captured
 *  via the one-click manifest flow. The three secret columns are encrypted at
 *  rest by the route layer before they reach the store. */
/** Per-workspace integration switches: each channel behaviour the workspace can turn
 *  on or off. Stored as one JSON row per org; absent keys fall back to the defaults
 *  below (everything on), so connecting an integration "just works" until toggled. */
export interface OrgSettings {
  /** Send notification emails on comments/mentions. */
  emailNotifications: boolean
  /** Post Derive comment activity to the connected Slack workspace (the thread mirror). */
  /** The access a NEW publish lands with when the publisher doesn't say (see
   *  access-model.md). Factory default is the "team draft": `workspace_access =
   *  member` (a pasted link opens for a teammate or an on-behalf agent at their
   *  seat role), `link_role = none` (the world is out), `listed = none` (nothing
   *  in a feed until promoted). Changing these never retroactively touches
   *  existing artifacts. */
  defaultWorkspaceAccess: WorkspaceAccess
  defaultLinkRole: LinkRole
  defaultListed: Listed
  /** White-label shared surfaces: hide the Made-with-Derive marks (public-viewer
   *  footer, embed plaque) and honor the bare `?chrome=none` embed. The Team-tier
   *  affordance; free workspaces keep the badge and the bare embed is ignored. */
  whiteLabel: boolean
  /** Master switch for Derive-hosted agent runs in this workspace. Off silences every
   *  hosted run (the managed executor skips the workspace); owner-run agents are
   *  unaffected. */
  hostedAgentsEnabled: boolean
  /** BETA: chat with a document (the right-rail Chat tab). OFF by default — unlike every
   *  other setting here, it is now ON by default: the surface shipped, and an opt-in nobody
   *  finds is a feature nobody has. Setting it FALSE still turns chat off completely — the tab
   *  does not render and the chat routes refuse — so a half-enabled state cannot leave someone
   *  typing into a panel that will never answer. On a shared host DERIVE_CHAT_ALLOWLIST still
   *  bounds WHICH workspaces may spend the operator's model key. */
  chatBeta: boolean
  /**
   * WHICH CONNECTIONS CHAT MAY REACH. Connection ids, declared by an admin.
   *
   * A packaged run DECLARES the connections it may touch, so a Stripe-bound run sees Stripe
   * tools and nothing else. A conversation has no such declaration — somebody types a sentence
   * and the agent decides what to do — so handing it every connection in the workspace would be
   * a far larger blast radius than any run gets, granted by nobody in particular.
   *
   * This is that missing declaration, made once by the person who owns the credential rather
   * than continuously by the person typing. EMPTY BY DEFAULT: chat reaches no source until
   * somebody says which, so connecting a server never silently widens what chat can do.
   *
   * It is the ONLY binding control. Cross-source exfiltration — content read from one source
   * telling the agent to call another with private data — is not a write-posture problem and no
   * publish rule catches it; this list is what bounds it.
   */
  chatSources: string[]
  /**
   * WHICH MODEL chat answers with, set live by an admin — the outage lever.
   *
   * The deploy's default lives in configuration and therefore needs a redeploy to change, which
   * is the wrong shape for the case it is most needed in: a provider that has gone slow or dark
   * while people are typing. This is the same choice held where it can be changed in seconds.
   *
   * A catalog id (namespaced for a named gateway, e.g. `openrouter:deepseek/...`). Unset ⇒ the
   * deploy default, exactly as before. An id naming nothing is IGNORED rather than fatal — a
   * typo here must cost the override, never every turn in the workspace.
   */
  chatModel?: string
  /** BETA: automations (the artifact's "Automate…" surface). Same shape and same reasoning as
   *  {@link chatBeta}, and separate from it because they are different bets: chat is attended
   *  and answers in the request, an automation runs unattended on a trigger and can write while
   *  nobody is watching. Off means the entry point does not render and the create/run/fire lanes
   *  refuse, so a workspace cannot queue work that will never be executed. */
  automateBeta: boolean
  /** THE one agent-write switch, read fresh per turn/claim/publish. On (the default),
   *  agent writes publish live like a person's — versioned, with the publish fan-out,
   *  and a review round when one was asked for. Off, agents stop writing everywhere an
   *  agent credential can write: hosted runs and asks are neither materialized,
   *  dispatched, nor claimed (no model spend), chat's publish tool refuses and steers
   *  the drafted change into the reply, and an agent-credentialed publish — MCP or
   *  HTTP — is refused at the API. Every reader fails CLOSED on a settings error. */
  agentWrites: boolean
  /** The workspace's default agent (a registered agent id): the fallback actor for
   *  users with no connected agent (the concierge, workspace-owned living docs).
   *  Absent = none. */
  defaultAgentId?: string
  /** The workspace's Brandprint: a conventions collection agents pull as context, plus
   *  the generated brand profile. Absent until set. Mirrored on a profile (user layer);
   *  resolved profile-over-workspace. */
  brandprint?: Brandprint
  /** Per-agent owner-lend allow-list: agent ids whose OWNER (created_by) has opted that
   *  agent in to bill the owner's OWN connected model plan when a run's initiator has no
   *  plan of their own. Default absent = off. Only the agent's owner toggles membership;
   *  the credential resolver falls to the owner's plan for a listed agent, then the
   *  workspace pool, then fail-closed. */
  ownerLendAgents?: string[]
  /**
   * THE MODEL LIBRARY. Deploy-scoped, and read on the reserved `__instance__` settings row
   * ONLY — a workspace's own settings never carry it (see lib/instance-settings.ts).
   *
   * Models the operator added on top of the ones configured in the environment. Same gateway,
   * same key, so a model here is DATA: `DERIVE_MODEL_NAMES` needs a redeploy to change, and a
   * provider going slow is exactly the moment nobody can afford one. A genuinely different
   * provider is a different credential and therefore still environment + a deploy — this list
   * cannot express one, deliberately, because a model id with no key behind it is a 401 per
   * turn.
   *
   * Absent = the environment's catalog alone, exactly as before this existed.
   */
  models?: InstanceModel[]
  /**
   * WHICH MODEL SERVES WHICH LANE. Instance row only, same as {@link models}.
   *
   * Lanes rather than one default, because they answer different questions on different
   * budgets: `chat` is attended and somebody is waiting on the first token, while `automation`
   * runs unattended where depth is worth more than turnaround. Both used to be pinned in the
   * environment (`DERIVE_MODEL_NAME`, `DERIVE_LOOP_MODEL`), which put a redeploy between an
   * operator and an outage.
   *
   * An id naming nothing in the catalog is IGNORED, not fatal — a slot that has gone stale
   * costs the override, never every turn on the deploy.
   */
  slots?: InstanceSlots
  /** Optimistic-concurrency revision for the reserved instance row. Ordinary workspace settings
   *  do not use it. Absent is revision zero, preserving rows written before live model updates. */
  settingsRevision?: number
}

/** One model in the library: the provider's own id, an optional display override, and what the
 *  last probe found. The probe rides the entry it describes rather than sitting in a parallel
 *  table — there is exactly one last-known-good per model, and it is meaningless without it. */
export interface InstanceModel {
  /** The provider's model id, exactly as it names it. The stable, public handle: a stored
   *  transcript and an operator's picker both carry it. */
  id: string
  /** Display override. Absent = the id's readable tail, which is what the catalog derives. */
  label?: string
  /** The last probe, or absent if it has never been probed. */
  probe?: ModelProbe
}

/** What a probe found: whether the model answered, and how long it took to. Both numbers,
 *  because they measure different failures — a model can start fast and then grind, or think
 *  for six seconds and finish instantly, and only one of those is felt as slow in chat. */
export interface ModelProbe {
  /** When it ran (ISO). Stale probe data is worse than none if you cannot see its age. */
  at: string
  ok: boolean
  /** Time to the FIRST token, ms. Null when the adapter did not stream (the probe still
   *  reports a total). This is the number that predicts how a chat turn feels. */
  ttftMs: number | null
  /** Wall time for the whole call, ms. Null only when the call never returned. */
  totalMs: number | null
  /** Why it failed, in the provider's own words, trimmed. Absent when ok. */
  error?: string
}

/** The lanes a model can be pinned to. A lane with no entry falls to the deploy's configured
 *  default for that lane, which is what every deploy predating the library has. */
export interface InstanceSlots {
  /** Attended chat, and an @Derive mention. Falls back to `DERIVE_MODEL_NAME`. */
  chat?: string
  /** Unattended automation runs on the in-process loop. Falls back to `DERIVE_LOOP_MODEL`,
   *  then to model-anthropic's DEFAULT_ANTHROPIC_MODEL.
   *
   *  🚨 THIS NAMES THE MODEL, NOT WHO PAYS. The automation lane resolves a credential per run
   *  through the payer chain unless the operator configured a gateway, so pinning a model here
   *  moves no turn onto the operator's key. */
  automation?: string
}

/** How a workspace/profile likes its stuff built: a pointer to a "conventions"
 *  collection (docs/skills agents read) and, at workspace scope, the generated brand
 *  profile. */
export interface Brandprint {
  /** Collection of convention artifacts (the Brandprint docs). */
  collectionId?: string
  /** short_id of the workspace's brand-profile artifact — the one self-contained HTML
   *  page the user's agent generates from the source docs. Version 1 is always the
   *  intake's stub (`profileState` derives live/pending from that). Workspace-only: a
   *  personal Brandprint never sets it. */
  profileId?: string
  /** Personal-layer only: false turns the WORKSPACE Brandprint off for this user
   *  (their agents skip the org's conventions and profile; a personal collection
   *  above still applies). Absent or true: the workspace layer applies. A
   *  workspace's own settings never carry this field. */
  useWorkspaceBrandprint?: boolean
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  emailNotifications: true,
  defaultWorkspaceAccess: "member",
  defaultLinkRole: "none",
  defaultListed: "none",
  whiteLabel: false,
  // Hosting on by default: it does nothing until an agent is flagged hosted, and
  // the run-time safety is the loop itself — every write is a kept version with the
  // publish fan-out, restore is one click, and `agentWrites` is the brake.
  hostedAgentsEnabled: true,
  // Chat is ON by default now: it left beta, and an opt-in that everybody has to find is a
  // feature nobody uses. Explicitly setting it FALSE still turns it off, so a workspace that
  // does not want it keeps that. Automations stay opt-in — they run unattended and can write
  // while nobody is watching, which is a different bet from an attended answer.
  chatBeta: true,
  // Empty: chat reaches no connected source until an admin names one. Connecting a server
  // must never silently widen what a conversation can do.
  chatSources: [],
  // Unset: the deploy's configured default answers, exactly as it did before this existed.
  chatModel: undefined,
  automateBeta: false,
  // ON by default: an agent product whose agents cannot write out of the box undercuts
  // the model. The switch exists for the day a workspace wants them stopped.
  agentWrites: true,
}

/** A connected Slack workspace (one per Derive workspace). `bot_token` is the OAuth bot
 *  token, AES-encrypted at rest. Where Derive posts is no longer a property of the install —
 *  see `slack_subscription`, one row per subscribed channel. The `default_channel` COLUMN is
 *  left in place unused (lint:schema forbids DROP COLUMN) but is no longer read or written.
 *  Historically `default_channel` was where Derive posted when an artifact
 *  has no more specific channel. */
/** A team member's own model-plan credential, encrypted at rest. `secret` is the AES-GCM
 *  blob (lib/crypto); `provider` matches a runner provider ("claude-code" | "codex"); `kind`
 *  distinguishes an OAuth/plan token from a plain API key. Scoped (org, user, provider). */
export interface ModelCredentialRecord {
  id: string
  org_id: string
  user_id: string
  provider: string
  // oauth = an env-var plan token (Claude's setup-token). api_key = a provider API key.
  // login = a file-delivered plan login blob (Codex's ~/.codex/auth.json), materialized into
  // a private CODEX_HOME per run.
  kind: "oauth" | "api_key" | "login"
  secret: string
  hint: string
  created_at: string
  updated_at: string
}

export interface SlackInstallRecord {
  org_id: string
  team_id: string
  team_name: string | null
  bot_token: string
  bot_user_id: string | null
  /** 1 when a Slack call failed for auth/scope reasons (invalid_auth, token_revoked,
   *  missing_scope); the Settings UI shows a reconnect banner. Cleared on reconnect. */
  needs_reauth?: 0 | 1
  created_at: string
}

/** A user's per-workspace notification preferences. `prefs` is a JSON blob (an absent key
 *  means the default is in effect), so new preference types don't need a migration. */
export interface UserNotificationPrefRecord {
  id: string
  org_id: string
  user_id: string
  prefs: string
  created_at: string
}

/** Where a Slack root was posted. Channel roots need a live subscription; a mention DM is a
 * personal reply route bound to one intended Derive/Slack identity. */
export type SlackThreadSurface = "channel_mirror" | "mention_dm"

/** Links a Derive comment thread to the Slack message Derive posted for it, so replies
 * thread under it (Derive→Slack) and Slack thread replies map back (Slack→Derive). */
export interface SlackThreadLinkRecord {
  id: string
  org_id: string
  artifact_id: string
  thread_id: string
  channel: string
  message_ts: string
  /** Missing only on an in-memory/legacy caller; persisted rows default to channel_mirror. */
  surface?: SlackThreadSurface
  /** The human this DM route was addressed to. Null for channel mirrors. */
  recipient_user_id?: string | null
  /** Slack actor allowed to answer a mention DM route. Null for channel mirrors. */
  slack_user_id?: string | null
  created_at: string
}

/** Links a Derive user to their Slack identity, so Slack events/DMs resolve to the real
 *  account instead of guessing by email. Keyed on (team_id, slack_user_id): a Slack user id
 *  is unique per workspace, and one Derive user can link across several workspaces. `org_id`
 *  is the workspace the link was made from (context, not part of the identity key). */
export type SlackLinkOrigin = "oauth" | "email" | "miss"

export interface SlackUserLinkRecord {
  id: string
  org_id: string
  user_id: string
  team_id: string
  slack_user_id: string
  /**
   * HOW this identity was established — and why a MISS lives in the same table.
   *
   * "oauth" the person deliberately linked through Slack sign-in.
   * "email" inferred from their Slack profile email, which resolved to a seat.
   * "miss"  we looked and found nobody. NOT a link: it is the memo that stops us asking
   *         Slack and re-prompting the person on every message, and it ages out.
   *
   * A miss and a link occupy the SAME (team_id, slack_user_id) row, so a later success
   * replaces the miss through the ordinary upsert. Self-healing, with no cleanup job.
   */
  origin: SlackLinkOrigin
  /** `user_id` is empty on a miss — there is nobody to point at. Never read it without
   *  checking `origin`, which is exactly what the filtered accessors below do for you. */
  created_at: string
  /** When we last CHECKED, or null for a row that predates this mechanism. Distinct from
   *  created_at, which the upsert preserves: a miss has to be able to age out and be retried.
   *  Nullable so it can be ALTER-added to a populated table — see ddl.ts isMigratable. */
  checked_at: string | null
}

/** Where a subscription's events come from: the whole workspace, or one collection. */
export type SlackScopeKind = "workspace" | "collection"
/** Which authors' activity a subscription carries. `agent` is the axis unique to Derive —
 *  agents are first-class authors here, and a channel usually wants one or the other. */
export type SlackAuthorFilter = "all" | "human" | "agent"

/**
 * A Slack channel subscribed to a workspace's activity. Replaces the one-channel-per-workspace
 * `slack_install.default_channel`: several channels, each scoped and filtered independently.
 *
 * `events` uses the same encoding as `webhook.events` — comma-separated types, or "*" for all —
 * so the two subscription surfaces read the same way.
 */
export interface SlackSubscriptionRecord {
  id: string
  org_id: string
  channel_id: string
  /** Denormalized `#name` for display. Never authoritative; the id is the key. */
  channel_name: string | null
  scope_kind: SlackScopeKind
  /** The collection id when `scope_kind` is "collection"; the empty string for a workspace
   *  scope. Empty rather than NULL because SQL treats NULLs as distinct in a UNIQUE
   *  constraint — nullable here would silently allow duplicate workspace subscriptions. */
  scope_id: string
  events: string
  authors: SlackAuthorFilter
  /** Paused (0) subscriptions keep their config but deliver nothing. */
  active: 0 | 1
  created_by: string | null
  created_at: string
}

export interface NewSlackSubscription {
  id: string
  org_id: string
  channel_id: string
  channel_name?: string | null
  scope_kind?: SlackScopeKind
  scope_id?: string
  events?: string
  authors?: SlackAuthorFilter
  active?: 0 | 1
  created_by?: string | null
}

export interface GitHubAppRecord {
  id: string
  /** Numeric GitHub App id, stored as text. */
  app_id: string
  /** App slug, for the install URL github.com/apps/<slug>. */
  slug: string
  client_id: string
  client_secret: string
  /** PEM private key (encrypted at rest). */
  private_key: string
  created_at: string
}

/** A GitHub App installation a workspace connected: the binding between a GitHub
 *  account's selected repos and a Derive workspace. */
export interface GitHubInstallationRecord {
  /** Numeric GitHub installation id, stored as text (PK). */
  installation_id: string
  org_id: string
  /** The GitHub account (org/user login) the App is installed on. */
  account_login: string | null
  created_by: string
  created_at: string
}

export interface ArtifactMemberRecord {
  id: string
  artifact_id: string
  user_id: string
  role: Role
  created_at: string
}
export interface NewArtifactMember {
  id: string
  artifact_id: string
  user_id: string
  role: Role
}

export type WebhookKind = "generic" | "slack"
export type DeliveryStatus = "pending" | "delivered" | "dead"

/**
 * What an outbox row delivers to. `generic`/`slack` are user-configured webhooks
 * (a `webhook` row). The rest are first-party channels Derive fans out to directly —
 * email (Cloudflare Email Service), a connected Slack App (`chat.postMessage`), and
 * GitHub PR comments (inline review or top-level issue comment). Internal-channel
 * rows carry `webhook_id = "internal"` (no backing `webhook` row); the per-kind
 * sender knows how to build credentials + destination from the payload.
 *
 * `slack_ingest` runs the seam the other way: an *inbound* Slack thread reply the events
 * endpoint enqueues so the slow work (users.info + the comment write) happens on the
 * worker — the endpoint acks Slack under its 3s deadline and the outbox retries a
 * transient failure instead of dropping the reply.
 */
export type DeliveryKind = WebhookKind | "slack_app" | "slack_dm" | "slack_ingest" | "email"

/** Sentinel `webhook_id` for outbox rows not tied to a configured `webhook` row. */
export const INTERNAL_DELIVERY = "internal"

export interface WebhookRecord {
  id: string
  org_id: string
  artifact_id: string | null
  url: string
  secret: string
  kind: WebhookKind
  /** Comma-separated event types this hook fires on, or "*" for all. */
  events: string
  label: string | null
  active: 0 | 1
  created_at: string
}
export interface NewWebhook {
  id: string
  org_id: string
  artifact_id?: string | null
  url: string
  secret: string
  kind: WebhookKind
  events: string
  label?: string | null
}

export interface DeliveryRecord {
  id: string
  /** A `webhook` row id, or `INTERNAL_DELIVERY` for a first-party channel row. */
  webhook_id: string
  /** Destination URL for HTTP kinds; a per-kind hint (or empty) for channel kinds. */
  url: string
  /** Signing/bearer secret for HTTP kinds; empty for channel kinds (the sender
   *  resolves credentials from the org/payload at delivery time). */
  secret: string
  kind: DeliveryKind
  event_type: string
  payload: string
  status: DeliveryStatus
  attempts: number
  last_error: string | null
  next_attempt_at: string
  created_at: string
}
export interface NewDelivery {
  id: string
  webhook_id: string
  url: string
  secret: string
  kind: DeliveryKind
  event_type: string
  payload: string
}

export interface NewView {
  id: string
  artifact_id: string
  version: number
  viewer: string
  viewer_kind: "user" | "anon"
}

export interface ViewStats {
  total: number
  /** Views in the trailing 24 hours. A rolling window, not a calendar day, so it
   *  needs no timezone from the caller and reads the same everywhere. */
  last24h: number
  unique: number
  /** Distinct anonymous viewers (the rest of `unique` are named users). */
  anonViewers: number
  /** Distinct viewers confirmed to have stayed, not just fetched (see `confirmRead`).
   *  Always <= unique. */
  reads: number
  perVersion: { version: number; count: number }[]
  /** Daily counts over the trailing window, oldest first. */
  daily: { day: string; count: number }[]
  /** Most-recent distinct viewers, newest first. `avatar` is set for users. */
  recent: { viewer: string; kind: "user" | "anon"; at: string; avatar?: string | null }[]
}

// open      — live feedback awaiting a reply/resolution
// resolved  — a human marked the thread done, or a publish with `addresses` landed the fix
// outdated  — the text this thread anchored to changed or vanished in a later
//             version, so the feedback may no longer apply. Set automatically by
//             the re-anchor sweep on every version bump; flips back to `open` if
//             the quoted text reappears. Never overwrites `resolved`.
export type CommentState = "open" | "resolved" | "outdated"

/** Per-artifact comment signals for a viewer (see `MetaStore.commentSignals`).
 *  `open_threads` is the count of distinct OPEN threads; `mentions_me` / `i_participated`
 *  flag that the viewer is tagged in or has authored an open thread on this artifact —
 *  the two things that make it "need your feedback". */
export interface CommentSignals {
  open_threads: number
  mentions_me: boolean
  i_participated: boolean
}

export interface CommentRecord {
  id: string
  artifact_id: string
  thread_id: string
  base_version: number
  path: string | null
  anchor: string | null
  body_md: string
  author: string
  /** Stable id of the author (user/agent); authorization keys on this, not `author`.
   *  Null for legacy rows and anonymous comments. */
  author_id: string | null
  state: CommentState
  created_at: string
  /** JSON blob: { reactions?: {emoji: author[]}, edited_at?: string, deleted?: boolean }. */
  meta: string | null
}

export interface NewComment {
  id: string
  artifact_id: string
  thread_id: string
  base_version: number
  path?: string | null
  anchor?: string | null
  body_md: string
  author: string
  author_id?: string | null
  /** Opaque JSON sidecar (e.g. the Slack `{ts,channel}` origin marker). Set at insert so a
   *  dedupe key is written atomically with the row, not in a second write a retry can skip. */
  meta?: string | null
}

/** Options for {@link MetaStore.listComments}. */
export interface CommentListOpts {
  state?: CommentState
  /** Only this thread's comments. Filtering in SQL rather than reading the artifact's whole
   *  comment table and filtering in the Worker, which is what the agent tools used to do. */
  threadId?: string
}

/** A bundle version's blob is this manifest; file versions point at content directly. */
export interface BundleManifest {
  entry: string
  spa: boolean
  files: Record<string, { key: string; type: string }>
}

export const BUNDLE_CONTENT_TYPE = "derive/bundle"
/** A skill is a bundle too (kind stays "bundle"), but carries a distinct content type
 *  so its skill-ness rides the artifact's denormalized `current_content_type` — free to
 *  read in the list (the "Skill" badge) without opening the manifest, and it tracks the
 *  current version automatically (republish without a SKILL.md → back to a plain bundle). */
export const SKILL_CONTENT_TYPE = "derive/skill"
/** Is this stored content a bundle (plain bundle OR skill)? Use everywhere that branches
 *  on "is this a multi-file bundle", so a skill is never mistaken for a single file. */
export const isBundleContentType = (contentType: string | null | undefined): boolean =>
  contentType === BUNDLE_CONTENT_TYPE || contentType === SKILL_CONTENT_TYPE
