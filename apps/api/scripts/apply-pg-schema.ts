import { join } from "node:path"
import { PgMetaStore } from "@derive/db/pg"
import { PgVectorStore } from "@derive/db/pgvector"
import { Pool } from "pg"
import { makeAuth, migrateAuth } from "../src/auth-config"
import { EMBED_DIMENSIONS } from "../src/embedder"

// Bring the hosted tier's Postgres fully current before a Worker deploy — the pg
// twin of `apply-d1-schema.mjs` + `migrate-auth-d1.ts`. The Workers entry never
// applies schema at runtime (the Node tier does on boot), so this runs out of band:
// `pnpm deploy:pg-schema`, or as part of `pnpm deploy:pg`. Both steps are
// idempotent — they create the whole schema on a brand-new database and reconcile
// an existing one, so a deploy can never ship code against a stale schema.
//
// Reads DATABASE_URL from the environment, falling back to the repo-root .env
// (same lookup as node.ts).

for (const envPath of [join(import.meta.dirname, "../../../.env"), ".env"]) {
  try {
    process.loadEnvFile(envPath)
    break
  } catch {
    /* no .env at this path — carry on */
  }
}

const raw = process.env.DATABASE_URL
if (!raw) {
  // A D1-only deploy has no Postgres to migrate; `pnpm deploy` runs both schema
  // steps unconditionally, so this exits clean instead of failing that path.
  console.log("DATABASE_URL not set — skipping pg schema")
  process.exit(0)
}
// node-postgres reads `sslrootcert` as a file path; the `system` keyword some
// providers emit (Neon, PlanetScale) breaks it. Dropping the param falls back to
// the default CA bundle — the same verification for a public-CA cert.
const u = new URL(raw)
if (u.searchParams.get("sslrootcert") === "system") u.searchParams.delete("sslrootcert")
const url = u.toString()

// App schema: PgMetaStore.create applies PG_SCHEMA_STATEMENTS (idempotent DDL).
const store = await PgMetaStore.create(url, (e) => console.error("pool error:", e.message))
console.log("app schema applied")

// (The one-time pre-v2 access backfill used to run here, after the DDL. Retired
// with the v1 `visibility`/`general_role` columns — an instance upgrading straight
// from a pre-v2 build runs deploy/drop-v1-access.sql instead, which folds the old
// values into the access fields before dropping them.)

// Better Auth schema: derived from the live auth config (the single source of
// truth), reconciled by Better Auth's own migrator. baseUrl/secret are dummies —
// only the table shapes matter here.
const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 10_000 })
pool.on("error", (e) => console.error("auth pool error:", e.message))
const auth = makeAuth(pool, "http://localhost:8080", "schema-apply-not-a-real-secret", {})
await migrateAuth(auth)
// Better Auth can't add UNIQUE to an existing column; enforce it here (both the
// Node boot and this script apply the same backstop — see node.ts).
await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS user_username ON "user" (username)`)
console.log("auth schema applied")

// Dense/semantic search: the pgvector table for the edge dense arm (the Worker never runs DDL at
// runtime, so — like the app + auth schema — it's created here, out of band). bge-m3 = 1024-dim.
// Idempotent; the dimension guard throws only on an incompatible embedder swap (⇒ drop + rebackfill).
const vectorStore = new PgVectorStore(pool, EMBED_DIMENSIONS)
await vectorStore.ensureSchema()
// Widen HNSW candidate breadth DB-wide so Hyperdrive's pooled connections don't cap topK at the
// default ef_search=40 (the edge can't set it per-connection the way the Node pool does). Best-
// effort — a recall tuning knob, not required for correctness, so a failure here doesn't block the
// deploy.
try {
  const { rows } = await pool.query<{ d: string }>("SELECT current_database() AS d")
  const db = rows[0]?.d
  if (db) await pool.query(`ALTER DATABASE "${db}" SET hnsw.ef_search = 100`)
} catch (e) {
  console.error("ef_search tuning skipped:", e instanceof Error ? e.message : String(e))
}
console.log("vector schema applied")

await store.close()
await pool.end()
