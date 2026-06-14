import { defineConfig } from "vitest/config"

// Coverage gate on the data layer. It scopes to the code this package's own tests
// exercise: the cross-dialect query layer (repos.ts), the SQLite driver (sqlite.ts),
// and the DDL (schema.ts / d1-schema.ts, pinned by the schema-conformance test).
//
// pg.ts and d1.ts are deliberately excluded: they're the Postgres and Cloudflare-D1
// drivers, which need a live Postgres / the workerd runtime to run. pg.ts is
// exercised behaviorally by the api suite under DOCK_TEST_DB=pg (the same tests, the
// pg driver); both dialects' DDL is conformance-checked against the drizzle defs. A
// floor here would otherwise just track "is a Postgres container in CI", not data
// correctness. The thresholds sit just under the current numbers as a ratchet.
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
