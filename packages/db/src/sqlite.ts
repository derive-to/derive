import type {
  GithubUserMapping,
  MetaStore,
  NewVersion,
  UserDir,
  UserProfile,
  VersionRecord,
  ViewStats,
} from "@derive/core"
import Database from "better-sqlite3"
import { and, eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { makeRepos, schema } from "./repos"
import {
  agentMention,
  artifact,
  artifactFavorite,
  artifactMember,
  artifactTag,
  auditLog,
  collection,
  collectionItem,
  collectionMember,
  comment,
  context,
  contextSession,
  domain,
  MIGRATION_STATEMENTS,
  notification,
  proposal,
  report,
  reviewRound,
  SCHEMA_STATEMENTS,
  sessionMessage,
  slackThreadLink,
  version,
  versionData,
  webhook,
} from "./schema"

const VIEW_WINDOW_MS = 30 * 86400_000

/**
 * Embedded SQLite (WAL) — the zero-dependency default; no external services. The
 * bulk of the MetaStore comes from the cross-dialect repos; this driver adds the
 * synchronous-transaction writes, the raw analytics SQL (clearer as raw GROUP BY),
 * and the Better-Auth user-directory lookups.
 */
export function createSqliteStore(path: string): MetaStore & { close(): void } {
  const raw = new Database(path)
  raw.pragma("journal_mode = WAL")
  // WAL still allows only one writer at a time; without a busy timeout a second
  // concurrent writer fails immediately with SQLITE_BUSY. Make writers wait for
  // the lock instead (graceful under bursty concurrent load, incl. parallel e2e
  // and busy self-host instances). NORMAL sync is the standard, safe WAL pairing.
  raw.pragma("busy_timeout = 5000")
  raw.pragma("synchronous = NORMAL")
  // Forward-only column adds run BEFORE the schema statements so a raw partial
  // index in SCHEMA_STATEMENTS that references a migrated column (e.g. the
  // dedupe uniqueness on context_session.dedupe_key) resolves on a pre-existing
  // DB. On a FRESH DB these ALTERs harmlessly fail — the table isn't created yet,
  // swallowed below — and the SCHEMA_STATEMENTS pass then creates the full tables
  // WITH those columns. SQLite lacks ADD COLUMN IF NOT EXISTS; a "duplicate
  // column" throw just means the migration is already applied.
  for (const stmt of MIGRATION_STATEMENTS) {
    try {
      raw.exec(stmt)
    } catch {
      /* already applied, or the table isn't created yet on a fresh DB */
    }
  }
  for (const stmt of SCHEMA_STATEMENTS) raw.exec(stmt)
  const db = drizzle(raw, { schema })
  const repos = makeRepos(db)

  return {
    ...repos,

    // Synchronous transaction: a concurrent increment can't interleave between
    // the read and the write, so version numbers never collide.
    addVersion: async (artifactId: string, v: NewVersion): Promise<VersionRecord> => {
      const n = db.transaction((tx) => {
        const row = tx
          .select({ cv: artifact.current_version })
          .from(artifact)
          .where(eq(artifact.id, artifactId))
          .get()
        if (!row) throw new Error(`artifact not found: ${artifactId}`)
        const next = row.cv + 1
        tx.insert(version)
          .values({ ...v, artifact_id: artifactId, n: next })
          .run()
        tx.update(artifact)
          .set({
            current_version: next,
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
          .run()
        return next
      })
      return (await repos.getVersion(artifactId, n)) as VersionRecord
    },

    setArtifactTags: async (artifactId: string, tags: string[]): Promise<void> => {
      raw.transaction(() => {
        db.delete(artifactTag).where(eq(artifactTag.artifact_id, artifactId)).run()
        for (const tag of tags)
          db.insert(artifactTag)
            .values({ id: crypto.randomUUID(), artifact_id: artifactId, tag })
            .run()
      })()
    },

    deleteCollection: async (id: string): Promise<void> => {
      raw.transaction(() => {
        db.delete(collectionItem).where(eq(collectionItem.collection_id, id)).run()
        db.delete(collectionMember).where(eq(collectionMember.collection_id, id)).run()
        db.delete(collection).where(eq(collection.id, id)).run()
      })()
    },

    // Atomic: the thread's comments and everything keyed to it commit together, so a
    // removed thread never leaves a dangling notification / agent mention / Slack link.
    deleteThread: async (artifactId: string, threadId: string): Promise<void> => {
      raw.transaction(() => {
        db.delete(notification)
          .where(
            and(eq(notification.artifact_id, artifactId), eq(notification.thread_id, threadId)),
          )
          .run()
        db.delete(agentMention)
          .where(
            and(eq(agentMention.artifact_id, artifactId), eq(agentMention.thread_id, threadId)),
          )
          .run()
        db.delete(slackThreadLink).where(eq(slackThreadLink.thread_id, threadId)).run()
        db.delete(comment)
          .where(and(eq(comment.artifact_id, artifactId), eq(comment.thread_id, threadId)))
          .run()
      })()
    },

    // Atomic delete: all FK-dependent rows and the artifact itself commit together.
    deleteArtifact: async (id: string): Promise<void> => {
      raw.transaction(() => {
        // A context's manifest FK means deleting a manifest deletes its context
        // (and sessions) — a context cannot outlive its definition, by design.
        // Subqueries, matching the shared query layer (D1 bound-parameter cap).
        const ctxIds = db
          .select({ id: context.id })
          .from(context)
          .where(eq(context.manifest_artifact_id, id))
        db.delete(sessionMessage)
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
        db.delete(contextSession).where(inArray(contextSession.context_id, ctxIds)).run()
        db.delete(context).where(eq(context.manifest_artifact_id, id)).run()
        db.delete(reviewRound).where(eq(reviewRound.artifact_id, id)).run()
        // Artifact-SCOPED webhooks only (artifact_id = this id). A workspace-wide webhook
        // has a null artifact_id and never matches, so it survives, which is right: it was
        // never about this artifact. Found by scripts/check-delete-cascade.mjs.
        db.delete(webhook).where(eq(webhook.artifact_id, id)).run()
        db.delete(versionData).where(eq(versionData.artifact_id, id)).run()
        db.delete(version).where(eq(version.artifact_id, id)).run()
        db.delete(comment).where(eq(comment.artifact_id, id)).run()
        db.delete(artifactMember).where(eq(artifactMember.artifact_id, id)).run()
        db.delete(artifactFavorite).where(eq(artifactFavorite.artifact_id, id)).run()
        db.delete(artifactTag).where(eq(artifactTag.artifact_id, id)).run()
        db.delete(collectionItem).where(eq(collectionItem.artifact_id, id)).run()
        db.delete(domain).where(eq(domain.artifact_id, id)).run()
        db.delete(proposal).where(eq(proposal.artifact_id, id)).run()
        db.delete(report).where(eq(report.artifact_id, id)).run()
        db.delete(notification).where(eq(notification.artifact_id, id)).run()
        db.delete(agentMention).where(eq(agentMention.artifact_id, id)).run()
        db.delete(slackThreadLink).where(eq(slackThreadLink.artifact_id, id)).run()
        db.delete(artifact).where(eq(artifact.id, id)).run()
      })()
      // The contentless fts5 row isn't a drizzle table, so it rides the inherited
      // unindexArtifact (raw SQL) after the delete commits. An orphan left by a crash
      // here is harmless: listArtifacts filters the deleted artifact out of any result.
      await repos.unindexArtifact(id)
    },

    // Atomic move: org_id flips, collection membership and any artifact-targeted
    // webhook detach, all in one commit.
    moveArtifactOrg: async (artifactId: string, targetOrgId: string): Promise<void> => {
      raw.transaction(() => {
        db.update(artifact).set({ org_id: targetOrgId }).where(eq(artifact.id, artifactId)).run()
        db.delete(collectionItem).where(eq(collectionItem.artifact_id, artifactId)).run()
        db.update(webhook)
          .set({ artifact_id: null })
          .where(eq(webhook.artifact_id, artifactId))
          .run()
      })()
      // Re-scope the fts5 row to match (raw, since it's not a drizzle model). A stale org
      // can't leak the artifact — listArtifacts re-checks org against the live row — so
      // this is only a findability fix, safe to run outside the move's transaction.
      raw
        .prepare(`UPDATE artifact_search SET org_id = ? WHERE artifact_id = ?`)
        .run(targetOrgId, artifactId)
    },

    // Atomic takedown: the tombstone, the bulk open-report resolution, and the
    // audit entry commit together (or not at all), so a crash mid-takedown can't
    // leave an artifact removed with its reports still open or no audit trail.
    takedownArtifact: async (input): Promise<void> => {
      raw.transaction(() => {
        db.update(artifact)
          .set({ removed_at: input.removedAt })
          .where(eq(artifact.id, input.artifactId))
          .run()
        db.update(report)
          .set({ state: "actioned" })
          .where(
            and(
              eq(report.artifact_id, input.artifactId),
              eq(report.org_id, input.orgId),
              eq(report.state, "open"),
            ),
          )
          .run()
        db.insert(auditLog).values(input.audit).run()
      })()
    },

    // ---- View analytics (raw SQL: aggregation reads clearer) -------------
    recordView: async (v): Promise<void> => {
      raw
        .prepare(
          `INSERT INTO view (id, artifact_id, version, viewer, viewer_kind) VALUES (?,?,?,?,?)`,
        )
        .run(v.id, v.artifact_id, v.version, v.viewer, v.viewer_kind)
      // Activation stamp: first non-author view only (the route already excluded
      // owner self-views). WHERE IS NULL keeps it a one-time write.
      raw
        .prepare(
          `UPDATE artifact SET first_foreign_view_at = ? WHERE id = ? AND first_foreign_view_at IS NULL`,
        )
        .run(new Date().toISOString(), v.artifact_id)
    },
    viewedSince: async (artifactId, viewer, version, sinceIso): Promise<boolean> => {
      const row = raw
        .prepare(
          `SELECT 1 FROM view WHERE artifact_id=? AND viewer=? AND version=? AND created_at>=? LIMIT 1`,
        )
        .get(artifactId, viewer, version, sinceIso)
      return !!row
    },
    pruneViews: async (cutoffIso): Promise<number> =>
      raw.prepare(`DELETE FROM view WHERE created_at < ?`).run(cutoffIso).changes,
    pruneViewsByViewers: async (viewers): Promise<number> => {
      if (viewers.length === 0) return 0
      const ph = viewers.map(() => "?").join(",")
      return raw
        .prepare(`DELETE FROM view WHERE viewer_kind='user' AND viewer IN (${ph})`)
        .run(...viewers).changes
    },
    viewStats: async (artifactId): Promise<ViewStats> => {
      const cutoff = new Date(Date.now() - VIEW_WINDOW_MS).toISOString()
      const n = (q: string, ...p: unknown[]) => (raw.prepare(q).get(...p) as { n: number }).n
      return {
        total: n(`SELECT count(*) n FROM view WHERE artifact_id=?`, artifactId),
        unique: n(`SELECT count(DISTINCT viewer) n FROM view WHERE artifact_id=?`, artifactId),
        anonViewers: n(
          `SELECT count(DISTINCT viewer) n FROM view WHERE artifact_id=? AND viewer_kind='anon'`,
          artifactId,
        ),
        perVersion: raw
          .prepare(
            `SELECT version, count(*) count FROM view WHERE artifact_id=? GROUP BY version ORDER BY version`,
          )
          .all(artifactId) as { version: number; count: number }[],
        daily: raw
          .prepare(
            `SELECT substr(created_at,1,10) day, count(*) count FROM view WHERE artifact_id=? AND created_at>=? GROUP BY day ORDER BY day`,
          )
          .all(artifactId, cutoff) as { day: string; count: number }[],
        recent: raw
          .prepare(
            `SELECT viewer, viewer_kind kind, max(created_at) at FROM view WHERE artifact_id=? GROUP BY viewer, viewer_kind ORDER BY at DESC LIMIT 8`,
          )
          .all(artifactId) as { viewer: string; kind: "user" | "anon"; at: string }[],
      }
    },
    viewCounts: async (artifactIds): Promise<Record<string, number>> => {
      if (artifactIds.length === 0) return {}
      const ph = artifactIds.map(() => "?").join(",")
      const rows = raw
        .prepare(
          `SELECT artifact_id, count(*) c FROM view WHERE artifact_id IN (${ph}) GROUP BY artifact_id`,
        )
        .all(...artifactIds) as { artifact_id: string; c: number }[]
      const out: Record<string, number> = {}
      for (const r of rows) out[r.artifact_id] = r.c
      return out
    },
    openProposalCounts: async (artifactIds): Promise<Record<string, number>> => {
      if (artifactIds.length === 0) return {}
      const ph = artifactIds.map(() => "?").join(",")
      const rows = raw
        .prepare(
          `SELECT artifact_id, count(*) c FROM proposal WHERE state='open' AND artifact_id IN (${ph}) GROUP BY artifact_id`,
        )
        .all(...artifactIds) as { artifact_id: string; c: number }[]
      const out: Record<string, number> = {}
      for (const r of rows) out[r.artifact_id] = r.c
      return out
    },
    previewReady: async (artifactIds): Promise<Record<string, boolean>> => {
      if (artifactIds.length === 0) return {}
      const ph = artifactIds.map(() => "?").join(",")
      const rows = raw
        .prepare(
          `SELECT a.id artifact_id FROM artifact a
           JOIN version v ON v.artifact_id = a.id AND v.n = a.current_version
           WHERE v.preview_status = 'ready' AND a.id IN (${ph})`,
        )
        .all(...artifactIds) as { artifact_id: string }[]
      const out: Record<string, boolean> = {}
      for (const r of rows) out[r.artifact_id] = true
      return out
    },

    // ---- User directory (Better Auth's `user` table; raw, may be absent) -
    findUserByEmail: async (email): Promise<UserDir | null> => {
      try {
        return (
          (raw
            .prepare(`SELECT id, email, name, image FROM user WHERE email = ?`)
            .get(email) as UserDir) ?? null
        )
      } catch {
        return null
      }
    },
    getUsers: async (ids): Promise<UserDir[]> => {
      if (ids.length === 0) return []
      try {
        const ph = ids.map(() => "?").join(",")
        return raw
          .prepare(
            `SELECT id, email, name, image, username, profession, about FROM user WHERE id IN (${ph})`,
          )
          .all(...ids) as UserDir[]
      } catch {
        return []
      }
    },
    // Map GitHub numeric user ids to the Derive accounts that signed in with GitHub:
    // account.accountId (the stringified GitHub id) → user. providerId='github' scopes
    // it to the social provider. Best-effort — [] when the Better Auth tables are absent.
    usersByGithubIds: async (ghIds): Promise<GithubUserMapping[]> => {
      if (ghIds.length === 0) return []
      try {
        const ph = ghIds.map(() => "?").join(",")
        return raw
          .prepare(
            `SELECT a.accountId gh_id, u.id, u.name, u.image, u.username
             FROM account a JOIN user u ON u.id = a.userId
             WHERE a.providerId = 'github' AND a.accountId IN (${ph})`,
          )
          .all(...ghIds) as GithubUserMapping[]
      } catch {
        return []
      }
    },
    // Idempotent backfill: stamp author_id where a synced artifact's author_gh_id maps
    // to a Derive account and author_id is still null. Correlated subquery; only fills
    // rows with a known mapping, so it's a no-op once applied.
    backfillAuthorIds: async (): Promise<number> => {
      try {
        return raw
          .prepare(
            `UPDATE artifact SET author_id = (
               SELECT u.id FROM account a JOIN user u ON u.id = a.userId
               WHERE a.providerId = 'github' AND a.accountId = artifact.author_gh_id LIMIT 1)
             WHERE author_id IS NULL AND author_gh_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM account a JOIN user u ON u.id = a.userId
                 WHERE a.providerId = 'github' AND a.accountId = artifact.author_gh_id)`,
          )
          .run().changes
      } catch {
        return 0
      }
    },
    getUserByUsername: async (username): Promise<UserProfile | null> => {
      try {
        return (
          (raw
            .prepare(
              `SELECT id, name, image, username, profession, about, discoverable FROM user WHERE username = ?`,
            )
            .get(username) as UserProfile) ?? null
        )
      } catch {
        return null
      }
    },
    setUsername: async (userId, username): Promise<"ok" | "taken"> => {
      // Handles are stored lowercased, so a plain equality check finds the holder.
      const holder = raw.prepare(`SELECT id FROM user WHERE username = ?`).get(username) as
        | { id: string }
        | undefined
      if (holder && holder.id !== userId) return "taken"
      try {
        raw.prepare(`UPDATE user SET username = ? WHERE id = ?`).run(username, userId)
        return "ok"
      } catch {
        // Unique-index race: claimed between the check and the write.
        return "taken"
      }
    },
    setUserImage: async (userId, image): Promise<void> => {
      raw.prepare(`UPDATE user SET image = ? WHERE id = ?`).run(image, userId)
    },
    setUserDiscoverable: async (userId, discoverable): Promise<void> => {
      raw.prepare(`UPDATE user SET discoverable = ? WHERE id = ?`).run(discoverable ? 1 : 0, userId)
    },
    setUserOnboarded: async (userId, onboarded): Promise<void> => {
      raw.prepare(`UPDATE user SET onboarded = ? WHERE id = ?`).run(onboarded ? 1 : 0, userId)
    },
    setUserProfile: async (userId, fields): Promise<void> => {
      // Patch only the fields provided (undefined = leave as-is; null = clear).
      const sets: string[] = []
      const args: (string | null)[] = []
      if (fields.profession !== undefined) {
        sets.push("profession = ?")
        args.push(fields.profession)
      }
      if (fields.about !== undefined) {
        sets.push("about = ?")
        args.push(fields.about)
      }
      if (fields.brandprint !== undefined) {
        sets.push("brandprint = ?")
        args.push(fields.brandprint)
      }
      if (sets.length === 0) return
      raw.prepare(`UPDATE user SET ${sets.join(", ")} WHERE id = ?`).run(...args, userId)
    },
    getUserBrandprint: async (userId): Promise<string | null> => {
      try {
        const row = raw.prepare("SELECT brandprint FROM user WHERE id = ?").get(userId) as
          | { brandprint?: string | null }
          | undefined
        return row?.brandprint ?? null
      } catch {
        return null // older/minimal user table without the column
      }
    },
    searchDiscoverableUsers: async (q, limit): Promise<UserProfile[]> => {
      const s = q.trim().toLowerCase()
      if (!s) return []
      try {
        // Escape LIKE metacharacters so a literal %/_/\ in the query matches itself —
        // a search for "%" finds nothing, not everyone.
        const like = `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
        return raw
          .prepare(
            // discoverable IS NOT 0 → true OR unset(null) both match (on by
            // default); only an explicit 0 (opted out) is excluded.
            `SELECT id, name, image, username, profession, about FROM user
             WHERE discoverable IS NOT 0 AND username IS NOT NULL
               AND (lower(username) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')
             ORDER BY username LIMIT ?`,
          )
          .all(like, like, limit) as UserProfile[]
      } catch {
        return []
      }
    },
    // Browse mode for the People directory: every discoverable, handle-claimed user,
    // ordered by handle, capped. (The empty-query counterpart to the search above.)
    listDiscoverableUsers: async (limit): Promise<UserProfile[]> => {
      try {
        return raw
          .prepare(
            `SELECT id, name, image, username, profession, about FROM user
             WHERE discoverable IS NOT 0 AND username IS NOT NULL
             ORDER BY username LIMIT ?`,
          )
          .all(limit) as UserProfile[]
      } catch {
        return []
      }
    },

    listWorkspaceMates: async (userId, limit): Promise<UserProfile[]> => {
      try {
        return raw
          .prepare(
            `SELECT DISTINCT u.id, u.name, u.image, u.username, u.profession, u.about
             FROM membership m1
             JOIN membership m2 ON m2.org_id = m1.org_id AND m2.user_id != m1.user_id
             JOIN user u ON u.id = m2.user_id
             WHERE m1.user_id = ? AND u.username IS NOT NULL
             ORDER BY u.username LIMIT ?`,
          )
          .all(userId, limit) as UserProfile[]
      } catch {
        return []
      }
    },

    close: () => raw.close(),
  }
}

/**
 * Back-compat constructor surface: `new SqliteMetaStore(path)` returns the store
 * built by `createSqliteStore`. Kept so existing call sites (and the type
 * annotation) don't change now that the implementation is a factory.
 */
export type SqliteMetaStore = MetaStore & { close(): void }
export const SqliteMetaStore = createSqliteStore as unknown as {
  new (path: string): SqliteMetaStore
}
