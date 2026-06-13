import Database from "better-sqlite3"
import { getTableColumns, getTableName } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { schema } from "../src/repos"
import { MIGRATION_STATEMENTS, SCHEMA_STATEMENTS } from "../src/schema"

// The drizzle table defs are the *type* source of truth (parity-guarded against
// the core Records), but the table that actually gets created comes from the
// hand-written SCHEMA_STATEMENTS / MIGRATION_STATEMENTS strings — and nothing
// at compile time ties those two together. So a column can live in the drizzle
// def (typechecks green) yet be missing from the CREATE TABLE that runs at boot.
//
// This boots a real SQLite DB exactly the way the driver does, then asserts that
// every drizzle table's columns match the columns that actually exist. Forget to
// add a column to the DDL and the matching test goes red.

describe("schema conformance: drizzle defs match the DDL that actually runs", () => {
  let db: Database.Database

  beforeAll(() => {
    db = new Database(":memory:")
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt)
    // Forward migrations are idempotent ALTERs; on a fresh DB the column already
    // exists, so a "duplicate column" throw is the expected no-op (same as boot).
    for (const stmt of MIGRATION_STATEMENTS) {
      try {
        db.exec(stmt)
      } catch {
        /* already applied by the CREATE above */
      }
    }
  })
  afterAll(() => db.close())

  const liveColumns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
      .map((r) => r.name)
      .sort()

  for (const [key, table] of Object.entries(schema)) {
    it(`${key}: drizzle columns === the created table's columns`, () => {
      const sqlName = getTableName(table)
      const defined = Object.values(getTableColumns(table))
        .map((c) => c.name)
        .sort()
      const live = liveColumns(sqlName)
      expect(
        live.length,
        `table "${sqlName}" was not created by SCHEMA_STATEMENTS`,
      ).toBeGreaterThan(0)
      // Exact set: catches a drizzle column missing from the DDL AND a DDL column
      // the drizzle def doesn't know about.
      expect(defined).toEqual(live)
    })
  }
})
