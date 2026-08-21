import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Unit tests for the web app's pure logic that a browser smoke test cannot reach
// directly: the comment-permission matrix, deck/bundle reconciliation, markdown
// rendering, the seat-confirm gate. User-facing flows belong to the Playwright suite
// in e2e/. A standalone config, not the TanStack Start vite config, so tests don't
// boot the SSR/router plugins. Coverage is reported, not gated; see
// apps/api/vitest.config.ts.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary"],
    },
  },
})
