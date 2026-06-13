import type {
  AgentMentionRecord,
  AgentMentionState,
  AgentRecord,
  ArtifactKind,
  ArtifactMemberRecord,
  ArtifactRecord,
  CommentRecord,
  CommentState,
  DeliveryRecord,
  DeliveryStatus,
  MembershipRecord,
  NotificationKind,
  NotificationRecord,
  ProposalRecord,
  ProposalState,
  Role,
  VersionRecord,
  Visibility,
  WebhookKind,
  WebhookRecord,
} from "@dock/core"
import { sql } from "drizzle-orm"
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

// Drizzle tables for the queried entities. One SQLite-dialect schema, shared by
// the better-sqlite3 driver (self-host) and the D1 driver (edge).
export const artifact = sqliteTable("artifact", {
  id: text("id").primaryKey(),
  short_id: text("short_id").notNull().unique(),
  org_id: text("org_id").notNull().default("local"),
  slug: text("slug"),
  title: text("title"),
  visibility: text("visibility").$type<Visibility>().notNull().default("link"),
  kind: text("kind").$type<ArtifactKind>().notNull(),
  spa: integer("spa").$type<0 | 1>().notNull().default(0),
  current_version: integer("current_version").notNull().default(0),
  created_at: text("created_at").notNull().default(now),
})

export const version = sqliteTable(
  "version",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    n: integer("n").notNull(),
    blob_key: text("blob_key").notNull(),
    content_type: text("content_type").notNull(),
    author: text("author").notNull(),
    message: text("message"),
    name: text("name"),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("artifact_version").on(t.artifact_id, t.n)],
)

export const comment = sqliteTable("comment", {
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
  state: text("state").$type<CommentState>().notNull().default("open"),
  created_at: text("created_at").notNull().default(now),
  meta: text("meta"),
})

export const webhook = sqliteTable("webhook", {
  id: text("id").primaryKey(),
  artifact_id: text("artifact_id").references(() => artifact.id),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  kind: text("kind").$type<WebhookKind>().notNull().default("generic"),
  events: text("events").notNull().default("*"),
  label: text("label"),
  active: integer("active").$type<0 | 1>().notNull().default(1),
  created_at: text("created_at").notNull().default(now),
})

export const webhookDelivery = sqliteTable("webhook_delivery", {
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
  next_attempt_at: text("next_attempt_at").notNull().default(now),
  created_at: text("created_at").notNull().default(now),
})

export const membership = sqliteTable(
  "membership",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    user_id: text("user_id").notNull(),
    role: text("role").$type<Role>().notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("membership_org_user").on(t.org_id, t.user_id)],
)

// The workspace itself — just a display name for now (one row per org_id).
export const workspace = sqliteTable("workspace", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  created_at: text("created_at").notNull().default(now),
})

export const artifactMember = sqliteTable(
  "artifact_member",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    user_id: text("user_id").notNull(),
    role: text("role").$type<Role>().notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("artifact_member_user").on(t.artifact_id, t.user_id)],
)

export const notification = sqliteTable("notification", {
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
  created_at: text("created_at").notNull().default(now),
})

// A registered agent: a mentionable principal that acts via a scoped token.
export const agent = sqliteTable(
  "agent",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    name: text("name").notNull(),
    token: text("token").notNull(),
    role: text("role").$type<Role>().notNull().default("commenter"),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("agent_token").on(t.token),
    uniqueIndex("agent_org_name").on(t.org_id, t.name),
  ],
)

// An agent's pull inbox: one row per mention directed at the agent.
export const agentMention = sqliteTable("agent_mention", {
  id: text("id").primaryKey(),
  agent_id: text("agent_id").notNull(),
  artifact_id: text("artifact_id").notNull(),
  artifact_short_id: text("artifact_short_id").notNull(),
  comment_id: text("comment_id").notNull(),
  thread_id: text("thread_id").notNull(),
  body: text("body").notNull(),
  author: text("author").notNull(),
  state: text("state").$type<AgentMentionState>().notNull().default("pending"),
  created_at: text("created_at").notNull().default(now),
})

// Per-user stars. One row per (artifact, user); favorites are personal, never shared.
export const artifactFavorite = sqliteTable(
  "artifact_favorite",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    user_id: text("user_id").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("artifact_favorite_user").on(t.artifact_id, t.user_id)],
)

// Browse tags. One row per (artifact, tag); workspace-wide, not per-user.
export const artifactTag = sqliteTable(
  "artifact_tag",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    tag: text("tag").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("artifact_tag_uniq").on(t.artifact_id, t.tag)],
)

// A named, shareable group of artifacts. Sharing a collection grants its role
// on every artifact inside it (see bestCollectionRole in the drivers).
export const collection = sqliteTable("collection", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("local"),
  title: text("title").notNull(),
  created_by: text("created_by").notNull(),
  created_at: text("created_at").notNull().default(now),
})

export const collectionItem = sqliteTable(
  "collection_item",
  {
    id: text("id").primaryKey(),
    collection_id: text("collection_id")
      .notNull()
      .references(() => collection.id),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("collection_item_uniq").on(t.collection_id, t.artifact_id)],
)

export const collectionMember = sqliteTable(
  "collection_member",
  {
    id: text("id").primaryKey(),
    collection_id: text("collection_id")
      .notNull()
      .references(() => collection.id),
    user_id: text("user_id").notNull(),
    role: text("role").$type<Role>().notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("collection_member_uniq").on(t.collection_id, t.user_id)],
)

export const proposal = sqliteTable("proposal", {
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
  base_version: integer("base_version").notNull(),
  state: text("state").$type<ProposalState>().notNull().default("open"),
  decided_by: text("decided_by"),
  decided_version: integer("decided_version"),
  decision_note: text("decision_note"),
  decided_at: text("decided_at"),
  created_at: text("created_at").notNull().default(now),
})

// user/session/account/verification tables are owned and migrated by Better Auth
// (see apps/api/src/auth-config.ts) — not declared here.

/**
 * Raw DDL run at boot for the self-host SQLite default (zero-config), and used
 * to seed D1 (deploy/d1-schema.sql). Tables not yet queried (comment, principal,
 * acl) are created here up front so migrations stay forward-only.
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS artifact (
    id TEXT PRIMARY KEY,
    short_id TEXT NOT NULL UNIQUE,
    org_id TEXT NOT NULL DEFAULT 'local',
    slug TEXT,
    title TEXT,
    visibility TEXT NOT NULL DEFAULT 'link',
    kind TEXT NOT NULL,
    spa INTEGER NOT NULL DEFAULT 0,
    current_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS version (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    n INTEGER NOT NULL,
    blob_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    author TEXT NOT NULL,
    message TEXT,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (artifact_id, n)
  )`,
  `CREATE TABLE IF NOT EXISTS comment (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    thread_id TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    path TEXT,
    anchor TEXT,
    body_md TEXT NOT NULL,
    author TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    meta TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS principal (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT,
    kind TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS acl (
    artifact_id TEXT PRIMARY KEY REFERENCES artifact(id),
    visibility TEXT NOT NULL,
    password_hash TEXT,
    org_gate TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS view (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    version INTEGER NOT NULL,
    viewer TEXT NOT NULL,
    viewer_kind TEXT NOT NULL DEFAULT 'anon',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS view_artifact_time ON view (artifact_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS webhook (
    id TEXT PRIMARY KEY,
    artifact_id TEXT REFERENCES artifact(id),
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'generic',
    events TEXT NOT NULL DEFAULT '*',
    label TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS webhook_delivery (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    kind TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS delivery_due ON webhook_delivery (status, next_attempt_at)`,
  `CREATE TABLE IF NOT EXISTS membership (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (org_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS artifact_member (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (artifact_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS notification (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    artifact_short_id TEXT NOT NULL,
    artifact_title TEXT,
    thread_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    preview TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS notification_user_time ON notification (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS agent (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'commenter',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (token),
    UNIQUE (org_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_mention (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    artifact_short_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    body TEXT NOT NULL,
    author TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS agent_mention_inbox ON agent_mention (agent_id, state, created_at)`,
  `CREATE TABLE IF NOT EXISTS artifact_favorite (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (artifact_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS favorite_user ON artifact_favorite (user_id)`,
  `CREATE TABLE IF NOT EXISTS artifact_tag (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (artifact_id, tag)
  )`,
  `CREATE INDEX IF NOT EXISTS tag_name ON artifact_tag (tag)`,
  `CREATE TABLE IF NOT EXISTS collection (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL DEFAULT 'local',
    title TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE IF NOT EXISTS collection_item (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collection(id),
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (collection_id, artifact_id)
  )`,
  `CREATE INDEX IF NOT EXISTS collection_item_artifact ON collection_item (artifact_id)`,
  `CREATE TABLE IF NOT EXISTS collection_member (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collection(id),
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (collection_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS collection_member_user ON collection_member (user_id)`,
  `CREATE TABLE IF NOT EXISTS proposal (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id),
    blob_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT,
    message TEXT,
    author TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    decided_by TEXT,
    decided_version INTEGER,
    decision_note TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS proposal_artifact_state ON proposal (artifact_id, state)`,
  // user/session/account/verification are owned and migrated by Better Auth.
]

/**
 * Forward-only column adds for tables that predate them. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so each runs inside a try/catch at boot and a
 * "duplicate column" error is the success path. Keep statements idempotent.
 */
export const MIGRATION_STATEMENTS: string[] = [
  `ALTER TABLE comment ADD COLUMN meta TEXT`,
  `ALTER TABLE version ADD COLUMN name TEXT`,
  `ALTER TABLE proposal ADD COLUMN decision_note TEXT`,
]

// Compile-time guard: the drizzle table defs must exactly match the core record
// shapes. A non-`true` element here is schema drift — fix the table or the type.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _schemaParity: [
  Exact<typeof artifact.$inferSelect, ArtifactRecord>,
  Exact<typeof version.$inferSelect, VersionRecord>,
  Exact<typeof comment.$inferSelect, CommentRecord>,
  Exact<typeof webhook.$inferSelect, WebhookRecord>,
  Exact<typeof webhookDelivery.$inferSelect, DeliveryRecord>,
  Exact<typeof membership.$inferSelect, MembershipRecord>,
  Exact<typeof artifactMember.$inferSelect, ArtifactMemberRecord>,
  Exact<typeof notification.$inferSelect, NotificationRecord>,
  Exact<typeof proposal.$inferSelect, ProposalRecord>,
  Exact<typeof agent.$inferSelect, AgentRecord>,
  Exact<typeof agentMention.$inferSelect, AgentMentionRecord>,
] = [true, true, true, true, true, true, true, true, true, true, true]
void _schemaParity
