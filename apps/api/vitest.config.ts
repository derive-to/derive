import { fileURLToPath } from "node:url"
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
//
// Raised after backfilling the deploy/entry surface (config.ts, worker.ts edge
// secret gate, the extracted shutdown in lifecycle.ts, auth-config providers): the
// suite now reports ~82% lines / 75% stmts / 68% branches. Floor sits just under
// that so a regression fails but normal noise doesn't.
export default defineConfig({
  resolve: {
    alias: {
      // `cloudflare:workers` only resolves inside workerd. The Workers entry statically
      // exports its DO classes (wrangler requires it) and one extends Container from
      // @cloudflare/containers, which imports it — so a Node-side test of worker.ts would
      // die on an import unrelated to what it asserts. See the stub for the full note.
      "cloudflare:workers": fileURLToPath(
        new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      provider: "v8",
      // TypeScript only: src/skills/*.md (the MCP skill sources) live under src,
      // and the v8 provider's uncovered-file sweep PARSE_ERRORs trying to read
      // markdown as JS — which exits 1 even with every test green.
      include: ["src/**/*.ts"],
      reporter: ["text-summary"],
      // Ratchet floors, set just under the current numbers (78.9/70.1/79.0/83.2)
      // with headroom for noise. A drop fails `check`, and deploy needs check, so
      // a coverage regression blocks the ship. Raise as coverage climbs.
      thresholds: { statements: 76, branches: 67, functions: 76, lines: 80 },
    },
  },
})
