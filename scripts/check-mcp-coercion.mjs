#!/usr/bin/env node
// MCP-surface tolerance guardrail: no BARE `z.number()` in a tool's inputSchema.
//
// The failure this exists to stop has now shipped three times, in three shapes. A client
// caches the tool schema when it connects and validates arguments against that copy, so
// anything added afterwards is a parameter the client has never heard of:
//
//   a new ENUM VALUE   -> refused locally, never reaches the server  (fixed: lib/open-choice.ts)
//   a new STRING param -> passes through untouched                   (fine)
//   a new NUMBER param -> arrives as a STRING, the server rejects it (this check)
//
// The third one is the quiet one. `publish` shipped `render` and `wait` together; `render`
// worked from an already-connected client and `wait` did not, so a render could be asked
// for and never waited for — the capability was half-reachable, which reads as broken
// rather than as missing. `z.coerce.number()` accepts both and validates identically, so
// there is no reason to prefer the bare form on a surface whose callers hold stale copies
// of its schema.
//
// Enums are deliberately NOT covered: a closed vocabulary (access levels, terminal states)
// is one a client SHOULD refuse early. Growth-prone discriminators use open-choice instead.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const TOOLS_DIR = join(process.cwd(), "apps/api/src/mcp-tools")

// `z.number()` not preceded by `z.coerce`. Matches the bare constructor only, so
// `z.coerce.number()` and a plain `number` in a comment both pass.
const BARE_NUMBER = /(?<!coerce\.)\bz\.number\s*\(/g

const offenders = []
for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(join(TOOLS_DIR, file), "utf8")
  const lines = src.split("\n")
  lines.forEach((line, i) => {
    // Skip comment lines: prose about z.number() is not a schema declaration.
    const t = line.trim()
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return
    BARE_NUMBER.lastIndex = 0
    if (BARE_NUMBER.test(line)) offenders.push(`${file}:${i + 1}  ${t}`)
  })
}

if (offenders.length) {
  console.error(
    `check-mcp-coercion: ${offenders.length} bare z.number() in the MCP tool surface.\n` +
      "A client that connected before this parameter existed sends it as a STRING, so the\n" +
      "server rejects a value the caller passed correctly. Use z.coerce.number() — same\n" +
      "validation, tolerant of a stale schema.\n",
  )
  for (const o of offenders) console.error(`  ${o}`)
  process.exit(1)
}
console.log("check-mcp-coercion: ok — every numeric tool parameter coerces")
