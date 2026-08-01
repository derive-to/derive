// Schema parity spec — shared by every dialect (sqlite/d1 via repos.ts, pg via
// pg.ts). It does two things at compile time:
//
//   1. EXHAUSTIVENESS — every drizzle table must be CLASSIFIED, either as a
//      typed table (mapped to its @derive/core Record in `TypedTables`) or as a
//      junction table (named in `JunctionTable`). Add a `sqliteTable`/`pgTable`
//      without classifying it and `Exhaustive<typeof schema>` stops being
//      `true`, so the guard in the driver fails to compile. No more "added a
//      table, forgot the parity check."
//
//   2. SHAPE — each typed table's inferred row (`$inferSelect`) must EXACTLY
//      match its core Record type. Drift a column and `Shapes<typeof schema>`
//      flags exactly which table broke.

import type {
  AgentMentionRecord,
  AgentRecord,
  ArtifactInviteRecord,
  ArtifactMemberRecord,
  ArtifactRecord,
  AssetRecord,
  AuditLogRecord,
  AutomationRecord,
  BetaSignupRecord,
  CollectionMemberRecord,
  CollectionRecord,
  CommentRecord,
  ConnectionRecord,
  ContextAskerRecord,
  ContextRecord,
  DeliveryRecord,
  DomainRecord,
  FolderRecord,
  FollowRecord,
  GitHubAppRecord,
  GitHubInstallationRecord,
  InvitationRecord,
  MembershipRecord,
  NotificationRecord,
  PlanRecord,
  ProposalRecord,
  RenderJobRecord,
  ReportRecord,
  RepoSourceRecord,
  ReviewRoundRecord,
  RunRecord,
  SessionMessageRecord,
  SessionRecord,
  SignupAttributionRecord,
  SubscriptionRecord,
  VersionDataRecord,
  VersionRecord,
  WebhookRecord,
  WorkspaceRecord,
} from "@derive/core"

/** A is structurally identical to B (assignable both ways). */
export type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** Drizzle tables that mirror a core Record type — their shape is parity-checked. */
export interface TypedTables {
  artifact: ArtifactRecord
  version: VersionRecord
  versionData: VersionDataRecord
  comment: CommentRecord
  webhook: WebhookRecord
  webhookDelivery: DeliveryRecord
  renderJob: RenderJobRecord
  membership: MembershipRecord
  workspace: WorkspaceRecord
  artifactMember: ArtifactMemberRecord
  notification: NotificationRecord
  follow: FollowRecord
  proposal: ProposalRecord
  reviewRound: ReviewRoundRecord
  agent: AgentRecord
  agentMention: AgentMentionRecord
  automation: AutomationRecord
  run: RunRecord
  plan: PlanRecord
  connection: ConnectionRecord
  artifactInvite: ArtifactInviteRecord
  invitation: InvitationRecord
  betaSignup: BetaSignupRecord
  signupAttribution: SignupAttributionRecord
  subscription: SubscriptionRecord
  context: ContextRecord
  contextAsker: ContextAskerRecord
  contextSession: SessionRecord
  sessionMessage: SessionMessageRecord
  collection: CollectionRecord
  collectionMember: CollectionMemberRecord
  folder: FolderRecord
  repoSource: RepoSourceRecord
  githubApp: GitHubAppRecord
  githubInstallation: GitHubInstallationRecord
  domain: DomainRecord
  report: ReportRecord
  auditLog: AuditLogRecord
  asset: AssetRecord
}

/**
 * Junction tables with no dedicated core Record (simple link rows whose shape
 * isn't mirrored in @derive/core). Naming a table here is a deliberate opt-out of
 * shape parity — but it still has to be named, so it can't be forgotten.
 */
export type JunctionTable =
  | "artifactFavorite"
  | "collectionFavorite"
  | "artifactTag"
  | "collectionItem"
  | "oauthClientWorkspace"

type ClassifiedKey = keyof TypedTables | JunctionTable

/** `true` iff the schema's table keys are exactly the classified keys. */
export type Exhaustive<Schema> = [Exclude<keyof Schema, ClassifiedKey>] extends [never]
  ? [Exclude<ClassifiedKey, keyof Schema>] extends [never]
    ? true
    : false
  : false

/** Per-typed-table shape parity for a given dialect's `schema` object. */
export type Shapes<Schema> = {
  [K in keyof TypedTables]: K extends keyof Schema
    ? Schema[K] extends { $inferSelect: infer Row }
      ? Exact<Row, TypedTables[K]>
      : false
    : false
}
