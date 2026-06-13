import type {
  D1Database,
  DurableObjectNamespace,
  ExecutionContext,
  R2Bucket,
} from "@cloudflare/workers-types"
import { createD1Store } from "@dock/db/d1"
import { R2BlobStore } from "@dock/storage"
import { D1Dialect } from "kysely-d1"
import { createApp } from "./app"
import { makeAuth } from "./auth-config"
import { createDoBackplane, edgeCtx } from "./realtime-do"

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
  DOCK_SUPERADMIN_EMAILS?: string
  /** "true" to run the edge instance open (anon = owner, zero-config). Unset/anything
   *  else = secure: real permissions apply (anon → viewer on public, else no access). */
  DOCK_OPEN?: string
}

let app: ReturnType<typeof createApp> | null = null

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    if (!app) {
      // No insecure default on the edge: a hardcoded, public session-signing key
      // would let anyone forge a valid session. The Node path generates+persists
      // one when unset, but a stateless Worker can't, so it must be bound. Fail
      // closed (a 500 on every request) rather than boot with a forgeable secret.
      const secret = env.DOCK_AUTH_SECRET
      if (!secret || secret.length < 16)
        throw new Error("DOCK_AUTH_SECRET (>= 16 chars) is required on the edge")
      const baseUrl = env.BASE_URL ?? new URL(req.url).origin
      const auth = makeAuth(
        { dialect: new D1Dialect({ database: env.DB }), type: "sqlite" },
        baseUrl,
        secret,
      )
      app = createApp({
        meta: createD1Store(env.DB),
        blobs: new R2BlobStore(env.BUCKET),
        backplane: createDoBackplane(env.ROOMS),
        baseUrl,
        auth,
        // Secure by default on the edge: anonymous callers are NOT owners. Set
        // DOCK_OPEN=true only for a single-user / zero-config edge instance.
        open: env.DOCK_OPEN === "true",
        superAdmins: (env.DOCK_SUPERADMIN_EMAILS ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
        defaultOrgId: "default",
      })
    }
    // Run within the per-request context so the DO backplane's publish can waitUntil.
    const ready = app
    return edgeCtx.run(ctx, () => ready.fetch(req))
  },
}
