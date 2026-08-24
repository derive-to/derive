#!/usr/bin/env node
// The static gate: biome plus every custom guardrail, spawned directly and run
// concurrently. Going through `pnpm lint:<name>` for each one costs ~0.6s of pnpm
// startup per check, which for 30-odd checks is most of the wall time.
//
//   node scripts/guardrails.mjs            # all of them (this is `pnpm run ci`)
//   node scripts/guardrails.mjs tokens api # a subset, by name
//   pnpm lint:<name>                       # one check, via package.json
//
// To add a check, add a row to CHECKS and a matching `lint:<name>` script.
import { spawn } from "node:child_process"
import { cpus } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const bin = (name) => join(root, "node_modules", ".bin", name)
const script = (name, ...args) => ["node", join(root, "scripts", name), ...args]

/** name → argv, in the order they are started. Names match `lint:<name>` in package.json. */
const CHECKS = {
  biome: [bin("biome"), "ci", "--colors=off"],
  tokens: script("check-design-tokens.mjs"),
  frontend: script("check-frontend.mjs"),
  interaction: script("check-interaction.mjs"),
  mutations: script("check-mutations.mjs"),
  reload: script("check-workspace-reload.mjs"),
  surfaces: script("check-surfaces.mjs"),
  testids: script("check-testids.mjs"),
  api: script("check-api.mjs"),
  schema: script("check-schema.mjs"),
  hyperdrive: script("check-hyperdrive-no-pool.mjs"),
  filesize: script("check-file-size.mjs"),
  favicons: script("check-favicons.mjs"),
  "anchor-client": script("check-anchor-client.mjs"),
  deadcode: [bin("knip")],
  boundaries: [bin("depcruise"), "--config", ".dependency-cruiser.mjs", "packages", "apps"],
  env: script("check-env.mjs"),
  "api-types": script("check-api-types.mjs"),
  "agent-skill": script("sync-derive-agent-skill.mjs", "--check"),
  "agent-package-files": script("check-agent-package-files.mjs"),
  skills: script("gen-skills.mjs", "--check"),
  "deck-template": script("gen-deck-template.mjs", "--check"),
  "app-map": script("check-app-map.mjs"),
  "mcp-coercion": script("check-mcp-coercion.mjs"),
  "local-data": script("check-local-data.mjs"),
  "delete-cascade": script("check-delete-cascade.mjs"),
  "facts-visibility": script("check-facts-visibility.mjs"),
  "facts-portable": script("check-facts-portable.mjs"),
  "derived-exclusion": script("check-derived-exclusion.mjs"),
  "selfhost-quickstart": script("check-selfhost-quickstart.mjs"),
  "deploy-verified": script("check-deploy-verified.mjs"),
  "public-claims": script("check-public-claims.mjs"),
  "workflow-pins": script("check-workflow-pins.mjs"),
  "worker-types": script("gen-worker-types.mjs", "--check"),
}

const wanted = process.argv.slice(2)
for (const name of wanted)
  if (!(name in CHECKS)) {
    console.error(`unknown check "${name}". Known: ${Object.keys(CHECKS).join(", ")}`)
    process.exit(2)
  }
const names = wanted.length ? wanted : Object.keys(CHECKS)

const run = (name) =>
  new Promise((resolve) => {
    const [cmd, ...args] = CHECKS[name]
    const started = performance.now()
    // Output is captured and replayed only on failure, so ask the tools for plain text.
    const child = spawn(cmd, args, {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (out += d))
    child.on("error", (err) =>
      resolve({ name, ok: false, out: String(err), ms: performance.now() - started }),
    )
    child.on("close", (code) =>
      resolve({ name, ok: code === 0, out, ms: performance.now() - started }),
    )
  })

// Bounded by core count: biome, knip and depcruise are CPU-bound and only contend past it.
const limit = Math.max(2, Math.min(8, cpus().length))
const queue = [...names]
const results = []
const worker = async () => {
  for (let name = queue.shift(); name; name = queue.shift()) {
    const r = await run(name)
    results.push(r)
    console.log(`${r.ok ? "✓" : "✖"} ${name.padEnd(20)} ${(r.ms / 1000).toFixed(1)}s`)
  }
}
const started = performance.now()
await Promise.all(Array.from({ length: limit }, worker))

const failed = results.filter((r) => !r.ok)
for (const r of failed) {
  console.error(`\n━━ ${r.name} failed (pnpm lint:${r.name} to rerun alone) ━━`)
  console.error(r.out.trimEnd())
}
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed in ${((performance.now() - started) / 1000).toFixed(1)}s`,
)
process.exit(failed.length ? 1 : 0)
