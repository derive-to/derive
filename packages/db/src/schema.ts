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
  LinkRole,
  Listed,
  NotificationKind,
  PreviewStatus,
  ProposalState,
  RenderJobStatus,
  ReportState,
  ReviewRoundState,
  Role,
  RunStatus,
  SessionMessageAuthor,
  SessionState,
  VersionSource,
  WebhookKind,
  WorkspaceAccess,
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
  // The access model (docs/access-model.md), three independent fields.
  // workspace_access: does the artifact's workspace get access at each member's
  // SEAT role (`member`) or not (`none`). link_role: the WORLD link — what anyone
  // holding the URL gets (`none` inert / viewer / commenter / editor; anon clamped
  // to viewer). listed: discovery only (`none` / `workspace` library / `public`
  // directory), NO access. All fail-closed to `none` so an un-stamped row grants
  // nothing; publish() resolves real values. See effectiveRole.
  workspace_access: text("workspace_access").$type<WorkspaceAccess>().notNull().default("none"),
  link_role: text("link_role").$type<LinkRole>().notNull().default("none"),
  listed: text("listed").$type<Listed>().notNull().default("none"),
  // Locks the world link on a public-directory doc until unlocked; members and
  // explicit shares never need it.
  password_hash: text("password_hash"),
  // (The v1 `visibility`/`general_role` columns were backfilled into the fields
  // above and removed from this definition; existing databases drop them with
  // deploy/drop-v1-access.sql — new ones never create them.)
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
    // Which surface created this version ('web' | 'mcp' | 'api' | 'sync') — the
    // onboarding/analytics stamp. Null for pre-column versions and non-stamping paths.
    source: text("source").$type<VersionSource>(),
    message: text("message"),
    name: text("name"),
    preview_key: text("preview_key"),
    preview_status: text("preview_status").$type<PreviewStatus>(),
    preview_error: text("preview_error"),
    // Two more render-rung variants, agent-facing only (never used for og:image/
    // unfurls, which stay the fixed 1200x630 crop above): the whole page as authored
    // (`preview_full_*`, full-page fullPage:true screenshot — catches below-the-fold
    // breakage the OG crop can't) and the same full-page render with the region map's
    // @N refs drawn on it (`preview_marked_*` — see marks-script.ts), so an agent's
    // visual read lines up with what it reads/searches by. Same nullable triple shape
    // and lifecycle as the OG columns; best-effort, computed after the OG render in
    // the SAME publish job (see previews.ts) rather than a separate queue entry.
    preview_full_key: text("preview_full_key"),
    preview_full_status: text("preview_full_status").$type<PreviewStatus>(),
    preview_full_error: text("preview_full_error"),
    preview_marked_key: text("preview_marked_key"),
    preview_marked_status: text("preview_marked_status").$type<PreviewStatus>(),
    preview_marked_error: text("preview_marked_error"),
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

export const renderJob = sqliteTable("render_job", {
  id: text("id").primaryKey(),
  artifact_id: text("artifact_id").notNull(),
  version_n: integer("version_n").notNull(),
  status: text("status").$type<RenderJobStatus>().notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  next_attempt_at: text("next_attempt_at").notNull().default(now),
  created_at: text("created_at").notNull().default(now),
})

// The run ledger (WP6): one row per hosted/owner agent invocation — the durable
// An automation (WP5): a standing agent job — WHO (agent), WHEN (trigger, open-ended
// JSON), WHAT (free-form instruction), on WHAT (refs). The definition only; every firing
// is a `run`. A "living doc" is just an automation whose instruction keeps a doc current.
export const automation = sqliteTable("automation", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull(),
  agent_id: text("agent_id").notNull(),
  // Serialized AutomationTrigger { kind: manual|schedule|event, cron?, tz?, on? }. A new
  // trigger kind adds no columns — it is a new value in this blob.
  trigger: text("trigger").notNull(),
  instruction: text("instruction").notNull(),
  // Serialized inputs/targets (artifact ids, urls, arbitrary), or null.
  // How each write lands (publish vs propose) rides IN the refs blob per target —
  // policy is config, config evolves, and evolving config never gets a column.
  refs: text("refs"),
  enabled: integer("enabled").$type<0 | 1>().notNull().default(1),
  created_at: text("created_at").notNull().default(now),
})

// A run (WP5/WP6): one execution of an automation (or an ad-hoc one-off). The queue and
// the ledger in ONE table (pg-boss's model): a `queued` row is pending work, a terminal
// row is history. A worker claims the oldest due queued run under a row lock, runs it, and
// finishes it. Cost is snapshotted at finish (micro-USD int); everything else lives in the
// open `meta` blob, so a new field never means a new column.
export const run = sqliteTable("run", {
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
    // Served by Derive's managed executor when 1. Hosting changes WHERE the
    // agent runs — never its principal, role cap, or attribution.
    hosted: integer("hosted").notNull().default(0).$type<0 | 1>(),
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

// A pending per-artifact share invitation: an email invited to ONE artifact at a
// role, redeemable by token — the share dialog's answer to "no Derive user with
// that email". Accepting creates the artifact_member row; workspace membership is
// never involved (see `invitation` above for that flow).
export const artifactInvite = sqliteTable(
  "artifact_invite",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id").notNull(),
    email: text("email").notNull(),
    role: text("role").$type<Role>().notNull().default("commenter"),
    token: text("token").notNull(),
    invited_by: text("invited_by"),
    created_at: text("created_at").notNull().default(now),
    expires_at: text("expires_at").notNull(),
    accepted_at: text("accepted_at"),
  },
  (t) => [
    uniqueIndex("artifact_invite_token").on(t.token),
    // One live invite per (artifact, email): the route deletes any prior pending
    // row before inserting, so a re-invite supersedes rather than duplicating.
    index("artifact_invite_artifact_email").on(t.artifact_id, t.email),
  ],
)

// A beta signup from the marketing site's request-access form: just the email and
// when it arrived. The access email (with the create-account link) is sent on
// signup; this row is the audience list — who asked, and in what order.
export const betaSignup = sqliteTable(
  "beta_signup",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("beta_signup_email").on(t.email)],
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

// The SET of workspaces an OAuth client's grants are scoped to for one user —
// the workspaces ticked on the consent screen. ONE ROW PER GRANTED WORKSPACE
// (composite-unique on user+client+org). An EMPTY set (no rows) means "all
// workspaces" — the grant reaches every workspace the user belongs to, including
// any added later (also the back-compat state for pre-picker grants). A non-empty
// set restricts the grant to exactly those workspaces. Re-consent replaces the set.
export const oauthClientWorkspace = sqliteTable(
  "oauth_client_workspace",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    client_id: text("client_id").notNull(),
    org_id: text("org_id").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("oauth_client_workspace_user_client_org").on(t.user_id, t.client_id, t.org_id),
  ],
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
  // Same share experience as an artifact's workspace_access, minus link_role/listed —
  // a collection is a grouping of other artifacts, each with its own access, not
  // individually link-servable content (see access-model.md). `member` = every
  // workspace member reaches it at their seat role; `none` = invite-only
  // (collectionMember rows only). Defaults to `member` (not artifact's fail-closed
  // `none`) because that's collections' existing behavior today — collectionRole
  // already folds in the caller's seat unconditionally, so an ADD COLUMN migration
  // defaulting every existing row to `member` changes nothing for anyone.
  workspace_access: text("workspace_access").$type<WorkspaceAccess>().notNull().default("member"),
  // The org-shared folder this collection is filed under (null = ungrouped). A plain
  // pointer, NOT a FK — folders are pure organization and grant no access, and a
  // constraint-free nullable column keeps the ADD COLUMN migration trivially additive
  // across both dialects. Integrity (a real folder in the same workspace) is enforced
  // by the owner-only assign endpoint; deleting a folder nulls this on its members.
  folder_id: text("folder_id"),
})

// A workspace-shared organizing folder for collections — owner-editable, grouping only.
// It grants NO access of its own (a collection keeps its own auth); it never appears in
// any auth path. A collection points at one via collection.folder_id.
export const folder = sqliteTable("folder", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull().default("local"),
  // The collection this folder organizes (a folder lives INSIDE a collection and groups
  // its artifacts). App-required; nullable at the DB only so the ADD COLUMN migration
  // stays additive. FK-free — folders grant no access; the API enforces that a filed
  // item's folder belongs to the item's collection.
  collection_id: text("collection_id"),
  name: text("name").notNull(),
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
    // Which folder (within THIS collection) the artifact is filed under; null = unfiled.
    // Folder membership refines collection membership, so it rides the membership row.
    // FK-free (see folder.collection_id).
    folder_id: text("folder_id"),
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
  // Flipped to 1 when Slack rejects a call for auth/scope reasons (invalid_auth,
  // token_revoked, missing_scope); the Settings UI shows a reconnect banner. Cleared on
  // a fresh OAuth connect.
  needs_reauth: integer("needs_reauth").notNull().default(0).$type<0 | 1>(),
  created_at: text("created_at").notNull().default(now),
})

// Per-user notification preferences within a workspace. `prefs` is a JSON blob (absent =
// defaults on), so preference types can be added without a migration.
export const userNotificationPref = sqliteTable(
  "user_notification_pref",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    user_id: text("user_id").notNull(),
    prefs: text("prefs").notNull().default("{}"),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("user_notification_pref_key").on(t.org_id, t.user_id)],
)

// A team member's OWN model-plan credential — their Claude/Codex plan token (or an API
// key) — encrypted at rest (AES-GCM, lib/crypto, keyed by DERIVE_AUTH_SECRET), scoped
// (org, user, provider) and used ONLY for that user's own agent runs. Never a shared
// token: this is what replaces the single global model-credential env for hosted runs.
// `secret` is the encrypted blob; `hint` is a safe label (e.g. last 4) for the UI.
export const modelCredential = sqliteTable(
  "model_credential",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    user_id: text("user_id").notNull(),
    provider: text("provider").notNull(),
    kind: text("kind").$type<"oauth" | "api_key">().notNull(),
    secret: text("secret").notNull(),
    hint: text("hint").notNull().default(""),
    created_at: text("created_at").notNull().default(now),
    updated_at: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("model_credential_key").on(t.org_id, t.user_id, t.provider)],
)

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

// Derive user ↔ their Slack identity in a workspace (from the "Link Slack account" OIDC
// flow). Keyed on (team_id, slack_user_id) — a Slack user id is per-workspace — so a Slack
// event/DM resolves to the real Derive account instead of an email guess.
export const slackUserLink = sqliteTable(
  "slack_user_link",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    user_id: text("user_id").notNull(),
    team_id: text("team_id").notNull(),
    slack_user_id: text("slack_user_id").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("slack_user_link_slack").on(t.team_id, t.slack_user_id),
    index("slack_user_link_user").on(t.team_id, t.user_id),
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
    // Last time this context's runner polled its queue — liveness derived from the
    // poll itself, no separate heartbeat. Stamped at most once a minute (the queue
    // route throttles; the poll is ~5s) so the row isn't churned. Nullable (never
    // polled + clean ALTER ADD COLUMN); the console renders online/offline from it.
    runner_seen_at: text("runner_seen_at"),
    // Who in the workspace may ASK this context — DELIBERATELY not the manifest's
    // artifact access. A context is a data-access grant, not a document: it must
    // never be reachable outside its workspace, so its access model has no
    // world-link or public concept to leak one. `invited` = the context_asker
    // roster (+ the creator); `workspace` = any member. Membership in org_id is
    // the hard floor either way (enforced in the ask gate, not here). Defaults to
    // `invited` (least privilege): a data grant opens to nobody until the owner
    // widens it — the migration keeps existing contexts closed, not opened.
    ask_policy: text("ask_policy").$type<"workspace" | "invited">().notNull().default("invited"),
    // Per-run wall-clock budget (ms). Nullable = the server's default run budget
    // (clean ALTER ADD COLUMN onto existing rows). The runner reads it; the store
    // just carries it.
    max_run_ms: integer("max_run_ms"),
    // How many sessions the runner may work in parallel on this context. Constant
    // default 1 (serial), so it migrates onto populated rows without a backfill.
    max_concurrency: integer("max_concurrency").notNull().default(1),
    // Opaque JSON sidecar, parsed only at the route layer (like session_message.meta)
    // — never by the store. Nullable (clean ADD COLUMN; unset until the owner sets one).
    config: text("config"),
  },
  (t) => [uniqueIndex("context_org_name").on(t.org_id, t.name)],
)

// The per-context asker roster (only consulted when ask_policy = 'invited'). A
// row grants ONE workspace member the right to ask; workspace membership is
// re-checked at ask time, so removing someone from the workspace revokes here
// too. No non-member can be added (the add route validates membership) — the
// table structurally can't reference outside the workspace.
export const contextAsker = sqliteTable(
  "context_asker",
  {
    id: text("id").primaryKey(),
    context_id: text("context_id")
      .notNull()
      .references(() => context.id),
    user_id: text("user_id").notNull(),
    added_by: text("added_by").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("context_asker_user").on(t.context_id, t.user_id)],
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
    // Lease bookkeeping for the concurrency-safe claim (mirrors webhook_delivery /
    // render_job). All nullable: a session is unclaimed until a runner claims it,
    // and these ALTER onto existing rows cleanly.
    started_at: text("started_at"),
    lease_until: text("lease_until"),
    result_artifact_id: text("result_artifact_id"),
    // Ask idempotency key. The partial-unique index below keeps at most one live
    // (open|working) session per (context, dedupe_key). Nullable = not deduped.
    dedupe_key: text("dedupe_key"),
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

// A staged binary image asset (POST /v1/assets): content-addressed by `hash`, so
// re-uploading identical bytes is a no-op. This row is what makes GET /blob/:hash
// servable at all — the blob store also holds bundle manifests and page HTML, and
// this table is the allowlist keeping the public route from ever serving those.
export const asset = sqliteTable(
  "asset",
  {
    hash: text("hash").primaryKey(),
    org_id: text("org_id").notNull(),
    content_type: text("content_type").notNull(),
    size_bytes: integer("size_bytes").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [index("asset_org").on(t.org_id)],
)

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
  renderJob,
  membership,
  workspace,
  artifactMember,
  notification,
  agent,
  agentMention,
  automation,
  run,
  invitation,
  artifactInvite,
  betaSignup,
  oauthClientWorkspace,
  artifactFavorite,
  follow,
  artifactTag,
  collection,
  collectionItem,
  collectionMember,
  folder,
  repoSource,
  orgSettings,
  modelCredential,
  slackInstall,
  slackThreadLink,
  slackUserLink,
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
]

const ddl = generateDdl(TABLES, getTableConfig, {
  ifNotExists: false,
  timestampDefault: SQLITE_TIMESTAMP_DEFAULT,
})

/**
 * Raw DDL run at boot for the self-host SQLite default (zero-config), and used to
 * seed D1 (deploy/d1-schema.sql). Table/index CREATEs come from the drizzle defs;
 * the not-yet-queried placeholder tables (principal/view) and the perf indexes
 * have no drizzle def and stay explicit (see ./ddl).
 */
// Full-text search index (workspace search substrate). A contentless FTS5 virtual table:
// `text` is tokenized/searched; `artifact_id`/`org_id` are stored-but-UNINDEXED so a query
// can filter to one workspace (`org_id = ?`) and return the id, ranked by `bm25()`. Not a
// drizzle def (FTS5 is raw DDL only), so it lives here explicitly like the perf indexes.
// D1 ships FTS5; better-sqlite3 ships it too.
// `remove_diacritics 0` keeps fts5 accent-SENSITIVE, matching both Postgres
// `to_tsvector('simple', …)` (which preserves diacritics) and the literal grep-confirm
// pass — so "café" is found by "café", not by "cafe", identically on every tier.
// unicode61's default folds accents, which would silently diverge the two dialects
// AND nominate docs the literal grep then drops. Word/whitespace tokenization still
// differs across dialects for scripts without spaces (CJK) and tokens >2047 bytes
// (Postgres drops those) — a documented limit of a lexical index, not fixed here.
const ARTIFACT_SEARCH_FTS5 =
  `CREATE VIRTUAL TABLE IF NOT EXISTS artifact_search USING fts5(` +
  `text, artifact_id UNINDEXED, org_id UNINDEXED, tokenize='unicode61 remove_diacritics 0')`

// Ask-idempotency guard: at most one LIVE (open|working) session per
// (context, asker, dedupe_key). Scoped by asker so one asker's key can't collide with —
// or, via findInflightSession, join onto — another asker's session (sessions are private
// to asker + owner). Partial + expression-scoped, so drizzle's uniqueIndex can't express
// it — raw DDL like the FTS table. SQLite and Postgres both honor `CREATE UNIQUE INDEX …
// WHERE …`. On a fresh DB the CREATE TABLE above already carries dedupe_key, so this is
// safe in the initial schema pass.
const CONTEXT_SESSION_DEDUPE_UNIQUE =
  `CREATE UNIQUE INDEX IF NOT EXISTS context_session_dedupe ON context_session ` +
  `(context_id, asker_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('open', 'working')`

export const SCHEMA_STATEMENTS: string[] = [
  ...ddl.creates,
  ...placeholderTables(SQLITE_TIMESTAMP_DEFAULT),
  ...PERF_INDEXES,
  ARTIFACT_SEARCH_FTS5,
  CONTEXT_SESSION_DEDUPE_UNIQUE,
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
