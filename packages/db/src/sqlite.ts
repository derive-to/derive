import type {
  MetaStore,
  NewVersion,
  UserDir,
  UserProfile,
  VersionRecord,
  ViewStats,
} from "@dock/core"
import Database from "better-sqlite3"
import { and, eq } from "drizzle-orm"
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
  domain,
  MIGRATION_STATEMENTS,
  notification,
  proposal,
  report,
  SCHEMA_STATEMENTS,
  version,
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
  for (const stmt of SCHEMA_STATEMENTS) raw.exec(stmt)
  // Forward-only column adds (SQLite lacks ADD COLUMN IF NOT EXISTS); a
  // "duplicate column" throw means the migration is already applied.
  for (const stmt of MIGRATION_STATEMENTS) {
    try {
      raw.exec(stmt)
    } catch {
      /* already applied */
    }
  }
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
          .set({ current_version: next, current_content_type: v.content_type })
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

    // Atomic delete: all FK-dependent rows and the artifact itself commit together.
    deleteArtifact: async (id: string): Promise<void> => {
      raw.transaction(() => {
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
        db.delete(artifact).where(eq(artifact.id, id)).run()
      })()
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
    getUserByUsername: async (username): Promise<UserProfile | null> => {
      try {
        return (
          (raw
            .prepare(
              `SELECT id, name, image, username, profession, about FROM user WHERE username = ?`,
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
      if (sets.length === 0) return
      raw.prepare(`UPDATE user SET ${sets.join(", ")} WHERE id = ?`).run(...args, userId)
    },
    searchDiscoverableUsers: async (q, limit): Promise<UserProfile[]> => {
      const s = q.trim().toLowerCase()
      if (!s) return []
      try {
        const like = `%${s}%`
        return raw
          .prepare(
            // discoverable IS NOT 0 → true OR unset(null) both match (on by
            // default); only an explicit 0 (opted out) is excluded.
            `SELECT id, name, image, username, profession, about FROM user
             WHERE discoverable IS NOT 0 AND username IS NOT NULL
               AND (lower(username) LIKE ? OR lower(name) LIKE ?)
             ORDER BY username LIMIT ?`,
          )
          .all(like, like, limit) as UserProfile[]
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
