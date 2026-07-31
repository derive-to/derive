#!/usr/bin/env node
// Visibility guardrail for the store methods that reach MANY artifacts at once.
//
// These queries take an orgId and nothing else, because a store has no way to know who is
// asking. A workspace is NOT a read permission — an artifact can be invite-only inside its
// own workspace — so every caller has to narrow the result through the gate in
// apps/api/src/lib/visibility.ts before returning or counting a single row.
//
// This exists because it happened. Workspace search had the gate, with a long comment
// explaining password locks and seat-only reach. The cross-artifact slot readers were
// written later for the same shape of problem, scoped by org, and shipped with no gate at
// all: `find(data:"revenue")` returned the title and the figures of documents the caller
// had been deliberately left off, and the catalog counted them into its totals. The whole
// suite was green, because tests assert that a feature works and none of them asked who
// else could see the answer.
//
// The next multi-artifact reader will be written by someone who never read that story.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// Store methods that return rows for MANY artifacts scoped only by org. Adding one here is
// the point: a new reader gets the guard for free the moment it is listed.
const UNGATED_READERS = ["listSlotAcrossArtifacts", "listWorkspaceSlots", "searchArtifactIds"]
// Any one of these in the same file means the caller narrowed the rows.
const GATES = ["visibleArtifacts", "visibleArtifactIds"]
// The gate's own home, and the port file that DECLARES these methods: naming them is not
// calling them.
const EXEMPT = [
  "apps/api/src/lib/visibility.ts",
  "packages/core/src/ports.ts",
  "packages/db/src/pg.ts",
  "packages/db/src/repos.ts",
  "packages/db/src/sqlite.ts",
]

const walk = (dir) => {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full)
  }
  return out
}

const roots = ["apps/api/src", "apps/web/src", "packages/core/src", "packages/mcp/src"].filter(
  (r) => {
    try {
      return statSync(r).isDirectory()
    } catch {
      return false
    }
  },
)

const failures = []
let checked = 0
for (const file of roots.flatMap(walk)) {
  const rel = file.replace(/\\/g, "/")
  if (EXEMPT.includes(rel)) continue
  const src = readFileSync(file, "utf8")
  const used = UNGATED_READERS.filter((m) => src.includes(`${m}(`))
  if (!used.length) continue
  checked++
  if (!GATES.some((g) => src.includes(g)))
    failures.push(`${rel} calls ${used.join(", ")} without a visibility gate`)
}

// A guard that passes because it looked in the wrong place is worse than no guard: it is a
// claim. If nothing at all matched, the readers were renamed or the roots moved.
if (checked === 0) {
  console.error(
    "check-slot-visibility: found NO caller of any multi-artifact reader — the names in " +
      "UNGATED_READERS or the source roots are stale, so this guard is asserting nothing.",
  )
  process.exit(1)
}

if (failures.length) {
  console.error("check-slot-visibility: ungated multi-artifact read\n")
  for (const f of failures) console.error(`  ✖ ${f}`)
  console.error(
    "\nThese store methods scope by ORG, which is not a read permission: an artifact can be " +
      "invite-only inside its own workspace. Narrow the rows through visibleArtifactIds " +
      "(apps/api/src/lib/visibility.ts) before returning or COUNTING them — an aggregate over " +
      "artifacts the caller cannot see discloses them just as surely as naming them.",
  )
  process.exit(1)
}

console.log(`check-slot-visibility: ok — ${checked} multi-artifact read site(s), all gated`)
