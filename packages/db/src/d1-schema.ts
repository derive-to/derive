import { SCHEMA_STATEMENTS } from "./schema"

/**
 * The Cloudflare D1 bootstrap schema as a single SQL file body. D1 is SQLite-
 * compatible and the d1 driver shares the SQLite `schema`, so the DDL is exactly
 * `SCHEMA_STATEMENTS` — the same statements the SQLite driver boots and the
 * schema-conformance test validates against the drizzle defs. Joining them here
 * (rather than hand-maintaining a parallel `.sql`) keeps the D1 deploy schema from
 * drifting; `deploy/d1-schema.sql` is generated from this and guarded by a test.
 */
export const buildD1SchemaSql = (): string => {
  const header = `-- Cloudflare D1 bootstrap schema for Derive.
-- GENERATED from packages/db/src/schema.ts (SCHEMA_STATEMENTS); do not edit by hand.
-- Regenerate after a schema change: \`pnpm --filter @derive/db gen:d1-schema\`.
-- Apply once: \`wrangler d1 execute <db> --file=deploy/d1-schema.sql\`.

`
  const body = SCHEMA_STATEMENTS.map((s) => `${s.trim().replace(/;\s*$/, "")};`).join("\n\n")
  return `${header}${body}\n`
}
