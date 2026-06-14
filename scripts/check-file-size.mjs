#!/usr/bin/env node
// File-size guard. Big files accrete complexity, hide bugs, and breed merge
// conflicts — and agents (human or AI) keep appending to the file that's already
// open instead of extracting. Source files must stay under MAX_LINES. A small
// allowlist pins the existing large files at their current ceiling: they may only
// SHRINK, never grow, and the moment one drops under the limit its entry must be
// removed. Any NEW oversized file fails outright — split it into focused
// modules/components/hooks. Escape hatch: add the path to ALLOWLIST with the reason
// it's irreducibly long (a generated schema, a flat type/DDL catalog).
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const MAX_LINES = 500
const ROOT = process.cwd()
const SCAN = [
  "apps/api/src",
  "apps/web/src",
  "packages/core/src",
  "packages/db/src",
  "packages/cli/src",
  "packages/mcp/src",
  "packages/storage/src",
]

// path -> ceiling (its current line count). An allowlisted file may be <= its
// ceiling; lower the number as you split it, and delete the entry once it's under
// MAX_LINES. Prefer splitting over allowlisting — only pin genuinely flat files.
const ALLOWLIST = {
  // React pages worth decomposing (tracked down, not pinned forever):
  "apps/web/src/pages/artifact/index.tsx": 790, // page orchestration — next: extract the document body + comment/edit handlers
  "apps/web/src/pages/artifact/comment-thread.tsx": 803, // comment thread UI — split candidate
  // Irreducibly flat by nature (DDL / a port interface / driver query catalogs):
  "packages/db/src/pg.ts": 883, // Postgres MetaStore: one flat method per query
  "packages/db/src/repos.ts": 840, // shared SQL repo methods
  "packages/core/src/ports.ts": 628, // the MetaStore port — a flat interface catalog
  "packages/db/src/schema.ts": 546, // SQLite schema (DDL)
  "packages/db/src/pg-schema.ts": 518, // Postgres schema (DDL)
}

const EXCLUDE = /\.(test|spec|gen|d)\.tsx?$|[/\\]generated[/\\]/

const walk = (dir, out = []) => {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name) && !EXCLUDE.test(full)) out.push(full)
  }
  return out
}

const files = SCAN.flatMap((d) => walk(join(ROOT, d)))
const errors = []
const seen = new Set()

for (const file of files) {
  const rel = relative(ROOT, file).split("\\").join("/")
  const lines = readFileSync(file, "utf8").split("\n").length
  const ceiling = ALLOWLIST[rel]
  if (ceiling != null) {
    seen.add(rel)
    if (lines > ceiling)
      errors.push(`${rel}: ${lines} lines > pinned ${ceiling} — it grew. Split it, don't append.`)
    else if (lines <= MAX_LINES)
      errors.push(`${rel}: ${lines} lines is under ${MAX_LINES} now — delete its allowlist entry.`)
  } else if (lines > MAX_LINES) {
    errors.push(
      `${rel}: ${lines} lines > ${MAX_LINES} — split into focused modules` +
        ` (allowlist only if irreducibly flat, with a reason).`,
    )
  }
}
for (const rel of Object.keys(ALLOWLIST))
  if (!seen.has(rel)) errors.push(`${rel}: allowlisted but not found — remove the stale entry.`)

if (errors.length === 0) {
  console.log(
    `filesize: ok — no source file over ${MAX_LINES} lines` +
      ` (${Object.keys(ALLOWLIST).length} pinned + shrinking)`,
  )
  process.exit(0)
}
console.error(`filesize: ${errors.length} oversized-file issue(s)\n`)
for (const e of errors) console.error(`  ${e}`)
console.error(
  `\n  Keep files small: extract components, hooks, and helpers. Files balloon one` +
    `\n  append at a time — this guard ratchets them down. See scripts/check-file-size.mjs.`,
)
process.exit(1)
