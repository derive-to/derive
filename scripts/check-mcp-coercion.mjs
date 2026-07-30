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

// A declaration can span lines:
//
//     wait: z
//       .number()      <-- bare too, and a line-by-line regex never saw it
//
// That gap was LIVE: this check reported "ok" while seven such parameters sat in
// catch-up.ts and find.ts — the precise stale-client bug it exists to prevent. A guard
// that passes while the thing it guards against is present is worse than no guard,
// because it is also a claim that the problem is handled. So a line ENDING in a bare `z`
// is checked together with the lines that continue it, and still reported at its own
// line number, which is where the reader has to edit.
const offenders = []
for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(join(TOOLS_DIR, file), "utf8")
  const lines = src.split("\n")
  lines.forEach((line, i) => {
    // Skip comment lines: prose about z.number() is not a schema declaration.
    const t = line.trim()
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return
    // A declaration that OPENS with a bare `z` continues on the following lines, so look
    // at this line joined to the next few — that is where `.number()` actually lands.
    // Collapse the whitespace INSIDE the chain (`z .number(` -> `z.number(`), or the
    // joined window still hides the very thing being looked for.
    const window = [line, ...lines.slice(i + 1, i + 4)]
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/\bz\s+\./g, "z.")
      .replace(/\.\s+/g, ".")
    const subject = /(^|[\s:([,])z\s*$/.test(line.replace(/\s+$/, "")) ? window : line
    BARE_NUMBER.lastIndex = 0
    if (BARE_NUMBER.test(subject)) offenders.push(`${file}:${i + 1}  ${t}`)
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
