import { defineConfig } from "vitest/config"

// Coverage gate on the data layer. It scopes to the code this package's own tests
// exercise: the cross-dialect query layer (repos.ts), the SQLite driver (sqlite.ts),
// and the DDL (schema.ts / d1-schema.ts, pinned by the schema-conformance test).
//
// pg.ts is gated separately in the `pg` lane (vitest.pg.config.ts): the store
// contract runs against a real Postgres there, which this default (no-Postgres) lane
// can't. d1.ts stays out — the Cloudflare-D1 driver needs the workerd runtime. Both
// dialects' DDL is conformance-checked against the drizzle defs. The thresholds sit
// just under the current numbers as a ratchet.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/repos.ts", "src/sqlite.ts", "src/schema.ts", "src/d1-schema.ts"],
      reporter: ["text-summary"],
      thresholds: { lines: 88, statements: 86, branches: 58 },
    },
  },
})
