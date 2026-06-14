// Schema parity spec — shared by every dialect (sqlite/d1 via repos.ts, pg via
// pg.ts). It does two things at compile time:
//
//   1. EXHAUSTIVENESS — every drizzle table must be CLASSIFIED, either as a
//      typed table (mapped to its @dock/core Record in `TypedTables`) or as a
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
  ArtifactMemberRecord,
  ArtifactRecord,
  AuditLogRecord,
  CollectionMemberRecord,
  CollectionRecord,
  CommentRecord,
  DeliveryRecord,
  MembershipRecord,
  NotificationRecord,
  ProposalRecord,
  ReportRecord,
  RepoSourceRecord,
  VersionRecord,
  WebhookRecord,
  WorkspaceRecord,
} from "@dock/core"

/** A is structurally identical to B (assignable both ways). */
export type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** Drizzle tables that mirror a core Record type — their shape is parity-checked. */
export interface TypedTables {
  artifact: ArtifactRecord
  version: VersionRecord
  comment: CommentRecord
  webhook: WebhookRecord
  webhookDelivery: DeliveryRecord
  membership: MembershipRecord
  workspace: WorkspaceRecord
  artifactMember: ArtifactMemberRecord
  notification: NotificationRecord
  proposal: ProposalRecord
  agent: AgentRecord
  agentMention: AgentMentionRecord
  collection: CollectionRecord
  collectionMember: CollectionMemberRecord
  repoSource: RepoSourceRecord
  report: ReportRecord
  auditLog: AuditLogRecord
}

/**
 * Junction tables with no dedicated core Record (simple link rows whose shape
 * isn't mirrored in @dock/core). Naming a table here is a deliberate opt-out of
 * shape parity — but it still has to be named, so it can't be forgotten.
 */
export type JunctionTable = "artifactFavorite" | "artifactTag" | "collectionItem"

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
