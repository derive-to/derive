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

// This is a tripwire for ACCIDENTS (a stray `import * from "phosphor"`, a fat dep
// landing eagerly), not a perf diet. Cloudflare gives the client assets multi-MB
// of room, so the absolute numbers are loose on purpose — generous headroom over
// the real figures (~259 kB total / ~113 kB largest at the time of writing) so a
// normal dep doesn't trip it, but a sudden balloon does. Bump deliberately when a
// feature earns it. The single-chunk budget is the sharper signal: a fat eager
// import shows up as one chunk blowing past, not as broad creep.
const TOTAL_BUDGET = 450 * 1024
const CHUNK_BUDGET = 180 * 1024

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
