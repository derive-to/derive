#!/usr/bin/env node
// Bundle budget. The web client's JS is gzipped and summed; a big jump (a stray
// eager import of phosphor / radix / cmdk, a fat new dep) trips the budget so it
// can't land silently. Run `pnpm --filter @dock/web build` first — this reads the
// emitted client chunks. Budgets carry ~25% headroom over the real numbers at
// the time of writing; raise them deliberately (in a PR) when a feature earns it.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

const ASSETS = join(process.cwd(), "apps/web/dist/client/assets")

// Total gzipped JS across all chunks (catches broad weight creep), and the
// single largest chunk (catches a fat eager import landing in the entry/vendor).
const TOTAL_BUDGET = 260 * 1024
// Bumped 95 -> 120 after the React 19 + React Compiler upgrade (#94): the compiler
// runtime + React 19 land in the entry chunk (~102 kB gzipped), a justified, one-time
// baseline jump. Still catches a stray fat import (radix/cmdk/phosphor) on top.
const CHUNK_BUDGET = 120 * 1024

let files
try {
  files = readdirSync(ASSETS).filter((f) => f.endsWith(".js"))
} catch {
  console.error(
    `bundle: no client build at ${ASSETS}\n  Run \`pnpm --filter @dock/web build\` first.`,
  )
  process.exit(1)
}

let total = 0
let biggest = { file: "", gz: 0 }
const rows = files
  .map((f) => {
    const gz = gzipSync(readFileSync(join(ASSETS, f)), { level: 9 }).length
    total += gz
    if (gz > biggest.gz) biggest = { file: f, gz }
    return { f, gz }
  })
  .sort((a, b) => b.gz - a.gz)

const kb = (n) => `${(n / 1024).toFixed(1)} kB`
const overTotal = total > TOTAL_BUDGET
const overChunk = biggest.gz > CHUNK_BUDGET

console.log("bundle: gzipped client JS")
for (const r of rows.slice(0, 6)) console.log(`  ${kb(r.gz).padStart(9)}  ${r.f}`)
console.log(`  ${"…".padStart(9)}  (${files.length} chunks total)`)
console.log(`  total:   ${kb(total)} / ${kb(TOTAL_BUDGET)} budget`)
console.log(`  largest: ${kb(biggest.gz)} (${biggest.file}) / ${kb(CHUNK_BUDGET)} budget`)

if (overTotal || overChunk) {
  console.error("\nbundle: OVER BUDGET")
  if (overTotal) console.error(`  total ${kb(total)} exceeds ${kb(TOTAL_BUDGET)}`)
  if (overChunk)
    console.error(`  chunk ${biggest.file} ${kb(biggest.gz)} exceeds ${kb(CHUNK_BUDGET)}`)
  console.error(
    "\n  Trim the import (lazy-load it, or import the specific symbol),\n" +
      "  or raise the budget in scripts/check-bundle.mjs if the weight is justified.",
  )
  process.exit(1)
}
console.log("bundle: ok — within budget")
process.exit(0)
