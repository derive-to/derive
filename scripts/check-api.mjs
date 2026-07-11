#!/usr/bin/env node
// Backend convention guardrails, run in the CI gate. Escape hatch on any flagged line: an
// `api-ignore` comment.
//
//  1. ROUTE error contract — handlers return errors through the shared `fail(c, status,
//     message)` helper (apps/api/src/lib/http.ts), never a bare `c.json({ error }, status)`,
//     and validate bodies with `readJson(c, schema)`, never a raw `c.req.json()` cast.
//
//  2. PUBLISH orchestration — the "a new version went live" side-effect chain (the
//     `version.published` realtime event and the follower fan-out) is constructed in exactly
//     ONE place, apps/api/src/lib/after-publish.ts. Every publish path (HTTP route, MCP tool,
//     restore, proposal-approve) must route through `afterPublish` / `emitVersionBump`. This
//     is here because it already went wrong once: an MCP publish silently skipped webhooks
//     and the realtime event because the sequence was hand-copied and drifted.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const API_SRC = join(process.cwd(), "apps/api/src")
const ROUTES = join(API_SRC, "routes")

// Scoped to routes/: the error-response contract.
const ROUTE_RULES = [
  {
    re: /c\.json\(\{\s*error/,
    msg: "return errors via fail(c, status, message) (lib/http.ts), not a bare c.json({ error })",
  },
  {
    re: /c\.req\.json\(/,
    msg: "validate the body with readJson(c, schema) (lib/http.ts), not a raw c.req.json() cast",
  },
]

// Scoped to all of apps/api/src EXCEPT the one sanctioned home: publish orchestration.
// `\btype:` deliberately does not match `event_type:` (a webhook row column).
const ORCHESTRATION_HOME = join(API_SRC, "lib/after-publish.ts")
const ORCHESTRATION_RULES = [
  {
    re: /\btype:\s*["']version\.published["']/,
    msg: "emit the version.published bus event via afterPublish/emitVersionBump (lib/after-publish.ts), not inline — every publish path must share the one side-effect chain",
  },
  {
    re: /\bkind:\s*["']publish["']/,
    msg: "the publisher→follower fan-out lives only in lib/after-publish.ts; call afterPublish instead of re-inlining the notification",
  },
]

const stripIgnorable = (line) => line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "")

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full)
  }
  return out
}

const scan = (files, rules, skip = () => false) => {
  const hits = []
  for (const file of files) {
    if (skip(file)) continue
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((raw, i) => {
        if (raw.includes("api-ignore")) return
        const line = stripIgnorable(raw)
        for (const rule of rules) {
          const m = rule.re.exec(line)
          if (m)
            hits.push({
              rel: relative(API_SRC, file),
              line: i + 1,
              col: m.index + 1,
              snippet: m[0].trim(),
              msg: rule.msg,
            })
        }
      })
  }
  return hits
}

const allFiles = walk(API_SRC)
const violations = [
  ...scan(walk(ROUTES), ROUTE_RULES),
  ...scan(allFiles, ORCHESTRATION_RULES, (f) => f === ORCHESTRATION_HOME),
]

if (violations.length === 0) {
  console.log("api: ok — error contract via fail(); publish side-effects via after-publish.ts")
  process.exit(0)
}

console.error(`api: ${violations.length} convention violation(s)\n`)
for (const v of violations) {
  console.error(`  apps/api/src/${v.rel}:${v.line}:${v.col}  ${v.snippet}`)
  console.error(`    → ${v.msg}`)
}
process.exit(1)
