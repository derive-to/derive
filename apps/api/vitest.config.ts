import { defineConfig } from "vitest/config"

// Coverage gate on the API — the core logic, ~60% of the suite. The thresholds
// are a ratchet floor set just below the current numbers: a regression fails the
// build, and the floor is meant to be raised over time.
//
// Recalibrated for vitest 4 / coverage-v8 4, which count branch points far more
// granularly than v3 (the same 141 tests now report 59% branches / 68% stmts /
// 74% lines, vs ~73% across the board before). That's a measurement-basis change,
// not a coverage regression — so the floor is reset to the new basis, not lowered
// to hide lost coverage.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      thresholds: { lines: 72, statements: 66, branches: 57 },
    },
  },
})
