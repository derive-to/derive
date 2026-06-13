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

  listArtifacts(opts?: { limit?: number }): Promise<ArtifactRecord[]>

  /** Append a view event. */
  recordView(v: NewView): Promise<void>
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
  getMembership(orgId: string, userId: string): Promise<MembershipRecord | null>
  listMemberships(orgId: string): Promise<MembershipRecord[]>
  countMemberships(orgId: string): Promise<number>
  /** Insert or update a member's workspace role. */
  setMembership(m: NewMembership): Promise<MembershipRecord>

  getArtifactMember(artifactId: string, userId: string): Promise<ArtifactMemberRecord | null>
  listArtifactMembers(artifactId: string): Promise<ArtifactMemberRecord[]>
  /** Insert or update a per-artifact role override (a share). */
  setArtifactMember(m: NewArtifactMember): Promise<ArtifactMemberRecord>
  removeArtifactMember(artifactId: string, userId: string): Promise<void>

  // ---- User directory (reads Better Auth's `user` table) ----------------
  findUserByEmail(email: string): Promise<UserDir | null>
  getUsers(ids: string[]): Promise<UserDir[]>
}

/** A person, as needed for sharing UIs. Sourced from Better Auth's user table. */
export interface UserDir {
  id: string
  email: string
  name: string | null
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
