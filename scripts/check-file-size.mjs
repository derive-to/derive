#!/usr/bin/env node
// File-size nudge — NOT a hard gate. Big files tend to lose their shape: too many
// concerns in one place, harder to review, a magnet for merge conflicts. This
// never fails the build; it just flags any source file over WARN_LINES so someone
// can decide whether it's time to pull out a hook, component, or module. Length
// itself is fine — a flat DDL or query catalog is legitimately long. The point is
// organization, not a line count. Treat a warning as "take a look," not "blocked."
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const WARN_LINES = 750
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

const big = []
for (const file of SCAN.flatMap((d) => walk(join(ROOT, d)))) {
  const lines = readFileSync(file, "utf8").split("\n").length
  if (lines > WARN_LINES) big.push({ rel: relative(ROOT, file).split("\\").join("/"), lines })
}
big.sort((a, b) => b.lines - a.lines)

if (big.length === 0) {
  console.log(`filesize: ok — no source file over ${WARN_LINES} lines`)
} else {
  console.warn(`filesize: ${big.length} file(s) over ${WARN_LINES} lines — worth a look:`)
  for (const { rel, lines } of big) console.warn(`  ${rel}: ${lines} lines`)
  console.warn(
    `\n  Not a hard limit. Long is fine when a file is one cohesive thing (a flat` +
      `\n  DDL/query catalog). If it's several concerns piled up, extract a hook,` +
      `\n  component, or module. Organization over length.`,
  )
}
// Always succeeds — this is a warning, never a gate.
process.exit(0)
