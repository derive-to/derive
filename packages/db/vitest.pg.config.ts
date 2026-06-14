import { defineConfig } from "vitest/config"

// Coverage gate for the Postgres driver, run only in the `pg` lane (DOCK_TEST_DB=pg
// against a real Postgres — see scripts/test-pg.sh / the CI pg job). pg.ts is raw
// SQL mirroring repos.ts; the store contract (test/pg-store.test.ts) drives it
// through every entity lifecycle. The default sqlite gate (vitest.config.ts) can't
// measure this — there's no Postgres in that lane — so it lives here. Ratchet floor
// just under the current numbers (~94% lines / 90% stmts / 60% branches).
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/pg.ts"],
      reporter: ["text-summary"],
      thresholds: { lines: 88, statements: 85, branches: 55 },
    },
  },
})
