import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FUZZ_ON, test } from "./fixtures"
import { fuzzSeeds, resultsDir, type SessionResult } from "./session"
import { summarize } from "./summary"

/**
 * Teardown for the editing-fuzz project: aggregates <outputDir>/results/*.json into
 * one table, printed and written to <outputDir>/summary.md (outputDir is FUZZ_OUT,
 * test-results/fuzz by default).
 */

test.skip(!FUZZ_ON, "fuzz runs only with FUZZ=1 (pnpm test:fuzz)")

test("editing fuzz summary", async () => {
  const outDir = test.info().project.outputDir
  const RESULTS_DIR = resultsDir(outDir)
  if (!existsSync(RESULTS_DIR)) {
    console.log("editing fuzz: no session results to summarize")
    return
  }
  const results = readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8")) as SessionResult)
  const ran = new Set(results.map((r) => r.seed))
  const missing = fuzzSeeds().filter((seed) => !ran.has(seed))
  const table =
    summarize(results) +
    (missing.length
      ? `\n\n${missing.length} planned session(s) produced no result (worker setup failed or the test was killed): seeds ${missing.join(", ")}`
      : "")
  writeFileSync(join(outDir, "summary.md"), `${table}\n`)
  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify(
      results.map((r) => ({
        seed: r.seed,
        ok: r.ok,
        failures: r.failures.map((f) => ({
          phase: f.phase,
          oracle: f.oracle,
          signature: f.signature,
        })),
      })),
      null,
      2,
    ),
  )
  console.log(`\n${table}\n`)
})
