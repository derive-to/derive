#!/usr/bin/env node
// Delete-cascade guardrail. Every table that references artifact.id must be cleared by
// EVERY deleteArtifact implementation, or deleting an artifact fails on a foreign-key
// constraint — at runtime, in production, for the one caller unlucky enough to have used
// the new feature.
//
// This exists because it happened: `version_data` was added with an artifact_id FK, all
// three delete paths kept clearing every OTHER child table, and the full test suite stayed
// green because no test deleted an artifact that carried a facts. The bug surfaced
// only when a live cleanup 500'd.
//
// The trap is that there are THREE implementations (the synchronous better-sqlite3 one the
// self-host node path runs, the Postgres transaction, and the shared async path D1 uses),
// so "I fixed the delete" is easy to believe after fixing one. Runs in the CI gate.
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SCHEMA = "packages/db/src/schema.ts"
// Every implementation of deleteArtifact. Adding a fourth without adding it here is the
// same class of miss this guard exists to catch, so the list is asserted below.
const IMPLS = [
  { file: "packages/db/src/sqlite.ts", label: "sqlite (self-host node)" },
  { file: "packages/db/src/pg.ts", label: "postgres" },
  { file: "packages/db/src/repos.ts", label: "shared/D1" },
]

const read = (rel) => readFileSync(join(process.cwd(), rel), "utf8")

// Drizzle table defs whose columns include an artifact_id FK to artifact.id. Matches the
// `export const <name> = sqliteTable("<table>", { ... })` block, then looks inside it.
const artifactChildTables = (src) => {
  const out = []
  const re = /export const (\w+) = sqliteTable\(\s*"([\w]+)"\s*,\s*\{/g
  let m = re.exec(src)
  while (m) {
    const [, varName, tableName] = m
    // Slice from the match to the next `export const` (or EOF) — enough to see the columns.
    const start = m.index
    const nextExport = src.indexOf("\nexport const ", start + 1)
    const body = src.slice(start, nextExport === -1 ? src.length : nextExport)
    const hasArtifactFk =
      /artifact_id:\s*text\("artifact_id"\)/.test(body) &&
      /references\(\(\)\s*=>\s*artifact\.id\)/.test(body)
    if (hasArtifactFk && varName !== "artifact") out.push({ varName, tableName })
    m = re.exec(src)
  }
  return out
}

/** The body of the deleteArtifact function in one implementation file. */
const deleteBody = (src, file) => {
  const at = src.search(/deleteArtifact[\s(:]/)
  if (at === -1) return null
  // To the next top-level member: `\n  async name(` or `\n  const name =` at 2-space indent.
  const rest = src.slice(at)
  const end = rest.search(/\n {2}(?:async \w+\(|const \w+ =|\/\/ ----)/)
  return rest.slice(0, end === -1 ? Math.min(rest.length, 8000) : end)
}

const schema = read(SCHEMA)
const children = artifactChildTables(schema)
const violations = []

if (children.length === 0)
  violations.push(`could not parse any artifact-child tables out of ${SCHEMA} — the guard is blind`)

for (const { file, label } of IMPLS) {
  let src
  try {
    src = read(file)
  } catch {
    violations.push(`missing delete implementation file: ${file}`)
    continue
  }
  const body = deleteBody(src, file)
  if (!body) {
    violations.push(`${file}: no deleteArtifact found — update IMPLS in this script if it moved`)
    continue
  }
  for (const { varName, tableName } of children) {
    // The delete may be written as delete(versionData) or delete(schema.versionData).
    const cleared = new RegExp(`delete\\(\\s*(?:\\w+\\.)?${varName}\\s*\\)`).test(body)
    if (!cleared)
      violations.push(
        `${file} [${label}]: deleteArtifact never clears "${tableName}" (${varName}), which has an artifact_id FK — deleting an artifact with one of these rows will fail on a FOREIGN KEY constraint`,
      )
  }
}

if (violations.length) {
  console.error("check-delete-cascade: FAILED\n")
  for (const v of violations) console.error(`  ✖ ${v}`)
  console.error(
    `\nEvery table with an artifact_id FK must be deleted in ALL ${IMPLS.length} implementations, before the artifact row itself.`,
  )
  process.exit(1)
}

console.log(
  `check-delete-cascade: ok — ${children.length} artifact-child tables cleared by all ${IMPLS.length} delete paths`,
)
