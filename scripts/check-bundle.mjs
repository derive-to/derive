#!/usr/bin/env node
// Bundle budget. The real cost that matters is the CRITICAL PATH: the JS the
// browser must download before the app is interactive — the entry chunk plus the
// closure of its STATIC imports (react-vendor, the API client, the runtime).
// Route chunks behind a dynamic `import()` (the CodeMirror editor, per-route
// pages) are lazy: a visitor who never opens that surface never pays for them, so
// they don't belong in the same budget as the first paint.
//
// So this gates two things hard — the eager total and any single chunk — and
// reports the lazy/aggregate weight for visibility without failing on it (a CDN
// serves the client with multi-MB of room; the point is catching an ACCIDENT, a
// fat dep landing EAGERLY, not policing on-demand features). Run
// `pnpm --filter @derive/web build` first; it emits the manifest this reads.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

const CLIENT = join(process.cwd(), "apps/web/dist/client")
const ASSETS = join(CLIENT, "assets")
const MANIFEST = join(CLIENT, ".vite/manifest.json")

// The eager budget sits generously over the measured critical path (~186 kB at
// the time of writing) — room for the first-paint surface to grow before this
// trips. The single-chunk budget is the sharper tripwire for one fat dep (eager
// or lazy); the aggregate is a loose backstop only. Raise any of these
// deliberately (in a PR) when a feature earns it.
const EAGER_BUDGET = 300 * 1024
const CHUNK_BUDGET = 180 * 1024
// Templates adds a fully lazy catalog + library-management surface. Its metadata
// is fetched on demand (not bundled), and the eager path remains unchanged; give
// that intentional route 20 kB of aggregate room without relaxing either hard
// user-facing budget above.
const TOTAL_BACKSTOP = 822 * 1024

let manifest
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"))
} catch {
  console.error(
    `bundle: no client manifest at ${MANIFEST}\n` +
      "  Run `pnpm --filter @derive/web build` first (needs build.manifest in vite.config).",
  )
  process.exit(1)
}

// The eager set: every chunk reachable from an entry through STATIC imports only.
// `dynamicImports` (lazy route chunks) are deliberately not followed.
const eagerKeys = new Set()
const walk = (key) => {
  if (eagerKeys.has(key) || !manifest[key]) return
  eagerKeys.add(key)
  for (const imp of manifest[key].imports ?? []) walk(imp)
}
for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) walk(key)
const eagerFiles = new Set(
  [...eagerKeys].map((k) => manifest[k].file).filter((f) => f?.endsWith(".js")),
)

let files
try {
  files = readdirSync(ASSETS).filter((f) => f.endsWith(".js"))
} catch {
  console.error(
    `bundle: no client build at ${ASSETS}\n  Run \`pnpm --filter @derive/web build\` first.`,
  )
  process.exit(1)
}

let eager = 0
let total = 0
let biggest = { file: "", gz: 0 }
const rows = files
  .map((f) => {
    const gz = gzipSync(readFileSync(join(ASSETS, f)), { level: 9 }).length
    total += gz
    if (eagerFiles.has(`assets/${f}`)) eager += gz
    if (gz > biggest.gz) biggest = { file: f, gz }
    return { f, gz, eager: eagerFiles.has(`assets/${f}`) }
  })
  .sort((a, b) => b.gz - a.gz)

const kb = (n) => `${(n / 1024).toFixed(1)} kB`
const overEager = eager > EAGER_BUDGET
const overChunk = biggest.gz > CHUNK_BUDGET
const overTotal = total > TOTAL_BACKSTOP

console.log("bundle: gzipped client JS (▸ = eager / critical path)")
for (const r of rows.slice(0, 8))
  console.log(`  ${r.eager ? "▸" : " "} ${kb(r.gz).padStart(9)}  ${r.f}`)
console.log(`  ${"…".padStart(11)}  (${files.length} chunks total)`)
console.log(`  eager:   ${kb(eager)} / ${kb(EAGER_BUDGET)} budget   (critical path)`)
console.log(`  lazy:    ${kb(total - eager)}   (on-demand route chunks)`)
console.log(`  total:   ${kb(total)} / ${kb(TOTAL_BACKSTOP)} backstop`)
console.log(`  largest: ${kb(biggest.gz)} (${biggest.file}) / ${kb(CHUNK_BUDGET)} budget`)

if (overEager || overChunk || overTotal) {
  console.error("\nbundle: OVER BUDGET")
  if (overEager) console.error(`  eager critical path ${kb(eager)} exceeds ${kb(EAGER_BUDGET)}`)
  if (overChunk)
    console.error(`  chunk ${biggest.file} ${kb(biggest.gz)} exceeds ${kb(CHUNK_BUDGET)}`)
  if (overTotal) console.error(`  total ${kb(total)} exceeds the ${kb(TOTAL_BACKSTOP)} backstop`)
  console.error(
    "\n  If it's eager: lazy-load it (`lazy(() => import(...))`) or import the\n" +
      "  specific symbol. If the weight is justified, raise the budget in\n" +
      "  scripts/check-bundle.mjs.",
  )
  process.exit(1)
}
console.log("bundle: ok — within budget")
process.exit(0)
