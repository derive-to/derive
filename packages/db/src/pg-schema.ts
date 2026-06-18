import type {
  AgentMentionState,
  ArtifactKind,
  AuditAction,
  CommentState,
  DeliveryStatus,
  DomainKind,
  DomainStatus,
  FollowKind,
  GeneralRole,
  NotificationKind,
  ProposalState,
  ReportState,
  Role,
  Visibility,
  WebhookKind,
} from "@dock/core"
import { getTableConfig, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"
import { generateDdl, PERF_INDEXES, placeholderTables } from "./ddl"

// Postgres drizzle schema — the query source of truth, dialect-paired with the
// SQLite defs in schema.ts. created_at is ISO-8601 text so record shapes and
// lexical sort match the SQLite driver exactly. Client-side timestamp defaults
// (kept out of the column type) keep inserts optional without sql() fragments.
const isoNow = () => new Date().toISOString()

export const artifact = pgTable("artifact", {
  id: text("id").primaryKey(),
  short_id: text("short_id").notNull().unique(),
  org_id: text("org_id").notNull().default("local"),
  slug: text("slug"),
  title: text("title"),
  visibility: text("visibility").$type<Visibility>().notNull().default("link"),
  password_hash: text("password_hash"),
  general_role: text("general_role").$type<GeneralRole>().notNull().default("viewer"),
  kind: text("kind").$type<ArtifactKind>().notNull(),
  spa: integer("spa").$type<0 | 1>().notNull().default(0),
  locked: integer("locked").$type<0 | 1>().notNull().default(0),
  current_version: integer("current_version").notNull().default(0),
  current_content_type: text("current_content_type"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
  // Set on every new version; null until first versioned (coalesces to created_at).
  updated_at: text("updated_at"),
  removed_at: text("removed_at"),
  source_path: text("source_path"),
  // The CURRENT (last) author, denormalized from the latest version for the list view +
  // author filtering. For a GitHub-synced artifact these mirror the last commit's author.
  // All nullable (legacy/anonymous/non-synced rows). Mirrors schema.ts.
  author_name: text("author_name"),
  author_login: text("author_login"),
  author_avatar: text("author_avatar"),
  author_gh_id: text("author_gh_id"),
  // The Dock user who created this artifact (set on publish) — drives "follow a person"
  // for hand-published work. Nullable; mirrors schema.ts.
  author_id: text("author_id"),
})

export const version = pgTable(
  "version",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    n: integer("n").notNull(),
    blob_key: text("blob_key").notNull(),
    content_type: text("content_type").notNull(),
    size_bytes: integer("size_bytes").notNull().default(0),
    author: text("author").notNull(),
    // The GitHub identity behind this version, when synced (login / avatar / numeric
    // user id as text). All nullable — manual/anonymous/unmappable publishes leave them
    // null and `author` carries the display name. Mirrors schema.ts.
    author_login: text("author_login"),
    author_avatar: text("author_avatar"),
    author_gh_id: text("author_gh_id"),
    message: text("message"),
    name: text("name"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  // (artifact_id, n) is unique — addVersion relies on it to turn a concurrent
  // version-number race into a clean constraint error. The SQLite def declares the
  // same; previously the pg DDL had it inline but this drizzle def didn't.
  (t) => [uniqueIndex("version_artifact_n").on(t.artifact_id, t.n)],
)

export const comment = pgTable("comment", {
  id: text("id").primaryKey(),
  artifact_id: text("artifact_id")
    .notNull()
    .references(() => artifact.id),
  thread_id: text("thread_id").notNull(),
  base_version: integer("base_version").notNull(),
  path: text("path"),
  anchor: text("anchor"),
  body_md: text("body_md").notNull(),
  author: text("author").notNull(),
  // Stable identity of the author (user or agent id). Authorization keys on this,
  // never the mutable display `author` name. Nullable for legacy/anonymous rows.
  author_id: text("author_id"),
  state: text("state").$type<CommentState>().notNull().default("open"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
  meta: text("meta"),
})

export const webhook = pgTable("webhook", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("default"),
  artifact_id: text("artifact_id").references(() => artifact.id),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  kind: text("kind").$type<WebhookKind>().notNull().default("generic"),
  events: text("events").notNull().default("*"),
  label: text("label"),
  active: integer("active").$type<0 | 1>().notNull().default(1),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

export const webhookDelivery = pgTable("webhook_delivery", {
  id: text("id").primaryKey(),
  webhook_id: text("webhook_id").notNull(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  kind: text("kind").$type<WebhookKind>().notNull(),
  event_type: text("event_type").notNull(),
  payload: text("payload").notNull(),
  status: text("status").$type<DeliveryStatus>().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  next_attempt_at: text("next_attempt_at").notNull().$defaultFn(isoNow),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

export const membership = pgTable(
  "membership",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    user_id: text("user_id").notNull(),
    role: text("role").$type<Role>().notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("membership_org_user").on(t.org_id, t.user_id)],
)

// The workspace itself — just a display name for now (one row per org_id).
export const workspace = pgTable("workspace", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

export const artifactMember = pgTable(
  "artifact_member",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    user_id: text("user_id").notNull(),
    role: text("role").$type<Role>().notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("artifact_member_user").on(t.artifact_id, t.user_id)],
)

export const notification = pgTable("notification", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  actor: text("actor").notNull(),
  kind: text("kind").$type<NotificationKind>().notNull(),
  artifact_id: text("artifact_id").notNull(),
  artifact_short_id: text("artifact_short_id").notNull(),
  artifact_title: text("artifact_title"),
  thread_id: text("thread_id").notNull(),
  comment_id: text("comment_id").notNull(),
  preview: text("preview").notNull(),
  read: integer("read").$type<0 | 1>().notNull().default(0),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

export const agent = pgTable(
  "agent",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    name: text("name").notNull(),
    token: text("token").notNull(),
    role: text("role").$type<Role>().notNull().default("commenter"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [
    uniqueIndex("agent_token").on(t.token),
    uniqueIndex("agent_org_name").on(t.org_id, t.name),
  ],
)

export const agentMention = pgTable("agent_mention", {
  id: text("id").primaryKey(),
  agent_id: text("agent_id").notNull(),
  artifact_id: text("artifact_id").notNull(),
  artifact_short_id: text("artifact_short_id").notNull(),
  comment_id: text("comment_id").notNull(),
  thread_id: text("thread_id").notNull(),
  body: text("body").notNull(),
  author: text("author").notNull(),
  state: text("state").$type<AgentMentionState>().notNull().default("pending"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

export const artifactFavorite = pgTable(
  "artifact_favorite",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    user_id: text("user_id").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("artifact_favorite_user").on(t.artifact_id, t.user_id)],
)

// Per-user follows. One row per (user, org, kind, target). Mirrors schema.ts.
export const follow = pgTable(
  "follow",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    user_id: text("user_id").notNull(),
    kind: text("kind").$type<FollowKind>().notNull(),
    target: text("target").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("follow_user_target").on(t.user_id, t.org_id, t.kind, t.target)],
)

export const artifactTag = pgTable(
  "artifact_tag",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    tag: text("tag").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("artifact_tag_uniq").on(t.artifact_id, t.tag)],
)
export const collection = pgTable("collection", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("local"),
  title: text("title").notNull(),
  created_by: text("created_by").notNull(),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})
export const collectionItem = pgTable(
  "collection_item",
  {
    id: text("id").primaryKey(),
    collection_id: text("collection_id")
      .notNull()
      .references(() => collection.id),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("collection_item_uniq").on(t.collection_id, t.artifact_id)],
)
export const collectionMember = pgTable(
  "collection_member",
  {
    id: text("id").primaryKey(),
    collection_id: text("collection_id")
      .notNull()
      .references(() => collection.id),
    user_id: text("user_id").notNull(),
    role: text("role").$type<Role>().notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("collection_member_uniq").on(t.collection_id, t.user_id)],
)
export const repoSource = pgTable("repo_source", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("local"),
  collection_id: text("collection_id")
    .notNull()
    .references(() => collection.id),
  repo: text("repo").notNull(),
  ref: text("ref").notNull().default("HEAD"),
  includes: text("includes").notNull(),
  token: text("token"),
  installation_id: text("installation_id"),
  files: text("files").notNull().default("{}"),
  last_synced_at: text("last_synced_at"),
  last_status: text("last_status"),
  progress: text("progress"),
  created_by: text("created_by").notNull(),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})
export const githubApp = pgTable("github_app", {
  id: text("id").primaryKey(),
  app_id: text("app_id").notNull(),
  slug: text("slug").notNull(),
  client_id: text("client_id").notNull(),
  client_secret: text("client_secret").notNull(),
  private_key: text("private_key").notNull(),
  webhook_secret: text("webhook_secret").notNull(),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})
export const githubInstallation = pgTable("github_installation", {
  installation_id: text("installation_id").primaryKey(),
  org_id: text("org_id").notNull(),
  account_login: text("account_login"),
  created_by: text("created_by").notNull(),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})
export const domain = pgTable("domain", {
  host: text("host").primaryKey(),
  artifact_id: text("artifact_id").references(() => artifact.id),
  org_id: text("org_id").notNull(),
  kind: text("kind").$type<DomainKind>().notNull().default("subdomain"),
  status: text("status").$type<DomainStatus>().notNull().default("active"),
  cf_hostname_id: text("cf_hostname_id"),
  verification: text("verification"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})
export const proposal = pgTable("proposal", {
  id: text("id").primaryKey(),
  artifact_id: text("artifact_id")
    .notNull()
    .references(() => artifact.id),
  blob_key: text("blob_key").notNull(),
  content_type: text("content_type").notNull(),
  kind: text("kind").$type<ArtifactKind>().notNull(),
  title: text("title"),
  message: text("message"),
  author: text("author").notNull(),
  // Stable identity of the proposer (user or agent id). Withdraw authorization
  // keys on this, never the mutable display `author` name. Nullable for legacy.
  author_id: text("author_id"),
  base_version: integer("base_version").notNull(),
  state: text("state").$type<ProposalState>().notNull().default("open"),
  decided_by: text("decided_by"),
  decided_version: integer("decided_version"),
  decision_note: text("decision_note"),
  decided_at: text("decided_at"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

export const report = pgTable("report", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("default"),
  artifact_id: text("artifact_id").notNull(),
  artifact_short_id: text("artifact_short_id").notNull(),
  reason: text("reason").notNull(),
  detail: text("detail"),
  reporter: text("reporter"),
  state: text("state").$type<ReportState>().notNull().default("open"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("default"),
  action: text("action").$type<AuditAction>().notNull(),
  artifact_id: text("artifact_id"),
  actor: text("actor").notNull(),
  detail: text("detail"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

// Schema parity is enforced in pg.ts, where the pg `schema` object lives — it
// checks these table defs (via `Exhaustive`/`Shapes` in ./parity) against the
// same core Record types the sqlite dialect uses, so the two dialects can't
// disagree. See ./parity.

// Boot DDL, generated from the drizzle tables above (see ./ddl) so the pg schema
// can't drift from the table defs and stays in lockstep with the SQLite + D1 DDL.
// created_at / next_attempt_at use an app-side $defaultFn; this mirrors it as a SQL
// backstop so a non-drizzle insert still gets a timestamp.
const PG_TIMESTAMP_DEFAULT = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

// Drizzle tables, in FK-dependency order (a referenced table is created first).
const TABLES = [
  artifact,
  version,
  comment,
  webhook,
  webhookDelivery,
  membership,
  workspace,
  artifactMember,
  notification,
  agent,
  agentMention,
  artifactFavorite,
  follow,
  artifactTag,
  collection,
  collectionItem,
  collectionMember,
  repoSource,
  githubApp,
  githubInstallation,
  domain,
  proposal,
  report,
  auditLog,
]

/** Build the Postgres boot DDL: generated table/index CREATEs + placeholder tables
 *  + perf indexes, then the idempotent ADD COLUMN IF NOT EXISTS migrations. Pure;
 *  exported for the conformance test. */
export const buildPgSchemaStatements = (): string[] => {
  const { creates, alters } = generateDdl(TABLES, getTableConfig, {
    ifNotExists: true,
    timestampDefault: PG_TIMESTAMP_DEFAULT,
  })
  return [...creates, ...placeholderTables(PG_TIMESTAMP_DEFAULT), ...PERF_INDEXES, ...alters]
}

export const PG_SCHEMA_STATEMENTS: string[] = buildPgSchemaStatements()
