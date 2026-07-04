#!/usr/bin/env node
// Guardrail: NEVER use a `pg.Pool` on the Hyperdrive (Workers) path.
//
// Hyperdrive already pools connections server-side. A pg.Pool layered on top opens
// extra/idle sockets the Workers runtime can't keep alive across the
// request↔waitUntil boundary; Hyperdrive terminates them and the next query fails
// with "Connection terminated unexpectedly" (this took down sign-in / get-session /
// presence in prod). The edge tier must open exactly ONE pg.Client per invocation
// and let Hyperdrive multiplex — see apps/api/src/edge-pg.ts (`hyperdriveConn`).
//
// This fails the build if `new Pool(` (or the old `hyperdrivePool`) appears in any
// Workers/Hyperdrive-tier file: one that imports the `Hyperdrive` type or `edge-pg`.
// The Node self-host tier (direct Postgres, no Hyperdrive) may still use a Pool.
// Runs in the CI gate. Escape hatch: a `hyperdrive-pool-ok` comment on the line.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(process.cwd(), "apps/api/src")

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith(".ts")) out.push(full)
  }
  return out
}

// A file is on the Hyperdrive/Workers path if it touches the Hyperdrive binding
// type or the edge-pg plumbing.
const isHyperdrivePath = (src) =>
  /\bHyperdrive\b/.test(src) || /["']\.?\.?\/?.*edge-pg["']/.test(src)

const BANNED = [
  { re: /new\s+Pool\s*\(/, msg: "`new Pool()` on the Hyperdrive path — Hyperdrive pools already." },
  { re: /\bhyperdrivePool\b/, msg: "`hyperdrivePool` is gone — use `hyperdriveConn` (a single client)." },
]

const violations = []
for (const file of walk(SRC)) {
  const src = readFileSync(file, "utf8")
  if (!isHyperdrivePath(src)) continue
  src.split("\n").forEach((line, i) => {
    const trimmed = line.trim()
    // Skip comment lines (incl. JSDoc `*` continuations) and the escape hatch — a
    // doc block explaining the rule mentions `new Pool(` on purpose.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return
    if (line.includes("hyperdrive-pool-ok")) return
    for (const { re, msg } of BANNED)
      if (re.test(line)) violations.push(`${relative(process.cwd(), file)}:${i + 1}  ${msg}`)
  })
}

if (violations.length) {
  console.error("hyperdrive: pg.Pool is not allowed on the Workers/Hyperdrive path.\n")
  for (const v of violations) console.error(`  ${v}`)
  console.error(
    "\n  Open ONE pg.Client per request and let Hyperdrive multiplex (apps/api/src/edge-pg.ts).",
  )
  process.exit(1)
}
console.log("hyperdrive: ok — no pg.Pool on the Workers path")
