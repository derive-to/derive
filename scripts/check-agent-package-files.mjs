import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const packages = [
  {
    dir: "packages/cli",
    required: [
      "README.md",
      "skills/derive/SKILL.md",
      "skills/derive/agents/openai.yaml",
      "skills/derive/references/connect.md",
      "skills/derive/references/compatibility.md",
    ],
  },
  {
    dir: "packages/mcp",
    required: ["README.md", "SKILL.md", "references/connect.md", "references/compatibility.md"],
  },
  {
    dir: "packages/templates",
    required: ["README.md"],
  },
]

const errors = []

// The published set must be closed under its own workspace dependencies: a
// `workspace:*` dependency on a package outside this list ships a version spec
// the registry cannot resolve (the internal @derive/* scope is never published),
// and `pnpm publish` rewrites the spec without checking that the target exists —
// so the closure has to be asserted here, before anything is packed.
const publishedNames = new Set(
  packages.map((pkg) => {
    const manifest = JSON.parse(readFileSync(join(root, pkg.dir, "package.json"), "utf8"))
    return manifest.name
  }),
)
for (const pkg of packages) {
  const manifest = JSON.parse(readFileSync(join(root, pkg.dir, "package.json"), "utf8"))
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {}))
    if (String(spec).startsWith("workspace:") && !publishedNames.has(name))
      errors.push(
        `${pkg.dir}: dependency ${name} is workspace-linked but not in the published set — ` +
          `the registry cannot resolve it. Publish it (add it to this list) or cut the dependency.`,
      )
}
for (const pkg of packages) {
  const result = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: join(root, pkg.dir),
    encoding: "utf8",
  })
  if (result.status !== 0) {
    errors.push(`${pkg.dir}: npm pack failed\n${result.stderr || result.stdout}`)
    continue
  }

  let packed
  try {
    packed = JSON.parse(result.stdout)
  } catch {
    errors.push(`${pkg.dir}: npm pack returned invalid JSON`)
    continue
  }
  const files = new Set((packed[0]?.files ?? []).map((file) => file.path))
  for (const path of pkg.required)
    if (!files.has(path)) errors.push(`${pkg.dir}: packed tarball is missing ${path}`)
}

if (errors.length) {
  for (const error of errors) console.error(`agent-package-files: ${error}`)
  process.exit(1)
}

console.log(
  "agent-package-files: published tarballs carry their required files, and the set is dependency-closed",
)
