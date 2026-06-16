import { getTableColumns, getTableName } from "drizzle-orm"
// biome-ignore lint/suspicious/noExplicitAny: drizzle column runtime shape (.default) isn't exported.
type AnyCol = any
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

  // The generator maps every $defaultFn column (hasDefault, no literal value) to the
  // ISO-timestamp SQL backstop — correct only because all of them are timestamps.
  // If a non-timestamp $defaultFn is ever added, this fails so the generator's
  // default handling gets revisited instead of silently emitting a wrong default.
  it("only known timestamp columns use the $defaultFn timestamp backstop", () => {
    const known = new Set(["created_at", "next_attempt_at"])
    for (const table of Object.values(schema))
      for (const col of Object.values(getTableColumns(table)) as AnyCol[])
        if (col.hasDefault && col.default === undefined)
          expect(
            known.has(col.name),
            `column "${col.name}" uses $defaultFn but isn't a known timestamp backstop`,
          ).toBe(true)
  })
})
