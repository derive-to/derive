#!/usr/bin/env node
// Bring a Derive D1 database fully up to the current app schema. Run as part of every
// edge deploy (see the `deploy` script) so a deploy can NEVER ship code against a
// stale schema — the failure that takes the artifact read path (and everything
// downstream) to 500s, because the edge applies schema out of band (D1 forbids the
// runtime sqlite_master introspection the Node tier uses at boot).
//
// Idempotent and safe to run on every deploy:
//   1. CREATE TABLE IF NOT EXISTS (tables/virtual tables) from deploy/d1-schema.sql.
//   2. Diff each table's columns against the live DB and ALTER ... ADD COLUMN only the
//      missing ones (CREATE-IF-NOT-EXISTS never adds columns to a table that exists).
//   3. CREATE [UNIQUE] INDEX IF NOT EXISTS last — a partial index can reference a column
//      step 2 just added, so indexes must not run before the reconciler.
//
// No-op on the Postgres tier: with Hyperdrive → Neon bound, the worker reads Postgres
// and this D1 sits idle, so its schema is irrelevant. DATABASE_URL set ⇒ skip (see the
// guard below) — otherwise a drift in a database prod never reads could block deploys.
//
//   node scripts/apply-d1-schema.mjs           # --remote (production D1)
//   node scripts/apply-d1-schema.mjs --local   # local/dev D1
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseExpectedColumns, partitionStatements, planColumnAdds } from "./d1-schema-plan.mjs"

const DB = process.env.DERIVE_D1_NAME ?? "derive"
const TARGET = process.argv.includes("--local") ? "--local" : "--remote"

// Postgres tier: skip. When Hyperdrive → Neon is bound, the worker reads Postgres and
// the D1 database "sits idle" (see apps/api/wrangler.toml) — its schema never serves a
// request. Applying it anyway lets a drift in a database prod never reads block every
// deploy: e.g. a NOT NULL column added to an existing table, which fails the `CREATE
// INDEX` in the declarative file AND can't be ALTER-added by the additive-only
// reconciler below — wedging the pipeline over dead weight. DATABASE_URL set means the
// Postgres tier (the deploy step asserts it before calling this), so bow out cleanly. A
// D1-tier deploy (no DATABASE_URL) still applies, as does `--local` dev without one.
if (process.env.DATABASE_URL) {
  console.log("[d1] DATABASE_URL set (Postgres tier) — D1 is idle; skipping D1 schema apply")
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(here, "../../../deploy/d1-schema.sql")

const wrangler = (args, capture = false) =>
  execFileSync("wrangler", ["d1", "execute", DB, TARGET, ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  })

// Apply a batch of statements via a temp .sql file — wrangler's --file takes the whole
// batch, sidestepping any --command length cap. Cleaned up whether or not it throws.
const applySql = (label, statements) => {
  if (!statements.length) return
  const tmp = join(tmpdir(), `d1-apply-${label}-${process.pid}.sql`)
  writeFileSync(tmp, statements.join("\n\n"))
  try {
    wrangler(["--file", tmp])
  } finally {
    rmSync(tmp, { force: true })
  }
}

// Parse expected columns (+ their full definitions) per table from the generated schema,
// and split it: tables/virtual tables apply first, indexes AFTER the column reconciler.
const sql = readFileSync(schemaPath, "utf8")
const expected = parseExpectedColumns(sql)
const { preIndex, indexes } = partitionStatements(sql)

console.log(`[d1] applying schema to "${DB}" (${TARGET})`)
// 1. Create any missing tables/virtual tables (IF NOT EXISTS → no-op for existing ones).
//    NOT the indexes: a partial index (context_session_dedupe) references a column the
//    step-2 alters add on an existing DB, so it must wait until step 3 — otherwise its
//    CREATE fails "no such column" and aborts the apply before a single ALTER runs.
applySql("tables", preIndex)

// 2. Find which columns the live DB is missing (D1 caps compound SELECT, so chunk).
const chunk = (a, n) => {
  const out = []
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n))
  return out
}
const live = {}
for (const batch of chunk(Object.keys(expected), 5)) {
  const union = batch
    .map((t) => `SELECT '${t}' tbl, name col FROM pragma_table_info('${t}')`)
    .join(" UNION ALL ")
  const out = wrangler(["--json", "--command", union], true)
  for (const r of JSON.parse(out)[0].results) {
    if (!live[r.tbl]) live[r.tbl] = new Set()
    live[r.tbl].add(r.col)
  }
}

const { alters, unsafe } = planColumnAdds(expected, live)

// Derive's schema policy is additive-only: a column added to an existing table must be
// nullable or carry a constant DEFAULT (SQLite/D1 reject ADD COLUMN of a NOT NULL column
// with no default on populated rows). Abort BEFORE running any ALTER so a policy slip
// fails the deploy cleanly with an actionable message instead of half-applying the batch.
if (unsafe.length) {
  console.error(`[d1] refusing to add ${unsafe.length} NOT NULL column(s) without a default:`)
  for (const u of unsafe) console.error(`  ${u.tbl}.${u.col}  →  ${u.def}`)
  console.error(
    "[d1] make the column nullable or give it a constant DEFAULT (additive-only schema\n" +
      "     policy — see CONTRIBUTING.md → Database migrations). Database left untouched.",
  )
  process.exit(1)
}

if (alters.length === 0) {
  console.log("[d1] columns already current — nothing to add")
} else {
  console.log(`[d1] adding ${alters.length} missing column(s):`)
  for (const a of alters) console.log(`  ${a}`)
  wrangler(["--command", alters.join(" ")])
}

// 3. Indexes last — every column they reference (e.g. context_session.dedupe_key) now
//    exists, whether just ALTER-added above or already present. IF NOT EXISTS → idempotent.
applySql("indexes", indexes)
console.log("[d1] schema up to date")
