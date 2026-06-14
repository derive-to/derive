import { randomUUID as uuid } from "node:crypto"
import { Pool } from "pg"
import { describe, it } from "vitest"
import { PgMetaStore } from "../src/pg"
import { runStoreContract } from "./store-contract"

// The same MetaStore contract on a REAL Postgres — the only place pg.ts (the
// hosted-tier driver, raw SQL mirroring repos.ts) is exercised by this package's
// own suite. Gated on DOCK_TEST_DB=pg + TEST_DATABASE_URL, which `scripts/test-pg.sh`
// and the CI `pg` job set after standing up an ephemeral Postgres. A wrong WHERE, a
// missing org scope, or a broken transaction in pg.ts fails the same assertion that
// passes on SQLite. Without the env it's a no-op (so `pnpm test` stays zero-config).
const PG_URL = process.env.DOCK_TEST_DB === "pg" ? process.env.TEST_DATABASE_URL : undefined

if (PG_URL) {
  const url = PG_URL
  runStoreContract("pg store", async () => {
    // Each run gets its own schema (search_path) so concurrent test files and reruns
    // never collide; PgMetaStore.create applies the DDL into it. Dropped on teardown.
    const schema = `t_db_${process.pid}_${uuid().replace(/-/g, "")}`
    const boot = new Pool({ connectionString: url, max: 1 })
    await boot.query(`CREATE SCHEMA ${schema}`)
    await boot.end()
    const opt = encodeURIComponent(`-c search_path=${schema}`)
    const store = await PgMetaStore.create(`${url}${url.includes("?") ? "&" : "?"}options=${opt}`)
    const cleanup = async () => {
      await store.close()
      const drop = new Pool({ connectionString: url, max: 1 })
      await drop.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await drop.end()
    }
    return { store, cleanup }
  })
} else {
  // Keep the file non-empty for the default (SQLite-only) run.
  describe("pg store", () => {
    it.skip("skipped — set DOCK_TEST_DB=pg + TEST_DATABASE_URL to run against Postgres", () => {})
  })
}
