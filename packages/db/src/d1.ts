import type { D1Database } from "@cloudflare/workers-types"
import type { MetaStore, NewView, UserDir, UserProfile, ViewStats } from "@dock/core"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
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
 * Experimental: the shared query logic rides on the SQLite suite and the schema on
 * schema-conformance, but the D1-specific runtime path has no integration test yet
 * and Dock ships no Worker entrypoint. Treat as unverified. See DEPLOY.md.
 */
export function createD1Store(d1: D1Database): MetaStore {
  const db = drizzle(d1, { schema })
  const repos = makeRepos(db)

  return {
    ...repos,

    // ---- View analytics (raw SQL) ----------------------------------------
    recordView: async (v: NewView): Promise<void> => {
      await db.run(
        sql`INSERT INTO view (id, artifact_id, version, viewer, viewer_kind) VALUES (${v.id}, ${v.artifact_id}, ${v.version}, ${v.viewer}, ${v.viewer_kind})`,
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
          sql`SELECT id, email, name, image FROM user WHERE id IN (${list})`,
        )) as UserDir[]
      } catch {
        return []
      }
    },
    getUserByUsername: async (username: string): Promise<UserProfile | null> => {
      try {
        return (
          ((await db.get(
            sql`SELECT id, name, image, username FROM user WHERE username = ${username}`,
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
    searchDiscoverableUsers: async (q: string, limit: number): Promise<UserProfile[]> => {
      const s = q.trim().toLowerCase()
      if (!s) return []
      try {
        const like = `%${s}%`
        return (await db.all(
          sql`SELECT id, name, image, username FROM user
              WHERE discoverable = 1 AND username IS NOT NULL
                AND (lower(username) LIKE ${like} OR lower(name) LIKE ${like})
              ORDER BY username LIMIT ${limit}`,
        )) as UserProfile[]
      } catch {
        return []
      }
    },
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
