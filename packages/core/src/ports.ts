/**
 * Core owns the ports; packages/db and packages/storage provide the adapters.
 * Everything here must run on Node AND Cloudflare Workers — no Node APIs.
 */
import type { LinkRole, Listed, Role, WorkspaceAccess } from "./roles"
import type { SortMode } from "./sort"

export interface BlobStore {
  /** Content-addressed put; returns the sha256 hex key. Idempotent. */
  put(data: Uint8Array): Promise<string>
  get(key: string): Promise<Uint8Array | null>
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
  /** Locked: direct publishes are rejected; changes must go through a proposal. */
  locked: 0 | 1
  current_version: number
  /** Denormalized from the current version row — updated on every publish. */
  current_content_type: string | null
  created_at: string
  /** Set on every new version (publish/sync); null until first versioned (read it as
   *  `updated_at ?? created_at`). Drives "most recently updated" sort + the label. */
  updated_at: string | null
  /** A takedown tombstone: when set, the content is gone (410) but the record stays. */
  removed_at: string | null
  /** Expiring anonymous draft (the claim flow): ISO instant after which the draft is
   *  served 410 and swept. Null for every ordinary artifact; cleared on claim. */
  expires_at: string | null
  /** When the first non-author view landed (the activation moment — recordView
   *  stamps it once; owner self-views were already excluded upstream). Null until
   *  someone else has actually seen the work. */
  first_foreign_view_at: string | null
  /** For a GitHub-synced artifact: its path within the repo (e.g. "docs/plans/foo.md").
   *  The structural "location" — drives the folder/tree view — kept distinct from the
   *  human `title`. Null for artifacts not mirrored from a repo. */
  source_path: string | null
  /** The CURRENT (last) author, denormalized from the latest version row for the list
   *  view + author filtering. `author_name` is the display name (commit author name,
   *  "GitHub sync", or a user display name); `author_login`/`author_avatar`/`author_gh_id`
   *  carry the GitHub login, avatar URL, and numeric user id (text) for a synced version.
   *  All null for legacy/anonymous/non-synced rows. */
  author_name: string | null
  author_login: string | null
  author_avatar: string | null
  author_gh_id: string | null
  /** The Derive user who last published this artifact by hand (the signed-in publisher).
   *  Null for GitHub-synced versions (attributed via `author_gh_id` instead), bare
   *  static-token publishes, and legacy rows. Lets a person's profile + people-follow
   *  surface their hand-published work. */
  author_id: string | null
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
  /** Case-insensitive title search. */
  q?: string
  /** Restrict to these artifact ids (tag / favorite filters resolve to ids). Empty ⇒ none. */
  ids?: string[]
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
  /** The GitHub identity behind this version, when it came from a sync: the commit
   *  author's login, avatar URL, and numeric user id (text). All null for a manual or
   *  anonymous publish, or a commit GitHub can't map to an account. */
  author_login: string | null
  author_avatar: string | null
  author_gh_id: string | null
  /** The Derive user who published this version by hand; null for sync/anon/legacy. */
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
}

/** Which surface created a version: the web app, the MCP publish tool, the HTTP API
 *  (agent tokens / OAuth bearers, incl. the CLI), or a GitHub sync. */
export type VersionSource = "web" | "mcp" | "api" | "sync"

export interface NewVersion {
  id: string
  blob_key: string
  content_type: string
  size_bytes?: number
  author: string
  /** The GitHub identity behind this version (sync only); null/omitted otherwise. */
  author_login?: string | null
  author_avatar?: string | null
  author_gh_id?: string | null
  /** The Derive user who published this version by hand; null/omitted for sync/anon. */
  author_id?: string | null
  /** Which surface created this version; omitted for paths that don't stamp. */
  source?: VersionSource | null
  message: string | null
  name?: string | null
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
  getByShortId(shortId: string): Promise<ArtifactRecord | null>
  /** Load an artifact by its internal id (used by domain mode's host lookup). */
  getArtifactById(id: string): Promise<ArtifactRecord | null>
  /** Batch-load artifacts by internal id in ONE query (id ∈ ids). Order is unspecified;
   *  callers key by `id`. Empty ids ⇒ []. Use this over a per-row getArtifactById loop. */
  getArtifactsByIds(ids: string[]): Promise<ArtifactRecord[]>
  /** GitHub-synced artifacts in `orgId` whose `source_path` is one of `paths` —
   *  resolves relative cross-document links (a sibling `.html`/`.md`) to the
   *  artifact each points at. Returns only what the link rewrite needs. Empty
   *  `paths` ⇒ none. */
  siblingsBySourcePaths(
    orgId: string,
    paths: string[],
  ): Promise<{ short_id: string; slug: string | null; source_path: string }[]>
  /** Appends the next version and bumps current_version. */
  addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord>
  listVersions(artifactId: string): Promise<VersionRecord[]>
  getVersion(artifactId: string, n: number): Promise<VersionRecord | null>
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
}

export interface ArtifactQueryStore {
  /**
   * Newest-first artifact page. `cursor` is keyset pagination on created_at
   * (rows strictly older than it); `q` is a case-insensitive title search;
   * `ids` restricts to a set (tag / favorite filters resolve to ids) — an empty
   * `ids` array matches nothing.
   */
  listArtifacts(opts?: ListArtifactsOpts): Promise<ArtifactRecord[]>
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

  /** Append a view event. */
  recordView(v: NewView): Promise<void>
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
  getMembership(orgId: string, userId: string): Promise<MembershipRecord | null>
  listMemberships(orgId: string): Promise<MembershipRecord[]>
  /** Every membership across a set of orgs in ONE query (org_id ∈ orgIds); callers group
   *  by `org_id`. Empty orgIds ⇒ []. Use this over a per-org listMemberships loop. */
  listMembershipsForOrgs(orgIds: string[]): Promise<MembershipRecord[]>
  countMemberships(orgId: string): Promise<number>
  /** Insert or update a member's workspace role. */
  setMembership(m: NewMembership): Promise<MembershipRecord>
  /** Remove a member from the workspace. */
  removeMembership(orgId: string, userId: string): Promise<void>

  getArtifactMember(artifactId: string, userId: string): Promise<ArtifactMemberRecord | null>
  listArtifactMembers(artifactId: string): Promise<ArtifactMemberRecord[]>
  /** Artifact ids explicitly shared with a user (they hold a per-artifact
   *  membership) — the "Shared with you" set; can span workspaces. */
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

  // ---- Follows (per-user: track GitHub authors, repo paths, and people) --
  /** Record a follow (idempotent on (user, org, kind, target)); returns the row. */
  addFollow(f: NewFollow): Promise<FollowRecord>
  removeFollow(userId: string, orgId: string, kind: FollowKind, target: string): Promise<void>
  /** A user's follows for the Following management UI: their `author`/`path` follows in
   *  `orgId` PLUS their global `user` (people) follows (org_id = "*"), newest first. */
  listFollows(userId: string, orgId: string): Promise<FollowRecord[]>
  /** Artifact ids (not removed) surfaced by this user's follows — the activity feed.
   *  Two scopes: author/path follows match within the active workspace `orgId` (a followed
   *  author_login, case-insensitive, or a source_path prefix); people follows match a
   *  followed person's PUBLIC work in ANY workspace (by `author_id` or their linked GitHub
   *  ids) — a person you follow usually publishes in their own workspace, not yours. The
   *  people scope is gated to `public`, so following someone never exposes their private
   *  cross-workspace work. Empty when the user follows nothing. */
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
  setCollectionAccess(id: string, workspaceAccess: WorkspaceAccess): Promise<void>
  /** Remove a collection and its items + member rows. */
  deleteCollection(id: string): Promise<void>
  /** Collections with their item counts, newest first; scoped to a workspace when orgId is given. */
  listCollections(orgId?: string): Promise<(CollectionRecord & { count: number })[]>
  /** Artifact ids in a collection (drives ?collection= browse). */
  collectionArtifactIds(collectionId: string): Promise<string[]>
  /** Collection ids containing an artifact (for the artifact's "add to" UI). */
  collectionIdsForArtifact(artifactId: string): Promise<string[]>
  addCollectionItem(collectionId: string, artifactId: string): Promise<void>
  removeCollectionItem(collectionId: string, artifactId: string): Promise<void>
  getCollectionMember(collectionId: string, userId: string): Promise<CollectionMemberRecord | null>
  listCollectionMembers(collectionId: string): Promise<CollectionMemberRecord[]>
  /** Explicit member-row counts for a set of collections in ONE query (id ∈ ids);
   *  ids with no member rows are absent from the map. Empty ids ⇒ {}. Drives the
   *  share dialog's collection-disclosure rows ("n collection members"). */
  collectionMemberCounts(collectionIds: string[]): Promise<Record<string, number>>
  /** One user's role per collection over a set of collections, in TWO queries
   *  (explicit member rows + the workspace seat on workspace-open collections,
   *  higher wins) — the batched face of context.ts's collectionRole for the
   *  artifact detail's disclosure rows. The caller still folds in created_by
   *  (permanent owner) and the static token. Ids with no role are absent. */
  collectionRolesForUser(collectionIds: string[], userId: string): Promise<Record<string, Role>>
  setCollectionMember(m: NewCollectionMember): Promise<CollectionMemberRecord>
  removeCollectionMember(collectionId: string, userId: string): Promise<void>
  /** This user's collection-member roles over collections containing the
   *  artifact — folded into their effective artifact role (collection sharing). */
  collectionRolesForArtifact(artifactId: string, userId: string): Promise<Role[]>

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
  // ---- GitHub sync sources (a repo mirrored into a collection, one-way) ---
  createRepoSource(s: NewRepoSource): Promise<RepoSourceRecord>
  /** One source by id, scoped to a workspace when orgId is given. */
  getRepoSource(id: string, orgId?: string): Promise<RepoSourceRecord | null>
  /** A workspace's sync sources, newest first. */
  listRepoSources(orgId: string): Promise<RepoSourceRecord[]>
  /** Persist post-sync state — the path→artifact map, time, and status — and/or
   *  re-point a PR preview at a new head (`ref`). Fields are partial; only those
   *  given are written. */
  updateRepoSourceSync(
    id: string,
    fields: Partial<{
      files: string
      last_synced_at: string
      last_status: string
      ref: string
    }>,
  ): Promise<void>
  /** Write just the live `progress` JSON (cheap, frequent — drives the UI bar). */
  setRepoSourceProgress(id: string, progress: string | null): Promise<void>
  deleteRepoSource(id: string, orgId: string): Promise<void>
  /** Every source backed by a GitHub App installation, across workspaces — the
   *  webhook router resolves push/repo events to the sources to re-sync. */
  listRepoSourcesByInstallation(installationId: string): Promise<RepoSourceRecord[]>
  /** Every source with a non-null `progress`, across workspaces — the Node entry
   *  resumes any left mid-sync on boot (a process restart) so it finishes
   *  server-side. The caller filters to the still-running phases. */
  listSyncingRepoSources(): Promise<RepoSourceRecord[]>
  /** Ids of every artifact mirrored from a sync source in this workspace —
   *  drives the read-only gate + the `managed` flag (synced docs aren't editable). */
  managedArtifactIds(orgId: string): Promise<string[]>
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
  deleteGithubInstallation(installationId: string): Promise<void>
  // ---- Workspace integration settings (enable/disable each channel) --------
  /** The workspace's integration preferences, merged over defaults (so a workspace
   *  that never saved any returns all-enabled). */
  getOrgSettings(orgId: string): Promise<OrgSettings>
  /** Persist the workspace's integration preferences (full object; upsert by org). */
  setOrgSettings(orgId: string, settings: OrgSettings): Promise<void>
  // ---- Slack App (connected workspace + thread links) ---------------------
  /** The Slack workspace connected to this Derive workspace, or null. */
  getSlackInstall(orgId: string): Promise<SlackInstallRecord | null>
  /** Upsert (connect / reconnect) the Slack install for a workspace. */
  setSlackInstall(s: SlackInstallRecord): Promise<void>
  /** Disconnect Slack for a workspace. */
  deleteSlackInstall(orgId: string): Promise<void>
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
  getSlackThreadLinkByThread(threadId: string): Promise<SlackThreadLinkRecord | null>
  /** The Derive thread a Slack message maps to (for reply-back), or null. */
  getSlackThreadLinkByTs(channel: string, ts: string): Promise<SlackThreadLinkRecord | null>
  /** Record the Slack message ↔ Derive thread mapping (idempotent on thread_id). */
  setSlackThreadLink(l: SlackThreadLinkRecord): Promise<void>
  /** Resolve a Slack user (team + user id) to the Derive user who linked it, or null. */
  getSlackUserLinkBySlackId(
    teamId: string,
    slackUserId: string,
  ): Promise<SlackUserLinkRecord | null>
  /** The Slack identity a Derive user linked for a team, or null. */
  getSlackUserLinkByUser(teamId: string, userId: string): Promise<SlackUserLinkRecord | null>
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
  // ---- Reviews: proposed versions awaiting approval ----------------------
  createProposal(p: NewProposal): Promise<ProposalRecord>
  getProposal(id: string): Promise<ProposalRecord | null>
  /** Proposals for an artifact, newest first; filterable by state. */
  listProposals(artifactId: string, opts?: { state?: ProposalState }): Promise<ProposalRecord[]>
  /** How many proposals are still awaiting a decision (for badges, no N+1). */
  openProposalCounts(artifactIds: string[]): Promise<Record<string, number>>
  /** Record a reviewer's decision (approve / request changes / withdraw). */
  decideProposal(
    id: string,
    fields: {
      state: ProposalState
      decided_by: string | null
      decided_version: number | null
      decision_note?: string | null
    },
  ): Promise<ProposalRecord | null>

  // ---- Review rounds (the agent↔human review loop) ----------------------
  /** Open a review round for a person, replacing their existing pending round on
   *  this artifact (one pending per (artifact, requested_for)). */
  createReviewRound(r: NewReviewRound): Promise<ReviewRoundRecord>
  /** This person's pending round on the artifact, if any. Omit `requestedFor` to
   *  get any pending round (whichever was created first). */
  getPendingRound(artifactId: string, requestedFor?: string): Promise<ReviewRoundRecord | null>
  /** All rounds on an artifact, newest first (the audit trail). */
  listReviewRounds(artifactId: string): Promise<ReviewRoundRecord[]>
  /** Settle a round (`sent_back` or `approved`), stamping resolved_at + note. */
  resolveReviewRound(
    id: string,
    fields: { state: Extract<ReviewRoundState, "sent_back" | "approved">; note?: string | null },
  ): Promise<ReviewRoundRecord | null>
}

export interface ContextStore {
  // ---- Contexts + sessions (ask a context; its runner answers) -----------
  createContext(x: NewContext): Promise<ContextRecord>
  getContext(id: string): Promise<ContextRecord | null>
  /** A workspace's contexts, newest first. */
  listContexts(orgId: string): Promise<ContextRecord[]>
  /** Remove a context and its sessions + messages, scoped to its workspace. */
  deleteContext(id: string, orgId: string): Promise<void>
  /** Stamp `runner_seen_at` (the queue route's liveness mark). The caller decides
   *  WHEN — the write throttle lives there, next to the poll cadence it paces. */
  touchContextSeen(id: string, at: string): Promise<void>
  /** Set who may ask (workspace | invited). Does not touch the roster. */
  setContextAskPolicy(id: string, policy: "workspace" | "invited"): Promise<void>
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
  getSession(id: string): Promise<SessionRecord | null>
  /** Sessions on a context, newest first; `askerId` narrows to one person's. */
  listSessions(
    contextId: string,
    opts?: { askerId?: string; limit?: number },
  ): Promise<SessionRecord[]>
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
  /** Sessions awaiting an executor across ALL workspaces (capped, oldest first) — the hosted
   *  tick's ask-lane scan, the twin of listDueQueuedRuns. Runnable means `open`, or `working`
   *  with a lapsed lease (a dead executor's session self-heals). Read-only: dispatch never
   *  claims, the booted executor does. */
  listDueOpenSessions(now: string, limit?: number): Promise<SessionRecord[]>
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
}

export interface DirectoryStore {
  // ---- User directory (reads Better Auth's `user` table) ----------------
  findUserByEmail(email: string): Promise<UserDir | null>
  getUsers(ids: string[]): Promise<UserDir[]>
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
   *  their authorship (author_id → null on artifacts/versions/comments/proposals, so others'
   *  threads survive), null the nullable back-references keyed to them (agent.created_by,
   *  invitation.invited_by), and drop their personal workspace row. Better Auth removes the
   *  account itself + its sessions/passkeys/2FA.
   *
   *  NOT hard-deleted: artifact/collection content is anonymized + orphaned (a GC concern),
   *  and NON-nullable historical metadata that merely records a past action (a proposal's
   *  decided_by, a review round's requester, an audit-log actor, a repo/collection creator)
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
  /** Mark the given ids read, or all of the user's notifications when "all". */
  markNotificationsRead(userId: string, ids: string[] | "all"): Promise<void>
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
  /** Partial update, org-scoped (id + orgId must both match). Undefined fields are
   *  untouched; refs null clears. Returns the updated row, or null when not found. */
  updateAutomation(
    id: string,
    orgId: string,
    fields: {
      agent_id?: string
      trigger?: string
      instruction?: string
      refs?: string | null
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
   *  meta. Returns the updated row, or null when the run isn't this agent's or isn't running. */
  /** Replace a run's meta blob mid-flight, with no status transition — the writer for facts
   *  discovered WHILE a run is running (today: taint, stamped when the server proxies a source
   *  tool). Deliberately status-agnostic: the run is `running` at the time, and adding a guard
   *  here would silently drop the stamp if the run were reclaimed in the same instant, which is
   *  exactly when recording it matters most. Callers pass an already-merged blob (mergeRunMeta),
   *  never a replacement, because run.meta has several independent writers. */
  updateRunMeta(id: string, meta: string | null): Promise<RunRecord | null>
  requeueRun(
    id: string,
    agentId: string,
    /** `costMicroUsd` banks the FAILED attempt's spend before the row goes back on the queue: a
     *  retry reuses this same run row, so a cost not recorded here is lost for good when the run
     *  eventually settles. Accumulates onto whatever the column already holds. */
    fields: { scheduledFor: string; meta?: string | null; costMicroUsd?: number | null },
  ): Promise<RunRecord | null>
  /** The reclaim sweep: runs stuck `running` since before `cutoffIso` (their substrate died)
   *  go back to `queued` for re-dispatch, with an attempt count kept in meta; a run past
   *  `maxAttempts` is finished failed (outcome "lost") instead of looping forever. */
  reclaimStaleRuns(
    cutoffIso: string,
    maxAttempts?: number,
  ): Promise<{ requeued: number; failed: number }>
  /** Every enabled automation across ALL workspaces (capped) — the hosted tick scans these
   *  to materialize due schedule runs. Fine at self-host scale; revisit if it ever shows up. */
  listEnabledAutomations(limit?: number): Promise<AutomationRecord[]>
  /** Queued runs due now across ALL workspaces (capped), oldest first — the hosted tick's
   *  dispatch scan. Read-only: dispatch does NOT claim; the booted substrate claims. */
  listDueQueuedRuns(now: string, limit?: number): Promise<RunRecord[]>
  /** Terminate a run: set the terminal status, finished_at, and (optional) cost + meta.
   *  Scoped to (id, agent) so only the claiming agent settles it. */
  finishRun(
    id: string,
    agentId: string,
    fields: {
      status: RunStatus
      finishedAt: string
      costMicroUsd?: number | null
      meta?: string | null
    },
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
  /** A workspace's connections, newest first; pass userId to scope to one person's. */
  listConnections(orgId: string, userId?: string): Promise<ConnectionRecord[]>
  /** Flip a connection's status (activate on authorize, revoke on teardown), org-scoped. */
  setConnectionStatus(
    id: string,
    orgId: string,
    status: ConnectionStatus,
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
   *  (version.source='mcp', attributed to them) or an approved agent proposal on their
   *  behalf (proposal.on_behalf_of). The onboarding "published via agent" signal. */
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
  /** Stamp accepted_at so the invite can't be redeemed twice. */
  markInvitationAccepted(id: string): Promise<void>

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
  /** Stamp accepted_at so the invite can't be redeemed twice. */
  markArtifactInviteAccepted(id: string): Promise<void>
  // ---- Beta signups (the marketing site's request-access form) ------------
  /** Record a beta signup (idempotent per email). Returns true when the email is
   *  new, false when it was already on the list — the caller resends the access
   *  email either way, so "sign up again" doubles as "resend my link". */
  recordBetaSignup(id: string, email: string): Promise<boolean>

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
   *  proposals, memberships, favorites, tags, collection items, domains, etc.).
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
  /** Take an artifact down atomically: tombstone the artifact, resolve every open
   *  report against it (→ actioned), and write the audit entry — all in one
   *  transaction so a crash mid-way can't leave a half-applied takedown (removed
   *  but reports still open, or no audit trail). Replaces the route's
   *  read-loop-write, which was both non-atomic and N+1 in the open-report count. */
  takedownArtifact(input: TakedownInput): Promise<void>
  /** Update an artifact's display title (used when a GitHub-synced file is renamed —
   *  the title tracks the repo path; the artifact + its comments are preserved). */
  setArtifactTitle(id: string, title: string): Promise<void>
  /** Set the repo path of a GitHub-synced artifact (its folder/tree "location"). */
  setArtifactSourcePath(id: string, sourcePath: string | null): Promise<void>
  /** Override "updated_at" with an external timestamp (a synced file's last-commit
   *  date), so the card's "updated" reflects the SOURCE's last change, not when Derive
   *  ingested it. Publish bumps updated_at to now; the sync calls this after to correct it. */
  setArtifactUpdatedAt(id: string, updatedAt: string): Promise<void>
  /** Set the artifact's denormalized current author (its author_* columns). Used by the
   *  sync backfill path to stamp an existing tracked artifact's author from its last
   *  commit without republishing. `null` clears all four columns. */
  setArtifactAuthor(artifactId: string, author: GithubAuthor | null): Promise<void>
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
  created_at: string
}
export interface NewAsset {
  hash: string
  org_id: string
  content_type: string
  size_bytes: number
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
    DirectoryStore,
    AgentStore,
    ModerationStore,
    AssetStore {}

/** What a user follows: a GitHub author (`target` = the login), a repo path prefix
 *  (`target` = a path prefix, e.g. "docs/plans"), or a Derive person (`target` = their
 *  user id). `author`/`path` follows are workspace-scoped; `user` follows are global
 *  (stored with `org_id = "*"`) since a person's work spans workspaces. */
export type FollowKind = "author" | "path" | "user"
/** Sentinel org_id for `user` (people) follows — they are global, not workspace-scoped,
 *  so a person's work surfaces regardless of which workspace the follower is viewing. */
export const GLOBAL_FOLLOW_ORG = "*"
/** A per-user follow — the same shape of relation as a favorite, but keyed on a
 *  (kind, target) pair instead of an artifact id. Drives the "following" feed. */
export interface FollowRecord {
  id: string
  org_id: string
  user_id: string
  kind: FollowKind
  /** For `author`: the GitHub login (stored lowercased). For `path`: a repo path prefix.
   *  For `user`: the followed Derive user id (verbatim). */
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
 * Default role is commenter, so an agent can propose but never publish directly
 * — a human still approves. Treated like a member of the workspace.
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
  refs?: string | null
  connection_ids?: string | null
  context_id?: string | null
  enabled?: 0 | 1
}

/** How a run's work landed — the semantic outcome, kept in the run's meta blob (not a
 *  column). Mirrors the autonomy-gate decisions plus the ask-answer terminal. */
export type RunOutcome = "answered" | "published" | "proposed" | "shadow" | "escalated"

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

/** A per-user connected external account (WO3): the owner authorized Derive's broker to act on
 *  their Gmail/Stripe/GitHub/etc. Always bound to ONE person (identity never falls back), and
 *  scoped least-privilege per toolkit. A hosted run sees the tools of its bound connections
 *  only; the BYO path never touches these. */
export interface ConnectionRecord {
  id: string
  org_id: string
  /** The owner — always a specific person, never null. */
  user_id: string
  /** Broker provider slug: "local" | "composio". */
  broker: string
  /** Toolkit slug, e.g. "gmail" | "stripe" | "github". */
  toolkit: string
  /** Broker-side connected-account id. */
  broker_ref: string
  /** Human label of the granted scopes (display only), or null. */
  scopes_label: string | null
  status: ConnectionStatus
  created_at: string
}

export interface NewConnection {
  id: string
  org_id: string
  user_id: string
  broker: string
  toolkit: string
  broker_ref: string
  scopes_label?: string | null
  status?: ConnectionStatus
}

export type AgentMentionState = "pending" | "done"
/** A queued mention for an agent's pull inbox (denormalized for a cheap read). */
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
 * A beta signup from the marketing site's request-access form. One row per email
 * (idempotent — signing up again resends the access email, never duplicates). The
 * list is the launch audience: who asked for access, and in what order.
 */
export interface BetaSignupRecord {
  id: string
  /** Normalized (lowercased) signup email. */
  email: string
  created_at: string
}

/**
 * Where a signup came from. One row per user, recorded by the
 * auth layer's user-create hook from the `d_src` cookie the capture middleware
 * stamped on the way in; first write wins. Organic signups have no row.
 */
export interface SignupAttributionRecord {
  id: string
  /** The Better Auth user this attribution belongs to (no FK; auth owns its tables). */
  user_id: string
  /** The sourcing surface: an artifact surface (badge, comment_wall, duplicate,
   *  share_chrome, artifact_visit) or a campaign token (hn-launch, …). */
  source_kind: string
  /** The artifact (short id) the sourcing surface lived on, when known. */
  source_artifact: string | null
  /** Path of the page that stamped the cookie. */
  landing_path: string | null
  /** Referrer host at stamp time. */
  referrer: string | null
  created_at: string
}

export type NewSignupAttribution = Omit<SignupAttributionRecord, "created_at">

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

/**
 * A candidate version awaiting review. It holds content exactly like a version
 * (blob_key + content_type, file or bundle manifest) but is NOT current until a
 * reviewer approves it, at which point it is appended as the new live version.
 *   open → approved | changes_requested | withdrawn
 */
export type ProposalState = "open" | "approved" | "changes_requested" | "withdrawn"

export interface ProposalRecord {
  id: string
  artifact_id: string
  blob_key: string
  content_type: string
  kind: ArtifactKind
  /** Optional new title the proposal would set on approval. */
  title: string | null
  /** What the proposer is changing, in their words. */
  message: string | null
  author: string
  /** Stable id of the proposer (user/agent); withdraw authorization keys on this,
   *  not `author`. Null for legacy rows and anonymous proposals. */
  author_id: string | null
  /** When an AGENT proposed this, the human it acted on behalf of (the granting/registering
   *  user) — so a reviewer sees "proposed by Agent X on behalf of Alice." Null for a direct
   *  human proposal or an agent with no known principal. The delegation made legible. */
  on_behalf_of: string | null
  /** The current_version this candidate was proposed against (for the diff). */
  base_version: number
  state: ProposalState
  /** Set once decided. */
  decided_by: string | null
  /** The version number it became on approval; null otherwise. */
  decided_version: number | null
  /** The reviewer's note when approving or requesting changes; the feedback. */
  decision_note: string | null
  decided_at: string | null
  created_at: string
}

export interface NewProposal {
  id: string
  artifact_id: string
  blob_key: string
  content_type: string
  kind: ArtifactKind
  title?: string | null
  message?: string | null
  author: string
  author_id?: string | null
  on_behalf_of?: string | null
  base_version: number
}

/** A review round's lifecycle. `pending` = the agent asked and is waiting;
 *  `sent_back` = the human returned their answers (the poll target); `approved` =
 *  the human signed off (the build go-signal). One pending round per person. */
export type ReviewRoundState = "pending" | "sent_back" | "approved"

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
  context_id: string
  org_id: string
  asker_id: string
  /** The manifest version the session started against (provenance). */
  context_version: number
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
export interface NewSession {
  id: string
  context_id: string
  org_id: string
  asker_id: string
  context_version: number
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

/**
 * A GitHub repository mirrored into a collection, one-way (GitHub is the source
 * of truth). `files` is a JSON map of repo path → { artifact_id, sha } so a
 * re-sync can skip unchanged files (sha match), version changed ones, and
 * tombstone vanished ones. The token is a read-only PAT (null for public repos)
 * and is never returned to clients (redacted in list responses).
 */
/** Live, pollable progress for one repo sync (stored as JSON in repo_source.progress).
 *  `phase` runs queued → listing → mirroring → done|error. The UI renders done/total. */
export interface SyncProgress {
  phase: "queued" | "listing" | "mirroring" | "done" | "error"
  /** Docs mirrored so far. */
  done: number
  /** Total matching docs this run (0 until the tree is listed). */
  total: number
  /** Error text when phase === "error". */
  message?: string
  /** ISO time of this update (drives a "stalled?" check + resume on Node restart). */
  updatedAt: string
}

export interface RepoSourceRecord {
  id: string
  org_id: string
  collection_id: string
  /** "owner/name". */
  repo: string
  /** Branch or ref to read (default "HEAD"). */
  ref: string
  /** Comma-separated include globs, e.g. "**\/*.md,**\/*.html". */
  includes: string
  token: string | null
  /** GitHub App installation backing this source. When set, sync mints a
   *  short-lived installation token; `token` (a PAT) is the fallback path. */
  installation_id: string | null
  /** When set, this source is a read-only PREVIEW of that pull request: `ref` is the
   *  PR head sha and it mirrors only the PR's changed docs into its own collection.
   *  NULL = an ordinary branch mirror. Keeps PR previews out of the per-repo dedup
   *  and the push auto-sync matcher. */
  pr_number: number | null
  /** JSON: { [repoPath]: { artifact_id: string; sha: string } }. */
  files: string
  last_synced_at: string | null
  /** "ok" or "error: …" from the last run. */
  last_status: string | null
  /** Live sync progress as JSON (see SyncProgress): phase + done/total, written
   *  frequently during a run so the UI can poll a precise bar. Null = never run. */
  progress: string | null
  created_by: string
  created_at: string
}
export interface NewRepoSource {
  id: string
  org_id: string
  collection_id: string
  repo: string
  ref: string
  includes: string
  token?: string | null
  installation_id?: string | null
  /** Set only for a PR-preview source (the PR number); omit for a branch mirror. */
  pr_number?: number | null
  created_by: string
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
  /** Post a Derive comment to the PR (inline review or top-level) when it's on a
   *  PR-sourced artifact. */
  githubPostComments: boolean
  /** Mirror PR comments made on GitHub back into the Derive artifact. */
  githubMirrorComments: boolean
  /** When a PR opens (and on each push), post + keep updated a single comment on the
   *  pull request linking to the Derive preview of its docs. */
  githubPreviewLink: boolean
  /** Post Derive comment activity to the connected Slack workspace (the thread mirror). */
  slackPost: boolean
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
  /** The agent-write killswitch, read fresh per run by the autonomy gate: when true,
   *  every hosted agent write demotes to a proposal, instantly. */
  agentKillswitch: boolean
  /** Workspace opt-in for autonomy level `auto` to live-publish (always with a review
   *  round). Off = auto behaves as suggest. */
  agentAutoEnabled: boolean
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
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  emailNotifications: true,
  githubPostComments: true,
  githubMirrorComments: true,
  githubPreviewLink: true,
  slackPost: true,
  defaultWorkspaceAccess: "member",
  defaultLinkRole: "none",
  defaultListed: "none",
  whiteLabel: false,
  // Hosting on by default: it does nothing until an agent is flagged hosted, and
  // the run-time safety lives in the autonomy gate (killswitch defaults off but
  // every write still lands as a proposal until a workspace opts into auto).
  hostedAgentsEnabled: true,
  agentKillswitch: false,
  agentAutoEnabled: false,
}

/** A connected Slack workspace (one per Derive workspace). `bot_token` is the OAuth bot
 *  token, AES-encrypted at rest. `default_channel` is where Derive posts when an artifact
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
  default_channel: string | null
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

/** Links a Derive comment thread to the Slack message Derive posted for it, so replies
 *  thread under it (Derive→Slack) and Slack thread replies map back (Slack→Derive). */
export interface SlackThreadLinkRecord {
  id: string
  org_id: string
  artifact_id: string
  thread_id: string
  channel: string
  message_ts: string
  created_at: string
}

/** Links a Derive user to their Slack identity, so Slack events/DMs resolve to the real
 *  account instead of guessing by email. Keyed on (team_id, slack_user_id): a Slack user id
 *  is unique per workspace, and one Derive user can link across several workspaces. `org_id`
 *  is the workspace the link was made from (context, not part of the identity key). */
export interface SlackUserLinkRecord {
  id: string
  org_id: string
  user_id: string
  team_id: string
  slack_user_id: string
  created_at: string
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
  webhook_secret: string
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
export type DeliveryKind =
  | WebhookKind
  | "slack_app"
  | "slack_dm"
  | "slack_ingest"
  | "github_review_comment"
  | "github_issue_comment"
  | "email"

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
  unique: number
  /** Distinct anonymous viewers (the rest of `unique` are named users). */
  anonViewers: number
  perVersion: { version: number; count: number }[]
  /** Daily counts over the trailing window, oldest first. */
  daily: { day: string; count: number }[]
  /** Most-recent distinct viewers, newest first. `avatar` is set for users. */
  recent: { viewer: string; kind: "user" | "anon"; at: string; avatar?: string | null }[]
}

// open      — live feedback awaiting a reply/resolution
// addressed — a proposed revision that cites this thread is pending review. Set
//             when an agent/author `propose`s with `addresses`; clears to
//             `resolved` if that proposal is approved (the fix landed) or back to
//             `open` if it's withdrawn / sent back for changes.
// resolved  — a human marked the thread done (or an addressing proposal landed)
// outdated  — the text this thread anchored to changed or vanished in a later
//             version, so the feedback may no longer apply. Set automatically by
//             the re-anchor sweep on every version bump; flips back to `open` if
//             the quoted text reappears. Never overwrites `resolved`/`addressed`.
export type CommentState = "open" | "addressed" | "resolved" | "outdated"

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
