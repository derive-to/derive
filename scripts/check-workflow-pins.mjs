#!/usr/bin/env node
// A tag such as `@v4` can be retargeted after review. GitHub can enforce immutable
// references at the repository level, but that setting would break main until this
// change lands. Keep the invariant in the deterministic gate as the source-of-truth
// backstop: third-party actions and reusable workflows use full commit SHAs; local
// composite actions remain path references.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = process.cwd()
const GITHUB = join(ROOT, ".github")
const YAML_EXTENSIONS = new Set([".yml", ".yaml"])

const files = []
const walk = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path)
    else if (YAML_EXTENSIONS.has(name.slice(name.lastIndexOf(".")))) files.push(path)
  }
}
walk(GITHUB)

const failures = []
for (const path of files) {
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)["']?/)
    if (!match) continue
    const reference = match[1]
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue
    const separator = reference.lastIndexOf("@")
    const revision = separator === -1 ? "" : reference.slice(separator + 1)
    if (!/^[0-9a-f]{40}$/.test(revision))
      failures.push(`${relative(ROOT, path)}:${index + 1}: ${reference}`)
  }
}

if (failures.length) {
  console.error("Workflow dependencies must use full 40-character commit SHAs:")
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`workflow pins: ${files.length} GitHub YAML files checked`)
