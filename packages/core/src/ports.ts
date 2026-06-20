/**
 * Core owns the ports; packages/db and packages/storage provide the adapters.
 * Everything here must run on Node AND Cloudflare Workers — no Node APIs.
 */
import type { GeneralRole, Role } from "./permissions"

export interface BlobStore {
  /** Content-addressed put; returns the sha256 hex key. Idempotent. */
  put(data: Uint8Array): Promise<string>
  get(key: string): Promise<Uint8Array | null>
}

export type ArtifactKind = "file" | "bundle"
// `password`: world-reachable by URL like `link`, but the bytes stay gated until
// the visitor enters the password (then a viewer; members/owners see it by role).
export type Visibility = "public" | "link" | "org" | "password"

/** A platform subdomain (`name.dockd.app`) or a customer's own domain. */
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
  visibility: Visibility
  /** Salted hash of the unlock password for `password` visibility; null otherwise. */
  password_hash: string | null
  /** The role general access (the link) grants a reacher with no higher explicit grant.
   *  `viewer` (default) = view-only; `commenter` = authenticated reachers may comment.
   *  Anonymous reachers are always clamped to `viewer` regardless (see effectiveRole). */
  general_role: GeneralRole
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
}

export interface ListArtifactsOpts {
  limit?: number
  /**
   * Keyset cursor — return artifacts strictly older than this (created_at, id)
   * pair. The `id` tiebreak makes pagination correct even when many artifacts
   * share a created_at timestamp (sub-millisecond bulk inserts).
   */
  cursor?: { created_at: string; id: string }
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
  message: string | null
  /** A named checkpoint (Docs-style). Null = an ordinary auto-saved revision. */
  name: string | null
  created_at: string
}

export interface NewArtifact {
  id: string
  short_id: string
  org_id: string
  slug: string | null
  title: string | null
  visibility: Visibility
  /** Salted unlock-password hash; set only for `password` visibility. */
  password_hash?: string | null
  /** General-access role; defaults to `viewer` (view-only) when omitted. */
  general_role?: GeneralRole
  kind: ArtifactKind
  spa: 0 | 1
}

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
  message: string | null
  name?: string | null
}

export interface MetaStore {
  createArtifact(a: NewArtifact): Promise<ArtifactRecord>
  /** Change an artifact's general access: visibility, the unlock password hash (null for
   *  any non-`password` visibility), and the general-access role (view vs comment). */
  setVisibility(
    artifactId: string,
    visibility: Visibility,
    passwordHash: string | null,
    generalRole: GeneralRole,
  ): Promise<void>
  /** Toggle the change-lock: when locked, direct publishes are rejected. */
  setLocked(artifactId: string, locked: 0 | 1): Promise<void>
  getByShortId(shortId: string): Promise<ArtifactRecord | null>
  /** Load an artifact by its internal id (used by domain mode's host lookup). */
  getArtifactById(id: string): Promise<ArtifactRecord | null>
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

  createComment(c: NewComment): Promise<CommentRecord>
  listComments(artifactId: string, opts?: { state?: CommentState }): Promise<CommentRecord[]>
  getComment(id: string): Promise<CommentRecord | null>
  /** Patch a single comment's body and/or meta (reactions, edited, deleted). */
  updateComment(
    id: string,
    fields: { body_md?: string; meta?: string | null },
  ): Promise<CommentRecord | null>
  /** Flips every comment in a thread to a state; returns the count updated. */
  setThreadState(artifactId: string, threadId: string, state: CommentState): Promise<number>

  /**
   * Newest-first artifact page. `cursor` is keyset pagination on created_at
   * (rows strictly older than it); `q` is a case-insensitive title search;
   * `ids` restricts to a set (tag / favorite filters resolve to ids) — an empty
   * `ids` array matches nothing.
   */
  listArtifacts(opts?: ListArtifactsOpts): Promise<ArtifactRecord[]>
  /** Artifact ids carrying a tag (server-side tag filtering). */
  artifactIdsByTag(tag: string): Promise<string[]>
  /** Artifact ids in a workspace whose current author_login matches `login`
   *  (case-insensitive) — the author list-filter. Empty when nothing matches. */
  artifactIdsByAuthor(orgId: string, login: string): Promise<string[]>
  /** Total artifact count, scoped to a workspace when orgId is given. */
  countArtifacts(orgId?: string): Promise<number>
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

  // ---- Favorites (per-user stars) + tags (browse metadata) ---------------
  /** Artifact ids this user has starred. With `orgId`, scoped to that workspace's
   *  live (non-removed) artifacts — for the workspace-scoped favorites count. */
  listUserFavoriteIds(userId: string, orgId?: string): Promise<string[]>
  setFavorite(artifactId: string, userId: string): Promise<void>
  removeFavorite(artifactId: string, userId: string): Promise<void>

  // ---- Follows (per-user: track GitHub authors + repo path prefixes) -----
  /** Record a follow (idempotent on (user, org, kind, target)); returns the row. */
  addFollow(f: NewFollow): Promise<FollowRecord>
  removeFollow(userId: string, orgId: string, kind: FollowKind, target: string): Promise<void>
  /** A user's follows in a workspace, newest first. */
  listFollows(userId: string, orgId: string): Promise<FollowRecord[]>
  /** Artifact ids in `orgId` (not removed) whose current author_login is one of the
   *  user's followed logins (case-insensitive) OR whose source_path starts with one of
   *  the user's followed path prefixes — the activity feed. Empty when the user follows
   *  nothing. */
  followedArtifactIds(userId: string, orgId: string): Promise<string[]>
  /** Tags per artifact, batched (no N+1). Missing ids map to no entry. */
  tagsForArtifacts(artifactIds: string[]): Promise<Record<string, string[]>>
  /** Replace an artifact's full tag set (deduped, trimmed, lowercased upstream). */
  setArtifactTags(artifactId: string, tags: string[]): Promise<void>

  // ---- Collections (shareable groups; a member's role propagates to items) -
  createCollection(c: NewCollection): Promise<CollectionRecord>
  getCollection(id: string): Promise<CollectionRecord | null>
  updateCollection(id: string, fields: { title?: string }): Promise<CollectionRecord | null>
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
  setCollectionMember(m: NewCollectionMember): Promise<CollectionMemberRecord>
  removeCollectionMember(collectionId: string, userId: string): Promise<void>
  /** This user's collection-member roles over collections containing the
   *  artifact — folded into their effective artifact role (collection sharing). */
  collectionRolesForArtifact(artifactId: string, userId: string): Promise<Role[]>

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
  /** The Slack workspace connected to this Dock workspace, or null. */
  getSlackInstall(orgId: string): Promise<SlackInstallRecord | null>
  /** Upsert (connect / reconnect) the Slack install for a workspace. */
  setSlackInstall(s: SlackInstallRecord): Promise<void>
  /** Disconnect Slack for a workspace. */
  deleteSlackInstall(orgId: string): Promise<void>
  /** The Slack message a Dock thread is mirrored to (for threading replies), or null. */
  getSlackThreadLinkByThread(threadId: string): Promise<SlackThreadLinkRecord | null>
  /** The Dock thread a Slack message maps to (for reply-back), or null. */
  getSlackThreadLinkByTs(channel: string, ts: string): Promise<SlackThreadLinkRecord | null>
  /** Record the Slack message ↔ Dock thread mapping (idempotent on thread_id). */
  setSlackThreadLink(l: SlackThreadLinkRecord): Promise<void>
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
  /** Update a custom domain's validation status + the records to display. */
  updateDomain(
    host: string,
    fields: { status?: DomainStatus; verification?: string | null },
  ): Promise<DomainRecord | null>
  /** Release a hostname, scoped to its owning workspace. */
  deleteDomain(host: string, orgId: string): Promise<void>

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

  // ---- User directory (reads Better Auth's `user` table) ----------------
  findUserByEmail(email: string): Promise<UserDir | null>
  getUsers(ids: string[]): Promise<UserDir[]>
  /** Map GitHub numeric user ids (as strings) to the Dock accounts that signed in with
   *  GitHub — joins Better Auth's `account` (providerId='github', accountId IN ids) to
   *  `user`. Lets a synced artifact's commit author resolve to a Dock profile/handle.
   *  Returns [] for empty input or when the auth tables are absent. */
  usersByGithubIds(ghIds: string[]): Promise<GithubUserMapping[]>
  /** Resolve a public profile by its handle (username); null if unclaimed. */
  getUserByUsername(username: string): Promise<UserProfile | null>
  /** Claim or replace a user's handle. Returns "taken" when another account
   *  already holds it (the unique index is the hard backstop on a race). */
  setUsername(userId: string, username: string): Promise<"ok" | "taken">
  /** Set a user's avatar URL (image column on Better Auth's user table). */
  setUserImage(userId: string, image: string): Promise<void>
  /** Opt a user in/out of people search (discoverable column). */
  setUserDiscoverable(userId: string, discoverable: boolean): Promise<void>
  /** Set a user's team role + "what you do" blurb (profession/about columns). An
   *  undefined field is left untouched; null clears it. */
  setUserProfile(
    userId: string,
    fields: { profession?: string | null; about?: string | null },
  ): Promise<void>
  /** People search: opted-in (discoverable) profiles matching `q` on username or
   *  name, capped to `limit`. Empty `q` returns nothing (no full enumeration). */
  searchDiscoverableUsers(q: string, limit: number): Promise<UserProfile[]>

  // ---- Notifications (in-app, one row per recipient) --------------------
  createNotification(n: NewNotification): Promise<void>
  listNotifications(userId: string, limit: number): Promise<NotificationRecord[]>
  unreadNotificationCount(userId: string): Promise<number>
  /** Mark the given ids read, or all of the user's notifications when "all". */
  markNotificationsRead(userId: string, ids: string[] | "all"): Promise<void>

  // ---- Agents (mentionable principals that act via a scoped token) -------
  createAgent(a: NewAgent): Promise<AgentRecord>
  listAgents(orgId: string): Promise<AgentRecord[]>
  /** Resolve an agent from its bearer token (the agent's identity). */
  getAgentByToken(token: string): Promise<AgentRecord | null>
  /** Resolve a live OAuth access token (by its stored hash) to its grant. */
  getOAuthGrant(tokenHash: string): Promise<OAuthGrant | null>
  /** The display name of a registered OAuth client (for the consent screen). */
  getOAuthClientName(clientId: string): Promise<string | null>
  deleteAgent(id: string, orgId: string): Promise<void>
  /** Queue a mention into an agent's pull inbox. */
  createAgentMention(m: NewAgentMention): Promise<void>
  /** Pending (unhandled) mentions for an agent, oldest first. */
  listPendingAgentMentions(agentId: string, limit: number): Promise<AgentMentionRecord[]>
  /** Mark a mention handled; false if it isn't this agent's or doesn't exist. */
  ackAgentMention(agentId: string, id: string): Promise<boolean>

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
  /** Set or clear an artifact's takedown tombstone (the record is never deleted). */
  setArtifactRemoved(id: string, removedAt: string | null): Promise<void>
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
   *  date), so the card's "updated" reflects the SOURCE's last change, not when Dock
   *  ingested it. Publish bumps updated_at to now; the sync calls this after to correct it. */
  setArtifactUpdatedAt(id: string, updatedAt: string): Promise<void>
  /** Set the artifact's denormalized current author (its author_* columns). Used by the
   *  sync backfill path to stamp an existing tracked artifact's author from its last
   *  commit without republishing. `null` clears all four columns. */
  setArtifactAuthor(artifactId: string, author: GithubAuthor | null): Promise<void>
  createAuditLog(a: NewAuditLog): Promise<void>
  /** Moderation history, newest first. One workspace's, or — super-admin, orgId
   *  undefined — the whole instance's. Optionally narrowed to one artifact. */
  listAuditLog(
    orgId: string | undefined,
    opts?: { artifactId?: string; limit?: number },
  ): Promise<AuditLogRecord[]>
}

/** What a user follows: a GitHub author (`target` = the login) or a repo path
 *  prefix (`target` = a path prefix, e.g. "docs/plans"). */
export type FollowKind = "author" | "path"
/** A per-user follow — the same shape of relation as a favorite, but keyed on a
 *  (kind, target) pair instead of an artifact id. Drives the "following" feed. */
export interface FollowRecord {
  id: string
  org_id: string
  user_id: string
  kind: FollowKind
  /** For `author`: the GitHub login (stored lowercased). For `path`: a repo path prefix. */
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
  created_at: string
}
export interface NewAgent {
  id: string
  org_id: string
  name: string
  token: string
  role: Role
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
  base_version: number
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

/** A GitHub numeric user id resolved to the Dock account that signed in with it
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
}

export type NotificationKind = "mention" | "comment" | "share"
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
}
export interface NewCollection {
  id: string
  org_id: string
  title: string
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
  /** Post a Dock comment to the PR (inline review or top-level) when it's on a
   *  PR-sourced artifact. */
  githubPostComments: boolean
  /** Mirror PR comments made on GitHub back into the Dock artifact. */
  githubMirrorComments: boolean
  /** Post Dock activity to the connected Slack workspace. */
  slackPost: boolean
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  emailNotifications: true,
  githubPostComments: true,
  githubMirrorComments: true,
  slackPost: true,
}

/** A connected Slack workspace (one per Dock workspace). `bot_token` is the OAuth bot
 *  token, AES-encrypted at rest. `default_channel` is where Dock posts when an artifact
 *  has no more specific channel. */
export interface SlackInstallRecord {
  org_id: string
  team_id: string
  team_name: string | null
  bot_token: string
  bot_user_id: string | null
  default_channel: string | null
  created_at: string
}

/** Links a Dock comment thread to the Slack message Dock posted for it, so replies
 *  thread under it (Dock→Slack) and Slack thread replies map back (Slack→Dock). */
export interface SlackThreadLinkRecord {
  id: string
  org_id: string
  artifact_id: string
  thread_id: string
  channel: string
  message_ts: string
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
 *  account's selected repos and a Dock workspace. */
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
 * (a `webhook` row). The rest are first-party channels Dock fans out to directly —
 * email (Cloudflare Email Service), a connected Slack App (`chat.postMessage`), and
 * GitHub PR comments (inline review or top-level issue comment). Internal-channel
 * rows carry `webhook_id = "internal"` (no backing `webhook` row); the per-kind
 * sender knows how to build credentials + destination from the payload.
 */
export type DeliveryKind =
  | WebhookKind
  | "slack_app"
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
}

/** A bundle version's blob is this manifest; file versions point at content directly. */
export interface BundleManifest {
  entry: string
  spa: boolean
  files: Record<string, { key: string; type: string }>
}

export const BUNDLE_CONTENT_TYPE = "dock/bundle"
