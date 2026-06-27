import { defineConfig } from "vitest/config"

// Coverage gate on the shared domain logic: publish/storeContent (bundle entry +
// path cleaning), anchors, diff, unfurl, permissions, mime, hash, ids, md. ports.ts
// is type-only. Thresholds sit just under the current numbers as a ratchet floor.
//
// Raised after the #244 unit suite (permissions, anchor, diff, sessions, md, pool,
// ids, looksLikeHtmlDocument): now ~97% lines / 95% stmts / 82% branches. Pure
// logic, so these are stable across Node majors.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      thresholds: { lines: 96, statements: 94, branches: 81 },
    },
  },
})
