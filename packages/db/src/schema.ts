import type {
  AgentMentionState,
  ArtifactKind,
  AuditAction,
  CommentState,
  DeliveryKind,
  DeliveryStatus,
  DomainKind,
  DomainStatus,
  FollowKind,
  GeneralRole,
  NotificationKind,
  ProposalState,
  ReportState,
  ReviewRoundState,
  Role,
  SessionMessageAuthor,
  SessionState,
  Visibility,
  WebhookKind,
} from "@derive/core"
import { sql } from "drizzle-orm"
import {
  getTableConfig,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { generateDdl, PERF_INDEXES, placeholderTables } from "./ddl"

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

// Drizzle tables for the queried entities. One SQLite-dialect schema, shared by
// the better-sqlite3 driver (self-host) and the D1 driver (edge).
export const artifact = sqliteTable("artifact", {
  id: text("id").primaryKey(),
  short_id: text("short_id").notNull().unique(),
  org_id: text("org_id").notNull().default("local"),
  slug: text("slug"),
  title: text("title"),
  visibility: text("visibility").$type<Visibility>().notNull().default("private"),
  password_hash: text("password_hash"),
  // The role general access (the link) grants a reacher with no higher explicit
  // grant. viewer = view-only (default); commenter = authed reachers may comment
  // (anonymous reachers are always clamped to viewer — see effectiveRole).
  general_role: text("general_role").$type<GeneralRole>().notNull().default("viewer"),
  kind: text("kind").$type<ArtifactKind>().notNull(),
  spa: integer("spa").$type<0 | 1>().notNull().default(0),
  // When locked, direct publishes are rejected — changes must go through the
  // proposal → approval flow (any editor can toggle it).
  locked: integer("locked").$type<0 | 1>().notNull().default(0),
  current_version: integer("current_version").notNull().default(0),
  current_content_type: text("current_content_type"),
  created_at: text("created_at").notNull().default(now),
  // Set on every new version (publish/sync); null until first versioned. Drives the
  // "most recently updated" sort + the "updated X ago" label, coalescing to created_at
  // when null. Nullable + no default so it adds cleanly via ALTER ADD COLUMN on
  // existing DBs (SQLite forbids a non-constant default there).
  updated_at: text("updated_at"),
  removed_at: text("removed_at"),
  source_path: text("source_path"),
  // The CURRENT (last) author, denormalized from the latest version row for the list
  // view + author filtering. For a GitHub-synced artifact these mirror the last commit's
  // author: `author_name`/`author_login`/`author_avatar` are the display name, GitHub
  // login, and avatar URL; `author_gh_id` is the GitHub numeric user id (text) used to
  // map back to a Derive account. All nullable (legacy/anonymous/non-synced rows).
  author_name: text("author_name"),
  author_login: text("author_login"),
  author_avatar: text("author_avatar"),
  author_gh_id: text("author_gh_id"),
  // The Derive user who last published this by hand (the signed-in publisher). Null for
  // GitHub-synced versions (attributed via author_gh_id), static-token, and legacy rows.
  // Drives the profile work-list + people-follow. Nullable so it ALTER ADDs cleanly.
  author_id: text("author_id"),
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
    size_bytes: integer("size_bytes").notNull().default(0),
    author: text("author").notNull(),
    // The GitHub identity behind this version, when it came from a sync: the commit
    // author's login, avatar URL, and numeric user id (text). All nullable — a manual
    // publish, an anonymous one, or a commit GitHub can't map to an account leaves them
    // null and `author` carries the display name (commit author name / "GitHub sync").
    author_login: text("author_login"),
    author_avatar: text("author_avatar"),
    author_gh_id: text("author_gh_id"),
    // The Derive user who published this version by hand; null for sync/anon/legacy.
    author_id: text("author_id"),
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
  // Stable identity of the author (user or agent id). Authorization (edit/delete)
  // keys on this, never the mutable display `author` name. Nullable for legacy
  // rows + anonymous comments, which fall back to the name check.
  author_id: text("author_id"),
  state: text("state").$type<CommentState>().notNull().default("open"),
  created_at: text("created_at").notNull().default(now),
  meta: text("meta"),
})

export const webhook = sqliteTable("webhook", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("default"),
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
  kind: text("kind").$type<DeliveryKind>().notNull(),
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
    // The user who registered the agent. An agent acts ON BEHALF of this person:
    // publishes are attributed and owned by them (like OAuth agents' granting
    // user). Null for agents from before the column existed — those publish as
    // themselves, so recreating the agent is the upgrade path.
    created_by: text("created_by"),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("agent_token").on(t.token),
    uniqueIndex("agent_org_name").on(t.org_id, t.name),
  ],
)

// A pending workspace invitation: an email invited at a role, redeemable by token.
// Bringing in someone who has no account yet (a membership needs an existing user).
export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    email: text("email").notNull(),
    role: text("role").$type<Role>().notNull().default("editor"),
    token: text("token").notNull(),
    invited_by: text("invited_by"),
    created_at: text("created_at").notNull().default(now),
    expires_at: text("expires_at").notNull(),
    accepted_at: text("accepted_at"),
  },
  (t) => [
    uniqueIndex("invitation_token").on(t.token),
    // One live invite per (workspace, email): the route deletes any prior pending row
    // before inserting, so a re-invite supersedes rather than duplicating.
    index("invitation_org_email").on(t.org_id, t.email),
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

// Which workspace an OAuth client's grants act in for one user — chosen on the
// consent screen; re-consent upserts the row. Resolution falls back to the user's
// first workspace when absent (pre-picker grants) or when membership has lapsed.
export const oauthClientWorkspace = sqliteTable(
  "oauth_client_workspace",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    client_id: text("client_id").notNull(),
    org_id: text("org_id").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("oauth_client_workspace_user_client").on(t.user_id, t.client_id)],
)

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

// Per-user follows. One row per (user, org, kind, target); a follow tracks either a
// GitHub author (kind="author", target=login) or a repo path prefix (kind="path",
// target=path prefix). Drives the "following" activity feed. Idempotent on the tuple.
export const follow = sqliteTable(
  "follow",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    user_id: text("user_id").notNull(),
    kind: text("kind").$type<FollowKind>().notNull(),
    target: text("target").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("follow_user_target").on(t.user_id, t.org_id, t.kind, t.target)],
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

// A collection shared with an entire workspace rather than one person — a live
// binding: anyone who's currently, or later becomes, a member of `org_id` gets
// `role` on every artifact in the collection (see collectionRolesForArtifact).
// Sits alongside collectionMember (per-user). At most one per collection today
// (the route always writes org_id = the collection's own org — a single "share
// with my workspace" toggle); collection_id alone is the unique key so a re-share
// updates the row instead of adding a second one.
export const collectionWorkspaceShare = sqliteTable("collection_workspace_share", {
  id: text("id").primaryKey(),
  collection_id: text("collection_id")
    .notNull()
    .unique()
    .references(() => collection.id),
  org_id: text("org_id").notNull(),
  role: text("role").$type<Role>().notNull(),
  created_at: text("created_at").notNull().default(now),
})

// A GitHub repo mirrored into a collection, one-way. `files` is a JSON path→
// {artifact_id, sha} map so a re-sync skips unchanged files and tombstones gone ones.
export const repoSource = sqliteTable("repo_source", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("local"),
  collection_id: text("collection_id")
    .notNull()
    .references(() => collection.id),
  repo: text("repo").notNull(),
  ref: text("ref").notNull().default("HEAD"),
  includes: text("includes").notNull(),
  token: text("token"),
  // GitHub App installation backing this source. When set, sync mints a
  // short-lived installation token instead of using `token` (the PAT path).
  installation_id: text("installation_id"),
  // When set, this source is a read-only PREVIEW of an open pull request: `ref` is
  // the PR head sha and the source mirrors only the PR's changed docs into its own
  // collection ("PR #<pr_number>: <title>"). NULL = an ordinary branch mirror. This
  // is the discriminator that keeps PR previews out of the per-repo dedup + push matcher.
  pr_number: integer("pr_number"),
  files: text("files").notNull().default("{}"),
  last_synced_at: text("last_synced_at"),
  last_status: text("last_status"),
  progress: text("progress"),
  created_by: text("created_by").notNull(),
  created_at: text("created_at").notNull().default(now),
})

// The instance's GitHub App credentials, captured once via the manifest flow
// (one-click "Set up GitHub App"). A single row, id = 'default'. The three
// secret columns are AES-GCM encrypted at rest (see lib/crypto).
// Per-workspace integration switches (email / GitHub post + mirror / Slack). One row
// per org; `settings` is a JSON OrgSettings blob. Absent row ⇒ defaults (all on).
export const orgSettings = sqliteTable("org_settings", {
  org_id: text("org_id").primaryKey(),
  settings: text("settings").notNull().default("{}"),
  created_at: text("created_at").notNull().default(now),
})

// A connected Slack workspace (one row per Derive org). `bot_token` AES-encrypted at rest.
export const slackInstall = sqliteTable("slack_install", {
  org_id: text("org_id").primaryKey(),
  team_id: text("team_id").notNull(),
  team_name: text("team_name"),
  bot_token: text("bot_token").notNull(),
  bot_user_id: text("bot_user_id"),
  default_channel: text("default_channel"),
  created_at: text("created_at").notNull().default(now),
})

// Derive comment thread ↔ the Slack message Derive posted for it (for two-way threading).
export const slackThreadLink = sqliteTable(
  "slack_thread_link",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    artifact_id: text("artifact_id").notNull(),
    thread_id: text("thread_id").notNull(),
    channel: text("channel").notNull(),
    message_ts: text("message_ts").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("slack_thread_link_thread").on(t.thread_id),
    uniqueIndex("slack_thread_link_msg").on(t.channel, t.message_ts),
  ],
)

export const githubApp = sqliteTable("github_app", {
  id: text("id").primaryKey(),
  app_id: text("app_id").notNull(),
  slug: text("slug").notNull(),
  client_id: text("client_id").notNull(),
  client_secret: text("client_secret").notNull(),
  private_key: text("private_key").notNull(),
  webhook_secret: text("webhook_secret").notNull(),
  created_at: text("created_at").notNull().default(now),
})

// A GitHub App installation a workspace connected — the binding between a GitHub
// account's selected repos and a Derive workspace. One installation backs many
// repo_source rows; sync mints installation tokens against installation_id.
export const githubInstallation = sqliteTable("github_installation", {
  installation_id: text("installation_id").primaryKey(),
  org_id: text("org_id").notNull(),
  account_login: text("account_login"),
  created_by: text("created_by").notNull(),
  created_at: text("created_at").notNull().default(now),
})

// Domain mode: a hostname that serves an artifact at the root of its own origin.
// `host` is globally unique (one host → one artifact); `kind` separates a platform
// subdomain (name.derived.app) from a customer's own domain.
export const domain = sqliteTable("domain", {
  host: text("host").primaryKey(),
  // Set when the host serves one artifact at its root (subdomain / per-artifact
  // custom); null for a workspace domain (artifacts served at `<host>/<ref>`).
  artifact_id: text("artifact_id").references(() => artifact.id),
  org_id: text("org_id").notNull(),
  kind: text("kind").$type<DomainKind>().notNull().default("subdomain"),
  // `active` immediately for subdomains; a custom domain is `pending` until its
  // Cloudflare custom-hostname cert + ownership validate.
  status: text("status").$type<DomainStatus>().notNull().default("active"),
  // Cloudflare custom-hostname id (for refresh + teardown) and the JSON-encoded DNS
  // records to show while pending. Null for subdomains.
  cf_hostname_id: text("cf_hostname_id"),
  verification: text("verification"),
  created_at: text("created_at").notNull().default(now),
})

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
  created_at: text("created_at").notNull().default(now),
})

// A review round: an agent asks a specific person to review a live version, and
// polls for the answer. Keyed per (artifact, requested_for) — one PENDING round
// per person, so several reviewers can be asked in parallel without collision; a
// re-request replaces only that person's pending row. `sent_back` is the human
// "here are my answers" ack; `approved` is the go-signal. History is the row set.
export const reviewRound = sqliteTable(
  "review_round",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    // The version the review was requested on.
    version: integer("version").notNull(),
    // Stable id of the agent (or user) that requested the review.
    requested_by: text("requested_by").notNull(),
    // The user asked to review (the grant owner for an OAuth agent).
    requested_for: text("requested_for").notNull(),
    state: text("state").$type<ReviewRoundState>().notNull().default("pending"),
    note: text("note"),
    created_at: text("created_at").notNull().default(now),
    resolved_at: text("resolved_at"),
  },
  // "One pending round per (artifact, person)" is enforced in the store
  // (createReviewRound deletes the prior pending row first) — a partial unique index
  // isn't portable through the boot-DDL generator, and a full unique index would
  // wrongly block a sent_back row from coexisting with a fresh pending one. A plain
  // lookup index covers getPendingRound / listReviewRounds.
  (t) => [index("review_round_artifact").on(t.artifact_id, t.requested_for)],
)

// A context: a named, askable agent setup — the registered agent that answers it
// linked to the manifest artifact that defines it. Sharing the manifest IS sharing
// the context (v1: viewer on the manifest = can ask), so the share machinery is
// reused wholesale. `agent_id` is a plain column (an agent may be deleted out from
// under a context); the manifest FK is hard — a context can't outlive its definition.
export const context = sqliteTable(
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
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("context_org_name").on(t.org_id, t.name)],
)

// One ask-conversation with a context. Named context_session because Better Auth
// owns a `session` table in the same database. `state` doubles as the turn signal:
// `open` = the runner owes a reply, which makes the queue read one indexed predicate
// instead of a last-message join.
export const contextSession = sqliteTable(
  "context_session",
  {
    id: text("id").primaryKey(),
    context_id: text("context_id")
      .notNull()
      .references(() => context.id),
    org_id: text("org_id").notNull(),
    asker_id: text("asker_id").notNull(),
    context_version: integer("context_version").notNull(),
    state: text("state").$type<SessionState>().notNull().default("open"),
    created_at: text("created_at").notNull().default(now),
    updated_at: text("updated_at"),
  },
  (t) => [
    index("context_session_queue").on(t.context_id, t.state, t.created_at),
    index("context_session_asker").on(t.asker_id, t.created_at),
  ],
)

// A session's transcript, one row per turn. `meta` is the runner's structured
// payload (query, confidence, caveats, artifact refs) as TEXT JSON, like comment.meta.
export const sessionMessage = sqliteTable(
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
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [index("session_message_session").on(t.session_id, t.created_at)],
)

// Abuse reports against public artifacts; anyone can file one.
export const report = sqliteTable("report", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("default"),
  artifact_id: text("artifact_id").notNull(),
  artifact_short_id: text("artifact_short_id").notNull(),
  reason: text("reason").notNull(),
  detail: text("detail"),
  reporter: text("reporter"),
  state: text("state").$type<ReportState>().notNull().default("open"),
  created_at: text("created_at").notNull().default(now),
})

// Immutable moderation-action log (report filed, takedown, reinstate, dismiss).
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("default"),
  action: text("action").$type<AuditAction>().notNull(),
  artifact_id: text("artifact_id"),
  actor: text("actor").notNull(),
  detail: text("detail"),
  created_at: text("created_at").notNull().default(now),
})

// user/session/account/verification tables are owned and migrated by Better Auth
// (see apps/api/src/auth-config.ts) — not declared here.

// Boot DDL, generated from the drizzle tables above (see ./ddl) so the SQLite
// schema can't drift from the defs and stays in lockstep with the Postgres + D1 DDL.
// SQLite's created_at default is strftime, and ADD COLUMN has no IF NOT EXISTS, so
// MIGRATION_STATEMENTS run in a boot try/catch ("duplicate column" = already applied).
const SQLITE_TIMESTAMP_DEFAULT = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

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
  invitation,
  oauthClientWorkspace,
  artifactFavorite,
  follow,
  artifactTag,
  collection,
  collectionItem,
  collectionMember,
  collectionWorkspaceShare,
  repoSource,
  orgSettings,
  slackInstall,
  slackThreadLink,
  githubApp,
  githubInstallation,
  domain,
  proposal,
  reviewRound,
  context,
  contextSession,
  sessionMessage,
  report,
  auditLog,
]

const ddl = generateDdl(TABLES, getTableConfig, {
  ifNotExists: false,
  timestampDefault: SQLITE_TIMESTAMP_DEFAULT,
})

/**
 * Raw DDL run at boot for the self-host SQLite default (zero-config), and used to
 * seed D1 (deploy/d1-schema.sql). Table/index CREATEs come from the drizzle defs;
 * the not-yet-queried placeholder tables (principal/acl/view) and the perf indexes
 * have no drizzle def and stay explicit (see ./ddl).
 */
export const SCHEMA_STATEMENTS: string[] = [
  ...ddl.creates,
  ...placeholderTables(SQLITE_TIMESTAMP_DEFAULT),
  ...PERF_INDEXES,
]

/**
 * Forward-only column adds for existing DBs. SQLite has no ADD COLUMN IF NOT EXISTS,
 * so each runs inside a try/catch at boot and a "duplicate column" throw is the
 * success path (see sqlite.ts). Generated from the drizzle columns that can be added
 * to a populated table (nullable or constant-default), so a new column can't be
 * forgotten here.
 */
export const MIGRATION_STATEMENTS: string[] = ddl.alters

// Schema parity is enforced in repos.ts, where the shared `schema` object lives:
// `Exhaustive`/`Shapes` (./parity) force every table to be classified and every
// typed table's row shape to match its @derive/core Record. See ./parity.
