import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const root = process.cwd()
const sourceRoot = join(root, "packages/cli/skills/derive")
const files = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/connect.md",
  "references/compatibility.md",
]
const targets = [join(root, ".agents/skills/derive"), join(root, ".claude/skills/derive")]
const legacy = [
  join(root, ".agents/skills/derive-loop"),
  join(root, ".claude/skills/derive-loop"),
  join(root, ".claude/skills/derive.md"),
  join(root, ".claude/skills/derive-connect.md"),
]
const check = process.argv.includes("--check")
const errors = []

const source = Object.fromEntries(
  files.map((path) => [path, readFileSync(join(sourceRoot, path), "utf8")]),
)

const frontmatter = source["SKILL.md"].match(/^---\n([\s\S]*?)\n---/)
if (!frontmatter) errors.push("canonical SKILL.md has no frontmatter")
if (!/^name: derive$/m.test(frontmatter?.[1] ?? "")) errors.push("skill name must be derive")
if (!/^description: .*(Derive|\/derive)/m.test(frontmatter?.[1] ?? ""))
  errors.push("skill description must carry Derive trigger words")

for (const target of targets) {
  // Sync only the canonical files. Preserve any extra project-local files in the
  // skill directory so check and write mode have the same ownership boundary.
  for (const [path, contents] of Object.entries(source)) {
    const destination = join(target, path)
    if (check) {
      if (!existsSync(destination) || readFileSync(destination, "utf8") !== contents)
        errors.push(`${destination} is not synced from the canonical skill`)
    } else {
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, contents)
    }
  }
}

const mcpFiles = {
  "packages/mcp/SKILL.md": source["SKILL.md"],
  "packages/mcp/references/connect.md": source["references/connect.md"],
  "packages/mcp/references/compatibility.md": source["references/compatibility.md"],
}
for (const [path, contents] of Object.entries(mcpFiles)) {
  const destination = join(root, path)
  if (check) {
    if (!existsSync(destination) || readFileSync(destination, "utf8") !== contents)
      errors.push(`${destination} is not synced from the canonical skill`)
  } else {
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, contents)
  }
}

for (const path of legacy) {
  if (check && existsSync(path)) errors.push(`${path} is a stale duplicate Derive skill`)
  else if (!check) rmSync(path, { recursive: true, force: true })
}

if (errors.length) {
  for (const error of errors) console.error(`agent-skill: ${error}`)
  process.exit(1)
}

if (!check) console.log("Synced the Derive skill for Codex, Claude, and the stdio MCP.")
