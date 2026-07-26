import { configDefaults, defineConfig } from "vitest/config"

// Coverage gate on the data layer. It scopes to the code this package's own tests
// exercise: the cross-dialect query layer (repos.ts), the SQLite driver (sqlite.ts),
// and the DDL (schema.ts / d1-schema.ts, pinned by the schema-conformance test).
//
// pg.ts and d1.ts are each gated in their own lane against a real engine the default
// (Node, no-Postgres) lane can't host: pg.ts on a real Postgres (vitest.pg.config.ts /
// `test:pg`), d1.ts on Miniflare D1 inside workerd (vitest.d1.config.ts / `test:d1`).
// The d1 lane's test imports `cloudflare:test`, which only resolves under the workers
// pool, so it's excluded here. Both dialects' DDL is conformance-checked against the
// drizzle defs. The thresholds sit just under the current numbers as a ratchet.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/d1-store.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/repos.ts", "src/sqlite.ts", "src/schema.ts", "src/d1-schema.ts"],
      reporter: ["text-summary"],
      // Ratchet floors just under current (85.4/68.7/84.6/87.0). Raise over time.
      thresholds: { statements: 82, branches: 65, functions: 81, lines: 84 },
    },
  },
})
