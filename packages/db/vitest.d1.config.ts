import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

// The MetaStore contract on a real Cloudflare D1, run inside workerd via Miniflare —
// the only place src/d1.ts (the D1 driver) is exercised at runtime. The cross-dialect
// query layer otherwise rides the SQLite suite and the DDL on schema-conformance, but
// the D1 runtime path (drizzle-orm/d1 + the raw analytics SQL) had no test until this
// lane. Run with `pnpm test:d1` (and the CI `d1` job).
//
//   - nodejs_compat gives the contract its `node:crypto` randomUUID.
//   - The pool isolates storage per test; the contract applies the DDL in its root
//     beforeAll, which seeds the base storage and so persists into every test (the
//     documented Cloudflare D1 pattern). Each `it` is otherwise self-contained.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-05-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { DB: "derive-test" },
      },
    }),
  ],
})
