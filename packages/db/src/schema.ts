import type {
  AgentMentionKind,
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
  ExportJobStatus,
  ExportKind,
  FollowKind,
  LinkRole,
  Listed,
  NotificationKind,
  PlanKind,
  PreviewStatus,
  RenderJobStatus,
  ReportState,
  ReviewRoundState,
  Role,
  RunStatus,
  SessionMessageAuthor,
  SessionState,
  SharedStateAction,
  SlackAuthorFilter,
  SlackScopeKind,
  SlackThreadSurface,
  TemplateEntryFormat,
  TemplateEntryKind,
  TemplateLibraryScope,
  VersionSource,
  WebhookKind,
  WorkflowRequestedExecution,
  WorkflowRunStatus,
  WorkflowStepAttemptStatus,
  WorkflowStepKind,
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
  // When locked, publishes are rejected — the lock is a freeze until an editor
  // unlocks (any editor can toggle it).
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
  // Reversible library cleanup. Unlike removed_at (moderation/sync tombstone), this
  // only changes discovery: direct URLs and bytes remain readable.
  archived_at: text("archived_at"),
  // Expiring anonymous draft (the claim flow): ISO instant after which the draft is
  // gone — served 410 and swept. Null for every ordinary artifact; cleared on claim.
  expires_at: text("expires_at"),
  // When the first non-author view landed (recordView stamps it once — the
  // activation moment). Nullable, no default, so it ALTER ADDs cleanly.
  first_foreign_view_at: text("first_foreign_view_at"),
  // Owner opt-in: the ANONYMOUS public page shows version history (dropdown +
  // old-version reads). Off, anon callers get the current version only — signed-in
  // readers always keep workbench history (auth is the gate, like comments).
  // Nullable (null = off), no default, so it ALTER ADDs cleanly.
  public_history: integer("public_history").$type<0 | 1>(),
  source_path: text("source_path"),
  // The CURRENT (last) author, denormalized from the latest version row for list views.
  // GitHub identity fields remain for historical imported rows; the current integration
  // never publishes artifacts or writes them.
  author_name: text("author_name"),
  author_login: text("author_login"),
  author_avatar: text("author_avatar"),
  author_gh_id: text("author_gh_id"),
  // The Derive user who last published this (the signed-in publisher). Null for
  // historical imports, static-token publishes, and legacy rows.
  // Drives the profile work-list + people-follow. Nullable so it ALTER ADDs cleanly.
  author_id: text("author_id"),
  // Remix lineage: the artifact id this one was derived from ("Use this as a
  // template"). Deliberately not an FK — the source may be deleted later and the
  // copy must survive it. Nullable, no default, so it ALTER ADDs cleanly.
  derived_from: text("derived_from"),
})

// Small mutable JSON collections for interactive artifacts. One row per
// (artifact, key); `version` is an optimistic-concurrency guard.
export const sharedState = sqliteTable(
  "shared_state",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    key: text("key").notNull(),
    json: text("json").notNull(),
    version: integer("version").notNull(),
    updated_by_id: text("updated_by_id").notNull(),
    updated_by_name: text("updated_by_name").notNull(),
    updated_at: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("shared_state_key").on(t.artifact_id, t.key)],
)

// Append-only activity gives collaborators a useful "who did what" trail while
// keeping the authoring API free of identity fields.
export const sharedStateActivity = sqliteTable(
  "shared_state_activity",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id")
      .notNull()
      .references(() => artifact.id),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    action: text("action").$type<SharedStateAction>().notNull(),
    item_id: text("item_id").notNull(),
    actor_id: text("actor_id").notNull(),
    actor_name: text("actor_name").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("shared_state_activity_key_version").on(t.artifact_id, t.key, t.version)],
)

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
    // Historical imported-author identity. Current publish paths leave these nullable
    // compatibility columns empty and use `author_id` for a signed-in publisher.
    author_login: text("author_login"),
    author_avatar: text("author_avatar"),
    author_gh_id: text("author_gh_id"),
    // The Derive user who published this version; null for imports/anon/legacy.
    author_id: text("author_id"),
    // The agent that produced this version on that user's behalf (id + snapshotted name);
    // null for a person's own publish. `author` stays the person's byline. See VersionRecord.
    agent_id: text("agent_id"),
    agent_name: text("agent_name"),
    // Which surface created this version ('web' | 'mcp' | 'api'; historical rows may carry
    // 'sync') — the onboarding/analytics stamp. Null for pre-column/non-stamping paths.
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
    // A one- or two-sentence description of what this version SAYS, generated at publish
    // (lib/after-publish.ts). Every unfurl surface — the Slack card, og:description, oEmbed —
    // otherwise describes an artifact as "Markdown · 3 versions · 7 comments", which answers
    // "what is this?" and not "what is it about?". Null is the normal resting state: no model
    // bound (self-host), a non-text version, or a generation that failed — all fall back to
    // that inventory line, so nothing depends on this being present.
    //
    // `summary_src_hash` is over the exact text the model was given, and exists to make the
    // COMMON case free: agents republish constantly, and most publishes do not change what a
    // document is about. An unchanged hash copies the previous version's summary forward
    // instead of paying for an identical one.
    summary: text("summary"),
    summary_src_hash: text("summary_src_hash"),
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

export const exportJob = sqliteTable(
  "export_job",
  {
    id: text("id").primaryKey(),
    artifact_id: text("artifact_id").notNull(),
    version_n: integer("version_n").notNull(),
    org_id: text("org_id").notNull(),
    requested_by: text("requested_by").notNull(),
    kind: text("kind").$type<ExportKind>().notNull(),
    profile: text("profile").notNull(),
    renderer_scope: text("renderer_scope").notNull().default(""),
    options_json: text("options_json").notNull().default("{}"),
    input_hash: text("input_hash").notNull(),
    status: text("status").$type<ExportJobStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    last_error: text("last_error"),
    error_class: text("error_class"),
    next_attempt_at: text("next_attempt_at").notNull().default(now),
    output_key: text("output_key"),
    output_type: text("output_type"),
    output_bytes: integer("output_bytes"),
    public_asset_hash: text("public_asset_hash"),
    created_at: text("created_at").notNull().default(now),
    updated_at: text("updated_at").notNull().default(now),
    expires_at: text("expires_at"),
  },
  (t) => [uniqueIndex("export_job_input").on(t.input_hash)],
)

// The run ledger: one row per hosted/owner agent invocation — the durable
// An automation: a standing agent job — WHO (agent), WHEN (trigger, open-ended
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
  // Coding-agent runtime. Existing rows stay on the historical Claude default; new work can
  // choose Codex explicitly and snapshots that choice onto each run.
  provider: text("provider")
    .$type<import("@derive/core").ExecutionProvider>()
    .notNull()
    .default("claude-code"),
  // Serialized inputs/targets (artifact ids, urls, arbitrary), or null.
  refs: text("refs"),
  // JSON array of bound connection ids — the sources a run may read from (least privilege).
  // Nullable + no default, so it ALTER ADDs cleanly on existing databases.
  connection_ids: text("connection_ids"),
  // The context this automation runs AS (nullable): its manifest + skills become the run's
  // system prompt, making an automation literally a scheduled use(context, instruction).
  // Unset = the bare run contract (an artifact-freshness job needs no methodology).
  context_id: text("context_id"),
  enabled: integer("enabled").$type<0 | 1>().notNull().default(1),
  created_at: text("created_at").notNull().default(now),
})

// A run: one execution of an automation (or an ad-hoc one-off). The queue and
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

// One start of a version-pinned Workflow diagram.
export const workflowRun = sqliteTable(
  "workflow_run",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    // Deliberately not an FK: execution history outlives the source artifact.
    workflow_artifact_id: text("workflow_artifact_id").notNull(),
    workflow_version: integer("workflow_version").notNull(),
    workflow_blob_key: text("workflow_blob_key").notNull(),
    workflow_content_type: text("workflow_content_type").notNull(),
    diagram_id: text("diagram_id").notNull(),
    status: text("status").$type<WorkflowRunStatus>().notNull().default("queued"),
    state_revision: integer("state_revision").notNull().default(0),
    reason: text("reason").notNull(),
    initiated_by: text("initiated_by"),
    request_id: text("request_id"),
    assigned_agent_id: text("assigned_agent_id"),
    executor_id: text("executor_id"),
    requested_execution: text("requested_execution")
      .$type<WorkflowRequestedExecution>()
      .notNull()
      .default("any"),
    actual_execution: text("actual_execution").$type<"local" | "hosted" | "github_actions">(),
    external_execution: text("external_execution"),
    external_run_id: text("external_run_id"),
    created_at: text("created_at").notNull().default(now),
    updated_at: text("updated_at").notNull(),
    started_at: text("started_at"),
    finished_at: text("finished_at"),
  },
  (t) => [
    index("workflow_run_org_created").on(t.org_id, t.created_at),
    index("workflow_run_definition").on(
      t.workflow_artifact_id,
      t.workflow_version,
      t.diagram_id,
      t.created_at,
    ),
    index("workflow_run_external").on(t.external_run_id),
  ],
)

// One materialized node attempt. Unselected branches do not create rows.
export const workflowStepAttempt = sqliteTable(
  "workflow_step_attempt",
  {
    id: text("id").primaryKey(),
    workflow_run_id: text("workflow_run_id")
      .notNull()
      .references(() => workflowRun.id),
    node_id: text("node_id").notNull(),
    attempt: integer("attempt").notNull(),
    kind: text("kind").$type<WorkflowStepKind>().notNull(),
    status: text("status").$type<WorkflowStepAttemptStatus>().notNull().default("queued"),
    state_revision: integer("state_revision").notNull().default(0),
    context_id: text("context_id"),
    context_manifest_artifact_id: text("context_manifest_artifact_id"),
    context_version: integer("context_version"),
    context_blob_key: text("context_blob_key"),
    context_content_type: text("context_content_type"),
    session_id: text("session_id"),
    decision: text("decision"),
    selected_routes: text("selected_routes"),
    route_basis: text("route_basis"),
    result_artifact_id: text("result_artifact_id"),
    output: text("output"),
    error: text("error"),
    created_at: text("created_at").notNull().default(now),
    updated_at: text("updated_at").notNull(),
    started_at: text("started_at"),
    finished_at: text("finished_at"),
  },
  (t) => [
    uniqueIndex("workflow_step_attempt_number").on(t.workflow_run_id, t.node_id, t.attempt),
    uniqueIndex("workflow_step_attempt_session").on(t.session_id),
    index("workflow_step_attempt_run").on(t.workflow_run_id, t.created_at),
  ],
)

// A bring-your-own plan (WO2): an owner attaches their own model or broker credential and
// runs meter against it. user_id set = that person's personal plan; user_id null = the
// workspace pool (the fallback). The secret is encrypted at rest; limits ride a JSON blob.
export const plan = sqliteTable("plan", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull(),
  user_id: text("user_id"),
  kind: text("kind").$type<PlanKind>().notNull(),
  provider: text("provider").notNull(),
  secret_enc: text("secret_enc").notNull(),
  limits: text("limits"),
  created_at: text("created_at").notNull().default(now),
})

// A per-user connected external account (WO3): the owner authorized the broker to act on their
// Gmail/Stripe/etc. Always bound to one person; a hosted run sees the tools of its bound
// connections only. broker_ref is the broker-side connected-account id.
export const connection = sqliteTable("connection", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull(),
  user_id: text("user_id").notNull(),
  // personal (default) = act-as-me, owner-bound; workspace = org infrastructure,
  // admin-managed, survives the adder leaving. user_id stays "who added it" either way.
  scope: text("scope").$type<ConnectionScope>().notNull().default("personal"),
  // oauth (default) = broker-connected account; secret = a pasted credential, stored
  // encrypted, spent only server-side by the tool proxy, never returned by any route.
  kind: text("kind").$type<ConnectionKind>().notNull().default("oauth"),
  secret_enc: text("secret_enc"),
  base_url: text("base_url"),
  broker: text("broker").notNull(),
  toolkit: text("toolkit").notNull(),
  broker_ref: text("broker_ref").notNull(),
  scopes_label: text("scopes_label"),
  status: text("status").$type<ConnectionStatus>().notNull().default("pending"),
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
    // 1 = auto-minted for one context at creation (never user-named): the context's
    // Derive access, not a persona. The UI hides managed agents from the roster.
    managed: integer("managed").notNull().default(0).$type<0 | 1>(),
    // The runs-lane liveness mark (twin of context.runner_seen_at): stamped when the
    // agent's bearer polls the run claim endpoint. Null = no executor has ever polled.
    runs_seen_at: text("runs_seen_at"),
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

export const collectionInvite = sqliteTable(
  "collection_invite",
  {
    id: text("id").primaryKey(),
    collection_id: text("collection_id").notNull(),
    email: text("email").notNull(),
    role: text("role").$type<Role>().notNull().default("commenter"),
    token: text("token").notNull(),
    invited_by: text("invited_by"),
    created_at: text("created_at").notNull().default(now),
    expires_at: text("expires_at").notNull(),
    accepted_at: text("accepted_at"),
  },
  (t) => [
    uniqueIndex("collection_invite_token").on(t.token),
    index("collection_invite_collection_email").on(t.collection_id, t.email),
  ],
)

// Where a signup came from. One row per user, written from the explicit source
// carried by the signup URL during the short post-auth window; first write wins.
// No FK to Better Auth's user table: auth owns its tables out-of-band.
export const signupAttribution = sqliteTable(
  "signup_attribution",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    // The surface that sourced the signup: an artifact surface (badge, comment_wall,
    // duplicate, share_chrome, artifact_visit) or a campaign token (hn-launch, …).
    source_kind: text("source_kind").notNull(),
    // The artifact (short id) the sourcing surface lived on, when known.
    source_artifact: text("source_artifact"),
    // Coarse public landing path. `referrer` remains for backward-compatible rows;
    // cookieless attribution deliberately writes null for new signups.
    landing_path: text("landing_path"),
    referrer: text("referrer"),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("signup_attribution_user").on(t.user_id)],
)

// Instance-wide authority belongs to an immutable Better Auth user id. There is
// deliberately no email column: changing or reusing an address cannot transfer
// operator powers. Better Auth owns `user`, so this cross-owner relation has no FK.
export const instanceOperator = sqliteTable("instance_operator", {
  user_id: text("user_id").primaryKey(),
  created_at: text("created_at").notNull().default(now),
})

// An agent's pull inbox: one row per explicit mention or reply to a thread it owns.
export const agentMention = sqliteTable("agent_mention", {
  id: text("id").primaryKey(),
  agent_id: text("agent_id").notNull(),
  artifact_id: text("artifact_id").notNull(),
  artifact_short_id: text("artifact_short_id").notNull(),
  comment_id: text("comment_id").notNull(),
  thread_id: text("thread_id").notNull(),
  body: text("body").notNull(),
  author: text("author").notNull(),
  kind: text("kind").$type<AgentMentionKind>().notNull().default("mention"),
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
  // The canonical collection URL can grant a role which propagates to every item.
  // Existing collections stay closed to the world through the additive `none` default.
  link_role: text("link_role").$type<LinkRole>().notNull().default("none"),
  password_hash: text("password_hash"),
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

// Starred collections. A sibling of artifact_favorite rather than a `kind` column on
// it: the boot-DDL generator emits CREATE TABLE and idempotent ADD COLUMN only, so
// making artifact_id nullable or dropping its FK would need a hand-written migration
// against already-deployed tables. A new table needs neither, and both keep a real FK.
export const collectionFavorite = sqliteTable(
  "collection_favorite",
  {
    id: text("id").primaryKey(),
    collection_id: text("collection_id")
      .notNull()
      .references(() => collection.id),
    user_id: text("user_id").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("collection_favorite_user").on(t.collection_id, t.user_id)],
)

// A library is deliberately a content-sharing boundary of its own. Entries
// snapshot a source artifact version below, so making a library public is an
// explicit publication action—not a live widening of the source artifact.
export const templateLibrary = sqliteTable("template_library", {
  id: text("id").primaryKey(),
  org_id: text("org_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  scope: text("scope").$type<TemplateLibraryScope>().notNull().default("private"),
  created_by: text("created_by").notNull(),
  created_at: text("created_at").notNull().default(now),
  updated_at: text("updated_at"),
  mutation_token: text("mutation_token"),
  mutation_started_at: text("mutation_started_at"),
})

// An entry owns the exact starter bytes it publishes through source_blob_key +
// source_content_type. source_artifact_id/source_version are provenance only;
// consumers never read the source artifact to adopt this template.
export const templateLibraryEntry = sqliteTable(
  "template_library_entry",
  {
    id: text("id").primaryKey(),
    library_id: text("library_id")
      .notNull()
      .references(() => templateLibrary.id),
    // Deliberately not an FK: this is immutable provenance. A creator may
    // delete the original artifact without breaking an already-published
    // library snapshot (the bytes are held by source_blob_key).
    source_artifact_id: text("source_artifact_id").notNull(),
    source_version: integer("source_version").notNull(),
    source_blob_key: text("source_blob_key").notNull(),
    source_content_type: text("source_content_type").notNull(),
    kind: text("kind").$type<TemplateEntryKind>().notNull(),
    category: text("category").notNull(),
    format: text("format").$type<TemplateEntryFormat>().notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    outcome: text("outcome").notNull(),
    sections_json: text("sections_json").notNull().default("[]"),
    inputs_json: text("inputs_json").notNull().default("[]"),
    tags_json: text("tags_json").notNull().default("[]"),
    created_by: text("created_by").notNull(),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [index("template_library_entry_library").on(t.library_id, t.created_at)],
)

// The instance's GitHub App credentials, captured once via the manifest flow
// (one-click "Set up GitHub App"). A single row, id = 'default'. The three
// secret columns are AES-GCM encrypted at rest (see lib/crypto).
// Per-workspace preferences. One row per org; `settings` is a JSON OrgSettings blob.
export const orgSettings = sqliteTable("org_settings", {
  org_id: text("org_id").primaryKey(),
  settings: text("settings").notNull().default("{}"),
  created_at: text("created_at").notNull().default(now),
})

// One workspace's Stripe subscription cache (webhook-fed; Stripe is the source
// of truth). A row with a null stripe_subscription_id is a checkout stub.
export const subscription = sqliteTable("subscription", {
  org_id: text("org_id").primaryKey(),
  stripe_customer_id: text("stripe_customer_id").notNull(),
  stripe_subscription_id: text("stripe_subscription_id"),
  tier: text("tier").$type<"team" | "business">().notNull(),
  billing_interval: text("billing_interval").$type<"month" | "year">().notNull(),
  status: text("status").notNull(),
  quantity: integer("quantity").notNull(),
  current_period_end: text("current_period_end"),
  created_at: text("created_at").notNull().default(now),
  updated_at: text("updated_at").notNull(),
})

// A connected Slack workspace (one row per Derive org). `bot_token` AES-encrypted at rest.
export const slackInstall = sqliteTable("slack_install", {
  org_id: text("org_id").primaryKey(),
  team_id: text("team_id").notNull(),
  team_name: text("team_name"),
  bot_token: text("bot_token").notNull(),
  bot_user_id: text("bot_user_id"),
  // Flipped to 1 when the stored bot token is known to be unusable: either Slack rejected a
  // call for auth/scope reasons (invalid_auth, token_revoked, missing_scope), or Slack told us
  // outright via app_uninstalled / tokens_revoked. The Settings UI shows a reconnect banner.
  // Cleared on a fresh OAuth connect.
  needs_reauth: integer("needs_reauth").notNull().default(0).$type<0 | 1>(),
  created_at: text("created_at").notNull().default(now),
})

// Per-user notification preferences within a workspace. `prefs` is a JSON blob (absent =
// defaults on), so preference types can be added without a migration.
// A reader's last-seen position in an activity stream — one row per (user, scope), where
// scope is `ws:<org_id>` for the workspace feed or `artifact:<short_id>` for an artifact's
// rail. The web's "New" marker is measured against it. It moves forward on visible dwell
// and rewinds only on an explicit "mark new from here" (`manual`), so a glance at another
// tab never eats the line and every device draws it in the same place.
export const activitySeen = sqliteTable(
  "activity_seen",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    scope: text("scope").notNull(),
    seen_at: text("seen_at").notNull(),
    updated_at: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("activity_seen_key").on(t.user_id, t.scope)],
)

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
    kind: text("kind").$type<"oauth" | "api_key" | "login">().notNull(),
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
    surface: text("surface").$type<SlackThreadSurface>().notNull().default("channel_mirror"),
    recipient_user_id: text("recipient_user_id"),
    slack_user_id: text("slack_user_id"),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [
    // One Slack message per (Derive thread, channel): a thread mirrors into every channel
    // subscribed to its artifact, so the same thread legitimately has several messages.
    // Reply-back still resolves uniquely off (channel, message_ts) below.
    uniqueIndex("slack_thread_link_thread").on(t.thread_id, t.channel),
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
export const slackSubscription = sqliteTable(
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
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [
    // One subscription per channel per scope: subscribing the same channel to the same
    // collection twice is the same subscription, edited.
    uniqueIndex("slack_subscription_target").on(t.org_id, t.channel_id, t.scope_kind, t.scope_id),
    index("slack_subscription_org").on(t.org_id, t.active),
  ],
)

export const githubApp = sqliteTable("github_app", {
  id: text("id").primaryKey(),
  app_id: text("app_id").notNull(),
  slug: text("slug").notNull(),
  client_id: text("client_id").notNull(),
  client_secret: text("client_secret").notNull(),
  private_key: text("private_key").notNull(),
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
  // When set, the host answers 302 → this absolute URL instead of serving content.
  // Written when a draft is claimed (the derive.page URL forwards to the artifact's
  // permanent home); reusable for any future host rename.
  redirect_to: text("redirect_to"),
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
    // Snapshot name of the requester, so history stays legible after the agent is gone.
    requested_by_name: text("requested_by_name"),
    // The user asked to review (the grant owner for an OAuth agent).
    requested_for: text("requested_for").notNull(),
    state: text("state").$type<ReviewRoundState>().notNull().default("pending"),
    note: text("note"),
    // `requested_for` is who was asked; these record who actually settled it.
    resolved_by: text("resolved_by"),
    resolved_by_name: text("resolved_by_name"),
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
    // Connections this context may use, as a JSON array of ids — the SAME shape (and
    // parser) as automation.connection_ids, because an automation bound to a context is
    // a scheduled use(context, instruction) and the two must not disagree about what a
    // context can reach. Null/absent = no tools.
    connection_ids: text("connection_ids"),
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
    // NULLABLE since chat: a session that names no context is served by the default agent
    // (the model plus the document). A context is how you opt INTO a packaged agent, not a
    // requirement for having a conversation. Relaxed on existing DBs by RELAX_STATEMENTS.
    context_id: text("context_id").references(() => context.id),
    org_id: text("org_id").notNull(),
    asker_id: text("asker_id").notNull(),
    /** The manifest version this session opened against; null when there is no context. */
    context_version: integer("context_version"),
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
    // What this session is ABOUT, as a Selector (packages/core/src/selectors.ts) —
    // the same JSON shape automation.refs stores, so one address type serves both
    // lanes. Null = a plain ask with no subject, which is every session before this.
    subject_ref: text("subject_ref"),
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
    // Pixel dimensions read from the header at upload (see lib/image.ts). Null for fonts,
    // unreadable headers, and rows predating the columns — so they ALTER ADD cleanly.
    width: integer("width"),
    height: integer("height"),
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [index("asset_org").on(t.org_id)],
)

// A structured FACT extracted from a version's source (see @derive/facts):
// a small named JSON payload the authoring agent can query back across versions without
// re-parsing its own old markup. Natural key (artifact_id, n, slot); rows are written once
// when a version goes live and never mutated. `gen` marks which extraction rules produced
// the row (its DEFAULT must equal @derive/core FACT_GEN) so a grammar change can re-extract
// older versions lazily — the generation lever the derived-view cache uses.
export const versionData = sqliteTable(
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
    created_at: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("version_data_slot").on(t.artifact_id, t.n, t.slot)],
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
  sharedState,
  sharedStateActivity,
  version,
  versionData,
  comment,
  webhook,
  webhookDelivery,
  renderJob,
  exportJob,
  membership,
  workspace,
  artifactMember,
  notification,
  agent,
  agentMention,
  automation,
  run,
  workflowRun,
  workflowStepAttempt,
  plan,
  connection,
  invitation,
  artifactInvite,
  collectionInvite,
  signupAttribution,
  instanceOperator,
  oauthClientWorkspace,
  artifactFavorite,
  follow,
  artifactTag,
  collection,
  collectionItem,
  collectionMember,
  collectionFavorite,
  folder,
  templateLibrary,
  templateLibraryEntry,
  orgSettings,
  subscription,
  modelCredential,
  slackInstall,
  slackThreadLink,
  slackUserLink,
  slackSubscription,
  userNotificationPref,
  activitySeen,
  githubApp,
  domain,
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

// One run per automation per cron occurrence — as a CONSTRAINT rather than a convention.
//
// The schedule tick dedupes by reading the newest schedule run and comparing its scheduled_for
// (lib/schedule.ts). That is a read-then-write, so two ticks racing — the every-minute cron,
// plus every polling agent's claim, plus a second API replica — can both decide an occurrence
// is unmaterialized and both create it. Two runs for one occurrence means two executors, two
// model bills, and two versions of the same artifact. The read-then-write stays and still does
// the work; this makes LOSING that race harmless rather than expensive, because the loser's
// INSERT simply fails.
//
// Scoped to reason='schedule' deliberately: manual runs, webhook fires and retries all stamp
// scheduled_for as well (with `now`, or now+backoff), so an unscoped constraint would reject a
// second Run now in the same instant — which is legitimate. Partial and expression-scoped, so
// drizzle's uniqueIndex cannot express it: raw DDL, exactly like the session dedupe above.
const RUN_SCHEDULE_OCCURRENCE_UNIQUE =
  `CREATE UNIQUE INDEX IF NOT EXISTS run_schedule_occurrence ON run ` +
  `(automation_id, scheduled_for) WHERE reason = 'schedule' AND automation_id IS NOT NULL ` +
  `AND scheduled_for IS NOT NULL`

export const SCHEMA_STATEMENTS: string[] = [
  ...ddl.createTables,
  ...placeholderTables(SQLITE_TIMESTAMP_DEFAULT),
  ...ddl.createIndexes,
  ...PERF_INDEXES,
  ARTIFACT_SEARCH_FTS5,
  CONTEXT_SESSION_DEDUPE_UNIQUE,
  RUN_SCHEDULE_OCCURRENCE_UNIQUE,
]

/**
 * Forward-only column adds for existing DBs. SQLite has no ADD COLUMN IF NOT EXISTS,
 * so each runs inside a try/catch at boot and a "duplicate column" throw is the
 * success path (see sqlite.ts). Generated from the drizzle columns that can be added
 * to a populated table (nullable or constant-default), so a new column can't be
 * forgotten here.
 */
export const MIGRATION_STATEMENTS: string[] = ddl.addColumns

/**
 * NOT-NULL RELAXATIONS for existing databases.
 *
 * `ADD COLUMN` cannot express "this column may now be null", and SQLite has no
 * `ALTER COLUMN` at all — the only way is to rebuild the table. That is why these are a
 * separate list from MIGRATION_STATEMENTS rather than generated: a rebuild is destructive
 * if it goes wrong, so each one is written out and reviewed rather than inferred.
 *
 * Runs INSIDE a transaction, and only when the old constraint is still present (the caller
 * checks `PRAGMA table_info`), so a second boot is a no-op rather than a second rebuild.
 * Column order matches the CREATE in ddl.ts; `subject_ref` is last because it was the most
 * recent add.
 */
/**
 * Re-key `slack_thread_link` from UNIQUE(thread_id) to UNIQUE(thread_id, channel).
 *
 * A Derive thread now mirrors into every channel subscribed to its artifact, so one thread
 * legitimately has several Slack messages. The old single-column constraint makes the second
 * one fail with `UNIQUE constraint failed` — and unlike a new column, a constraint change has
 * no additive form: `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table and
 * MIGRATION_STATEMENTS only ever emits ADD COLUMN. So an upgraded database would silently keep
 * the old constraint and break the moment a second channel subscribed.
 *
 * Hence the documented SQLite create-copy-drop-rename, same as CONTEXT_SESSION_RELAX_SQLITE.
 * Applied only when a stale single-column unique on thread_id is actually present (see
 * sqlite.ts), so it runs once and is a no-op on a fresh database.
 */
export const SLACK_THREAD_LINK_REKEY_SQLITE: string[] = [
  `CREATE TABLE slack_thread_link__new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  surface TEXT NOT NULL DEFAULT 'channel_mirror',
  recipient_user_id TEXT,
  slack_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (thread_id, channel),
  UNIQUE (channel, message_ts)
)`,
  `INSERT INTO slack_thread_link__new
   (id, org_id, artifact_id, thread_id, channel, message_ts, surface, recipient_user_id, slack_user_id, created_at)
   SELECT id, org_id, artifact_id, thread_id, channel, message_ts, surface, recipient_user_id, slack_user_id, created_at
   FROM slack_thread_link`,
  `DROP TABLE slack_thread_link`, // schema-ignore: middle step of the rebuild above
  `ALTER TABLE slack_thread_link__new RENAME TO slack_thread_link`,
]

export const CONTEXT_SESSION_RELAX_SQLITE: string[] = [
  `CREATE TABLE context_session__new (
  id TEXT PRIMARY KEY,
  context_id TEXT,
  org_id TEXT NOT NULL,
  asker_id TEXT NOT NULL,
  context_version INTEGER,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  started_at TEXT,
  lease_until TEXT,
  result_artifact_id TEXT,
  dedupe_key TEXT,
  subject_ref TEXT,
  FOREIGN KEY (context_id) REFERENCES context(id)
)`,
  `INSERT INTO context_session__new (id, context_id, org_id, asker_id, context_version, state,
     created_at, updated_at, started_at, lease_until, result_artifact_id, dedupe_key, subject_ref)
   SELECT id, context_id, org_id, asker_id, context_version, state,
     created_at, updated_at, started_at, lease_until, result_artifact_id, dedupe_key, subject_ref
   FROM context_session`,
  // schema-ignore — the ONE sanctioned drop, and only as the middle step of the documented
  // SQLite table-rebuild (create-copy-drop-rename). The guardrail is right in general: you
  // evolve by adding. But `ADD COLUMN` cannot express "may now be null" and SQLite has no
  // ALTER COLUMN, so relaxing a NOT NULL has no additive form. The copy above has already
  // run inside the same transaction, and the test asserts every pre-existing row survives.
  `DROP TABLE context_session`, // schema-ignore: middle step of the rebuild above
  `ALTER TABLE context_session__new RENAME TO context_session`,
  `CREATE INDEX IF NOT EXISTS context_session_queue ON context_session (context_id, state, created_at)`,
  `CREATE INDEX IF NOT EXISTS context_session_asker ON context_session (asker_id, created_at)`,
  CONTEXT_SESSION_DEDUPE_UNIQUE,
]

// Schema parity is enforced in repos.ts, where the shared `schema` object lives:
// `Exhaustive`/`Shapes` (./parity) force every table to be classified and every
// typed table's row shape to match its @derive/core Record. See ./parity.
