import { defineConfig } from "vitest/config"

// Coverage gate on the shared domain logic: publish/storeContent (bundle entry +
// path cleaning), anchors, diff, unfurl, permissions, mime, hash, ids, md. ports.ts
// is type-only. Thresholds sit just under the current numbers as a ratchet floor.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      // Ratchet floors just under current (57.6/51.9/64.9/58.4). Raise over time.
      thresholds: { statements: 55, branches: 49, functions: 62, lines: 56 },
    },
  },
})
