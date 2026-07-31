import type {
  AgentMentionRecord,
  AgentRecord,
  ArtifactDetail,
  ArtifactDetailOpts,
  ArtifactInviteRecord,
  ArtifactMemberRecord,
  ArtifactRecord,
  AssetRecord,
  AuditLogRecord,
  AutomationRecord,
  CollectionMemberRecord,
  CollectionRecord,
  CommentListOpts,
  CommentRecord,
  CommentSignals,
  CommentState,
  ConnectionRecord,
  ConnectionScope,
  ConnectionStatus,
  ContextAskerRecord,
  ContextRecord,
  DeliveryRecord,
  DeliveryStatus,
  DomainRecord,
  DomainStatus,
  FolderRecord,
  FollowKind,
  FollowRecord,
  GitHubAppRecord,
  GitHubInstallationRecord,
  GithubAuthor,
  GithubUserMapping,
  InvitationRecord,
  LinkRole,
  ListArtifactsOpts,
  ListEnrichment,
  ListEnrichmentOpts,
  Listed,
  MembershipRecord,
  MetaStore,
  ModelCredentialRecord,
  NewAgent,
  NewAgentMention,
  NewArtifact,
  NewArtifactInvite,
  NewArtifactMember,
  NewAsset,
  NewAuditLog,
  NewAutomation,
  NewCollection,
  NewCollectionMember,
  NewComment,
  NewConnection,
  NewContext,
  NewContextAsker,
  NewDelivery,
  NewDomain,
  NewFolder,
  NewFollow,
  NewInvitation,
  NewMembership,
  NewNotification,
  NewPlan,
  NewProposal,
  NewRenderJob,
  NewReport,
  NewRepoSource,
  NewReviewRound,
  NewRun,
  NewSession,
  NewSessionMessage,
  NewSignupAttribution,
  NewVersion,
  NewVersionData,
  NewView,
  NewWebhook,
  NotificationRecord,
  NotificationsPage,
  OAuthGrant,
  OAuthGrantSummary,
  OrgSettings,
  PlanKind,
  PlanRecord,
  PreviewStatus,
  ProposalRecord,
  ProposalState,
  RenderJobRecord,
  RenderJobStatus,
  ReportRecord,
  ReportState,
  RepoSourceRecord,
  ReviewRoundRecord,
  ReviewRoundState,
  Role,
  RunRecord,
  RunStatus,
  SessionMessageRecord,
  SessionRecord,
  SessionState,
  SignupAttributionRecord,
  SlackInstallRecord,
  SlackThreadLinkRecord,
  SlackUserLinkRecord,
  TakedownInput,
  UserDir,
  UserNotificationPrefRecord,
  UserProfile,
  VersionDataRecord,
  VersionRecord,
  ViewStats,
  WebhookRecord,
  WorkspaceAccess,
  WorkspaceRecord,
  WorkspaceSummary,
} from "@derive/core"
import { GLOBAL_FOLLOW_ORG, maxRole, mergeRunMeta, parseRunMeta, runCounter } from "@derive/core"
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
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import type { Exhaustive, Shapes } from "./parity"
import {
  agent,
  agentMention,
  artifact,
  artifactFavorite,
  artifactInvite,
  artifactMember,
  artifactTag,
  asset,
  auditLog,
  automation,
  betaSignup,
  collection,
  collectionItem,
  collectionMember,
  comment,
  connection,
  context,
  contextAsker,
  contextSession,
  domain,
  folder,
  follow,
  githubApp,
  githubInstallation,
  invitation,
  membership,
  modelCredential,
  notification,
  oauthClientWorkspace,
  orgSettings,
  PG_SCHEMA_STATEMENTS,
  plan,
  proposal,
  renderJob,
  report,
  repoSource,
  reviewRound,
  run,
  sessionMessage,
  signupAttribution,
  slackInstall,
  slackThreadLink,
  slackUserLink,
  userNotificationPref,
  version,
  versionData,
  webhook,
  webhookDelivery,
  workspace,
} from "./pg-schema"
import {
  artifactListConditions,
  artifactListOrder,
  collectManagedIds,
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
  artifactFavorite,
  follow,
  artifactTag,
  proposal,
  reviewRound,
  agent,
  agentMention,
  automation,
  run,
  plan,
  connection,
  artifactInvite,
  invitation,
  betaSignup,
  signupAttribution,
  oauthClientWorkspace,
  context,
  contextAsker,
  contextSession,
  sessionMessage,
  collection,
  collectionItem,
  collectionMember,
  folder,
  repoSource,
  githubApp,
  githubInstallation,
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
  version: true,
  versionData: true,
  comment: true,
  webhook: true,
  webhookDelivery: true,
  renderJob: true,
  membership: true,
  workspace: true,
  artifactMember: true,
  notification: true,
  follow: true,
  proposal: true,
  reviewRound: true,
  agent: true,
  agentMention: true,
  automation: true,
  run: true,
  plan: true,
  connection: true,
  invitation: true,
  artifactInvite: true,
  betaSignup: true,
  signupAttribution: true,
  context: true,
  contextAsker: true,
  contextSession: true,
  sessionMessage: true,
  collection: true,
  collectionMember: true,
  folder: true,
  repoSource: true,
  githubApp: true,
  githubInstallation: true,
  domain: true,
  report: true,
  auditLog: true,
  asset: true,
}
void _schemaExhaustive
void _schemaShapes

const VIEW_WINDOW_MS = 30 * 86400_000

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

export class PgMetaStore implements MetaStore {
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
    for (const stmt of PG_SCHEMA_STATEMENTS) await pool.query(stmt)
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
  async getArtifactById(id: string): Promise<ArtifactRecord | null> {
    const rows = await this.db.select().from(artifact).where(eq(artifact.id, id))
    return rows[0] ?? null
  }
  async getArtifactsByIds(ids: string[]): Promise<ArtifactRecord[]> {
    if (ids.length === 0) return []
    return this.db.select().from(artifact).where(inArray(artifact.id, ids))
  }

  async siblingsBySourcePaths(
    orgId: string,
    paths: string[],
  ): Promise<{ short_id: string; slug: string | null; source_path: string }[]> {
    if (paths.length === 0) return []
    const rows = await this.db
      .select({
        short_id: artifact.short_id,
        slug: artifact.slug,
        source_path: artifact.source_path,
      })
      .from(artifact)
      .where(
        and(
          eq(artifact.org_id, orgId),
          inArray(artifact.source_path, paths),
          isNull(artifact.removed_at),
        ),
      )
    return rows.filter((r): r is typeof r & { source_path: string } => r.source_path != null)
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
  ): Promise<{ versionCount: number; commentCount: number; version: VersionRecord | null }> {
    // Counts computed IN the database rather than by reading both tables into the Worker
    // and calling `.length` (which is what the share-link path used to do), and the
    // current version row rides along — one round trip instead of three.
    const { rows } = await this.pool.query<{ kind: string; n: number | null; doc: unknown }>(
      // The NULL placeholders carry explicit casts: Postgres resolves a UNION's column
      // types from the branches, and a bare NULL against row_to_json's `json` (or against
      // an int) is a "could not determine data type" error rather than a null.
      `SELECT 'versions' kind, count(*)::int n, NULL::json doc FROM version WHERE artifact_id = $1
       UNION ALL
       SELECT 'comments', count(*)::int, NULL::json FROM comment WHERE artifact_id = $1
       UNION ALL
       SELECT 'version', NULL::int, row_to_json(v) FROM version v
        WHERE v.artifact_id = $1 AND v.n = $2`,
      [artifactId, versionN],
    )
    let versionCount = 0
    let commentCount = 0
    let version: VersionRecord | null = null
    for (const r of rows) {
      if (r.kind === "versions") versionCount = r.n ?? 0
      else if (r.kind === "comments") commentCount = r.n ?? 0
      else if (r.doc) version = r.doc as VersionRecord
    }
    return { versionCount, commentCount, version }
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
    // Seven sequential ~80ms round trips (versions, tags, collection ids, proposals,
    // open threads, favorite, settings, managed) collapsed into one UNION ALL. Whole
    // rows ride as JSON in `doc` so branches with different column sets can share the
    // union; the scalar branches carry a count or a marker row.
    const { rows } = await this.pool.query<{ kind: string; doc: unknown }>(
      `SELECT 'version' kind, row_to_json(v) doc FROM version v WHERE v.artifact_id = $1
       UNION ALL
       SELECT 'tag', to_json(t.tag) FROM artifact_tag t WHERE t.artifact_id = $1
       UNION ALL
       SELECT 'collection', to_json(ci.collection_id) FROM collection_item ci WHERE ci.artifact_id = $1
       UNION ALL
       SELECT 'proposal', row_to_json(p) FROM proposal p WHERE p.artifact_id = $1
       UNION ALL
       SELECT 'threads', to_json(count(DISTINCT c.thread_id)::int) FROM comment c
        WHERE c.artifact_id = $1 AND c.state = 'open'
       UNION ALL
       SELECT 'favorite', to_json(count(*)::int) FROM artifact_favorite f
        WHERE f.artifact_id = $1 AND $2::text IS NOT NULL AND f.user_id = $2
       UNION ALL
       SELECT 'settings', to_json(s.settings) FROM org_settings s WHERE s.org_id = $3
       UNION ALL
       SELECT 'source', to_json(r.files) FROM repo_source r WHERE r.org_id = $3`,
      [artifactId, viewerId, orgId],
    )
    const versions: VersionRecord[] = []
    const tags: string[] = []
    const collectionIds: string[] = []
    const proposals: ProposalRecord[] = []
    const sourceFiles: { files: string }[] = []
    let openThreads = 0
    let favorite = false
    let settingsJson: string | null = null
    for (const r of rows) {
      switch (r.kind) {
        case "version":
          versions.push(r.doc as VersionRecord)
          break
        case "tag":
          tags.push(r.doc as string)
          break
        case "collection":
          collectionIds.push(r.doc as string)
          break
        case "proposal":
          proposals.push(r.doc as ProposalRecord)
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
        case "source":
          if (typeof r.doc === "string") sourceFiles.push({ files: r.doc })
          break
      }
    }
    // Same orderings the individual queries guaranteed: versions ascending by n (the
    // detail route indexes `versions[i]` against its own mapped array), proposals newest
    // first, tags sorted.
    versions.sort((a, b) => a.n - b.n)
    proposals.sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    )
    tags.sort()
    return {
      versions,
      tags,
      collectionIds,
      proposals,
      openThreads,
      favorite,
      settings: parseOrgSettings(settingsJson),
      managed: collectManagedIds(sourceFiles).includes(artifactId),
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
  async listSlotAcrossArtifacts(
    orgId: string,
    slot: string,
    opts?: { tag?: string; limit?: number },
  ) {
    // Joined on artifact.current_version so a superseded row can never be reported as the
    // current state. Retired artifacts are excluded: they are out of the library.
    const tagged = opts?.tag
      ? this.db
          .select({ id: artifactTag.artifact_id })
          .from(artifactTag)
          .where(eq(artifactTag.tag, opts.tag.trim().toLowerCase()))
      : null
    return this.db
      .select({
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
    )
    return this.db.select().from(comment).where(where).orderBy(asc(comment.created_at))
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
      previews: {},
      handles: [],
      bylines: [],
      signals: {},
      proposals: {},
      shareRoles: {},
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
        `SELECT 'preview', a.id, NULL, NULL, NULL FROM artifact a
           JOIN version v ON v.artifact_id = a.id AND v.n = a.current_version
          WHERE v.preview_status = 'ready' AND a.id = ANY(${page})`,
        `SELECT 'proposal', artifact_id, count(*)::text, NULL, NULL FROM proposal
          WHERE state = 'open' AND artifact_id = ANY(${page}) GROUP BY artifact_id`,
      )
      if (views)
        branches.push(
          `SELECT 'view', artifact_id, count(*)::text, NULL, NULL FROM view
            WHERE artifact_id = ANY(${page}) GROUP BY artifact_id`,
        )
      if (viewerId)
        branches.push(
          `SELECT 'comment', artifact_id, thread_id, author_id, meta FROM comment
            WHERE state = 'open' AND artifact_id = ANY(${page})`,
        )
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
        case "preview":
          out.previews[r.k] = true
          break
        case "proposal":
          out.proposals[r.k] = Number(r.c1)
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

  listArtifacts(opts?: ListArtifactsOpts): Promise<ArtifactRecord[]> {
    if (opts?.ids && opts.ids.length === 0) return Promise.resolve([])
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
  async countOwnedBy(orgId: string, userId: string, listed?: Listed): Promise<number> {
    const rows = await this.db
      .select({ c: count() })
      .from(artifact)
      .innerJoin(artifactMember, this.ownerRowJoin(userId))
      .where(and(eq(artifact.org_id, orgId), listed ? eq(artifact.listed, listed) : undefined))
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
    // author_id denorm), and tags come back ordered by tag.
    const { rows } = await this.pool.query<{ kind: string; k: string | null; n: number | null }>(
      `SELECT 'total' kind, NULL k, count(*)::int n FROM artifact WHERE org_id = $1
       UNION ALL
       SELECT 'tag', t.tag, count(*)::int FROM artifact_tag t
         JOIN artifact a ON a.id = t.artifact_id
        WHERE a.org_id = $1 GROUP BY t.tag
       UNION ALL
       SELECT 'workspace', w.name, NULL FROM workspace w WHERE w.id = $1
       UNION ALL
       SELECT 'favorites', NULL, count(*)::int FROM artifact_favorite f
         JOIN artifact a ON a.id = f.artifact_id
        WHERE $2::text IS NOT NULL AND f.user_id = $2
          AND a.org_id = $1 AND a.removed_at IS NULL
       UNION ALL
       SELECT 'mine', NULL, count(*)::int FROM artifact a
         JOIN artifact_member m ON m.artifact_id = a.id AND m.user_id = $2 AND m.role = 'owner'
        WHERE $2::text IS NOT NULL AND a.org_id = $1
       UNION ALL
       SELECT 'mine_private', NULL, count(*)::int FROM artifact a
         JOIN artifact_member m ON m.artifact_id = a.id AND m.user_id = $2 AND m.role = 'owner'
        WHERE $2::text IS NOT NULL AND a.org_id = $1 AND a.listed = 'none'`,
      [orgId, userId],
    )
    const out: WorkspaceSummary = {
      total: 0,
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
  async tagCounts(orgId?: string): Promise<{ tag: string; count: number }[]> {
    const base = this.db
      .select({ tag: artifactTag.tag, count: count() })
      .from(artifactTag)
      .innerJoin(artifact, eq(artifact.id, artifactTag.artifact_id))
    const rows = await (orgId ? base.where(eq(artifact.org_id, orgId)) : base)
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
    const res = await this.pool.query(`DELETE FROM view WHERE created_at < $1`, [cutoffIso])
    return res.rowCount ?? 0
  }

  async pruneViewsByViewers(viewers: string[]): Promise<number> {
    if (viewers.length === 0) return 0
    const ph = viewers.map((_, i) => `$${i + 1}`).join(",")
    const res = await this.pool.query(
      `DELETE FROM view WHERE viewer_kind='user' AND viewer IN (${ph})`,
      viewers,
    )
    return res.rowCount ?? 0
  }

  async viewStats(artifactId: string): Promise<ViewStats> {
    const cutoff = new Date(Date.now() - VIEW_WINDOW_MS).toISOString()
    const [tot, uni, anon, perV, daily, recent] = await Promise.all([
      this.pool.query(`SELECT count(*)::int n FROM view WHERE artifact_id=$1`, [artifactId]),
      this.pool.query(`SELECT count(DISTINCT viewer)::int n FROM view WHERE artifact_id=$1`, [
        artifactId,
      ]),
      this.pool.query(
        `SELECT count(DISTINCT viewer)::int n FROM view WHERE artifact_id=$1 AND viewer_kind='anon'`,
        [artifactId],
      ),
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
      unique: uni.rows[0].n,
      anonViewers: anon.rows[0].n,
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
  ): Promise<{ orgRole: Role | null; artifactRoles: Role[] }> {
    const res = await this.db.execute(sql`
      select 'org' as kind, m.role as role
        from membership m
       where m.org_id = ${orgId} and m.user_id = ${userId}
      union all
      select 'artifact' as kind, am.role as role
        from artifact_member am
       where am.artifact_id = ${artifactId} and am.user_id = ${userId}
      union all
      select 'artifact' as kind, cm.role as role
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
    for (const r of rows) {
      if (r.kind === "org") orgRole = r.role
      else artifactRoles.push(r.role)
    }
    return { orgRole, artifactRoles }
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
  // Artifacts explicitly shared with a user (per-artifact membership) — can span
  // workspaces; drives the home's "Shared with you" section. Excludes what they
  // authored: the creator's own owner-member row (written at publish) is
  // ownership, not a share (see repos.ts).
  async artifactIdsSharedWith(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: artifactMember.artifact_id })
      .from(artifactMember)
      .innerJoin(artifact, eq(artifact.id, artifactMember.artifact_id))
      .where(
        and(
          eq(artifactMember.user_id, userId),
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
  // Author/path follows in this workspace PLUS the user's global people-follows (org "*").
  listFollows(userId: string, orgId: string): Promise<FollowRecord[]> {
    return this.db
      .select()
      .from(follow)
      .where(and(eq(follow.user_id, userId), inArray(follow.org_id, [orgId, GLOBAL_FOLLOW_ORG])))
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
  // The "following" feed id set: live artifacts whose current author is a followed login
  // (case-insensitive), whose source_path starts with a followed path prefix, OR whose
  // author/path follows match within the active workspace; people follows match a
  // followed person's PUBLIC work across ANY workspace. Mirrors the sqlite path.
  async followedArtifactIds(userId: string, orgId: string): Promise<string[]> {
    const follows = await this.listFollows(userId, orgId)
    const logins = follows.filter((f) => f.kind === "author").map((f) => f.target.toLowerCase())
    const prefixes = follows.filter((f) => f.kind === "path").map((f) => f.target)
    const people = follows.filter((f) => f.kind === "user").map((f) => f.target)
    if (logins.length === 0 && prefixes.length === 0 && people.length === 0) return []
    const branches = []
    const wsConds = []
    if (logins.length > 0) wsConds.push(inArray(sql`lower(${artifact.author_login})`, logins))
    for (const p of prefixes) {
      const escaped = p.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
      wsConds.push(sql`${artifact.source_path} like ${`${escaped}%`} escape '\\'`)
    }
    if (wsConds.length > 0) {
      const wsMatch = wsConds.length === 1 ? wsConds[0] : or(...wsConds)
      if (wsMatch) branches.push(and(eq(artifact.org_id, orgId), wsMatch))
    }
    if (people.length > 0) {
      const authorConds = [inArray(artifact.author_id, people)]
      const ghIds = (await this.githubIdsForUsers(people)).map((g) => g.toLowerCase())
      if (ghIds.length > 0) authorConds.push(inArray(sql`lower(${artifact.author_gh_id})`, ghIds))
      const authored = authorConds.length === 1 ? authorConds[0] : or(...authorConds)
      if (authored) branches.push(and(eq(artifact.listed, "public"), authored))
    }
    if (branches.length === 0) return []
    const match = branches.length === 1 ? branches[0] : or(...branches)
    const rows = await this.db
      .select({ id: artifact.id })
      .from(artifact)
      .where(and(isNull(artifact.removed_at), match))
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
  async setCollectionAccess(id: string, workspaceAccess: WorkspaceAccess): Promise<void> {
    await this.db
      .update(collection)
      .set({ workspace_access: workspaceAccess })
      .where(eq(collection.id, id))
  }
  async deleteCollection(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
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
    const counts = await this.db
      .select({ id: collectionItem.collection_id, c: count() })
      .from(collectionItem)
      .groupBy(collectionItem.collection_id)
    const cmap = new Map(counts.map((r) => [r.id, Number(r.c)]))
    return rows.map((r) => ({ ...r, count: cmap.get(r.id) ?? 0 }))
  }
  async collectionsOverview(orgId: string): Promise<{
    collections: (CollectionRecord & { count: number })[]
    sources: RepoSourceRecord[]
  }> {
    // The list route used to run listCollections + listRepoSources as two independent
    // org-scoped round trips; a UNION ALL discriminated by `kind` answers both in one,
    // each branch's full row carried as JSON so the shapes don't have to be reconciled
    // into a single column set.
    const { rows } = await this.pool.query<{ kind: string; doc: unknown }>(
      `SELECT 'collection' kind, row_to_json(t) doc FROM (
         SELECT c.*, COALESCE(ci.cnt, 0)::int AS count
         FROM collection c
         LEFT JOIN (
           SELECT collection_id, count(*)::int cnt FROM collection_item GROUP BY collection_id
         ) ci ON ci.collection_id = c.id
         WHERE c.org_id = $1
       ) t
       UNION ALL
       SELECT 'source', row_to_json(r) FROM repo_source r WHERE r.org_id = $1`,
      [orgId],
    )
    const collections: (CollectionRecord & { count: number })[] = []
    const sources: RepoSourceRecord[] = []
    for (const r of rows) {
      if (r.kind === "collection") collections.push(r.doc as CollectionRecord & { count: number })
      else sources.push(r.doc as RepoSourceRecord)
    }
    collections.sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    )
    return { collections, sources }
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
  async collectionRolesForArtifact(artifactId: string, userId: string): Promise<Role[]> {
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
    const seat = await this.db
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
  ): Promise<Record<string, Role>> {
    if (collectionIds.length === 0) return {}
    // Same two sources as collectionRolesForArtifact, keyed per collection: the user's
    // explicit member rows, and their SEAT on each workspace-open collection — a UNION ALL
    // instead of two sequential awaits, since both are scoped to the same collectionIds.
    const { rows } = await this.pool.query<{ id: string; role: Role }>(
      `SELECT collection_id id, role FROM collection_member
        WHERE collection_id = ANY($1) AND user_id = $2
       UNION ALL
       SELECT c.id, m.role FROM collection c
       JOIN membership m ON m.org_id = c.org_id
       WHERE c.id = ANY($1) AND c.workspace_access = 'member' AND m.user_id = $2`,
      [collectionIds, userId],
    )
    const out: Record<string, Role> = {}
    for (const r of rows) out[r.id] = maxRole(out[r.id] ?? null, r.role) as Role
    return out
  }

  // ---- GitHub sync sources -----------------------------------------------
  async createRepoSource(s: NewRepoSource): Promise<RepoSourceRecord> {
    const rows = await this.db.insert(repoSource).values(s).returning()
    return one(rows)
  }
  async getRepoSource(id: string, orgId?: string): Promise<RepoSourceRecord | null> {
    const rows = await this.db
      .select()
      .from(repoSource)
      .where(and(eq(repoSource.id, id), orgId ? eq(repoSource.org_id, orgId) : undefined))
    return rows[0] ?? null
  }
  async listRepoSources(orgId: string): Promise<RepoSourceRecord[]> {
    return this.db
      .select()
      .from(repoSource)
      .where(eq(repoSource.org_id, orgId))
      .orderBy(desc(repoSource.created_at))
  }
  async updateRepoSourceSync(
    id: string,
    fields: { files: string; last_synced_at: string; last_status: string },
  ): Promise<void> {
    await this.db.update(repoSource).set(fields).where(eq(repoSource.id, id))
  }
  async setRepoSourceProgress(id: string, progress: string | null): Promise<void> {
    await this.db.update(repoSource).set({ progress }).where(eq(repoSource.id, id))
  }
  async deleteRepoSource(id: string, orgId: string): Promise<void> {
    await this.db.delete(repoSource).where(and(eq(repoSource.id, id), eq(repoSource.org_id, orgId)))
  }
  async managedArtifactIds(orgId: string): Promise<string[]> {
    const rows = await this.db
      .select({ files: repoSource.files })
      .from(repoSource)
      .where(eq(repoSource.org_id, orgId))
    return collectManagedIds(rows)
  }
  async listRepoSourcesByInstallation(installationId: string): Promise<RepoSourceRecord[]> {
    return this.db
      .select()
      .from(repoSource)
      .where(eq(repoSource.installation_id, installationId))
      .orderBy(desc(repoSource.created_at))
  }
  async listSyncingRepoSources(): Promise<RepoSourceRecord[]> {
    return this.db.select().from(repoSource).where(isNotNull(repoSource.progress))
  }

  // ---- GitHub App (instance credentials + per-workspace installations) -----
  async getGithubApp(): Promise<GitHubAppRecord | null> {
    const rows = await this.db.select().from(githubApp).where(eq(githubApp.id, "default"))
    return rows[0] ?? null
  }
  async setGithubApp(a: GitHubAppRecord): Promise<void> {
    const { id: _id, created_at: _created, ...set } = a
    await this.db.insert(githubApp).values(a).onConflictDoUpdate({ target: githubApp.id, set })
  }
  async getOrgSettings(orgId: string): Promise<OrgSettings> {
    const rows = await this.db.select().from(orgSettings).where(eq(orgSettings.org_id, orgId))
    return parseOrgSettings(rows[0]?.settings ?? null)
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
  async getSlackThreadLinkByThread(threadId: string): Promise<SlackThreadLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(slackThreadLink)
      .where(eq(slackThreadLink.thread_id, threadId))
    return rows[0] ?? null
  }
  async getSlackThreadLinkByTs(channel: string, ts: string): Promise<SlackThreadLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(slackThreadLink)
      .where(and(eq(slackThreadLink.channel, channel), eq(slackThreadLink.message_ts, ts)))
    return rows[0] ?? null
  }
  async setSlackThreadLink(l: SlackThreadLinkRecord): Promise<void> {
    const { thread_id: _t, created_at: _c, ...set } = l
    await this.db
      .insert(slackThreadLink)
      .values(l)
      .onConflictDoUpdate({ target: slackThreadLink.thread_id, set })
  }
  async getSlackUserLinkBySlackId(
    teamId: string,
    slackUserId: string,
  ): Promise<SlackUserLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(slackUserLink)
      .where(and(eq(slackUserLink.team_id, teamId), eq(slackUserLink.slack_user_id, slackUserId)))
    return rows[0] ?? null
  }
  async getSlackUserLinkByUser(
    teamId: string,
    userId: string,
  ): Promise<SlackUserLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(slackUserLink)
      .where(and(eq(slackUserLink.team_id, teamId), eq(slackUserLink.user_id, userId)))
    return rows[0] ?? null
  }
  async setSlackUserLink(l: SlackUserLinkRecord): Promise<void> {
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
  async upsertGithubInstallation(i: GitHubInstallationRecord): Promise<GitHubInstallationRecord> {
    const rows = await this.db
      .insert(githubInstallation)
      .values(i)
      .onConflictDoUpdate({
        target: githubInstallation.installation_id,
        set: { org_id: i.org_id, account_login: i.account_login, created_by: i.created_by },
      })
      .returning()
    return one(rows)
  }
  async getGithubInstallation(installationId: string): Promise<GitHubInstallationRecord | null> {
    const rows = await this.db
      .select()
      .from(githubInstallation)
      .where(eq(githubInstallation.installation_id, installationId))
    return rows[0] ?? null
  }
  async listGithubInstallations(orgId: string): Promise<GitHubInstallationRecord[]> {
    return this.db
      .select()
      .from(githubInstallation)
      .where(eq(githubInstallation.org_id, orgId))
      .orderBy(desc(githubInstallation.created_at))
  }
  async deleteGithubInstallation(installationId: string): Promise<void> {
    await this.db
      .delete(githubInstallation)
      .where(eq(githubInstallation.installation_id, installationId))
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

  // ---- Reviews: proposed versions ----------------------------------------
  async createProposal(p: NewProposal): Promise<ProposalRecord> {
    const rows = await this.db.insert(proposal).values(p).returning()
    return one(rows)
  }
  async getProposal(id: string): Promise<ProposalRecord | null> {
    const rows = await this.db.select().from(proposal).where(eq(proposal.id, id))
    return rows[0] ?? null
  }
  listProposals(artifactId: string, opts?: { state?: ProposalState }): Promise<ProposalRecord[]> {
    const where = opts?.state
      ? and(eq(proposal.artifact_id, artifactId), eq(proposal.state, opts.state))
      : eq(proposal.artifact_id, artifactId)
    return this.db.select().from(proposal).where(where).orderBy(desc(proposal.created_at))
  }
  async openProposalCounts(artifactIds: string[]): Promise<Record<string, number>> {
    if (artifactIds.length === 0) return {}
    const ph = artifactIds.map((_, i) => `$${i + 1}`).join(",")
    const { rows } = await this.pool.query(
      `SELECT artifact_id, count(*)::int c FROM proposal WHERE state='open' AND artifact_id IN (${ph}) GROUP BY artifact_id`,
      artifactIds,
    )
    const out: Record<string, number> = {}
    for (const r of rows) out[r.artifact_id] = r.c
    return out
  }
  async decideProposal(
    id: string,
    fields: {
      state: ProposalState
      decided_by: string | null
      decided_version: number | null
      decision_note?: string | null
    },
  ): Promise<ProposalRecord | null> {
    const rows = await this.db
      .update(proposal)
      .set({ ...fields, decided_at: new Date().toISOString() })
      .where(eq(proposal.id, id))
      .returning()
    return rows[0] ?? null
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
  listReviewRounds(artifactId: string): Promise<ReviewRoundRecord[]> {
    return this.db
      .select()
      .from(reviewRound)
      .where(eq(reviewRound.artifact_id, artifactId))
      .orderBy(desc(reviewRound.created_at))
  }
  async resolveReviewRound(
    id: string,
    fields: { state: Extract<ReviewRoundState, "sent_back" | "approved">; note?: string | null },
  ): Promise<ReviewRoundRecord | null> {
    const rows = await this.db
      .update(reviewRound)
      .set({ ...fields, resolved_at: new Date().toISOString() })
      .where(eq(reviewRound.id, id))
      .returning()
    return rows[0] ?? null
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
    opts?: { askerId?: string; limit?: number },
  ): Promise<SessionRecord[]> {
    const where = opts?.askerId
      ? and(eq(contextSession.context_id, contextId), eq(contextSession.asker_id, opts.askerId))
      : eq(contextSession.context_id, contextId)
    return this.db
      .select()
      .from(contextSession)
      .where(where)
      .orderBy(desc(contextSession.created_at))
      .limit(opts?.limit ?? 50)
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
  async listDueOpenSessions(now: string, limit = 50): Promise<SessionRecord[]> {
    return this.db
      .select()
      .from(contextSession)
      .where(
        or(
          eq(contextSession.state, "open"),
          // A `working` row whose lease lapsed (or never existed) is a dead executor's
          // session — runnable again, exactly as claimPendingSessions treats it.
          and(
            eq(contextSession.state, "working"),
            or(isNull(contextSession.lease_until), lt(contextSession.lease_until, now)),
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
      refs?: string | null
      enabled?: 0 | 1
    },
  ): Promise<AutomationRecord | null> {
    const set: Record<string, unknown> = {}
    if (fields.agent_id !== undefined) set.agent_id = fields.agent_id
    if (fields.trigger !== undefined) set.trigger = fields.trigger
    if (fields.instruction !== undefined) set.instruction = fields.instruction
    if (fields.refs !== undefined) set.refs = fields.refs
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
  ): Promise<{ requeued: number; failed: number }> {
    // Substrate died mid-run: running since before the cutoff. Requeue with an attempt count
    // in meta (JSON attribute, not a column); give up as failed/lost past maxAttempts.
    const stale: RunRecord[] = await this.db
      .select()
      .from(run)
      .where(and(eq(run.status, "running"), lte(run.started_at, cutoffIso)))
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
  async listEnabledAutomations(limit = 500): Promise<AutomationRecord[]> {
    return this.db.select().from(automation).where(eq(automation.enabled, 1)).limit(limit)
  }
  async listDueQueuedRuns(now: string, limit = 50): Promise<RunRecord[]> {
    return this.db
      .select()
      .from(run)
      .where(
        and(eq(run.status, "queued"), or(isNull(run.scheduled_for), lte(run.scheduled_for, now))),
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
    // The first artifact an agent produced FOR this user: a direct MCP publish, or an
    // approved agent proposal on their behalf. Earliest wins. Mirrors repos.ts.
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
    const approved = (
      await this.db
        .select({ short_id: artifact.short_id, title: artifact.title, at: proposal.decided_at })
        .from(proposal)
        .innerJoin(artifact, eq(artifact.id, proposal.artifact_id))
        .where(
          and(
            eq(proposal.on_behalf_of, userId),
            eq(proposal.state, "approved"),
            isNull(artifact.removed_at),
          ),
        )
        .orderBy(asc(proposal.decided_at), asc(proposal.id))
        .limit(1)
    )[0]
    // A null decided_at (defensive; decide always stamps it) sorts LAST, never first.
    const winner =
      direct && approved
        ? approved.at && approved.at < direct.at
          ? approved
          : direct
        : (direct ?? approved)
    return winner ? { short_id: winner.short_id, title: winner.title } : null
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
    await this.db.insert(agentMention).values(m)
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
  async markInvitationAccepted(id: string): Promise<void> {
    await this.db
      .update(invitation)
      .set({ accepted_at: new Date().toISOString() })
      .where(eq(invitation.id, id))
  }

  // ---- Beta signups --------------------------------------------------------
  async recordBetaSignup(id: string, email: string): Promise<boolean> {
    // The unique email index makes a concurrent duplicate a no-op; an empty
    // RETURNING means the email was already on the list.
    const rows = await this.db
      .insert(betaSignup)
      .values({ id, email })
      .onConflictDoNothing()
      .returning()
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
  async markArtifactInviteAccepted(id: string): Promise<void> {
    await this.db
      .update(artifactInvite)
      .set({ accepted_at: new Date().toISOString() })
      .where(eq(artifactInvite.id, id))
  }
  // ---- Account deletion cascade (see MetaStore.deleteUserData) ------------
  async deleteUserData(userId: string): Promise<void> {
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
    await this.db.update(proposal).set({ author_id: null }).where(eq(proposal.author_id, userId))
    await this.db.update(agent).set({ created_by: null }).where(eq(agent.created_by, userId))
    await this.db
      .update(invitation)
      .set({ invited_by: null })
      .where(eq(invitation.invited_by, userId))
    await this.db
      .update(artifactInvite)
      .set({ invited_by: null })
      .where(eq(artifactInvite.invited_by, userId))
    await this.db.delete(workspace).where(eq(workspace.id, `ws_p_${userId}`))
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
  async setArtifactTitle(id: string, title: string, slug?: string | null): Promise<void> {
    await this.db
      .update(artifact)
      .set(slug === undefined ? { title } : { title, slug })
      .where(eq(artifact.id, id))
  }
  async setArtifactSourcePath(id: string, sourcePath: string | null): Promise<void> {
    await this.db.update(artifact).set({ source_path: sourcePath }).where(eq(artifact.id, id))
  }
  async setArtifactUpdatedAt(id: string, updatedAt: string): Promise<void> {
    await this.db.update(artifact).set({ updated_at: updatedAt }).where(eq(artifact.id, id))
  }
  async setArtifactAuthor(artifactId: string, author: GithubAuthor | null): Promise<void> {
    await this.db
      .update(artifact)
      .set({
        author_name: author?.name ?? null,
        author_login: author?.login ?? null,
        author_avatar: author?.avatar ?? null,
        author_gh_id: author?.ghId ?? null,
      })
      .where(eq(artifact.id, artifactId))
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
      await tx.delete(versionData).where(eq(versionData.artifact_id, id))
      await tx.delete(version).where(eq(version.artifact_id, id))
      await tx.delete(comment).where(eq(comment.artifact_id, id))
      await tx.delete(artifactMember).where(eq(artifactMember.artifact_id, id))
      await tx.delete(artifactInvite).where(eq(artifactInvite.artifact_id, id))
      await tx.delete(artifactFavorite).where(eq(artifactFavorite.artifact_id, id))
      await tx.delete(artifactTag).where(eq(artifactTag.artifact_id, id))
      await tx.delete(collectionItem).where(eq(collectionItem.artifact_id, id))
      await tx.delete(domain).where(eq(domain.artifact_id, id))
      await tx.delete(proposal).where(eq(proposal.artifact_id, id))
      await tx.delete(report).where(eq(report.artifact_id, id))
      await tx.delete(notification).where(eq(notification.artifact_id, id))
      await tx.delete(agentMention).where(eq(agentMention.artifact_id, id))
      await tx.delete(slackThreadLink).where(eq(slackThreadLink.artifact_id, id))
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
