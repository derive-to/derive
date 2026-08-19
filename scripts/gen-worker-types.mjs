#!/usr/bin/env node

// Regenerate apps/api/worker-configuration.d.ts from wrangler.toml.
//
//   pnpm gen:worker-types          write it
//   pnpm gen:worker-types --check  fail if it has drifted (this is `pnpm ci`)
//
// WHY THE WORKER'S AMBIENT TYPES ARE GENERATED RATHER THAN INSTALLED.
//
// @cloudflare/workers-types ships ONE type surface for every configuration, so
// it describes a runtime nobody is running: it cannot know this worker's
// compatibility date, its flags, or its bindings. Two concrete costs of that
// were paid here.
//
// From v5 it declares `declare const Buffer: any` among its nodejs_compat
// polyfill globals. That collides with the real Buffer from @types/node, and the
// collision does not announce itself as a conflict — node:crypto's randomBytes
// and getAuthTag quietly lose their encoding-aware toString() and two of the
// three calls on one line stop compiling. Reordering the `types` array does not
// help; it is a duplicate global declaration, not a precedence question.
//
// And the bindings (D1, R2, Hyperdrive, the Durable Object) had to be hand-typed
// against a config file nothing checked them against.
//
// `wrangler types` emits both from wrangler.toml itself, stamped with the workerd
// build and compatibility date it was generated for. The package stays installed
// — a dozen files do `import type { D1Database } from "@cloudflare/workers-types"`
// and named imports resolve independently of the `types` array — but its GLOBALS
// no longer load, which is where the damage was.
//
// The generated file is committed so CI typechecks without running wrangler, and
// this check is what keeps that copy honest.

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const API = join(ROOT, "apps/api")
const OUT = join(API, "worker-configuration.d.ts")
const check = process.argv.includes("--check")

const before = (() => {
  try {
    return readFileSync(OUT, "utf8")
  } catch {
    return "" // missing → stale
  }
})()

try {
  // Run from apps/api and with the default output path, so the emitted header and
  // the Durable Object's `import("./src/worker")` stay relative and portable. A
  // different cwd or an explicit path bakes a machine-specific string into a file
  // that is committed.
  execFileSync("pnpm", ["exec", "wrangler", "types"], { cwd: API, stdio: "pipe" })
} catch (error) {
  console.error("worker types: `wrangler types` failed")
  console.error(String(error.stderr || error.message).trim())
  process.exit(1)
}

const after = readFileSync(OUT, "utf8")

if (!check) {
  console.log(
    before === after
      ? "worker types: already current"
      : "worker types: regenerated apps/api/worker-configuration.d.ts",
  )
  process.exit(0)
}

if (before !== after) {
  // Put the committed copy back, so a failing check never leaves the tree dirty.
  const { writeFileSync } = await import("node:fs")
  if (before) writeFileSync(OUT, before)
  console.error(
    "worker types: apps/api/worker-configuration.d.ts is stale — wrangler.toml has moved on.",
  )
  console.error("Run `pnpm gen:worker-types` and commit the result.")
  console.error("\nThis matters beyond tidiness: those types describe the compatibility date,")
  console.error("flags and bindings the worker actually deploys with. Stale ones typecheck")
  console.error("your worker against a runtime it is not running on.")
  process.exit(1)
}

console.log("worker types: current with wrangler.toml")
