import type { D1Database, DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types"
import { createD1Store } from "@dock/db/d1"
import { R2BlobStore } from "@dock/storage"
import { D1Dialect } from "kysely-d1"
import { createApp } from "./app"
import { makeAuth } from "./auth-config"
import { createDoBackplane } from "./realtime-do"

// The realtime room Durable Object (one per channel). Exported so the Workers
// runtime can instantiate the bound class.
export { ArtifactRoom } from "./realtime-do"

/**
 * Cloudflare Workers entry (experimental edge tier). The same runtime-agnostic
 * `createApp` the Node entry uses, wired to edge adapters: D1 for the MetaStore,
 * R2 for blobs, Better Auth on a Kysely D1 dialect, and a Durable Object backplane
 * for cross-instance realtime fan-out (every client for a channel reaches the same
 * room DO). The Node/self-host path uses the in-process backplane instead, so
 * realtime stays zero-dependency there — the DO is opt-in to this entry.
 *
 * Schema (app + Better Auth) is applied to D1 out of band via `wrangler d1 execute`,
 * not at runtime: D1 forbids the sqlite_master introspection Better Auth's migrator
 * needs (SQLITE_AUTH); generate that DDL with gen-auth-schema.ts. See DEPLOY.md.
 *
 * NEVER import node.ts / config.ts / @dock/storage/fs here — those pull Node built-ins.
 */
export interface Env {
  DB: D1Database
  BUCKET: R2Bucket
  ROOMS: DurableObjectNamespace
  BASE_URL?: string
  DOCK_AUTH_SECRET?: string
  DOCK_MULTI_WORKSPACE?: string
}

let app: ReturnType<typeof createApp> | null = null

export default {
  fetch(req: Request, env: Env): Response | Promise<Response> {
    if (!app) {
      const baseUrl = env.BASE_URL ?? new URL(req.url).origin
      const auth = makeAuth(
        { dialect: new D1Dialect({ database: env.DB }), type: "sqlite" },
        baseUrl,
        env.DOCK_AUTH_SECRET ?? "dev-insecure-secret",
      )
      app = createApp({
        meta: createD1Store(env.DB),
        blobs: new R2BlobStore(env.BUCKET),
        backplane: createDoBackplane(env.ROOMS),
        baseUrl,
        auth,
        multiWorkspace: env.DOCK_MULTI_WORKSPACE === "true",
        defaultOrgId: "default",
      })
    }
    return app.fetch(req)
  },
}
