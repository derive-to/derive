#!/usr/bin/env node
// Frontend convention guardrails that a generic linter can't express. Today:
// localStorage / sessionStorage may only be keyed by a member of STORAGE_KEYS
// (apps/web/src/lib/storage-keys.ts), never a bare string literal — so a key
// can't be typo'd, duplicated, or drift out of the namespace. Runs in the CI
// gate. Escape hatch: a `frontend-ignore` comment on the line.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const WEB_SRC = join(process.cwd(), "apps/web/src")
const STORAGE_KEYS_FILE = "lib/storage-keys.ts"

const RULES = [
  {
    re: /\b(?:local|session)Storage\.(?:get|set|remove)Item\(\s*["'`]/,
    msg: "storage key must come from STORAGE_KEYS (lib/storage-keys.ts), not a string literal",
  },
  {
    // A load that catches its error into an empty array renders "request failed" as
    // "zero items" — the blank-list-means-broken bug. Surface an error state (or use
    // React Query's error state via lib/queries.ts) instead of swallowing to []. A
    // debounced search that intentionally clears on an aborted keystroke is the one
    // legitimate case: annotate it with `frontend-ignore` and a reason.
    re: /\.catch\(\(\)\s*=>\s*(?:[\w.]+\s*&&\s*)?set\w*\(\s*\[\s*\]\s*\)/,
    msg: "a failed load is not an empty result — surface an error state, don't .catch(() => setX([]))",
  },
]

const stripIgnorable = (line) => line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "")

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== "dist") walk(full, out)
    } else if (/\.(?:tsx?)$/.test(name) && !/\.gen\.tsx?$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

const violations = []
for (const file of walk(WEB_SRC)) {
  const rel = relative(WEB_SRC, file)
  if (rel === STORAGE_KEYS_FILE) continue
  const lines = readFileSync(file, "utf8").split("\n")
  lines.forEach((raw, i) => {
    // A `frontend-ignore` on the flagged line OR the line just above suppresses it
    // (biome-ignore style), so the reason can sit on its own comment line.
    if (raw.includes("frontend-ignore") || lines[i - 1]?.includes("frontend-ignore")) return
    const line = stripIgnorable(raw)
    for (const rule of RULES) {
      const m = rule.re.exec(line)
      if (m)
        violations.push({
          rel,
          line: i + 1,
          col: m.index + 1,
          snippet: m[0].trim(),
          msg: rule.msg,
        })
    }
  })
}

if (violations.length === 0) {
  console.log("frontend: ok — no convention violations in apps/web/src")
  process.exit(0)
}

console.error(`frontend: ${violations.length} convention violation(s)\n`)
for (const v of violations) {
  console.error(`  apps/web/src/${v.rel}:${v.line}:${v.col}  ${v.snippet}`)
  console.error(`    → ${v.msg}`)
}
process.exit(1)
