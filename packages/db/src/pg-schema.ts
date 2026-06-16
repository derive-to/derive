import type {
  AgentMentionState,
  ArtifactKind,
  AuditAction,
  CommentState,
  DeliveryStatus,
  DomainKind,
  DomainStatus,
  GeneralRole,
  NotificationKind,
  ProposalState,
  ReportState,
  Role,
  Visibility,
  WebhookKind,
} from "@dock/core"
import { getTableConfig, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"

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
  removed_at: text("removed_at"),
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
  files: text("files").notNull().default("{}"),
  last_synced_at: text("last_synced_at"),
  last_status: text("last_status"),
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

// Boot DDL is GENERATED from the drizzle tables above (see buildPgSchemaStatements):
// every CREATE TABLE's column list is derived from the table's own definition, so a
// column added above can't be missing here — the cross-dialect drift that previously
// shipped a broken Postgres schema (current_content_type) is now structurally
// impossible. Only the index list and the not-yet-queried placeholder tables
// (principal/acl/view), which have no drizzle def, stay explicit.

// created_at / next_attempt_at use an app-side $defaultFn (Date.now()); mirror it as
// a SQL backstop so a non-drizzle insert still gets a timestamp.
const isoDefault = `to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

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
  artifactTag,
  collection,
  collectionItem,
  collectionMember,
  repoSource,
  domain,
  proposal,
  report,
  auditLog,
]

// biome-ignore lint/suspicious/noExplicitAny: drizzle's column/index runtime shapes aren't exported as a stable type.
type Col = any
const sqlType = (c: Col): string => c.getSQLType().toUpperCase() // text/integer → TEXT/INTEGER
const sqlDefault = (c: Col): string | null => {
  if (c.default !== undefined)
    return typeof c.default === "string" ? `'${c.default}'` : `${c.default}`
  // $defaultFn columns report hasDefault with no literal value → use the SQL backstop.
  return c.hasDefault ? isoDefault : null
}
const columnDef = (c: Col): string => {
  const parts = [c.name, sqlType(c)]
  if (c.primary) parts.push("PRIMARY KEY")
  else if (c.notNull) parts.push("NOT NULL")
  if (c.isUnique && !c.primary) parts.push("UNIQUE")
  const def = sqlDefault(c)
  if (def) parts.push(`DEFAULT ${def}`)
  return parts.join(" ")
}
// Forward-compat for an existing DB missing a newly-added column. Idempotent; a
// no-op once the column exists. Omits PK/UNIQUE/FK (those only matter at CREATE).
const addColumn = (table: string, c: Col): string => {
  const parts = [`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${c.name} ${sqlType(c)}`]
  if (c.notNull && !c.primary) parts.push("NOT NULL")
  const def = sqlDefault(c)
  if (def) parts.push(`DEFAULT ${def}`)
  return parts.join(" ")
}
const createTable = (table: Col): string => {
  const cfg = getTableConfig(table)
  const lines = cfg.columns.map(columnDef)
  for (const idx of cfg.indexes)
    if (idx.config.unique)
      lines.push(`UNIQUE (${idx.config.columns.map((x: Col) => x.name).join(", ")})`)
  for (const fk of cfg.foreignKeys) {
    const r = fk.reference()
    const local = r.columns.map((x: Col) => x.name).join(", ")
    const target = getTableConfig(r.foreignTable).name
    const cols = r.foreignColumns.map((x: Col) => x.name).join(", ")
    lines.push(`FOREIGN KEY (${local}) REFERENCES ${target}(${cols})`)
  }
  return `CREATE TABLE IF NOT EXISTS ${cfg.name} (\n  ${lines.join(",\n  ")}\n)`
}

/** Build the boot DDL from the drizzle table defs + the explicit (non-drizzle)
 *  placeholder tables and indexes. Pure; exported for the conformance test. */
export const buildPgSchemaStatements = (): string[] => {
  const out: string[] = []
  for (const t of TABLES) {
    const cfg = getTableConfig(t)
    out.push(createTable(t))
    for (const c of cfg.columns) out.push(addColumn(cfg.name, c))
    // Unique indexes render inline in CREATE (above); a non-unique drizzle index
    // becomes a CREATE INDEX so it can't be silently dropped if one is ever added.
    for (const idx of cfg.indexes)
      if (!idx.config.unique)
        out.push(
          `CREATE INDEX IF NOT EXISTS ${idx.config.name} ON ${cfg.name} (${idx.config.columns
            .map((x: Col) => x.name)
            .join(", ")})`,
        )
  }
  return [...out, ...PLACEHOLDER_TABLES, ...INDEXES]
}

// Tables created up front but not yet queried (no drizzle def), so migrations stay
// forward-only. They reference `artifact`, which the generated tables create first.
const PLACEHOLDER_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS principal (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT,
    kind TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL DEFAULT ${isoDefault}
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
    created_at TEXT NOT NULL DEFAULT ${isoDefault}
  )`,
]

// Performance indexes (not unique — the unique ones are inline UNIQUE constraints
// generated from each table's uniqueIndex defs). Applied after every table exists.
const INDEXES: string[] = [
  // Library feed: scope by org_id + keyset order on (created_at, id) desc. One
  // composite serves both; Postgres backward-scans it for the DESC order.
  `CREATE INDEX IF NOT EXISTS artifact_org_created ON artifact (org_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS view_artifact_time ON view (artifact_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS delivery_due ON webhook_delivery (status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS notification_user_time ON notification (user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS agent_mention_inbox ON agent_mention (agent_id, state, created_at)`,
  `CREATE INDEX IF NOT EXISTS favorite_user ON artifact_favorite (user_id)`,
  `CREATE INDEX IF NOT EXISTS tag_name ON artifact_tag (tag)`,
  `CREATE INDEX IF NOT EXISTS collection_item_artifact ON collection_item (artifact_id)`,
  `CREATE INDEX IF NOT EXISTS collection_member_user ON collection_member (user_id)`,
  `CREATE INDEX IF NOT EXISTS repo_source_org ON repo_source (org_id)`,
  `CREATE INDEX IF NOT EXISTS domain_artifact ON domain (artifact_id)`,
  `CREATE INDEX IF NOT EXISTS proposal_artifact_state ON proposal (artifact_id, state)`,
  `CREATE INDEX IF NOT EXISTS report_state ON report (state, created_at)`,
  `CREATE INDEX IF NOT EXISTS audit_artifact ON audit_log (artifact_id, created_at)`,
]

export const PG_SCHEMA_STATEMENTS: string[] = buildPgSchemaStatements()
