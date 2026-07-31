#!/usr/bin/env node
// @derive/facts is the piece meant to be READ AND REIMPLEMENTED by other hosts, so its
// portability is a load-bearing property rather than a nice one: the moment it imports
// anything, the thing we are proposing as a convention stops being copyable without
// bringing this repo along.
//
// The failure is silent and easy. Someone needs a helper that already exists in
// @derive/core, adds one import, and every test still passes — because inside this
// workspace it resolves fine. Nothing would notice until an outside implementer tried to
// use the package and could not.
//
// This checks the two properties SPEC.md actually claims: zero imports in the source, and
// no runtime dependencies in the manifest. DevDependencies are fine (typescript, vitest);
// they are how the package is built and tested, not what a consumer inherits.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const PKG = "packages/facts"
const SRC = join(PKG, "src")

const walk = (dir) => {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith(".ts")) out.push(full)
  }
  return out
}

const failures = []
let checked = 0

for (const file of walk(SRC)) {
  // The test file is allowed to import its own module and a test runner; it is not shipped
  // as part of the convention.
  const isTest = file.endsWith(".test.ts")
  const src = readFileSync(file, "utf8")
  checked++
  for (const [, spec] of src.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)) {
    if (isTest && (spec === "./index" || spec === "vitest")) continue
    failures.push(`${file} imports "${spec}"`)
  }
  for (const [, spec] of src.matchAll(/\brequire\(\s*["']([^"']+)["']/g))
    failures.push(`${file} require()s "${spec}"`)
}

const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"))
for (const dep of Object.keys(manifest.dependencies ?? {}))
  failures.push(`package.json declares a runtime dependency "${dep}"`)

// A guard that passes because it looked in the wrong place is a claim, not a check.
if (checked === 0) {
  console.error(
    `check-facts-portable: found NO source under ${SRC} — the package moved or the ` +
      "path is stale, so this guard is asserting nothing.",
  )
  process.exit(1)
}

if (failures.length) {
  console.error("check-facts-portable: @derive/facts is no longer portable\n")
  for (const f of failures) console.error(`  ✖ ${f}`)
  console.error(
    "\nThis package is the part meant to be reimplemented by other hosts (see its SPEC.md), " +
      "so it must stay dependency-free. Inline what you need, or keep the new code in " +
      "@derive/core, which may depend on this package but never the reverse.",
  )
  process.exit(1)
}

console.log(`check-facts-portable: ok — ${checked} file(s), zero imports, zero runtime deps`)
