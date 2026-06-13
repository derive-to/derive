/**
 * Core owns the ports; packages/db and packages/storage provide the adapters.
 * Everything here must run on Node AND Cloudflare Workers — no Node APIs.
 */
import type { Role } from "./permissions"

export interface BlobStore {
  /** Content-addressed put; returns the sha256 hex key. Idempotent. */
  put(data: Uint8Array): Promise<string>
  get(key: string): Promise<Uint8Array | null>
}

export type ArtifactKind = "file" | "bundle"
export type Visibility = "public" | "link" | "org" | "password"

export interface ArtifactRecord {
  id: string
  short_id: string
  org_id: string
  slug: string | null
  title: string | null
  visibility: Visibility
  kind: ArtifactKind
  spa: 0 | 1
  current_version: number
  created_at: string
  /** A takedown tombstone: when set, the content is gone (410) but the record stays. */
  removed_at: string | null
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
  /** Scope to one workspace (multi-workspace). Omitted ⇒ every workspace. */
  orgId?: string
}

export interface VersionRecord {
  id: string
  artifact_id: string
  n: number
  blob_key: string
  content_type: string
  author: string
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
  kind: ArtifactKind
  spa: 0 | 1
}

export interface NewVersion {
  id: string
  blob_key: string
  content_type: string
  author: string
  message: string | null
  name?: string | null
}

export interface MetaStore {
  createArtifact(a: NewArtifact): Promise<ArtifactRecord>
  getByShortId(shortId: string): Promise<ArtifactRecord | null>
  /** Appends the next version and bumps current_version. */
  addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord>
  listVersions(artifactId: string): Promise<VersionRecord[]>
  getVersion(artifactId: string, n: number): Promise<VersionRecord | null>

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
  /** Total artifact count, scoped to a workspace when orgId is given. */
  countArtifacts(orgId?: string): Promise<number>
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
  /** Aggregated view analytics for one artifact. */
  viewStats(artifactId: string): Promise<ViewStats>
  /** Total view counts for many artifacts at once (no N+1). */
  viewCounts(artifactIds: string[]): Promise<Record<string, number>>

  // ---- Webhooks + outbox -------------------------------------------------
  createWebhook(w: NewWebhook): Promise<WebhookRecord>
  listWebhooks(): Promise<WebhookRecord[]>
  getWebhook(id: string): Promise<WebhookRecord | null>
  deleteWebhook(id: string): Promise<void>
  /** Active webhooks that fire for this artifact (incl. global, artifact_id null). */
  activeWebhooks(artifactId: string): Promise<WebhookRecord[]>
  /** Enqueue a delivery into the outbox (target is denormalized for durability). */
  enqueueDelivery(d: NewDelivery): Promise<void>
  /** Pending deliveries whose next_attempt_at has passed, oldest first. */
  claimDueDeliveries(now: string, limit: number): Promise<DeliveryRecord[]>
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
  /** Insert or update a per-artifact role override (a share). */
  setArtifactMember(m: NewArtifactMember): Promise<ArtifactMemberRecord>
  removeArtifactMember(artifactId: string, userId: string): Promise<void>

  // ---- Favorites (per-user stars) + tags (browse metadata) ---------------
  /** Artifact ids this user has starred. */
  listUserFavoriteIds(userId: string): Promise<string[]>
  setFavorite(artifactId: string, userId: string): Promise<void>
  removeFavorite(artifactId: string, userId: string): Promise<void>
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
  deleteAgent(id: string): Promise<void>
  /** Queue a mention into an agent's pull inbox. */
  createAgentMention(m: NewAgentMention): Promise<void>
  /** Pending (unhandled) mentions for an agent, oldest first. */
  listPendingAgentMentions(agentId: string, limit: number): Promise<AgentMentionRecord[]>
  /** Mark a mention handled; false if it isn't this agent's or doesn't exist. */
  ackAgentMention(agentId: string, id: string): Promise<boolean>

  // ---- Moderation: abuse reports, takedown, audit log --------------------
  createReport(r: NewReport): Promise<ReportRecord>
  listReports(opts?: { state?: ReportState; limit?: number }): Promise<ReportRecord[]>
  countOpenReports(): Promise<number>
  setReportState(id: string, state: ReportState): Promise<void>
  /** Set or clear an artifact's takedown tombstone (the record is never deleted). */
  setArtifactRemoved(id: string, removedAt: string | null): Promise<void>
  createAuditLog(a: NewAuditLog): Promise<void>
  /** Moderation history, newest first; all of it, or one artifact's. */
  listAuditLog(opts?: { artifactId?: string; limit?: number }): Promise<AuditLogRecord[]>
}

export type ReportState = "open" | "actioned" | "dismissed"
/** An abuse report against a public artifact. Anyone can file one. */
export interface ReportRecord {
  id: string
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
  artifact_id: string
  artifact_short_id: string
  reason: string
  detail?: string | null
  reporter?: string | null
}

export type AuditAction = "report" | "takedown" | "reinstate" | "dismiss"
/** An immutable moderation-action record. */
export interface AuditLogRecord {
  id: string
  action: AuditAction
  artifact_id: string | null
  /** Who acted: a user/agent display name, or "system" for an anonymous report. */
  actor: string
  detail: string | null
  created_at: string
}
export interface NewAuditLog {
  id: string
  action: AuditAction
  artifact_id?: string | null
  actor: string
  detail?: string | null
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
  base_version: number
}

/** A person, as needed for sharing UIs. Sourced from Better Auth's user table. */
export interface UserDir {
  id: string
  email: string
  name: string | null
}

export type NotificationKind = "mention" | "comment"
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

export interface WebhookRecord {
  id: string
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
  artifact_id?: string | null
  url: string
  secret: string
  kind: WebhookKind
  events: string
  label?: string | null
}

export interface DeliveryRecord {
  id: string
  webhook_id: string
  url: string
  secret: string
  kind: WebhookKind
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
  kind: WebhookKind
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
  perVersion: { version: number; count: number }[]
  /** Daily counts over the trailing window, oldest first. */
  daily: { day: string; count: number }[]
  /** Most-recent distinct viewers, newest first. */
  recent: { viewer: string; kind: "user" | "anon"; at: string }[]
}

export type CommentState = "open" | "resolved"

export interface CommentRecord {
  id: string
  artifact_id: string
  thread_id: string
  base_version: number
  path: string | null
  anchor: string | null
  body_md: string
  author: string
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
}

/** A bundle version's blob is this manifest; file versions point at content directly. */
export interface BundleManifest {
  entry: string
  spa: boolean
  files: Record<string, { key: string; type: string }>
}

export const BUNDLE_CONTENT_TYPE = "dock/bundle"
