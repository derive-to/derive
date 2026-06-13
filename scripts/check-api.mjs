#!/usr/bin/env node
// Backend convention guardrails. Today: route handlers return errors through the
// shared `fail(c, status, message)` helper (apps/api/src/lib/http.ts), never a
// bare `c.json({ error }, status)`, so the error contract lives in one place.
// Runs in the CI gate. Escape hatch: an `api-ignore` comment on the line.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROUTES = join(process.cwd(), "apps/api/src/routes")

const RULES = [
  {
    re: /c\.json\(\{\s*error/,
    msg: "return errors via fail(c, status, message) (lib/http.ts), not a bare c.json({ error })",
  },
]

const stripIgnorable = (line) => line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "")

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith(".ts")) out.push(full)
  }
  return out
}

const violations = []
for (const file of walk(ROUTES)) {
  const rel = relative(ROUTES, file)
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((raw, i) => {
      if (raw.includes("api-ignore")) return
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
  console.log("api: ok — every route error goes through fail()")
  process.exit(0)
}

console.error(`api: ${violations.length} ad-hoc error response(s)\n`)
for (const v of violations) {
  console.error(`  apps/api/src/routes/${v.rel}:${v.line}:${v.col}  ${v.snippet}`)
  console.error(`    → ${v.msg}`)
}
process.exit(1)
