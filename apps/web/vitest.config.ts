import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Unit tests for the web app's PURE logic — ref parsing, relative time, the
// optimistic reaction toggle, role mapping, class merge, and the comment-pin
// layout. A standalone config (NOT the TanStack Start vite config) so tests don't
// boot the SSR/router plugins. The user-facing flows are covered by the Playwright
// e2e suite (e2e/); this gate is scoped to the unit-testable helpers, so a regression
// in that logic fails CI without pretending to measure the React components.
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
        "src/lib/pr.ts",
        "src/pages/artifact/lib/layout.ts",
      ],
      reporter: ["text-summary"],
      // Ratchet floors. Only statements + lines gate — this is 7 small pure-logic
      // files, so functions/branches (22 fns) swing several % per unit and would
      // false-fail routine additions on a hard gate. (current 95.5/97.2)
      thresholds: { statements: 90, lines: 92 },
    },
  },
})
