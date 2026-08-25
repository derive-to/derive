#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(readFileSync(join(ROOT, "evals/editing/corpus.json"), "utf8"))
const args = process.argv.slice(2)
const full = args.includes("--full")
const json = args.includes("--json")
const list = args.includes("--list")
const laneAt = args.indexOf("--lane")
const onlyLane = laneAt >= 0 ? args[laneAt + 1] : undefined

const fail = (message) => {
  process.stderr.write(`editing-eval: ${message}\n`)
  process.exit(2)
}

if (manifest.schema !== "derive.editing-eval/v1") fail("unsupported corpus schema")
if (!manifest.lanes || !Array.isArray(manifest.scenarios)) fail("malformed corpus")

const ids = new Set()
const sourceCache = new Map()
for (const scenario of manifest.scenarios) {
  if (!scenario.id || ids.has(scenario.id)) fail(`duplicate or empty scenario id: ${scenario.id}`)
  ids.add(scenario.id)
  if (!manifest.lanes[scenario.lane]) fail(`${scenario.id} names unknown lane ${scenario.lane}`)
  const sourcePath = join(ROOT, scenario.source)
  let source = sourceCache.get(sourcePath)
  if (source === undefined) {
    try {
      source = readFileSync(sourcePath, "utf8")
    } catch {
      fail(`${scenario.id} source is missing: ${scenario.source}`)
    }
    sourceCache.set(sourcePath, source)
  }
  const literalDeclarations = ["it", "test"].flatMap((fn) =>
    ['"', "'", "`"].map((quote) => `${fn}(${quote}[${scenario.id}]`),
  )
  if (!literalDeclarations.some((declaration) => source.includes(declaration)))
    fail(`${scenario.id} has no literal it/test declaration in ${scenario.source}`)
}

if (onlyLane && !manifest.lanes[onlyLane]) fail(`unknown lane ${onlyLane}`)

if (list) {
  for (const scenario of manifest.scenarios)
    process.stdout.write(
      `${scenario.id}\t${scenario.risk}\t${scenario.surface}\t${scenario.lane}\t${scenario.covers}\n`,
    )
  process.exit(0)
}

const selected = Object.entries(manifest.lanes).filter(
  ([name, lane]) => (!onlyLane || name === onlyLane) && (full || lane.tier !== "full"),
)
const results = []
for (const [name, lane] of selected) {
  const [command, ...commandArgs] = lane.command
  const started = performance.now()
  if (!json) process.stdout.write(`\nediting-eval: ${name}\n`)
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  })
  const durationMs = Math.round(performance.now() - started)
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  if (!json) {
    process.stdout.write(stdout)
    process.stderr.write(stderr)
  }
  results.push({
    lane: name,
    passed: result.status === 0,
    exitCode: result.status ?? 1,
    durationMs,
    ...(result.status === 0 ? {} : { output: `${stdout}\n${stderr}`.trim().slice(-6000) }),
  })
}

const report = {
  schema: manifest.schema,
  mode: full ? "full" : "fast",
  scenarioCount: manifest.scenarios.filter((scenario) =>
    selected.some(([name]) => name === scenario.lane),
  ).length,
  passed: results.every((result) => result.passed),
  results,
}

if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
else {
  const status = report.passed ? "PASS" : "FAIL"
  process.stdout.write(
    `\nediting-eval: ${status} — ${report.scenarioCount} scenarios, ${results.length} lanes\n`,
  )
}
process.exit(report.passed ? 0 : 1)
