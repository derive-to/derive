import type { D1Database } from "@cloudflare/workers-types"
import type {
  GithubUserMapping,
  MetaStore,
  NewView,
  ProposalApproval,
  UserDir,
  UserProfile,
  VersionRecord,
  ViewStats,
} from "@derive/core"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import {
  composeArtifactDetail,
  composeAutomationsWithExecutors,
  composeBootstrap,
  composeCollectionsOverview,
  composeCommentsPage,
  composeContextsWithManifests,
  composeListEnrichment,
  composeNotificationsPage,
  composeOrgContext,
  composeWorkspaceSummary,
  composeWorkspacesAndOauthBinding,
} from "./list-enrichment"
import { makeRepos, schema } from "./repos"

const VIEW_WINDOW_MS = 30 * 86400_000

/**
 * Cloudflare D1 driver. The bulk of the MetaStore comes from the cross-dialect
 * repos (same SQLite query builder as better-sqlite3); D1 adds only the raw
 * analytics SQL + Better-Auth user directory. D1 has no interactive
 * transactions, so the repos' sequential writes are used as-is — addVersion
 * relies on UNIQUE(artifact_id, n) to turn a race into a clean error.
 *
 * Apply deploy/d1-schema.sql once before first use (generated from the shared
 * SCHEMA_STATEMENTS; see src/d1-schema.ts).
 *
 * The shared store contract also runs against a real D1 database in CI. Derive
 * still ships no D1 Worker entrypoint; deployments provide that composition.
 */
export function createD1Store(d1: D1Database): MetaStore {
  const db = drizzle(d1, { schema })
  const repos = makeRepos(db)

  // Embedded round trips are (near-)free, so `listEnrichment` composes the
  // individual queries (attached after the literal — it needs the finished store).
  const store: Omit<
    MetaStore,
    | "listEnrichment"
    | "artifactDetail"
    | "commentsPage"
    | "contextsWithManifests"
    | "notificationsPage"
    | "automationsWithExecutors"
    | "collectionsOverview"
    | "bootstrap"
    | "workspaceSummary"
    | "workspacesAndOauthBinding"
    | "orgContext"
  > = {
    ...repos,

    approveOpenProposal: async (
      id: string,
      approval: ProposalApproval,
    ): Promise<VersionRecord | null> => {
      const now = new Date().toISOString()
      // D1 has no interactive transaction, but batch() is transactional. Each
      // statement predicates on the proposal still being open; concurrent batches
      // serialize, so only the first inserts a version and advances the artifact.
      const results = await d1.batch([
        d1
          .prepare(
            `INSERT INTO version
              (id, artifact_id, n, blob_key, content_type, size_bytes, author, author_id, message, name)
             SELECT ?, p.artifact_id, a.current_version + 1, p.blob_key, p.content_type, ?,
                    p.author, p.author_id, coalesce(p.message, 'Approved proposal'), NULL
             FROM proposal p JOIN artifact a ON a.id = p.artifact_id
             WHERE p.id = ? AND p.state = 'open'`,
          )
          .bind(approval.version_id, approval.size_bytes, id),
        d1
          .prepare(
            `UPDATE artifact
             SET current_version = current_version + 1,
                 current_content_type = (SELECT content_type FROM proposal WHERE id = ? AND state = 'open'),
                 updated_at = ?,
                 author_name = (SELECT author FROM proposal WHERE id = ? AND state = 'open'),
                 author_login = NULL,
                 author_avatar = NULL,
                 author_gh_id = NULL,
                 author_id = (SELECT author_id FROM proposal WHERE id = ? AND state = 'open')
             WHERE id = (SELECT artifact_id FROM proposal WHERE id = ? AND state = 'open')`,
          )
          .bind(id, now, id, id, id),
        d1
          .prepare(
            `UPDATE proposal
             SET state = 'approved', decided_by = ?, decided_by_id = ?,
                 decided_version = (SELECT current_version FROM artifact WHERE id = proposal.artifact_id),
                 decision_note = ?, decided_at = ?
             WHERE id = ? AND state = 'open'`,
          )
          .bind(
            approval.decided_by,
            approval.decided_by_id,
            approval.decision_note ?? null,
            now,
            id,
          ),
      ])
      if ((results[0]?.meta.changes ?? 0) !== 1) return null
      const decided = await repos.getProposal(id)
      if (!decided || decided.decided_version === null)
        throw new Error(`approved proposal did not record a version: ${id}`)
      return repos.getVersion(decided.artifact_id, decided.decided_version)
    },

    // ---- View analytics (raw SQL) ----------------------------------------
    recordView: async (v: NewView): Promise<void> => {
      await db.run(
        sql`INSERT INTO view (id, artifact_id, version, viewer, viewer_kind) VALUES (${v.id}, ${v.artifact_id}, ${v.version}, ${v.viewer}, ${v.viewer_kind})`,
      )
      // Activation stamp: first non-author view only (the route already excluded
      // owner self-views). WHERE IS NULL keeps it a one-time write.
      await db.run(
        sql`UPDATE artifact SET first_foreign_view_at = ${new Date().toISOString()} WHERE id = ${v.artifact_id} AND first_foreign_view_at IS NULL`,
      )
    },
    viewedSince: async (
      artifactId: string,
      viewer: string,
      version: number,
      sinceIso: string,
    ): Promise<boolean> => {
      const row = await db.get(
        sql`SELECT 1 FROM view WHERE artifact_id=${artifactId} AND viewer=${viewer} AND version=${version} AND created_at>=${sinceIso} LIMIT 1`,
      )
      return !!row
    },
    pruneViews: async (cutoffIso: string): Promise<number> => {
      const res = await db.run(sql`DELETE FROM view WHERE created_at < ${cutoffIso}`)
      return res.meta.changes ?? 0
    },
    pruneViewsByViewers: async (viewers: string[]): Promise<number> => {
      if (viewers.length === 0) return 0
      const list = sql.join(
        viewers.map((v) => sql`${v}`),
        sql`, `,
      )
      const res = await db.run(
        sql`DELETE FROM view WHERE viewer_kind='user' AND viewer IN (${list})`,
      )
      return res.meta.changes ?? 0
    },
    viewStats: async (artifactId: string): Promise<ViewStats> => {
      const cutoff = new Date(Date.now() - VIEW_WINDOW_MS).toISOString()
      const tot = (await db.get(
        sql`SELECT count(*) n FROM view WHERE artifact_id=${artifactId}`,
      )) as { n: number }
      const uni = (await db.get(
        sql`SELECT count(DISTINCT viewer) n FROM view WHERE artifact_id=${artifactId}`,
      )) as { n: number }
      const anon = (await db.get(
        sql`SELECT count(DISTINCT viewer) n FROM view WHERE artifact_id=${artifactId} AND viewer_kind='anon'`,
      )) as { n: number }
      const perVersion = (await db.all(
        sql`SELECT version, count(*) count FROM view WHERE artifact_id=${artifactId} GROUP BY version ORDER BY version`,
      )) as { version: number; count: number }[]
      const daily = (await db.all(
        sql`SELECT substr(created_at,1,10) day, count(*) count FROM view WHERE artifact_id=${artifactId} AND created_at>=${cutoff} GROUP BY day ORDER BY day`,
      )) as { day: string; count: number }[]
      const recent = (await db.all(
        sql`SELECT viewer, viewer_kind kind, max(created_at) at FROM view WHERE artifact_id=${artifactId} GROUP BY viewer, viewer_kind ORDER BY at DESC LIMIT 8`,
      )) as { viewer: string; kind: "user" | "anon"; at: string }[]
      return { total: tot.n, unique: uni.n, anonViewers: anon.n, perVersion, daily, recent }
    },
    viewCounts: async (artifactIds: string[]): Promise<Record<string, number>> => {
      if (artifactIds.length === 0) return {}
      const ids = sql.join(
        artifactIds.map((id) => sql`${id}`),
        sql`, `,
      )
      const rows = (await db.all(
        sql`SELECT artifact_id, count(*) c FROM view WHERE artifact_id IN (${ids}) GROUP BY artifact_id`,
      )) as { artifact_id: string; c: number }[]
      const out: Record<string, number> = {}
      for (const r of rows) out[r.artifact_id] = r.c
      return out
    },
    openProposalCounts: async (artifactIds: string[]): Promise<Record<string, number>> => {
      if (artifactIds.length === 0) return {}
      const ids = sql.join(
        artifactIds.map((id) => sql`${id}`),
        sql`, `,
      )
      const rows = (await db.all(
        sql`SELECT artifact_id, count(*) c FROM proposal WHERE state='open' AND artifact_id IN (${ids}) GROUP BY artifact_id`,
      )) as { artifact_id: string; c: number }[]
      const out: Record<string, number> = {}
      for (const r of rows) out[r.artifact_id] = r.c
      return out
    },

    // ---- User directory (Better Auth's `user` table; raw, may be absent) -
    findUserByEmail: async (email: string): Promise<UserDir | null> => {
      try {
        return (
          ((await db.get(
            sql`SELECT id, email, name, image FROM user WHERE email = ${email}`,
          )) as UserDir) ?? null
        )
      } catch {
        return null
      }
    },
    getUsers: async (ids: string[]): Promise<UserDir[]> => {
      if (ids.length === 0) return []
      try {
        const list = sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )
        return (await db.all(
          sql`SELECT id, email, name, image, username, profession, about FROM user WHERE id IN (${list})`,
        )) as UserDir[]
      } catch {
        return []
      }
    },
    // Map GitHub numeric user ids to Derive accounts (account.accountId → user), scoped to
    // the github social provider. Best-effort — [] when the Better Auth tables are absent.
    usersByGithubIds: async (ghIds: string[]): Promise<GithubUserMapping[]> => {
      if (ghIds.length === 0) return []
      try {
        const list = sql.join(
          ghIds.map((id) => sql`${id}`),
          sql`, `,
        )
        return (await db.all(
          sql`SELECT a.accountId gh_id, u.id, u.name, u.image, u.username
              FROM account a JOIN user u ON u.id = a.userId
              WHERE a.providerId = 'github' AND a.accountId IN (${list})`,
        )) as GithubUserMapping[]
      } catch {
        return []
      }
    },
    // Idempotent backfill (see sqlite.ts) — stamp author_id from a known author_gh_id→user mapping.
    backfillAuthorIds: async (): Promise<number> => {
      try {
        const r = (await db.run(
          sql`UPDATE artifact SET author_id = (
                SELECT u.id FROM account a JOIN user u ON u.id = a.userId
                WHERE a.providerId = 'github' AND a.accountId = artifact.author_gh_id LIMIT 1)
              WHERE author_id IS NULL AND author_gh_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM account a JOIN user u ON u.id = a.userId
                  WHERE a.providerId = 'github' AND a.accountId = artifact.author_gh_id)`,
        )) as { meta?: { changes?: number } }
        return r.meta?.changes ?? 0
      } catch {
        return 0
      }
    },
    getUserByUsername: async (username: string): Promise<UserProfile | null> => {
      try {
        return (
          ((await db.get(
            sql`SELECT id, name, image, username, profession, about, discoverable FROM user WHERE username = ${username}`,
          )) as UserProfile) ?? null
        )
      } catch {
        return null
      }
    },
    setUsername: async (userId: string, username: string): Promise<"ok" | "taken"> => {
      // Handles are stored lowercased, so a plain equality check finds the holder.
      const holder = (await db.get(sql`SELECT id FROM user WHERE username = ${username}`)) as
        | { id: string }
        | undefined
      if (holder && holder.id !== userId) return "taken"
      try {
        await db.run(sql`UPDATE user SET username = ${username} WHERE id = ${userId}`)
        return "ok"
      } catch {
        // Unique-index race: claimed between the check and the write.
        return "taken"
      }
    },
    setUserImage: async (userId: string, image: string): Promise<void> => {
      await db.run(sql`UPDATE user SET image = ${image} WHERE id = ${userId}`)
    },
    setUserDiscoverable: async (userId: string, discoverable: boolean): Promise<void> => {
      await db.run(sql`UPDATE user SET discoverable = ${discoverable ? 1 : 0} WHERE id = ${userId}`)
    },
    setUserOnboarded: async (userId: string, onboarded: boolean): Promise<void> => {
      await db.run(sql`UPDATE user SET onboarded = ${onboarded ? 1 : 0} WHERE id = ${userId}`)
    },
    setUserProfile: async (userId, fields): Promise<void> => {
      // Patch only the fields provided (undefined = leave as-is; null = clear).
      if (fields.profession !== undefined)
        await db.run(sql`UPDATE user SET profession = ${fields.profession} WHERE id = ${userId}`)
      if (fields.about !== undefined)
        await db.run(sql`UPDATE user SET about = ${fields.about} WHERE id = ${userId}`)
      if (fields.brandprint !== undefined)
        await db.run(sql`UPDATE user SET brandprint = ${fields.brandprint} WHERE id = ${userId}`)
    },
    getUserBrandprint: async (userId: string): Promise<string | null> => {
      try {
        const row = (await db.get(sql`SELECT brandprint FROM user WHERE id = ${userId}`)) as
          | { brandprint?: string | null }
          | undefined
        return row?.brandprint ?? null
      } catch {
        return null // older/minimal user table without the column
      }
    },
    searchDiscoverableUsers: async (q: string, limit: number): Promise<UserProfile[]> => {
      const s = q.trim().toLowerCase()
      if (!s) return []
      try {
        // Escape LIKE metacharacters so a literal %/_/\ matches itself, not "anything".
        const like = `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
        return (await db.all(
          // discoverable IS NOT 0 → true OR unset(null) both match (on by default);
          // only an explicit 0 (opted out) is excluded.
          sql`SELECT id, name, image, username, profession, about FROM user
              WHERE discoverable IS NOT 0 AND username IS NOT NULL
                AND (lower(username) LIKE ${like} ESCAPE '\\' OR lower(name) LIKE ${like} ESCAPE '\\')
              ORDER BY username LIMIT ${limit}`,
        )) as UserProfile[]
      } catch {
        return []
      }
    },
    listDiscoverableUsers: async (limit: number): Promise<UserProfile[]> => {
      try {
        return (await db.all(
          sql`SELECT id, name, image, username, profession, about FROM user
              WHERE discoverable IS NOT 0 AND username IS NOT NULL
              ORDER BY username LIMIT ${limit}`,
        )) as UserProfile[]
      } catch {
        return []
      }
    },

    listWorkspaceMates: async (userId: string, limit: number): Promise<UserProfile[]> => {
      try {
        return (await db.all(
          sql`SELECT DISTINCT u.id, u.name, u.image, u.username, u.profession, u.about
              FROM membership m1
              JOIN membership m2 ON m2.org_id = m1.org_id AND m2.user_id != m1.user_id
              JOIN user u ON u.id = m2.user_id
              WHERE m1.user_id = ${userId} AND u.username IS NOT NULL
              ORDER BY u.username LIMIT ${limit}`,
        )) as UserProfile[]
      } catch {
        return []
      }
    },
  }
  return {
    ...store,
    listEnrichment: (opts) => composeListEnrichment(store, opts),
    artifactDetail: (opts) => composeArtifactDetail(store, opts),
    commentsPage: (artifactId, versionN, opts) =>
      composeCommentsPage(store, artifactId, versionN, opts),
    contextsWithManifests: (orgId) => composeContextsWithManifests(store, orgId),
    notificationsPage: (userId, limit) => composeNotificationsPage(store, userId, limit),
    automationsWithExecutors: (orgId, limit) =>
      composeAutomationsWithExecutors(store, orgId, limit),
    collectionsOverview: (orgId, viewer) => composeCollectionsOverview(store, orgId, viewer),
    workspaceSummary: (orgId, userId) => composeWorkspaceSummary(store, orgId, userId),
    bootstrap: (orgId, userId, limit, viewer) =>
      composeBootstrap(store, orgId, userId, limit, viewer),
    workspacesAndOauthBinding: (userId, clientId) =>
      composeWorkspacesAndOauthBinding(store, userId, clientId),
    orgContext: (orgId, userId) => composeOrgContext(store, orgId, userId),
  }
}

/**
 * Back-compat constructor surface: `new D1MetaStore(d1)` returns the store built
 * by `createD1Store`. Kept so the Workers entrypoint + index export are unchanged.
 */
export type D1MetaStore = MetaStore
export const D1MetaStore = createD1Store as unknown as {
  new (d1: D1Database): MetaStore
}
