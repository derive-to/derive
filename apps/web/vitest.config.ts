import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Unit tests for the web app's PURE logic — ref parsing, relative time, the
// optimistic reaction toggle, role mapping, class merge, the comment-pin layout,
// the client comment renderer (XSS-safe markdown), and username validation. A
// standalone config (NOT the TanStack Start vite config) so tests don't boot the
// SSR/router plugins. The user-facing flows are covered by the Playwright e2e suite
// (e2e/); this gate is scoped to the unit-testable helpers, so a regression in that
// logic fails CI without pretending to measure the React components.
//
// Floor raised after the #244 unit suite added markdown + username coverage: the
// 8-file include now reports ~98% lines / 97% stmts / 85% branches; thresholds sit
// just under that as a ratchet floor.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/pages/artifact/parse-ref.ts",
        "src/lib/time.ts",
        "src/pages/artifact/lib/reactions.ts",
        "src/pages/settings/roles.ts",
        "src/lib/utils.ts",
        "src/pages/artifact/lib/layout.ts",
        "src/pages/artifact/lib/markdown.ts",
        "src/lib/username.ts",
      ],
      reporter: ["text-summary"],
      thresholds: { lines: 97, statements: 96, branches: 84 },
    },
  },
})
