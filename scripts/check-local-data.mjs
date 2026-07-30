#!/usr/bin/env node
// Guardrail: NO LOCAL DATABASE AND NO AUTH SECRET MAY EVER BE TRACKED BY GIT.
//
// This is not hypothetical. On the require-payer branch a scratch run's
// `apps/api/.localdata-ux/derive.db` (851 KB) and its sibling `.auth-secret` (a real 64-hex
// secret) were committed together, and a reviewer decrypted a live model credential out of that
// database using that secret. They were deleted a commit later, which does nothing: the blobs
// stay reachable in history forever.
//
// .gitignore is the first line of defence and it is not enough on its own — the directory glob
// was apps/api-only when this happened, `git add -f` bypasses it entirely, and a file already
// tracked keeps being tracked no matter what the ignore file says afterwards. So the build
// fails instead. Runs in the CI gate.
//
// What it looks for, in the INDEX (tracked files), not the working tree:
//   - any .localdata / .localdata-* directory, anywhere;
//   - any SQLite database (*.db, *.sqlite, and their -wal/-shm sidecars);
//   - any .auth-secret.
//
// Escape hatch: none. A committed database is never the right answer — a fixture belongs in a
// test that builds it, and a secret belongs in a secret store. If a genuinely-needed binary
// fixture ever collides with these patterns, narrow the pattern here in a reviewed change
// rather than adding a bypass flag nobody will notice being used.
import { execFileSync } from "node:child_process"

const RULES = [
  {
    re: /(^|\/)\.localdata(-[^/]*)?\//,
    msg: "a local scratch data directory (holds a live derive.db + .auth-secret)",
  },
  { re: /\.(db|sqlite|sqlite3)(-wal|-shm)?$/i, msg: "a SQLite database" },
  { re: /(^|\/)\.auth-secret$/, msg: "an auth secret" },
  { re: /(^|\/)derive\.db$/, msg: "the Derive database" },
]

let tracked
try {
  tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0")
} catch {
  // Not a git checkout (a tarball build, a vendored copy). Nothing to check, nothing to fail.
  console.log("local-data: ok — not a git checkout, nothing tracked to inspect")
  process.exit(0)
}

const violations = []
for (const file of tracked) {
  if (!file) continue
  for (const rule of RULES) {
    if (rule.re.test(file)) {
      violations.push({ file, msg: rule.msg })
      break
    }
  }
}

if (violations.length === 0) {
  console.log(`local-data: ok — no databases or secrets among ${tracked.length - 1} tracked files`)
  process.exit(0)
}

console.error(`local-data: ${violations.length} file(s) that must never be committed\n`)
for (const v of violations) console.error(`  ${v.file}  — ${v.msg}`)
console.error(
  "\nRemove them from the index (`git rm --cached <file>`) and make sure .gitignore covers them.",
)
console.error(
  "If one has already landed in a pushed commit, the secret inside it must be rotated — deleting",
)
console.error("the file in a later commit does not remove the blob from history.")
process.exit(1)
