import { env } from "cloudflare:test"
import { createD1Store } from "../src/d1"
import { SCHEMA_STATEMENTS } from "../src/schema"
import { runStoreContract } from "./store-contract"

// The cross-dialect MetaStore contract on a REAL Cloudflare D1, run inside workerd
// via Miniflare (the `pnpm test:d1` lane / the CI `d1` job — see vitest.d1.config.ts).
// This is the first runtime coverage of src/d1.ts: until now the shared query logic
// rode the SQLite suite and the DDL rode schema-conformance, but the D1-specific path
// (drizzle-orm/d1 + the raw analytics SQL) had none, and Derive's edge tier runs on it.
// A wrong WHERE, a missing org scope, or a D1-only SQL quirk fails the same assertion
// that passes on SQLite/Postgres.
//
// The `cloudflare:test` `env` is typed by env.d.ts (DB: D1Database).
runStoreContract("d1 store", async () => {
  // The binding starts empty; apply the same DDL the deploy uses (SCHEMA_STATEMENTS,
  // the source of deploy/d1-schema.sql). One statement at a time — D1's batch/exec
  // splits on newlines, which would mangle the multi-line CREATE TABLEs. isolatedStorage
  // is off (see the config), so this persists for the whole contract.
  for (const stmt of SCHEMA_STATEMENTS) await env.DB.prepare(stmt).run()
  return { store: createD1Store(env.DB), cleanup: () => {} }
})
