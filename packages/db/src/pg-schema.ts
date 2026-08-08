import type {
  AgentMentionState,
  ArtifactKind,
  AuditAction,
  CommentState,
  ConnectionKind,
  ConnectionScope,
  ConnectionStatus,
  DeliveryKind,
  DeliveryStatus,
  DomainKind,
  DomainStatus,
  FollowKind,
  LinkRole,
  Listed,
  NotificationKind,
  PlanKind,
  PreviewStatus,
  ProposalState,
  RenderJobStatus,
  ReportState,
  ReviewRoundState,
  Role,
  RunStatus,
  SessionMessageAuthor,
  SessionState,
  SlackAuthorFilter,
  SlackScopeKind,
  VersionSource,
  WebhookKind,
  WorkspaceAccess,
} from "@derive/core"
import { getTableConfig, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"
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
  // The access model (mirrors schema.ts — see the comment there). Three fields:
  // workspace_access (seat access), link_role (the world link), listed (discovery).
  workspace_access: text("workspace_access").$type<WorkspaceAccess>().notNull().default("none"),
  link_role: text("link_role").$type<LinkRole>().notNull().default("none"),
  listed: text("listed").$type<Listed>().notNull().default("none"),
  password_hash: text("password_hash"),
  kind: text("kind").$type<ArtifactKind>().notNull(),
  spa: integer("spa").$type<0 | 1>().notNull().default(0),
  locked: integer("locked").$type<0 | 1>().notNull().default(0),
  current_version: integer("current_version").notNull().default(0),
  current_content_type: text("current_content_type"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
  // Set on every new version; null until first versioned (coalesces to created_at).
  updated_at: text("updated_at"),
  removed_at: text("removed_at"),
  // Expiring anonymous draft (the claim flow): ISO instant after which the draft is
  // gone — served 410 and swept. Null for every ordinary artifact; cleared on claim.
  expires_at: text("expires_at"),
  // First non-author view (the activation moment; see schema.ts).
  first_foreign_view_at: text("first_foreign_view_at"),
  // Owner opt-in: anon public page shows version history (see schema.ts).
  public_history: integer("public_history").$type<0 | 1>(),
  source_path: text("source_path"),
  // The CURRENT (last) author, denormalized from the latest version for the list view +
  // author filtering. For a GitHub-synced artifact these mirror the last commit's author.
  // All nullable (legacy/anonymous/non-synced rows). Mirrors schema.ts.
  author_name: text("author_name"),
  author_login: text("author_login"),
  author_avatar: text("author_avatar"),
  author_gh_id: text("author_gh_id"),
  // The Derive user who last published this by hand; null for sync/token/legacy. Mirrors
  // schema.ts — drives the profile work-list + people-follow.
  author_id: text("author_id"),
  // Remix lineage: the artifact id this was derived from. Not an FK (the source may be
  // deleted; the copy survives). Nullable, no default — ADD COLUMN IF NOT EXISTS clean.
  derived_from: text("derived_from"),
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
    // The Derive user who published this version by hand; null for sync/anon/legacy.
    author_id: text("author_id"),
    // Which surface created this version ('web' | 'mcp' | 'api' | 'sync') — the
    // onboarding/analytics stamp. Mirrors schema.ts.
    source: text("source").$type<VersionSource>(),
    message: text("message"),
    name: text("name"),
    preview_key: text("preview_key"),
    preview_status: text("preview_status").$type<PreviewStatus>(),
    preview_error: text("preview_error"),
    // Two more render-rung variants, agent-facing only — see the matching comment in
    // schema.ts for what each is and why they're a separate best-effort triple rather
    // than replacing the OG crop.
    preview_full_key: text("preview_full_key"),
    preview_full_status: text("preview_full_status").$type<PreviewStatus>(),
    preview_full_error: text("preview_full_error"),
    preview_marked_key: text("preview_marked_key"),
    preview_marked_status: text("preview_marked_status").$type<PreviewStatus>(),
    preview_marked_error: text("preview_marked_error"),
    // The generated one-line description of this version, and a hash of the text it was
    // generated from so an unchanged republish copies it forward instead of regenerating.
    // See the matching comment in schema.ts. Mirrors schema.ts.
    summary: text("summary"),
    summary_src_hash: text("summary_src_hash"),
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
  kind: text("kind").$type<DeliveryKind>().notNull(),
  event_type: text("event_type").notNull(),
  payload: text("payload").notNull(),
  status: text("status").$type<DeliveryStatus>().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  next_attempt_at: text("next_attempt_at").notNull().$defaultFn(isoNow),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

export const renderJob = pgTable("render_job", {
  id: text("id").primaryKey(),
  artifact_id: text("artifact_id").notNull(),
  version_n: integer("version_n").notNull(),
  status: text("status").$type<RenderJobStatus>().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  next_attempt_at: text("next_attempt_at").notNull().$defaultFn(isoNow),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

// An automation: a standing agent job (agent + trigger + instruction + refs). The
// definition only; every firing is a `run`. See schema.ts for the full contract.
export const automation = pgTable("automation", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull(),
  agent_id: text("agent_id").notNull(),
  trigger: text("trigger").notNull(),
  instruction: text("instruction").notNull(),
  provider: text("provider")
    .$type<import("@derive/core").ExecutionProvider>()
    .notNull()
    .default("claude-code"),
  refs: text("refs"),
  connection_ids: text("connection_ids"),
  context_id: text("context_id"),
  enabled: integer("enabled").$type<0 | 1>().notNull().default(1),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

// A run: one execution — the queue and the ledger in one table. See schema.ts.
export const run = pgTable("run", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull(),
  automation_id: text("automation_id"),
  agent_id: text("agent_id").notNull(),
  reason: text("reason").notNull(),
  // The initiating person (wallet key) — null for clock/event runs. See RunRecord.
  initiated_by: text("initiated_by"),
  status: text("status").$type<RunStatus>().notNull(),
  scheduled_for: text("scheduled_for"),
  started_at: text("started_at"),
  finished_at: text("finished_at"),
  cost_micro_usd: integer("cost_micro_usd"),
  meta: text("meta"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

// A bring-your-own plan (WO2): see schema.ts.
export const plan = pgTable("plan", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull(),
  user_id: text("user_id"),
  kind: text("kind").$type<PlanKind>().notNull(),
  provider: text("provider").notNull(),
  secret_enc: text("secret_enc").notNull(),
  limits: text("limits"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

// A per-user connected external account (WO3): see schema.ts.
export const connection = pgTable("connection", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull(),
  user_id: text("user_id").notNull(),
  scope: text("scope").$type<ConnectionScope>().notNull().default("personal"),
  kind: text("kind").$type<ConnectionKind>().notNull().default("oauth"),
  secret_enc: text("secret_enc"),
  base_url: text("base_url"),
  broker: text("broker").notNull(),
  toolkit: text("toolkit").notNull(),
  broker_ref: text("broker_ref").notNull(),
  scopes_label: text("scopes_label"),
  status: text("status").$type<ConnectionStatus>().notNull().default("pending"),
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
    // Who registered the agent — the person it publishes on behalf of (see schema.ts).
    created_by: text("created_by"),
    // Served by Derive's managed executor when 1 (see schema.ts).
    hosted: integer("hosted").notNull().default(0).$type<0 | 1>(),
    // 1 = auto-minted for one context at creation (never user-named): the context's
    // Derive access, not a persona. The UI hides managed agents from the roster.
    managed: integer("managed").notNull().default(0).$type<0 | 1>(),
    // The runs-lane liveness mark (twin of context.runner_seen_at): stamped when the
    // agent's bearer polls the run claim endpoint. Null = no executor has ever polled.
    runs_seen_at: text("runs_seen_at"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [
    uniqueIndex("agent_token").on(t.token),
    uniqueIndex("agent_org_name").on(t.org_id, t.name),
  ],
)

// A pending workspace invitation (see schema.ts) — invite-by-email → accept.
export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    email: text("email").notNull(),
    role: text("role").$type<Role>().notNull().default("editor"),
    token: text("token").notNull(),
    invited_by: text("invited_by"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
    expires_at: text("expires_at").notNull(),
    accepted_at: text("accepted_at"),
  },
  (t) => [
    uniqueIndex("invitation_token").on(t.token),
    index("invitation_org_email").on(t.org_id, t.email),
  ],
)

// A pending per-artifact share invitation (see schema.ts for the full note).
export const artifactInvite = pgTable(
  "artifact_invite",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id").notNull(),
    email: text("email").notNull(),
    role: text("role").$type<Role>().notNull().default("commenter"),
    token: text("token").notNull(),
    invited_by: text("invited_by"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
    expires_at: text("expires_at").notNull(),
    accepted_at: text("accepted_at"),
  },
  (t) => [
    uniqueIndex("artifact_invite_token").on(t.token),
    index("artifact_invite_artifact_email").on(t.artifact_id, t.email),
  ],
)

// A beta signup from the marketing site (see schema.ts for the full note).
export const betaSignup = pgTable(
  "beta_signup",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("beta_signup_email").on(t.email)],
)

// Where a signup came from (see schema.ts for the full note).
export const signupAttribution = pgTable(
  "signup_attribution",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    source_kind: text("source_kind").notNull(),
    source_artifact: text("source_artifact"),
    landing_path: text("landing_path"),
    referrer: text("referrer"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("signup_attribution_user").on(t.user_id)],
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

// The SET of workspaces an OAuth client's grants are scoped to for one user — the
// workspaces ticked on the consent screen. ONE ROW PER GRANTED WORKSPACE
// (composite-unique on user+client+org). An EMPTY set (no rows) means "all
// workspaces"; a non-empty set restricts the grant to exactly those. Re-consent
// replaces the set. See the sqlite mirror in schema.ts for the full rationale.
export const oauthClientWorkspace = pgTable(
  "oauth_client_workspace",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    client_id: text("client_id").notNull(),
    org_id: text("org_id").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [
    uniqueIndex("oauth_client_workspace_user_client_org").on(t.user_id, t.client_id, t.org_id),
  ],
)

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
  // See the sqlite dialect's schema.ts for the full comment. Defaults to `member`
  // (not artifact's fail-closed `none`) to match collections' existing behavior.
  workspace_access: text("workspace_access").$type<WorkspaceAccess>().notNull().default("member"),
  // See schema.ts for the full comment: the org-shared folder this collection is filed
  // under (null = ungrouped). Plain nullable pointer, NOT a FK — folders grant no access.
  folder_id: text("folder_id"),
})
// A workspace-shared organizing folder for collections (see schema.ts). Grouping only —
// grants no access, never in any auth path.
export const folder = pgTable("folder", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("local"),
  // The collection this folder organizes (see schema.ts). App-required, nullable at DB,
  // FK-free.
  collection_id: text("collection_id"),
  name: text("name").notNull(),
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
    // Folder within this collection (see schema.ts); null = unfiled. FK-free.
    folder_id: text("folder_id"),
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

// Starred collections — see the SQLite twin in schema.ts for why this is a sibling
// table rather than a kind column on artifact_favorite.
export const collectionFavorite = pgTable(
  "collection_favorite",
  {
    id: text("id").primaryKey(),
    collection_id: text("collection_id")
      .notNull()
      .references(() => collection.id),
    user_id: text("user_id").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("collection_favorite_user").on(t.collection_id, t.user_id)],
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
  // PR preview discriminator — see schema.ts (sqlite) for the contract. NULL = a
  // normal branch mirror; set = a read-only preview of that PR's changed docs.
  pr_number: integer("pr_number"),
  files: text("files").notNull().default("{}"),
  last_synced_at: text("last_synced_at"),
  last_status: text("last_status"),
  progress: text("progress"),
  created_by: text("created_by").notNull(),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})
export const orgSettings = pgTable("org_settings", {
  org_id: text("org_id").primaryKey(),
  settings: text("settings").notNull().default("{}"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})
export const subscription = pgTable("subscription", {
  org_id: text("org_id").primaryKey(),
  stripe_customer_id: text("stripe_customer_id").notNull(),
  stripe_subscription_id: text("stripe_subscription_id"),
  tier: text("tier").$type<"team" | "business">().notNull(),
  billing_interval: text("billing_interval").$type<"month" | "year">().notNull(),
  status: text("status").notNull(),
  quantity: integer("quantity").notNull(),
  current_period_end: text("current_period_end"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
  updated_at: text("updated_at").notNull(),
})
export const slackInstall = pgTable("slack_install", {
  org_id: text("org_id").primaryKey(),
  team_id: text("team_id").notNull(),
  team_name: text("team_name"),
  bot_token: text("bot_token").notNull(),
  bot_user_id: text("bot_user_id"),
  needs_reauth: integer("needs_reauth").notNull().default(0).$type<0 | 1>(),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})
export const userNotificationPref = pgTable(
  "user_notification_pref",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    user_id: text("user_id").notNull(),
    prefs: text("prefs").notNull().default("{}"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("user_notification_pref_key").on(t.org_id, t.user_id)],
)
// Per-user model-plan credential (Claude/Codex plan token or API key), encrypted at rest
// and scoped (org, user, provider). Used only for that user's own runs — see schema.ts.
export const modelCredential = pgTable(
  "model_credential",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    user_id: text("user_id").notNull(),
    provider: text("provider").notNull(),
    kind: text("kind").$type<"oauth" | "api_key" | "login">().notNull(),
    secret: text("secret").notNull(),
    hint: text("hint").notNull().default(""),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
    updated_at: text("updated_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("model_credential_key").on(t.org_id, t.user_id, t.provider)],
)
export const slackThreadLink = pgTable(
  "slack_thread_link",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    artifact_id: text("artifact_id").notNull(),
    thread_id: text("thread_id").notNull(),
    channel: text("channel").notNull(),
    message_ts: text("message_ts").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [
    // One Slack message per (Derive thread, channel): a thread mirrors into every channel
    // subscribed to its artifact, so the same thread legitimately has several messages.
    // Reply-back still resolves uniquely off (channel, message_ts) below.
    uniqueIndex("slack_thread_link_thread").on(t.thread_id, t.channel),
    uniqueIndex("slack_thread_link_msg").on(t.channel, t.message_ts),
  ],
)
export const slackUserLink = pgTable(
  "slack_user_link",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    user_id: text("user_id").notNull(),
    team_id: text("team_id").notNull(),
    slack_user_id: text("slack_user_id").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
    /**
     * HOW this identity was established, and the reason a MISS can share the table.
     *
     * 'oauth' — the person deliberately linked through Slack sign-in.
     * 'email' — inferred from their Slack profile email, which resolved to a seat.
     * 'miss'  — we looked and found nobody. NOT a link: it is the memo that stops us
     *           re-asking Slack and re-prompting the person on every message.
     *
     * A miss and a link occupy the SAME (team_id, slack_user_id) row, so a later success
     * simply replaces the miss through the existing upsert — self-healing, no cleanup job.
     * getSlackUserLinkBySlackId/ByUser filter miss rows out, so every existing caller keeps
     * its contract that a returned row is a real Derive user.
     */
    origin: text("origin").notNull().default("oauth").$type<"oauth" | "email" | "miss">(),
    /** When we last CHECKED. Distinct from created_at, which the upsert preserves: a miss
     *  has to be able to age out and be retried.
     *
     *  NULLABLE so it can be ALTER-added to a populated table. A NOT NULL column whose only
     *  default is a $defaultFn is initial-only (see isMigratable in ddl.ts) — it would have
     *  reached a fresh database and silently never reached an existing one. Null means "never
     *  checked by this mechanism", which is exactly what every pre-existing link row is. */
    checked_at: text("checked_at"),
  },
  (t) => [
    uniqueIndex("slack_user_link_slack").on(t.team_id, t.slack_user_id),
    index("slack_user_link_user").on(t.team_id, t.user_id),
  ],
)
// A Slack channel subscribed to a workspace's activity. Replaces the single
// `slack_install.default_channel`: a team routes design docs to one channel and specs to
// another, scoped to a collection and filtered by event — and by whether the author was a
// HUMAN or an AGENT, which is the axis no other product's integration needs.
export const slackSubscription = pgTable(
  "slack_subscription",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    channel_id: text("channel_id").notNull(),
    /** Denormalized `#name` for display; refreshed opportunistically, never authoritative. */
    channel_name: text("channel_name"),
    /** "workspace" (everything in the org) or "collection" (only its artifacts). */
    scope_kind: text("scope_kind").notNull().default("workspace").$type<SlackScopeKind>(),
    /** The collection id, or "" for a workspace scope. NOT NULL and empty-as-sentinel on
     *  purpose: SQL treats NULLs as DISTINCT in a UNIQUE constraint, so a nullable column here
     *  would let the same channel be subscribed to the workspace twice and would stop the
     *  upsert from ever matching — the common case, silently broken. Measured, not assumed. */
    scope_id: text("scope_id").notNull().default(""),
    /** Comma-separated event types, or "*" for all — the same encoding `webhook.events` uses. */
    events: text("events").notNull().default("*"),
    /** "all" | "human" | "agent" — which authors' activity reaches this channel. */
    authors: text("authors").notNull().default("all").$type<SlackAuthorFilter>(),
    active: integer("active").notNull().default(1).$type<0 | 1>(),
    created_by: text("created_by"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [
    // One subscription per channel per scope: subscribing the same channel to the same
    // collection twice is the same subscription, edited.
    uniqueIndex("slack_subscription_target").on(t.org_id, t.channel_id, t.scope_kind, t.scope_id),
    index("slack_subscription_org").on(t.org_id, t.active),
  ],
)

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
  // When set, the host answers 302 → this absolute URL instead of serving content.
  // Written when a draft is claimed (the derive.page URL forwards to the artifact's
  // permanent home); reusable for any future host rename.
  redirect_to: text("redirect_to"),
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
  // When an agent proposed this, the human it acted on behalf of (delegation provenance).
  on_behalf_of: text("on_behalf_of"),
  base_version: integer("base_version").notNull(),
  state: text("state").$type<ProposalState>().notNull().default("open"),
  decided_by: text("decided_by"),
  decided_version: integer("decided_version"),
  decision_note: text("decision_note"),
  decided_at: text("decided_at"),
  created_at: text("created_at").notNull().$defaultFn(isoNow),
})

// A review round: an agent asks a person to review a live version and polls for the
// answer. One PENDING round per (artifact, requested_for) — parallel reviewers safe;
// a re-request replaces that person's pending row. See the sqlite schema for detail.
export const reviewRound = pgTable(
  "review_round",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    version: integer("version").notNull(),
    requested_by: text("requested_by").notNull(),
    requested_for: text("requested_for").notNull(),
    state: text("state").$type<ReviewRoundState>().notNull().default("pending"),
    note: text("note"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
    resolved_at: text("resolved_at"),
  },
  (t) => [index("review_round_artifact").on(t.artifact_id, t.requested_for)],
)

// A context: an askable agent setup — agent + manifest artifact. Mirror of the
// sqlite def; see schema.ts for the design notes (loose agent_id, hard manifest FK,
// context_session naming vs Better Auth's `session` table).
export const context = pgTable(
  "context",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    name: text("name").notNull(),
    agent_id: text("agent_id").notNull(),
    manifest_artifact_id: text("manifest_artifact_id")
      .notNull()
      .references(() => artifact.id),
    created_by: text("created_by").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
    // Last runner queue poll, throttle-stamped — see schema.ts for the contract.
    runner_seen_at: text("runner_seen_at"),
    // Who may ASK — workspace-scoped only, never the manifest's artifact access.
    // See schema.ts for the design notes (a context can't leak outside its org).
    ask_policy: text("ask_policy").$type<"workspace" | "invited">().notNull().default("invited"),
    // Run budget / concurrency / opaque config — mirror of the sqlite def; see
    // schema.ts for the contract (nullable budget, constant-default concurrency,
    // route-parsed config sidecar).
    max_run_ms: integer("max_run_ms"),
    max_concurrency: integer("max_concurrency").notNull().default(1),
    connection_ids: text("connection_ids"),
    config: text("config"),
  },
  (t) => [uniqueIndex("context_org_name").on(t.org_id, t.name)],
)

// Per-context asker roster (ask_policy = 'invited'); mirror of the sqlite def.
export const contextAsker = pgTable(
  "context_asker",
  {
    id: text("id").primaryKey(),
    context_id: text("context_id")
      .notNull()
      .references(() => context.id),
    user_id: text("user_id").notNull(),
    added_by: text("added_by").notNull(),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("context_asker_user").on(t.context_id, t.user_id)],
)

export const contextSession = pgTable(
  "context_session",
  {
    id: text("id").primaryKey(),
    context_id: text("context_id").references(() => context.id),
    org_id: text("org_id").notNull(),
    asker_id: text("asker_id").notNull(),
    context_version: integer("context_version"),
    state: text("state").$type<SessionState>().notNull().default("open"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
    updated_at: text("updated_at"),
    // Lease bookkeeping + ask-idempotency key — mirror of the sqlite def (see
    // schema.ts). All nullable; the partial-unique index is raw DDL below.
    started_at: text("started_at"),
    lease_until: text("lease_until"),
    result_artifact_id: text("result_artifact_id"),
    dedupe_key: text("dedupe_key"),
    // What this session is about, as a Selector — mirror of the sqlite def.
    subject_ref: text("subject_ref"),
  },
  (t) => [
    index("context_session_queue").on(t.context_id, t.state, t.created_at),
    index("context_session_asker").on(t.asker_id, t.created_at),
  ],
)

export const sessionMessage = pgTable(
  "session_message",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id")
      .notNull()
      .references(() => contextSession.id),
    author_kind: text("author_kind").$type<SessionMessageAuthor>().notNull(),
    author_id: text("author_id").notNull(),
    body_md: text("body_md").notNull(),
    meta: text("meta"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [index("session_message_session").on(t.session_id, t.created_at)],
)

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

// A staged binary image asset (POST /v1/assets): content-addressed by `hash`, so
// re-uploading identical bytes is a no-op. This row is what makes GET /blob/:hash
// servable at all — the blob store also holds bundle manifests and page HTML, and
// this table is the allowlist keeping the public route from ever serving those.
export const asset = pgTable(
  "asset",
  {
    hash: text("hash").primaryKey(),
    org_id: text("org_id").notNull(),
    content_type: text("content_type").notNull(),
    size_bytes: integer("size_bytes").notNull(),
    // Header-read pixel dimensions; null for fonts/unreadable/legacy. Mirrors schema.ts.
    width: integer("width"),
    height: integer("height"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [index("asset_org").on(t.org_id)],
)

// A structured FACT extracted from a version's source (see @derive/facts).
// Natural key (artifact_id, n, slot); rows are written once when a version goes live and
// never mutated. `gen` (DEFAULT must equal @derive/core FACT_GEN) marks which extraction
// rules produced the row. Mirrors schema.ts.
export const versionData = pgTable(
  "version_data",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    n: integer("n").notNull(),
    slot: text("slot").notNull(),
    json: text("json").notNull(),
    size_bytes: integer("size_bytes").notNull(),
    gen: integer("gen").notNull().default(1),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
  },
  (t) => [uniqueIndex("version_data_slot").on(t.artifact_id, t.n, t.slot)],
)

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
  versionData,
  comment,
  webhook,
  webhookDelivery,
  renderJob,
  membership,
  workspace,
  artifactMember,
  notification,
  agent,
  agentMention,
  automation,
  run,
  plan,
  connection,
  invitation,
  artifactInvite,
  betaSignup,
  signupAttribution,
  oauthClientWorkspace,
  artifactFavorite,
  follow,
  artifactTag,
  collection,
  collectionItem,
  collectionMember,
  collectionFavorite,
  folder,
  repoSource,
  orgSettings,
  subscription,
  slackInstall,
  slackThreadLink,
  slackUserLink,
  slackSubscription,
  userNotificationPref,
  githubApp,
  githubInstallation,
  domain,
  proposal,
  reviewRound,
  context,
  contextAsker,
  contextSession,
  sessionMessage,
  report,
  auditLog,
  asset,
  modelCredential,
]

/** Build the Postgres boot DDL: generated table/index CREATEs + placeholder tables
 *  + perf indexes, then the idempotent ADD COLUMN IF NOT EXISTS migrations. Pure;
 *  exported for the conformance test. */
// Full-text search index (workspace search substrate) — the Postgres twin of the SQLite
// fts5 virtual table. A real table holding a precomputed `tsvector` per artifact, with a
// GIN index for `@@` lookups; the query filters `org_id` to one workspace and ranks with
// `ts_rank_cd`. Raw DDL (tsvector/GIN aren't in the drizzle defs), appended like the perf
// indexes so both dialects gain the same capability from one schema pass.
const ARTIFACT_SEARCH_PG = [
  `CREATE TABLE IF NOT EXISTS artifact_search (` +
    `artifact_id text PRIMARY KEY, org_id text NOT NULL, tsv tsvector NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS artifact_search_tsv ON artifact_search USING gin (tsv)`,
  `CREATE INDEX IF NOT EXISTS artifact_search_org ON artifact_search (org_id)`,
]

// Ask-idempotency guard — the Postgres twin of context_session_dedupe in schema.ts:
// at most one live (open|working) session per (context, asker, dedupe_key). Scoped by
// asker so one asker's key can't collide with or join onto another's session. Partial +
// expression-scoped, so it's raw DDL, not a drizzle uniqueIndex. It references
// dedupe_key, which the `alters` add on an existing DB, so it MUST run AFTER them
// (the PG boot has no per-statement try/catch — see pg.ts) — hence its position at
// the tail of the statement list below, not inline here.
const CONTEXT_SESSION_DEDUPE_UNIQUE_PG =
  `CREATE UNIQUE INDEX IF NOT EXISTS context_session_dedupe ON context_session ` +
  `(context_id, asker_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('open', 'working')`

// One run per automation per cron occurrence — the Postgres twin of run_schedule_occurrence
// in schema.ts. That comment carries the reasoning: the tick's dedupe is a read-then-write, so
// two ticks racing can both materialize the same occurrence, and this makes losing that race
// harmless rather than expensive. Scoped to reason='schedule' because manual runs, webhook
// fires and retries legitimately share a timestamp.
const RUN_SCHEDULE_OCCURRENCE_UNIQUE_PG =
  `CREATE UNIQUE INDEX IF NOT EXISTS run_schedule_occurrence ON run ` +
  `(automation_id, scheduled_for) WHERE reason = 'schedule' AND automation_id IS NOT NULL ` +
  `AND scheduled_for IS NOT NULL`

const SLACK_THREAD_LINK_REKEY_PG = `DO $$
DECLARE stale text;
BEGIN
  SELECT c.conname INTO stale
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  -- Schema-qualified. The ALTER below resolves through search_path and hits ONE table, so an
  -- unqualified scan that matched a same-named table in another schema (a second Derive schema,
  -- a pg_dump staging copy, a backup schema) would try to drop a constraint that is not on the
  -- table it alters. PG_SCHEMA_STATEMENTS has no per-statement try/catch, so that is a hard
  -- boot failure on EVERY boot rather than a skipped migration.
  WHERE n.nspname = current_schema()
    AND t.relname = 'slack_thread_link'
    AND c.contype = 'u'
    AND array_length(c.conkey, 1) = 1
    AND (SELECT a.attname FROM pg_attribute a
         WHERE a.attrelid = t.oid AND a.attnum = c.conkey[1]) = 'thread_id';
  IF stale IS NOT NULL THEN
    EXECUTE format('ALTER TABLE slack_thread_link DROP CONSTRAINT %I', stale);
    ALTER TABLE slack_thread_link
      ADD CONSTRAINT slack_thread_link_thread_channel_key UNIQUE (thread_id, channel);
  END IF;
END $$`

export const buildPgSchemaStatements = (): string[] => {
  const { creates, alters } = generateDdl(TABLES, getTableConfig, {
    ifNotExists: true,
    timestampDefault: PG_TIMESTAMP_DEFAULT,
  })
  return [
    ...creates,
    ...placeholderTables(PG_TIMESTAMP_DEFAULT),
    ...PERF_INDEXES,
    ...ARTIFACT_SEARCH_PG,
    ...alters,
    // After the alters: partial indexes reference columns the alters add on a populated DB
    // (dedupe_key), and the PG boot has no per-statement try/catch, so ordering is load-bearing.
    CONTEXT_SESSION_DEDUPE_UNIQUE_PG,
    RUN_SCHEDULE_OCCURRENCE_UNIQUE_PG,
    // A session no longer requires a context (chat with a document). Postgres can say this
    // directly, and DROP NOT NULL on an already-nullable column is a no-op, so it is safe to
    // run on every boot. SQLite needs a table rebuild instead — see CONTEXT_SESSION_RELAX_SQLITE.
    `ALTER TABLE context_session ALTER COLUMN context_id DROP NOT NULL`,
    `ALTER TABLE context_session ALTER COLUMN context_version DROP NOT NULL`,
    // A Derive thread mirrors into every subscribed channel, so slack_thread_link is keyed
    // (thread_id, channel). A fresh database gets that from the CREATE above; an existing one
    // still carries the old single-column unique, which would reject the second channel's
    // message. Fires ONLY when that stale constraint is present, so it is a no-op everywhere
    // else — including on a fresh DB, where adding a second equivalent constraint would just
    // be litter. SQLite has no ALTER CONSTRAINT and needs a rebuild instead — see
    // SLACK_THREAD_LINK_REKEY_SQLITE.
    SLACK_THREAD_LINK_REKEY_PG,
  ]
}

export const PG_SCHEMA_STATEMENTS: string[] = buildPgSchemaStatements()
