import type {
  AgentMentionRecord,
  AgentRecord,
  ArtifactInviteRecord,
  ArtifactMemberRecord,
  ArtifactRecord,
  AssetRecord,
  AuditLogRecord,
  CollectionMemberRecord,
  CollectionRecord,
  CommentListOpts,
  CommentRecord,
  CommentSignals,
  CommentState,
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
  InvitationRecord,
  LinkRole,
  ListArtifactsOpts,
  Listed,
  MembershipRecord,
  NewAgent,
  NewAgentMention,
  NewArtifact,
  NewArtifactInvite,
  NewArtifactMember,
  NewAsset,
  NewAuditLog,
  NewCollection,
  NewCollectionMember,
  NewComment,
  NewContext,
  NewContextAsker,
  NewDelivery,
  NewDomain,
  NewFolder,
  NewFollow,
  NewInvitation,
  NewMembership,
  NewNotification,
  NewProposal,
  NewRenderJob,
  NewReport,
  NewRepoSource,
  NewReviewRound,
  NewSession,
  NewSessionMessage,
  NewVersion,
  NewWebhook,
  NotificationRecord,
  OAuthGrant,
  OAuthGrantSummary,
  OrgSettings,
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
  SessionMessageRecord,
  SessionRecord,
  SessionState,
  SlackInstallRecord,
  SlackThreadLinkRecord,
  SlackUserLinkRecord,
  SortMode,
  TakedownInput,
  UserNotificationPrefRecord,
  UserProfile,
  VersionRecord,
  WebhookRecord,
  WorkspaceAccess,
  WorkspaceRecord,
} from "@derive/core"
import { DEFAULT_ORG_SETTINGS, GLOBAL_FOLLOW_ORG, maxRole, sortFields } from "@derive/core"
import {
  and,
  asc,
  type Column,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
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
  betaSignup,
  collection,
  collectionItem,
  collectionMember,
  comment,
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
  notification,
  oauthClientWorkspace,
  orgSettings,
  proposal,
  renderJob,
  report,
  repoSource,
  reviewRound,
  sessionMessage,
  slackInstall,
  slackThreadLink,
  slackUserLink,
  userNotificationPref,
  version,
  webhook,
  webhookDelivery,
  workspace,
} from "./schema"

/**
 * The WHERE conditions for the artifact list (title search, keyset cursor, id
 * restriction, workspace scope). The drizzle operators are dialect-agnostic and
 * only the `artifact` columns differ between SQLite/D1 and Postgres, so both
 * drivers build the same filter through this one helper — a new filter is added
 * once, not in two places (the listArtifacts the review flagged as duplicated).
 */
export function artifactListConditions(
  art: {
    title: Column
    created_at: Column
    updated_at: Column
    current_version: Column
    id: Column
    org_id: Column
    listed: Column
    removed_at: Column
  },
  opts?: ListArtifactsOpts,
): SQL[] {
  const conds: SQL[] = []
  // Tombstone filter — OFF by default (the feed shows removed rows as tombstone cards),
  // ON for content-reading callers like search so a moderated artifact's text can't be
  // grepped out of the index. See ListArtifactsOpts.excludeRemoved.
  if (opts?.excludeRemoved) conds.push(isNull(art.removed_at))
  // Anonymous / non-member callers only ever see the public directory — a
  // workspace-listed title must not leak to someone outside the workspace.
  if (opts?.publicOnly) conds.push(eq(art.listed, "public"))
  // A listing surfaces feed-listed rows (`workspace`/`public`) to members, plus any
  // row the viewer is an explicit member of (their own drafts, shares, collections)
  // — an UNlisted row (listed='none') never appears in a feed by access alone. The
  // subquery names the table literally — sqlite, D1, and pg all call it
  // artifact_member, and this function serves all three.
  else if (opts?.viewerId) {
    const isMember = sql`EXISTS (
        SELECT 1 FROM artifact_member am
        WHERE am.artifact_id = ${art.id} AND am.user_id = ${opts.viewerId}
      )`
    conds.push(sql`(${art.listed} != 'none' OR ${isMember})`)
  }
  // A trusted caller (operator token / internal jobs, no viewerId) sees everything.
  if (opts?.q) conds.push(like(sql`lower(${art.title})`, `%${opts.q.toLowerCase()}%`))
  if (opts?.cursor) {
    const { field, dir } = sortFields(opts.sort ?? "created")
    const col = artifactSortExpr(art, field)
    // The title sort key is the raw title (see sortKeyOf); lower it HERE so the same engine
    // case-folds both sides — JS toLowerCase and SQLite's ASCII-only lower() disagree, which
    // would drop/dup a title-sort page boundary on D1.
    const key = field === "title" ? sql`lower(${opts.cursor.key})` : opts.cursor.key
    const cmp = dir === "asc" ? gt : lt
    const cursor = or(cmp(col, key), and(eq(col, key), cmp(art.id, opts.cursor.id)))
    if (cursor) conds.push(cursor)
  }
  if (opts?.ids) conds.push(inArray(art.id, opts.ids))
  if (opts?.orgId) conds.push(eq(art.org_id, opts.orgId))
  return conds
}

/** The keyset/ordering column for a sort field, as SQL valid on both SQLite and Postgres.
 *  `revised` prefixes the coalesced activity time with a group flag so docs with a genuine new
 *  version (current_version >= 2) sort as one block above the never-revised ones; the JS twin
 *  is sortKeyOf. `||` and `case` are standard on both dialects. */
export function artifactSortExpr(
  art: { created_at: Column; updated_at: Column; title: Column; current_version: Column },
  field: "updated" | "created" | "revised" | "title",
): SQL {
  if (field === "updated") return sql`coalesce(${art.updated_at}, ${art.created_at})`
  if (field === "title") return sql`lower(coalesce(${art.title}, ''))`
  if (field === "revised")
    return sql`(case when ${art.current_version} >= 2 then '1:' else '0:' end) || coalesce(${art.updated_at}, ${art.created_at})`
  return sql`${art.created_at}`
}

/** The `ORDER BY` for a sort mode: the mode's column then the `id` tiebreak, same direction —
 *  the tuple the keyset cursor comparison mirrors. Shared by both drivers so they can't drift. */
export function artifactListOrder(
  art: {
    created_at: Column
    updated_at: Column
    title: Column
    current_version: Column
    id: Column
  },
  mode: SortMode,
): SQL[] {
  const { field, dir } = sortFields(mode)
  const d = dir === "asc" ? asc : desc
  return [d(artifactSortExpr(art, field)), d(art.id)]
}

/** The drizzle schema object — shared by the better-sqlite3 and D1 drivers. */
export const schema = {
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
  artifactFavorite,
  follow,
  artifactTag,
  proposal,
  reviewRound,
  agent,
  agentMention,
  artifactInvite,
  invitation,
  betaSignup,
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

// Compile-time schema parity (see ./parity): every table must be classified, and
// every typed table's row shape must match its @derive/core Record exactly. A new
// table that isn't classified, or a column that drifts, fails to compile here.
const _schemaExhaustive: Exhaustive<typeof schema> = true
const _schemaShapes: Shapes<typeof schema> = {
  artifact: true,
  version: true,
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
  invitation: true,
  artifactInvite: true,
  betaSignup: true,
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

/**
 * A drizzle SQLite database of either result kind. better-sqlite3 is synchronous
 * (`.get()` returns a value), D1 is async (`.get()` returns a Promise) — but the
 * query *builders* are identical, and `await` passes a sync value straight through.
 * So every method here is written once with `await` and works on both drivers.
 */
export type SqliteDb = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>

/** The shape of a `.run()` result across drivers: better-sqlite3 exposes
 *  `changes` directly; D1 nests it under `meta`. */
type RunResult = { changes?: number; meta?: { changes?: number } }

/** Pull the artifact ids out of repo_source `files` JSON rows. A file map is
 *  `{ [repoPath]: { artifact_id, sha } }`; a managed artifact is any id therein.
 *  Shared by both drivers so "is this artifact synced?" reads identically. */
/** The oauth-provider stores granted scopes as a JSON array string
 *  (`["openid","derive:publish"]`); tolerate a space-separated form too. On the
 *  Postgres tier the driver hands json/jsonb columns back ALREADY PARSED, so the
 *  value can arrive as an actual array — without the array branch every OAuth
 *  bearer 500'd on prod (`s.split is not a function` inside getOAuthGrant). */
export const parseOAuthScopes = (s: string | string[] | null): string[] => {
  if (!s) return []
  if (Array.isArray(s)) return s.filter((x): x is string => typeof x === "string")
  try {
    const a = JSON.parse(s)
    if (Array.isArray(a)) return a.filter((x): x is string => typeof x === "string")
  } catch {
    // not JSON; fall through to the space-separated form
  }
  return s.split(/\s+/).filter(Boolean)
}

/** Parse a stored org-settings JSON blob over the defaults, normalizing the v2
 *  access defaults (defaultWorkspaceAccess/defaultLinkRole/defaultListed) and
 *  dropping the retired keys (defaultUnlistedRole, defaultAgentVisibility,
 *  defaultLinkAudience). An unknown or missing value reads as the factory default
 *  (the team draft: `member` / `none` / `none` — see DEFAULT_ORG_SETTINGS), so a
 *  stale or malformed blob can never silently widen a workspace's defaults. Shared
 *  by both drivers so old blobs read identically everywhere. */
export const parseOrgSettings = (raw: string | null): OrgSettings => {
  let parsed: Partial<OrgSettings> & { defaultUnlistedRole?: unknown } = {}
  try {
    if (raw) parsed = JSON.parse(raw) as Partial<OrgSettings>
  } catch {}
  const {
    defaultUnlistedRole: _retiredA,
    defaultAgentVisibility: _retiredB,
    defaultLinkAudience: _retiredC,
    ...rest
  } = parsed as Partial<OrgSettings> & {
    defaultUnlistedRole?: unknown
    defaultAgentVisibility?: unknown
    defaultLinkAudience?: unknown
  }
  const wa = rest.defaultWorkspaceAccess as string | undefined
  const defaultWorkspaceAccess: OrgSettings["defaultWorkspaceAccess"] =
    wa === "none" || wa === "member" ? wa : DEFAULT_ORG_SETTINGS.defaultWorkspaceAccess
  const lr = rest.defaultLinkRole as string | undefined
  const defaultLinkRole: OrgSettings["defaultLinkRole"] =
    lr === "none" || lr === "viewer" || lr === "commenter" || lr === "editor"
      ? lr
      : DEFAULT_ORG_SETTINGS.defaultLinkRole
  const li = rest.defaultListed as string | undefined
  const defaultListed: OrgSettings["defaultListed"] =
    li === "none" || li === "workspace" || li === "public" ? li : DEFAULT_ORG_SETTINGS.defaultListed
  return {
    ...DEFAULT_ORG_SETTINGS,
    ...rest,
    defaultWorkspaceAccess,
    defaultLinkRole,
    defaultListed,
  }
}

export const collectManagedIds = (rows: { files: string }[]): string[] => {
  const ids = new Set<string>()
  for (const r of rows) {
    try {
      const map = JSON.parse(r.files) as Record<string, { artifact_id?: string }>
      for (const k in map) {
        const id = map[k]?.artifact_id
        if (id) ids.add(id)
      }
    } catch {
      // A malformed map shouldn't break the gate; treat it as managing nothing.
    }
  }
  return [...ids]
}

/**
 * The dialect-agnostic SQLite repository: the bulk of the MetaStore implemented
 * once over drizzle's SQLite query builder. The better-sqlite3 and D1 drivers
 * compose this and add only what genuinely differs — raw analytics SQL, the
 * Better-Auth user directory, and the transaction-bearing writes (where
 * better-sqlite3 wraps them in a sync transaction and D1 runs them sequentially,
 * the sequential versions living here).
 */
export function makeRepos(db: SqliteDb) {
  // ---- Artifacts + versions ----------------------------------------------
  const getByShortId = async (shortId: string): Promise<ArtifactRecord | null> =>
    (await db.select().from(artifact).where(eq(artifact.short_id, shortId)).get()) ?? null
  const getArtifactById = async (id: string): Promise<ArtifactRecord | null> =>
    (await db.select().from(artifact).where(eq(artifact.id, id)).get()) ?? null
  const getArtifactsByIds = async (ids: string[]): Promise<ArtifactRecord[]> =>
    ids.length === 0 ? [] : db.select().from(artifact).where(inArray(artifact.id, ids)).all()

  const siblingsBySourcePaths = async (
    orgId: string,
    paths: string[],
  ): Promise<{ short_id: string; slug: string | null; source_path: string }[]> => {
    if (paths.length === 0) return []
    const rows = await db
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
      .all()
    return rows.filter((r): r is typeof r & { source_path: string } => r.source_path != null)
  }

  const createArtifact = async (a: NewArtifact): Promise<ArtifactRecord> => {
    await db.insert(artifact).values(a).run()
    return (await getByShortId(a.short_id)) as ArtifactRecord
  }

  const setAccess = async (
    artifactId: string,
    workspaceAccess: WorkspaceAccess,
    listed: Listed,
    linkRole: LinkRole,
    passwordHash: string | null,
  ): Promise<void> => {
    await db
      .update(artifact)
      .set({
        workspace_access: workspaceAccess,
        listed,
        link_role: linkRole,
        password_hash: passwordHash,
      })
      .where(eq(artifact.id, artifactId))
      .run()
  }

  const setLocked = async (artifactId: string, locked: 0 | 1): Promise<void> => {
    await db.update(artifact).set({ locked }).where(eq(artifact.id, artifactId)).run()
  }

  const getVersion = async (artifactId: string, n: number): Promise<VersionRecord | null> =>
    (await db
      .select()
      .from(version)
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
      .get()) ?? null

  // Sequential add (used by D1, which has no interactive transactions; the
  // UNIQUE(artifact_id, n) constraint turns a race into a clean error). The
  // better-sqlite3 driver overrides this with a synchronous transaction.
  const addVersion = async (artifactId: string, v: NewVersion): Promise<VersionRecord> => {
    const row = await db
      .select({ cv: artifact.current_version })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .get()
    if (!row) throw new Error(`artifact not found: ${artifactId}`)
    const n = row.cv + 1
    await db
      .insert(version)
      .values({ ...v, artifact_id: artifactId, n })
      .run()
    await db
      .update(artifact)
      .set({
        current_version: n,
        current_content_type: v.content_type,
        updated_at: new Date().toISOString(),
        // Denormalize the new version's author onto the artifact (its CURRENT author),
        // for the list view + author filter. `author_name` is always the display name;
        // the GitHub fields are null for a manual/anonymous publish.
        author_name: v.author,
        author_login: v.author_login ?? null,
        author_avatar: v.author_avatar ?? null,
        author_gh_id: v.author_gh_id ?? null,
        author_id: v.author_id ?? null,
      })
      .where(eq(artifact.id, artifactId))
      .run()
    return (await getVersion(artifactId, n)) as VersionRecord
  }

  const listVersions = async (artifactId: string): Promise<VersionRecord[]> =>
    db
      .select()
      .from(version)
      .where(eq(version.artifact_id, artifactId))
      .orderBy(asc(version.n))
      .all()

  const reclassifyVersion = async (
    artifactId: string,
    n: number,
    contentType: string,
  ): Promise<void> => {
    await db
      .update(version)
      .set({ content_type: contentType })
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
      .run()
    // Keep the artifact's denormalized current_content_type in sync when the fixed
    // version is the current one (it's the field the viewer reads to pick render mode).
    await db
      .update(artifact)
      .set({ current_content_type: contentType })
      .where(and(eq(artifact.id, artifactId), eq(artifact.current_version, n)))
      .run()
  }

  const setVersionPreview = async (
    artifactId: string,
    n: number,
    fields: {
      preview_key?: string | null
      preview_status?: PreviewStatus | null
      preview_error?: string | null
    },
  ): Promise<void> => {
    await db
      .update(version)
      .set(fields)
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
      .run()
  }

  const setVersionPreviewVariant = async (
    artifactId: string,
    n: number,
    variant: "full" | "marked",
    fields: { key?: string | null; status?: PreviewStatus | null; error?: string | null },
  ): Promise<void> => {
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
    await db
      .update(version)
      .set(set)
      .where(and(eq(version.artifact_id, artifactId), eq(version.n, n)))
      .run()
  }

  const listArtifacts = async (opts?: ListArtifactsOpts): Promise<ArtifactRecord[]> => {
    if (opts?.ids && opts.ids.length === 0) return []
    const conds = artifactListConditions(artifact, opts)
    // Collection scope is a JOIN, never an `id IN (…members)`: a big collection would
    // otherwise bind one parameter per member and trip D1's 100-param cap (a 500).
    if (opts?.collectionId) {
      conds.push(eq(collectionItem.collection_id, opts.collectionId))
      const rows = db
        .select(getTableColumns(artifact))
        .from(artifact)
        .innerJoin(collectionItem, eq(collectionItem.artifact_id, artifact.id))
        .where(and(...conds))
        .orderBy(...artifactListOrder(artifact, opts?.sort ?? "created"))
      return opts.limit ? rows.limit(opts.limit).all() : rows.all()
    }
    const rows = db
      .select()
      .from(artifact)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(...artifactListOrder(artifact, opts?.sort ?? "created"))
    return opts?.limit ? rows.limit(opts.limit).all() : rows.all()
  }

  // ---- full-text search index (workspace search substrate) ----
  // Translate a LITERAL user query into a safe FTS5 MATCH: alnum tokens AND'd as quoted
  // PREFIX phrases (`"auth"*`), so the user's text is never read as FTS5 syntax
  // (AND/OR/NEAR/*/parens/quotes) AND a partial word finds its whole word ("auth" →
  // "authentication") — the grep-confirm pass the caller runs still enforces the exact
  // literal, so the prefix only widens candidate RECALL, never final precision. Quoting
  // before the star keeps it valid for every token shape (numeric-leading, unicode).
  // No tokens (all punctuation) → no query → no matches.
  const fts5Match = (query: string): string | null => {
    const tokens = query.match(/[\p{L}\p{N}]+/gu)
    return tokens?.length ? tokens.map((t) => `"${t}"*`).join(" ") : null
  }
  // FTS5 has no UPSERT, so index = delete-then-insert the one row. `text` is title + body
  // so a title hit ranks the artifact too. Contentless: the source of truth stays the blob.
  const indexArtifact = async (
    id: string,
    orgId: string,
    title: string | null,
    text: string,
  ): Promise<void> => {
    const content = title ? `${title}\n\n${text}` : text
    await db.run(sql`DELETE FROM artifact_search WHERE artifact_id = ${id}`)
    await db.run(
      sql`INSERT INTO artifact_search (text, artifact_id, org_id) VALUES (${content}, ${id}, ${orgId})`,
    )
  }
  const unindexArtifact = async (id: string): Promise<void> => {
    await db.run(sql`DELETE FROM artifact_search WHERE artifact_id = ${id}`)
  }
  const searchArtifactIds = async (
    orgId: string,
    query: string,
    limit: number,
  ): Promise<{ id: string; rank: number }[]> => {
    const match = fts5Match(query)
    if (!match) return []
    // bm25() is smaller-is-better; negate so the interface's "higher = more relevant" holds.
    const rows = (await db.all(sql`
      SELECT artifact_id, -bm25(artifact_search) AS rank
      FROM artifact_search
      WHERE org_id = ${orgId} AND artifact_search MATCH ${match}
      ORDER BY rank DESC
      LIMIT ${limit}`)) as { artifact_id: string; rank: number }[]
    // fts5 has no UNIQUE(artifact_id) and index = DELETE-then-INSERT (two statements), so a
    // race between two same-artifact publishes can momentarily leave two rows. Dedup on read
    // (keep the best-ranked) so a caller never sees an id twice. (Postgres can't: PK upsert.)
    const seen = new Set<string>()
    const out: { id: string; rank: number }[] = []
    for (const r of rows) {
      if (seen.has(r.artifact_id)) continue
      seen.add(r.artifact_id)
      out.push({ id: r.artifact_id, rank: r.rank })
    }
    return out
  }

  const artifactIdsByTag = async (tag: string): Promise<string[]> =>
    (
      await db
        .select({ id: artifactTag.artifact_id })
        .from(artifactTag)
        .where(eq(artifactTag.tag, tag))
        .all()
    ).map((r) => r.id)

  // Author filter for the list (mirrors artifactIdsByTag). Case-insensitive match on the
  // denormalized current author_login, scoped to the workspace.
  const artifactIdsByAuthor = async (orgId: string, login: string): Promise<string[]> =>
    (
      await db
        .select({ id: artifact.id })
        .from(artifact)
        .where(
          and(
            eq(artifact.org_id, orgId),
            eq(sql`lower(${artifact.author_login})`, login.toLowerCase()),
          ),
        )
        .all()
    ).map((r) => r.id)

  // "Created by me" for the list — every artifact this user holds an OWNER member
  // row on in the workspace, any visibility. The roster row is written once at
  // creation for the human behind the publish (agents included), so the filter
  // survives republishes; the author_id denorm doesn't (addVersion rewrites it to
  // the newest version's author — null for a token publish). The author-login
  // filter above stays byline-based deliberately: it's GitHub-commit attribution.
  const ownedBy = (userId: string) =>
    and(eq(artifactMember.user_id, userId), eq(artifactMember.role, "owner"))
  const artifactIdsOwnedBy = async (orgId: string, userId: string): Promise<string[]> =>
    (
      await db
        .select({ id: artifact.id })
        .from(artifact)
        .innerJoin(
          artifactMember,
          and(eq(artifactMember.artifact_id, artifact.id), ownedBy(userId)),
        )
        .where(eq(artifact.org_id, orgId))
        .all()
    ).map((r) => r.id)

  const countArtifacts = async (orgId?: string): Promise<number> => {
    const q = db.select({ c: count() }).from(artifact)
    return (await (orgId ? q.where(eq(artifact.org_id, orgId)) : q).get())?.c ?? 0
  }

  const countOwnedBy = async (orgId: string, userId: string, listed?: Listed): Promise<number> =>
    (
      await db
        .select({ c: count() })
        .from(artifact)
        .innerJoin(
          artifactMember,
          and(eq(artifactMember.artifact_id, artifact.id), ownedBy(userId)),
        )
        .where(and(eq(artifact.org_id, orgId), listed ? eq(artifact.listed, listed) : undefined))
        .get()
    )?.c ?? 0

  const storageBytes = async (orgId: string): Promise<number> => {
    // One row per distinct blob in the org (max size_bytes guards a stale 0 on a
    // restored row), then summed — so dedup'd content is counted once.
    const perBlob = db
      .select({ mx: sql<number>`max(${version.size_bytes})`.as("mx") })
      .from(version)
      .innerJoin(artifact, eq(artifact.id, version.artifact_id))
      .where(eq(artifact.org_id, orgId))
      .groupBy(version.blob_key)
      .as("per_blob")
    const row = await db
      .select({ s: sql<number>`coalesce(sum(${perBlob.mx}), 0)` })
      .from(perBlob)
      .get()
    return Number(row?.s ?? 0)
  }

  const tagCounts = async (orgId?: string): Promise<{ tag: string; count: number }[]> => {
    const base = db
      .select({ tag: artifactTag.tag, count: count() })
      .from(artifactTag)
      .innerJoin(artifact, eq(artifact.id, artifactTag.artifact_id))
    return (orgId ? base.where(eq(artifact.org_id, orgId)) : base)
      .groupBy(artifactTag.tag)
      .orderBy(asc(artifactTag.tag))
      .all()
  }

  const setArtifactRemoved = async (id: string, removedAt: string | null): Promise<void> => {
    await db.update(artifact).set({ removed_at: removedAt }).where(eq(artifact.id, id)).run()
  }
  const setArtifactsRemoved = async (ids: string[], removedAt: string | null): Promise<void> => {
    if (ids.length === 0) return
    await db.update(artifact).set({ removed_at: removedAt }).where(inArray(artifact.id, ids)).run()
  }
  const setArtifactTitle = async (id: string, title: string): Promise<void> => {
    await db.update(artifact).set({ title }).where(eq(artifact.id, id)).run()
  }
  const setArtifactSourcePath = async (id: string, sourcePath: string | null): Promise<void> => {
    await db.update(artifact).set({ source_path: sourcePath }).where(eq(artifact.id, id)).run()
  }
  const setArtifactUpdatedAt = async (id: string, updatedAt: string): Promise<void> => {
    await db.update(artifact).set({ updated_at: updatedAt }).where(eq(artifact.id, id)).run()
  }
  const setArtifactAuthor = async (
    artifactId: string,
    author: GithubAuthor | null,
  ): Promise<void> => {
    await db
      .update(artifact)
      .set({
        author_name: author?.name ?? null,
        author_login: author?.login ?? null,
        author_avatar: author?.avatar ?? null,
        author_gh_id: author?.ghId ?? null,
      })
      .where(eq(artifact.id, artifactId))
      .run()
  }

  // ---- Comments + threads ------------------------------------------------
  const getComment = async (id: string): Promise<CommentRecord | null> =>
    (await db.select().from(comment).where(eq(comment.id, id)).get()) ?? null

  const createComment = async (c: NewComment): Promise<CommentRecord> => {
    await db.insert(comment).values(c).run()
    return (await getComment(c.id)) as CommentRecord
  }

  const updateComment = async (
    id: string,
    fields: { body_md?: string; meta?: string | null; anchor?: string | null },
  ): Promise<CommentRecord | null> => {
    await db.update(comment).set(fields).where(eq(comment.id, id)).run()
    return getComment(id)
  }

  const listComments = async (
    artifactId: string,
    opts?: CommentListOpts,
  ): Promise<CommentRecord[]> => {
    const where = and(
      eq(comment.artifact_id, artifactId),
      opts?.state ? eq(comment.state, opts.state) : undefined,
    )
    return db.select().from(comment).where(where).orderBy(asc(comment.created_at)).all()
  }

  const setThreadState = async (
    artifactId: string,
    threadId: string,
    state: CommentState,
  ): Promise<number> => {
    const res = (await db
      .update(comment)
      .set({ state })
      .where(and(eq(comment.artifact_id, artifactId), eq(comment.thread_id, threadId)))
      .run()) as RunResult
    return res.changes ?? res.meta?.changes ?? 0
  }

  // Hard-remove an entire thread and everything keyed to it. Sequential deletes (no
  // cross-statement transaction on D1; the sqlite path wraps these in one) — order is
  // immaterial since nothing here references another of these rows. Everything keyed on
  // thread_id goes, so a removed thread leaves no dangling notification / agent mention /
  // Slack link behind. Mirrors deleteArtifact's cascade, scoped to one thread.
  const deleteThread = async (artifactId: string, threadId: string): Promise<void> => {
    await db
      .delete(notification)
      .where(and(eq(notification.artifact_id, artifactId), eq(notification.thread_id, threadId)))
      .run()
    await db
      .delete(agentMention)
      .where(and(eq(agentMention.artifact_id, artifactId), eq(agentMention.thread_id, threadId)))
      .run()
    await db.delete(slackThreadLink).where(eq(slackThreadLink.thread_id, threadId)).run()
    await db
      .delete(comment)
      .where(and(eq(comment.artifact_id, artifactId), eq(comment.thread_id, threadId)))
      .run()
  }

  // Does this comment's meta JSON tag `userId`? Mentions live in meta.mentions
  // (a {id,name}[]), so they can't be filtered in SQL cheaply — matched in code.
  const commentMentionsUser = (metaJson: string | null, userId: string): boolean => {
    if (!metaJson) return false
    try {
      const m = JSON.parse(metaJson) as { mentions?: { id?: string }[] }
      return Array.isArray(m.mentions) && m.mentions.some((x) => x?.id === userId)
    } catch {
      return false
    }
  }

  // Per-artifact comment signals for a viewer over a page of artifacts. ONE query;
  // state is filtered in code (not SQL) so the bound-parameter count stays at the page
  // size — D1 caps it at 100 and tagsForArtifacts already rides that edge. open_threads
  // counts distinct OPEN threads; the flags drive "needs your feedback" featuring.
  const commentSignals = async (
    artifactIds: string[],
    userId: string | null,
  ): Promise<Record<string, CommentSignals>> => {
    const out: Record<string, CommentSignals> = {}
    if (artifactIds.length === 0) return out
    const rows = await db
      .select({
        artifact_id: comment.artifact_id,
        thread_id: comment.thread_id,
        state: comment.state,
        author_id: comment.author_id,
        meta: comment.meta,
      })
      .from(comment)
      .where(inArray(comment.artifact_id, artifactIds))
      .all()
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
        if (!sig.mentions_me && commentMentionsUser(r.meta, userId)) sig.mentions_me = true
      }
    }
    for (const [id, set] of Object.entries(threads)) {
      const sig = out[id]
      if (sig) sig.open_threads = set.size
    }
    return out
  }

  // Artifact ids in `orgId` with an OPEN thread the viewer is tagged in or authored —
  // the "needs your feedback" set. Scans the workspace's open comments (bounded by
  // open-comment volume) and reduces in code, since the mention match is JSON.
  const artifactIdsNeedingFeedback = async (userId: string, orgId: string): Promise<string[]> => {
    const rows = await db
      .select({
        artifact_id: comment.artifact_id,
        author_id: comment.author_id,
        meta: comment.meta,
      })
      .from(comment)
      .innerJoin(artifact, eq(artifact.id, comment.artifact_id))
      .where(and(eq(comment.state, "open"), eq(artifact.org_id, orgId)))
      .all()
    const ids = new Set<string>()
    for (const r of rows) {
      if (r.author_id === userId || commentMentionsUser(r.meta, userId)) ids.add(r.artifact_id)
    }
    return [...ids]
  }

  // ---- Webhooks + outbox -------------------------------------------------
  const createWebhook = async (w: NewWebhook): Promise<WebhookRecord> =>
    (await db.insert(webhook).values(w).returning().get()) as WebhookRecord
  const listWebhooks = async (orgId: string): Promise<WebhookRecord[]> =>
    db
      .select()
      .from(webhook)
      .where(eq(webhook.org_id, orgId))
      .orderBy(desc(webhook.created_at))
      .all()
  const getWebhook = async (id: string, orgId: string): Promise<WebhookRecord | null> =>
    (await db
      .select()
      .from(webhook)
      .where(and(eq(webhook.id, id), eq(webhook.org_id, orgId)))
      .get()) ?? null
  const deleteWebhook = async (id: string, orgId: string): Promise<void> => {
    await db
      .delete(webhook)
      .where(and(eq(webhook.id, id), eq(webhook.org_id, orgId)))
      .run()
  }
  const activeWebhooks = async (artifactId: string, orgId: string): Promise<WebhookRecord[]> =>
    db
      .select()
      .from(webhook)
      .where(
        and(
          eq(webhook.active, 1),
          eq(webhook.org_id, orgId),
          or(isNull(webhook.artifact_id), eq(webhook.artifact_id, artifactId)),
        ),
      )
      .all()
  const enqueueDelivery = async (d: NewDelivery): Promise<void> => {
    await db.insert(webhookDelivery).values(d).run()
  }
  const enqueueDeliveries = async (rows: NewDelivery[]): Promise<void> => {
    if (rows.length === 0) return
    await db.insert(webhookDelivery).values(rows).run()
  }
  const claimDueDeliveries = async (
    now: string,
    limit: number,
    leaseUntil: string,
  ): Promise<DeliveryRecord[]> => {
    // sqlite/d1 are single-writer, so the UPDATE...WHERE id IN (SELECT...) claim is
    // atomic without row locks; bumping next_attempt_at to the lease hides the row
    // from overlapping ticks and recovers a crashed delivery once the lease lapses.
    const due = db
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(and(eq(webhookDelivery.status, "pending"), lte(webhookDelivery.next_attempt_at, now)))
      .orderBy(asc(webhookDelivery.next_attempt_at))
      .limit(limit)
    return (await db
      .update(webhookDelivery)
      .set({ attempts: sql`${webhookDelivery.attempts} + 1`, next_attempt_at: leaseUntil })
      .where(inArray(webhookDelivery.id, due))
      .returning()) as DeliveryRecord[]
  }
  const updateDelivery = async (
    id: string,
    f: {
      status: DeliveryStatus
      attempts: number
      last_error: string | null
      next_attempt_at: string
    },
  ): Promise<void> => {
    await db.update(webhookDelivery).set(f).where(eq(webhookDelivery.id, id)).run()
  }
  const recentDeliveries = async (webhookId: string, limit: number): Promise<DeliveryRecord[]> =>
    db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.webhook_id, webhookId))
      .orderBy(desc(webhookDelivery.created_at))
      .limit(limit)
      .all()

  // ---- Render-job queue --------------------------------------------------
  const enqueueRenderJob = async (j: NewRenderJob): Promise<void> => {
    await db.insert(renderJob).values(j).run()
  }
  const versionsMissingPreview = async (
    limit: number,
  ): Promise<Array<{ artifact_id: string; n: number }>> =>
    db
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
            db
              .select({ one: sql`1` })
              .from(renderJob)
              .where(and(eq(renderJob.artifact_id, artifact.id), eq(renderJob.status, "pending"))),
          ),
        ),
      )
      .limit(limit)
      .all()
  const claimDueRenderJobs = async (
    now: string,
    limit: number,
    leaseUntil: string,
  ): Promise<RenderJobRecord[]> => {
    const due = db
      .select({ id: renderJob.id })
      .from(renderJob)
      .where(and(eq(renderJob.status, "pending"), lte(renderJob.next_attempt_at, now)))
      .orderBy(asc(renderJob.next_attempt_at))
      .limit(limit)
    return (await db
      .update(renderJob)
      .set({ attempts: sql`${renderJob.attempts} + 1`, next_attempt_at: leaseUntil })
      .where(inArray(renderJob.id, due))
      .returning()) as RenderJobRecord[]
  }
  const updateRenderJob = async (
    id: string,
    fields: {
      status: RenderJobStatus
      attempts: number
      last_error: string | null
      next_attempt_at: string
    },
  ): Promise<void> => {
    await db.update(renderJob).set(fields).where(eq(renderJob.id, id)).run()
  }

  // ---- Workspace membership ----------------------------------------------
  const getMembership = async (orgId: string, userId: string): Promise<MembershipRecord | null> =>
    (await db
      .select()
      .from(membership)
      .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
      .get()) ?? null
  const listMemberships = async (orgId: string): Promise<MembershipRecord[]> =>
    db.select().from(membership).where(eq(membership.org_id, orgId)).all()
  const listMembershipsForOrgs = async (orgIds: string[]): Promise<MembershipRecord[]> =>
    orgIds.length === 0
      ? []
      : db.select().from(membership).where(inArray(membership.org_id, orgIds)).all()
  const countMemberships = async (orgId: string): Promise<number> =>
    (await db.select({ n: count() }).from(membership).where(eq(membership.org_id, orgId)).get())
      ?.n ?? 0
  const setMembership = async (m: NewMembership): Promise<MembershipRecord> =>
    (await db
      .insert(membership)
      .values(m)
      .onConflictDoUpdate({
        target: [membership.org_id, membership.user_id],
        set: { role: m.role },
      })
      .returning()
      .get()) as MembershipRecord
  const removeMembership = async (orgId: string, userId: string): Promise<void> => {
    await db
      .delete(membership)
      .where(and(eq(membership.org_id, orgId), eq(membership.user_id, userId)))
      .run()
  }
  const getWorkspace = async (orgId: string): Promise<WorkspaceRecord | null> =>
    (await db.select().from(workspace).where(eq(workspace.id, orgId)).get()) ?? null
  const setWorkspace = async (orgId: string, name: string): Promise<WorkspaceRecord> =>
    (await db
      .insert(workspace)
      .values({ id: orgId, name })
      .onConflictDoUpdate({ target: workspace.id, set: { name } })
      .returning()
      .get()) as WorkspaceRecord
  const deleteWorkspace = async (orgId: string): Promise<void> => {
    await db.delete(membership).where(eq(membership.org_id, orgId)).run()
    await db.delete(workspace).where(eq(workspace.id, orgId)).run()
  }
  const listWorkspaces = async (userId: string): Promise<(WorkspaceRecord & { role: Role })[]> =>
    db
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
      .all()

  // ---- Per-artifact shares -----------------------------------------------
  const getArtifactMember = async (
    artifactId: string,
    userId: string,
  ): Promise<ArtifactMemberRecord | null> =>
    (await db
      .select()
      .from(artifactMember)
      .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
      .get()) ?? null
  const listArtifactMembers = async (artifactId: string): Promise<ArtifactMemberRecord[]> =>
    db.select().from(artifactMember).where(eq(artifactMember.artifact_id, artifactId)).all()
  const artifactRolesFor = async (
    userId: string,
    artifactIds: string[],
  ): Promise<Record<string, Role>> => {
    if (artifactIds.length === 0) return {}
    const rows = await db
      .select({ artifact_id: artifactMember.artifact_id, role: artifactMember.role })
      .from(artifactMember)
      .where(
        and(eq(artifactMember.user_id, userId), inArray(artifactMember.artifact_id, artifactIds)),
      )
      .all()
    return Object.fromEntries(rows.map((r) => [r.artifact_id, r.role]))
  }
  // Artifacts explicitly shared with a user (they hold a per-artifact membership) —
  // the "Shared with you" set, which can span workspaces.
  // "Shared with me" excludes what I authored: publishing writes the creator an
  // owner-member row (that's how `private` knows its owner), and without the
  // author check every artifact you make would land in your own shared feed.
  const artifactIdsSharedWith = async (userId: string): Promise<string[]> =>
    (
      await db
        .select({ id: artifactMember.artifact_id })
        .from(artifactMember)
        .innerJoin(artifact, eq(artifact.id, artifactMember.artifact_id))
        .where(
          and(
            eq(artifactMember.user_id, userId),
            // NULL-safe: a token-published artifact (author_id null) shared with
            // you still counts — plain != would drop the NULL rows.
            or(isNull(artifact.author_id), ne(artifact.author_id, userId)),
          ),
        )
        .all()
    ).map((r) => r.id)
  const setArtifactMember = async (m: NewArtifactMember): Promise<ArtifactMemberRecord> =>
    (await db
      .insert(artifactMember)
      .values(m)
      .onConflictDoUpdate({
        target: [artifactMember.artifact_id, artifactMember.user_id],
        set: { role: m.role },
      })
      .returning()
      .get()) as ArtifactMemberRecord
  const removeArtifactMember = async (artifactId: string, userId: string): Promise<void> => {
    await db
      .delete(artifactMember)
      .where(and(eq(artifactMember.artifact_id, artifactId), eq(artifactMember.user_id, userId)))
      .run()
  }

  // ---- Favorites + tags --------------------------------------------------
  const listUserFavoriteIds = async (userId: string, orgId?: string): Promise<string[]> => {
    // With orgId, join to the artifact so the count reflects only live artifacts in
    // that workspace (a favorite of a removed or other-workspace artifact is dropped).
    if (orgId !== undefined) {
      const rows = await db
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
        .all()
      return rows.map((r) => r.id)
    }
    return (
      await db
        .select({ id: artifactFavorite.artifact_id })
        .from(artifactFavorite)
        .where(eq(artifactFavorite.user_id, userId))
        .all()
    ).map((r) => r.id)
  }
  const setFavorite = async (artifactId: string, userId: string): Promise<void> => {
    await db
      .insert(artifactFavorite)
      .values({ id: crypto.randomUUID(), artifact_id: artifactId, user_id: userId })
      .onConflictDoNothing({ target: [artifactFavorite.artifact_id, artifactFavorite.user_id] })
      .run()
  }
  const removeFavorite = async (artifactId: string, userId: string): Promise<void> => {
    await db
      .delete(artifactFavorite)
      .where(
        and(eq(artifactFavorite.artifact_id, artifactId), eq(artifactFavorite.user_id, userId)),
      )
      .run()
  }

  // ---- Follows (track GitHub authors + repo path prefixes) ---------------
  // Insert-or-ignore on the (user, org, kind, target) unique key (idempotent, like
  // setFavorite), then read the row back so the caller always gets the persisted follow.
  const addFollow = async (f: NewFollow): Promise<FollowRecord> => {
    await db
      .insert(follow)
      .values(f)
      .onConflictDoNothing({
        target: [follow.user_id, follow.org_id, follow.kind, follow.target],
      })
      .run()
    return (await db
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
      .get()) as FollowRecord
  }
  const removeFollow = async (
    userId: string,
    orgId: string,
    kind: FollowKind,
    target: string,
  ): Promise<void> => {
    await db
      .delete(follow)
      .where(
        and(
          eq(follow.user_id, userId),
          eq(follow.org_id, orgId),
          eq(follow.kind, kind),
          eq(follow.target, target),
        ),
      )
      .run()
  }
  // A user's follows for the management UI: their author/path follows in this workspace
  // PLUS their global people-follows (org_id = "*"), newest first.
  const listFollows = async (userId: string, orgId: string): Promise<FollowRecord[]> =>
    db
      .select()
      .from(follow)
      .where(and(eq(follow.user_id, userId), inArray(follow.org_id, [orgId, GLOBAL_FOLLOW_ORG])))
      .orderBy(desc(follow.created_at), desc(follow.id))
      .all()
  // The GitHub numeric ids a set of Derive users linked via Better Auth (raw account read;
  // the auth tables live in the same DB but aren't in the drizzle schema). [] if absent.
  const githubIdsForUsers = async (userIds: string[]): Promise<string[]> => {
    if (userIds.length === 0) return []
    try {
      const list = sql.join(
        userIds.map((id) => sql`${id}`),
        sql`, `,
      )
      const rows = (await db.all(
        sql`SELECT a.accountId gh_id FROM account a
            WHERE a.providerId = 'github' AND a.userId IN (${list})`,
      )) as { gh_id: string }[]
      return rows.map((r) => r.gh_id).filter(Boolean)
    } catch {
      return []
    }
  }
  // The "following" feed's id set (live artifacts only). Two scopes ORed together:
  //  · author/path follows match within the ACTIVE workspace (your repo-sync feed) —
  //    a followed login (case-insensitive) or a followed source_path prefix.
  //  · people follows match a followed person's PUBLIC work across ANY workspace
  //    (by the artifact's denormalized author_id, or their linked GitHub ids), since a
  //    person you follow usually publishes in their own workspace, not yours. Gated to
  //    `public`, so following someone never surfaces their private cross-workspace work.
  const followedArtifactIds = async (userId: string, orgId: string): Promise<string[]> => {
    const follows = await listFollows(userId, orgId)
    const logins = follows.filter((f) => f.kind === "author").map((f) => f.target.toLowerCase())
    const prefixes = follows.filter((f) => f.kind === "path").map((f) => f.target)
    const people = follows.filter((f) => f.kind === "user").map((f) => f.target)
    if (logins.length === 0 && prefixes.length === 0 && people.length === 0) return []
    const branches: SQL[] = []
    // Workspace branch: author/path matches, scoped to the active workspace.
    const wsConds: SQL[] = []
    if (logins.length > 0) wsConds.push(inArray(sql`lower(${artifact.author_login})`, logins))
    // A path prefix is a LIKE 'prefix%'. Escape LIKE metacharacters in the prefix and
    // declare the escape char so a path that happens to contain % or _ matches literally.
    for (const p of prefixes) {
      const escaped = p.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
      wsConds.push(sql`${artifact.source_path} like ${`${escaped}%`} escape '\\'`)
    }
    if (wsConds.length > 0) {
      const wsMatch = wsConds.length === 1 ? wsConds[0] : or(...wsConds)
      if (wsMatch) branches.push(and(eq(artifact.org_id, orgId), wsMatch) as SQL)
    }
    // People branch: a followed person's public work, in any workspace.
    if (people.length > 0) {
      const authorConds: SQL[] = [inArray(artifact.author_id, people)]
      const ghIds = (await githubIdsForUsers(people)).map((g) => g.toLowerCase())
      if (ghIds.length > 0) authorConds.push(inArray(sql`lower(${artifact.author_gh_id})`, ghIds))
      const authored = authorConds.length === 1 ? authorConds[0] : or(...authorConds)
      if (authored) branches.push(and(eq(artifact.listed, "public"), authored) as SQL)
    }
    if (branches.length === 0) return []
    const match = branches.length === 1 ? branches[0] : or(...branches)
    const rows = await db
      .select({ id: artifact.id })
      .from(artifact)
      .where(and(isNull(artifact.removed_at), match))
      .all()
    return rows.map((r) => r.id)
  }

  // ---- People profiles: works, shared workspaces, follower/following -----
  // The GitHub numeric ids one Derive user linked (raw account read; [] if absent).
  const githubIdsForUser = (userId: string): Promise<string[]> => githubIdsForUsers([userId])
  // A Derive user's GitHub login, derived from any artifact whose author_gh_id is one of
  // their linked ids (we don't store the login on `account`). Null when unknown.
  const githubLoginForUser = async (_userId: string, ghIds: string[]): Promise<string | null> => {
    if (ghIds.length === 0) return null
    const row = await db
      .select({ login: artifact.author_login })
      .from(artifact)
      .where(and(inArray(artifact.author_gh_id, ghIds), isNotNull(artifact.author_login)))
      .limit(1)
      .get()
    return row?.login ?? null
  }
  // Org ids where BOTH users hold a membership — widens a viewer's profile visibility.
  const sharedOrgIds = async (viewerId: string, targetUserId: string): Promise<string[]> => {
    const rows = await db
      .select({ org: membership.org_id })
      .from(membership)
      .where(
        and(
          eq(membership.user_id, viewerId),
          inArray(
            membership.org_id,
            db
              .select({ o: membership.org_id })
              .from(membership)
              .where(eq(membership.user_id, targetUserId)),
          ),
        ),
      )
      .all()
    return rows.map((r) => r.org)
  }
  // The WHERE for a person's visible work: not removed, authored by them (author_id or a
  // linked GitHub id), and visible to the viewer (public OR in a shared workspace).
  const userWorksConds = (userId: string, ghIds: string[], opts: ListArtifactsOpts): SQL[] => {
    // artifactListConditions handles the keyset cursor (key,id); we add the rest.
    const conds: SQL[] = [...artifactListConditions(artifact, opts), isNull(artifact.removed_at)]
    // Authored by them: author_id is the person, OR a linked GitHub id wrote a synced version.
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
    // Visible to the viewer on a profile: publicly listed, OR listed in a workspace
    // they share with the profile owner. UNlisted work (listed='none') never rides
    // a profile, shared workspace or not — the owner finds it in their library, not
    // on their public face.
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
  const listUserWorks = async (
    userId: string,
    ghIds: string[],
    opts: ListArtifactsOpts,
  ): Promise<ArtifactRecord[]> => {
    const rows = db
      .select()
      .from(artifact)
      .where(and(...userWorksConds(userId, ghIds, opts)))
      .orderBy(desc(artifact.created_at), desc(artifact.id))
    return opts.limit ? rows.limit(opts.limit).all() : rows.all()
  }
  const countUserWorks = async (
    userId: string,
    ghIds: string[],
    opts: ListArtifactsOpts,
  ): Promise<number> =>
    (
      await db
        .select({ c: count() })
        .from(artifact)
        .where(
          and(...userWorksConds(userId, ghIds, { ...opts, cursor: undefined, limit: undefined })),
        )
        .get()
    )?.c ?? 0
  const countFollowers = async (userId: string): Promise<number> =>
    (
      await db
        .select({ c: count() })
        .from(follow)
        .where(and(eq(follow.kind, "user"), eq(follow.target, userId)))
        .get()
    )?.c ?? 0
  const countFollowing = async (userId: string): Promise<number> =>
    (
      await db
        .select({ c: count() })
        .from(follow)
        .where(and(eq(follow.kind, "user"), eq(follow.user_id, userId)))
        .get()
    )?.c ?? 0
  // Resolve a set of follow rows (people) to public profiles via the raw user table.
  const profilesForFollow = async (
    column: "user_id" | "target",
    userId: string,
    limit: number,
  ): Promise<UserProfile[]> => {
    try {
      const join = column === "target" ? sql`u.id = f.target` : sql`u.id = f.user_id`
      const pick = column === "target" ? sql`f.user_id = ${userId}` : sql`f.target = ${userId}`
      return (await db.all(
        sql`SELECT u.id, u.name, u.image, u.username, u.profession, u.about
            FROM follow f JOIN user u ON ${join}
            WHERE f.kind = 'user' AND ${pick} AND u.username IS NOT NULL
            ORDER BY f.created_at DESC, f.id DESC LIMIT ${limit}`,
      )) as UserProfile[]
    } catch {
      return []
    }
  }
  // People this user follows: rows where f.user_id = userId, joined on f.target → user.
  const listFollowing = (userId: string, limit: number): Promise<UserProfile[]> =>
    profilesForFollow("target", userId, limit)
  // People who follow this user: rows where f.target = userId, joined on f.user_id → user.
  const listFollowers = (userId: string, limit: number): Promise<UserProfile[]> =>
    profilesForFollow("user_id", userId, limit)

  const tagsForArtifacts = async (artifactIds: string[]): Promise<Record<string, string[]>> => {
    if (artifactIds.length === 0) return {}
    const rows = await db
      .select({ artifact_id: artifactTag.artifact_id, tag: artifactTag.tag })
      .from(artifactTag)
      .where(inArray(artifactTag.artifact_id, artifactIds))
      .all()
    const out: Record<string, string[]> = {}
    for (const r of rows) {
      out[r.artifact_id] ??= []
      out[r.artifact_id]?.push(r.tag)
    }
    for (const k in out) out[k]?.sort()
    return out
  }

  const previewReady = async (artifactIds: string[]): Promise<Record<string, boolean>> => {
    if (artifactIds.length === 0) return {}
    const rows = await db
      .select({ artifact_id: artifact.id })
      .from(artifact)
      .innerJoin(
        version,
        and(eq(version.artifact_id, artifact.id), eq(version.n, artifact.current_version)),
      )
      .where(and(inArray(artifact.id, artifactIds), eq(version.preview_status, "ready")))
      .all()
    const out: Record<string, boolean> = {}
    for (const r of rows) out[r.artifact_id] = true
    return out
  }
  // Sequential replace (used by D1). better-sqlite3 overrides with a transaction.
  const setArtifactTags = async (artifactId: string, tags: string[]): Promise<void> => {
    await db.delete(artifactTag).where(eq(artifactTag.artifact_id, artifactId)).run()
    for (const tag of tags)
      await db
        .insert(artifactTag)
        .values({ id: crypto.randomUUID(), artifact_id: artifactId, tag })
        .run()
  }

  // ---- Collections -------------------------------------------------------
  const createCollection = async (c: NewCollection): Promise<CollectionRecord> =>
    (await db.insert(collection).values(c).returning().get()) as CollectionRecord
  const getCollection = async (id: string): Promise<CollectionRecord | null> =>
    (await db.select().from(collection).where(eq(collection.id, id)).get()) ?? null
  const getCollections = async (ids: string[]): Promise<CollectionRecord[]> =>
    ids.length === 0 ? [] : db.select().from(collection).where(inArray(collection.id, ids)).all()
  const updateCollection = async (
    id: string,
    fields: { title?: string },
  ): Promise<CollectionRecord | null> => {
    if (fields.title === undefined) return getCollection(id)
    return (
      (await db
        .update(collection)
        .set({ title: fields.title })
        .where(eq(collection.id, id))
        .returning()
        .get()) ?? null
    )
  }
  const setCollectionAccess = async (
    id: string,
    workspaceAccess: WorkspaceAccess,
  ): Promise<void> => {
    await db
      .update(collection)
      .set({ workspace_access: workspaceAccess })
      .where(eq(collection.id, id))
      .run()
  }
  // Sequential cascade (used by D1). better-sqlite3 overrides with a transaction.
  const deleteCollection = async (id: string): Promise<void> => {
    await db.delete(collectionItem).where(eq(collectionItem.collection_id, id)).run()
    await db.delete(collectionMember).where(eq(collectionMember.collection_id, id)).run()
    await db.delete(folder).where(eq(folder.collection_id, id)).run()
    await db.delete(collection).where(eq(collection.id, id)).run()
  }
  const listCollections = async (
    orgId?: string,
  ): Promise<(CollectionRecord & { count: number })[]> => {
    const base = db.select().from(collection)
    const rows = await (orgId ? base.where(eq(collection.org_id, orgId)) : base)
      .orderBy(desc(collection.created_at))
      .all()
    const counts = await db
      .select({ id: collectionItem.collection_id, c: count() })
      .from(collectionItem)
      .groupBy(collectionItem.collection_id)
      .all()
    const cmap = new Map(counts.map((r) => [r.id, Number(r.c)]))
    return rows.map((r) => ({ ...r, count: cmap.get(r.id) ?? 0 }))
  }
  // ---- Folders (organize a collection's artifacts) -----------------------
  const createFolder = async (f: NewFolder): Promise<FolderRecord> =>
    (await db.insert(folder).values(f).returning().get()) as FolderRecord
  const listFolders = async (collectionId: string): Promise<FolderRecord[]> =>
    db.select().from(folder).where(eq(folder.collection_id, collectionId)).all()
  const getFolder = async (id: string): Promise<FolderRecord | null> =>
    (await db.select().from(folder).where(eq(folder.id, id)).get()) ?? null
  const updateFolder = async (
    id: string,
    fields: { name?: string },
  ): Promise<FolderRecord | null> => {
    if (fields.name === undefined) return getFolder(id)
    return (
      (await db
        .update(folder)
        .set({ name: fields.name })
        .where(eq(folder.id, id))
        .returning()
        .get()) ?? null
    )
  }
  // Un-file this folder's items (they stay in the collection), then drop the folder.
  // Sequential (D1-safe), like deleteCollection.
  const deleteFolder = async (id: string): Promise<void> => {
    await db
      .update(collectionItem)
      .set({ folder_id: null })
      .where(eq(collectionItem.folder_id, id))
      .run()
    await db.delete(folder).where(eq(folder.id, id)).run()
  }
  const setItemFolder = async (
    collectionId: string,
    artifactId: string,
    folderId: string | null,
  ): Promise<void> => {
    await db
      .update(collectionItem)
      .set({ folder_id: folderId })
      .where(
        and(
          eq(collectionItem.collection_id, collectionId),
          eq(collectionItem.artifact_id, artifactId),
        ),
      )
      .run()
  }
  const collectionItemFolders = async (collectionId: string): Promise<Record<string, string>> => {
    const rows = await db
      .select({ s: artifact.short_id, f: collectionItem.folder_id })
      .from(collectionItem)
      .innerJoin(artifact, eq(artifact.id, collectionItem.artifact_id))
      .where(
        and(eq(collectionItem.collection_id, collectionId), isNotNull(collectionItem.folder_id)),
      )
      .all()
    const map: Record<string, string> = {}
    for (const r of rows) if (r.f) map[r.s] = r.f
    return map
  }

  const collectionArtifactIds = async (collectionId: string): Promise<string[]> =>
    (
      await db
        .select({ id: collectionItem.artifact_id })
        .from(collectionItem)
        .where(eq(collectionItem.collection_id, collectionId))
        .all()
    ).map((r) => r.id)
  const collectionIdsForArtifact = async (artifactId: string): Promise<string[]> =>
    (
      await db
        .select({ id: collectionItem.collection_id })
        .from(collectionItem)
        .where(eq(collectionItem.artifact_id, artifactId))
        .all()
    ).map((r) => r.id)
  const addCollectionItem = async (collectionId: string, artifactId: string): Promise<void> => {
    await db
      .insert(collectionItem)
      .values({ id: crypto.randomUUID(), collection_id: collectionId, artifact_id: artifactId })
      .onConflictDoNothing({ target: [collectionItem.collection_id, collectionItem.artifact_id] })
      .run()
  }
  const removeCollectionItem = async (collectionId: string, artifactId: string): Promise<void> => {
    await db
      .delete(collectionItem)
      .where(
        and(
          eq(collectionItem.collection_id, collectionId),
          eq(collectionItem.artifact_id, artifactId),
        ),
      )
      .run()
  }
  const getCollectionMember = async (
    collectionId: string,
    userId: string,
  ): Promise<CollectionMemberRecord | null> =>
    (await db
      .select()
      .from(collectionMember)
      .where(
        and(eq(collectionMember.collection_id, collectionId), eq(collectionMember.user_id, userId)),
      )
      .get()) ?? null
  const listCollectionMembers = async (collectionId: string): Promise<CollectionMemberRecord[]> =>
    db.select().from(collectionMember).where(eq(collectionMember.collection_id, collectionId)).all()
  const collectionMemberCounts = async (
    collectionIds: string[],
  ): Promise<Record<string, number>> => {
    if (collectionIds.length === 0) return {}
    const rows = await db
      .select({ id: collectionMember.collection_id, c: count() })
      .from(collectionMember)
      .where(inArray(collectionMember.collection_id, collectionIds))
      .groupBy(collectionMember.collection_id)
      .all()
    return Object.fromEntries(rows.map((r) => [r.id, Number(r.c)]))
  }
  const setCollectionMember = async (m: NewCollectionMember): Promise<CollectionMemberRecord> =>
    (await db
      .insert(collectionMember)
      .values(m)
      .onConflictDoUpdate({
        target: [collectionMember.collection_id, collectionMember.user_id],
        set: { role: m.role },
      })
      .returning()
      .get()) as CollectionMemberRecord
  const removeCollectionMember = async (collectionId: string, userId: string): Promise<void> => {
    await db
      .delete(collectionMember)
      .where(
        and(eq(collectionMember.collection_id, collectionId), eq(collectionMember.user_id, userId)),
      )
      .run()
  }
  const collectionRolesForArtifact = async (
    artifactId: string,
    userId: string,
  ): Promise<Role[]> => {
    // Explicit collectionMember rows on any collection holding this artifact.
    const explicit = await db
      .select({ role: collectionMember.role })
      .from(collectionMember)
      .innerJoin(collectionItem, eq(collectionItem.collection_id, collectionMember.collection_id))
      .where(and(eq(collectionItem.artifact_id, artifactId), eq(collectionMember.user_id, userId)))
      .all()
    // A workspace-open collection propagates the viewer's SEAT role to every artifact
    // inside it — "Everyone in the workspace opens this at their role" (the Share
    // dialog's promise; see access-model.md). Join the artifact's collections to the
    // viewer's membership in each collection's org, keeping only workspace-open ones.
    const seat = await db
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
      .all()
    return [...explicit, ...seat].map((r) => r.role)
  }
  const collectionRolesForUser = async (
    collectionIds: string[],
    userId: string,
  ): Promise<Record<string, Role>> => {
    if (collectionIds.length === 0) return {}
    // Same two sources as collectionRolesForArtifact, keyed per collection: the
    // user's explicit member rows, and their SEAT on each workspace-open collection.
    const explicit = await db
      .select({ id: collectionMember.collection_id, role: collectionMember.role })
      .from(collectionMember)
      .where(
        and(
          inArray(collectionMember.collection_id, collectionIds),
          eq(collectionMember.user_id, userId),
        ),
      )
      .all()
    const seat = await db
      .select({ id: collection.id, role: membership.role })
      .from(collection)
      .innerJoin(membership, eq(membership.org_id, collection.org_id))
      .where(
        and(
          inArray(collection.id, collectionIds),
          eq(collection.workspace_access, "member"),
          eq(membership.user_id, userId),
        ),
      )
      .all()
    const out: Record<string, Role> = {}
    for (const r of [...explicit, ...seat]) out[r.id] = maxRole(out[r.id] ?? null, r.role) as Role
    return out
  }

  // ---- GitHub sync sources -----------------------------------------------
  const createRepoSource = async (s: NewRepoSource): Promise<RepoSourceRecord> =>
    (await db.insert(repoSource).values(s).returning().get()) as RepoSourceRecord
  const getRepoSource = async (id: string, orgId?: string): Promise<RepoSourceRecord | null> =>
    (await db
      .select()
      .from(repoSource)
      .where(and(eq(repoSource.id, id), orgId ? eq(repoSource.org_id, orgId) : undefined))
      .get()) ?? null
  const listRepoSources = async (orgId: string): Promise<RepoSourceRecord[]> =>
    db
      .select()
      .from(repoSource)
      .where(eq(repoSource.org_id, orgId))
      .orderBy(desc(repoSource.created_at))
      .all()
  const updateRepoSourceSync = async (
    id: string,
    fields: { files: string; last_synced_at: string; last_status: string },
  ): Promise<void> => {
    await db.update(repoSource).set(fields).where(eq(repoSource.id, id)).run()
  }
  const setRepoSourceProgress = async (id: string, progress: string | null): Promise<void> => {
    await db.update(repoSource).set({ progress }).where(eq(repoSource.id, id)).run()
  }
  const deleteRepoSource = async (id: string, orgId: string): Promise<void> => {
    await db
      .delete(repoSource)
      .where(and(eq(repoSource.id, id), eq(repoSource.org_id, orgId)))
      .run()
  }
  const managedArtifactIds = async (orgId: string): Promise<string[]> => {
    const rows = await db
      .select({ files: repoSource.files })
      .from(repoSource)
      .where(eq(repoSource.org_id, orgId))
      .all()
    return collectManagedIds(rows)
  }
  const listRepoSourcesByInstallation = async (
    installationId: string,
  ): Promise<RepoSourceRecord[]> =>
    db
      .select()
      .from(repoSource)
      .where(eq(repoSource.installation_id, installationId))
      .orderBy(desc(repoSource.created_at))
      .all()
  const listSyncingRepoSources = async (): Promise<RepoSourceRecord[]> =>
    db.select().from(repoSource).where(isNotNull(repoSource.progress)).all()

  // ---- GitHub App (instance credentials + per-workspace installations) -----
  const getGithubApp = async (): Promise<GitHubAppRecord | null> =>
    (await db.select().from(githubApp).where(eq(githubApp.id, "default")).get()) ?? null
  const setGithubApp = async (a: GitHubAppRecord): Promise<void> => {
    const { id: _id, created_at: _created, ...set } = a
    await db.insert(githubApp).values(a).onConflictDoUpdate({ target: githubApp.id, set }).run()
  }

  // ---- Workspace integration settings -------------------------------------
  const getOrgSettings = async (orgId: string): Promise<OrgSettings> => {
    const row = await db.select().from(orgSettings).where(eq(orgSettings.org_id, orgId)).get()
    return parseOrgSettings(row?.settings ?? null)
  }
  const setOrgSettings = async (orgId: string, settings: OrgSettings): Promise<void> => {
    await db
      .insert(orgSettings)
      .values({ org_id: orgId, settings: JSON.stringify(settings) })
      .onConflictDoUpdate({
        target: orgSettings.org_id,
        set: { settings: JSON.stringify(settings) },
      })
      .run()
  }

  // ---- Slack App ----------------------------------------------------------
  const getSlackInstall = async (orgId: string): Promise<SlackInstallRecord | null> =>
    (await db.select().from(slackInstall).where(eq(slackInstall.org_id, orgId)).get()) ?? null
  const setSlackInstall = async (s: SlackInstallRecord): Promise<void> => {
    const { org_id: _o, created_at: _c, ...set } = s
    await db
      .insert(slackInstall)
      .values(s)
      .onConflictDoUpdate({ target: slackInstall.org_id, set })
      .run()
  }
  const deleteSlackInstall = async (orgId: string): Promise<void> => {
    await db.delete(slackInstall).where(eq(slackInstall.org_id, orgId)).run()
  }
  const getSlackThreadLinkByThread = async (
    threadId: string,
  ): Promise<SlackThreadLinkRecord | null> =>
    (await db
      .select()
      .from(slackThreadLink)
      .where(eq(slackThreadLink.thread_id, threadId))
      .get()) ?? null
  const getSlackThreadLinkByTs = async (
    channel: string,
    ts: string,
  ): Promise<SlackThreadLinkRecord | null> =>
    (await db
      .select()
      .from(slackThreadLink)
      .where(and(eq(slackThreadLink.channel, channel), eq(slackThreadLink.message_ts, ts)))
      .get()) ?? null
  const setSlackThreadLink = async (l: SlackThreadLinkRecord): Promise<void> => {
    const { thread_id: _t, created_at: _c, ...set } = l
    await db
      .insert(slackThreadLink)
      .values(l)
      .onConflictDoUpdate({ target: slackThreadLink.thread_id, set })
      .run()
  }
  const getSlackUserLinkBySlackId = async (
    teamId: string,
    slackUserId: string,
  ): Promise<SlackUserLinkRecord | null> =>
    (await db
      .select()
      .from(slackUserLink)
      .where(and(eq(slackUserLink.team_id, teamId), eq(slackUserLink.slack_user_id, slackUserId)))
      .get()) ?? null
  const getSlackUserLinkByUser = async (
    teamId: string,
    userId: string,
  ): Promise<SlackUserLinkRecord | null> =>
    (await db
      .select()
      .from(slackUserLink)
      .where(and(eq(slackUserLink.team_id, teamId), eq(slackUserLink.user_id, userId)))
      .get()) ?? null
  const setSlackUserLink = async (l: SlackUserLinkRecord): Promise<void> => {
    const { id: _i, created_at: _c, ...set } = l
    await db
      .insert(slackUserLink)
      .values(l)
      .onConflictDoUpdate({ target: [slackUserLink.team_id, slackUserLink.slack_user_id], set })
      .run()
  }
  const deleteSlackUserLink = async (teamId: string, userId: string): Promise<void> => {
    await db
      .delete(slackUserLink)
      .where(and(eq(slackUserLink.team_id, teamId), eq(slackUserLink.user_id, userId)))
      .run()
  }
  const getUserNotificationPref = async (
    orgId: string,
    userId: string,
  ): Promise<UserNotificationPrefRecord | null> =>
    (await db
      .select()
      .from(userNotificationPref)
      .where(and(eq(userNotificationPref.org_id, orgId), eq(userNotificationPref.user_id, userId)))
      .get()) ?? null
  const setUserNotificationPref = async (p: UserNotificationPrefRecord): Promise<void> => {
    const { id: _i, created_at: _c, ...set } = p
    await db
      .insert(userNotificationPref)
      .values(p)
      .onConflictDoUpdate({
        target: [userNotificationPref.org_id, userNotificationPref.user_id],
        set,
      })
      .run()
  }
  const upsertGithubInstallation = async (
    i: GitHubInstallationRecord,
  ): Promise<GitHubInstallationRecord> =>
    (await db
      .insert(githubInstallation)
      .values(i)
      .onConflictDoUpdate({
        target: githubInstallation.installation_id,
        set: { org_id: i.org_id, account_login: i.account_login, created_by: i.created_by },
      })
      .returning()
      .get()) as GitHubInstallationRecord
  const getGithubInstallation = async (
    installationId: string,
  ): Promise<GitHubInstallationRecord | null> =>
    (await db
      .select()
      .from(githubInstallation)
      .where(eq(githubInstallation.installation_id, installationId))
      .get()) ?? null
  const listGithubInstallations = async (orgId: string): Promise<GitHubInstallationRecord[]> =>
    db
      .select()
      .from(githubInstallation)
      .where(eq(githubInstallation.org_id, orgId))
      .orderBy(desc(githubInstallation.created_at))
      .all()
  const deleteGithubInstallation = async (installationId: string): Promise<void> => {
    await db
      .delete(githubInstallation)
      .where(eq(githubInstallation.installation_id, installationId))
      .run()
  }
  // ---- Domains (hostname → artifact) -------------------------------------
  const getDomain = async (host: string): Promise<DomainRecord | null> =>
    (await db.select().from(domain).where(eq(domain.host, host)).get()) ?? null
  // Insert-only: a taken host yields no row (the route turns that into a 409),
  // so one workspace can never claim a host already owned by another.
  const setDomain = async (d: NewDomain): Promise<DomainRecord | null> =>
    ((await db.insert(domain).values(d).onConflictDoNothing().returning().get()) as
      | DomainRecord
      | undefined) ?? null
  const getArtifactDomains = async (artifactId: string): Promise<DomainRecord[]> =>
    db.select().from(domain).where(eq(domain.artifact_id, artifactId)).all()
  // A workspace's own custom domains: org-scoped and not bound to one artifact.
  const getWorkspaceDomains = async (orgId: string): Promise<DomainRecord[]> =>
    db
      .select()
      .from(domain)
      .where(and(eq(domain.org_id, orgId), isNull(domain.artifact_id)))
      .all()
  const updateDomain = async (
    host: string,
    fields: { status?: DomainStatus; verification?: string | null },
  ): Promise<DomainRecord | null> =>
    ((await db.update(domain).set(fields).where(eq(domain.host, host)).returning().get()) as
      | DomainRecord
      | undefined) ?? null
  const deleteDomain = async (host: string, orgId: string): Promise<void> => {
    await db
      .delete(domain)
      .where(and(eq(domain.host, host), eq(domain.org_id, orgId)))
      .run()
  }

  // ---- Reviews: proposals ------------------------------------------------
  const createProposal = async (p: NewProposal): Promise<ProposalRecord> =>
    (await db.insert(proposal).values(p).returning().get()) as ProposalRecord
  const getProposal = async (id: string): Promise<ProposalRecord | null> =>
    (await db.select().from(proposal).where(eq(proposal.id, id)).get()) ?? null
  const listProposals = async (
    artifactId: string,
    opts?: { state?: ProposalState },
  ): Promise<ProposalRecord[]> => {
    const where = opts?.state
      ? and(eq(proposal.artifact_id, artifactId), eq(proposal.state, opts.state))
      : eq(proposal.artifact_id, artifactId)
    return db.select().from(proposal).where(where).orderBy(desc(proposal.created_at)).all()
  }
  const decideProposal = async (
    id: string,
    fields: {
      state: ProposalState
      decided_by: string | null
      decided_version: number | null
      decision_note?: string | null
    },
  ): Promise<ProposalRecord | null> =>
    (await db
      .update(proposal)
      .set({ ...fields, decided_at: new Date().toISOString() })
      .where(eq(proposal.id, id))
      .returning()
      .get()) ?? null

  // ---- Review rounds -----------------------------------------------------
  const createReviewRound = async (r: NewReviewRound): Promise<ReviewRoundRecord> => {
    // One pending round per (artifact, person): clear this person's prior pending
    // row first so the re-request replaces it (and the partial unique index holds).
    await db
      .delete(reviewRound)
      .where(
        and(
          eq(reviewRound.artifact_id, r.artifact_id),
          eq(reviewRound.requested_for, r.requested_for),
          eq(reviewRound.state, "pending"),
        ),
      )
      .run()
    return (await db.insert(reviewRound).values(r).returning().get()) as ReviewRoundRecord
  }
  const getPendingRound = async (
    artifactId: string,
    requestedFor?: string,
  ): Promise<ReviewRoundRecord | null> => {
    const where = requestedFor
      ? and(
          eq(reviewRound.artifact_id, artifactId),
          eq(reviewRound.requested_for, requestedFor),
          eq(reviewRound.state, "pending"),
        )
      : and(eq(reviewRound.artifact_id, artifactId), eq(reviewRound.state, "pending"))
    return (
      (await db
        .select()
        .from(reviewRound)
        .where(where)
        .orderBy(asc(reviewRound.created_at))
        .get()) ?? null
    )
  }
  const listReviewRounds = async (artifactId: string): Promise<ReviewRoundRecord[]> =>
    db
      .select()
      .from(reviewRound)
      .where(eq(reviewRound.artifact_id, artifactId))
      .orderBy(desc(reviewRound.created_at))
      .all()
  const resolveReviewRound = async (
    id: string,
    fields: { state: Extract<ReviewRoundState, "sent_back" | "approved">; note?: string | null },
  ): Promise<ReviewRoundRecord | null> =>
    (await db
      .update(reviewRound)
      .set({ ...fields, resolved_at: new Date().toISOString() })
      .where(eq(reviewRound.id, id))
      .returning()
      .get()) ?? null

  // ---- Contexts + sessions -------------------------------------------------
  const createContext = async (x: NewContext): Promise<ContextRecord> =>
    (await db.insert(context).values(x).returning().get()) as ContextRecord
  const getContext = async (id: string): Promise<ContextRecord | null> =>
    (await db.select().from(context).where(eq(context.id, id)).get()) ?? null
  const listContexts = async (orgId: string): Promise<ContextRecord[]> =>
    db
      .select()
      .from(context)
      .where(eq(context.org_id, orgId))
      .orderBy(desc(context.created_at))
      .all()
  // Sequential cascade (messages → sessions → context), like deleteCollection.
  // The org scope gates the WHOLE cascade, not just the context row — otherwise a
  // wrong-workspace call would wipe another tenant's sessions and leave the context.
  const deleteContext = async (id: string, orgId: string): Promise<void> => {
    const owned = await db
      .select({ id: context.id })
      .from(context)
      .where(and(eq(context.id, id), eq(context.org_id, orgId)))
      .get()
    if (!owned) return
    // Subqueries, never materialized id lists: a long-lived context accumulates
    // one session per ask, and an expanded IN (...) would blow D1's
    // 100-bound-parameter cap (the same constraint listArtifacts documents).
    await db
      .delete(sessionMessage)
      .where(
        inArray(
          sessionMessage.session_id,
          db
            .select({ id: contextSession.id })
            .from(contextSession)
            .where(eq(contextSession.context_id, id)),
        ),
      )
      .run()
    await db.delete(contextSession).where(eq(contextSession.context_id, id)).run()
    // The asker roster FKs the context — clear it before the parent row.
    await db.delete(contextAsker).where(eq(contextAsker.context_id, id)).run()
    await db.delete(context).where(eq(context.id, id)).run()
  }
  // A no-op on an unknown id, deliberately: the caller already 404'd before
  // stamping, and liveness is best-effort — never worth a throw.
  const touchContextSeen = async (id: string, at: string): Promise<void> => {
    await db.update(context).set({ runner_seen_at: at }).where(eq(context.id, id)).run()
  }
  const setContextAskPolicy = async (
    id: string,
    policy: "workspace" | "invited",
  ): Promise<void> => {
    await db.update(context).set({ ask_policy: policy }).where(eq(context.id, id)).run()
  }
  const listContextAskers = async (contextId: string): Promise<ContextAskerRecord[]> =>
    db
      .select()
      .from(contextAsker)
      .where(eq(contextAsker.context_id, contextId))
      .orderBy(contextAsker.created_at)
      .all() as Promise<ContextAskerRecord[]>
  const getContextAsker = async (
    contextId: string,
    userId: string,
  ): Promise<ContextAskerRecord | null> =>
    (await db
      .select()
      .from(contextAsker)
      .where(and(eq(contextAsker.context_id, contextId), eq(contextAsker.user_id, userId)))
      .get()) ?? null
  const addContextAsker = async (a: NewContextAsker): Promise<ContextAskerRecord> => {
    await db
      .insert(contextAsker)
      .values(a)
      .onConflictDoNothing({ target: [contextAsker.context_id, contextAsker.user_id] })
      .run()
    // Read back so a re-add returns the EXISTING row (the insert was a no-op).
    return (await getContextAsker(a.context_id, a.user_id)) as ContextAskerRecord
  }
  const removeContextAsker = async (contextId: string, userId: string): Promise<void> => {
    await db
      .delete(contextAsker)
      .where(and(eq(contextAsker.context_id, contextId), eq(contextAsker.user_id, userId)))
      .run()
  }
  const createSession = async (s: NewSession): Promise<SessionRecord> =>
    (await db.insert(contextSession).values(s).returning().get()) as SessionRecord
  const getSession = async (id: string): Promise<SessionRecord | null> =>
    (await db.select().from(contextSession).where(eq(contextSession.id, id)).get()) ?? null
  const listSessions = async (
    contextId: string,
    opts?: { askerId?: string; limit?: number },
  ): Promise<SessionRecord[]> => {
    const where = opts?.askerId
      ? and(eq(contextSession.context_id, contextId), eq(contextSession.asker_id, opts.askerId))
      : eq(contextSession.context_id, contextId)
    return db
      .select()
      .from(contextSession)
      .where(where)
      .orderBy(desc(contextSession.created_at))
      .limit(opts?.limit ?? 50)
      .all()
  }
  const pendingSessions = async (contextId: string, limit: number): Promise<SessionRecord[]> =>
    db
      .select()
      .from(contextSession)
      .where(and(eq(contextSession.context_id, contextId), eq(contextSession.state, "open")))
      .orderBy(asc(contextSession.created_at))
      .limit(limit)
      .all()
  const setSessionState = async (id: string, state: SessionState): Promise<SessionRecord | null> =>
    (await db
      .update(contextSession)
      .set({ state, updated_at: new Date().toISOString() })
      .where(eq(contextSession.id, id))
      .returning()
      .get()) ?? null
  // Two writes, no transaction (the createReviewRound pattern; D1 has no txn in
  // this driver). A crash between them leaves state stale: an unsettled agent
  // turn is caught by the runner's last-turn guard; a lost asker `open` waits
  // for the asker's next message. Both windows are milliseconds.
  const addSessionMessage = async (
    m: NewSessionMessage,
    state: SessionState,
  ): Promise<SessionMessageRecord> => {
    const row = (await db
      .insert(sessionMessage)
      .values(m)
      .returning()
      .get()) as SessionMessageRecord
    await db
      .update(contextSession)
      .set({ state, updated_at: new Date().toISOString() })
      .where(eq(contextSession.id, m.session_id))
      .run()
    return row
  }
  const listSessionMessages = async (sessionId: string): Promise<SessionMessageRecord[]> =>
    db
      .select()
      .from(sessionMessage)
      .where(eq(sessionMessage.session_id, sessionId))
      .orderBy(asc(sessionMessage.created_at))
      .all()
  const listSessionMessagesFor = async (sessionIds: string[]): Promise<SessionMessageRecord[]> =>
    sessionIds.length === 0
      ? []
      : db
          .select()
          .from(sessionMessage)
          .where(inArray(sessionMessage.session_id, sessionIds))
          .orderBy(asc(sessionMessage.created_at))
          .all()

  // ---- Notifications -----------------------------------------------------
  const createNotification = async (n: NewNotification): Promise<void> => {
    await db.insert(notification).values(n).run()
  }
  const createNotifications = async (rows: NewNotification[]): Promise<void> => {
    if (rows.length === 0) return
    await db.insert(notification).values(rows).run()
  }
  const listNotifications = async (userId: string, limit: number): Promise<NotificationRecord[]> =>
    db
      .select()
      .from(notification)
      .where(eq(notification.user_id, userId))
      .orderBy(desc(notification.created_at))
      .limit(limit)
      .all()
  const unreadNotificationCount = async (userId: string): Promise<number> =>
    (
      await db
        .select({ n: count() })
        .from(notification)
        .where(and(eq(notification.user_id, userId), eq(notification.read, 0)))
        .get()
    )?.n ?? 0
  const markNotificationsRead = async (userId: string, ids: string[] | "all"): Promise<void> => {
    const where =
      ids === "all"
        ? eq(notification.user_id, userId)
        : ids.length > 0
          ? and(eq(notification.user_id, userId), inArray(notification.id, ids))
          : null
    if (!where) return
    await db.update(notification).set({ read: 1 }).where(where).run()
  }

  // ---- Agents + pull inbox -----------------------------------------------
  const createAgent = async (a: NewAgent): Promise<AgentRecord> =>
    (await db.insert(agent).values(a).returning().get()) as AgentRecord
  const listAgents = async (orgId: string): Promise<AgentRecord[]> =>
    db.select().from(agent).where(eq(agent.org_id, orgId)).all()
  const setAgentHosted = async (
    id: string,
    orgId: string,
    hosted: 0 | 1,
  ): Promise<AgentRecord | null> =>
    (await db
      .update(agent)
      .set({ hosted })
      .where(and(eq(agent.id, id), eq(agent.org_id, orgId)))
      .returning()
      .get()) ?? null
  const getAgentByToken = async (token: string): Promise<AgentRecord | null> =>
    (await db.select().from(agent).where(eq(agent.token, token)).get()) ?? null
  // Introspect a Better Auth oidc-provider access token (its own tables, same DB).
  // Quoted camelCase identifiers resolve on better-sqlite3 + D1; the token is bound,
  // not interpolated. Joined to the app row for the granting client's display name.
  const getOAuthGrant = async (tokenHash: string): Promise<OAuthGrant | null> => {
    type GrantRow = {
      user_id: string
      user_email: string
      user_name: string | null
      client_id: string
      scopes: string | null
      expires_at: string | number
      client_name: string
    }
    let row: GrantRow | undefined
    try {
      row = (await db.get(sql`
        select t."userId" as user_id, t."clientId" as client_id, t."scopes" as scopes,
               t."expiresAt" as expires_at, c."name" as client_name,
               u."email" as user_email, u."name" as user_name
        from "oauthAccessToken" t
        join "oauthClient" c on c."clientId" = t."clientId"
        join "user" u on u."id" = t."userId"
        where t."token" = ${tokenHash} limit 1
      `)) as GrantRow | undefined
    } catch {
      // OAuth tables absent (oauth-provider not migrated) or query error: no grant.
      return null
    }
    if (!row) return null
    // Better Auth may store the expiry as an ISO string or an epoch (s or ms).
    const ts =
      typeof row.expires_at === "number"
        ? row.expires_at < 1e12
          ? row.expires_at * 1000
          : row.expires_at
        : Date.parse(row.expires_at)
    return {
      userId: row.user_id,
      userEmail: row.user_email,
      userName: row.user_name,
      clientId: row.client_id,
      clientName: row.client_name,
      scopes: parseOAuthScopes(row.scopes),
      expiresAt: new Date(ts),
    }
  }
  const getOAuthClientName = async (clientId: string): Promise<string | null> => {
    try {
      const r = (await db.get(
        sql`select "name" as name from "oauthClient" where "clientId" = ${clientId} limit 1`,
      )) as { name?: string | null } | undefined
      return r?.name ?? null
    } catch {
      return null
    }
  }
  const oauthClientExists = async (clientId: string): Promise<boolean> => {
    try {
      const r = await db.get(
        sql`select 1 as one from "oauthClient" where "clientId" = ${clientId} limit 1`,
      )
      return !!r
    } catch {
      return false
    }
  }
  // Replace the whole granted-workspace SET for (user, client): clear, then insert
  // one row per ticked workspace. An EMPTY array clears it → the grant reverts to
  // "all workspaces". This is what the consent screen's multi-select persists.
  const setOAuthClientWorkspaces = async (
    userId: string,
    clientId: string,
    orgIds: string[],
  ): Promise<void> => {
    await db
      .delete(oauthClientWorkspace)
      .where(
        and(eq(oauthClientWorkspace.user_id, userId), eq(oauthClientWorkspace.client_id, clientId)),
      )
      .run()
    for (const orgId of orgIds) {
      await db
        .insert(oauthClientWorkspace)
        .values({ id: crypto.randomUUID(), user_id: userId, client_id: clientId, org_id: orgId })
        .onConflictDoNothing()
        .run()
    }
  }
  // The grant's scoped workspaces. Empty array = "all workspaces" (unscoped).
  const getOAuthClientWorkspaces = async (userId: string, clientId: string): Promise<string[]> => {
    const rows = await db
      .select({ org_id: oauthClientWorkspace.org_id })
      .from(oauthClientWorkspace)
      .where(
        and(eq(oauthClientWorkspace.user_id, userId), eq(oauthClientWorkspace.client_id, clientId)),
      )
    return rows.map((r) => r.org_id)
  }
  const pruneStaleOAuthClients = async (cutoffIso: string): Promise<number> => {
    try {
      const r = (await db.run(sql`
        delete from "oauthClient"
        where "userId" is null
          and "createdAt" < ${cutoffIso}
          and "clientId" not in (select "clientId" from "oauthConsent")
          and "clientId" not in (select "clientId" from "oauthAccessToken")
      `)) as RunResult
      // Workspace bindings for clients that no longer exist (pruned above, or
      // any earlier sweep) have nothing left to resolve against — sweep them too.
      await db.run(sql`
        delete from oauth_client_workspace
        where client_id not in (select "clientId" from "oauthClient")
      `)
      return r.changes ?? r.meta?.changes ?? 0
    } catch {
      // OAuth tables absent → nothing to reap.
      return 0
    }
  }
  // The agents a user has authorized (one row per consented client): join oauthConsent to
  // oauthClient for the display name. `scopes` is stored as a JSON array string by Better
  // Auth; parse defensively. Empty when the oauth-provider tables aren't present.
  const listUserGrants = async (userId: string): Promise<OAuthGrantSummary[]> => {
    try {
      const rows = (await db.all(sql`
        select k."clientId" as client_id, c."name" as client_name,
               k."scopes" as scopes, k."updatedAt" as granted_at
        from "oauthConsent" k
        join "oauthClient" c on c."clientId" = k."clientId"
        where k."userId" = ${userId}
        order by k."updatedAt" desc
      `)) as {
        client_id: string
        client_name: string | null
        scopes: string | null
        granted_at: string | number | null
      }[]
      return rows.map((r) => {
        // updatedAt may be an ISO string or an epoch (s or ms), like getOAuthGrant's expiry.
        const ms =
          typeof r.granted_at === "number"
            ? r.granted_at < 1e12
              ? r.granted_at * 1000
              : r.granted_at
            : Date.parse(r.granted_at ?? "")
        return {
          clientId: r.client_id,
          clientName: r.client_name || r.client_id,
          scopes: parseOAuthScopes(r.scopes),
          grantedAt: new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString(),
        }
      })
    } catch {
      return []
    }
  }
  // The first artifact an agent produced FOR this user — the onboarding "published
  // via agent" signal. Two paths count: a direct MCP publish (version.source='mcp',
  // attributed to the human the agent acted for) and the propose → approve loop
  // (an agent proposal on_behalf_of this user that a human approved — the
  // recommended flow for propose-scoped grants, which never creates an
  // 'mcp'-stamped version itself). Earliest of the two wins.
  const firstAgentPublish = async (
    userId: string,
  ): Promise<{ short_id: string; title: string | null } | null> => {
    const direct = await db
      .select({ short_id: artifact.short_id, title: artifact.title, at: version.created_at })
      .from(version)
      .innerJoin(artifact, eq(artifact.id, version.artifact_id))
      .where(
        and(eq(version.author_id, userId), eq(version.source, "mcp"), isNull(artifact.removed_at)),
      )
      .orderBy(asc(version.created_at), asc(version.id))
      .limit(1)
      .get()
    const approved = await db
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
      .get()
    // A null decided_at (defensive; decide always stamps it) sorts LAST, never first.
    const winner =
      direct && approved
        ? approved.at && approved.at < direct.at
          ? approved
          : direct
        : (direct ?? approved)
    return winner ? { short_id: winner.short_id, title: winner.title } : null
  }
  // Revoke a user's grant to a client: drop the consent + every live token so access ends
  // now and a fresh consent is required. Best-effort per table (a table may not exist).
  const revokeUserGrant = async (userId: string, clientId: string): Promise<void> => {
    for (const table of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"]) {
      try {
        await db.run(
          sql`delete from ${sql.raw(`"${table}"`)} where "userId" = ${userId} and "clientId" = ${clientId}`,
        )
      } catch {
        // Table absent or column mismatch on this dialect → skip; the others still run.
      }
    }
  }
  const deleteAgent = async (id: string, orgId: string): Promise<void> => {
    await db
      .delete(agent)
      .where(and(eq(agent.id, id), eq(agent.org_id, orgId)))
      .run()
  }
  const createAgentMention = async (m: NewAgentMention): Promise<void> => {
    await db.insert(agentMention).values(m).run()
  }

  // ---- Workspace invitations ---------------------------------------------
  const createInvitation = async (i: NewInvitation): Promise<InvitationRecord> =>
    (await db.insert(invitation).values(i).returning().get()) as InvitationRecord
  const getInvitationByToken = async (tokenHash: string): Promise<InvitationRecord | null> =>
    (await db.select().from(invitation).where(eq(invitation.token, tokenHash)).get()) ?? null
  const listPendingInvitations = async (orgId: string): Promise<InvitationRecord[]> =>
    db
      .select()
      .from(invitation)
      .where(and(eq(invitation.org_id, orgId), isNull(invitation.accepted_at)))
      .orderBy(desc(invitation.created_at))
      .all()
  const deletePendingInvitationsFor = async (orgId: string, email: string): Promise<void> => {
    await db
      .delete(invitation)
      .where(
        and(
          eq(invitation.org_id, orgId),
          eq(invitation.email, email),
          isNull(invitation.accepted_at),
        ),
      )
      .run()
  }
  const deleteInvitation = async (id: string, orgId: string): Promise<void> => {
    await db
      .delete(invitation)
      .where(and(eq(invitation.id, id), eq(invitation.org_id, orgId)))
      .run()
  }
  const markInvitationAccepted = async (id: string): Promise<void> => {
    await db
      .update(invitation)
      .set({ accepted_at: new Date().toISOString() })
      .where(eq(invitation.id, id))
      .run()
  }

  // ---- Beta signups --------------------------------------------------------
  const recordBetaSignup = async (id: string, email: string): Promise<boolean> => {
    // The unique email index makes a concurrent duplicate a no-op; an empty
    // RETURNING means the email was already on the list.
    const row = await db
      .insert(betaSignup)
      .values({ id, email })
      .onConflictDoNothing()
      .returning()
      .get()
    return row !== undefined
  }

  // ---- Artifact invitations ------------------------------------------------
  const createArtifactInvite = async (i: NewArtifactInvite): Promise<ArtifactInviteRecord> =>
    (await db.insert(artifactInvite).values(i).returning().get()) as ArtifactInviteRecord
  const getArtifactInviteByToken = async (
    tokenHash: string,
  ): Promise<ArtifactInviteRecord | null> =>
    (await db.select().from(artifactInvite).where(eq(artifactInvite.token, tokenHash)).get()) ??
    null
  const listPendingArtifactInvites = async (artifactId: string): Promise<ArtifactInviteRecord[]> =>
    db
      .select()
      .from(artifactInvite)
      .where(and(eq(artifactInvite.artifact_id, artifactId), isNull(artifactInvite.accepted_at)))
      .orderBy(desc(artifactInvite.created_at))
      .all()
  const deletePendingArtifactInvitesFor = async (
    artifactId: string,
    email: string,
  ): Promise<void> => {
    await db
      .delete(artifactInvite)
      .where(
        and(
          eq(artifactInvite.artifact_id, artifactId),
          eq(artifactInvite.email, email),
          isNull(artifactInvite.accepted_at),
        ),
      )
      .run()
  }
  const deleteArtifactInvite = async (id: string, artifactId: string): Promise<void> => {
    await db
      .delete(artifactInvite)
      .where(and(eq(artifactInvite.id, id), eq(artifactInvite.artifact_id, artifactId)))
      .run()
  }
  const markArtifactInviteAccepted = async (id: string): Promise<void> => {
    await db
      .update(artifactInvite)
      .set({ accepted_at: new Date().toISOString() })
      .where(eq(artifactInvite.id, id))
      .run()
  }

  // ---- Account deletion cascade (see MetaStore.deleteUserData) ------------
  const deleteUserData = async (userId: string): Promise<void> => {
    // The user's own association rows go entirely.
    await db.delete(membership).where(eq(membership.user_id, userId)).run()
    await db.delete(artifactMember).where(eq(artifactMember.user_id, userId)).run()
    await db.delete(collectionMember).where(eq(collectionMember.user_id, userId)).run()
    await db.delete(follow).where(eq(follow.user_id, userId)).run()
    await db.delete(artifactFavorite).where(eq(artifactFavorite.user_id, userId)).run()
    await db.delete(notification).where(eq(notification.user_id, userId)).run()
    // Authorship is anonymized (nullable), so others' artifacts/threads survive intact.
    await db.update(artifact).set({ author_id: null }).where(eq(artifact.author_id, userId)).run()
    await db.update(version).set({ author_id: null }).where(eq(version.author_id, userId)).run()
    await db.update(comment).set({ author_id: null }).where(eq(comment.author_id, userId)).run()
    await db.update(proposal).set({ author_id: null }).where(eq(proposal.author_id, userId)).run()
    await db.update(agent).set({ created_by: null }).where(eq(agent.created_by, userId)).run()
    await db
      .update(invitation)
      .set({ invited_by: null })
      .where(eq(invitation.invited_by, userId))
      .run()
    await db
      .update(artifactInvite)
      .set({ invited_by: null })
      .where(eq(artifactInvite.invited_by, userId))
      .run()
    // Drop the personal workspace row (removes the "<name>'s Workspace" label).
    await db
      .delete(workspace)
      .where(eq(workspace.id, `ws_p_${userId}`))
      .run()
  }
  const listPendingAgentMentions = async (
    agentId: string,
    limit: number,
  ): Promise<AgentMentionRecord[]> =>
    db
      .select()
      .from(agentMention)
      .where(and(eq(agentMention.agent_id, agentId), eq(agentMention.state, "pending")))
      .orderBy(asc(agentMention.created_at))
      .limit(limit)
      .all()
  const ackAgentMention = async (agentId: string, id: string): Promise<boolean> => {
    const res = (await db
      .update(agentMention)
      .set({ state: "done" })
      .where(and(eq(agentMention.id, id), eq(agentMention.agent_id, agentId)))
      .run()) as RunResult
    return (res.changes ?? res.meta?.changes ?? 0) > 0
  }

  // ---- Moderation: reports + audit log -----------------------------------
  const createReport = async (r: NewReport): Promise<ReportRecord> =>
    (await db.insert(report).values(r).returning().get()) as ReportRecord
  const getReport = async (id: string, orgId?: string): Promise<ReportRecord | null> =>
    (await db
      .select()
      .from(report)
      .where(and(eq(report.id, id), orgId ? eq(report.org_id, orgId) : undefined))
      .get()) ?? null
  const listReports = async (
    orgId: string | undefined,
    opts?: { state?: ReportState; limit?: number },
  ): Promise<ReportRecord[]> => {
    const q = db
      .select()
      .from(report)
      .where(
        and(
          orgId ? eq(report.org_id, orgId) : undefined,
          opts?.state ? eq(report.state, opts.state) : undefined,
        ),
      )
      .orderBy(desc(report.created_at))
    return (opts?.limit ? q.limit(opts.limit) : q).all()
  }
  const countOpenReports = async (orgId: string | undefined): Promise<number> =>
    (
      await db
        .select({ n: count() })
        .from(report)
        .where(and(eq(report.state, "open"), orgId ? eq(report.org_id, orgId) : undefined))
        .get()
    )?.n ?? 0
  const setReportState = async (id: string, state: ReportState, orgId?: string): Promise<void> => {
    await db
      .update(report)
      .set({ state })
      .where(and(eq(report.id, id), orgId ? eq(report.org_id, orgId) : undefined))
      .run()
  }
  const createAuditLog = async (a: NewAuditLog): Promise<void> => {
    await db.insert(auditLog).values(a).run()
  }
  // Sequential cascade (used by D1). better-sqlite3 + pg override with a transaction.
  const deleteArtifact = async (id: string): Promise<void> => {
    // Delete FK-referencing tables before the artifact row itself. A context's
    // manifest FK means deleting a manifest deletes its context (and sessions) —
    // a context cannot outlive its definition, by design. Subqueries throughout
    // (D1's 100-bound-parameter cap; see deleteContext).
    const ctxIds = db
      .select({ id: context.id })
      .from(context)
      .where(eq(context.manifest_artifact_id, id))
    await db
      .delete(sessionMessage)
      .where(
        inArray(
          sessionMessage.session_id,
          db
            .select({ id: contextSession.id })
            .from(contextSession)
            .where(inArray(contextSession.context_id, ctxIds)),
        ),
      )
      .run()
    await db.delete(contextSession).where(inArray(contextSession.context_id, ctxIds)).run()
    await db.delete(context).where(eq(context.manifest_artifact_id, id)).run()
    await db.delete(reviewRound).where(eq(reviewRound.artifact_id, id)).run()
    await db.delete(version).where(eq(version.artifact_id, id)).run()
    await db.delete(comment).where(eq(comment.artifact_id, id)).run()
    await db.delete(artifactMember).where(eq(artifactMember.artifact_id, id)).run()
    await db.delete(artifactInvite).where(eq(artifactInvite.artifact_id, id)).run()
    await db.delete(artifactFavorite).where(eq(artifactFavorite.artifact_id, id)).run()
    await db.delete(artifactTag).where(eq(artifactTag.artifact_id, id)).run()
    await db.delete(collectionItem).where(eq(collectionItem.artifact_id, id)).run()
    await db.delete(domain).where(eq(domain.artifact_id, id)).run()
    await db.delete(proposal).where(eq(proposal.artifact_id, id)).run()
    await db.delete(report).where(eq(report.artifact_id, id)).run()
    await db.delete(notification).where(eq(notification.artifact_id, id)).run()
    await db.delete(agentMention).where(eq(agentMention.artifact_id, id)).run()
    await db.delete(slackThreadLink).where(eq(slackThreadLink.artifact_id, id)).run()
    await db.delete(artifact).where(eq(artifact.id, id)).run()
    // Drop the search-index row too. Contentless FTS/tsvector rows aren't drizzle
    // tables, so they ride the same raw-SQL path unindexArtifact uses.
    await unindexArtifact(id)
  }

  // Sequential move (used by D1). better-sqlite3 + pg override with a transaction.
  const moveArtifactOrg = async (artifactId: string, targetOrgId: string): Promise<void> => {
    await db.update(artifact).set({ org_id: targetOrgId }).where(eq(artifact.id, artifactId)).run()
    // Keep the search-index row's org in step so the moved artifact is findable in its
    // new workspace immediately (its text is unchanged by a move — only the scope is).
    // A stale org here could never LEAK it: listArtifacts re-checks org against the live
    // row, so this is a findability fix, not a visibility one.
    await db.run(
      sql`UPDATE artifact_search SET org_id = ${targetOrgId} WHERE artifact_id = ${artifactId}`,
    )
    // Collections are org-scoped groupings; the artifact leaves all of them.
    await db.delete(collectionItem).where(eq(collectionItem.artifact_id, artifactId)).run()
    // An org-scoped webhook that targeted this one artifact falls back to org-wide
    // rather than keep firing across a workspace boundary.
    await db
      .update(webhook)
      .set({ artifact_id: null })
      .where(eq(webhook.artifact_id, artifactId))
      .run()
  }

  // Sequential takedown (used by D1, which has no multi-statement transaction in
  // this driver). better-sqlite3 + pg override this with a real transaction; the
  // single bulk report UPDATE (vs the old per-report loop) is the same here.
  const takedownArtifact = async (input: TakedownInput): Promise<void> => {
    await db
      .update(artifact)
      .set({ removed_at: input.removedAt })
      .where(eq(artifact.id, input.artifactId))
      .run()
    await db
      .update(report)
      .set({ state: "actioned" })
      .where(
        and(
          eq(report.artifact_id, input.artifactId),
          eq(report.org_id, input.orgId),
          eq(report.state, "open"),
        ),
      )
      .run()
    await db.insert(auditLog).values(input.audit).run()
  }
  const listAuditLog = async (
    orgId: string | undefined,
    opts?: { artifactId?: string; limit?: number },
  ): Promise<AuditLogRecord[]> => {
    const q = db
      .select()
      .from(auditLog)
      .where(
        and(
          orgId ? eq(auditLog.org_id, orgId) : undefined,
          opts?.artifactId ? eq(auditLog.artifact_id, opts.artifactId) : undefined,
        ),
      )
      .orderBy(desc(auditLog.created_at))
    return (opts?.limit ? q.limit(opts.limit) : q).all()
  }

  // ---- Standalone image assets (POST /v1/assets -> GET /blob/:hash) ------
  const createAsset = async (a: NewAsset): Promise<AssetRecord> => {
    const inserted = await db.insert(asset).values(a).onConflictDoNothing().returning().get()
    // Content-addressed: a conflict means these exact bytes are already staged.
    return (inserted ?? (await getAsset(a.hash))) as AssetRecord
  }
  const getAsset = async (hash: string): Promise<AssetRecord | null> =>
    (await db.select().from(asset).where(eq(asset.hash, hash)).get()) ?? null
  const assetStorageBytes = async (orgId: string): Promise<number> => {
    // `hash` is the primary key, so unlike storageBytes there's no per-org
    // dedup to do — each row is already one distinct blob.
    const row = await db
      .select({ s: sql<number>`coalesce(sum(${asset.size_bytes}), 0)` })
      .from(asset)
      .where(eq(asset.org_id, orgId))
      .get()
    return Number(row?.s ?? 0)
  }

  return {
    createArtifact,
    setAccess,
    setLocked,
    getByShortId,
    getArtifactById,
    getArtifactsByIds,
    siblingsBySourcePaths,
    addVersion,
    listVersions,
    getVersion,
    reclassifyVersion,
    setVersionPreview,
    setVersionPreviewVariant,
    listArtifacts,
    indexArtifact,
    unindexArtifact,
    searchArtifactIds,
    artifactIdsByTag,
    artifactIdsByAuthor,
    artifactIdsOwnedBy,
    countArtifacts,
    countOwnedBy,
    storageBytes,
    tagCounts,
    deleteArtifact,
    moveArtifactOrg,
    setArtifactRemoved,
    setArtifactsRemoved,
    setArtifactTitle,
    setArtifactSourcePath,
    setArtifactUpdatedAt,
    setArtifactAuthor,
    createComment,
    getComment,
    updateComment,
    listComments,
    setThreadState,
    deleteThread,
    commentSignals,
    artifactIdsNeedingFeedback,
    createWebhook,
    listWebhooks,
    getWebhook,
    deleteWebhook,
    activeWebhooks,
    enqueueDelivery,
    enqueueDeliveries,
    claimDueDeliveries,
    updateDelivery,
    recentDeliveries,
    enqueueRenderJob,
    versionsMissingPreview,
    claimDueRenderJobs,
    updateRenderJob,
    getMembership,
    listMemberships,
    listMembershipsForOrgs,
    countMemberships,
    setMembership,
    removeMembership,
    getWorkspace,
    setWorkspace,
    deleteWorkspace,
    listWorkspaces,
    getArtifactMember,
    listArtifactMembers,
    artifactRolesFor,
    artifactIdsSharedWith,
    setArtifactMember,
    removeArtifactMember,
    listUserFavoriteIds,
    setFavorite,
    removeFavorite,
    addFollow,
    removeFollow,
    listFollows,
    followedArtifactIds,
    countFollowers,
    countFollowing,
    listFollowers,
    listFollowing,
    githubIdsForUser,
    githubLoginForUser,
    sharedOrgIds,
    listUserWorks,
    countUserWorks,
    tagsForArtifacts,
    previewReady,
    setArtifactTags,
    createCollection,
    getCollection,
    getCollections,
    updateCollection,
    setCollectionAccess,
    deleteCollection,
    listCollections,
    createFolder,
    listFolders,
    getFolder,
    updateFolder,
    deleteFolder,
    setItemFolder,
    collectionItemFolders,
    collectionArtifactIds,
    collectionIdsForArtifact,
    addCollectionItem,
    removeCollectionItem,
    getCollectionMember,
    listCollectionMembers,
    setCollectionMember,
    removeCollectionMember,
    collectionRolesForArtifact,
    collectionRolesForUser,
    collectionMemberCounts,
    createRepoSource,
    getRepoSource,
    listRepoSources,
    updateRepoSourceSync,
    setRepoSourceProgress,
    deleteRepoSource,
    listRepoSourcesByInstallation,
    listSyncingRepoSources,
    managedArtifactIds,
    getGithubApp,
    setGithubApp,
    getOrgSettings,
    setOrgSettings,
    getSlackInstall,
    setSlackInstall,
    deleteSlackInstall,
    getSlackThreadLinkByThread,
    getSlackThreadLinkByTs,
    setSlackThreadLink,
    getSlackUserLinkBySlackId,
    getSlackUserLinkByUser,
    setSlackUserLink,
    deleteSlackUserLink,
    getUserNotificationPref,
    setUserNotificationPref,
    upsertGithubInstallation,
    getGithubInstallation,
    listGithubInstallations,
    deleteGithubInstallation,
    getDomain,
    setDomain,
    getArtifactDomains,
    getWorkspaceDomains,
    updateDomain,
    deleteDomain,
    createProposal,
    createReviewRound,
    getPendingRound,
    listReviewRounds,
    resolveReviewRound,
    createContext,
    getContext,
    listContexts,
    deleteContext,
    touchContextSeen,
    setContextAskPolicy,
    listContextAskers,
    getContextAsker,
    addContextAsker,
    removeContextAsker,
    createSession,
    getSession,
    listSessions,
    pendingSessions,
    setSessionState,
    addSessionMessage,
    listSessionMessages,
    listSessionMessagesFor,
    getProposal,
    listProposals,
    decideProposal,
    createNotification,
    createNotifications,
    listNotifications,
    unreadNotificationCount,
    markNotificationsRead,
    createAgent,
    listAgents,
    setAgentHosted,
    getAgentByToken,
    getOAuthGrant,
    getOAuthClientName,
    oauthClientExists,
    listUserGrants,
    firstAgentPublish,
    revokeUserGrant,
    setOAuthClientWorkspaces,
    getOAuthClientWorkspaces,
    pruneStaleOAuthClients,
    deleteAgent,
    createAgentMention,
    listPendingAgentMentions,
    ackAgentMention,
    createInvitation,
    getInvitationByToken,
    listPendingInvitations,
    deletePendingInvitationsFor,
    deleteInvitation,
    markInvitationAccepted,
    recordBetaSignup,
    createArtifactInvite,
    getArtifactInviteByToken,
    listPendingArtifactInvites,
    deletePendingArtifactInvitesFor,
    deleteArtifactInvite,
    markArtifactInviteAccepted,
    deleteUserData,
    createReport,
    getReport,
    listReports,
    countOpenReports,
    setReportState,
    createAuditLog,
    takedownArtifact,
    listAuditLog,
    createAsset,
    getAsset,
    assetStorageBytes,
  }
}

export type SqliteRepos = ReturnType<typeof makeRepos>
