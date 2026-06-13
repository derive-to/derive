import { defineConfig } from "vitest/config"

// Coverage gate on the API — the core logic, ~60% of the suite. The thresholds
// are a ratchet floor (set just below current ~73%): a regression fails the
// build, and the floor is meant to be raised over time, never lowered.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      thresholds: { lines: 70, statements: 70, branches: 70 },
    },
  },
})
