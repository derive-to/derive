import type {
  AgentMentionRecord,
  AgentRecord,
  ArtifactDetail,
  ArtifactDetailOpts,
  ArtifactInviteRecord,
  ArtifactMemberRecord,
  ArtifactRecord,
  ArtifactSkillLinkRecord,
  AssetRecord,
  AuditLogRecord,
  AutomationRecord,
  BootstrapRead,
  CollectionInviteRecord,
  CollectionMemberRecord,
  CollectionPreview,
  CollectionRecord,
  CollectionsOverviewRead,
  CollectionsViewer,
  CommentListOpts,
  CommentRecord,
  CommentSignals,
  CommentState,
  ConnectionRecord,
  ConnectionScope,
  ConnectionStatus,
  ContextAskerRecord,
  ContextOutput,
  ContextRecord,
  DeliveryRecord,
  DeliveryStatus,
  DomainRecord,
  DomainStatus,
  ExportJobRecord,
  FolderRecord,
  FollowKind,
  FollowRecord,
  GitHubAppRecord,
  GithubUserMapping,
  InvitationRecord,
  LinkRole,
  ListArtifactsOpts,
  ListEnrichment,
  ListEnrichmentOpts,
  Listed,
  ListPageOpts,
  MembershipRecord,
  MetaStore,
  ModelCredentialRecord,
  NewAgent,
  NewAgentMention,
  NewArtifact,
  NewArtifactInvite,
  NewArtifactMember,
  NewArtifactSkillLink,
  NewAsset,
  NewAuditLog,
  NewAutomation,
  NewCollection,
  NewCollectionInvite,
  NewCollectionMember,
  NewComment,
  NewConnection,
  NewContext,
  NewContextAsker,
  NewDelivery,
  NewDomain,
  NewExportJob,
  NewFolder,
  NewFollow,
  NewInvitation,
  NewMembership,
  NewNotification,
  NewPlan,
  NewRenderJob,
  NewReport,
  NewReviewRound,
  NewRun,
  NewSession,
  NewSessionMessage,
  NewSharedStateActivity,
  NewSignupAttribution,
  NewSkillInstallation,
  NewSkillRelation,
  NewSlackSubscription,
  NewTemplateLibrary,
  NewTemplateLibraryEntry,
  NewVersion,
  NewVersionData,
  NewView,
  NewWebhook,
  NewWorkflowRun,
  NewWorkflowStepAttempt,
  NotificationRecord,
  NotificationsPage,
  OAuthGrant,
  OAuthGrantSummary,
  OAuthGrantWorkspaceRead,
  OrgSettings,
  PlanKind,
  PlanRecord,
  PreviewStatus,
  RenderJobRecord,
  RenderJobStatus,
  ReportRecord,
  ReportState,
  ReviewRoundRecord,
  Role,
  RunRecord,
  RunStatus,
  SessionMessageRecord,
  SessionRecord,
  SessionState,
  SharedStateActivityRecord,
  SharedStateRecord,
  SharedStateWrite,
  SignupAttributionRecord,
  SkillInstallationRecord,
  SkillRelationRecord,
  SkillUsageBucket,
  SlackAuthorFilter,
  SlackInstallRecord,
  SlackSubscriptionRecord,
  SlackThreadLinkRecord,
  SlackUserLinkRecord,
  SubscriptionRecord,
  TakedownInput,
  TemplateLibraryEntryRecord,
  TemplateLibraryRecord,
  TemplateLibraryScope,
  UserDir,
  UserNotificationPrefRecord,
  UserProfile,
  VersionDataRecord,
  VersionRecord,
  ViewStats,
  WebhookRecord,
  WorkflowRunRecord,
  WorkflowRunTransition,
  WorkflowStepAttemptRecord,
  WorkflowStepAttemptTransition,
  WorkflowStepTransitionGuard,
  WorkflowTransitionGuard,
  WorkspaceAccess,
  WorkspaceRecord,
  WorkspaceSummary,
} from "@derive/core"
import {
  BILLABLE_ROLES,
  GLOBAL_FOLLOW_ORG,
  isValidWorkflowRunDefinitionPin,
  isValidWorkflowStepContextPin,
  LINKS_FACT,
  maxRole,
  mergeRunMeta,
  parseRunMeta,
  runCounter,
  SHARED_STATE_ACTIVITY_LIMIT,
  WORKSPACE_FACT_ROW_CAP,
  workflowRunCanTransition,
  workflowStatusIsTerminal,
  workflowStepCanTransition,
} from "@derive/core"
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  max,
  ne,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import type { Exhaustive, Shapes } from "./parity"
import {
  activitySeen,
  agent,
  agentMention,
  artifact,
  artifactFavorite,
  artifactInvite,
  artifactMember,
  artifactSkillLink,
  artifactTag,
  asset,
  auditLog,
  automation,
  collection,
  collectionFavorite,
  collectionInvite,
  collectionItem,
  collectionMember,
  comment,
  connection,
  context,
  contextAsker,
  contextSession,
  domain,
  exportJob,
  folder,
  follow,
  githubApp,
  instanceOperator,
  invitation,
  membership,
  modelCredential,
  notification,
  oauthClientWorkspace,
  orgSettings,
  PG_SCHEMA_STATEMENTS,
  plan,
  renderJob,
  report,
  reviewRound,
  run,
  sessionMessage,
  sharedState,
  sharedStateActivity,
  signupAttribution,
  skillInstallation,
  skillRelation,
  slackInstall,
  slackSubscription,
  slackThreadLink,
  slackUserLink,
  subscription,
  templateLibrary,
  templateLibraryEntry,
  userNotificationPref,
  version,
  versionData,
  webhook,
  webhookDelivery,
  workflowRun,
  workflowStepAttempt,
  workspace,
} from "./pg-schema"
import {
  artifactListConditions,
  artifactListOrder,
  artifactSortExpr,
  parseOAuthScopes,
  parseOrgSettings,
} from "./repos"

const one = <T>(rows: T[]): T => {
  const r = rows[0]
  if (r === undefined) throw new Error("expected a returning row")
  return r
}

// Exported so the pg schema-conformance test can diff these defs against the
// columns PG_SCHEMA_STATEMENTS actually creates in a real Postgres.
export const schema = {
  artifact,
  sharedState,
  sharedStateActivity,
  version,
  versionData,
  comment,
  webhook,
  webhookDelivery,
  exportJob,
  renderJob,
  membership,
  workspace,
  artifactMember,
  notification,
  artifactFavorite,
  follow,
  artifactTag,
  reviewRound,
  agent,
  agentMention,
  automation,
  run,
  workflowRun,
  workflowStepAttempt,
  skillRelation,
  skillInstallation,
  artifactSkillLink,
  plan,
  connection,
  artifactInvite,
  invitation,
  signupAttribution,
  instanceOperator,
  subscription,
  oauthClientWorkspace,
  context,
  contextAsker,
  contextSession,
  sessionMessage,
  collection,
  collectionItem,
  collectionMember,
  collectionFavorite,
  folder,
  templateLibrary,
  templateLibraryEntry,
  githubApp,
  domain,
  report,
  auditLog,
  asset,
}

// Compile-time schema parity (see ./parity), same classification as the sqlite
// dialect but checking the pg `$inferSelect` shapes. New table not classified, or
// a pg column that drifts from its core Record → compile error here.
const _schemaExhaustive: Exhaustive<typeof schema> = true
const _schemaShapes: Shapes<typeof schema> = {
  artifact: true,
  sharedState: true,
  sharedStateActivity: true,
  version: true,
  versionData: true,
  comment: true,
  webhook: true,
  webhookDelivery: true,
  renderJob: true,
  exportJob: true,
  membership: true,
  workspace: true,
  artifactMember: true,
  notification: true,
  follow: true,
  reviewRound: true,
  agent: true,
  agentMention: true,
  automation: true,
  run: true,
  workflowRun: true,
  workflowStepAttempt: true,
  skillRelation: true,
  skillInstallation: true,
  artifactSkillLink: true,
  plan: true,
  connection: true,
  invitation: true,
  artifactInvite: true,
  signupAttribution: true,
  subscription: true,
  context: true,
  contextAsker: true,
  contextSession: true,
  sessionMessage: true,
  collection: true,
  collectionMember: true,
  folder: true,
  templateLibrary: true,
  templateLibraryEntry: true,
  githubApp: true,
  domain: true,
  report: true,
  auditLog: true,
  asset: true,
}
void _schemaExhaustive
void _schemaShapes

const VIEW_WINDOW_MS = 30 * 86400_000
const LAST_24H_MS = 86400_000

/**
 * Postgres metadata store (Neon, RDS, self-hosted) for horizontal scale — the
 * container is stateless and many instances share one database. CRUD goes
 * through the drizzle query builder against the pg-dialect schema (one table
 * definition, dialect-correct SQL generated for us); the analytics aggregations
 * stay raw `pool.query` where GROUP BY / DISTINCT read clearer.
 */

/**
 * Cost ACCUMULATES onto whatever the run already banked — it never replaces it.
 *
 * A retry reuses the SAME run row (requeueRun), so a run that burned an expensive failed attempt
 * and then settled cheaply would report only the cheap number, undercounting exactly the runs
 * that cost the most in the column the monthly budget sums. A missing value leaves the column
 * untouched rather than nulling it, so a provider that reports nothing (Codex plain-text, an
 * older CLI) cannot erase what an earlier attempt recorded.
 *
 * Shared by finishRun and requeueRun, and mirrored in the other driver — the two must agree.
 */
const addRunCost = (micros: number | null | undefined) =>
  micros == null ? {} : { cost_micro_usd: sql`coalesce(${run.cost_micro_usd}, 0) + ${micros}` }

// ---- Boot-path SQL shared between the standalone methods and bootstrap() ----
// Positional params are stable across every consumer: $1 = org id, $2 = user id
// (nullable text), $3 = notifications page limit (bootstrap only).
type SummaryRow = { kind: string; k: string | null; n: number | null }
const WORKSPACE_SUMMARY_SQL = `SELECT 'total' kind, NULL k, count(*)::int n FROM artifact WHERE org_id = $1 AND archived_at IS NULL
       UNION ALL
       SELECT 'archived', NULL, count(*)::int FROM artifact WHERE org_id = $1 AND archived_at IS NOT NULL
       UNION ALL
       SELECT 'tag', t.tag, count(*)::int FROM artifact_tag t
         JOIN artifact a ON a.id = t.artifact_id
        WHERE a.org_id = $1 AND a.archived_at IS NULL GROUP BY t.tag
       UNION ALL
       SELECT 'workspace', w.name, NULL FROM workspace w WHERE w.id = $1
       UNION ALL
       SELECT 'favorites', NULL, count(*)::int FROM artifact_favorite f
         JOIN artifact a ON a.id = f.artifact_id
        WHERE $2::text IS NOT NULL AND f.user_id = $2
          AND a.org_id = $1 AND a.removed_at IS NULL AND a.archived_at IS NULL
       UNION ALL
       SELECT 'mine', NULL, count(*)::int FROM artifact a
         JOIN artifact_member m ON m.artifact_id = a.id AND m.user_id = $2 AND m.role = 'owner'
        WHERE $2::text IS NOT NULL AND a.org_id = $1 AND a.archived_at IS NULL
       UNION ALL
       SELECT 'mine_private', NULL, count(*)::int FROM artifact a
         JOIN artifact_member m ON m.artifact_id = a.id AND m.user_id = $2 AND m.role = 'owner'
        WHERE $2::text IS NOT NULL AND a.org_id = $1 AND a.listed = 'none' AND a.archived_at IS NULL`
const mapSummaryRows = (rows: SummaryRow[]): WorkspaceSummary => {
  const out: WorkspaceSummary = {
    total: 0,
    archived: 0,
    tags: [],
    workspace: null,
    favorites: 0,
    mine: 0,
    minePrivate: 0,
  }
  for (const r of rows) {
    switch (r.kind) {
      case "total":
        out.total = r.n ?? 0
        break
      case "archived":
        out.archived = r.n ?? 0
        break
      case "tag":
        if (r.k !== null) out.tags.push({ tag: r.k, count: r.n ?? 0 })
        break
      case "workspace":
        out.workspace = r.k
        break
      case "favorites":
        out.favorites = r.n ?? 0
        break
      case "mine":
        out.mine = r.n ?? 0
        break
      case "mine_private":
        out.minePrivate = r.n ?? 0
        break
    }
  }
  out.tags.sort((a, b) => a.tag.localeCompare(b.tag))
  return out
}
/**
 * A user's role per collection, from BOTH sources: their explicit member rows, and
 * their workspace SEAT on each workspace-open collection (higher wins, applied by the
 * caller with maxRole).
 *
 * `scope` is a subquery selecting the collections in play — an id list for the batched
 * method, the whole org for the boot read. Shared because it drifted: bootstrap carried
 * only the member-row half, so on Postgres the boot batch dropped every workspace-open
 * collection the caller had not explicitly joined (collectionsJson filters out a
 * collection with no role), and the later /v1/collections fetch put them back. A
 * collection visibly appeared and disappeared depending on which response you were
 * looking at. Embedded drivers were never wrong here — composeBootstrap calls the real
 * method — so it only showed against Postgres.
 */
const collectionRolesSql = (scope: string, user: string) =>
  `SELECT collection_id id, role FROM collection_member
     WHERE user_id = ${user} AND collection_id IN (${scope})
   UNION ALL
   SELECT c.id, m.role FROM collection c
     JOIN membership m ON m.org_id = c.org_id
    WHERE c.id IN (${scope}) AND c.workspace_access = 'member' AND m.user_id = ${user}`

// $1 = org id. Two org-scoped tables the collections route always reads together, plus —
// when the caller is a known viewer — the three per-user arms the Collections view
// decorates them with. Those three were separate store calls for one release and cost
// ~240ms per request on the edge tier; as UNION arms they cost nothing extra, which is
// what round-trip-budget.test.ts pins.
//
// `viewer` carries the PLACEHOLDER NAMES (not values) so the same arms can be spliced
// into two statements with different parameter numbering — bootstrap already owns $1..$4.
//
// Every arm's second column must be `json`, not `jsonb`: UNION refuses to match the two,
// and the first two arms are row_to_json. Hence to_json() on the scalar arms.
// The ranked strip both viewer arms read: each collection's live artifacts, newest
// first, numbered within the collection. Built once so 'preview' and 'byline' cannot
// disagree about which artifacts are on the strip.
const PREVIEW_STRIP_SQL = `SELECT ci.collection_id, a.id, a.short_id, a.title, a.current_version,
                  COALESCE(a.updated_at, a.created_at) updated_at,
                  (v.preview_status = 'ready') has_preview,
                  a.author_id, a.author_name, a.author_login, a.author_avatar,
                  row_number() OVER (
                    PARTITION BY ci.collection_id
                    ORDER BY COALESCE(a.updated_at, a.created_at) DESC, a.id DESC) rn
             FROM collection_item ci
             JOIN collection c ON c.id = ci.collection_id AND c.org_id = $1
             JOIN artifact a ON a.id = ci.artifact_id AND a.removed_at IS NULL AND a.archived_at IS NULL
             LEFT JOIN "version" v ON v.artifact_id = a.id AND v.n = a.current_version`

// `bylines` joins the Better Auth "user" table, which fresh self-hosts may not have —
// callers try WITH it and retry WITHOUT on failure, the same best-effort contract
// listEnrichment keeps for its directory arms.
const collectionsOverviewSql = (
  viewer?: { user: string; since: string; per: string },
  bylines = true,
) =>
  `SELECT 'collection' kind, row_to_json(t) doc FROM (
         SELECT c.*, COALESCE(ci.cnt, 0)::int AS count
         FROM collection c
         LEFT JOIN (
           SELECT ci2.collection_id, count(*)::int cnt FROM collection_item ci2
             JOIN artifact a2 ON a2.id = ci2.artifact_id AND a2.removed_at IS NULL AND a2.archived_at IS NULL
            GROUP BY ci2.collection_id
         ) ci ON ci.collection_id = c.id
         WHERE c.org_id = $1
       ) t${
         !viewer
           ? ""
           : `
       UNION ALL
       SELECT 'starred', to_json(cf.collection_id) FROM collection_favorite cf
         JOIN collection c ON c.id = cf.collection_id
        WHERE cf.user_id = ${viewer.user} AND c.org_id = $1
       UNION ALL
       SELECT 'active', row_to_json(w) FROM (
         SELECT id, max(at) at FROM (
           SELECT ci.collection_id id, t.at FROM (
             SELECT artifact_id, created_at at FROM "version"
              WHERE author_id = ${viewer.user} AND created_at >= ${viewer.since}
             UNION ALL
             SELECT artifact_id, created_at FROM "comment"
              WHERE author_id = ${viewer.user} AND created_at >= ${viewer.since}
           ) t
           JOIN collection_item ci ON ci.artifact_id = t.artifact_id
           JOIN collection c ON c.id = ci.collection_id AND c.org_id = $1
           UNION ALL
           SELECT cm.collection_id, cm.created_at FROM collection_member cm
             JOIN collection c ON c.id = cm.collection_id
            WHERE cm.user_id = ${viewer.user} AND cm.created_at >= ${viewer.since}
              AND c.org_id = $1 AND c.created_by <> ${viewer.user}
         ) u GROUP BY id
       ) w
       UNION ALL
       SELECT 'preview', row_to_json(p) FROM (
         SELECT collection_id, id, short_id, title, current_version, updated_at, has_preview,
                author_id, author_name, author_login, author_avatar
           FROM (${PREVIEW_STRIP_SQL}) r WHERE r.rn <= ${viewer.per}
       ) p${
         !bylines
           ? ""
           : `
       UNION ALL
       SELECT 'byline', row_to_json(b) FROM (
         SELECT DISTINCT u.id, u.name, u.username FROM "user" u
          WHERE u.id IN (SELECT r2.author_id FROM (${PREVIEW_STRIP_SQL}) r2
                          WHERE r2.rn <= ${viewer.per} AND r2.author_id IS NOT NULL)
       ) b`
}`
}`
/** The viewer-free statement, for callers that only want the org-scoped halves. */
const COLLECTIONS_OVERVIEW_SQL = collectionsOverviewSql()
type OverviewRow = { kind: string; doc: unknown }
const mapOverviewRows = (rows: OverviewRow[]): CollectionsOverviewRead => {
  const collections: (CollectionRecord & { count: number })[] = []
  const starred: string[] = []
  const workedIn: { id: string; at: string }[] = []
  const previews: Record<string, CollectionPreview[]> = {}
  const previewBylines: { id: string; name: string | null; username: string | null }[] = []
  for (const r of rows) {
    switch (r.kind) {
      case "collection":
        collections.push(r.doc as CollectionRecord & { count: number })
        break
      case "starred":
        starred.push(r.doc as string)
        break
      case "active":
        workedIn.push(r.doc as { id: string; at: string })
        break
      case "byline":
        previewBylines.push(r.doc as { id: string; name: string | null; username: string | null })
        break
      case "preview": {
        const p = r.doc as CollectionPreview & { collection_id: string }
        const bucket = previews[p.collection_id] ?? []
        previews[p.collection_id] = bucket
        bucket.push({
          id: p.id,
          short_id: p.short_id,
          title: p.title,
          current_version: p.current_version,
          updated_at: p.updated_at,
          // A left-joined row with no ready version yields SQL NULL, not false.
          has_preview: p.has_preview === true,
          author_id: p.author_id,
          author_name: p.author_name,
          author_login: p.author_login,
          author_avatar: p.author_avatar,
        })
        break
      }
      default:
        break
    }
  }
  collections.sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  )
  // The window function ordered each partition, but UNION ALL gives no cross-row order
  // guarantee once the arms are merged — re-apply the strip's order here.
  for (const bucket of Object.values(previews))
    bucket.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))
  return { collections, starred, workedIn, previews, previewBylines }
}

export class PgMetaStore implements MetaStore {
  /** Postgres binds an id array as ONE parameter and caps a statement at 65535, so the
   *  shared visibility gate does not need to split a candidate list the way D1 does. Well
   *  under the cap, and comfortably above the deepest candidate cap the search uses (200). */
  idsPerQuery() {
    return 1000
  }

  private constructor(
    private pool: Pool,
    private db: NodePgDatabase<typeof schema>,
  ) {}

  /** Connect and apply the schema (idempotent) before first use. `onError` is
   *  invoked for idle-pool errors: a DB restart / network blip emits an `'error'`
   *  on the pool, and without a listener node-postgres turns it into an unhandled
   *  exception that crashes the whole process. */
  static async create(
    connectionString: string,
    onError?: (err: Error) => void,
  ): Promise<PgMetaStore> {
    const pool = new Pool({
      connectionString,
      // Bound how long a query / connection acquisition can hang, so a stuck query
      // can't pin a connection indefinitely and exhaust the pool.
      statement_timeout: 30_000,
      connectionTimeoutMillis: 10_000,
    })
    pool.on("error", (err) => onError?.(err))
    // ONE round trip, not 294. The statements are joined and sent as a single
    // simple query rather than awaited one at a time.
    //
    // This is a latency fix, and the size of it depends on who is paying the
    // round trips. The test suite provisions 915 stores per Postgres run (counted
    // from information_schema.schemata after a full run), and each one was
    // replaying all 294 statements sequentially: 234ms per store measured, ~1.4x
    // of which is round-trip overhead rather than work. Measured on the five
    // heaviest api specs against a clean database, 287 tests passing either way:
    // 56.1s -> 46.5s wall, 84.3s -> 60.3s of test-body time.
    //
    // Production gains MORE than the suite does, not less, which is the opposite
    // of what a local benchmark suggests. Against a networked Postgres every one
    // of those 294 statements paid a full RTT; at a Neon-ish 20ms that is ~6s of
    // pure latency on every boot, and it collapses to one RTT here.
    //
    // Two properties change, both checked before doing this:
    //   - ATOMICITY. A multi-statement simple query runs in one implicit
    //     transaction, so a failure now rolls the whole schema back instead of
    //     leaving it half applied. That is strictly better for a boot, and it does
    //     not change the failure POLICY: this boot has never had a per-statement
    //     try/catch, so any failing statement was already fatal (see the note on
    //     SLACK_THREAD_LINK_REKEY_PG in pg-schema.ts). Postgres has transactional
    //     DDL and nothing here uses CREATE INDEX CONCURRENTLY, which is the one
    //     thing that could not run inside it.
    //   - TIMEOUT SCOPE. statement_timeout above now bounds the whole schema pass
    //     rather than each statement. The pass measures ~117ms against a local
    //     engine and is one round trip against a remote one, so 30s keeps roughly
    //     two orders of magnitude of headroom.
    //
    // The conformance test in packages/db/test deliberately still applies these
    // one at a time — it is asserting per-statement idempotency and the legacy
    // migration paths, which is a different property from how boot applies them.
    await pool.query(PG_SCHEMA_STATEMENTS.join(";\n"))
    return PgMetaStore.fromPool(pool)
  }

  /** Wrap an existing pool without applying schema — the Workers path, where pools
   *  are invocation-scoped (see apps/api edge-pg.ts) and DDL runs at deploy
   *  time (apply-pg-schema.ts). */
  static fromPool(pool: Pool): PgMetaStore {
    return new PgMetaStore(pool, drizzle(pool, { schema }))
  }

  async createArtifact(a: NewArtifact): Promise<ArtifactRecord> {
    await this.db.insert(artifact).values(a)
    return (await this.getByShortId(a.short_id)) as ArtifactRecord
  }

  async setAccess(
    artifactId: string,
    workspaceAccess: WorkspaceAccess,
    listed: Listed,
    linkRole: LinkRole,
    passwordHash: string | null,
  ): Promise<void> {
    await this.db
      .update(artifact)
      .set({
        workspace_access: workspaceAccess,
        listed,
        link_role: linkRole,
        password_hash: passwordHash,
      })
      .where(eq(artifact.id, artifactId))
  }

  async setLocked(artifactId: string, locked: 0 | 1): Promise<void> {
    await this.db.update(artifact).set({ locked }).where(eq(artifact.id, artifactId))
  }

  async setPublicHistory(artifactId: string, on: 0 | 1): Promise<void> {
    await this.db.update(artifact).set({ public_history: on }).where(eq(artifact.id, artifactId))
  }

  async getByShortId(shortId: string): Promise<ArtifactRecord | null> {
    const rows = await this.db.select().from(artifact).where(eq(artifact.short_id, shortId))
    return rows[0] ?? null
  }
  async artifactWithVersion(
    shortId: string,
    n?: number,
  ): Promise<{ artifact: ArtifactRecord; version: VersionRecord | null } | null> {
    const rows = await this.db
      .select({ artifact, version })
      .from(artifact)
      .leftJoin(
        version,
        and(
          eq(version.artifact_id, artifact.id),
          n === undefined ? eq(version.n, artifact.current_version) : eq(version.n, n),
        ),
      )
      .where(eq(artifact.short_id, shortId))
    const row = rows[0]
    return row
      ? {
          artifact: row.artifact as ArtifactRecord,
          version: (row.version as VersionRecord | null) ?? null,
        }
      : null
  }

  async artifactWithVersionData(
    shortId: string,
    slot: string,
    n?: number,
  ): Promise<{
    artifact: ArtifactRecord
    version: VersionRecord | null
    data: VersionDataRecord | null
  } | null> {
    const rows = await this.db
      .select({ artifact, version, data: versionData })
      .from(artifact)
      .leftJoin(
        version,
        and(
          eq(version.artifact_id, artifact.id),
          n === undefined ? eq(version.n, artifact.current_version) : eq(version.n, n),
        ),
      )
      .leftJoin(
        versionData,
        and(
          eq(versionData.artifact_id, artifact.id),
          eq(versionData.n, version.n),
          eq(versionData.slot, slot),
        ),
      )
      .where(eq(artifact.short_id, shortId))
    const row = rows[0]
    return row
      ? {
          artifact: row.artifact as ArtifactRecord,
          version: (row.version as VersionRecord | null) ?? null,
          data: (row.data as VersionDataRecord | null) ?? null,
        }
      : null
  }
  async getByShortIds(shortIds: string[]): Promise<ArtifactRecord[]> {
    if (shortIds.length === 0) return []
    return this.db.select().from(artifact).where(inArray(artifact.short_id, shortIds))
  }
  async artifactWithSettings(
    shortId: string,
  ): Promise<{ artifact: ArtifactRecord | null; settings: OrgSettings }> {
    // LEFT JOIN, not INNER: a workspace with no settings row is the common case (settings
    // are written on first change), and the artifact must still come back — with parsed
    // defaults, exactly what getOrgSettings returns for a missing row.
    const rows = await this.db
      .select({ artifact, settings: orgSettings.settings })
      .from(artifact)
      .leftJoin(orgSettings, eq(orgSettings.org_id, artifact.org_id))
      .where(eq(artifact.short_id, shortId))
    const row = rows[0]
    return {
      artifact: (row?.artifact as ArtifactRecord | undefined) ?? null,
      settings: parseOrgSettings(row?.settings ?? null),
    }
  }
  async getArtifactById(id: string): Promise<ArtifactRecord | null> {
    const rows = await this.db.select().from(artifact).where(eq(artifact.id, id))
    return rows[0] ?? null
  }
  async getArtifactsByIds(ids: string[]): Promise<ArtifactRecord[]> {
    if (ids.length === 0) return []
    return this.db.select().from(artifact).where(inArray(artifact.id, ids))
  }

  async getSharedState(artifactId: string, key: string): Promise<SharedStateRecord | null> {
    const rows = await this.db
      .select()
      .from(sharedState)
      .where(and(eq(sharedState.artifact_id, artifactId), eq(sharedState.key, key)))
    return rows[0] ?? null
  }

  async countSharedStateKeys(artifactId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(sharedState)
      .where(eq(sharedState.artifact_id, artifactId))
    return Number(rows[0]?.n ?? 0)
  }

  async putSharedState(write: SharedStateWrite): Promise<SharedStateRecord | null> {
    const { expected_version, ...values } = write
    if (expected_version === 0) {
      const rows = await this.db
        .insert(sharedState)
        .values({ ...values, version: 1 })
        .onConflictDoNothing()
        .returning()
      return rows[0] ?? null
    }
    const rows = await this.db
      .update(sharedState)
      .set({
        json: values.json,
        version: expected_version + 1,
        updated_by_id: values.updated_by_id,
        updated_by_name: values.updated_by_name,
        updated_at: values.updated_at,
      })
      .where(
        and(
          eq(sharedState.artifact_id, values.artifact_id),
          eq(sharedState.key, values.key),
          eq(sharedState.version, expected_version),
        ),
      )
      .returning()
    return rows[0] ?? null
  }

  async appendSharedStateActivity(a: NewSharedStateActivity): Promise<void> {
    await this.db.insert(sharedStateActivity).values(a)
    if (a.version <= SHARED_STATE_ACTIVITY_LIMIT) return
    await this.db
      .delete(sharedStateActivity)
      .where(
        and(
          eq(sharedStateActivity.artifact_id, a.artifact_id),
          eq(sharedStateActivity.key, a.key),
          lte(sharedStateActivity.version, a.version - SHARED_STATE_ACTIVITY_LIMIT),
        ),
      )
  }

  async listSharedStateActivity(
    artifactId: string,
    key: string,
    limit: number,
  ): Promise<SharedStateActivityRecord[]> {
    return this.db
      .select()
      .from(sharedStateActivity)
      .where(and(eq(sharedStateActivity.artifact_id, artifactId), eq(sharedStateActivity.key, key)))
      .orderBy(desc(sharedStateActivity.version))
      .limit(limit)
  }

  async addVersion(artifactId: string, v: NewVersion): Promise<VersionRecord> {
    return this.db.transaction(async (tx) => {
      const cur = await tx
        .select({ cv: artifact.current_version })
        .from(artifact)
        .where(eq(artifact.id, artifactId))
        .for("update")
      if (!cur[0]) throw new Error(`artifact not found: ${artifactId}`)
      const n = cur[0].cv + 1
      await tx.insert(version).values({ ...v, artifact_id: artifactId, n })
      await tx
        .update(artifact)
        .set({
          current_version: n,
          current_content_type: v.content_type,
          updated_at: new Date().toISOString(),
          // Denormalize the new version's author onto the artifact (its CURRENT author).
          author_name: v.author,
          author_login: v.author_login ?? null,
          author_avatar: v.author_avatar ?? null,
          author_gh_id: v.author_gh_id ?? null,
          author_id: v.author_id ?? null,
        })
        .where(eq(artifact.id, artifactId))
      const rows = await tx
        .select()
        .from(version)
        .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
      return one(rows)
    })
  }

  async replaceCurrentVersion(
    artifactId: string,
    expected: { n: number; blobKey: string },
    v: NewVersion,
  ): Promise<VersionRecord | null> {
    return this.db.transaction(async (tx) => {
      const current = await tx
        .select({ n: artifact.current_version })
        .from(artifact)
        .where(eq(artifact.id, artifactId))
        .for("update")
      if (current[0]?.n !== expected.n) return null

      const now = new Date().toISOString()
      const rows = await tx
        .update(version)
        .set({
          blob_key: v.blob_key,
          content_type: v.content_type,
          size_bytes: v.size_bytes ?? 0,
          author: v.author,
          author_login: v.author_login ?? null,
          author_avatar: v.author_avatar ?? null,
          author_gh_id: v.author_gh_id ?? null,
          author_id: v.author_id ?? null,
          source: v.source ?? null,
          message: v.message,
          name: v.name ?? null,
          preview_key: null,
          preview_status: null,
          preview_error: null,
          preview_full_key: null,
          preview_full_status: null,
          preview_full_error: null,
          preview_marked_key: null,
          preview_marked_status: null,
          preview_marked_error: null,
          summary: null,
          summary_src_hash: null,
          created_at: now,
        })
        .where(
          and(
            eq(version.artifact_id, artifactId),
            eq(version.n, expected.n),
            eq(version.blob_key, expected.blobKey),
          ),
        )
        .returning()
      const replaced = rows[0]
      if (!replaced) return null

      await tx
        .delete(versionData)
        .where(and(eq(versionData.artifact_id, artifactId), eq(versionData.n, expected.n)))
      await tx
        .update(artifact)
        .set({
          current_content_type: v.content_type,
          updated_at: now,
          author_name: v.author,
          author_login: v.author_login ?? null,
          author_avatar: v.author_avatar ?? null,
          author_gh_id: v.author_gh_id ?? null,
          author_id: v.author_id ?? null,
        })
        .where(and(eq(artifact.id, artifactId), eq(artifact.current_version, expected.n)))
      return replaced
    })
  }

  listVersions(artifactId: string): Promise<VersionRecord[]> {
    return this.db
      .select()
      .from(version)
      .where(eq(version.artifact_id, artifactId))
      .orderBy(asc(version.n))
  }

  async unfurlInfo(
    artifactId: string,
    versionN: number,
  ): Promise<{
    versionCount: number
    commentCount: number
    version: VersionRecord | null
    facts: { slot: string; json: string }[]
  }> {
    // Counts computed IN the database rather than by reading both tables into the Worker
    // and calling `.length` (which is what the share-link path used to do), and the
    // current version row and its data slots ride along — one round trip instead of four.
    const { rows } = await this.pool.query<{ kind: string; n: number | null; doc: unknown }>(
      // The NULL placeholders carry explicit casts: Postgres resolves a UNION's column
      // types from the branches, and a bare NULL against row_to_json's `json` (or against
      // an int) is a "could not determine data type" error rather than a null.
      `SELECT 'versions' kind, count(*)::int n, NULL::json doc FROM version WHERE artifact_id = $1
       UNION ALL
       SELECT 'comments', count(*)::int, NULL::json FROM comment WHERE artifact_id = $1
       UNION ALL
       SELECT 'version', NULL::int, row_to_json(v) FROM version v
        WHERE v.artifact_id = $1 AND v.n = $2
       UNION ALL
       -- Ordered here, not in the caller: slotSummary reads them in slot order, and a
       -- UNION ALL makes no ordering promise of its own.
       SELECT 'slot', NULL::int, row_to_json(d) FROM (
         SELECT slot, json FROM version_data
          WHERE artifact_id = $1 AND n = $2 ORDER BY slot
       ) d`,
      [artifactId, versionN],
    )
    let versionCount = 0
    let commentCount = 0
    let version: VersionRecord | null = null
    const facts: { slot: string; json: string }[] = []
    // Branch on `kind`, never on "has a doc" — the version row and the fact rows both
    // carry one, so a truthiness test would read a fact as the version.
    for (const r of rows) {
      if (r.kind === "versions") versionCount = r.n ?? 0
      else if (r.kind === "comments") commentCount = r.n ?? 0
      else if (r.kind === "version") {
        if (r.doc) version = r.doc as VersionRecord
      } else if (r.kind === "slot" && r.doc) {
        facts.push(r.doc as { slot: string; json: string })
      }
    }
    return { versionCount, commentCount, version, facts }
  }

  async currentVersions(artifactIds: string[]): Promise<Record<string, VersionRecord>> {
    if (artifactIds.length === 0) return {}
    const { rows } = await this.pool.query<VersionRecord & { artifact_id: string }>(
      `SELECT v.* FROM version v
         JOIN artifact a ON a.id = v.artifact_id AND a.current_version = v.n
        WHERE v.artifact_id = ANY($1)`,
      [artifactIds],
    )
    const out: Record<string, VersionRecord> = {}
    for (const r of rows) out[r.artifact_id] = r
    return out
  }

  async artifactDetail(opts: ArtifactDetailOpts): Promise<ArtifactDetail> {
    const { artifactId, orgId, viewerId } = opts
    // Six sequential ~80ms round trips (versions, tags, collection ids,
    // open threads, favorite, settings) collapsed into one UNION ALL. Whole
    // rows ride as JSON in `doc` so branches with different column sets can share the
    // union; the scalar branches carry a count or a marker row.
    // The byline arm reads Better Auth's `user` table, which this package's schema does
    // not own — a D1-only or db-package-only deployment may not have it at all. Same
    // shape as listEnrichment's directory branches: try the whole statement, and on
    // failure retry without that one arm rather than losing the other seven. The caller
    // then simply gets no bylines, which is exactly what it got before this arm existed.
    const CORE_BRANCHES = `SELECT 'version' kind, row_to_json(v) doc FROM version v WHERE v.artifact_id = $1
       UNION ALL
       SELECT 'tag', to_json(t.tag) FROM artifact_tag t WHERE t.artifact_id = $1
       UNION ALL
       SELECT 'collection', to_json(ci.collection_id) FROM collection_item ci WHERE ci.artifact_id = $1
       UNION ALL
       SELECT 'threads', to_json(count(DISTINCT c.thread_id)::int) FROM comment c
        WHERE c.artifact_id = $1 AND c.state = 'open'
       UNION ALL
       SELECT 'favorite', to_json(count(*)::int) FROM artifact_favorite f
        WHERE f.artifact_id = $1 AND $2::text IS NOT NULL AND f.user_id = $2
       UNION ALL
       SELECT 'settings', to_json(s.settings) FROM org_settings s WHERE s.org_id = $3`
    // The live rows behind every author_id on this artifact and its versions. This was
    // its own resolveUserBylines round trip at the end of the record route, sequential
    // with everything above it; as an arm it costs nothing extra.
    const BYLINE_BRANCH = `
       UNION ALL
       SELECT 'byline', row_to_json(u) FROM "user" u WHERE u.id IN (
         SELECT v.author_id FROM version v WHERE v.artifact_id = $1 AND v.author_id IS NOT NULL
         UNION
         SELECT a.author_id FROM artifact a WHERE a.id = $1 AND a.author_id IS NOT NULL)`
    const params = [artifactId, viewerId, orgId]
    let rows: { kind: string; doc: unknown }[]
    try {
      rows = (
        await this.pool.query<{ kind: string; doc: unknown }>(CORE_BRANCHES + BYLINE_BRANCH, params)
      ).rows
    } catch {
      rows = (await this.pool.query<{ kind: string; doc: unknown }>(CORE_BRANCHES, params)).rows
    }
    const versions: VersionRecord[] = []
    const bylines: { id: string; name: string | null; username: string | null }[] = []
    const tags: string[] = []
    const collectionIds: string[] = []
    let openThreads = 0
    let favorite = false
    let settingsJson: string | null = null
    for (const r of rows) {
      switch (r.kind) {
        case "version":
          versions.push(r.doc as VersionRecord)
          break
        case "byline":
          bylines.push(r.doc as { id: string; name: string | null; username: string | null })
          break
        case "tag":
          tags.push(r.doc as string)
          break
        case "collection":
          collectionIds.push(r.doc as string)
          break
        case "threads":
          openThreads = (r.doc as number) ?? 0
          break
        case "favorite":
          favorite = ((r.doc as number) ?? 0) > 0
          break
        case "settings":
          settingsJson = (r.doc as string | null) ?? null
          break
      }
    }
    // Same orderings the individual queries guaranteed: versions ascending by n (the
    // detail route indexes `versions[i]` against its own mapped array),
    // first, tags sorted.
    versions.sort((a, b) => a.n - b.n)
    tags.sort()
    return {
      versions,
      bylines,
      tags,
      collectionIds,
      openThreads,
      favorite,
      settings: parseOrgSettings(settingsJson),
    }
  }

  async getVersion(artifactId: string, n: number): Promise<VersionRecord | null> {
    const rows = await this.db
      .select()
      .from(version)
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
    return rows[0] ?? null
  }
  async setVersionData(artifactId: string, n: number, rows: NewVersionData[]): Promise<void> {
    // Delete-then-insert so a re-extraction of the same version is idempotent (a fresh
    // publish never has existing rows for its new n; restore/re-extract might).
    await this.db
      .delete(versionData)
      .where(and(eq(versionData.artifact_id, artifactId), eq(versionData.n, n)))
    if (rows.length === 0) return
    await this.db
      .insert(versionData)
      .values(rows.map((r) => ({ ...r, artifact_id: artifactId, n })))
  }
  async setDerivedVersionData(
    artifactId: string,
    n: number,
    rows: NewVersionData[],
  ): Promise<void> {
    // Replace ONLY the derived ($) rows: the delete is prefix-scoped so this writer cannot
    // express "remove an asserted row", which is what makes it safe to run concurrently with
    // the backfill (see MetaStore.setDerivedVersionData for the interleaving it prevents).
    await this.db
      .delete(versionData)
      .where(
        and(
          eq(versionData.artifact_id, artifactId),
          eq(versionData.n, n),
          like(versionData.slot, "$%"),
        ),
      )
    if (rows.length === 0) return
    await this.db
      .insert(versionData)
      .values(rows.map((r) => ({ ...r, artifact_id: artifactId, n })))
  }
  async getVersionData(artifactId: string, n: number, slot?: string): Promise<VersionDataRecord[]> {
    return this.db
      .select()
      .from(versionData)
      .where(
        and(
          eq(versionData.artifact_id, artifactId),
          eq(versionData.n, n),
          slot ? eq(versionData.slot, slot) : undefined,
        ),
      )
      .orderBy(asc(versionData.slot))
  }

  async catchUpRead(
    artifactId: string,
    beforeN: number,
    afterN: number,
  ): Promise<{
    versions: VersionRecord[]
    comments: CommentRecord[]
    rounds: ReviewRoundRecord[]
    beforeData: VersionDataRecord[]
    afterData: VersionDataRecord[]
  }> {
    // Five independent reads ride one statement. node-postgres serializes queries on one
    // edge connection, so Promise.all cannot remove their network latency by itself.
    const { rows } = await this.pool.query<{ kind: string; doc: unknown }>(
      `SELECT 'version' kind, row_to_json(v) doc FROM version v
        WHERE v.artifact_id = $1
       UNION ALL
       SELECT 'comment', row_to_json(c) FROM comment c
        WHERE c.artifact_id = $1
       UNION ALL
       SELECT 'round', row_to_json(r) FROM review_round r
        WHERE r.artifact_id = $1
       UNION ALL
       SELECT 'before-data', row_to_json(d) FROM version_data d
        WHERE d.artifact_id = $1 AND d.n = $2
       UNION ALL
       SELECT 'after-data', row_to_json(d) FROM version_data d
        WHERE d.artifact_id = $1 AND d.n = $3`,
      [artifactId, beforeN, afterN],
    )
    const versions: VersionRecord[] = []
    const comments: CommentRecord[] = []
    const rounds: ReviewRoundRecord[] = []
    const beforeData: VersionDataRecord[] = []
    const afterData: VersionDataRecord[] = []
    for (const row of rows) {
      if (row.kind === "version") versions.push(row.doc as VersionRecord)
      else if (row.kind === "comment") comments.push(row.doc as CommentRecord)
      else if (row.kind === "round") rounds.push(row.doc as ReviewRoundRecord)
      else if (row.kind === "before-data") beforeData.push(row.doc as VersionDataRecord)
      else if (row.kind === "after-data") afterData.push(row.doc as VersionDataRecord)
    }
    versions.sort((a, b) => a.n - b.n)
    comments.sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
    )
    rounds.sort((a, b) => (a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : 0))
    beforeData.sort((a, b) => a.slot.localeCompare(b.slot))
    afterData.sort((a, b) => a.slot.localeCompare(b.slot))
    return { versions, comments, rounds, beforeData, afterData }
  }
  async getVersionDataSeries(
    artifactId: string,
    slot: string,
    from: number,
    to: number,
    limit: number,
  ): Promise<VersionDataRecord[]> {
    return this.db
      .select()
      .from(versionData)
      .where(
        and(
          eq(versionData.artifact_id, artifactId),
          eq(versionData.slot, slot),
          gte(versionData.n, from),
          lte(versionData.n, to),
        ),
      )
      .orderBy(asc(versionData.n))
      .limit(limit)
  }
  async listWorkspaceFacts(orgId: string, opts?: { limit?: number }) {
    // Raw (slot, artifact) rows over each artifact's CURRENT version. Counting happens in
    // the caller, AFTER the visibility gate — see the port doc for why not here.
    return this.db
      .select({
        slot: versionData.slot,
        artifact_id: versionData.artifact_id,
        at: versionData.created_at,
      })
      .from(versionData)
      .innerJoin(
        artifact,
        and(eq(artifact.id, versionData.artifact_id), eq(artifact.current_version, versionData.n)),
      )
      .where(
        and(eq(artifact.org_id, orgId), isNull(artifact.removed_at), isNull(artifact.archived_at)),
      )
      .orderBy(asc(versionData.slot))
      .limit(opts?.limit ?? WORKSPACE_FACT_ROW_CAP)
  }
  async listFactAcrossArtifacts(
    orgId: string,
    slot: string,
    opts?: { tag?: string; limit?: number },
  ) {
    // Joined on artifact.current_version so a superseded row cannot be reported as the
    // current state. Tombstoned and archived artifacts are outside ordinary discovery.
    const tagged = opts?.tag
      ? this.db
          .select({ id: artifactTag.artifact_id })
          .from(artifactTag)
          .where(eq(artifactTag.tag, opts.tag.trim().toLowerCase()))
      : null
    return this.db
      .select({
        id: artifact.id,
        short_id: artifact.short_id,
        title: artifact.title,
        n: versionData.n,
        json: versionData.json,
        at: versionData.created_at,
      })
      .from(versionData)
      .innerJoin(
        artifact,
        and(eq(artifact.id, versionData.artifact_id), eq(artifact.current_version, versionData.n)),
      )
      .where(
        and(
          eq(artifact.org_id, orgId),
          eq(versionData.slot, slot),
          isNull(artifact.removed_at),
          isNull(artifact.archived_at),
          tagged ? inArray(artifact.id, tagged) : undefined,
        ),
      )
      .orderBy(desc(versionData.created_at))
      .limit(opts?.limit ?? 100)
  }
  async currentVersionDataForArtifacts(artifactIds: string[], slots: string[]) {
    if (!artifactIds.length || !slots.length) return []
    return this.db
      .select(getTableColumns(versionData))
      .from(versionData)
      .innerJoin(
        artifact,
        and(eq(artifact.id, versionData.artifact_id), eq(artifact.current_version, versionData.n)),
      )
      .where(and(inArray(versionData.artifact_id, artifactIds), inArray(versionData.slot, slots)))
      .orderBy(asc(versionData.artifact_id), asc(versionData.slot))
  }
  // The BACKLINK scan: the inversion of $links. Same join as above, two more predicates.
  //
  // The LIKE NARROWS, the caller CONFIRMS by parsing — a substring match is not proof (the
  // same reasoning as any substring-narrowed index). The quote anchoring that makes it exact today
  // rests on facts in three other files: the slot is $links, the deriver emits only
  // [0-9a-z]{6,12}, and the caller passes no metacharacter. A fourth deriver breaks two of
  // them, and the confirm is what makes that a non-event rather than a wrong answer.
  //
  // `ref` is re-validated HERE as well as at the tool boundary, because an unvalidated one
  // reaching the pattern ("%") returns every linking artifact — a wrong answer, which is
  // worse than an error. Lowercased by the caller because SQLite's LIKE is ASCII
  // case-insensitive and Postgres's is not: the confirm settles the difference, but the two
  // dialects should not disagree about the candidate set either.
  //
  // `at` is the artifact's activity time (stamped by addVersion), never
  // version_data.created_at: a lazily derived row's timestamp is when the host got round to
  // indexing, not when the link was made.
  async listArtifactsLinkingTo(
    orgId: string,
    ref: string,
    opts?: { tag?: string; limit?: number },
  ) {
    if (!/^[0-9a-z]{6,12}$/.test(ref)) return []
    const tagged = opts?.tag
      ? this.db
          .select({ id: artifactTag.artifact_id })
          .from(artifactTag)
          .where(eq(artifactTag.tag, opts.tag.trim().toLowerCase()))
      : null
    return this.db
      .select({
        id: artifact.id,
        short_id: artifact.short_id,
        title: artifact.title,
        current_content_type: artifact.current_content_type,
        n: versionData.n,
        json: versionData.json,
        gen: versionData.gen,
        at: artifactSortExpr(artifact, "updated").mapWith(String),
      })
      .from(versionData)
      .innerJoin(
        artifact,
        and(eq(artifact.id, versionData.artifact_id), eq(artifact.current_version, versionData.n)),
      )
      .where(
        and(
          eq(artifact.org_id, orgId),
          eq(versionData.slot, LINKS_FACT),
          like(versionData.json, `%"${ref}"%`),
          isNull(artifact.removed_at),
          isNull(artifact.archived_at),
          tagged ? inArray(artifact.id, tagged) : undefined,
        ),
      )
      .orderBy(desc(versionData.created_at))
      .limit(opts?.limit ?? 100)
  }
  async reclassifyVersion(artifactId: string, n: number, contentType: string): Promise<void> {
    await this.db
      .update(version)
      .set({ content_type: contentType })
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
    // Keep the artifact's denormalized current_content_type in sync when the fixed
    // version is the current one (the field the viewer reads to pick render mode).
    await this.db
      .update(artifact)
      .set({ current_content_type: contentType })
      .where(and(eq(artifact.id, artifactId), eq(artifact.current_version, n)))
  }

  async setVersionPreview(
    artifactId: string,
    n: number,
    fields: {
      preview_key?: string | null
      preview_status?: PreviewStatus | null
      preview_error?: string | null
    },
  ): Promise<void> {
    await this.db
      .update(version)
      .set(fields)
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
  }

  async setVersionSummary(
    artifactId: string,
    n: number,
    fields: { summary?: string | null; summary_src_hash?: string | null },
  ): Promise<void> {
    await this.db
      .update(version)
      .set(fields)
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
  }

  async setVersionPreviewVariant(
    artifactId: string,
    n: number,
    variant: "full" | "marked",
    fields: { key?: string | null; status?: PreviewStatus | null; error?: string | null },
  ): Promise<void> {
    const set =
      variant === "full"
        ? {
            preview_full_key: fields.key,
            preview_full_status: fields.status,
            preview_full_error: fields.error,
          }
        : {
            preview_marked_key: fields.key,
            preview_marked_status: fields.status,
            preview_marked_error: fields.error,
          }
    await this.db
      .update(version)
      .set(set)
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
  }

  async createComment(c: NewComment): Promise<CommentRecord> {
    const rows = await this.db.insert(comment).values(c).returning()
    return one(rows)
  }

  async getComment(id: string): Promise<CommentRecord | null> {
    const rows = await this.db.select().from(comment).where(eq(comment.id, id))
    return rows[0] ?? null
  }

  async updateComment(
    id: string,
    fields: { body_md?: string; meta?: string | null; anchor?: string | null },
  ): Promise<CommentRecord | null> {
    const rows = await this.db.update(comment).set(fields).where(eq(comment.id, id)).returning()
    return rows[0] ?? null
  }

  listComments(artifactId: string, opts?: CommentListOpts): Promise<CommentRecord[]> {
    const where = and(
      eq(comment.artifact_id, artifactId),
      opts?.state ? eq(comment.state, opts.state) : undefined,
      opts?.threadId ? eq(comment.thread_id, opts.threadId) : undefined,
    )
    return this.db.select().from(comment).where(where).orderBy(asc(comment.created_at))
  }
  async commentAuthorIds(artifactId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ id: comment.author_id })
      .from(comment)
      .where(and(eq(comment.artifact_id, artifactId), isNotNull(comment.author_id)))
    return rows.map((r) => r.id).filter((x): x is string => !!x)
  }

  async commentsPage(
    artifactId: string,
    versionN: number,
    opts?: CommentListOpts,
  ): Promise<{ comments: CommentRecord[]; version: VersionRecord | null }> {
    // The comments and the version their anchors re-resolve against, both keyed on this
    // artifact — one round trip instead of two (see edge-pg.ts on why that matters).
    const { rows } = await this.pool.query<{ kind: string; doc: unknown }>(
      `SELECT 'comment' kind, row_to_json(c) doc FROM comment c
        WHERE c.artifact_id = $1 AND ($2::text IS NULL OR c.state = $2)
       UNION ALL
       SELECT 'version', row_to_json(v) FROM version v
        WHERE v.artifact_id = $1 AND v.n = $3`,
      [artifactId, opts?.state ?? null, versionN],
    )
    const comments: CommentRecord[] = []
    let version: VersionRecord | null = null
    for (const r of rows) {
      if (r.kind === "comment") comments.push(r.doc as CommentRecord)
      else version = r.doc as VersionRecord
    }
    // listComments' ordering, preserved: oldest first (the rail renders in thread order).
    comments.sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
    )
    return { comments, version }
  }

  async setThreadState(artifactId: string, threadId: string, state: CommentState): Promise<number> {
    const rows = await this.db
      .update(comment)
      .set({ state })
      .where(and(eq(comment.artifact_id, artifactId), eq(comment.thread_id, threadId)))
      .returning({ id: comment.id })
    return rows.length
  }

  // Atomic: the thread's comments and everything keyed to it (notifications, agent
  // mentions, Slack link) go together, so a removed thread leaves nothing dangling.
  async deleteThread(artifactId: string, threadId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(notification)
        .where(and(eq(notification.artifact_id, artifactId), eq(notification.thread_id, threadId)))
      await tx
        .delete(agentMention)
        .where(and(eq(agentMention.artifact_id, artifactId), eq(agentMention.thread_id, threadId)))
      await tx.delete(slackThreadLink).where(eq(slackThreadLink.thread_id, threadId))
      await tx
        .delete(comment)
        .where(and(eq(comment.artifact_id, artifactId), eq(comment.thread_id, threadId)))
    })
  }

  // Mirrors the sqlite path: mentions live in meta.mentions (JSON), matched in code.
  private commentMentionsUser(metaJson: string | null, userId: string): boolean {
    if (!metaJson) return false
    try {
      const m = JSON.parse(metaJson) as { mentions?: { id?: string }[] }
      return Array.isArray(m.mentions) && m.mentions.some((x) => x?.id === userId)
    } catch {
      return false
    }
  }

  async commentSignals(
    artifactIds: string[],
    userId: string | null,
  ): Promise<Record<string, CommentSignals>> {
    if (artifactIds.length === 0) return {}
    const rows = await this.db
      .select({
        artifact_id: comment.artifact_id,
        thread_id: comment.thread_id,
        state: comment.state,
        author_id: comment.author_id,
        meta: comment.meta,
      })
      .from(comment)
      .where(inArray(comment.artifact_id, artifactIds))
    return this.assembleCommentSignals(rows, userId)
  }

  /** Fold raw comment rows into per-artifact signals — shared by `commentSignals`
   *  and the `listEnrichment` batch so the two paths cannot drift. */
  private assembleCommentSignals(
    rows: {
      artifact_id: string
      thread_id: string
      state: string
      author_id: string | null
      meta: string | null
    }[],
    userId: string | null,
  ): Record<string, CommentSignals> {
    const out: Record<string, CommentSignals> = {}
    const threads: Record<string, Set<string>> = {}
    for (const r of rows) {
      if (r.state !== "open") continue
      let sig = out[r.artifact_id]
      if (!sig) {
        sig = { open_threads: 0, mentions_me: false, i_participated: false }
        out[r.artifact_id] = sig
      }
      let set = threads[r.artifact_id]
      if (!set) {
        set = new Set()
        threads[r.artifact_id] = set
      }
      set.add(r.thread_id)
      if (userId) {
        if (r.author_id === userId) sig.i_participated = true
        if (!sig.mentions_me && this.commentMentionsUser(r.meta, userId)) sig.mentions_me = true
      }
    }
    for (const [id, set] of Object.entries(threads)) {
      const sig = out[id]
      if (sig) sig.open_threads = set.size
    }
    return out
  }

  /**
   * The library list's whole decoration in ONE round trip: a UNION ALL over the seven
   * per-id lookups, discriminated by a `kind` column and demuxed in code. On the edge
   * tier every round trip costs ~80ms flat (one serialized pg.Client per invocation —
   * see edge-pg.ts), so seven separate trips keyed on the same page of ids was ~560ms
   * of pure wire time per listing; the SQL each branch runs is unchanged. All columns
   * are text (counts cast) so the union stays type-consistent. `= ANY($n)` binds each
   * id set as one array parameter. The "user"/"account" branches are not best-effort
   * here the way `getUsers`/`usersByGithubIds` are: on Postgres, Better Auth shares
   * this database (its jwks row is read on every authenticated request), so those
   * tables existing is a precondition of reaching this route at all.
   */
  async listEnrichment(opts: ListEnrichmentOpts): Promise<ListEnrichment> {
    const { ids, ghIds, authorIds, viewerId, memberId, views } = opts
    const out: ListEnrichment = {
      views: {},
      tags: {},
      collections: {},
      previews: {},
      handles: [],
      bylines: [],
      signals: {},
      shareRoles: {},
      favorites: [],
    }
    if (ids.length === 0 && ghIds.length === 0 && authorIds.length === 0) return out
    const params: unknown[] = []
    const bind = (v: unknown) => {
      params.push(v)
      return `$${params.length}`
    }
    const branches: string[] = []
    if (ids.length > 0) {
      const page = bind(ids)
      branches.push(
        `SELECT 'tag' kind, artifact_id k, tag c1, NULL c2, NULL c3 FROM artifact_tag WHERE artifact_id = ANY(${page})`,
        `SELECT 'collection', artifact_id, collection_id, NULL, NULL FROM collection_item
          WHERE artifact_id = ANY(${page})`,
        `SELECT 'preview', a.id, NULL, NULL, NULL FROM artifact a
           JOIN version v ON v.artifact_id = a.id AND v.n = a.current_version
          WHERE v.preview_status = 'ready' AND a.id = ANY(${page})`,
      )
      if (views)
        branches.push(
          `SELECT 'view', artifact_id, count(*)::text, NULL, NULL FROM view
            WHERE artifact_id = ANY(${page}) GROUP BY artifact_id`,
        )
      if (viewerId) {
        const viewer = bind(viewerId)
        branches.push(
          `SELECT 'comment', artifact_id, thread_id, author_id, meta FROM comment
            WHERE state = 'open' AND artifact_id = ANY(${page})`,
          // Page-scoped, so the arm reads at most `ids.length` rows off the unique
          // (artifact_id, user_id) index — where the route's old standalone call read the
          // viewer's whole favorite list, and paid a round trip to do it.
          `SELECT 'favorite', artifact_id, NULL, NULL, NULL FROM artifact_favorite
            WHERE user_id = ${viewer} AND artifact_id = ANY(${page})`,
        )
      }
      if (memberId)
        branches.push(
          `SELECT 'share', artifact_id, role, NULL, NULL FROM artifact_member
            WHERE user_id = ${bind(memberId)} AND artifact_id = ANY(${page})`,
        )
    }
    // The "user"/"account" branches keep `getUsers`/`usersByGithubIds`' best-effort
    // contract: those Better Auth tables can be absent (fresh self-host, operator-token
    // deployments), and there they must degrade to empty — not 500 the listing. A
    // failed union retries once without them; a union that fails WITHOUT them has a
    // real problem and still throws.
    const directoryBranches = (ghIds.length > 0 ? 1 : 0) + (authorIds.length > 0 ? 1 : 0)
    if (ghIds.length > 0)
      branches.push(
        `SELECT 'handle', a."accountId", u.username, NULL, NULL
           FROM "account" a JOIN "user" u ON u.id = a."userId"
          WHERE a."providerId" = 'github' AND a."accountId" = ANY(${bind(ghIds)})`,
      )
    if (authorIds.length > 0)
      branches.push(
        `SELECT 'byline', id, name, username, NULL FROM "user" WHERE id = ANY(${bind(authorIds)})`,
      )
    type EnrichmentRow = {
      kind: string
      k: string
      c1: string | null
      c2: string | null
      c3: string | null
    }
    let rows: EnrichmentRow[]
    try {
      const res = await this.pool.query<EnrichmentRow>(branches.join("\nUNION ALL\n"), params)
      rows = res.rows
    } catch (e) {
      if (directoryBranches === 0) throw e
      const core = branches.slice(0, branches.length - directoryBranches)
      if (core.length === 0) return out
      const res = await this.pool.query<EnrichmentRow>(
        core.join("\nUNION ALL\n"),
        params.slice(0, params.length - directoryBranches),
      )
      rows = res.rows
    }
    const commentRows: {
      artifact_id: string
      thread_id: string
      state: string
      author_id: string | null
      meta: string | null
    }[] = []
    for (const r of rows) {
      switch (r.kind) {
        case "tag": {
          const list = out.tags[r.k] ?? []
          list.push(r.c1 as string)
          out.tags[r.k] = list
          break
        }
        case "collection": {
          const list = out.collections[r.k] ?? []
          list.push(r.c1 as string)
          out.collections[r.k] = list
          break
        }
        case "preview":
          out.previews[r.k] = true
          break
        case "view":
          out.views[r.k] = Number(r.c1)
          break
        case "comment":
          commentRows.push({
            artifact_id: r.k,
            thread_id: r.c1 as string,
            state: "open",
            author_id: r.c2,
            meta: r.c3,
          })
          break
        case "share":
          out.shareRoles[r.k] = r.c1 as Role
          break
        case "favorite":
          out.favorites.push(r.k)
          break
        case "handle":
          out.handles.push({ gh_id: r.k, username: r.c1 })
          break
        case "byline":
          out.bylines.push({ id: r.k, name: r.c1, username: r.c2 })
          break
      }
    }
    for (const k in out.tags) out.tags[k]?.sort()
    out.signals = this.assembleCommentSignals(commentRows, viewerId)
    return out
  }

  async artifactIdsNeedingFeedback(userId: string, orgId: string): Promise<string[]> {
    const rows = await this.db
      .select({
        artifact_id: comment.artifact_id,
        author_id: comment.author_id,
        meta: comment.meta,
      })
      .from(comment)
      .innerJoin(artifact, eq(artifact.id, comment.artifact_id))
      .where(and(eq(comment.state, "open"), eq(artifact.org_id, orgId)))
    const ids = new Set<string>()
    for (const r of rows) {
      if (r.author_id === userId || this.commentMentionsUser(r.meta, userId)) ids.add(r.artifact_id)
    }
    return [...ids]
  }

  /** The list query as a BUILDER, so `listArtifacts` and `listPage` cannot diverge.
   *  `listPage` inlines this into a CTE verbatim — which is the entire safety argument
   *  for that fold: the visibility predicate is REUSED, never re-expressed in raw SQL.
   *  Getting it subtly wrong is not a slow page, it is one workspace's documents
   *  appearing in another's library. */
  private artifactListQuery(opts?: ListArtifactsOpts) {
    const conds = artifactListConditions(artifact, opts)
    // Collection scope is a JOIN, not an `id IN (…members)` — mirrors the SQLite/D1
    // path in repos.ts so behavior matches across dialects (and never trips a param cap).
    if (opts?.collectionId) {
      conds.push(eq(collectionItem.collection_id, opts.collectionId))
      const q = this.db
        .select(getTableColumns(artifact))
        .from(artifact)
        .innerJoin(collectionItem, eq(collectionItem.artifact_id, artifact.id))
        .where(and(...conds))
        .orderBy(...artifactListOrder(artifact, opts?.sort ?? "created"))
      return opts.limit ? q.limit(opts.limit) : q
    }
    const q = this.db
      .select()
      .from(artifact)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(...artifactListOrder(artifact, opts?.sort ?? "created"))
    return opts?.limit ? q.limit(opts.limit) : q
  }

  listArtifacts(opts?: ListArtifactsOpts): Promise<ArtifactRecord[]> {
    if (opts?.ids && opts.ids.length === 0) return Promise.resolve([])
    return this.artifactListQuery(opts)
  }

  /**
   * The library page AND its decoration in ONE statement — see the port doc.
   *
   * `listArtifacts` then `listEnrichment` are strictly serial: the decoration keys on the
   * ids the list returns, so it cannot start until the list lands. That is ~80ms of pure
   * wire time on the edge tier, on the request that IS the cold boot's critical path
   * (measured 389ms, with the first card at 566ms right behind it).
   *
   * The list query goes in as a CTE **verbatim** — the same builder `listArtifacts` runs,
   * inlined with its parameters — so no visibility predicate is restated here and none can
   * drift. Every decoration arm then joins to that CTE instead of to an id list, which
   * also means `ghIds`/`authorIds` no longer have to make the round trip out to the caller
   * and back: the page's own author columns drive those joins.
   */
  async listPage(
    opts: ListPageOpts,
  ): Promise<{ artifacts: ArtifactRecord[]; enrichment: ListEnrichment }> {
    const empty: ListEnrichment = {
      views: {},
      tags: {},
      collections: {},
      previews: {},
      handles: [],
      bylines: [],
      signals: {},
      shareRoles: {},
      favorites: [],
    }
    if (opts.list.ids && opts.list.ids.length === 0) return { artifacts: [], enrichment: empty }
    const page = this.artifactListQuery(opts.list)
    const { viewerId, memberId, views } = opts

    // Same arms as `listEnrichment`, in the same order, joined to the page instead of to
    // an id array. The store contract runs this against listArtifacts + listEnrichment
    // over the same fixtures and requires them to agree.
    const core = [
      // `- '__rn'` strips the ordinal back off, so the row arm yields exactly the
      // artifact record shape the read-by-read path returns.
      sql`select 'row' as kind, jsonb_build_array(to_jsonb(p) - '__rn', p.__rn::text) as doc from page p`,
      sql`select 'tag', jsonb_build_array(t.artifact_id, t.tag) from artifact_tag t join page p on p.id = t.artifact_id`,
      sql`select 'collection', jsonb_build_array(ci.artifact_id, ci.collection_id) from collection_item ci
            join page p on p.id = ci.artifact_id`,
      sql`select 'preview', jsonb_build_array(p.id) from page p
            join version v on v.artifact_id = p.id and v.n = p.current_version
           where v.preview_status = 'ready'`,
    ]
    if (views)
      core.push(
        sql`select 'view', jsonb_build_array(vw.artifact_id, count(*)::text) from view vw
              join page p on p.id = vw.artifact_id group by vw.artifact_id`,
      )
    if (viewerId) {
      core.push(
        sql`select 'comment', jsonb_build_array(cm.artifact_id, cm.thread_id, cm.author_id, cm.meta) from comment cm
              join page p on p.id = cm.artifact_id where cm.state = 'open'`,
        sql`select 'favorite', jsonb_build_array(f.artifact_id) from artifact_favorite f
              join page p on p.id = f.artifact_id where f.user_id = ${viewerId}`,
      )
    }
    if (memberId)
      core.push(
        sql`select 'share', jsonb_build_array(am.artifact_id, am.role) from artifact_member am
              join page p on p.id = am.artifact_id where am.user_id = ${memberId}`,
      )
    // The Better Auth directory tables can be absent (fresh self-host, operator-token
    // deployments) — the same best-effort contract listEnrichment keeps. A failed union
    // retries once without them rather than failing the listing.
    const directory = [
      sql`select 'handle', jsonb_build_array(ac."accountId", u.username) from page p
            join "account" ac on ac."accountId" = p.author_gh_id and ac."providerId" = 'github'
            join "user" u on u.id = ac."userId"`,
      sql`select 'byline', jsonb_build_array(u.id, u.name, u.username) from page p
            join "user" u on u.id = p.author_id`,
    ]

    type Row = { kind: string; doc: unknown[] }
    const run = async (arms: ReturnType<typeof sql>[]) => {
      const unioned = sql.join(arms, sql` union all `)
      // MATERIALIZED + row_number is what carries the caller's ORDER BY through: a UNION
      // ALL does not preserve the order of its arms, and the LAST row of the page is what
      // the keyset cursor is built from — so losing the order is a pagination bug, not a
      // cosmetic one. Materializing pins the CTE to one evaluation whose output order the
      // window function then numbers.
      const res = await this.db.execute(
        sql`with page_raw as materialized (${page}),
                 page as (select pr.*, row_number() over () as __rn from page_raw pr)
            ${unioned}`,
      )
      return ((res as unknown as { rows?: Row[] }).rows ?? []) as Row[]
    }
    let rows: Row[]
    try {
      rows = await run([...core, ...directory])
    } catch (e) {
      rows = await run(core).catch(() => {
        throw e
      })
    }

    const out: ListEnrichment = {
      ...empty,
      tags: {},
      collections: {},
      views: {},
      previews: {},
      shareRoles: {},
    }
    const ranked: { n: number; a: ArtifactRecord }[] = []
    const commentRows: {
      artifact_id: string
      thread_id: string
      state: string
      author_id: string | null
      meta: string | null
    }[] = []
    for (const r of rows) {
      const d = r.doc as (string | null)[]
      switch (r.kind) {
        case "row":
          ranked.push({ n: Number(d[1]), a: d[0] as unknown as ArtifactRecord })
          break
        case "tag": {
          const list = out.tags[d[0] as string] ?? []
          list.push(d[1] as string)
          out.tags[d[0] as string] = list
          break
        }
        case "collection": {
          const list = out.collections[d[0] as string] ?? []
          list.push(d[1] as string)
          out.collections[d[0] as string] = list
          break
        }
        case "preview":
          out.previews[d[0] as string] = true
          break
        case "view":
          out.views[d[0] as string] = Number(d[1])
          break
        case "comment":
          commentRows.push({
            artifact_id: d[0] as string,
            thread_id: d[1] as string,
            state: "open",
            author_id: d[2] ?? null,
            meta: d[3] ?? null,
          })
          break
        case "favorite":
          out.favorites.push(d[0] as string)
          break
        case "share":
          out.shareRoles[d[0] as string] = d[1] as Role
          break
        case "handle":
          out.handles.push({ gh_id: d[0] as string, username: d[1] ?? null })
          break
        case "byline":
          out.bylines.push({ id: d[0] as string, name: d[1] ?? null, username: d[2] ?? null })
          break
      }
    }
    for (const k in out.tags) out.tags[k]?.sort()
    out.signals = this.assembleCommentSignals(commentRows, viewerId)
    ranked.sort((x, y) => x.n - y.n)
    return { artifacts: ranked.map((r) => r.a), enrichment: out }
  }
  // ---- full-text search index (workspace search substrate) — the tsvector twin of the
  // SQLite fts5 path. `ts_rank_cd` ranks (higher = more relevant). `text` is title + body
  // so a title hit ranks the artifact too.
  //
  // Query building is the tsquery twin of repos.ts `fts5Match`: the raw user text is
  // reduced to alnum tokens, then AND'd as `:*` PREFIX lexemes so a partial word finds its
  // whole word ("auth" → "authentication"), matching the fts5 prefix behaviour. Because the
  // tokens are alnum-only they can never carry tsquery operators (& | ! ( ) : *), so
  // `to_tsquery` can't be injected — the prefix only widens candidate RECALL; the caller's
  // grep-confirm still enforces the exact literal. No tokens → null → no query, no matches.
  private tsPrefixQuery(query: string): string | null {
    const tokens = query.match(/[\p{L}\p{N}]+/gu)
    return tokens?.length ? tokens.map((t) => `${t}:*`).join(" & ") : null
  }
  async indexArtifact(
    id: string,
    orgId: string,
    title: string | null,
    text: string,
  ): Promise<void> {
    const content = title ? `${title}\n\n${text}` : text
    await this.pool.query(
      `INSERT INTO artifact_search (artifact_id, org_id, tsv) VALUES ($1, $2, to_tsvector('simple', $3))
       ON CONFLICT (artifact_id) DO UPDATE SET org_id = $2, tsv = to_tsvector('simple', $3)`,
      [id, orgId, content],
    )
  }
  async unindexArtifact(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM artifact_search WHERE artifact_id = $1`, [id])
  }
  async searchArtifactIds(
    orgId: string,
    query: string,
    limit: number,
  ): Promise<{ id: string; rank: number }[]> {
    const ts = this.tsPrefixQuery(query)
    if (!ts) return []
    const r = await this.pool.query<{ artifact_id: string; rank: number }>(
      `SELECT artifact_id, ts_rank_cd(tsv, to_tsquery('simple', $2)) AS rank
       FROM artifact_search
       WHERE org_id = $1 AND tsv @@ to_tsquery('simple', $2)
       ORDER BY rank DESC LIMIT $3`,
      [orgId, ts, limit],
    )
    return r.rows.map((row) => ({ id: row.artifact_id, rank: Number(row.rank) }))
  }
  async searchArtifactIdsMany(
    orgId: string,
    queries: string[],
    limit: number,
  ): Promise<{ id: string; rank: number }[][]> {
    const out = queries.map(() => [] as { id: string; rank: number }[])
    const searchable = queries
      .map((query, index) => ({ ts: this.tsPrefixQuery(query), index }))
      .filter((item): item is { ts: string; index: number } => item.ts !== null)
    if (!searchable.length) return out
    const params: unknown[] = [orgId]
    // Keep each tsquery constant within its branch. PostgreSQL can then use the GIN index for
    // every concept while the whole batch still crosses the database boundary once.
    const branches = searchable.map(({ index, ts }) => {
      const first = params.length + 1
      params.push(index, ts, Math.max(limit, 1))
      return `(SELECT $${first}::int AS input_index,
                      artifact_id,
                      ts_rank_cd(tsv, to_tsquery('simple', $${first + 1})) AS rank
                 FROM artifact_search
                WHERE org_id = $1 AND tsv @@ to_tsquery('simple', $${first + 1})
                ORDER BY rank DESC
                LIMIT $${first + 2})`
    })
    const r = await this.pool.query<{
      input_index: number
      artifact_id: string
      rank: number
    }>(
      `SELECT * FROM (${branches.join(" UNION ALL ")}) AS batch
        ORDER BY input_index, rank DESC`,
      params,
    )
    for (const row of r.rows) {
      const bucket = out[Number(row.input_index)]
      if (bucket) bucket.push({ id: row.artifact_id, rank: Number(row.rank) })
    }
    return out
  }
  async artifactIdsByTag(tag: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifactTag.artifact_id })
      .from(artifactTag)
      .where(eq(artifactTag.tag, tag))
    return rows.map((r) => r.id)
  }
  // Author filter (mirrors artifactIdsByTag + the SQLite path). Case-insensitive match
  // on the denormalized current author_login, scoped to the workspace.
  async artifactIdsByAuthor(orgId: string, login: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifact.id })
      .from(artifact)
      .where(
        and(
          eq(artifact.org_id, orgId),
          eq(sql`lower(${artifact.author_login})`, login.toLowerCase()),
        ),
      )
    return rows.map((r) => r.id)
  }
  // "Created by me" — every artifact this user holds an OWNER member row on in the
  // workspace, any visibility. Roster-keyed, not author_id-keyed (mirrors the
  // SQLite path — see repos.ts for why the denorm can't anchor "yours").
  private ownerRowJoin(userId: string) {
    return and(
      eq(artifactMember.artifact_id, artifact.id),
      eq(artifactMember.user_id, userId),
      eq(artifactMember.role, "owner"),
    )
  }
  async artifactIdsOwnedBy(orgId: string, userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifact.id })
      .from(artifact)
      .innerJoin(artifactMember, this.ownerRowJoin(userId))
      .where(eq(artifact.org_id, orgId))
    return rows.map((r) => r.id)
  }
  async countArtifacts(orgId?: string): Promise<number> {
    const q = this.db.select({ c: count() }).from(artifact)
    const rows = await (orgId ? q.where(eq(artifact.org_id, orgId)) : q)
    return Number(rows[0]?.c ?? 0)
  }
  async countArchivedArtifacts(orgId: string): Promise<number> {
    const rows = await this.db
      .select({ c: count() })
      .from(artifact)
      .where(and(eq(artifact.org_id, orgId), isNotNull(artifact.archived_at)))
    return Number(rows[0]?.c ?? 0)
  }
  async countOwnedBy(orgId: string, userId: string, listed?: Listed): Promise<number> {
    const rows = await this.db
      .select({ c: count() })
      .from(artifact)
      .innerJoin(artifactMember, this.ownerRowJoin(userId))
      .where(
        and(
          eq(artifact.org_id, orgId),
          isNull(artifact.archived_at),
          listed ? eq(artifact.listed, listed) : undefined,
        ),
      )
    return Number(rows[0]?.c ?? 0)
  }
  async storageBytes(orgId: string): Promise<number> {
    // One row per distinct blob in the org (max size_bytes guards a stale 0 on a
    // restored row), then summed — so dedup'd content is counted once.
    const perBlob = this.db
      .select({ mx: sql<number>`max(${version.size_bytes})`.as("mx") })
      .from(version)
      .innerJoin(artifact, eq(artifact.id, version.artifact_id))
      .where(eq(artifact.org_id, orgId))
      .groupBy(version.blob_key)
      .as("per_blob")
    const rows = await this.db
      .select({ s: sql<number>`coalesce(sum(${perBlob.mx}), 0)` })
      .from(perBlob)
    return Number(rows[0]?.s ?? 0)
  }
  async workspaceSummary(orgId: string, userId: string | null): Promise<WorkspaceSummary> {
    // The browse sidebar's six org/user-scoped reads in one round trip. Each branch is
    // the same SQL the individual method runs — including the semantics that are easy to
    // lose: `favorites` joins the artifact so a favorite of a REMOVED or other-workspace
    // artifact is excluded, `mine`/`minePrivate` require an OWNER member row (not the
    // author_id denorm), and tags come back ordered by tag. The statement text is shared
    // with bootstrap() below, so the two can never drift.
    const { rows } = await this.pool.query<SummaryRow>(WORKSPACE_SUMMARY_SQL, [orgId, userId])
    return mapSummaryRows(rows)
  }
  async bootstrap(
    orgId: string,
    userId: string,
    notifLimit: number,
    viewer: Omit<CollectionsViewer, "userId">,
  ): Promise<BootstrapRead> {
    // The app shell's first breath as ONE statement: five independent org/user-scoped
    // arms UNION ALLed as (arm, doc) jsonb rows. The summary and overview arms embed the
    // EXACT statements their standalone methods run (shared constants above, so they
    // cannot drift); roles is the by-id-list method re-keyed by org (same rows for this
    // caller: every collection id in the list belongs to the org); settings is the raw
    // row getOrgSettings parses; notifications is the window query notificationsPage
    // runs, with the aggregate ordered explicitly so the page order survives jsonb_agg.
    // On the hosted tier this replaces four boot REQUESTS (each paying its own auth and
    // round trips on its own pg.Client) with one round trip after auth.
    const bootSql = (bylines: boolean) =>
      `SELECT 'summary' arm, (SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (${WORKSPACE_SUMMARY_SQL}) t) doc
       UNION ALL
       SELECT 'overview', (SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (${collectionsOverviewSql({ user: "$2", since: "$5", per: "$6" }, bylines)}) t)
       UNION ALL
       SELECT 'roles', (SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (${collectionRolesSql(
         "SELECT id FROM collection WHERE org_id = $1",
         "$2",
       )}) t)
       UNION ALL
       SELECT 'settings', (SELECT to_jsonb(os.settings) FROM org_settings os WHERE os.org_id = $1)
       UNION ALL
       SELECT 'notifications', (SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.created_at DESC, t.id DESC), '[]'::jsonb) FROM (
         SELECT *, count(*) FILTER (WHERE read = 0) OVER ()::int AS unread_total
           FROM notification WHERE user_id = $2
          ORDER BY created_at DESC LIMIT $3) t)
       UNION ALL
       SELECT 'subscription', (SELECT to_jsonb(s) FROM subscription s WHERE s.org_id = $1)
       UNION ALL
       SELECT 'seats', to_jsonb((SELECT count(*)::int FROM membership m
                                  WHERE m.org_id = $1 AND m.role = ANY($4)))`
    const bootParams = [
      orgId,
      userId,
      notifLimit,
      [...BILLABLE_ROLES],
      viewer.activeSince,
      viewer.previewPer,
    ]
    let rows: { arm: string; doc: unknown }[]
    try {
      rows = (await this.pool.query<{ arm: string; doc: unknown }>(bootSql(true), bootParams)).rows
    } catch {
      // Same best-effort as collectionsOverview: the byline arm's "user" join is the
      // only optional table in this statement.
      rows = (await this.pool.query<{ arm: string; doc: unknown }>(bootSql(false), bootParams)).rows
    }
    const arm: Record<string, unknown> = {}
    for (const r of rows) arm[r.arm] = r.doc
    const { collections, starred, workedIn, previews, previewBylines } = mapOverviewRows(
      (arm.overview as OverviewRow[] | null) ?? [],
    )
    // maxRole, not last-wins: the two arms both answer for a collection you are an
    // explicit member of AND hold a seat on, and the higher of the two is your role.
    const collectionRoles: Record<string, Role> = {}
    for (const r of (arm.roles as { id: string; role: Role }[] | null) ?? [])
      collectionRoles[r.id] = maxRole(collectionRoles[r.id] ?? null, r.role) as Role
    const notifRows =
      (arm.notifications as (NotificationRecord & { unread_total: number })[] | null) ?? []
    return {
      summary: mapSummaryRows((arm.summary as SummaryRow[] | null) ?? []),
      collections,
      starred,
      workedIn,
      previews,
      previewBylines,
      collectionRoles,
      billing: {
        subscription: (arm.subscription as SubscriptionRecord | null) ?? null,
        billableSeats: (arm.seats as number | null) ?? 0,
      },
      // to_jsonb of the text column yields a JSON string (or null when no row) — exactly
      // the raw value getOrgSettings hands to the same parser.
      settings: parseOrgSettings(typeof arm.settings === "string" ? arm.settings : null),
      notifications: {
        notifications: notifRows.map(({ unread_total: _, ...n }) => n),
        unread: notifRows[0]?.unread_total ?? 0,
      },
    }
  }
  async tagCounts(orgId?: string): Promise<{ tag: string; count: number }[]> {
    const base = this.db
      .select({ tag: artifactTag.tag, count: count() })
      .from(artifactTag)
      .innerJoin(artifact, eq(artifact.id, artifactTag.artifact_id))
    const rows = await base
      .where(and(orgId ? eq(artifact.org_id, orgId) : undefined, isNull(artifact.archived_at)))
      .groupBy(artifactTag.tag)
      .orderBy(asc(artifactTag.tag))
    return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }))
  }

  // ---- View analytics (raw: aggregation-heavy) ---------------------------
  async recordView(v: NewView): Promise<void> {
    await this.pool.query(
      `INSERT INTO view (id, artifact_id, version, viewer, viewer_kind) VALUES ($1,$2,$3,$4,$5)`,
      [v.id, v.artifact_id, v.version, v.viewer, v.viewer_kind],
    )
    // Activation stamp: first non-author view only (the route already excluded
    // owner self-views). WHERE IS NULL keeps it a one-time write.
    await this.pool.query(
      `UPDATE artifact SET first_foreign_view_at = $1 WHERE id = $2 AND first_foreign_view_at IS NULL`,
      [new Date().toISOString(), v.artifact_id],
    )
  }

  async confirmRead(artifactId: string, viewer: string, viewedBeforeIso: string): Promise<void> {
    // EXISTS rather than a join: the read is anchored to a view row old enough to rule
    // out a one-shot fetch, and ON CONFLICT makes every later heartbeat a cheap no-op.
    await this.pool.query(
      `INSERT INTO view_read (artifact_id, viewer)
       SELECT $1, $2
        WHERE EXISTS (
          SELECT 1 FROM view WHERE artifact_id=$1 AND viewer=$2 AND created_at<=$3
        )
       ON CONFLICT (artifact_id, viewer) DO NOTHING`,
      [artifactId, viewer, viewedBeforeIso],
    )
  }

  async viewedSince(
    artifactId: string,
    viewer: string,
    version: number,
    sinceIso: string,
  ): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM view WHERE artifact_id=$1 AND viewer=$2 AND version=$3 AND created_at>=$4 LIMIT 1`,
      [artifactId, viewer, version, sinceIso],
    )
    return rows.length > 0
  }

  async pruneViews(cutoffIso: string): Promise<number> {
    // Reads ride the same retention: leaving them behind would let `reads` outlive the
    // views it is derived from, and outgrow `unique`.
    await this.pool.query(`DELETE FROM view_read WHERE created_at < $1`, [cutoffIso])
    const res = await this.pool.query(`DELETE FROM view WHERE created_at < $1`, [cutoffIso])
    return res.rowCount ?? 0
  }

  async pruneViewsByViewers(viewers: string[]): Promise<number> {
    if (viewers.length === 0) return 0
    const ph = viewers.map((_, i) => `$${i + 1}`).join(",")
    // Their reads go too, or an owner stays counted as a reader after the self-view
    // rows they came from are gone.
    await this.pool.query(`DELETE FROM view_read WHERE viewer IN (${ph})`, viewers)
    const res = await this.pool.query(
      `DELETE FROM view WHERE viewer_kind='user' AND viewer IN (${ph})`,
      viewers,
    )
    return res.rowCount ?? 0
  }

  async viewStats(artifactId: string): Promise<ViewStats> {
    const cutoff = new Date(Date.now() - VIEW_WINDOW_MS).toISOString()
    const dayAgo = new Date(Date.now() - LAST_24H_MS).toISOString()
    const [tot, day, uni, anon, reads, perV, daily, recent] = await Promise.all([
      this.pool.query(`SELECT count(*)::int n FROM view WHERE artifact_id=$1`, [artifactId]),
      this.pool.query(`SELECT count(*)::int n FROM view WHERE artifact_id=$1 AND created_at>=$2`, [
        artifactId,
        dayAgo,
      ]),
      this.pool.query(`SELECT count(DISTINCT viewer)::int n FROM view WHERE artifact_id=$1`, [
        artifactId,
      ]),
      this.pool.query(
        `SELECT count(DISTINCT viewer)::int n FROM view WHERE artifact_id=$1 AND viewer_kind='anon'`,
        [artifactId],
      ),
      this.pool.query(`SELECT count(*)::int n FROM view_read WHERE artifact_id=$1`, [artifactId]),
      this.pool.query(
        `SELECT version, count(*)::int c FROM view WHERE artifact_id=$1 GROUP BY version ORDER BY version`,
        [artifactId],
      ),
      this.pool.query(
        `SELECT substr(created_at,1,10) AS "day", count(*)::int c FROM view WHERE artifact_id=$1 AND created_at>=$2 GROUP BY 1 ORDER BY 1`,
        [artifactId, cutoff],
      ),
      this.pool.query(
        `SELECT viewer, viewer_kind, max(created_at) "at" FROM view WHERE artifact_id=$1 GROUP BY viewer, viewer_kind ORDER BY 3 DESC LIMIT 8`,
        [artifactId],
      ),
    ])
    return {
      total: tot.rows[0].n,
      last24h: day.rows[0].n,
      unique: uni.rows[0].n,
      anonViewers: anon.rows[0].n,
      reads: reads.rows[0].n,
      perVersion: perV.rows.map((r) => ({ version: r.version, count: r.c })),
      daily: daily.rows.map((r) => ({ day: r.day, count: r.c })),
      recent: recent.rows.map((r) => ({ viewer: r.viewer, kind: r.viewer_kind, at: r.at })),
    }
  }

  async viewCounts(artifactIds: string[]): Promise<Record<string, number>> {
    if (artifactIds.length === 0) return {}
    const ph = artifactIds.map((_, i) => `$${i + 1}`).join(",")
    const { rows } = await this.pool.query(
      `SELECT artifact_id, count(*)::int c FROM view WHERE artifact_id IN (${ph}) GROUP BY artifact_id`,
      artifactIds,
    )
    const out: Record<string, number> = {}
    for (const r of rows) out[r.artifact_id] = r.c
    return out
  }

  // ---- Webhooks + outbox -------------------------------------------------
  async createWebhook(w: NewWebhook): Promise<WebhookRecord> {
    const rows = await this.db.insert(webhook).values(w).returning()
    return one(rows)
  }
  listWebhooks(orgId: string): Promise<WebhookRecord[]> {
    return this.db
      .select()
      .from(webhook)
      .where(eq(webhook.org_id, orgId))
      .orderBy(desc(webhook.created_at))
  }
  async getWebhook(id: string, orgId: string): Promise<WebhookRecord | null> {
    const rows = await this.db
      .select()
      .from(webhook)
      .where(and(eq(webhook.id, id), eq(webhook.org_id, orgId)))
    return rows[0] ?? null
  }
  async deleteWebhook(id: string, orgId: string): Promise<void> {
    await this.db.delete(webhook).where(and(eq(webhook.id, id), eq(webhook.org_id, orgId)))
  }
  activeWebhooks(artifactId: string, orgId: string): Promise<WebhookRecord[]> {
    return this.db
      .select()
      .from(webhook)
      .where(
        and(
          eq(webhook.active, 1),
          eq(webhook.org_id, orgId),
          or(isNull(webhook.artifact_id), eq(webhook.artifact_id, artifactId)),
        ),
      )
  }
  async enqueueDelivery(d: NewDelivery): Promise<void> {
    await this.db.insert(webhookDelivery).values(d)
  }
  async enqueueCoalescedDelivery(d: NewDelivery): Promise<void> {
    await this.db
      .insert(webhookDelivery)
      .values(d)
      .onConflictDoUpdate({
        target: webhookDelivery.id,
        set: { payload: d.payload, event_type: d.event_type },
        setWhere: eq(webhookDelivery.status, "pending"),
      })
  }
  async enqueueDeliveries(rows: NewDelivery[]): Promise<void> {
    if (rows.length === 0) return
    await this.db.insert(webhookDelivery).values(rows)
  }
  claimDueDeliveries(now: string, limit: number, leaseUntil: string): Promise<DeliveryRecord[]> {
    // FOR UPDATE SKIP LOCKED so concurrent instances each grab a disjoint set;
    // the UPDATE then leases the rows (next_attempt_at -> future) + counts an
    // attempt, so no other tick re-selects them until the lease lapses.
    const due = this.db
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(and(eq(webhookDelivery.status, "pending"), lte(webhookDelivery.next_attempt_at, now)))
      .orderBy(asc(webhookDelivery.next_attempt_at))
      .limit(limit)
      .for("update", { skipLocked: true })
    return this.db
      .update(webhookDelivery)
      .set({ attempts: sql`${webhookDelivery.attempts} + 1`, next_attempt_at: leaseUntil })
      .where(inArray(webhookDelivery.id, due))
      .returning()
  }
  async updateDelivery(
    id: string,
    f: {
      status: DeliveryStatus
      attempts: number
      last_error: string | null
      next_attempt_at: string
    },
  ): Promise<void> {
    await this.db.update(webhookDelivery).set(f).where(eq(webhookDelivery.id, id))
  }
  recentDeliveries(webhookId: string, limit: number): Promise<DeliveryRecord[]> {
    return this.db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.webhook_id, webhookId))
      .orderBy(desc(webhookDelivery.created_at))
      .limit(limit)
  }

  // ---- Render-job queue --------------------------------------------------
  async enqueueRenderJob(j: NewRenderJob): Promise<void> {
    await this.db.insert(renderJob).values(j)
  }
  versionsMissingPreview(limit: number): Promise<Array<{ artifact_id: string; n: number }>> {
    return this.db
      .select({ artifact_id: version.artifact_id, n: version.n })
      .from(artifact)
      .innerJoin(
        version,
        and(eq(version.artifact_id, artifact.id), eq(version.n, artifact.current_version)),
      )
      .where(
        and(
          isNull(artifact.removed_at),
          isNull(artifact.archived_at),
          isNull(version.preview_status),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(renderJob)
              .where(and(eq(renderJob.artifact_id, artifact.id), eq(renderJob.status, "pending"))),
          ),
        ),
      )
      .limit(limit)
  }
  claimDueRenderJobs(now: string, limit: number, leaseUntil: string): Promise<RenderJobRecord[]> {
    const due = this.db
      .select({ id: renderJob.id })
      .from(renderJob)
      .where(and(eq(renderJob.status, "pending"), lte(renderJob.next_attempt_at, now)))
      .orderBy(asc(renderJob.next_attempt_at))
      .limit(limit)
      .for("update", { skipLocked: true })
    return this.db
      .update(renderJob)
      .set({ attempts: sql`${renderJob.attempts} + 1`, next_attempt_at: leaseUntil })
      .where(inArray(renderJob.id, due))
      .returning()
  }
  async updateRenderJob(
    id: string,
    fields: {
      status: RenderJobStatus
      attempts: number
      last_error: string | null
      next_attempt_at: string
    },
  ): Promise<void> {
    await this.db.update(renderJob).set(fields).where(eq(renderJob.id, id))
  }

  async enqueueExportJob(j: NewExportJob): Promise<ExportJobRecord> {
    await this.db.insert(exportJob).values(j).onConflictDoNothing({ target: exportJob.input_hash })
    const rows = await this.db
      .select()
      .from(exportJob)
      .where(eq(exportJob.input_hash, j.input_hash))
    return one(rows) as ExportJobRecord
  }
  async getExportJob(id: string): Promise<ExportJobRecord | null> {
    const rows = await this.db.select().from(exportJob).where(eq(exportJob.id, id)).limit(1)
    return (rows[0] as ExportJobRecord | undefined) ?? null
  }
  listExportJobs(
    artifactId: string,
    requestedBy: string,
    limit: number,
  ): Promise<ExportJobRecord[]> {
    return this.db
      .select()
      .from(exportJob)
      .where(and(eq(exportJob.artifact_id, artifactId), eq(exportJob.requested_by, requestedBy)))
      .orderBy(desc(exportJob.created_at))
      .limit(limit) as Promise<ExportJobRecord[]>
  }
  claimDueExportJobs(
    now: string,
    limit: number,
    leaseUntil: string,
    rendererScope: string,
  ): Promise<ExportJobRecord[]> {
    const due = this.db
      .select({ id: exportJob.id })
      .from(exportJob)
      .where(
        and(
          or(
            eq(exportJob.status, "pending"),
            eq(exportJob.status, "rendering"),
            eq(exportJob.status, "failed"),
          ),
          eq(exportJob.renderer_scope, rendererScope),
          lte(exportJob.next_attempt_at, now),
        ),
      )
      .orderBy(asc(exportJob.next_attempt_at))
      .limit(limit)
      .for("update", { skipLocked: true })
    return this.db
      .update(exportJob)
      .set({
        status: "rendering",
        attempts: sql`${exportJob.attempts} + 1`,
        next_attempt_at: leaseUntil,
        updated_at: now,
      })
      .where(inArray(exportJob.id, due))
      .returning() as Promise<ExportJobRecord[]>
  }
  async updateExportJob(
    id: string,
    fields: Parameters<MetaStore["updateExportJob"]>[1],
  ): Promise<void> {
    await this.db.update(exportJob).set(fields).where(eq(exportJob.id, id))
  }

  // ---- Permissions: membership + per-artifact shares ---------------------
  async getMembership(orgId: string, userId: string): Promise<MembershipRecord | null> {
    const rows = await this.db
      .select()
      .from(membership)
      .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
    return rows[0] ?? null
  }
  listMemberships(orgId: string): Promise<MembershipRecord[]> {
    return this.db.select().from(membership).where(eq(membership.org_id, orgId))
  }
  async listMembershipsForOrgs(orgIds: string[]): Promise<MembershipRecord[]> {
    if (orgIds.length === 0) return []
    return this.db.select().from(membership).where(inArray(membership.org_id, orgIds))
  }
  async countMemberships(orgId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(membership)
      .where(eq(membership.org_id, orgId))
    return rows[0]?.n ?? 0
  }
  async setMembership(m: NewMembership): Promise<MembershipRecord> {
    const rows = await this.db
      .insert(membership)
      .values(m)
      .onConflictDoUpdate({
        target: [membership.org_id, membership.user_id],
        set: { role: m.role },
      })
      .returning()
    return one(rows)
  }
  async workspaceOwnershipBlockers(
    orgId: string,
    userId: string,
  ): Promise<{ artifacts: number; collections: number }> {
    const res = await this.db.execute(sql`
      select 'artifacts' as kind, count(*) as n
        from artifact a
        join artifact_member mine
          on mine.artifact_id = a.id
         and mine.user_id = ${userId}
         and mine.role = 'owner'
       where a.org_id = ${orgId}
         and not exists (
           select 1
             from artifact_member other
             join membership active
               on active.org_id = a.org_id
              and active.user_id = other.user_id
            where other.artifact_id = a.id
              and other.user_id <> ${userId}
              and other.role = 'owner'
         )
      union all
      select 'collections', count(*)
        from collection c
       where c.org_id = ${orgId}
         and (
           c.created_by = ${userId}
           or exists (
             select 1 from collection_member mine
              where mine.collection_id = c.id
                and mine.user_id = ${userId}
                and mine.role = 'owner'
           )
         )
         and not exists (
           select 1
             from membership active
            where active.org_id = c.org_id
              and active.user_id <> ${userId}
              and (
                active.user_id = c.created_by
                or exists (
                  select 1 from collection_member other
                   where other.collection_id = c.id
                     and other.user_id = active.user_id
                     and other.role = 'owner'
                )
              )
         )
    `)
    const rows =
      (
        res as unknown as {
          rows?: { kind: "artifacts" | "collections"; n: string | number }[]
        }
      ).rows ?? []
    return {
      artifacts: Number(rows.find((row) => row.kind === "artifacts")?.n ?? 0),
      collections: Number(rows.find((row) => row.kind === "collections")?.n ?? 0),
    }
  }
  async removeMembership(orgId: string, userId: string): Promise<void> {
    await this.db
      .delete(membership)
      .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
    // A removed member's connected plan must stop being billable here — otherwise a lent
    // agent would keep charging their token after they've lost workspace access.
    await this.db
      .delete(modelCredential)
      .where(and(eq(modelCredential.org_id, orgId), eq(modelCredential.user_id, userId)))
  }
  async getWorkspace(orgId: string): Promise<WorkspaceRecord | null> {
    const rows = await this.db.select().from(workspace).where(eq(workspace.id, orgId))
    return rows[0] ?? null
  }
  async setWorkspace(orgId: string, name: string): Promise<WorkspaceRecord> {
    const rows = await this.db
      .insert(workspace)
      .values({ id: orgId, name })
      .onConflictDoUpdate({ target: workspace.id, set: { name } })
      .returning()
    return one(rows)
  }
  async deleteWorkspace(orgId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(templateLibraryEntry)
        .where(
          inArray(
            templateLibraryEntry.library_id,
            tx
              .select({ id: templateLibrary.id })
              .from(templateLibrary)
              .where(eq(templateLibrary.org_id, orgId)),
          ),
        )
      await tx.delete(templateLibrary).where(eq(templateLibrary.org_id, orgId))
    })
    await this.db.delete(membership).where(eq(membership.org_id, orgId))
    // Every connected plan for this org, INCLUDING the workspace-pool sentinel row, so no
    // encrypted token is orphaned (the pool row would otherwise have no API path left to
    // delete once memberships are gone). One predicate covers members and the pool.
    await this.db.delete(modelCredential).where(eq(modelCredential.org_id, orgId))
    await this.db.delete(workspace).where(eq(workspace.id, orgId))
  }
  listWorkspaces(userId: string): Promise<(WorkspaceRecord & { role: Role })[]> {
    return this.db
      .select({
        id: workspace.id,
        name: workspace.name,
        created_at: workspace.created_at,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(workspace, eq(workspace.id, membership.org_id))
      .where(eq(membership.user_id, userId))
      .orderBy(asc(workspace.created_at))
  }

  // listWorkspaces + getOAuthClientWorkspaces in ONE round trip: a LEFT JOIN against
  // oauth_client_workspace tells each row whether it's in the grant's bound set, rather
  // than a second query the caller then filters `mine` against anyway (see
  // oauth-agent.ts's oauthWorkspace, the only caller). `bound` this way is already a
  // subset of `mine` — a workspace the grant names but the user has since left can never
  // appear, matching the two-query version's existing `scoped = mine.filter(...)` step.
  async workspacesAndOauthBinding(
    userId: string,
    clientId: string,
  ): Promise<{ mine: (WorkspaceRecord & { role: Role })[]; bound: string[] }> {
    const rows = await this.db
      .select({
        id: workspace.id,
        name: workspace.name,
        created_at: workspace.created_at,
        role: membership.role,
        boundRowId: oauthClientWorkspace.id,
      })
      .from(membership)
      .innerJoin(workspace, eq(workspace.id, membership.org_id))
      .leftJoin(
        oauthClientWorkspace,
        and(
          eq(oauthClientWorkspace.org_id, workspace.id),
          eq(oauthClientWorkspace.user_id, membership.user_id),
          eq(oauthClientWorkspace.client_id, clientId),
        ),
      )
      .where(eq(membership.user_id, userId))
      .orderBy(asc(workspace.created_at))
    return {
      mine: rows.map(({ boundRowId: _b, ...w }) => w),
      bound: rows.filter((r) => r.boundRowId !== null).map((r) => r.id),
    }
  }

  async getArtifactMember(
    artifactId: string,
    userId: string,
  ): Promise<ArtifactMemberRecord | null> {
    const rows = await this.db
      .select()
      .from(artifactMember)
      .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
    return rows[0] ?? null
  }
  listArtifactMembers(artifactId: string): Promise<ArtifactMemberRecord[]> {
    return this.db.select().from(artifactMember).where(eq(artifactMember.artifact_id, artifactId))
  }
  /**
   * Every grant one user holds over one artifact, in ONE round trip — see MetaStore.
   *
   * A union of the four reads it replaces, tagged by source so the caller can tell an org role
   * from an artifact role. Deliberately a union rather than joins: an artifact can sit in many
   * collections, and joining would multiply the membership row across them, making the result
   * depend on collection layout. Each arm returns its own rows; the caller reduces.
   *
   * The arms mirror, in order, getMembership, getArtifactMember, and the two halves of
   * collectionRolesForArtifact — the explicit collection share, then the workspace-open
   * collection that propagates the viewer's SEAT role. Change either of those and change this.
   */
  async artifactGrants(
    artifactId: string,
    orgId: string,
    userId: string,
  ): Promise<{ orgRole: Role | null; artifactRoles: Role[]; portableArtifactRoles: Role[] }> {
    const res = await this.db.execute(sql`
      select 'org' as kind, m.role as role
        from membership m
       where m.org_id = ${orgId} and m.user_id = ${userId}
      union all
      select case when am.role = 'owner' then 'artifact' else 'portable' end as kind,
             am.role as role
        from artifact_member am
       where am.artifact_id = ${artifactId} and am.user_id = ${userId}
      union all
      select case when cm.role = 'owner' then 'artifact' else 'portable' end as kind,
             cm.role as role
        from collection_member cm
        join collection_item ci on ci.collection_id = cm.collection_id
       where ci.artifact_id = ${artifactId} and cm.user_id = ${userId}
      union all
      select 'artifact' as kind, m2.role as role
        from collection_item ci2
        join collection c on c.id = ci2.collection_id
        join membership m2 on m2.org_id = c.org_id
       where ci2.artifact_id = ${artifactId}
         and c.workspace_access = 'member'
         and m2.user_id = ${userId}
    `)
    const rows = (res as unknown as { rows?: { kind: string; role: Role }[] }).rows ?? []
    let orgRole: Role | null = null
    const artifactRoles: Role[] = []
    const portableArtifactRoles: Role[] = []
    for (const r of rows) {
      if (r.kind === "org") orgRole = r.role
      else {
        artifactRoles.push(r.role)
        if (r.kind === "portable") portableArtifactRoles.push(r.role)
      }
    }
    return { orgRole, artifactRoles, portableArtifactRoles }
  }
  // `getByShortId` + `artifactGrants` as ONE statement — see the port doc. The artifact
  // resolves in a CTE and every grant arm joins to it, so the caller's standing comes back
  // with the record instead of after it. Same four grant sources as artifactGrants above,
  // in the same order, deliberately: the store contract runs both against the read-by-read
  // path and requires all three to agree.
  async artifactWithGrants(
    shortId: string,
    userId: string,
  ): Promise<{
    artifact: ArtifactRecord
    orgRole: Role | null
    artifactRoles: Role[]
    portableArtifactRoles: Role[]
  } | null> {
    const res = await this.db.execute(sql`
      with a as (select * from artifact where short_id = ${shortId})
      select 'artifact' as kind, to_jsonb(a) as doc from a
      union all
      select 'org', to_jsonb(m.role)
        from a join membership m on m.org_id = a.org_id and m.user_id = ${userId}
      union all
      select case when am.role = 'owner' then 'grant' else 'portable' end, to_jsonb(am.role)
        from a join artifact_member am on am.artifact_id = a.id and am.user_id = ${userId}
      union all
      select case when cm.role = 'owner' then 'grant' else 'portable' end, to_jsonb(cm.role)
        from a
        join collection_item ci on ci.artifact_id = a.id
        join collection_member cm on cm.collection_id = ci.collection_id and cm.user_id = ${userId}
      union all
      select 'grant', to_jsonb(m2.role)
        from a
        join collection_item ci2 on ci2.artifact_id = a.id
        join collection c on c.id = ci2.collection_id and c.workspace_access = 'member'
        join membership m2 on m2.org_id = c.org_id and m2.user_id = ${userId}
    `)
    const rows = (res as unknown as { rows?: { kind: string; doc: unknown }[] }).rows ?? []
    let record: ArtifactRecord | null = null
    let orgRole: Role | null = null
    const artifactRoles: Role[] = []
    const portableArtifactRoles: Role[] = []
    for (const r of rows) {
      if (r.kind === "artifact") record = r.doc as ArtifactRecord
      else if (r.kind === "org") orgRole = r.doc as Role
      else {
        artifactRoles.push(r.doc as Role)
        if (r.kind === "portable") portableArtifactRoles.push(r.doc as Role)
      }
    }
    // No artifact row means no such short id — and then no grant arm could have matched
    // either, since every one of them joins through it.
    return record ? { artifact: record, orgRole, artifactRoles, portableArtifactRoles } : null
  }
  async artifactsWithGrants(
    shortIds: string[],
    userId: string,
  ): Promise<
    Array<{
      artifact: ArtifactRecord
      orgRole: Role | null
      artifactRoles: Role[]
      portableArtifactRoles: Role[]
    }>
  > {
    if (shortIds.length === 0) return []
    const ids = [...new Set(shortIds)]
    const res = await this.db.execute(sql`
      select to_jsonb(a) as artifact,
             (select m.role from membership m
               where m.org_id = a.org_id and m.user_id = ${userId}) as org_role,
             array(
               select am.role::text from artifact_member am
                where am.artifact_id = a.id and am.user_id = ${userId}
               union all
               select cm.role::text
                 from collection_item ci
                 join collection_member cm on cm.collection_id = ci.collection_id
                where ci.artifact_id = a.id and cm.user_id = ${userId}
               union all
               select m2.role::text
                 from collection_item ci2
                 join collection c on c.id = ci2.collection_id and c.workspace_access = 'member'
                 join membership m2 on m2.org_id = c.org_id
                where ci2.artifact_id = a.id and m2.user_id = ${userId}
             ) as artifact_roles,
             array(
               select am.role::text from artifact_member am
                where am.artifact_id = a.id and am.user_id = ${userId} and am.role <> 'owner'
               union all
               select cm.role::text
                 from collection_item ci
                 join collection_member cm on cm.collection_id = ci.collection_id
                where ci.artifact_id = a.id and cm.user_id = ${userId} and cm.role <> 'owner'
             ) as portable_artifact_roles
        from artifact a
       where a.short_id in (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})
    `)
    const rows =
      (
        res as unknown as {
          rows?: Array<{
            artifact: ArtifactRecord
            org_role: Role | null
            artifact_roles: Role[]
            portable_artifact_roles: Role[]
          }>
        }
      ).rows ?? []
    const byShortId = new Map(rows.map((row) => [row.artifact.short_id, row]))
    return ids.flatMap((shortId) => {
      const row = byShortId.get(shortId)
      return row
        ? [
            {
              artifact: row.artifact,
              orgRole: row.org_role,
              artifactRoles: row.artifact_roles,
              portableArtifactRoles: row.portable_artifact_roles,
            },
          ]
        : []
    })
  }
  async artifactRolesFor(userId: string, artifactIds: string[]): Promise<Record<string, Role>> {
    if (artifactIds.length === 0) return {}
    const rows = await this.db
      .select({ artifact_id: artifactMember.artifact_id, role: artifactMember.role })
      .from(artifactMember)
      .where(
        and(eq(artifactMember.user_id, userId), inArray(artifactMember.artifact_id, artifactIds)),
      )
    return Object.fromEntries(rows.map((r) => [r.artifact_id, r.role]))
  }
  // Artifacts explicitly shared with a user at a portable collaborator role — can
  // span workspaces and drive the home's "Shared with you" section. Owner rows are
  // workspace-bound ownership, not shares. The author check additionally protects
  // historical creator rows (see repos.ts).
  async artifactIdsSharedWith(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifactMember.artifact_id })
      .from(artifactMember)
      .innerJoin(artifact, eq(artifact.id, artifactMember.artifact_id))
      .where(
        and(
          eq(artifactMember.user_id, userId),
          ne(artifactMember.role, "owner"),
          or(isNull(artifact.author_id), ne(artifact.author_id, userId)),
        ),
      )
    return rows.map((r) => r.id)
  }
  async setArtifactMember(m: NewArtifactMember): Promise<ArtifactMemberRecord> {
    const rows = await this.db
      .insert(artifactMember)
      .values(m)
      .onConflictDoUpdate({
        target: [artifactMember.artifact_id, artifactMember.user_id],
        set: { role: m.role },
      })
      .returning()
    return one(rows)
  }
  async removeArtifactMember(artifactId: string, userId: string): Promise<void> {
    await this.db
      .delete(artifactMember)
      .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
  }

  // ---- Favorites + tags --------------------------------------------------
  async listUserFavoriteIds(userId: string, orgId?: string): Promise<string[]> {
    // With orgId, join to the artifact so the count reflects only live artifacts in
    // that workspace (a favorite of a removed or other-workspace artifact is dropped).
    if (orgId !== undefined) {
      const rows = await this.db
        .select({ id: artifactFavorite.artifact_id })
        .from(artifactFavorite)
        .innerJoin(artifact, eq(artifact.id, artifactFavorite.artifact_id))
        .where(
          and(
            eq(artifactFavorite.user_id, userId),
            eq(artifact.org_id, orgId),
            isNull(artifact.removed_at),
            isNull(artifact.archived_at),
          ),
        )
      return rows.map((r) => r.id)
    }
    const rows = await this.db
      .select({ id: artifactFavorite.artifact_id })
      .from(artifactFavorite)
      .where(eq(artifactFavorite.user_id, userId))
    return rows.map((r) => r.id)
  }
  async setFavorite(artifactId: string, userId: string): Promise<void> {
    await this.db
      .insert(artifactFavorite)
      .values({ id: crypto.randomUUID(), artifact_id: artifactId, user_id: userId })
      .onConflictDoNothing({ target: [artifactFavorite.artifact_id, artifactFavorite.user_id] })
  }
  async removeFavorite(artifactId: string, userId: string): Promise<void> {
    await this.db
      .delete(artifactFavorite)
      .where(
        and(eq(artifactFavorite.artifact_id, artifactId), eq(artifactFavorite.user_id, userId)),
      )
  }

  // Starred collections. Org-scoped like the artifact twin, so a star does not leak
  // across a workspace switch.
  async listUserFavoriteCollectionIds(userId: string, orgId?: string): Promise<string[]> {
    if (orgId !== undefined) {
      const rows = await this.db
        .select({ id: collectionFavorite.collection_id })
        .from(collectionFavorite)
        .innerJoin(collection, eq(collection.id, collectionFavorite.collection_id))
        .where(and(eq(collectionFavorite.user_id, userId), eq(collection.org_id, orgId)))
      return rows.map((r) => r.id)
    }
    const rows = await this.db
      .select({ id: collectionFavorite.collection_id })
      .from(collectionFavorite)
      .where(eq(collectionFavorite.user_id, userId))
    return rows.map((r) => r.id)
  }
  async setCollectionFavorite(collectionId: string, userId: string): Promise<void> {
    await this.db
      .insert(collectionFavorite)
      .values({ id: crypto.randomUUID(), collection_id: collectionId, user_id: userId })
      .onConflictDoNothing({
        target: [collectionFavorite.collection_id, collectionFavorite.user_id],
      })
  }
  async removeCollectionFavorite(collectionId: string, userId: string): Promise<void> {
    await this.db
      .delete(collectionFavorite)
      .where(
        and(
          eq(collectionFavorite.collection_id, collectionId),
          eq(collectionFavorite.user_id, userId),
        ),
      )
  }
  // Same four indexed reads as the D1 twin — see repos.ts for why this is not one join.
  async collectionsWorkedIn(
    userId: string,
    orgId: string,
    sinceIso: string,
  ): Promise<{ id: string; at: string }[]> {
    // One statement: the viewer's touches (versions, comments) folded through the
    // collections that hold those artifacts, plus being-added-by-someone-else, each
    // carrying its timestamp — max per collection. Same signals as the repos twin.
    const { rows } = await this.pool.query<{ id: string; at: string }>(
      `SELECT id, max(at) at FROM (
         SELECT ci.collection_id id, t.at FROM (
           SELECT artifact_id, created_at at FROM "version"
            WHERE author_id = $2 AND created_at >= $3
           UNION ALL
           SELECT artifact_id, created_at FROM "comment"
            WHERE author_id = $2 AND created_at >= $3
         ) t
         JOIN collection_item ci ON ci.artifact_id = t.artifact_id
         JOIN collection c ON c.id = ci.collection_id AND c.org_id = $1
         UNION ALL
         SELECT cm.collection_id, cm.created_at FROM collection_member cm
           JOIN collection c ON c.id = cm.collection_id
          WHERE cm.user_id = $2 AND cm.created_at >= $3
            AND c.org_id = $1 AND c.created_by <> $2
       ) w GROUP BY id`,
      [orgId, userId, sinceIso],
    )
    return rows
  }
  // See the repos.ts twin: one read, sliced per collection in JS rather than a
  // per-collection LIMIT.
  async collectionPreviews(
    collectionIds: string[],
    perCollection: number,
  ): Promise<Record<string, CollectionPreview[]>> {
    const out: Record<string, CollectionPreview[]> = {}
    if (collectionIds.length === 0) return out
    const rows = await this.db
      .select({
        collection_id: collectionItem.collection_id,
        id: artifact.id,
        short_id: artifact.short_id,
        title: artifact.title,
        current_version: artifact.current_version,
        updated_at: artifact.updated_at,
        created_at: artifact.created_at,
        preview_status: version.preview_status,
        author_id: artifact.author_id,
        author_name: artifact.author_name,
        author_login: artifact.author_login,
        author_avatar: artifact.author_avatar,
      })
      .from(collectionItem)
      .innerJoin(artifact, eq(artifact.id, collectionItem.artifact_id))
      // Left join: an artifact whose current version is still rendering has no ready row
      // and must fall back to the live iframe rather than a broken <img>.
      .leftJoin(
        version,
        and(eq(version.artifact_id, artifact.id), eq(version.n, artifact.current_version)),
      )
      .where(
        and(
          inArray(collectionItem.collection_id, collectionIds),
          isNull(artifact.removed_at),
          isNull(artifact.archived_at),
        ),
      )
    // Newest first, tie-broken on id: two artifacts published in the same millisecond
    // would otherwise land in whatever order the driver returned them, and a strip that
    // reshuffles between page loads reads as churn.
    const at = (r: { updated_at: string | null; created_at: string }) =>
      r.updated_at ?? r.created_at
    rows.sort((a, b) => at(b).localeCompare(at(a)) || b.id.localeCompare(a.id))
    for (const r of rows) {
      const bucket = out[r.collection_id] ?? []
      out[r.collection_id] = bucket
      if (bucket.length < perCollection)
        bucket.push({
          id: r.id,
          short_id: r.short_id,
          title: r.title,
          current_version: r.current_version,
          updated_at: r.updated_at ?? r.created_at,
          has_preview: r.preview_status === "ready",
          author_id: r.author_id,
          author_name: r.author_name,
          author_login: r.author_login,
          author_avatar: r.author_avatar,
        })
    }
    return out
  }

  // ---- Follows (track GitHub authors + repo path prefixes) ---------------
  // Mirrors the sqlite path: insert-or-ignore on the unique key, then read back.
  async addFollow(f: NewFollow): Promise<FollowRecord> {
    await this.db
      .insert(follow)
      .values(f)
      .onConflictDoNothing({
        target: [follow.user_id, follow.org_id, follow.kind, follow.target],
      })
    const rows = await this.db
      .select()
      .from(follow)
      .where(
        and(
          eq(follow.user_id, f.user_id),
          eq(follow.org_id, f.org_id),
          eq(follow.kind, f.kind),
          eq(follow.target, f.target),
        ),
      )
    return one(rows)
  }
  async removeFollow(
    userId: string,
    orgId: string,
    kind: FollowKind,
    target: string,
  ): Promise<void> {
    await this.db
      .delete(follow)
      .where(
        and(
          eq(follow.user_id, userId),
          eq(follow.org_id, orgId),
          eq(follow.kind, kind),
          eq(follow.target, target),
        ),
      )
  }
  // A user's global people follows.
  listFollows(userId: string, _orgId: string): Promise<FollowRecord[]> {
    return this.db
      .select()
      .from(follow)
      .where(and(eq(follow.user_id, userId), eq(follow.org_id, GLOBAL_FOLLOW_ORG)))
      .orderBy(desc(follow.created_at), desc(follow.id))
  }
  // GitHub numeric ids a set of Derive users linked (raw account read; [] if absent).
  private async githubIdsForUsers(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return []
    try {
      const ph = userIds.map((_, i) => `$${i + 1}`).join(",")
      const { rows } = await this.pool.query(
        `SELECT a."accountId" gh_id FROM "account" a
         WHERE a."providerId" = 'github' AND a."userId" IN (${ph})`,
        userIds,
      )
      return (rows as { gh_id: string }[]).map((r) => r.gh_id).filter(Boolean)
    } catch {
      return []
    }
  }
  // The "following" feed id set: public work authored by followed people.
  async followedArtifactIds(userId: string, orgId: string): Promise<string[]> {
    const people = (await this.listFollows(userId, orgId)).map((f) => f.target)
    if (people.length === 0) return []
    const rows = await this.db
      .select({ id: artifact.id })
      .from(artifact)
      .where(
        and(
          isNull(artifact.removed_at),
          isNull(artifact.archived_at),
          eq(artifact.listed, "public"),
          inArray(artifact.author_id, people),
        ),
      )
    return rows.map((r) => r.id)
  }
  // ---- People profiles: works, shared workspaces, follower/following -----
  githubIdsForUser(userId: string): Promise<string[]> {
    return this.githubIdsForUsers([userId])
  }
  async githubLoginForUser(_userId: string, ghIds: string[]): Promise<string | null> {
    if (ghIds.length === 0) return null
    const rows = await this.db
      .select({ login: artifact.author_login })
      .from(artifact)
      .where(and(inArray(artifact.author_gh_id, ghIds), isNotNull(artifact.author_login)))
      .limit(1)
    return rows[0]?.login ?? null
  }
  async sharedOrgIds(viewerId: string, targetUserId: string): Promise<string[]> {
    const rows = await this.db
      .select({ org: membership.org_id })
      .from(membership)
      .where(
        and(
          eq(membership.user_id, viewerId),
          inArray(
            membership.org_id,
            this.db
              .select({ o: membership.org_id })
              .from(membership)
              .where(eq(membership.user_id, targetUserId)),
          ),
        ),
      )
    return rows.map((r) => r.org)
  }
  private userWorksConds(userId: string, ghIds: string[], opts: ListArtifactsOpts) {
    const conds = [...artifactListConditions(artifact, opts), isNull(artifact.removed_at)]
    if (ghIds.length > 0) {
      const m = or(
        eq(artifact.author_id, userId),
        inArray(
          sql`lower(${artifact.author_gh_id})`,
          ghIds.map((g) => g.toLowerCase()),
        ),
      )
      if (m) conds.push(m)
    } else {
      conds.push(eq(artifact.author_id, userId))
    }
    // Private work never rides a profile, shared workspace or not (see repos.ts).
    const orgs = opts.visibleOrgIds ?? []
    if (orgs.length > 0) {
      const v = or(
        eq(artifact.listed, "public"),
        and(inArray(artifact.org_id, orgs), ne(artifact.listed, "none")),
      )
      if (v) conds.push(v)
    } else {
      conds.push(eq(artifact.listed, "public"))
    }
    return conds
  }
  async listUserWorks(
    userId: string,
    ghIds: string[],
    opts: ListArtifactsOpts,
  ): Promise<ArtifactRecord[]> {
    const q = this.db
      .select()
      .from(artifact)
      .where(and(...this.userWorksConds(userId, ghIds, opts)))
      .orderBy(desc(artifact.created_at), desc(artifact.id))
    return opts.limit ? q.limit(opts.limit) : q
  }
  async countUserWorks(userId: string, ghIds: string[], opts: ListArtifactsOpts): Promise<number> {
    const rows = await this.db
      .select({ c: count() })
      .from(artifact)
      .where(
        and(
          ...this.userWorksConds(userId, ghIds, { ...opts, cursor: undefined, limit: undefined }),
        ),
      )
    return rows[0]?.c ?? 0
  }
  async countFollowers(userId: string): Promise<number> {
    const rows = await this.db
      .select({ c: count() })
      .from(follow)
      .where(and(eq(follow.kind, "user"), eq(follow.target, userId)))
    return rows[0]?.c ?? 0
  }
  async countFollowing(userId: string): Promise<number> {
    const rows = await this.db
      .select({ c: count() })
      .from(follow)
      .where(and(eq(follow.kind, "user"), eq(follow.user_id, userId)))
    return rows[0]?.c ?? 0
  }
  private async profilesForFollow(
    column: "user_id" | "target",
    userId: string,
    limit: number,
  ): Promise<UserProfile[]> {
    try {
      const join = column === "target" ? `u.id = f.target` : `u.id = f.user_id`
      const pick = column === "target" ? `f.user_id = $1` : `f.target = $1`
      const { rows } = await this.pool.query(
        `SELECT u.id, u.name, u.image, u.username, u.profession, u.about
         FROM follow f JOIN "user" u ON ${join}
         WHERE f.kind = 'user' AND ${pick} AND u.username IS NOT NULL
         ORDER BY f.created_at DESC, f.id DESC LIMIT $2`,
        [userId, limit],
      )
      return rows as UserProfile[]
    } catch {
      return []
    }
  }
  listFollowing(userId: string, limit: number): Promise<UserProfile[]> {
    return this.profilesForFollow("target", userId, limit)
  }
  listFollowers(userId: string, limit: number): Promise<UserProfile[]> {
    return this.profilesForFollow("user_id", userId, limit)
  }
  async tagsForArtifacts(artifactIds: string[]): Promise<Record<string, string[]>> {
    if (artifactIds.length === 0) return {}
    const rows = await this.db
      .select({ artifact_id: artifactTag.artifact_id, tag: artifactTag.tag })
      .from(artifactTag)
      .where(inArray(artifactTag.artifact_id, artifactIds))
    const out: Record<string, string[]> = {}
    for (const r of rows) {
      out[r.artifact_id] ??= []
      out[r.artifact_id]?.push(r.tag)
    }
    for (const k in out) out[k]?.sort()
    return out
  }

  async collectionsForArtifacts(artifactIds: string[]): Promise<Record<string, string[]>> {
    if (artifactIds.length === 0) return {}
    const rows = await this.db
      .select({ a: collectionItem.artifact_id, c: collectionItem.collection_id })
      .from(collectionItem)
      .where(inArray(collectionItem.artifact_id, artifactIds))
    const out: Record<string, string[]> = {}
    for (const r of rows) {
      const list = out[r.a] ?? []
      out[r.a] = list
      list.push(r.c)
    }
    return out
  }
  async previewReady(artifactIds: string[]): Promise<Record<string, boolean>> {
    if (artifactIds.length === 0) return {}
    const ph = artifactIds.map((_, i) => `$${i + 1}`).join(",")
    const { rows } = await this.pool.query(
      `SELECT a.id artifact_id FROM artifact a
       JOIN version v ON v.artifact_id = a.id AND v.n = a.current_version
       WHERE v.preview_status = 'ready' AND a.id IN (${ph})`,
      artifactIds,
    )
    const out: Record<string, boolean> = {}
    for (const r of rows) out[r.artifact_id] = true
    return out
  }
  async setArtifactTags(artifactId: string, tags: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(artifactTag).where(eq(artifactTag.artifact_id, artifactId))
      if (tags.length)
        await tx
          .insert(artifactTag)
          .values(tags.map((tag) => ({ id: crypto.randomUUID(), artifact_id: artifactId, tag })))
    })
  }

  // ---- Collections -------------------------------------------------------
  async createCollection(c: NewCollection): Promise<CollectionRecord> {
    const rows = await this.db.insert(collection).values(c).returning()
    return one(rows)
  }
  async getCollection(id: string): Promise<CollectionRecord | null> {
    const rows = await this.db.select().from(collection).where(eq(collection.id, id))
    return rows[0] ?? null
  }
  async getCollections(ids: string[]): Promise<CollectionRecord[]> {
    if (ids.length === 0) return []
    return this.db.select().from(collection).where(inArray(collection.id, ids))
  }
  async updateCollection(id: string, fields: { title?: string }): Promise<CollectionRecord | null> {
    if (fields.title === undefined) return this.getCollection(id)
    const rows = await this.db
      .update(collection)
      .set({ title: fields.title })
      .where(eq(collection.id, id))
      .returning()
    return rows[0] ?? null
  }
  async setCollectionAccess(
    id: string,
    workspaceAccess: WorkspaceAccess,
    linkRole?: LinkRole,
    passwordHash?: string | null,
  ): Promise<void> {
    await this.db
      .update(collection)
      .set({
        workspace_access: workspaceAccess,
        ...(linkRole !== undefined ? { link_role: linkRole } : {}),
        ...(passwordHash !== undefined ? { password_hash: passwordHash } : {}),
      })
      .where(eq(collection.id, id))
  }
  async deleteCollection(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(collectionInvite).where(eq(collectionInvite.collection_id, id))
      await tx.delete(collectionItem).where(eq(collectionItem.collection_id, id))
      await tx.delete(collectionMember).where(eq(collectionMember.collection_id, id))
      await tx.delete(folder).where(eq(folder.collection_id, id))
      await tx.delete(collection).where(eq(collection.id, id))
    })
  }
  async listCollections(orgId?: string): Promise<(CollectionRecord & { count: number })[]> {
    const base = this.db.select().from(collection)
    const rows = await (orgId ? base.where(eq(collection.org_id, orgId)) : base).orderBy(
      desc(collection.created_at),
    )
    // Count LIVE artifacts, matching COLLECTIONS_OVERVIEW_SQL and the repos twin — a
    // tombstoned artifact keeps its item row but is not something opening the shelf
    // shows. This copy shipped uncorrected once: the contract test only caught it on
    // CI's Postgres job, because SQLite answers this method from the shared repos code.
    const counts = await this.db
      .select({ id: collectionItem.collection_id, c: count() })
      .from(collectionItem)
      .innerJoin(artifact, eq(artifact.id, collectionItem.artifact_id))
      .where(and(isNull(artifact.removed_at), isNull(artifact.archived_at)))
      .groupBy(collectionItem.collection_id)
    const cmap = new Map(counts.map((r) => [r.id, Number(r.c)]))
    return rows.map((r) => ({ ...r, count: cmap.get(r.id) ?? 0 }))
  }
  async collectionsOverview(
    orgId: string,
    viewer?: CollectionsViewer,
  ): Promise<CollectionsOverviewRead> {
    // Viewer decoration joins the same union rather than adding separate round trips.
    // Statement text shared with bootstrap() — see WORKSPACE_SUMMARY_SQL's note.
    const params = viewer ? [orgId, viewer.userId, viewer.activeSince, viewer.previewPer] : [orgId]
    const run = (bylines: boolean) =>
      this.pool.query<OverviewRow>(
        viewer
          ? collectionsOverviewSql({ user: "$2", since: "$3", per: "$4" }, bylines)
          : COLLECTIONS_OVERVIEW_SQL,
        params,
      )
    let rows: OverviewRow[]
    try {
      rows = (await run(true)).rows
    } catch (e) {
      // The byline arm joins the Better Auth "user" table, absent on some self-hosts.
      // A failure WITHOUT the arm has a real problem and still throws.
      if (!viewer) throw e
      rows = (await run(false)).rows
    }
    return mapOverviewRows(rows)
  }
  // ---- Folders (organize a collection's artifacts) -----------------------
  async createFolder(f: NewFolder): Promise<FolderRecord> {
    const rows = await this.db.insert(folder).values(f).returning()
    return one(rows)
  }
  async listFolders(collectionId: string): Promise<FolderRecord[]> {
    return this.db.select().from(folder).where(eq(folder.collection_id, collectionId))
  }
  async getFolder(id: string): Promise<FolderRecord | null> {
    const rows = await this.db.select().from(folder).where(eq(folder.id, id))
    return rows[0] ?? null
  }
  async updateFolder(id: string, fields: { name?: string }): Promise<FolderRecord | null> {
    if (fields.name === undefined) return this.getFolder(id)
    const rows = await this.db
      .update(folder)
      .set({ name: fields.name })
      .where(eq(folder.id, id))
      .returning()
    return rows[0] ?? null
  }
  async deleteFolder(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(collectionItem)
        .set({ folder_id: null })
        .where(eq(collectionItem.folder_id, id))
      await tx.delete(folder).where(eq(folder.id, id))
    })
  }
  async setItemFolder(
    collectionId: string,
    artifactId: string,
    folderId: string | null,
  ): Promise<void> {
    await this.db
      .update(collectionItem)
      .set({ folder_id: folderId })
      .where(
        and(
          eq(collectionItem.collection_id, collectionId),
          eq(collectionItem.artifact_id, artifactId),
        ),
      )
  }
  async collectionItemFolders(collectionId: string): Promise<Record<string, string>> {
    const rows = await this.db
      .select({ s: artifact.short_id, f: collectionItem.folder_id })
      .from(collectionItem)
      .innerJoin(artifact, eq(artifact.id, collectionItem.artifact_id))
      .where(
        and(eq(collectionItem.collection_id, collectionId), isNotNull(collectionItem.folder_id)),
      )
    const map: Record<string, string> = {}
    for (const r of rows) if (r.f) map[r.s] = r.f
    return map
  }

  async collectionArtifactIds(collectionId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: collectionItem.artifact_id })
      .from(collectionItem)
      .where(eq(collectionItem.collection_id, collectionId))
    return rows.map((r) => r.id)
  }
  async collectionIdsForArtifact(artifactId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: collectionItem.collection_id })
      .from(collectionItem)
      .where(eq(collectionItem.artifact_id, artifactId))
    return rows.map((r) => r.id)
  }
  async collectionsForArtifact(artifactId: string): Promise<CollectionRecord[]> {
    const rows = await this.db
      .select({ collection })
      .from(collectionItem)
      .innerJoin(collection, eq(collection.id, collectionItem.collection_id))
      .where(eq(collectionItem.artifact_id, artifactId))
    return rows.map((r) => r.collection)
  }
  async addCollectionItem(collectionId: string, artifactId: string): Promise<void> {
    await this.db
      .insert(collectionItem)
      .values({ id: crypto.randomUUID(), collection_id: collectionId, artifact_id: artifactId })
      .onConflictDoNothing({ target: [collectionItem.collection_id, collectionItem.artifact_id] })
  }
  async removeCollectionItem(collectionId: string, artifactId: string): Promise<void> {
    await this.db
      .delete(collectionItem)
      .where(
        and(
          eq(collectionItem.collection_id, collectionId),
          eq(collectionItem.artifact_id, artifactId),
        ),
      )
  }
  async getCollectionMember(
    collectionId: string,
    userId: string,
  ): Promise<CollectionMemberRecord | null> {
    const rows = await this.db
      .select()
      .from(collectionMember)
      .where(
        and(eq(collectionMember.collection_id, collectionId), eq(collectionMember.user_id, userId)),
      )
    return rows[0] ?? null
  }
  listCollectionMembers(collectionId: string): Promise<CollectionMemberRecord[]> {
    return this.db
      .select()
      .from(collectionMember)
      .where(eq(collectionMember.collection_id, collectionId))
  }
  async collectionMemberCounts(collectionIds: string[]): Promise<Record<string, number>> {
    if (collectionIds.length === 0) return {}
    const rows = await this.db
      .select({ id: collectionMember.collection_id, c: count() })
      .from(collectionMember)
      .where(inArray(collectionMember.collection_id, collectionIds))
      .groupBy(collectionMember.collection_id)
    return Object.fromEntries(rows.map((r) => [r.id, Number(r.c)]))
  }
  async setCollectionMember(m: NewCollectionMember): Promise<CollectionMemberRecord> {
    const rows = await this.db
      .insert(collectionMember)
      .values(m)
      .onConflictDoUpdate({
        target: [collectionMember.collection_id, collectionMember.user_id],
        set: { role: m.role },
      })
      .returning()
    return one(rows)
  }
  async removeCollectionMember(collectionId: string, userId: string): Promise<void> {
    await this.db
      .delete(collectionMember)
      .where(
        and(eq(collectionMember.collection_id, collectionId), eq(collectionMember.user_id, userId)),
      )
  }
  async collectionRolesForArtifact(
    artifactId: string,
    userId: string,
    opts?: { includeWorkspaceSeats?: boolean },
  ): Promise<Role[]> {
    // Explicit collectionMember rows on any collection holding this artifact.
    const explicit = await this.db
      .select({ role: collectionMember.role })
      .from(collectionMember)
      .innerJoin(collectionItem, eq(collectionItem.collection_id, collectionMember.collection_id))
      .where(and(eq(collectionItem.artifact_id, artifactId), eq(collectionMember.user_id, userId)))
    // A workspace-open collection propagates the viewer's SEAT role to every artifact
    // inside it — "Everyone in the workspace opens this at their role" (the Share
    // dialog's promise; see access-model.md). Join the artifact's collections to the
    // viewer's membership in each collection's org, keeping only workspace-open ones.
    const seat =
      opts?.includeWorkspaceSeats === false
        ? []
        : await this.db
            .select({ role: membership.role })
            .from(collectionItem)
            .innerJoin(collection, eq(collection.id, collectionItem.collection_id))
            .innerJoin(membership, eq(membership.org_id, collection.org_id))
            .where(
              and(
                eq(collectionItem.artifact_id, artifactId),
                eq(collection.workspace_access, "member"),
                eq(membership.user_id, userId),
              ),
            )
    return [...explicit, ...seat].map((r) => r.role)
  }
  async collectionRolesForUser(
    collectionIds: string[],
    userId: string,
    opts?: { includeWorkspaceSeats?: boolean },
  ): Promise<Record<string, Role>> {
    if (collectionIds.length === 0) return {}
    // Same two sources as collectionRolesForArtifact, keyed per collection: the user's
    // explicit member rows, and their SEAT on each workspace-open collection — a UNION ALL
    // instead of two sequential awaits, since both are scoped to the same collectionIds.
    const rows =
      opts?.includeWorkspaceSeats === false
        ? await this.db
            .select({ id: collectionMember.collection_id, role: collectionMember.role })
            .from(collectionMember)
            .where(
              and(
                inArray(collectionMember.collection_id, collectionIds),
                eq(collectionMember.user_id, userId),
              ),
            )
        : (
            await this.pool.query<{ id: string; role: Role }>(
              collectionRolesSql("SELECT unnest($1::text[])", "$2"),
              [collectionIds, userId],
            )
          ).rows
    const out: Record<string, Role> = {}
    for (const r of rows) out[r.id] = maxRole(out[r.id] ?? null, r.role) as Role
    return out
  }

  // ---- Template libraries ------------------------------------------------
  async createTemplateLibrary(x: NewTemplateLibrary): Promise<TemplateLibraryRecord> {
    const rows = await this.db.insert(templateLibrary).values(x).returning()
    return one(rows)
  }
  async getTemplateLibrary(id: string): Promise<TemplateLibraryRecord | null> {
    const rows = await this.db.select().from(templateLibrary).where(eq(templateLibrary.id, id))
    return rows[0] ?? null
  }
  async listTemplateLibraries(opts?: {
    orgId?: string
    scope?: TemplateLibraryScope
    createdBy?: string
    query?: string
    before?: { createdAt: string; id: string }
    limit?: number
  }): Promise<TemplateLibraryRecord[]> {
    const needle = opts?.query?.trim().toLowerCase()
    return this.db
      .select()
      .from(templateLibrary)
      .where(
        and(
          opts?.orgId ? eq(templateLibrary.org_id, opts.orgId) : undefined,
          opts?.scope ? eq(templateLibrary.scope, opts.scope) : undefined,
          opts?.createdBy ? eq(templateLibrary.created_by, opts.createdBy) : undefined,
          needle
            ? sql`lower(${templateLibrary.title} || ' ' || ${templateLibrary.description}) like ${`%${needle}%`}`
            : undefined,
          opts?.before
            ? or(
                lt(templateLibrary.created_at, opts.before.createdAt),
                and(
                  eq(templateLibrary.created_at, opts.before.createdAt),
                  lt(templateLibrary.id, opts.before.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(templateLibrary.created_at), desc(templateLibrary.id))
      .limit(Math.min(Math.max(opts?.limit ?? 1_000, 1), 1_000))
  }
  async updateTemplateLibrary(
    id: string,
    fields: { title?: string; description?: string; scope?: TemplateLibraryScope },
  ): Promise<TemplateLibraryRecord | null> {
    if (Object.keys(fields).length === 0) return this.getTemplateLibrary(id)
    const rows = await this.db
      .update(templateLibrary)
      .set({ ...fields, updated_at: new Date().toISOString() })
      .where(eq(templateLibrary.id, id))
      .returning()
    return rows[0] ?? null
  }
  async acquireTemplateLibraryMutation(
    id: string,
    token: string,
    staleBefore: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(templateLibrary)
      .set({ mutation_token: token, mutation_started_at: new Date().toISOString() })
      .where(
        and(
          eq(templateLibrary.id, id),
          or(
            isNull(templateLibrary.mutation_token),
            lt(templateLibrary.mutation_started_at, staleBefore),
          ),
        ),
      )
      .returning({ id: templateLibrary.id })
    return rows.length > 0
  }
  async renewTemplateLibraryMutation(id: string, token: string): Promise<boolean> {
    const rows = await this.db
      .update(templateLibrary)
      .set({ mutation_started_at: new Date().toISOString() })
      .where(and(eq(templateLibrary.id, id), eq(templateLibrary.mutation_token, token)))
      .returning({ id: templateLibrary.id })
    return rows.length > 0
  }
  async releaseTemplateLibraryMutation(id: string, token: string): Promise<void> {
    await this.db
      .update(templateLibrary)
      .set({ mutation_token: null, mutation_started_at: null })
      .where(and(eq(templateLibrary.id, id), eq(templateLibrary.mutation_token, token)))
  }
  async deleteTemplateLibrary(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(templateLibraryEntry).where(eq(templateLibraryEntry.library_id, id))
      await tx.delete(templateLibrary).where(eq(templateLibrary.id, id))
    })
  }
  async createTemplateLibraryEntry(
    x: NewTemplateLibraryEntry,
  ): Promise<TemplateLibraryEntryRecord> {
    const rows = await this.db.insert(templateLibraryEntry).values(x).returning()
    return one(rows)
  }
  async getTemplateLibraryEntry(id: string): Promise<TemplateLibraryEntryRecord | null> {
    const rows = await this.db
      .select()
      .from(templateLibraryEntry)
      .where(eq(templateLibraryEntry.id, id))
    return rows[0] ?? null
  }
  listTemplateLibraryEntries(libraryId: string): Promise<TemplateLibraryEntryRecord[]> {
    return this.db
      .select()
      .from(templateLibraryEntry)
      .where(eq(templateLibraryEntry.library_id, libraryId))
      .orderBy(desc(templateLibraryEntry.created_at))
  }
  async searchTemplateLibraryEntries(opts: {
    orgId: string
    ownerId: string | null
    query?: string
    limit: number
  }): Promise<Array<{ library: TemplateLibraryRecord; entry: TemplateLibraryEntryRecord }>> {
    const needle = opts.query?.trim().toLowerCase()
    return this.db
      .select({ library: templateLibrary, entry: templateLibraryEntry })
      .from(templateLibraryEntry)
      .innerJoin(templateLibrary, eq(templateLibrary.id, templateLibraryEntry.library_id))
      .where(
        and(
          or(
            eq(templateLibrary.scope, "public"),
            and(
              eq(templateLibrary.org_id, opts.orgId),
              or(
                eq(templateLibrary.scope, "workspace"),
                opts.ownerId
                  ? and(
                      eq(templateLibrary.scope, "private"),
                      eq(templateLibrary.created_by, opts.ownerId),
                    )
                  : undefined,
              ),
            ),
          ),
          needle
            ? sql`lower(${templateLibrary.title} || ' ' || ${templateLibraryEntry.title} || ' ' || ${templateLibraryEntry.description} || ' ' || ${templateLibraryEntry.outcome} || ' ' || ${templateLibraryEntry.category} || ' ' || ${templateLibraryEntry.tags_json}) like ${`%${needle}%`}`
            : undefined,
        ),
      )
      .orderBy(desc(templateLibraryEntry.created_at), desc(templateLibraryEntry.id))
      .limit(Math.min(Math.max(opts.limit, 1), 1_000))
  }
  async countTemplateLibraryEntries(libraryIds: string[]): Promise<Record<string, number>> {
    if (!libraryIds.length) return {}
    const rows = await this.db
      .select({ library_id: templateLibraryEntry.library_id, total: count() })
      .from(templateLibraryEntry)
      .where(inArray(templateLibraryEntry.library_id, libraryIds))
      .groupBy(templateLibraryEntry.library_id)
    return Object.fromEntries(rows.map((row) => [row.library_id, Number(row.total)]))
  }
  async deleteTemplateLibraryEntry(id: string): Promise<void> {
    await this.db.delete(templateLibraryEntry).where(eq(templateLibraryEntry.id, id))
  }

  // ---- GitHub App (instance credentials + per-workspace installations) -----
  async getGithubApp(): Promise<GitHubAppRecord | null> {
    const rows = await this.db.select().from(githubApp).where(eq(githubApp.id, "default"))
    return rows[0] ?? null
  }
  async createGithubApp(a: GitHubAppRecord): Promise<boolean> {
    const rows = await this.db
      .insert(githubApp)
      .values(a)
      .onConflictDoNothing()
      .returning({ id: githubApp.id })
    return rows.length > 0
  }
  async setGithubApp(a: GitHubAppRecord): Promise<void> {
    const { id: _id, created_at: _created, ...set } = a
    await this.db.insert(githubApp).values(a).onConflictDoUpdate({ target: githubApp.id, set })
  }
  async getOrgSettings(orgId: string): Promise<OrgSettings> {
    const rows = await this.db.select().from(orgSettings).where(eq(orgSettings.org_id, orgId))
    return parseOrgSettings(rows[0]?.settings ?? null)
  }
  // getOrgSettings + getUserBrandprint in ONE round trip: independent tables, no join
  // key between them, so a discriminated UNION ALL (same technique as unfurlInfo) rather
  // than a JOIN. Both branches select a plain `text` column, so — unlike a bare NULL
  // literal — no explicit cast is needed for type resolution. resolveActorBrandprint
  // (MCP connect, context runner, rework endpoint) is the only caller.
  async orgContext(
    orgId: string,
    userId: string | null,
  ): Promise<{ settings: OrgSettings; personalBrandprint: string | null }> {
    if (!userId) return { settings: await this.getOrgSettings(orgId), personalBrandprint: null }
    try {
      const { rows } = await this.pool.query<{ kind: string; val: string | null }>(
        `SELECT 'settings' kind, os.settings val FROM org_settings os WHERE os.org_id = $1
         UNION ALL
         SELECT 'brandprint', u."brandprint" FROM "user" u WHERE u.id = $2`,
        [orgId, userId],
      )
      const settingsRaw = rows.find((r) => r.kind === "settings")?.val ?? null
      const brandprintRaw = rows.find((r) => r.kind === "brandprint")?.val ?? null
      return { settings: parseOrgSettings(settingsRaw), personalBrandprint: brandprintRaw }
    } catch {
      // Older/minimal user table with no brandprint column — same fallback as
      // getUserBrandprint's own try/catch.
      return { settings: await this.getOrgSettings(orgId), personalBrandprint: null }
    }
  }
  async setOrgSettings(orgId: string, settings: OrgSettings): Promise<void> {
    await this.db
      .insert(orgSettings)
      .values({ org_id: orgId, settings: JSON.stringify(settings) })
      .onConflictDoUpdate({
        target: orgSettings.org_id,
        set: { settings: JSON.stringify(settings) },
      })
  }
  async setOrgSettingsIfRevision(
    orgId: string,
    expectedRevision: number,
    settings: OrgSettings,
  ): Promise<boolean> {
    const raw = JSON.stringify(settings)
    const updated = await this.db
      .update(orgSettings)
      .set({ settings: raw })
      .where(
        and(
          eq(orgSettings.org_id, orgId),
          sql`coalesce((${orgSettings.settings}::jsonb ->> 'settingsRevision')::integer, 0) = ${expectedRevision}`,
        ),
      )
      .returning({ id: orgSettings.org_id })
    if (updated.length) return true
    if (expectedRevision !== 0) return false
    const inserted = await this.db
      .insert(orgSettings)
      .values({ org_id: orgId, settings: raw })
      .onConflictDoNothing()
      .returning({ id: orgSettings.org_id })
    return inserted.length > 0
  }
  async getSubscription(orgId: string): Promise<SubscriptionRecord | null> {
    const rows = await this.db.select().from(subscription).where(eq(subscription.org_id, orgId))
    return rows[0] ?? null
  }
  async getSubscriptionByStripeId(sid: string): Promise<SubscriptionRecord | null> {
    const rows = await this.db
      .select()
      .from(subscription)
      .where(eq(subscription.stripe_subscription_id, sid))
    return rows[0] ?? null
  }
  async upsertSubscription(s: SubscriptionRecord): Promise<void> {
    const { org_id: _org, created_at: _created, ...set } = s
    await this.db
      .insert(subscription)
      .values(s)
      .onConflictDoUpdate({ target: subscription.org_id, set })
  }

  // ---- Slack App ----------------------------------------------------------
  async getSlackInstall(orgId: string): Promise<SlackInstallRecord | null> {
    const rows = await this.db.select().from(slackInstall).where(eq(slackInstall.org_id, orgId))
    return rows[0] ?? null
  }
  async setSlackInstall(s: SlackInstallRecord): Promise<void> {
    const { org_id: _o, created_at: _c, ...set } = s
    await this.db
      .insert(slackInstall)
      .values(s)
      .onConflictDoUpdate({ target: slackInstall.org_id, set })
  }
  async listSlackInstallsByTeam(teamId: string): Promise<SlackInstallRecord[]> {
    return await this.db.select().from(slackInstall).where(eq(slackInstall.team_id, teamId))
  }
  async deleteSlackInstall(orgId: string): Promise<void> {
    // See the repos.ts twin: disconnect forgets where to post, not just how.
    await this.db.delete(slackSubscription).where(eq(slackSubscription.org_id, orgId))
    await this.db.delete(slackInstall).where(eq(slackInstall.org_id, orgId))
  }
  async getModelCredential(
    orgId: string,
    userId: string,
    provider: string,
  ): Promise<ModelCredentialRecord | null> {
    const rows = await this.db
      .select()
      .from(modelCredential)
      .where(
        and(
          eq(modelCredential.org_id, orgId),
          eq(modelCredential.user_id, userId),
          eq(modelCredential.provider, provider),
        ),
      )
    return rows[0] ?? null
  }
  async setModelCredential(c: ModelCredentialRecord): Promise<void> {
    await this.db
      .insert(modelCredential)
      .values(c)
      .onConflictDoUpdate({
        target: [modelCredential.org_id, modelCredential.user_id, modelCredential.provider],
        set: { secret: c.secret, kind: c.kind, hint: c.hint, updated_at: c.updated_at },
      })
  }
  async deleteModelCredential(orgId: string, userId: string, provider: string): Promise<void> {
    await this.db
      .delete(modelCredential)
      .where(
        and(
          eq(modelCredential.org_id, orgId),
          eq(modelCredential.user_id, userId),
          eq(modelCredential.provider, provider),
        ),
      )
  }
  async listModelCredentials(orgId: string, userId: string): Promise<ModelCredentialRecord[]> {
    return this.db
      .select()
      .from(modelCredential)
      .where(and(eq(modelCredential.org_id, orgId), eq(modelCredential.user_id, userId)))
  }
  async getSlackThreadLink(
    threadId: string,
    channel: string,
  ): Promise<SlackThreadLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(slackThreadLink)
      .where(and(eq(slackThreadLink.thread_id, threadId), eq(slackThreadLink.channel, channel)))
    return rows[0] ?? null
  }
  async listSlackThreadLinksByThread(threadId: string): Promise<SlackThreadLinkRecord[]> {
    return await this.db
      .select()
      .from(slackThreadLink)
      .where(eq(slackThreadLink.thread_id, threadId))
  }
  async getSlackThreadLinkByTs(channel: string, ts: string): Promise<SlackThreadLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(slackThreadLink)
      .where(and(eq(slackThreadLink.channel, channel), eq(slackThreadLink.message_ts, ts)))
    return rows[0] ?? null
  }
  async setSlackThreadLink(l: SlackThreadLinkRecord): Promise<void> {
    const { thread_id: _t, channel: _ch, created_at: _c, ...set } = l
    await this.db
      .insert(slackThreadLink)
      .values(l)
      .onConflictDoUpdate({ target: [slackThreadLink.thread_id, slackThreadLink.channel], set })
  }
  async listSlackSubscriptions(orgId: string): Promise<SlackSubscriptionRecord[]> {
    return await this.db
      .select()
      .from(slackSubscription)
      .where(eq(slackSubscription.org_id, orgId))
      .orderBy(desc(slackSubscription.created_at))
  }
  async upsertSlackSubscription(sub: NewSlackSubscription): Promise<SlackSubscriptionRecord> {
    const row = {
      scope_kind: "workspace" as const,
      scope_id: "",
      events: "*",
      authors: "all" as const,
      active: 1 as const,
      channel_name: null,
      created_by: null,
      ...sub,
    }
    // Identity and provenance are not editable by an upsert — a second admin re-subscribing a
    // channel must not re-stamp who created it.
    const { id: _i, org_id: _o, created_by: _c, ...set } = row
    await this.db
      .insert(slackSubscription)
      .values(row)
      .onConflictDoUpdate({
        target: [
          slackSubscription.org_id,
          slackSubscription.channel_id,
          slackSubscription.scope_kind,
          slackSubscription.scope_id,
        ],
        set,
      })
    const rows = await this.db
      .select()
      .from(slackSubscription)
      .where(
        and(
          eq(slackSubscription.org_id, row.org_id),
          eq(slackSubscription.channel_id, row.channel_id),
          eq(slackSubscription.scope_kind, row.scope_kind),
          eq(slackSubscription.scope_id, row.scope_id),
        ),
      )
    const found = rows[0]
    if (!found) throw new Error("slack subscription upsert did not persist")
    return found
  }
  async updateSlackSubscription(
    id: string,
    orgId: string,
    fields: {
      events?: string
      authors?: SlackAuthorFilter
      active?: 0 | 1
      channel_name?: string | null
    },
  ): Promise<SlackSubscriptionRecord | null> {
    await this.db
      .update(slackSubscription)
      .set(fields)
      .where(and(eq(slackSubscription.id, id), eq(slackSubscription.org_id, orgId)))
    const rows = await this.db
      .select()
      .from(slackSubscription)
      .where(and(eq(slackSubscription.id, id), eq(slackSubscription.org_id, orgId)))
    return rows[0] ?? null
  }
  async deleteSlackSubscription(id: string, orgId: string): Promise<void> {
    await this.db
      .delete(slackSubscription)
      .where(and(eq(slackSubscription.id, id), eq(slackSubscription.org_id, orgId)))
  }
  async deleteSlackSubscriptionsByChannel(orgId: string, channelId: string): Promise<void> {
    await this.db
      .delete(slackSubscription)
      .where(and(eq(slackSubscription.org_id, orgId), eq(slackSubscription.channel_id, channelId)))
  }
  // A `miss` shares this table with real links, so both getters filter it out HERE rather
  // than at their call sites: every caller treats a non-null result as a real Derive user,
  // and one of them DMs `user_id` directly. Filtering once, in the store, is what lets that
  // stay true. `getSlackIdentityState` is the deliberate way to see a miss.
  async getSlackUserLinkBySlackId(
    teamId: string,
    slackUserId: string,
  ): Promise<SlackUserLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(slackUserLink)
      .where(
        and(
          eq(slackUserLink.team_id, teamId),
          eq(slackUserLink.slack_user_id, slackUserId),
          ne(slackUserLink.origin, "miss"),
        ),
      )
    return rows[0] ?? null
  }
  async getSlackUserLinkByUser(
    teamId: string,
    userId: string,
  ): Promise<SlackUserLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(slackUserLink)
      .where(
        and(
          eq(slackUserLink.team_id, teamId),
          eq(slackUserLink.user_id, userId),
          ne(slackUserLink.origin, "miss"),
        ),
      )
    return rows[0] ?? null
  }
  async getSlackIdentityState(
    teamId: string,
    slackUserId: string,
  ): Promise<SlackUserLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(slackUserLink)
      .where(and(eq(slackUserLink.team_id, teamId), eq(slackUserLink.slack_user_id, slackUserId)))
    return rows[0] ?? null
  }
  async setSlackUserLink(l: SlackUserLinkRecord): Promise<void> {
    // created_at is preserved (first seen); checked_at rides in `set` so a miss can age.
    const { id: _i, created_at: _c, ...set } = l
    await this.db
      .insert(slackUserLink)
      .values(l)
      .onConflictDoUpdate({ target: [slackUserLink.team_id, slackUserLink.slack_user_id], set })
  }
  async deleteSlackUserLink(teamId: string, userId: string): Promise<void> {
    await this.db
      .delete(slackUserLink)
      .where(and(eq(slackUserLink.team_id, teamId), eq(slackUserLink.user_id, userId)))
  }
  async getUserNotificationPref(
    orgId: string,
    userId: string,
  ): Promise<UserNotificationPrefRecord | null> {
    const rows = await this.db
      .select()
      .from(userNotificationPref)
      .where(and(eq(userNotificationPref.org_id, orgId), eq(userNotificationPref.user_id, userId)))
    return rows[0] ?? null
  }
  async setUserNotificationPref(p: UserNotificationPrefRecord): Promise<void> {
    const { id: _i, created_at: _c, ...set } = p
    await this.db
      .insert(userNotificationPref)
      .values(p)
      .onConflictDoUpdate({
        target: [userNotificationPref.org_id, userNotificationPref.user_id],
        set,
      })
  }
  // ---- Domains (hostname → artifact) -------------------------------------
  async getDomain(host: string): Promise<DomainRecord | null> {
    const rows = await this.db.select().from(domain).where(eq(domain.host, host))
    return rows[0] ?? null
  }
  // Insert-only: a taken host yields no row (→ 409 in the route), so a workspace
  // can never claim a host already owned by another.
  async setDomain(d: NewDomain): Promise<DomainRecord | null> {
    const rows = await this.db.insert(domain).values(d).onConflictDoNothing().returning()
    return rows[0] ?? null
  }
  async getArtifactDomains(artifactId: string): Promise<DomainRecord[]> {
    return this.db.select().from(domain).where(eq(domain.artifact_id, artifactId))
  }
  async getWorkspaceDomains(orgId: string): Promise<DomainRecord[]> {
    return this.db
      .select()
      .from(domain)
      .where(and(eq(domain.org_id, orgId), isNull(domain.artifact_id)))
  }
  async updateDomain(
    host: string,
    fields: {
      status?: DomainStatus
      verification?: string | null
      artifact_id?: string | null
      redirect_to?: string | null
    },
  ): Promise<DomainRecord | null> {
    const rows = await this.db.update(domain).set(fields).where(eq(domain.host, host)).returning()
    return rows[0] ?? null
  }

  async setArtifactExpiry(artifactId: string, expiresAt: string | null): Promise<void> {
    await this.db.update(artifact).set({ expires_at: expiresAt }).where(eq(artifact.id, artifactId))
  }

  // expires_at is ISO-8601 text (the schema-wide convention), so lexical lt() IS
  // chronological order.
  async listExpiredArtifacts(nowIso: string, limit: number): Promise<ArtifactRecord[]> {
    return this.db
      .select()
      .from(artifact)
      .where(and(isNotNull(artifact.expires_at), lt(artifact.expires_at, nowIso)))
      .limit(limit)
  }
  async deleteDomain(host: string, orgId: string): Promise<void> {
    await this.db.delete(domain).where(and(eq(domain.host, host), eq(domain.org_id, orgId)))
  }

  // ---- Review rounds -----------------------------------------------------
  async createReviewRound(r: NewReviewRound): Promise<ReviewRoundRecord> {
    // Replace this person's prior pending round so the re-request wins and the
    // partial unique index holds.
    await this.db
      .delete(reviewRound)
      .where(
        and(
          eq(reviewRound.artifact_id, r.artifact_id),
          eq(reviewRound.requested_for, r.requested_for),
          eq(reviewRound.state, "pending"),
        ),
      )
    const rows = await this.db.insert(reviewRound).values(r).returning()
    return one(rows)
  }
  async getPendingRound(
    artifactId: string,
    requestedFor?: string,
  ): Promise<ReviewRoundRecord | null> {
    const where = requestedFor
      ? and(
          eq(reviewRound.artifact_id, artifactId),
          eq(reviewRound.requested_for, requestedFor),
          eq(reviewRound.state, "pending"),
        )
      : and(eq(reviewRound.artifact_id, artifactId), eq(reviewRound.state, "pending"))
    const rows = await this.db
      .select()
      .from(reviewRound)
      .where(where)
      .orderBy(asc(reviewRound.created_at))
      .limit(1)
    return rows[0] ?? null
  }
  // ---- Workspace activity -----------------------------------------------------------
  async listVersionsInOrg(
    orgId: string,
    opts: { since: string; limit: number },
  ): Promise<VersionRecord[]> {
    const rows = await this.db
      .select({ v: version })
      .from(version)
      .innerJoin(artifact, eq(artifact.id, version.artifact_id))
      .where(and(eq(artifact.org_id, orgId), gte(version.created_at, opts.since)))
      .orderBy(desc(version.created_at))
      .limit(opts.limit)
    return rows.map((r) => r.v)
  }
  async listCommentsInOrg(
    orgId: string,
    opts: { since: string; limit: number; openOn?: string[] },
  ): Promise<CommentRecord[]> {
    const recent = gte(comment.created_at, opts.since)
    const open =
      opts.openOn && opts.openOn.length
        ? and(eq(comment.state, "open"), inArray(comment.artifact_id, opts.openOn))
        : null
    const rows = await this.db
      .select({ c: comment })
      .from(comment)
      .innerJoin(artifact, eq(artifact.id, comment.artifact_id))
      .where(and(eq(artifact.org_id, orgId), open ? or(recent, open) : recent))
      .orderBy(desc(comment.created_at))
      .limit(opts.limit)
    return rows.map((r) => r.c)
  }
  async getActivitySeen(userId: string, scope: string): Promise<string | null> {
    const rows = await this.db
      .select({ seen_at: activitySeen.seen_at })
      .from(activitySeen)
      .where(and(eq(activitySeen.user_id, userId), eq(activitySeen.scope, scope)))
      .limit(1)
    return rows[0]?.seen_at ?? null
  }
  async setActivitySeen(
    userId: string,
    scope: string,
    at: string,
    opts?: { manual?: boolean },
  ): Promise<string> {
    const current = await this.getActivitySeen(userId, scope)
    if (current !== null && !opts?.manual && current >= at) return current
    const updated_at = new Date().toISOString()
    await this.db
      .insert(activitySeen)
      .values({ id: crypto.randomUUID(), user_id: userId, scope, seen_at: at, updated_at })
      .onConflictDoUpdate({
        target: [activitySeen.user_id, activitySeen.scope],
        set: { seen_at: at, updated_at },
      })
    return at
  }
  async listReviewRoundsInOrg(
    orgId: string,
    opts: { since: string; limit: number },
  ): Promise<ReviewRoundRecord[]> {
    const rows = await this.db
      .select({ r: reviewRound })
      .from(reviewRound)
      .innerJoin(artifact, eq(artifact.id, reviewRound.artifact_id))
      .where(
        and(
          eq(artifact.org_id, orgId),
          or(
            eq(reviewRound.state, "pending"),
            gte(reviewRound.created_at, opts.since),
            gte(reviewRound.resolved_at, opts.since),
          ),
        ),
      )
      .orderBy(desc(reviewRound.created_at))
      .limit(opts.limit)
    return rows.map((r) => r.r)
  }
  listReviewRounds(artifactId: string): Promise<ReviewRoundRecord[]> {
    return this.db
      .select()
      .from(reviewRound)
      .where(eq(reviewRound.artifact_id, artifactId))
      .orderBy(desc(reviewRound.created_at))
  }
  async resolveReviewRound(
    id: string,
    fields: {
      note?: string | null
      resolved_by?: string | null
      resolved_by_name?: string | null
    },
  ): Promise<ReviewRoundRecord | null> {
    const rows = await this.db
      .update(reviewRound)
      .set({ ...fields, state: "sent_back", resolved_at: new Date().toISOString() })
      .where(and(eq(reviewRound.id, id), eq(reviewRound.state, "pending")))
      .returning()
    const updated = rows[0] ?? null
    return updated
  }

  // ---- Contexts + sessions -------------------------------------------------
  async createContext(x: NewContext): Promise<ContextRecord> {
    const rows = await this.db.insert(context).values(x).returning()
    return one(rows)
  }
  async getContext(id: string): Promise<ContextRecord | null> {
    const rows = await this.db.select().from(context).where(eq(context.id, id)).limit(1)
    return rows[0] ?? null
  }
  listContexts(orgId: string): Promise<ContextRecord[]> {
    return this.db
      .select()
      .from(context)
      .where(eq(context.org_id, orgId))
      .orderBy(desc(context.created_at))
  }
  async contextsWithManifests(
    orgId: string,
  ): Promise<(ContextRecord & { manifest_short_id: string | null })[]> {
    // The route resolved every context's manifest artifact in a SECOND query keyed on
    // the ids the first one returned — a real FK dependency, so it could not be a
    // same-key batch, but a LEFT JOIN still answers it in one round trip. LEFT, not
    // INNER: a context whose manifest artifact is gone must still list (the route
    // rendered it with a null short_id).
    const rows = await this.db
      .select({ context, manifest_short_id: artifact.short_id })
      .from(context)
      .leftJoin(artifact, eq(artifact.id, context.manifest_artifact_id))
      .where(eq(context.org_id, orgId))
      .orderBy(desc(context.created_at))
    return rows.map((r) => ({
      ...(r.context as ContextRecord),
      manifest_short_id: r.manifest_short_id ?? null,
    }))
  }
  // Sequential cascade (messages → sessions → context), like deleteCollection.
  // The org scope gates the WHOLE cascade, not just the context row — otherwise a
  // wrong-workspace call would wipe another tenant's sessions and leave the context.
  async deleteContext(id: string, orgId: string): Promise<void> {
    const owned = await this.db
      .select({ id: context.id })
      .from(context)
      .where(and(eq(context.id, id), eq(context.org_id, orgId)))
      .limit(1)
    if (owned.length === 0) return
    // Subquery, not a materialized id list — kept identical to the sqlite/d1
    // layer, where an expanded IN (...) would blow D1's bound-parameter cap.
    await this.db
      .delete(sessionMessage)
      .where(
        inArray(
          sessionMessage.session_id,
          this.db
            .select({ id: contextSession.id })
            .from(contextSession)
            .where(eq(contextSession.context_id, id)),
        ),
      )
    await this.db.delete(contextSession).where(eq(contextSession.context_id, id))
    // The asker roster FKs the context — clear it before the parent row.
    await this.db.delete(contextAsker).where(eq(contextAsker.context_id, id))
    await this.db.delete(context).where(eq(context.id, id))
  }
  // A no-op on an unknown id, deliberately: the caller already 404'd before
  // stamping, and liveness is best-effort — never worth a throw.
  async touchContextSeen(id: string, at: string): Promise<void> {
    await this.db.update(context).set({ runner_seen_at: at }).where(eq(context.id, id))
  }
  async setContextAskPolicy(id: string, policy: "workspace" | "invited"): Promise<void> {
    await this.db.update(context).set({ ask_policy: policy }).where(eq(context.id, id))
  }
  async setContextManifest(id: string, manifestArtifactId: string): Promise<void> {
    await this.db
      .update(context)
      .set({ manifest_artifact_id: manifestArtifactId })
      .where(eq(context.id, id))
  }
  async setContextConnections(id: string, connectionIds: string | null): Promise<void> {
    await this.db.update(context).set({ connection_ids: connectionIds }).where(eq(context.id, id))
  }
  async listContextAskers(contextId: string): Promise<ContextAskerRecord[]> {
    return this.db
      .select()
      .from(contextAsker)
      .where(eq(contextAsker.context_id, contextId))
      .orderBy(contextAsker.created_at) as Promise<ContextAskerRecord[]>
  }
  async getContextAsker(contextId: string, userId: string): Promise<ContextAskerRecord | null> {
    const rows = await this.db
      .select()
      .from(contextAsker)
      .where(and(eq(contextAsker.context_id, contextId), eq(contextAsker.user_id, userId)))
      .limit(1)
    return (rows[0] as ContextAskerRecord) ?? null
  }
  async addContextAsker(a: NewContextAsker): Promise<ContextAskerRecord> {
    await this.db
      .insert(contextAsker)
      .values(a)
      .onConflictDoNothing({ target: [contextAsker.context_id, contextAsker.user_id] })
    return (await this.getContextAsker(a.context_id, a.user_id)) as ContextAskerRecord
  }
  async removeContextAsker(contextId: string, userId: string): Promise<void> {
    await this.db
      .delete(contextAsker)
      .where(and(eq(contextAsker.context_id, contextId), eq(contextAsker.user_id, userId)))
  }
  async createSession(s: NewSession): Promise<SessionRecord> {
    const rows = await this.db.insert(contextSession).values(s).returning()
    return one(rows)
  }
  async createSessionWithMessage(
    s: NewSession,
    m: Omit<NewSessionMessage, "session_id">,
    state: SessionState,
  ): Promise<{ session: SessionRecord; message: SessionMessageRecord }> {
    // Three statements (insert session, insert message, set state) as ONE, in a single
    // implicit transaction — one round trip, and atomic, where the three loose statements it
    // replaces could leave a session with no first message if the isolate died between them.
    //
    // THE STATE IS WRITTEN BY THE INSERT, not by a follow-up UPDATE. That is not a shortcut:
    // data-modifying CTEs in one statement all see the SAME snapshot and cannot observe each
    // other's effects on the target table, so an `UPDATE context_session WHERE id = (SELECT
    // id FROM ins)` matches ZERO rows — the row `ins` just wrote is not visible to it. The
    // first version of this did exactly that, returned no rows at all, and 500'd every chat
    // open on Postgres while passing the entire SQLite suite.
    //
    // `msg` reading from `ins` IS allowed, and is the difference that matters: it consumes
    // `ins`'s RETURNING output (a CTE result set), not the table's post-insert state.
    const now = new Date().toISOString()
    const { rows } = await this.pool.query<{
      session: SessionRecord
      message: SessionMessageRecord
    }>(
      `WITH ins AS (
         INSERT INTO context_session
           (id, context_id, org_id, asker_id, context_version, dedupe_key, subject_ref, state, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
       ), msg AS (
         INSERT INTO session_message (id, session_id, author_kind, author_id, body_md, meta)
         SELECT $10, ins.id, $11, $12, $13, $14 FROM ins RETURNING *
       )
       SELECT row_to_json(ins) session, row_to_json(msg) message FROM ins, msg`,
      [
        s.id,
        s.context_id ?? null,
        s.org_id,
        s.asker_id,
        s.context_version ?? null,
        s.dedupe_key ?? null,
        s.subject_ref ?? null,
        state,
        now,
        m.id,
        m.author_kind,
        m.author_id,
        m.body_md,
        m.meta ?? null,
      ],
    )
    const row = rows[0]
    if (!row) throw new Error("createSessionWithMessage: insert returned no row")
    return { session: row.session, message: row.message }
  }
  async getSession(id: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(contextSession)
      .where(eq(contextSession.id, id))
      .limit(1)
    return rows[0] ?? null
  }
  listSessions(
    contextId: string,
    opts?: { askerId?: string; limit?: number; cursor?: { key: string; id: string } },
  ): Promise<SessionRecord[]> {
    const clauses = [eq(contextSession.context_id, contextId)]
    if (opts?.askerId) clauses.push(eq(contextSession.asker_id, opts.askerId))
    // Keyset, not offset (a session opened mid-paging would shift every offset and
    // repeat a row), and the id tiebreak is required, not belt-and-braces: several
    // sessions really do share a created_at, and `created_at < key` alone would skip
    // every one of them at the page boundary.
    const cur = opts?.cursor
    if (cur)
      clauses.push(
        or(
          lt(contextSession.created_at, cur.key),
          and(eq(contextSession.created_at, cur.key), lt(contextSession.id, cur.id)),
        ) as SQL,
      )
    return this.db
      .select()
      .from(contextSession)
      .where(and(...clauses))
      .orderBy(desc(contextSession.created_at), desc(contextSession.id))
      .limit(opts?.limit ?? 50)
  }
  contextOutputs(contextId: string, limit?: number): Promise<ContextOutput[]> {
    const lastRun = sql<string>`max(coalesce(${contextSession.updated_at}, ${contextSession.created_at}))`
    return this.db
      .select({
        short_id: sql<string>`${contextSession.result_artifact_id}`,
        runs: count(),
        last_run_at: lastRun,
      })
      .from(contextSession)
      .where(
        and(eq(contextSession.context_id, contextId), isNotNull(contextSession.result_artifact_id)),
      )
      .groupBy(contextSession.result_artifact_id)
      .orderBy(desc(lastRun))
      .limit(limit ?? 50)
  }
  listChatSessions(orgId: string, askerId: string, limit?: number): Promise<SessionRecord[]> {
    return this.db
      .select()
      .from(contextSession)
      .where(
        and(
          eq(contextSession.org_id, orgId),
          eq(contextSession.asker_id, askerId),
          isNull(contextSession.context_id),
        ),
      )
      .orderBy(desc(contextSession.created_at))
      .limit(limit ?? 50)
  }
  pendingSessions(contextId: string, limit: number): Promise<SessionRecord[]> {
    return this.db
      .select()
      .from(contextSession)
      .where(and(eq(contextSession.context_id, contextId), eq(contextSession.state, "open")))
      .orderBy(asc(contextSession.created_at))
      .limit(limit)
  }
  claimPendingSessions(
    contextId: string,
    limit: number,
    leaseUntil: string,
  ): Promise<SessionRecord[]> {
    // FOR UPDATE SKIP LOCKED so concurrent runners each grab a disjoint set; the
    // UPDATE then flips them to `working` + leases them (the claimDueRenderJobs
    // pattern). Runnable = `open`, or `working` with a lapsed lease (crash recovery).
    const now = new Date().toISOString()
    const runnable = this.db
      .select({ id: contextSession.id })
      .from(contextSession)
      .where(
        and(
          eq(contextSession.context_id, contextId),
          or(
            eq(contextSession.state, "open"),
            // A `working` row with a lapsed OR missing lease is reclaimable (crash recovery,
            // and a never-leased zombie self-heals) — mirrors countWorkingSessions.
            and(
              eq(contextSession.state, "working"),
              or(lte(contextSession.lease_until, now), isNull(contextSession.lease_until)),
            ),
          ),
        ),
      )
      .orderBy(asc(contextSession.created_at))
      .limit(limit)
      .for("update", { skipLocked: true })
    return this.db
      .update(contextSession)
      .set({ state: "working", started_at: now, lease_until: leaseUntil, updated_at: now })
      .where(inArray(contextSession.id, runnable))
      .returning()
  }
  // Only LIVE working sessions (lease not lapsed) fill the concurrency cap — else a
  // crashed run wedges the queue (the lapsed-lease reclaim is in claimPendingSessions,
  // which only runs when there is room). Mirrors the sqlite/d1 layer.
  async listDueOpenSessions(
    now: string,
    limit = 50,
    orgIds?: readonly string[],
  ): Promise<SessionRecord[]> {
    if (orgIds?.length === 0) return []
    return this.db
      .select()
      .from(contextSession)
      .where(
        and(
          orgIds ? inArray(contextSession.org_id, [...orgIds]) : undefined,
          or(
            eq(contextSession.state, "open"),
            // A `working` row whose lease lapsed (or never existed) is a dead executor's
            // session — runnable again, exactly as claimPendingSessions treats it.
            and(
              eq(contextSession.state, "working"),
              or(isNull(contextSession.lease_until), lt(contextSession.lease_until, now)),
            ),
          ),
        ),
      )
      .orderBy(contextSession.created_at)
      .limit(limit)
  }
  async claimSessionById(
    id: string,
    agentId: string,
    leaseUntil: string,
  ): Promise<SessionRecord | null> {
    // The session belongs to a CONTEXT, and the context names the agent — so ownership is
    // checked through it rather than on the row. A foreign agent claims nothing.
    const sRows = await this.db.select().from(contextSession).where(eq(contextSession.id, id))
    const s = sRows[0]
    if (!s) return null
    // No context ⇒ no owning agent ⇒ not agent-claimable (see the sqlite driver).
    if (!s.context_id) return null
    const cRows = await this.db.select().from(context).where(eq(context.id, s.context_id))
    if (cRows[0]?.agent_id !== agentId) return null
    const now = new Date().toISOString()
    const rows = await this.db
      .update(contextSession)
      .set({ state: "working", started_at: now, lease_until: leaseUntil, updated_at: now })
      .where(
        and(
          eq(contextSession.id, id),
          or(
            eq(contextSession.state, "open"),
            and(
              eq(contextSession.state, "working"),
              or(isNull(contextSession.lease_until), lt(contextSession.lease_until, now)),
            ),
          ),
        ),
      )
      .returning()
    return rows[0] ?? null
  }
  async countWorkingSessions(contextId: string): Promise<number> {
    const now = new Date().toISOString()
    const rows = await this.db
      .select({ n: count() })
      .from(contextSession)
      .where(
        and(
          eq(contextSession.context_id, contextId),
          eq(contextSession.state, "working"),
          gt(contextSession.lease_until, now),
        ),
      )
    return rows[0]?.n ?? 0
  }
  async findInflightSession(
    contextId: string,
    askerId: string,
    dedupeKey: string,
  ): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(contextSession)
      .where(
        and(
          eq(contextSession.context_id, contextId),
          eq(contextSession.asker_id, askerId),
          eq(contextSession.dedupe_key, dedupeKey),
          inArray(contextSession.state, ["open", "working"]),
        ),
      )
      .orderBy(desc(contextSession.created_at))
      .limit(1)
    return rows[0] ?? null
  }
  async setResultArtifact(sessionId: string, artifactShortId: string): Promise<void> {
    await this.db
      .update(contextSession)
      .set({ result_artifact_id: artifactShortId, updated_at: new Date().toISOString() })
      .where(eq(contextSession.id, sessionId))
  }
  // Extend a claimed session's lease — a runner streaming progress is alive, so its
  // lease must move forward or a slow-but-live run gets re-served and double-run.
  async renewSessionLease(sessionId: string, leaseUntil: string): Promise<void> {
    await this.db
      .update(contextSession)
      .set({ lease_until: leaseUntil, updated_at: new Date().toISOString() })
      .where(eq(contextSession.id, sessionId))
  }
  // Append an asker follow-up and reopen the session in ONE atomic compare-and-set: a
  // `working` session STAYS working (don't vacate the active claim), while a settled or open
  // one goes to `open` (reclaimable), dropping the dedupe key on the settled path so it can't
  // collide with a newer same-key session. The CASE reads the row's live state inside the
  // update, so a settle racing the reopen can't strand the session `working` with no runner.
  async appendFollowupReopen(m: NewSessionMessage): Promise<SessionMessageRecord> {
    const rows = await this.db.insert(sessionMessage).values(m).returning()
    const now = new Date().toISOString()
    await this.db
      .update(contextSession)
      .set({
        state: sql`CASE WHEN ${contextSession.state} = 'working' THEN 'working' ELSE 'open' END`,
        dedupe_key: sql`CASE WHEN ${contextSession.state} IN ('answered', 'escalated', 'failed') THEN NULL ELSE ${contextSession.dedupe_key} END`,
        updated_at: now,
      })
      .where(eq(contextSession.id, m.session_id))
    return one(rows)
  }
  async claimAttendedSession(id: string, leaseUntil: string): Promise<SessionRecord | null> {
    const now = new Date().toISOString()
    // Mirror of the sqlite driver: contextless only, and the status predicate is the exclusion.
    const rows = await this.db
      .update(contextSession)
      .set({ state: "working", started_at: now, lease_until: leaseUntil, updated_at: now })
      .where(
        and(
          eq(contextSession.id, id),
          isNull(contextSession.context_id),
          or(
            eq(contextSession.state, "open"),
            and(
              eq(contextSession.state, "working"),
              or(lte(contextSession.lease_until, now), isNull(contextSession.lease_until)),
            ),
          ),
        ),
      )
      .returning()
    return rows[0] ?? null
  }
  async setSessionState(id: string, state: SessionState): Promise<SessionRecord | null> {
    const rows = await this.db
      .update(contextSession)
      .set({ state, updated_at: new Date().toISOString() })
      .where(eq(contextSession.id, id))
      .returning()
    return rows[0] ?? null
  }
  // Two writes, no transaction (the createReviewRound pattern, kept identical to
  // the sqlite/d1 layer). A crash between them leaves state stale: an unsettled
  // agent turn is caught by the runner's last-turn guard; a lost asker `open`
  // waits for the asker's next message. Both windows are milliseconds.
  async addSessionMessage(
    m: NewSessionMessage,
    state: SessionState,
  ): Promise<SessionMessageRecord> {
    const rows = await this.db.insert(sessionMessage).values(m).returning()
    await this.db
      .update(contextSession)
      .set({ state, updated_at: new Date().toISOString() })
      .where(eq(contextSession.id, m.session_id))
    return one(rows)
  }
  listSessionMessages(sessionId: string): Promise<SessionMessageRecord[]> {
    return this.db
      .select()
      .from(sessionMessage)
      .where(eq(sessionMessage.session_id, sessionId))
      .orderBy(asc(sessionMessage.created_at))
  }
  /**
   * The most recent AGENT answers across every session, newest first. Unscoped by design (see
   * the port): it answers a question about the DEPLOY, and the route that calls it is
   * operator-only. `desc(created_at)` rides the `session_message_recent` index.
   */
  async listRecentAgentMessages(
    limit: number,
  ): Promise<Pick<SessionMessageRecord, "session_id" | "author_kind" | "created_at" | "meta">[]> {
    return this.db
      .select({
        session_id: sessionMessage.session_id,
        author_kind: sessionMessage.author_kind,
        created_at: sessionMessage.created_at,
        meta: sessionMessage.meta,
      })
      .from(sessionMessage)
      .where(eq(sessionMessage.author_kind, "agent"))
      .orderBy(desc(sessionMessage.created_at))
      .limit(limit)
  }

  async listSessionMessagesFor(sessionIds: string[]): Promise<SessionMessageRecord[]> {
    if (sessionIds.length === 0) return []
    return this.db
      .select()
      .from(sessionMessage)
      .where(inArray(sessionMessage.session_id, sessionIds))
      .orderBy(asc(sessionMessage.created_at))
  }

  // ---- User directory (Better Auth's "user" table; raw, may be absent) ---
  async findUserByEmail(email: string): Promise<UserDir | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, email, name, image FROM "user" WHERE email = $1`,
        [email],
      )
      return (rows[0] as UserDir) ?? null
    } catch {
      return null
    }
  }
  // The workspace, its roster, and the directory rows for that roster in ONE statement —
  // see the port doc. The user arm joins THROUGH membership rather than taking an id list,
  // so it no longer has to wait for the roster to come back before it can start.
  async workspaceWithMembers(orgId: string): Promise<{
    workspace: WorkspaceRecord | null
    members: MembershipRecord[]
    users: UserDir[]
  }> {
    const core = [
      sql`select 'ws' as kind, to_jsonb(w) as doc from workspace w where w.id = ${orgId}`,
      sql`select 'member', to_jsonb(m) from membership m where m.org_id = ${orgId}`,
    ]
    // Best-effort, exactly like getUsers: the Better Auth tables can be absent on a fresh
    // self-host, and there the roster must still come back rather than fail the page.
    const directory = sql`select 'user', jsonb_build_object(
        'id', u.id, 'email', u.email, 'name', u.name, 'image', u.image,
        'username', u.username, 'profession', u.profession, 'about', u.about)
      from "user" u join membership m2 on m2.user_id = u.id and m2.org_id = ${orgId}`
    type Row = { kind: string; doc: unknown }
    const run = async (arms: ReturnType<typeof sql>[]) => {
      const res = await this.db.execute(sql.join(arms, sql` union all `))
      return ((res as unknown as { rows?: Row[] }).rows ?? []) as Row[]
    }
    let rows: Row[]
    try {
      rows = await run([...core, directory])
    } catch {
      rows = await run(core)
    }
    let workspace: WorkspaceRecord | null = null
    const members: MembershipRecord[] = []
    const users: UserDir[] = []
    for (const r of rows) {
      if (r.kind === "ws") workspace = r.doc as WorkspaceRecord
      else if (r.kind === "member") members.push(r.doc as MembershipRecord)
      else users.push(r.doc as UserDir)
    }
    return { workspace, members, users }
  }

  async getUsers(ids: string[]): Promise<UserDir[]> {
    if (ids.length === 0) return []
    try {
      const ph = ids.map((_, i) => `$${i + 1}`).join(",")
      const { rows } = await this.pool.query(
        `SELECT id, email, name, image, username, profession, about FROM "user" WHERE id IN (${ph})`,
        ids,
      )
      return rows as UserDir[]
    } catch {
      return []
    }
  }
  // Map GitHub numeric user ids to Derive accounts ("account".accountId → "user"), scoped
  // to the github social provider. Best-effort — [] when the Better Auth tables are absent.
  async usersByGithubIds(ghIds: string[]): Promise<GithubUserMapping[]> {
    if (ghIds.length === 0) return []
    try {
      const ph = ghIds.map((_, i) => `$${i + 1}`).join(",")
      const { rows } = await this.pool.query(
        `SELECT a."accountId" gh_id, u.id, u.name, u.image, u.username
         FROM "account" a JOIN "user" u ON u.id = a."userId"
         WHERE a."providerId" = 'github' AND a."accountId" IN (${ph})`,
        ghIds,
      )
      return rows as GithubUserMapping[]
    } catch {
      return []
    }
  }
  // Idempotent backfill (see sqlite.ts) — stamp author_id from a known author_gh_id→user mapping.
  async backfillAuthorIds(): Promise<number> {
    try {
      const res = await this.pool.query(
        `UPDATE "artifact" SET author_id = (
           SELECT u.id FROM "account" a JOIN "user" u ON u.id = a."userId"
           WHERE a."providerId" = 'github' AND a."accountId" = "artifact".author_gh_id LIMIT 1)
         WHERE author_id IS NULL AND author_gh_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM "account" a JOIN "user" u ON u.id = a."userId"
             WHERE a."providerId" = 'github' AND a."accountId" = "artifact".author_gh_id)`,
      )
      return res.rowCount ?? 0
    } catch {
      return 0
    }
  }
  async getUserByUsername(username: string): Promise<UserProfile | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, name, image, username, profession, about, discoverable FROM "user" WHERE username = $1`,
        [username],
      )
      return (rows[0] as UserProfile) ?? null
    } catch {
      return null
    }
  }
  async setUsername(userId: string, username: string): Promise<"ok" | "taken"> {
    // Handles are stored lowercased, so a plain equality check finds the holder.
    const { rows } = await this.pool.query(`SELECT id FROM "user" WHERE username = $1`, [username])
    const holder = rows[0] as { id: string } | undefined
    if (holder && holder.id !== userId) return "taken"
    try {
      await this.pool.query(`UPDATE "user" SET username = $1 WHERE id = $2`, [username, userId])
      return "ok"
    } catch {
      // Unique-index race: claimed between the check and the write.
      return "taken"
    }
  }
  async setUserImage(userId: string, image: string): Promise<void> {
    await this.pool.query(`UPDATE "user" SET image = $1 WHERE id = $2`, [image, userId])
  }
  async setUserDiscoverable(userId: string, discoverable: boolean): Promise<void> {
    await this.pool.query(`UPDATE "user" SET discoverable = $1 WHERE id = $2`, [
      discoverable,
      userId,
    ])
  }
  async setUserOnboarded(userId: string, onboarded: boolean): Promise<void> {
    await this.pool.query(`UPDATE "user" SET onboarded = $1 WHERE id = $2`, [onboarded, userId])
  }
  async setUserProfile(
    userId: string,
    fields: { profession?: string | null; about?: string | null; brandprint?: string | null },
  ): Promise<void> {
    // Patch only the fields provided (undefined = leave as-is; null = clear).
    const sets: string[] = []
    const args: (string | null)[] = []
    if (fields.profession !== undefined) {
      args.push(fields.profession)
      sets.push(`profession = $${args.length}`)
    }
    if (fields.about !== undefined) {
      args.push(fields.about)
      sets.push(`about = $${args.length}`)
    }
    if (fields.brandprint !== undefined) {
      args.push(fields.brandprint)
      sets.push(`"brandprint" = $${args.length}`)
    }
    if (sets.length === 0) return
    args.push(userId)
    await this.pool.query(`UPDATE "user" SET ${sets.join(", ")} WHERE id = $${args.length}`, args)
  }
  async getUserBrandprint(userId: string): Promise<string | null> {
    try {
      const r = await this.pool.query(`SELECT "brandprint" FROM "user" WHERE id = $1`, [userId])
      return (r.rows[0]?.brandprint as string | null | undefined) ?? null
    } catch {
      return null // older/minimal user table without the column
    }
  }
  async searchDiscoverableUsers(q: string, limit: number): Promise<UserProfile[]> {
    const s = q.trim()
    if (!s) return []
    try {
      // Escape ILIKE metacharacters so a literal %/_/\ in the query matches itself —
      // a search for "%" finds nothing, not everyone.
      const like = `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
      const { rows } = await this.pool.query(
        // discoverable IS NOT FALSE → true OR unset(null) both match (on by
        // default); only an explicit false (opted out) is excluded.
        `SELECT id, name, image, username, profession, about FROM "user"
         WHERE discoverable IS NOT FALSE AND username IS NOT NULL
           AND (username ILIKE $1 OR name ILIKE $1)
         ORDER BY username LIMIT $2`,
        [like, limit],
      )
      return rows as UserProfile[]
    } catch {
      return []
    }
  }
  async listDiscoverableUsers(limit: number): Promise<UserProfile[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, name, image, username, profession, about FROM "user"
         WHERE discoverable IS NOT FALSE AND username IS NOT NULL
         ORDER BY username LIMIT $1`,
        [limit],
      )
      return rows as UserProfile[]
    } catch {
      return []
    }
  }

  async listWorkspaceMates(userId: string, limit: number): Promise<UserProfile[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT DISTINCT u.id, u.name, u.image, u.username, u.profession, u.about
         FROM membership m1
         JOIN membership m2 ON m2.org_id = m1.org_id AND m2.user_id != m1.user_id
         JOIN "user" u ON u.id = m2.user_id
         WHERE m1.user_id = $1 AND u.username IS NOT NULL
         ORDER BY u.username LIMIT $2`,
        [userId, limit],
      )
      return rows as UserProfile[]
    } catch {
      return []
    }
  }

  // ---- Notifications (in-app, one row per recipient) ---------------------
  async createNotification(n: NewNotification): Promise<void> {
    await this.db.insert(notification).values(n)
  }
  async createNotifications(rows: NewNotification[]): Promise<void> {
    if (rows.length === 0) return
    await this.db.insert(notification).values(rows)
  }
  listNotifications(userId: string, limit: number): Promise<NotificationRecord[]> {
    return this.db
      .select()
      .from(notification)
      .where(eq(notification.user_id, userId))
      .orderBy(desc(notification.created_at))
      .limit(limit)
  }
  async unreadNotificationCount(userId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(notification)
      .where(and(eq(notification.user_id, userId), eq(notification.read, 0)))
    return rows[0]?.n ?? 0
  }
  async notificationsPage(userId: string, limit: number): Promise<NotificationsPage> {
    // A window function computes `unread` over every row this user has (WHERE is applied
    // before the window, ORDER BY/LIMIT after) — one query answers both the page and the
    // true total unread count, not just the unread count within the returned page.
    const { rows } = await this.pool.query<NotificationRecord & { unread_total: number }>(
      `SELECT *, count(*) FILTER (WHERE read = 0) OVER ()::int AS unread_total
         FROM notification WHERE user_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    )
    const unread = rows[0]?.unread_total ?? 0
    return {
      notifications: rows.map(({ unread_total, ...n }) => n),
      unread,
    }
  }
  async markNotificationsRead(userId: string, ids: string[] | "all"): Promise<void> {
    const where =
      ids === "all"
        ? eq(notification.user_id, userId)
        : ids.length > 0
          ? and(eq(notification.user_id, userId), inArray(notification.id, ids))
          : null
    if (!where) return
    await this.db.update(notification).set({ read: 1 }).where(where)
  }

  // ---- Agents + their pull inbox -----------------------------------------
  async createAgent(a: NewAgent): Promise<AgentRecord> {
    const rows = await this.db.insert(agent).values(a).returning()
    return one(rows)
  }
  async touchAgentRunsSeen(id: string, at: string): Promise<void> {
    await this.db.update(agent).set({ runs_seen_at: at }).where(eq(agent.id, id))
  }
  async rotateAgentToken(
    id: string,
    orgId: string,
    tokenHash: string,
  ): Promise<AgentRecord | null> {
    const rows = await this.db
      .update(agent)
      .set({ token: tokenHash })
      .where(and(eq(agent.id, id), eq(agent.org_id, orgId)))
      .returning()
    return (rows[0] as AgentRecord | undefined) ?? null
  }
  listAgents(orgId: string): Promise<AgentRecord[]> {
    return this.db.select().from(agent).where(eq(agent.org_id, orgId))
  }
  async setAgentHosted(id: string, orgId: string, hosted: 0 | 1): Promise<AgentRecord | null> {
    const rows = await this.db
      .update(agent)
      .set({ hosted })
      .where(and(eq(agent.id, id), eq(agent.org_id, orgId)))
      .returning()
    return rows[0] ?? null
  }
  async createAutomation(a: NewAutomation): Promise<AutomationRecord> {
    const rows = await this.db.insert(automation).values(a).returning()
    return one(rows)
  }
  async getAutomation(id: string): Promise<AutomationRecord | null> {
    const rows = await this.db.select().from(automation).where(eq(automation.id, id))
    return rows[0] ?? null
  }
  async getAutomationsByIds(ids: string[]): Promise<AutomationRecord[]> {
    if (ids.length === 0) return []
    return this.db.select().from(automation).where(inArray(automation.id, ids))
  }
  listAutomations(orgId: string, limit = 100): Promise<AutomationRecord[]> {
    return this.db
      .select()
      .from(automation)
      .where(eq(automation.org_id, orgId))
      .orderBy(desc(automation.created_at))
      .limit(limit)
  }
  async automationsWithExecutors(
    orgId: string,
    limit = 100,
  ): Promise<(AutomationRecord & { executor_seen_at: string | null })[]> {
    // The route used to fetch the org's automations AND its whole agent roster as two
    // round trips and join `runs_seen_at` in memory by agent_id; a LEFT JOIN answers it
    // in one query (an automation's agent can in principle be deleted out from under it,
    // hence LEFT not INNER).
    const rows = await this.db
      .select({ automation, executor_seen_at: agent.runs_seen_at })
      .from(automation)
      .leftJoin(agent, eq(agent.id, automation.agent_id))
      .where(eq(automation.org_id, orgId))
      .orderBy(desc(automation.created_at))
      .limit(limit)
    return rows.map((r) => ({
      ...(r.automation as AutomationRecord),
      executor_seen_at: r.executor_seen_at ?? null,
    }))
  }
  async updateAutomation(
    id: string,
    orgId: string,
    fields: {
      agent_id?: string
      trigger?: string
      instruction?: string
      provider?: import("@derive/core").ExecutionProvider
      refs?: string | null
      context_id?: string | null
      /** JSON array of connection ids this automation may spend; null clears them all. */
      connection_ids?: string | null
      enabled?: 0 | 1
    },
  ): Promise<AutomationRecord | null> {
    const set: Record<string, unknown> = {}
    if (fields.agent_id !== undefined) set.agent_id = fields.agent_id
    if (fields.trigger !== undefined) set.trigger = fields.trigger
    if (fields.instruction !== undefined) set.instruction = fields.instruction
    if (fields.provider !== undefined) set.provider = fields.provider
    if (fields.refs !== undefined) set.refs = fields.refs
    if (fields.context_id !== undefined) set.context_id = fields.context_id
    if (fields.connection_ids !== undefined) set.connection_ids = fields.connection_ids
    if (fields.enabled !== undefined) set.enabled = fields.enabled
    if (Object.keys(set).length === 0) return this.getAutomation(id)
    const rows = await this.db
      .update(automation)
      .set(set)
      .where(and(eq(automation.id, id), eq(automation.org_id, orgId)))
      .returning()
    return rows[0] ?? null
  }
  async deleteAutomation(id: string, orgId: string): Promise<void> {
    // Cancel pending work first, then remove the definition — both org-scoped so a stray
    // caller can't reach across tenants. Running/finished runs stay as history.
    await this.db.delete(run).where(and(eq(run.automation_id, id), eq(run.status, "queued")))
    await this.db.delete(automation).where(and(eq(automation.id, id), eq(automation.org_id, orgId)))
  }
  async createRun(r: NewRun): Promise<RunRecord> {
    const rows = await this.db
      .insert(run)
      .values({ ...r, status: r.status ?? "queued" })
      .returning()
    return one(rows)
  }
  async getRun(id: string): Promise<RunRecord | null> {
    const rows = await this.db.select().from(run).where(eq(run.id, id)).limit(1)
    return (rows[0] as RunRecord | undefined) ?? null
  }
  claimDueRuns(agentId: string, now: string, limit = 20): Promise<RunRecord[]> {
    // The oldest queued runs due now for this agent, flipped to running under a row lock
    // (FOR UPDATE SKIP LOCKED) so two executors never claim the same run. A null
    // scheduled_for means "as soon as possible"; coalesce to '' so it orders FIRST
    // identically on Postgres and sqlite (asc(scheduled_for) puts NULLs last on pg).
    const due = this.db
      .select({ id: run.id })
      .from(run)
      .where(
        and(
          eq(run.agent_id, agentId),
          eq(run.status, "queued"),
          or(isNull(run.scheduled_for), lte(run.scheduled_for, now)),
        ),
      )
      .orderBy(sql`coalesce(${run.scheduled_for}, '') asc`)
      .limit(limit)
      .for("update", { skipLocked: true })
    return this.db
      .update(run)
      .set({ status: "running", started_at: now })
      .where(inArray(run.id, due))
      .returning()
  }
  async claimRunById(id: string, agentId: string, now: string): Promise<RunRecord | null> {
    // The capability-token claim: exactly this run, queued → running. The status guard in the
    // WHERE is the race safety — a double-booted substrate's second update matches zero rows.
    const rows = await this.db
      .update(run)
      .set({ status: "running", started_at: now })
      .where(and(eq(run.id, id), eq(run.agent_id, agentId), eq(run.status, "queued")))
      .returning()
    return rows[0] ?? null
  }
  async requeueRun(
    id: string,
    agentId: string,
    fields: { scheduledFor: string; meta?: string | null; costMicroUsd?: number | null },
    expectedStartedAt?: string | null,
  ): Promise<RunRecord | null> {
    // Strict running → queued, only for the claiming agent: the status guard stops a duplicate
    // or late retry request from resurrecting a run that already settled. FENCED on
    // started_at too, when the caller supplies it — see the sqlite twin (repos.ts) for the
    // full reasoning: status+agent alone can't tell "my own claim" from one that superseded
    // it, since a run-scoped token carries no notion of which claim episode minted it.
    const rows = await this.db
      .update(run)
      .set({
        status: "queued",
        started_at: null,
        scheduled_for: fields.scheduledFor,
        ...addRunCost(fields.costMicroUsd),
        ...(fields.meta === undefined ? {} : { meta: fields.meta }),
      })
      .where(
        and(
          eq(run.id, id),
          eq(run.agent_id, agentId),
          eq(run.status, "running"),
          expectedStartedAt === undefined
            ? undefined
            : expectedStartedAt === null
              ? isNull(run.started_at)
              : eq(run.started_at, expectedStartedAt),
        ),
      )
      .returning()
    return rows[0] ?? null
  }
  async reclaimStaleRuns(
    cutoffIso: string,
    maxAttempts = 3,
    orgIds?: readonly string[],
  ): Promise<{ requeued: number; failed: number }> {
    if (orgIds?.length === 0) return { requeued: 0, failed: 0 }
    // Substrate died mid-run: running since before the cutoff. Requeue with an attempt count
    // in meta (JSON attribute, not a column); give up as failed/lost past maxAttempts.
    const stale: RunRecord[] = await this.db
      .select()
      .from(run)
      .where(
        and(
          orgIds ? inArray(run.org_id, [...orgIds]) : undefined,
          eq(run.status, "running"),
          lte(run.started_at, cutoffIso),
        ),
      )
      .limit(100)
    let requeued = 0
    let failed = 0
    for (const r of stale) {
      const attempts = runCounter(parseRunMeta(r.meta), "attempts") + 1
      // Past the cap the run is given up as `lost`; otherwise it goes back to the queue with
      // the count carried forward. Both merge into the existing blob so the previous attempt's
      // outcome survives.
      const settled = attempts >= maxAttempts
      await this.db
        .update(run)
        .set(
          settled
            ? {
                status: "failed",
                finished_at: cutoffIso,
                meta: mergeRunMeta(r.meta, { attempts, outcome: "lost" }),
              }
            : { status: "queued", started_at: null, meta: mergeRunMeta(r.meta, { attempts }) },
        )
        // FENCED on started_at — see the twin in repos.ts for the full reasoning. Guarding on
        // status alone lets a second, concurrent sweep requeue a run that was re-claimed
        // between this sweep's SELECT and its UPDATE, putting two live executors on one run.
        .where(
          and(
            eq(run.id, r.id),
            eq(run.status, "running"),
            r.started_at === null ? isNull(run.started_at) : eq(run.started_at, r.started_at),
          ),
        )
      if (settled) failed += 1
      else requeued += 1
    }
    return { requeued, failed }
  }
  async listEnabledAutomations(
    limit = 500,
    orgIds?: readonly string[],
  ): Promise<AutomationRecord[]> {
    if (orgIds?.length === 0) return []
    return this.db
      .select()
      .from(automation)
      .where(
        and(
          orgIds ? inArray(automation.org_id, [...orgIds]) : undefined,
          eq(automation.enabled, 1),
        ),
      )
      .limit(limit)
  }
  async listDueQueuedRuns(
    now: string,
    limit = 50,
    orgIds?: readonly string[],
  ): Promise<RunRecord[]> {
    if (orgIds?.length === 0) return []
    return this.db
      .select()
      .from(run)
      .where(
        and(
          orgIds ? inArray(run.org_id, [...orgIds]) : undefined,
          eq(run.status, "queued"),
          or(isNull(run.scheduled_for), lte(run.scheduled_for, now)),
        ),
      )
      .orderBy(sql`coalesce(${run.scheduled_for}, '') asc`)
      .limit(limit)
  }
  async finishRun(
    id: string,
    agentId: string,
    fields: {
      status: RunStatus
      finishedAt: string
      costMicroUsd?: number | null
      meta?: string | null
    },
    expectedStartedAt?: string | null,
  ): Promise<RunRecord | null> {
    // Strict running → terminal transition: only the claiming agent, and only a run that is
    // actually running — a duplicate/retried finish can't clobber a settled run's cost, and a
    // finish can't terminate a never-claimed queued run. FENCED on started_at too, when
    // supplied — see requeueRun's twin comment: without it, a stale but unexpired token from
    // a claim a newer one has superseded can settle a run out from under the executor
    // actually working it.
    const rows = await this.db
      .update(run)
      .set({
        status: fields.status,
        finished_at: fields.finishedAt,
        ...addRunCost(fields.costMicroUsd),
        meta: fields.meta ?? null,
      })
      .where(
        and(
          eq(run.id, id),
          eq(run.agent_id, agentId),
          eq(run.status, "running"),
          expectedStartedAt === undefined
            ? undefined
            : expectedStartedAt === null
              ? isNull(run.started_at)
              : eq(run.started_at, expectedStartedAt),
        ),
      )
      .returning()
    return rows[0] ?? null
  }
  listRuns(orgId: string, limit = 50): Promise<RunRecord[]> {
    return this.db
      .select()
      .from(run)
      .where(eq(run.org_id, orgId))
      .orderBy(desc(run.created_at))
      .limit(limit)
  }
  async latestRunForAutomation(automationId: string, reason?: string): Promise<RunRecord | null> {
    const rows = await this.db
      .select()
      .from(run)
      .where(
        reason
          ? and(eq(run.automation_id, automationId), eq(run.reason, reason))
          : eq(run.automation_id, automationId),
      )
      .orderBy(sql`coalesce(${run.scheduled_for}, '') desc`)
      .limit(1)
    return rows[0] ?? null
  }
  async findCoalescibleRun(automationId: string, cutoffIso: string): Promise<RunRecord | null> {
    const rows = await this.db
      .select()
      .from(run)
      .where(
        and(
          eq(run.automation_id, automationId),
          eq(run.status, "queued"),
          lte(run.scheduled_for, cutoffIso),
        ),
      )
      .orderBy(desc(run.created_at))
      .limit(1)
    return rows[0] ?? null
  }
  async appendRunPayload(
    runId: string,
    payload: unknown,
    maxMetaBytes: number,
  ): Promise<RunRecord | null> {
    // Read the current meta, then CAS on it: the UPDATE applies only while the run is still
    // queued AND its meta is unchanged since the read. A concurrent claim (→ running) or a
    // racing append both fall through to null, and the caller enqueues a fresh run — so a
    // payload is never dropped, at worst an extra run is created under contention.
    const rows = await this.db
      .select()
      .from(run)
      .where(and(eq(run.id, runId), eq(run.status, "queued")))
    const row = rows[0]
    if (!row?.meta) return null
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(row.meta) as Record<string, unknown>
    } catch {
      return null
    }
    const payloads = Array.isArray(parsed.payloads) ? parsed.payloads : []
    const nextMeta = JSON.stringify({ ...parsed, payloads: [...payloads, payload] })
    if (nextMeta.length > maxMetaBytes) return null
    const updated = await this.db
      .update(run)
      .set({ meta: nextMeta })
      .where(and(eq(run.id, runId), eq(run.status, "queued"), eq(run.meta, row.meta)))
      .returning()
    return updated[0] ?? null
  }
  async createWorkflowRun(r: NewWorkflowRun): Promise<WorkflowRunRecord> {
    if (!isValidWorkflowRunDefinitionPin(r))
      throw new Error("workflow run requires a complete version pin")
    const createdAt = r.created_at ?? new Date().toISOString()
    const rows = await this.db
      .insert(workflowRun)
      .values({ ...r, created_at: createdAt, updated_at: createdAt })
      .returning()
    return one(rows)
  }
  async getWorkflowRun(id: string, orgId: string): Promise<WorkflowRunRecord | null> {
    const rows = await this.db
      .select()
      .from(workflowRun)
      .where(and(eq(workflowRun.id, id), eq(workflowRun.org_id, orgId)))
      .limit(1)
    return rows[0] ?? null
  }
  async getWorkflowRunById(id: string): Promise<WorkflowRunRecord | null> {
    const rows = await this.db.select().from(workflowRun).where(eq(workflowRun.id, id)).limit(1)
    return rows[0] ?? null
  }
  async getWorkflowRunByExternalRunId(externalRunId: string): Promise<WorkflowRunRecord | null> {
    const rows = await this.db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.external_run_id, externalRunId))
      .limit(1)
    return rows[0] ?? null
  }
  async listWorkflowRuns(
    workflowArtifactId: string,
    orgId: string,
    opts: { diagramId?: string; limit?: number } = {},
  ): Promise<WorkflowRunRecord[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 100))
    return this.db
      .select()
      .from(workflowRun)
      .where(
        and(
          eq(workflowRun.workflow_artifact_id, workflowArtifactId),
          eq(workflowRun.org_id, orgId),
          opts.diagramId ? eq(workflowRun.diagram_id, opts.diagramId) : undefined,
        ),
      )
      .orderBy(desc(workflowRun.created_at), desc(workflowRun.id))
      .limit(limit)
  }
  async transitionWorkflowRun(
    id: string,
    orgId: string,
    expected: WorkflowTransitionGuard,
    transition: WorkflowRunTransition,
  ): Promise<WorkflowRunRecord | null> {
    if (!workflowRunCanTransition(expected.status, transition.status)) return null
    if (!Number.isInteger(expected.stateRevision) || expected.stateRevision < 0) return null
    const firstStart =
      (expected.status === "queued" || expected.status === "dispatched") &&
      transition.status === "running"
    const dispatching = expected.status === "queued" && transition.status === "dispatched"
    const lane = transition.actualExecution
    const executorId = transition.executorId
    if (firstStart && (!lane || !executorId)) return null
    if (dispatching && (!transition.externalRunId || transition.externalExecution === undefined))
      return null
    const alreadyClaimed = expected.status === "running" || expected.status === "waiting"
    if (!firstStart && !alreadyClaimed && (lane || executorId)) return null
    if (alreadyClaimed && (!lane || !executorId)) return null
    const rows = await this.db
      .update(workflowRun)
      .set({
        status: transition.status,
        state_revision: sql`${workflowRun.state_revision} + 1`,
        updated_at: transition.at,
        ...(transition.status === "running"
          ? { started_at: sql`coalesce(${workflowRun.started_at}, ${transition.at})` }
          : {}),
        ...(workflowStatusIsTerminal(transition.status) ? { finished_at: transition.at } : {}),
        ...(firstStart ? { actual_execution: lane, executor_id: executorId } : {}),
        ...(transition.externalExecution !== undefined
          ? { external_execution: transition.externalExecution }
          : {}),
        ...(transition.externalRunId !== undefined
          ? { external_run_id: transition.externalRunId }
          : {}),
      })
      .where(
        and(
          eq(workflowRun.id, id),
          eq(workflowRun.org_id, orgId),
          eq(workflowRun.status, expected.status),
          eq(workflowRun.state_revision, expected.stateRevision),
          dispatching ? eq(workflowRun.requested_execution, "github_actions") : undefined,
          workflowStatusIsTerminal(transition.status)
            ? notExists(
                this.db
                  .select({ id: workflowStepAttempt.id })
                  .from(workflowStepAttempt)
                  .where(
                    and(
                      eq(workflowStepAttempt.workflow_run_id, workflowRun.id),
                      notInArray(workflowStepAttempt.status, ["succeeded", "failed", "cancelled"]),
                    ),
                  ),
              )
            : undefined,
          firstStart && lane && executorId
            ? or(
                eq(workflowRun.requested_execution, "any"),
                eq(workflowRun.requested_execution, lane),
              )
            : lane && executorId
              ? and(eq(workflowRun.actual_execution, lane), eq(workflowRun.executor_id, executorId))
              : undefined,
        ),
      )
      .returning()
    return rows[0] ?? null
  }
  async setWorkflowRunExternalReceipt(
    id: string,
    orgId: string,
    externalRunId: string,
    externalExecution: string,
    at: string,
  ): Promise<WorkflowRunRecord | null> {
    const rows = await this.db
      .update(workflowRun)
      .set({ external_execution: externalExecution, updated_at: at })
      .where(
        and(
          eq(workflowRun.id, id),
          eq(workflowRun.org_id, orgId),
          eq(workflowRun.external_run_id, externalRunId),
        ),
      )
      .returning()
    return rows[0] ?? null
  }
  async overrideSuccessfulWorkflowRunFromExternal(
    id: string,
    orgId: string,
    externalRunId: string,
    status: "failed" | "cancelled" | "timed_out",
    externalExecution: string,
    at: string,
  ): Promise<WorkflowRunRecord | null> {
    const rows = await this.db
      .update(workflowRun)
      .set({
        status,
        state_revision: sql`${workflowRun.state_revision} + 1`,
        external_execution: externalExecution,
        updated_at: at,
        finished_at: at,
      })
      .where(
        and(
          eq(workflowRun.id, id),
          eq(workflowRun.org_id, orgId),
          eq(workflowRun.external_run_id, externalRunId),
          eq(workflowRun.status, "succeeded"),
        ),
      )
      .returning()
    return rows[0] ?? null
  }
  async createWorkflowStepAttempt(
    orgId: string,
    a: NewWorkflowStepAttempt,
  ): Promise<WorkflowStepAttemptRecord> {
    if (!Number.isInteger(a.attempt) || a.attempt < 1)
      throw new Error("workflow step attempt must be a positive integer")
    if (!a.node_id.trim()) throw new Error("workflow step attempt requires a node id")
    if (!isValidWorkflowStepContextPin(a))
      throw new Error("workflow context attempts require a complete version pin")
    const createdAt = a.created_at ?? new Date().toISOString()
    const context = a.kind === "context" ? a : null
    const rows = await this.db
      .insert(workflowStepAttempt)
      .select(
        this.db
          .select({
            id: sql<string>`${a.id}`.as("id"),
            workflow_run_id: workflowRun.id,
            node_id: sql<string>`${a.node_id}`.as("node_id"),
            attempt: sql<number>`${a.attempt}`.as("attempt"),
            kind: sql<typeof a.kind>`${a.kind}`.as("kind"),
            status: sql<"queued">`'queued'`.as("status"),
            state_revision: sql<number>`0`.as("state_revision"),
            context_id: sql<string | null>`${context?.context_id ?? null}`.as("context_id"),
            context_manifest_artifact_id: sql<
              string | null
            >`${context?.context_manifest_artifact_id ?? null}`.as("context_manifest_artifact_id"),
            context_version: sql<number | null>`${context?.context_version ?? null}`.as(
              "context_version",
            ),
            context_blob_key: sql<string | null>`${context?.context_blob_key ?? null}`.as(
              "context_blob_key",
            ),
            context_content_type: sql<string | null>`${context?.context_content_type ?? null}`.as(
              "context_content_type",
            ),
            session_id: sql<string | null>`${context?.session_id ?? null}`.as("session_id"),
            decision: sql<null>`null`.as("decision"),
            selected_routes: sql<null>`null`.as("selected_routes"),
            route_basis: sql<null>`null`.as("route_basis"),
            result_artifact_id: sql<null>`null`.as("result_artifact_id"),
            output: sql<null>`null`.as("output"),
            error: sql<null>`null`.as("error"),
            created_at: sql<string>`${createdAt}`.as("created_at"),
            updated_at: sql<string>`${createdAt}`.as("updated_at"),
            started_at: sql<null>`null`.as("started_at"),
            finished_at: sql<null>`null`.as("finished_at"),
          })
          .from(workflowRun)
          .where(
            and(
              eq(workflowRun.id, a.workflow_run_id),
              eq(workflowRun.org_id, orgId),
              notInArray(workflowRun.status, ["succeeded", "failed", "cancelled"]),
            ),
          )
          .for("update"),
      )
      .returning()
    if (rows[0]) return rows[0]
    const parent = await this.getWorkflowRun(a.workflow_run_id, orgId)
    if (!parent) throw new Error("workflow run not found")
    throw new Error("workflow run is already terminal")
  }
  async getWorkflowStepAttemptBySession(
    sessionId: string,
    orgId: string,
  ): Promise<WorkflowStepAttemptRecord | null> {
    const rows = await this.db
      .select()
      .from(workflowStepAttempt)
      .where(
        and(
          eq(workflowStepAttempt.session_id, sessionId),
          inArray(
            workflowStepAttempt.workflow_run_id,
            this.db
              .select({ id: workflowRun.id })
              .from(workflowRun)
              .where(eq(workflowRun.org_id, orgId)),
          ),
        ),
      )
      .limit(1)
    return rows[0] ?? null
  }
  listWorkflowStepAttempts(
    workflowRunId: string,
    orgId: string,
  ): Promise<WorkflowStepAttemptRecord[]> {
    return this.db
      .select()
      .from(workflowStepAttempt)
      .where(
        and(
          eq(workflowStepAttempt.workflow_run_id, workflowRunId),
          inArray(
            workflowStepAttempt.workflow_run_id,
            this.db
              .select({ id: workflowRun.id })
              .from(workflowRun)
              .where(eq(workflowRun.org_id, orgId)),
          ),
        ),
      )
      .orderBy(
        asc(workflowStepAttempt.created_at),
        asc(workflowStepAttempt.node_id),
        asc(workflowStepAttempt.attempt),
        asc(workflowStepAttempt.id),
      )
  }
  async transitionWorkflowStepAttempt(
    id: string,
    workflowRunId: string,
    orgId: string,
    expected: WorkflowStepTransitionGuard,
    transition: WorkflowStepAttemptTransition,
  ): Promise<WorkflowStepAttemptRecord | null> {
    if (!workflowStepCanTransition(expected.status, transition.status)) return null
    if (!Number.isInteger(expected.stateRevision) || expected.stateRevision < 0) return null
    const starts = transition.status === "running" || transition.status === "waiting"
    const rows = await this.db
      .update(workflowStepAttempt)
      .set({
        status: transition.status,
        state_revision: sql`${workflowStepAttempt.state_revision} + 1`,
        updated_at: transition.at,
        ...(starts
          ? { started_at: sql`coalesce(${workflowStepAttempt.started_at}, ${transition.at})` }
          : {}),
        ...(workflowStatusIsTerminal(transition.status) ? { finished_at: transition.at } : {}),
        ...(transition.sessionId !== undefined ? { session_id: transition.sessionId } : {}),
        ...(transition.decision !== undefined ? { decision: transition.decision } : {}),
        ...(transition.selectedRoutes !== undefined
          ? { selected_routes: transition.selectedRoutes }
          : {}),
        ...(transition.routeBasis !== undefined ? { route_basis: transition.routeBasis } : {}),
        ...(transition.resultArtifactId !== undefined
          ? { result_artifact_id: transition.resultArtifactId }
          : {}),
        ...(transition.output !== undefined ? { output: transition.output } : {}),
        ...(transition.error !== undefined ? { error: transition.error } : {}),
      })
      .where(
        and(
          eq(workflowStepAttempt.id, id),
          eq(workflowStepAttempt.workflow_run_id, workflowRunId),
          eq(workflowStepAttempt.status, expected.status),
          eq(workflowStepAttempt.state_revision, expected.stateRevision),
          inArray(
            workflowStepAttempt.workflow_run_id,
            this.db
              .select({ id: workflowRun.id })
              .from(workflowRun)
              .where(eq(workflowRun.org_id, orgId)),
          ),
        ),
      )
      .returning()
    return rows[0] ?? null
  }
  async replaceSkillRelations(
    orgId: string,
    skillArtifactId: string,
    skillVersion: number,
    relations: NewSkillRelation[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(skillRelation)
        .where(
          and(
            eq(skillRelation.org_id, orgId),
            eq(skillRelation.source_artifact_id, skillArtifactId),
            eq(skillRelation.source_version, skillVersion),
          ),
        )
      if (relations.length > 0) await tx.insert(skillRelation).values(relations)
    })
  }
  listSkillRelations(skillArtifactId: string, orgId: string): Promise<SkillRelationRecord[]> {
    return this.db
      .select()
      .from(skillRelation)
      .where(
        and(
          eq(skillRelation.org_id, orgId),
          or(
            eq(skillRelation.source_artifact_id, skillArtifactId),
            eq(skillRelation.target_artifact_id, skillArtifactId),
          ),
        ),
      )
      .orderBy(desc(skillRelation.source_version), asc(skillRelation.kind))
  }
  async upsertSkillInstallation(i: NewSkillInstallation): Promise<SkillInstallationRecord> {
    const rows = await this.db
      .insert(skillInstallation)
      .values(i)
      .onConflictDoUpdate({
        target: [
          skillInstallation.org_id,
          skillInstallation.skill_artifact_id,
          skillInstallation.scope_kind,
          skillInstallation.opaque_scope_id,
          skillInstallation.client,
        ],
        set: {
          skill_version: i.skill_version,
          digest: i.digest,
          policy: i.policy,
          installed_by: i.installed_by ?? null,
          updated_at: i.updated_at,
          removed_at: i.removed_at ?? null,
        },
      })
      .returning()
    return one(rows)
  }
  listSkillInstallations(
    skillArtifactId: string,
    orgId: string,
  ): Promise<SkillInstallationRecord[]> {
    return this.db
      .select()
      .from(skillInstallation)
      .where(
        and(
          eq(skillInstallation.org_id, orgId),
          eq(skillInstallation.skill_artifact_id, skillArtifactId),
        ),
      )
      .orderBy(desc(skillInstallation.updated_at), asc(skillInstallation.client))
  }
  async linkArtifactSkill(link: NewArtifactSkillLink): Promise<ArtifactSkillLinkRecord> {
    const rows = await this.db
      .insert(artifactSkillLink)
      .values(link)
      .onConflictDoUpdate({
        target: [
          artifactSkillLink.artifact_id,
          artifactSkillLink.artifact_version,
          artifactSkillLink.skill_artifact_id,
          artifactSkillLink.skill_version,
          artifactSkillLink.role,
        ],
        set: { linked_by: link.linked_by },
      })
      .returning()
    return one(rows)
  }
  listArtifactSkillLinks(
    artifactId: string,
    artifactVersion: number,
    orgId: string,
  ): Promise<ArtifactSkillLinkRecord[]> {
    return this.db
      .select()
      .from(artifactSkillLink)
      .where(
        and(
          eq(artifactSkillLink.org_id, orgId),
          eq(artifactSkillLink.artifact_id, artifactId),
          eq(artifactSkillLink.artifact_version, artifactVersion),
        ),
      )
      .orderBy(asc(artifactSkillLink.role), asc(artifactSkillLink.skill_artifact_id))
  }
  listArtifactSkillLinkHistory(
    artifactId: string,
    orgId: string,
    limit = 100,
  ): Promise<ArtifactSkillLinkRecord[]> {
    return this.db
      .select()
      .from(artifactSkillLink)
      .where(
        and(eq(artifactSkillLink.org_id, orgId), eq(artifactSkillLink.artifact_id, artifactId)),
      )
      .orderBy(desc(artifactSkillLink.artifact_version), desc(artifactSkillLink.created_at))
      .limit(Math.max(1, Math.min(limit, 100)))
  }
  listSkillArtifactLinks(
    skillArtifactId: string,
    orgId: string,
    limit = 100,
  ): Promise<ArtifactSkillLinkRecord[]> {
    return this.db
      .select()
      .from(artifactSkillLink)
      .where(
        and(
          eq(artifactSkillLink.org_id, orgId),
          eq(artifactSkillLink.skill_artifact_id, skillArtifactId),
        ),
      )
      .orderBy(desc(artifactSkillLink.created_at), desc(artifactSkillLink.id))
      .limit(Math.max(1, Math.min(limit, 100)))
  }
  async skillUsage(
    skillArtifactId: string,
    orgId: string,
  ): Promise<{ contexts: SkillUsageBucket[]; workflows: SkillUsageBucket[] }> {
    const contextRows = await this.db
      .select({
        skill_version: contextSession.context_version,
        count: count(),
        last_used_at: max(contextSession.created_at),
      })
      .from(contextSession)
      .innerJoin(context, eq(context.id, contextSession.context_id))
      .where(and(eq(context.org_id, orgId), eq(context.manifest_artifact_id, skillArtifactId)))
      .groupBy(contextSession.context_version)
      .orderBy(desc(contextSession.context_version))
    const workflowRows = await this.db
      .select({
        skill_version: artifactSkillLink.skill_version,
        count: count(),
        last_used_at: max(workflowRun.created_at),
      })
      .from(workflowRun)
      .innerJoin(
        artifactSkillLink,
        and(
          eq(artifactSkillLink.artifact_id, workflowRun.workflow_artifact_id),
          eq(artifactSkillLink.artifact_version, workflowRun.workflow_version),
        ),
      )
      .where(
        and(
          eq(workflowRun.org_id, orgId),
          eq(artifactSkillLink.org_id, orgId),
          eq(artifactSkillLink.skill_artifact_id, skillArtifactId),
          eq(artifactSkillLink.role, "workflow-definition"),
        ),
      )
      .groupBy(artifactSkillLink.skill_version)
      .orderBy(desc(artifactSkillLink.skill_version))
    const buckets = (
      rows: Array<{
        skill_version: number | null
        count: number | bigint
        last_used_at: string | null
      }>,
    ): SkillUsageBucket[] =>
      rows.flatMap((row) =>
        row.last_used_at && row.skill_version !== null
          ? [
              {
                skill_version: row.skill_version,
                count: Number(row.count),
                last_used_at: row.last_used_at,
              },
            ]
          : [],
      )
    return { contexts: buckets(contextRows), workflows: buckets(workflowRows) }
  }
  async createPlan(p: NewPlan): Promise<PlanRecord> {
    const rows = await this.db.insert(plan).values(p).returning()
    return one(rows)
  }
  async getPlan(id: string): Promise<PlanRecord | null> {
    const rows = await this.db.select().from(plan).where(eq(plan.id, id))
    return rows[0] ?? null
  }
  listPlans(orgId: string): Promise<PlanRecord[]> {
    return this.db.select().from(plan).where(eq(plan.org_id, orgId)).orderBy(desc(plan.created_at))
  }
  async deletePlan(id: string, orgId: string): Promise<void> {
    await this.db.delete(plan).where(and(eq(plan.id, id), eq(plan.org_id, orgId)))
  }
  async resolvePlan(
    orgId: string,
    userId: string | null,
    kind: PlanKind,
  ): Promise<PlanRecord | null> {
    // Money falls back: a personal plan first, then the workspace pool (user_id null).
    if (userId) {
      const personal = await this.db
        .select()
        .from(plan)
        .where(and(eq(plan.org_id, orgId), eq(plan.user_id, userId), eq(plan.kind, kind)))
        .orderBy(desc(plan.created_at))
        .limit(1)
      if (personal[0]) return personal[0]
    }
    const pool = await this.db
      .select()
      .from(plan)
      .where(and(eq(plan.org_id, orgId), isNull(plan.user_id), eq(plan.kind, kind)))
      .orderBy(desc(plan.created_at))
      .limit(1)
    return pool[0] ?? null
  }
  async sumRunCostSince(orgId: string, sinceIso: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${run.cost_micro_usd}), 0)` })
      .from(run)
      .where(and(eq(run.org_id, orgId), gte(run.created_at, sinceIso)))
    return Number(rows[0]?.total ?? 0)
  }
  async createConnection(cn: NewConnection): Promise<ConnectionRecord> {
    const rows = await this.db.insert(connection).values(cn).returning()
    return one(rows)
  }
  async getConnection(id: string): Promise<ConnectionRecord | null> {
    const rows = await this.db.select().from(connection).where(eq(connection.id, id))
    return rows[0] ?? null
  }
  async getConnectionsByIds(ids: string[]): Promise<ConnectionRecord[]> {
    if (ids.length === 0) return []
    return this.db.select().from(connection).where(inArray(connection.id, ids))
  }
  listConnections(
    orgId: string,
    userId?: string,
    scope?: ConnectionScope,
  ): Promise<ConnectionRecord[]> {
    const wh = [eq(connection.org_id, orgId)]
    if (userId) wh.push(eq(connection.user_id, userId))
    if (scope) wh.push(eq(connection.scope, scope))
    return this.db
      .select()
      .from(connection)
      .where(and(...wh))
      .orderBy(desc(connection.created_at))
  }
  async setConnectionStatus(
    id: string,
    orgId: string,
    status: ConnectionStatus,
  ): Promise<ConnectionRecord | null> {
    const rows = await this.db
      .update(connection)
      .set({ status })
      .where(and(eq(connection.id, id), eq(connection.org_id, orgId)))
      .returning()
    return rows[0] ?? null
  }
  async updateConnectionCredential(
    id: string,
    orgId: string,
    fields: {
      secret_enc?: string | null
      broker_ref?: string
      status?: ConnectionStatus
      scopes_label?: string | null
    },
    expectSecretEnc?: string | null,
  ): Promise<ConnectionRecord | null> {
    const set: Record<string, unknown> = {}
    if (fields.secret_enc !== undefined) set.secret_enc = fields.secret_enc
    if (fields.broker_ref !== undefined) set.broker_ref = fields.broker_ref
    if (fields.status !== undefined) set.status = fields.status
    if (fields.scopes_label !== undefined) set.scopes_label = fields.scopes_label
    if (Object.keys(set).length === 0) return this.getConnection(id)
    // The compare-and-swap rides IN the WHERE clause, so the check and the write are one
    // statement. Reading first and then writing would leave the window this exists to close.
    const guard =
      expectSecretEnc === undefined
        ? undefined
        : expectSecretEnc === null
          ? isNull(connection.secret_enc)
          : eq(connection.secret_enc, expectSecretEnc)
    const rows = await this.db
      .update(connection)
      .set(set)
      .where(
        guard
          ? and(eq(connection.id, id), eq(connection.org_id, orgId), guard)
          : and(eq(connection.id, id), eq(connection.org_id, orgId)),
      )
      .returning()
    return rows[0] ?? null
  }
  async getAgentByToken(token: string): Promise<AgentRecord | null> {
    const rows = await this.db.select().from(agent).where(eq(agent.token, token))
    return rows[0] ?? null
  }
  async getAgent(id: string): Promise<AgentRecord | null> {
    const rows = await this.db.select().from(agent).where(eq(agent.id, id))
    return rows[0] ?? null
  }
  async getOAuthGrant(tokenHash: string): Promise<OAuthGrant | null> {
    // Better Auth oauth-provider tables live in the same pg database; quoted
    // identifiers preserve their camelCase. The hash is bound ($1), not inlined.
    type GrantRow = {
      user_id: string
      user_email: string
      user_name: string | null
      client_id: string
      // node-postgres returns json/jsonb columns already parsed, so this can be a
      // real array; text columns stay strings. parseOAuthScopes handles both.
      scopes: string | string[] | null
      expires_at: Date | string | number
      client_name: string
    }
    let row: GrantRow | undefined
    try {
      const { rows } = await this.pool.query(
        `SELECT t."userId" AS user_id, t."clientId" AS client_id, t."scopes" AS scopes,
                t."expiresAt" AS expires_at, c."name" AS client_name,
                u."email" AS user_email, u."name" AS user_name
           FROM "oauthAccessToken" t
           JOIN "oauthClient" c ON c."clientId" = t."clientId"
           JOIN "user" u ON u."id" = t."userId"
          WHERE t."token" = $1 LIMIT 1`,
        [tokenHash],
      )
      row = rows[0] as GrantRow | undefined
    } catch {
      // OAuth tables absent (oidc-provider not migrated) or query error: no grant.
      return null
    }
    if (!row) return null
    return {
      userId: row.user_id,
      userEmail: row.user_email,
      userName: row.user_name,
      clientId: row.client_id,
      clientName: row.client_name,
      scopes: parseOAuthScopes(row.scopes),
      expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    }
  }
  async oauthGrantWithWorkspaces(tokenHash: string): Promise<{
    grant: OAuthGrant
    mine: (WorkspaceRecord & { role: Role })[]
    bound: string[]
    orgContext?: OAuthGrantWorkspaceRead["orgContext"]
  } | null> {
    type Row = { kind: string; doc: unknown }
    type GrantRow = {
      user_id: string
      user_email: string
      user_name: string | null
      client_id: string
      scopes: string | string[] | null
      expires_at: Date | string | number
      client_name: string
    }
    type WorkspaceRow = WorkspaceRecord & { role: Role; bound: boolean }
    type ContextRow = {
      org_id: string
      settings: string | null
      personal_brandprint: string | null
    }
    let rows: Row[]
    try {
      rows = (
        await this.pool.query<Row>(
          `WITH g AS (
             SELECT t."userId" AS user_id, t."clientId" AS client_id,
                    t."scopes" AS scopes, t."expiresAt" AS expires_at,
                    c."name" AS client_name, u."email" AS user_email,
                    u."name" AS user_name
               FROM "oauthAccessToken" t
               JOIN "oauthClient" c ON c."clientId" = t."clientId"
               JOIN "user" u ON u."id" = t."userId"
              WHERE t."token" = $1 LIMIT 1
           ), w AS (
             SELECT ws.id, ws.name, ws.created_at, m.role,
                    (ocw.id IS NOT NULL) AS bound
               FROM g
               JOIN membership m ON m.user_id = g.user_id
               JOIN workspace ws ON ws.id = m.org_id
               LEFT JOIN oauth_client_workspace ocw
                 ON ocw.org_id = ws.id AND ocw.user_id = g.user_id
                AND ocw.client_id = g.client_id
           ), target AS (
             SELECT w.id
               FROM w
              ORDER BY
                CASE WHEN EXISTS (SELECT 1 FROM w WHERE bound) AND NOT w.bound THEN 1 ELSE 0 END,
                w.created_at
              LIMIT 1
           )
           SELECT 'grant' kind, row_to_json(g) doc FROM g
           UNION ALL
           SELECT 'workspace', row_to_json(w) FROM (SELECT * FROM w ORDER BY created_at) w
           UNION ALL
           SELECT 'context', json_build_object(
             'org_id', target.id,
             'settings', os.settings,
             'personal_brandprint', to_jsonb(u) ->> 'brandprint'
           )
             FROM target
             JOIN g ON true
             JOIN "user" u ON u.id = g.user_id
             LEFT JOIN org_settings os ON os.org_id = target.id`,
          [tokenHash],
        )
      ).rows
    } catch {
      return null
    }
    const grantRow = rows.find((row) => row.kind === "grant")?.doc as GrantRow | undefined
    if (!grantRow) return null
    const workspaceRows = rows
      .filter((row) => row.kind === "workspace")
      .map((row) => row.doc as WorkspaceRow)
    const contextRow = rows.find((row) => row.kind === "context")?.doc as ContextRow | undefined
    return {
      grant: {
        userId: grantRow.user_id,
        userEmail: grantRow.user_email,
        userName: grantRow.user_name,
        clientId: grantRow.client_id,
        clientName: grantRow.client_name,
        scopes: parseOAuthScopes(grantRow.scopes),
        expiresAt:
          grantRow.expires_at instanceof Date ? grantRow.expires_at : new Date(grantRow.expires_at),
      },
      mine: workspaceRows.map(({ bound: _bound, ...workspace }) => workspace),
      bound: workspaceRows.filter((workspace) => workspace.bound).map((workspace) => workspace.id),
      orgContext: contextRow
        ? {
            orgId: contextRow.org_id,
            settings: parseOrgSettings(contextRow.settings),
            personalBrandprint: contextRow.personal_brandprint,
          }
        : undefined,
    }
  }
  async getOAuthClientName(clientId: string): Promise<string | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT "name" AS name FROM "oauthClient" WHERE "clientId" = $1 LIMIT 1`,
        [clientId],
      )
      return (rows[0] as { name?: string | null } | undefined)?.name ?? null
    } catch {
      return null
    }
  }
  async oauthClientExists(clientId: string): Promise<boolean> {
    try {
      const { rows } = await this.pool.query(
        `SELECT 1 FROM "oauthClient" WHERE "clientId" = $1 LIMIT 1`,
        [clientId],
      )
      return rows.length > 0
    } catch {
      return false
    }
  }
  // Replace the whole granted-workspace SET for (user, client). Empty array clears
  // it → the grant reverts to "all workspaces". See schema.ts for the model.
  async setOAuthClientWorkspaces(
    userId: string,
    clientId: string,
    orgIds: string[],
  ): Promise<void> {
    await this.db
      .delete(oauthClientWorkspace)
      .where(
        and(eq(oauthClientWorkspace.user_id, userId), eq(oauthClientWorkspace.client_id, clientId)),
      )
    for (const orgId of orgIds) {
      await this.db
        .insert(oauthClientWorkspace)
        .values({ id: crypto.randomUUID(), user_id: userId, client_id: clientId, org_id: orgId })
        .onConflictDoNothing()
    }
  }
  // The grant's scoped workspaces. Empty array = "all workspaces" (unscoped).
  async getOAuthClientWorkspaces(userId: string, clientId: string): Promise<string[]> {
    const rows = await this.db
      .select({ org_id: oauthClientWorkspace.org_id })
      .from(oauthClientWorkspace)
      .where(
        and(eq(oauthClientWorkspace.user_id, userId), eq(oauthClientWorkspace.client_id, clientId)),
      )
    return rows.map((r) => r.org_id)
  }
  async pruneStaleOAuthClients(cutoffIso: string): Promise<number> {
    try {
      const res = await this.pool.query(
        `DELETE FROM "oauthClient" WHERE "userId" IS NULL AND "createdAt" < $1
           AND "clientId" NOT IN (SELECT "clientId" FROM "oauthConsent")
           AND "clientId" NOT IN (SELECT "clientId" FROM "oauthAccessToken")`,
        [cutoffIso],
      )
      // Workspace bindings for clients that no longer exist (pruned above, or
      // any earlier sweep) have nothing left to resolve against — sweep them too.
      await this.pool.query(
        `DELETE FROM oauth_client_workspace
          WHERE client_id NOT IN (SELECT "clientId" FROM "oauthClient")`,
      )
      return res.rowCount ?? 0
    } catch {
      return 0
    }
  }
  async firstAgentPublish(
    userId: string,
  ): Promise<{ short_id: string; title: string | null } | null> {
    // The first artifact an agent produced FOR this user: the earliest direct MCP
    // publish. Mirrors repos.ts.
    const direct = (
      await this.db
        .select({ short_id: artifact.short_id, title: artifact.title, at: version.created_at })
        .from(version)
        .innerJoin(artifact, eq(artifact.id, version.artifact_id))
        .where(
          and(
            eq(version.author_id, userId),
            eq(version.source, "mcp"),
            isNull(artifact.removed_at),
          ),
        )
        .orderBy(asc(version.created_at), asc(version.id))
        .limit(1)
    )[0]
    return direct ? { short_id: direct.short_id, title: direct.title } : null
  }
  async listUserGrants(userId: string): Promise<OAuthGrantSummary[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT k."clientId" AS client_id, c."name" AS client_name,
                k."scopes" AS scopes, k."updatedAt" AS granted_at
           FROM "oauthConsent" k
           JOIN "oauthClient" c ON c."clientId" = k."clientId"
          WHERE k."userId" = $1
          ORDER BY k."updatedAt" DESC`,
        [userId],
      )
      return (
        rows as {
          client_id: string
          client_name: string | null
          scopes: string | string[] | null
          granted_at: Date | string | null
        }[]
      ).map((r) => ({
        clientId: r.client_id,
        clientName: r.client_name || r.client_id,
        scopes: parseOAuthScopes(r.scopes),
        grantedAt: (r.granted_at instanceof Date
          ? r.granted_at
          : new Date(r.granted_at ?? Date.now())
        ).toISOString(),
      }))
    } catch {
      return []
    }
  }
  async revokeUserGrant(userId: string, clientId: string): Promise<void> {
    for (const table of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"]) {
      try {
        await this.pool.query(`DELETE FROM "${table}" WHERE "userId" = $1 AND "clientId" = $2`, [
          userId,
          clientId,
        ])
      } catch {
        // Table absent on this deploy → skip; the others still run.
      }
    }
  }
  async deleteAgent(id: string, orgId: string): Promise<void> {
    await this.db.delete(agent).where(and(eq(agent.id, id), eq(agent.org_id, orgId)))
  }
  async createAgentMention(m: NewAgentMention): Promise<void> {
    // See the SQLite store: a stable thread-reply id makes an outbox recovery idempotent.
    await this.db.insert(agentMention).values(m).onConflictDoNothing()
  }
  // ---- Instance operators ------------------------------------------------
  async isInstanceOperator(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ user_id: instanceOperator.user_id })
      .from(instanceOperator)
      .where(eq(instanceOperator.user_id, userId))
      .limit(1)
    return rows.length > 0
  }
  async hasInstanceOperators(): Promise<boolean> {
    const rows = await this.db
      .select({ user_id: instanceOperator.user_id })
      .from(instanceOperator)
      .limit(1)
    return rows.length > 0
  }
  async addInstanceOperator(userId: string): Promise<void> {
    await this.db.insert(instanceOperator).values({ user_id: userId }).onConflictDoNothing()
  }
  // ---- Workspace invitations ---------------------------------------------
  async createInvitation(i: NewInvitation): Promise<InvitationRecord> {
    const rows = await this.db.insert(invitation).values(i).returning()
    return one(rows) as InvitationRecord
  }
  async getInvitationByToken(tokenHash: string): Promise<InvitationRecord | null> {
    const rows = await this.db.select().from(invitation).where(eq(invitation.token, tokenHash))
    return (rows[0] as InvitationRecord | undefined) ?? null
  }
  listPendingInvitations(orgId: string): Promise<InvitationRecord[]> {
    return this.db
      .select()
      .from(invitation)
      .where(and(eq(invitation.org_id, orgId), isNull(invitation.accepted_at)))
      .orderBy(desc(invitation.created_at)) as Promise<InvitationRecord[]>
  }
  async deletePendingInvitationsFor(orgId: string, email: string): Promise<void> {
    await this.db
      .delete(invitation)
      .where(
        and(
          eq(invitation.org_id, orgId),
          eq(invitation.email, email),
          isNull(invitation.accepted_at),
        ),
      )
  }
  async deleteInvitation(id: string, orgId: string): Promise<void> {
    await this.db.delete(invitation).where(and(eq(invitation.id, id), eq(invitation.org_id, orgId)))
  }
  async consumeInvitation(id: string, now: string): Promise<boolean> {
    const rows = await this.db
      .update(invitation)
      .set({ accepted_at: now })
      .where(
        and(eq(invitation.id, id), isNull(invitation.accepted_at), gt(invitation.expires_at, now)),
      )
      .returning({ id: invitation.id })
    return rows.length > 0
  }

  // ---- Signup attribution ----------------------------------------------------
  async recordSignupAttribution(a: NewSignupAttribution): Promise<void> {
    // The unique user_id index makes a duplicate hook fire a no-op — first write
    // wins, so the attribution of record stays the one captured at signup time.
    await this.db.insert(signupAttribution).values(a).onConflictDoNothing()
  }

  async getSignupAttribution(userId: string): Promise<SignupAttributionRecord | null> {
    const rows = await this.db
      .select()
      .from(signupAttribution)
      .where(eq(signupAttribution.user_id, userId))
      .limit(1)
    return rows[0] ?? null
  }

  // ---- Artifact invitations ------------------------------------------------
  async createArtifactInvite(i: NewArtifactInvite): Promise<ArtifactInviteRecord> {
    const rows = await this.db.insert(artifactInvite).values(i).returning()
    return one(rows) as ArtifactInviteRecord
  }
  async getArtifactInviteByToken(tokenHash: string): Promise<ArtifactInviteRecord | null> {
    const rows = await this.db
      .select()
      .from(artifactInvite)
      .where(eq(artifactInvite.token, tokenHash))
    return (rows[0] as ArtifactInviteRecord | undefined) ?? null
  }
  listPendingArtifactInvites(artifactId: string): Promise<ArtifactInviteRecord[]> {
    return this.db
      .select()
      .from(artifactInvite)
      .where(and(eq(artifactInvite.artifact_id, artifactId), isNull(artifactInvite.accepted_at)))
      .orderBy(desc(artifactInvite.created_at)) as Promise<ArtifactInviteRecord[]>
  }
  async deletePendingArtifactInvitesFor(artifactId: string, email: string): Promise<void> {
    await this.db
      .delete(artifactInvite)
      .where(
        and(
          eq(artifactInvite.artifact_id, artifactId),
          eq(artifactInvite.email, email),
          isNull(artifactInvite.accepted_at),
        ),
      )
  }
  async deleteArtifactInvite(id: string, artifactId: string): Promise<void> {
    await this.db
      .delete(artifactInvite)
      .where(and(eq(artifactInvite.id, id), eq(artifactInvite.artifact_id, artifactId)))
  }
  async consumeArtifactInvite(id: string, now: string): Promise<boolean> {
    const rows = await this.db
      .update(artifactInvite)
      .set({ accepted_at: now })
      .where(
        and(
          eq(artifactInvite.id, id),
          isNull(artifactInvite.accepted_at),
          gt(artifactInvite.expires_at, now),
        ),
      )
      .returning({ id: artifactInvite.id })
    return rows.length > 0
  }
  // ---- Collection invitations ---------------------------------------------
  async createCollectionInvite(i: NewCollectionInvite): Promise<CollectionInviteRecord> {
    const rows = await this.db.insert(collectionInvite).values(i).returning()
    return one(rows) as CollectionInviteRecord
  }
  async getCollectionInviteByToken(tokenHash: string): Promise<CollectionInviteRecord | null> {
    const rows = await this.db
      .select()
      .from(collectionInvite)
      .where(eq(collectionInvite.token, tokenHash))
    return (rows[0] as CollectionInviteRecord | undefined) ?? null
  }
  listPendingCollectionInvites(collectionId: string): Promise<CollectionInviteRecord[]> {
    return this.db
      .select()
      .from(collectionInvite)
      .where(
        and(eq(collectionInvite.collection_id, collectionId), isNull(collectionInvite.accepted_at)),
      )
      .orderBy(desc(collectionInvite.created_at)) as Promise<CollectionInviteRecord[]>
  }
  async deletePendingCollectionInvitesFor(collectionId: string, email: string): Promise<void> {
    await this.db
      .delete(collectionInvite)
      .where(
        and(
          eq(collectionInvite.collection_id, collectionId),
          eq(collectionInvite.email, email),
          isNull(collectionInvite.accepted_at),
        ),
      )
  }
  async deleteCollectionInvite(id: string, collectionId: string): Promise<void> {
    await this.db
      .delete(collectionInvite)
      .where(and(eq(collectionInvite.id, id), eq(collectionInvite.collection_id, collectionId)))
  }
  async consumeCollectionInvite(id: string, now: string): Promise<boolean> {
    const rows = await this.db
      .update(collectionInvite)
      .set({ accepted_at: now })
      .where(
        and(
          eq(collectionInvite.id, id),
          isNull(collectionInvite.accepted_at),
          gt(collectionInvite.expires_at, now),
        ),
      )
      .returning({ id: collectionInvite.id })
    return rows.length > 0
  }
  // ---- Account deletion cascade (see MetaStore.deleteUserData) ------------
  async deleteUserData(userId: string): Promise<void> {
    await this.db.delete(instanceOperator).where(eq(instanceOperator.user_id, userId))
    const personalOrg = `ws_p_${userId}`
    const ownedLibraries = await this.db
      .select()
      .from(templateLibrary)
      .where(eq(templateLibrary.created_by, userId))
    const deletedLibraryIds = ownedLibraries
      .filter((library) => library.scope === "private" || library.org_id === personalOrg)
      .map((library) => library.id)
    if (deletedLibraryIds.length) {
      await this.db.transaction(async (tx) => {
        await tx
          .delete(templateLibraryEntry)
          .where(inArray(templateLibraryEntry.library_id, deletedLibraryIds))
        await tx.delete(templateLibrary).where(inArray(templateLibrary.id, deletedLibraryIds))
      })
    }
    for (const library of ownedLibraries) {
      if (deletedLibraryIds.includes(library.id)) continue
      const managers = await this.db
        .select()
        .from(membership)
        .where(and(eq(membership.org_id, library.org_id), ne(membership.user_id, userId)))
        .orderBy(asc(membership.created_at), asc(membership.user_id))
      const manager =
        managers.find((member) => member.role === "owner") ??
        managers.find((member) => member.role === "editor")
      const replacement = manager?.user_id ?? "__deleted_template_library_owner__"
      await this.db
        .update(templateLibrary)
        .set({ created_by: replacement, updated_at: new Date().toISOString() })
        .where(eq(templateLibrary.id, library.id))
      await this.db
        .update(templateLibraryEntry)
        .set({ created_by: replacement })
        .where(
          and(
            eq(templateLibraryEntry.library_id, library.id),
            eq(templateLibraryEntry.created_by, userId),
          ),
        )
    }
    await this.db
      .update(templateLibraryEntry)
      .set({ created_by: "__deleted_template_library_owner__" })
      .where(eq(templateLibraryEntry.created_by, userId))
    await this.db.delete(membership).where(eq(membership.user_id, userId))
    await this.db.delete(artifactMember).where(eq(artifactMember.user_id, userId))
    await this.db.delete(collectionMember).where(eq(collectionMember.user_id, userId))
    await this.db.delete(follow).where(eq(follow.user_id, userId))
    await this.db.delete(artifactFavorite).where(eq(artifactFavorite.user_id, userId))
    await this.db.delete(notification).where(eq(notification.user_id, userId))
    // Encrypted plan tokens must not linger after the account is gone; the workspace pool's
    // sentinel-user row is keyed differently, so it is never in scope.
    await this.db.delete(modelCredential).where(eq(modelCredential.user_id, userId))
    await this.db.update(artifact).set({ author_id: null }).where(eq(artifact.author_id, userId))
    await this.db.update(version).set({ author_id: null }).where(eq(version.author_id, userId))
    await this.db.update(comment).set({ author_id: null }).where(eq(comment.author_id, userId))
    await this.db.update(agent).set({ created_by: null }).where(eq(agent.created_by, userId))
    await this.db
      .update(invitation)
      .set({ invited_by: null })
      .where(eq(invitation.invited_by, userId))
    await this.db
      .update(artifactInvite)
      .set({ invited_by: null })
      .where(eq(artifactInvite.invited_by, userId))
    await this.db
      .update(collectionInvite)
      .set({ invited_by: null })
      .where(eq(collectionInvite.invited_by, userId))
    await this.db.delete(workspace).where(eq(workspace.id, personalOrg))
  }
  listPendingAgentMentions(agentId: string, limit: number): Promise<AgentMentionRecord[]> {
    return this.db
      .select()
      .from(agentMention)
      .where(and(eq(agentMention.agent_id, agentId), eq(agentMention.state, "pending")))
      .orderBy(asc(agentMention.created_at))
      .limit(limit)
  }
  async ackAgentMention(agentId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(agentMention)
      .set({ state: "done" })
      .where(and(eq(agentMention.id, id), eq(agentMention.agent_id, agentId)))
      .returning({ id: agentMention.id })
    return rows.length > 0
  }

  // ---- Moderation: reports, takedown, audit log --------------------------
  async createReport(r: NewReport): Promise<ReportRecord> {
    const rows = await this.db.insert(report).values(r).returning()
    return one(rows)
  }
  async getReport(id: string, orgId?: string): Promise<ReportRecord | null> {
    const rows = await this.db
      .select()
      .from(report)
      .where(and(eq(report.id, id), orgId ? eq(report.org_id, orgId) : undefined))
    return rows[0] ?? null
  }
  listReports(
    orgId: string | undefined,
    opts?: { state?: ReportState; limit?: number },
  ): Promise<ReportRecord[]> {
    const q = this.db
      .select()
      .from(report)
      .where(
        and(
          orgId ? eq(report.org_id, orgId) : undefined,
          opts?.state ? eq(report.state, opts.state) : undefined,
        ),
      )
      .orderBy(desc(report.created_at))
    return opts?.limit ? q.limit(opts.limit) : q
  }
  async countOpenReports(orgId: string | undefined): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(report)
      .where(and(eq(report.state, "open"), orgId ? eq(report.org_id, orgId) : undefined))
    return Number(rows[0]?.n ?? 0)
  }
  async setReportState(id: string, state: ReportState, orgId?: string): Promise<void> {
    await this.db
      .update(report)
      .set({ state })
      .where(and(eq(report.id, id), orgId ? eq(report.org_id, orgId) : undefined))
  }
  async setArtifactRemoved(id: string, removedAt: string | null): Promise<void> {
    await this.db.update(artifact).set({ removed_at: removedAt }).where(eq(artifact.id, id))
  }
  async setArtifactsRemoved(ids: string[], removedAt: string | null): Promise<void> {
    if (ids.length === 0) return
    await this.db.update(artifact).set({ removed_at: removedAt }).where(inArray(artifact.id, ids))
  }
  async setArtifactArchived(id: string, archivedAt: string | null): Promise<void> {
    await this.db.update(artifact).set({ archived_at: archivedAt }).where(eq(artifact.id, id))
  }
  async setArtifactsArchived(ids: string[], archivedAt: string | null): Promise<void> {
    if (ids.length === 0) return
    await this.db.update(artifact).set({ archived_at: archivedAt }).where(inArray(artifact.id, ids))
  }
  async setArtifactTitle(id: string, title: string, slug?: string | null): Promise<void> {
    await this.db
      .update(artifact)
      .set(slug === undefined ? { title } : { title, slug })
      .where(eq(artifact.id, id))
  }
  async setArtifactUpdatedAt(id: string, updatedAt: string): Promise<void> {
    await this.db.update(artifact).set({ updated_at: updatedAt }).where(eq(artifact.id, id))
  }
  async createAuditLog(a: NewAuditLog): Promise<void> {
    await this.db.insert(auditLog).values(a)
  }
  // Atomic delete: all FK-dependent rows and the artifact row commit together.
  async deleteArtifact(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // A context's manifest FK means deleting a manifest deletes its context
      // (and sessions) — a context cannot outlive its definition, by design.
      // Subqueries, matching the sqlite/d1 layer (D1 bound-parameter cap).
      const ctxIds = tx
        .select({ id: context.id })
        .from(context)
        .where(eq(context.manifest_artifact_id, id))
      await tx
        .delete(sessionMessage)
        .where(
          inArray(
            sessionMessage.session_id,
            tx
              .select({ id: contextSession.id })
              .from(contextSession)
              .where(inArray(contextSession.context_id, ctxIds)),
          ),
        )
      await tx.delete(contextSession).where(inArray(contextSession.context_id, ctxIds))
      await tx.delete(context).where(eq(context.manifest_artifact_id, id))
      await tx.delete(reviewRound).where(eq(reviewRound.artifact_id, id))
      // Artifact-SCOPED webhooks only; a workspace-wide one has a null artifact_id and
      // survives. Found by scripts/check-delete-cascade.mjs.
      await tx.delete(webhook).where(eq(webhook.artifact_id, id))
      await tx.delete(sharedStateActivity).where(eq(sharedStateActivity.artifact_id, id))
      await tx.delete(sharedState).where(eq(sharedState.artifact_id, id))
      await tx
        .delete(skillRelation)
        .where(
          or(eq(skillRelation.source_artifact_id, id), eq(skillRelation.target_artifact_id, id)),
        )
      await tx.delete(skillInstallation).where(eq(skillInstallation.skill_artifact_id, id))
      await tx
        .delete(artifactSkillLink)
        .where(
          or(eq(artifactSkillLink.artifact_id, id), eq(artifactSkillLink.skill_artifact_id, id)),
        )
      await tx.delete(versionData).where(eq(versionData.artifact_id, id))
      await tx.delete(version).where(eq(version.artifact_id, id))
      await tx.delete(comment).where(eq(comment.artifact_id, id))
      await tx.delete(artifactMember).where(eq(artifactMember.artifact_id, id))
      await tx.delete(artifactInvite).where(eq(artifactInvite.artifact_id, id))
      await tx.delete(artifactFavorite).where(eq(artifactFavorite.artifact_id, id))
      await tx.delete(artifactTag).where(eq(artifactTag.artifact_id, id))
      await tx.delete(collectionItem).where(eq(collectionItem.artifact_id, id))
      await tx.delete(domain).where(eq(domain.artifact_id, id))
      await tx.delete(report).where(eq(report.artifact_id, id))
      await tx.delete(notification).where(eq(notification.artifact_id, id))
      await tx.delete(agentMention).where(eq(agentMention.artifact_id, id))
      await tx.delete(slackThreadLink).where(eq(slackThreadLink.artifact_id, id))
      // The view ledger is a raw-DDL table (ddl.ts placeholderTables), NOT a drizzle
      // model — so scripts/check-delete-cascade.mjs cannot see it, and it was missed
      // here while carrying a NOT NULL FK to artifact(id). Postgres enforces that FK,
      // so deleting any artifact that had ever logged a view rolled the whole
      // transaction back (a production 500 the embedded suite could not reproduce:
      // better-sqlite3 runs with FK enforcement off). Raw SQL, matching the writes.
      await tx.execute(sql`DELETE FROM view_read WHERE artifact_id = ${id}`)
      await tx.execute(sql`DELETE FROM view WHERE artifact_id = ${id}`)
      await tx.delete(artifact).where(eq(artifact.id, id))
    })
    // Drop the search-index row after the delete commits (the tombstone table isn't a
    // drizzle model, so it stays outside the tx). An orphaned row left by a crash here
    // is harmless: listArtifacts filters the now-deleted artifact out of any result.
    await this.unindexArtifact(id)
  }

  // Atomic move: org_id flips, collection membership and any artifact-targeted
  // webhook detach, all in one commit.
  async moveArtifactOrg(artifactId: string, targetOrgId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(artifact).set({ org_id: targetOrgId }).where(eq(artifact.id, artifactId))
      await tx.delete(collectionItem).where(eq(collectionItem.artifact_id, artifactId))
      await tx.update(webhook).set({ artifact_id: null }).where(eq(webhook.artifact_id, artifactId))
    })
    // Re-scope the search-index row to match. Non-atomic with the move is fine: a stale
    // org can't leak the artifact (listArtifacts re-checks org live) — it's only a
    // findability fix, so it re-scopes on next publish/backfill even if this misses.
    await this.pool.query(`UPDATE artifact_search SET org_id = $2 WHERE artifact_id = $1`, [
      artifactId,
      targetOrgId,
    ])
  }

  // Atomic takedown: tombstone + bulk open-report resolution + audit entry in one
  // transaction, so a failure mid-way rolls back instead of leaving a half-applied
  // takedown. The single bulk UPDATE replaces the route's per-report loop (N+1).
  async takedownArtifact(input: TakedownInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(artifact)
        .set({ removed_at: input.removedAt })
        .where(eq(artifact.id, input.artifactId))
      await tx
        .update(report)
        .set({ state: "actioned" })
        .where(
          and(
            eq(report.artifact_id, input.artifactId),
            eq(report.org_id, input.orgId),
            eq(report.state, "open"),
          ),
        )
      await tx.insert(auditLog).values(input.audit)
    })
  }
  listAuditLog(
    orgId: string | undefined,
    opts?: { artifactId?: string; limit?: number },
  ): Promise<AuditLogRecord[]> {
    const q = this.db
      .select()
      .from(auditLog)
      .where(
        and(
          orgId ? eq(auditLog.org_id, orgId) : undefined,
          opts?.artifactId ? eq(auditLog.artifact_id, opts.artifactId) : undefined,
        ),
      )
      .orderBy(desc(auditLog.created_at))
    return opts?.limit ? q.limit(opts.limit) : q
  }

  // ---- Standalone image assets (POST /v1/assets -> GET /blob/:hash) ------
  async createAsset(a: NewAsset): Promise<AssetRecord> {
    const rows = await this.db.insert(asset).values(a).onConflictDoNothing().returning()
    // Content-addressed: a conflict means these exact bytes are already staged.
    return rows[0] ?? ((await this.getAsset(a.hash)) as AssetRecord)
  }
  async getAsset(hash: string): Promise<AssetRecord | null> {
    const rows = await this.db.select().from(asset).where(eq(asset.hash, hash))
    return rows[0] ?? null
  }
  async assetStorageBytes(orgId: string): Promise<number> {
    // `hash` is the primary key, so unlike storageBytes there's no per-org
    // dedup to do — each row is already one distinct blob.
    const rows = await this.db
      .select({ s: sql<number>`coalesce(sum(${asset.size_bytes}), 0)` })
      .from(asset)
      .where(eq(asset.org_id, orgId))
    return Number(rows[0]?.s ?? 0)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
