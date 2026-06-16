import { getTableColumns, getTableName } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { schema } from "../src/pg"
import { buildPgSchemaStatements } from "../src/pg-schema"

// The Postgres boot DDL is GENERATED from the drizzle table defs (see
// buildPgSchemaStatements). This pins that invariant WITHOUT a live Postgres, so a
// regression in the generator (or a column that somehow escaped it) fails plain
// `pnpm test` — not only the Docker-gated pg lane. Complements
// pg-schema-conformance.test.ts, which proves the same end-to-end against real PG.
describe("pg DDL is generated from the drizzle schema", () => {
  const statements = buildPgSchemaStatements()
  const sql = statements.join("\n")

  for (const [key, table] of Object.entries(schema)) {
    it(`${key}: every drizzle column is emitted in the DDL`, () => {
      const name = getTableName(table)
      // Each table is created exactly once.
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${name} (`)
      for (const col of Object.values(getTableColumns(table))) {
        // The generator emits an idempotent ADD COLUMN per column, so a missing
        // column can't slip through — this is the cross-dialect drift guard.
        expect(
          sql,
          `column "${col.name}" of "${name}" is missing from the generated PG DDL`,
        ).toContain(`ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS ${col.name} `)
      }
    })
  }
})
