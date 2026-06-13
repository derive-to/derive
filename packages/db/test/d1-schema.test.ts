import { describe, expect, it } from "vitest"
import { buildD1SchemaSql } from "../src/d1-schema"

// deploy/d1-schema.sql is the Cloudflare D1 bootstrap schema, generated from
// SCHEMA_STATEMENTS (see src/d1-schema.ts) so it can't drift from the SQLite DDL
// that the schema-conformance test already validates against the drizzle defs.
// This locks the committed file to the generated output; after a schema change,
// regenerate with `pnpm --filter @dock/db gen:d1-schema` (vitest -u under the hood).
describe("d1 deploy schema", () => {
  it("deploy/d1-schema.sql stays in sync with SCHEMA_STATEMENTS", async () => {
    await expect(buildD1SchemaSql()).toMatchFileSnapshot("../../../deploy/d1-schema.sql")
  })
})
