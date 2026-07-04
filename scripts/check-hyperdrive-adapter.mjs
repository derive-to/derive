#!/usr/bin/env node
// Guardrail: all Workers-tier Postgres access goes through the ONE Hyperdrive
// adapter (apps/api/src/edge-pg.ts) — never an ad-hoc `pg` connection.
//
// Why this is a build failure and not a nit: a `new Pool()` / `new Client()` opened
// outside the adapter almost always gets the lifecycle wrong for Workers + Hyperdrive
// (module scope, reused across requests, or never .end()ed) and every DB-backed
// request then 500s with "Connection terminated unexpectedly". The adapter encodes
// the Cloudflare-documented contract (per-request, explicit .end(), Pool, max:5, no
// idle reaper) in one place; everything else must import `hyperdrivePool` /
// `livePgPool` from it. See the doc block + links in edge-pg.ts.
//
// Allowed to construct `pg` connections directly:
//   • apps/api/src/edge-pg.ts — the adapter itself.
//   • apps/api/src/node.ts    — the Node self-host tier (direct Postgres, NO Hyperdrive).
// Build/schema scripts under apps/api/scripts are out of scope (not runtime edge code).
//
// Escape hatch (rare, must be justified in review): a `hyperdrive-adapter-ok` comment
// on the offending line.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(process.cwd(), "apps/api/src")
const ALLOW = new Set(["edge-pg.ts", "node.ts"])

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith(".ts")) out.push(full)
  }
  return out
}

const BANNED = [
  {
    re: /\bnew\s+Pool\s*\(/,
    msg: "`new Pool()` outside the adapter — import `hyperdrivePool` from edge-pg.",
  },
  {
    re: /\bnew\s+Client\s*\(/,
    msg: "`new Client()` outside the adapter — import `hyperdrivePool` from edge-pg.",
  },
  {
    re: /\bfrom\s+["']pg["']/,
    msg: "direct `pg` import outside the adapter — use `livePgPool`/`hyperdrivePool` from edge-pg.",
  },
]

const violations = []
for (const file of walk(SRC)) {
  const base = file.slice(SRC.length + 1)
  if (ALLOW.has(base)) continue
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const trimmed = line.trim()
      // Skip comment lines (incl. JSDoc `*` continuations) and the escape hatch — the
      // adapter's rules are quoted in prose elsewhere and must not trip the check.
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return
      if (line.includes("hyperdrive-adapter-ok")) return
      for (const { re, msg } of BANNED)
        if (re.test(line)) violations.push(`${relative(process.cwd(), file)}:${i + 1}  ${msg}`)
    })
}

if (violations.length) {
  console.error(
    "hyperdrive: Postgres on the Workers tier must go through apps/api/src/edge-pg.ts.\n",
  )
  for (const v of violations) console.error(`  ${v}`)
  console.error("\n  Import { hyperdrivePool } (or the request-scoped livePgPool) from ./edge-pg.")
  process.exit(1)
}
console.log("hyperdrive: ok — all edge Postgres access goes through the edge-pg adapter")
