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
      pool = new Pool({ connectionString: PG_URL, max: 2 })
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

    it("upgrades a populated legacy schema before creating dependent indexes", async () => {
      const legacyNs = `t_upgrade_${process.pid}_${uuid().replace(/-/g, "")}`
      const legacy = await pool.connect()
      try {
        await legacy.query(`CREATE SCHEMA ${legacyNs}`)
        await legacy.query(`SET search_path TO ${legacyNs}`)

        const currentArtifactCreate = PG_SCHEMA_STATEMENTS.find((statement) =>
          statement.startsWith("CREATE TABLE IF NOT EXISTS artifact ("),
        )
        if (!currentArtifactCreate) throw new Error("artifact CREATE statement is missing")
        expect(currentArtifactCreate).toContain("\n  archived_at TEXT,")
        const legacyArtifactCreate = currentArtifactCreate.replace("\n  archived_at TEXT,", "")
        expect(legacyArtifactCreate).not.toContain("archived_at")
        await legacy.query(legacyArtifactCreate)
        await legacy.query(
          `INSERT INTO artifact (id, short_id, kind) VALUES ('legacy-artifact', 'legacy', 'document')`,
        )

        for (const statement of PG_SCHEMA_STATEMENTS) await legacy.query(statement)
        // Reapplying the complete plan is the deployment contract, not a special migration path.
        for (const statement of PG_SCHEMA_STATEMENTS) await legacy.query(statement)

        const column = await legacy.query<{ archived_at: string | null }>(
          `SELECT archived_at FROM artifact WHERE id = 'legacy-artifact'`,
        )
        expect(column.rows).toEqual([{ archived_at: null }])
        const index = await legacy.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
          [legacyNs, "artifact_org_archived_created"],
        )
        expect(index.rows).toEqual([{ indexname: "artifact_org_archived_created" }])
      } finally {
        await legacy.query(`DROP SCHEMA IF EXISTS ${legacyNs} CASCADE`)
        legacy.release()
      }
    })

    // The drop-everything variant of the legacy test above. The boot's own ADD COLUMN
    // statements are the authoritative list of columns that can be absent on an existing
    // database, so remove ALL of them (Postgres drops dependent indexes with a column)
    // and require the replay to succeed and re-add each one. This exercises every
    // index/column pair at once — not just archived_at — including statements a
    // regex-based ordering check can't see (e.g. inside a DO block). Columns only:
    // constraint parity on upgraded databases (inline UNIQUE/FK on a migratable
    // column) is a known, separate gap this does not cover.
    it("replays cleanly when every alter-added column is missing", async () => {
      const droppedNs = `t_dropall_${process.pid}_${uuid().replace(/-/g, "")}`
      const dropped = await pool.connect()
      try {
        await dropped.query(`CREATE SCHEMA ${droppedNs}`)
        await dropped.query(`SET search_path TO ${droppedNs}`)
        for (const statement of PG_SCHEMA_STATEMENTS) await dropped.query(statement)

        const migratable = PG_SCHEMA_STATEMENTS.map((statement) =>
          /^ALTER TABLE (\S+) ADD COLUMN IF NOT EXISTS (\S+) /.exec(statement),
        ).filter((m): m is RegExpExecArray => m !== null)
        expect(migratable.length).toBeGreaterThan(0)
        for (const [, table, column] of migratable)
          await dropped.query(`ALTER TABLE ${table} DROP COLUMN ${column}`)

        for (const statement of PG_SCHEMA_STATEMENTS) {
          try {
            await dropped.query(statement)
          } catch (e) {
            throw new Error(
              `boot statement failed against a pre-column DB:\n${statement}\n→ ${
                (e as Error).message
              }`,
            )
          }
        }

        for (const [, table, column] of migratable) {
          const { rows } = await dropped.query(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
            [droppedNs, table, column],
          )
          expect(rows.length, `${table}.${column} was not re-added by the boot`).toBe(1)
        }
      } finally {
        await dropped.query(`DROP SCHEMA IF EXISTS ${droppedNs} CASCADE`)
        dropped.release()
      }
    })
  })
} else {
  // Keep the file non-empty for the default (no-Postgres) run.
  describe("pg schema conformance", () => {
    it.skip("skipped — set DERIVE_TEST_DB=pg + TEST_DATABASE_URL to run against Postgres", () => {})
  })
}
