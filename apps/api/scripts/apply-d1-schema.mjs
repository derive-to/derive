#!/usr/bin/env node
// Bring a Dock D1 database fully up to the current app schema. Run as part of every
// edge deploy (see the `deploy` script) so a deploy can NEVER ship code against a
// stale schema — the failure that takes the artifact read path (and everything
// downstream) to 500s, because the edge applies schema out of band (D1 forbids the
// runtime sqlite_master introspection the Node tier uses at boot).
//
// Idempotent and safe to run on every deploy:
//   1. CREATE TABLE/INDEX IF NOT EXISTS from deploy/d1-schema.sql → adds any new tables.
//   2. Diff each table's columns against the live DB and ALTER ... ADD COLUMN only the
//      missing ones (CREATE-IF-NOT-EXISTS never adds columns to a table that exists).
//
//   node scripts/apply-d1-schema.mjs           # --remote (production D1)
//   node scripts/apply-d1-schema.mjs --local   # local/dev D1
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DB = process.env.DOCK_D1_NAME ?? "dock"
const TARGET = process.argv.includes("--local") ? "--local" : "--remote"
const here = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(here, "../../../deploy/d1-schema.sql")

const wrangler = (args, capture = false) =>
  execFileSync("wrangler", ["d1", "execute", DB, TARGET, ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  })

// Parse expected columns (+ their full definitions) per table from the generated schema.
const sql = readFileSync(schemaPath, "utf8")
const expected = {}
const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\);/g
let m = re.exec(sql)
while (m) {
  const cols = {}
  for (const raw of m[2].split("\n")) {
    const line = raw.trim().replace(/,$/, "")
    if (!line || /^(UNIQUE|PRIMARY|FOREIGN|CHECK|CONSTRAINT)\b/i.test(line)) continue
    const col = line.split(/\s+/)[0]
    if (/^\w+$/.test(col)) cols[col] = line
  }
  expected[m[1]] = cols
  m = re.exec(sql)
}

console.log(`[d1] applying schema to "${DB}" (${TARGET})`)
// 1. Create any missing tables/indexes. IF NOT EXISTS → no-op for existing ones.
wrangler(["--file", schemaPath])

// 2. Find which columns the live DB is missing (D1 caps compound SELECT, so chunk).
const chunk = (a, n) => a.reduce((r, _, i) => (i % n ? r : [...r, a.slice(i, i + n)]), [])
const live = {}
for (const batch of chunk(Object.keys(expected), 5)) {
  const union = batch
    .map((t) => `SELECT '${t}' tbl, name col FROM pragma_table_info('${t}')`)
    .join(" UNION ALL ")
  const out = wrangler(["--json", "--command", union], true)
  for (const r of JSON.parse(out)[0].results) {
    if (!live[r.tbl]) live[r.tbl] = new Set()
    live[r.tbl].add(r.col)
  }
}

const alters = []
for (const [tbl, cols] of Object.entries(expected))
  for (const [col, def] of Object.entries(cols))
    if (live[tbl] && !live[tbl].has(col)) alters.push(`ALTER TABLE ${tbl} ADD COLUMN ${def};`)

if (alters.length === 0) {
  console.log("[d1] columns already current — nothing to add")
} else {
  console.log(`[d1] adding ${alters.length} missing column(s):`)
  for (const a of alters) console.log("  " + a)
  wrangler(["--command", alters.join(" ")])
}
console.log("[d1] schema up to date")
