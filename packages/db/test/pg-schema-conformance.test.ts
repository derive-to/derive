import { randomUUID as uuid } from "node:crypto"
import { getTableColumns, getTableName } from "drizzle-orm"
import { Pool, type PoolClient } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { schema } from "../src/pg"
import { PG_SCHEMA_STATEMENTS } from "../src/pg-schema"

// The Postgres twin of schema-conformance.test.ts. The drizzle pg defs are the
// type source of truth, but the tables that actually get created come from the
// hand-written PG_SCHEMA_STATEMENTS — and nothing at compile time ties them
// together. Until now only the SQLite DDL was boot-and-diffed, so a column added
// to the drizzle def + the SQLite DDL but forgotten in PG_SCHEMA_STATEMENTS would
// ship a broken Postgres schema undetected (the exact gap the review flagged).
//
// This runs PG_SCHEMA_STATEMENTS into a real Postgres (the `pg` lane:
// DERIVE_TEST_DB=pg + TEST_DATABASE_URL, set by scripts/test-pg.sh / the CI pg job)
// in an isolated schema, then asserts every drizzle pg table's columns match the
// columns information_schema reports. Forget a column in the pg DDL and it goes red.
const PG_URL = process.env.DERIVE_TEST_DB === "pg" ? process.env.TEST_DATABASE_URL : undefined

if (PG_URL) {
  describe("pg schema conformance: drizzle defs match PG_SCHEMA_STATEMENTS", () => {
    const ns = `t_conf_${process.pid}_${uuid().replace(/-/g, "")}`
    let pool: Pool
    let client: PoolClient

    beforeAll(async () => {
      pool = new Pool({ connectionString: PG_URL, max: 1 })
      client = await pool.connect()
      await client.query(`CREATE SCHEMA ${ns}`)
      // Unqualified CREATE TABLEs land in this schema; the boot path is the same.
      await client.query(`SET search_path TO ${ns}`)
      for (const stmt of PG_SCHEMA_STATEMENTS) await client.query(stmt)
    })
    afterAll(async () => {
      await client.query(`DROP SCHEMA IF EXISTS ${ns} CASCADE`)
      client.release()
      await pool.end()
    })

    const liveColumns = async (table: string): Promise<string[]> => {
      const { rows } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [ns, table],
      )
      return rows.map((r) => r.column_name).sort()
    }

    for (const [key, table] of Object.entries(schema)) {
      it(`${key}: drizzle pg columns === the created table's columns`, async () => {
        const sqlName = getTableName(table)
        const defined = Object.values(getTableColumns(table))
          .map((c) => c.name)
          .sort()
        const live = await liveColumns(sqlName)
        expect(
          live.length,
          `table "${sqlName}" was not created by PG_SCHEMA_STATEMENTS`,
        ).toBeGreaterThan(0)
        // Exact set: catches a drizzle column missing from the pg DDL AND a pg DDL
        // column the drizzle def doesn't know about.
        expect(defined).toEqual(live)
      })
    }
  })
} else {
  // Keep the file non-empty for the default (no-Postgres) run.
  describe("pg schema conformance", () => {
    it.skip("skipped — set DERIVE_TEST_DB=pg + TEST_DATABASE_URL to run against Postgres", () => {})
  })
}
