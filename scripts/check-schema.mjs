#!/usr/bin/env node
// Schema-safety guardrail. The boot-applied DDL + forward-only migrations
// (packages/db/src/schema.ts SCHEMA_STATEMENTS/MIGRATION_STATEMENTS, and
// pg-schema.ts PG_SCHEMA_STATEMENTS) must stay NON-DESTRUCTIVE: Derive evolves the
// schema by adding (expand/contract), never by dropping. A DROP TABLE / DROP
// COLUMN / TRUNCATE / bare DELETE FROM in the schema source is a data-loss
// footgun — boot re-applies these, so a stray destructive statement would wipe
// real data on every restart. It fails here so it can't ship silently. Deprecate
// a column by leaving it in place; an actual removal (if ever) is a deliberate,
// separately-reviewed migration. Runs in the CI gate.
// Escape hatch: a `schema-ignore` comment on the line.
import { readFileSync } from "node:fs"
import { join } from "node:path"

const FILES = ["packages/db/src/schema.ts", "packages/db/src/pg-schema.ts"]

const RULES = [
  { re: /\bDROP\s+TABLE\b/i, msg: "DROP TABLE is destructive — evolve by adding, never dropping" },
  {
    re: /\bDROP\s+COLUMN\b/i,
    msg: "DROP COLUMN is data-lossy — deprecate the column in place instead",
  },
  { re: /\bTRUNCATE\b/i, msg: "TRUNCATE wipes a table — not allowed in schema/migration DDL" },
  {
    re: /\bDELETE\s+FROM\b/i,
    msg: "DELETE FROM in schema DDL is destructive — migrations are additive",
  },
]

// Strip JS comments so a pattern named in a comment isn't a false positive; the
// real DDL lives in template-literal strings, which are untouched.
const stripIgnorable = (line) => line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "")

const violations = []
for (const rel of FILES) {
  let src
  try {
    src = readFileSync(join(process.cwd(), rel), "utf8")
  } catch {
    continue
  }
  src.split("\n").forEach((raw, i) => {
    if (raw.includes("schema-ignore")) return
    const line = stripIgnorable(raw)
    for (const rule of RULES) {
      const m = rule.re.exec(line)
      if (m)
        violations.push({ rel, line: i + 1, col: m.index + 1, snippet: m[0].trim(), msg: rule.msg })
    }
  })
}

if (violations.length === 0) {
  console.log("schema: ok — no destructive DDL in the schema/migration sources")
  process.exit(0)
}

console.error(`schema: ${violations.length} destructive DDL statement(s)\n`)
for (const v of violations) {
  console.error(`  ${v.rel}:${v.line}:${v.col}  ${v.snippet}`)
  console.error(`    → ${v.msg}`)
}
process.exit(1)
