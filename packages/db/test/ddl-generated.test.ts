import { getTableColumns, getTableName, type Table } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { isMigratable, isTimestampDefault } from "../src/ddl"
import { schema as pgSchema } from "../src/pg"
import { buildPgSchemaStatements } from "../src/pg-schema"
import { schema as sqliteSchema } from "../src/repos"
import { MIGRATION_STATEMENTS, SCHEMA_STATEMENTS } from "../src/schema"

// biome-ignore lint/suspicious/noExplicitAny: drizzle column runtime shape (.default/.hasDefault) isn't exported.
type AnyCol = any

// Every dialect's boot DDL is GENERATED from the drizzle table defs (see ../src/ddl).
// These checks pin the invariants WITHOUT a live database, so a generator regression
// fails plain `pnpm test`, not only the Docker-gated pg lane. The real-DB equivalence
// is proven separately (pg-schema-conformance.test.ts + the sqlite conformance test).
const dialects = {
  sqlite: { schema: sqliteSchema, statements: [...MIGRATION_STATEMENTS, ...SCHEMA_STATEMENTS] },
  postgres: { schema: pgSchema, statements: buildPgSchemaStatements() },
}

describe("Postgres DDL dependency order", () => {
  it("reconciles additive columns before creating indexes", () => {
    const statements = buildPgSchemaStatements()
    const columnPositions = statements
      .map((statement, index) => (/^ALTER TABLE .* ADD COLUMN /.test(statement) ? index : -1))
      .filter((index) => index >= 0)
    const indexPositions = statements
      .map((statement, index) => (/^CREATE (?:UNIQUE )?INDEX /.test(statement) ? index : -1))
      .filter((index) => index >= 0)

    expect(columnPositions.length).toBeGreaterThan(0)
    expect(indexPositions.length).toBeGreaterThan(0)
    expect(Math.max(...columnPositions)).toBeLessThan(Math.min(...indexPositions))
  })
})

for (const [dialect, { schema, statements }] of Object.entries(dialects)) {
  describe(`${dialect}: DDL generated from the drizzle schema`, () => {
    const createFor = (name: string) =>
      statements.find((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`))

    for (const [key, table] of Object.entries(schema as Record<string, Table>)) {
      it(`${key}: every column is in the CREATE; migratable ones are also migrated`, () => {
        const name = getTableName(table)
        const create = createFor(name)
        expect(create, `no CREATE TABLE for "${name}"`).toBeTruthy()
        for (const col of Object.values(getTableColumns(table)) as AnyCol[]) {
          // In the CREATE → fresh DBs always have it.
          expect(create, `column "${col.name}" of "${name}" is missing from its CREATE`).toContain(
            `\n  ${col.name} `,
          )
          // Nullable / constant-default columns can be added to an existing table, so
          // they must also be in the migrations (the existing-DB drift guard). PK,
          // not-null-no-default, and timestamp-default columns are initial-only.
          if (isMigratable(col))
            expect(
              statements.some((s) =>
                s.startsWith(`ALTER TABLE ${name} ADD COLUMN`)
                  ? new RegExp(`ADD COLUMN (IF NOT EXISTS )?${col.name} `).test(s)
                  : false,
              ),
              `migratable column "${col.name}" of "${name}" has no ADD COLUMN`,
            ).toBe(true)
        }
      })
    }

    // The generator maps every $defaultFn column (hasDefault, no literal value) to the
    // dialect timestamp default — correct only because all of them are timestamps. A
    // non-timestamp $defaultFn fails here so the default handling gets revisited.
    it("only known timestamp columns use the non-constant default backstop", () => {
      const known = new Set(["created_at", "next_attempt_at"])
      for (const table of Object.values(schema as Record<string, Table>))
        for (const col of Object.values(getTableColumns(table)) as AnyCol[])
          if (isTimestampDefault(col))
            expect(
              known.has(col.name),
              `column "${col.name}" has a non-constant default but isn't a known timestamp`,
            ).toBe(true)
    })
  })
}
