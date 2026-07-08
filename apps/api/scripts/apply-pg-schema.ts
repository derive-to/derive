import { join } from "node:path"
import { PgMetaStore } from "@derive/db/pg"
import { Pool } from "pg"
import { makeAuth, migrateAuth } from "../src/auth-config"

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

// One-time data migrations that the Node tier runs on boot but the Workers entry
// never gets a chance to (it applies no schema at runtime — see PgMetaStore.fromPool).
// Both are idempotent: they consume/guard their source columns, so re-running each
// deploy is a no-op after the first. Must run AFTER the DDL above (they touch the
// new columns) and BEFORE the Worker code that reads them ships — deploy:pg runs
// this step ahead of the Worker deploy.
//   - backfillAccess: maps the pre-v2 `visibility` onto workspace_access/link_role/
//     listed. Without it every org/public artifact would sit at the fail-closed
//     `none` default (invite-only) after the ADD COLUMN. See access-model.md.
await store.backfillAccess()
console.log("access backfill applied")

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

await store.close()
await pool.end()
