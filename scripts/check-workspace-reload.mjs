#!/usr/bin/env node
// Workspace-reload governance. The query cache persists to IndexedDB and is restored on
// every boot (apps/web/src/lib/persist.ts), so a hard navigation after the active
// workspace changes MUST flag the next boot to start cold — otherwise the restore
// rehydrates the OLD workspace's entries, and any staleTime-Infinity query
// (workspaceQuery) serves the wrong workspace's data forever: Settings pinned to a
// stale workspace, and a switcher whose no-op guard silently swallows switches. That
// shipped as a real cross-workspace data leak once persistence landed.
//
// There is exactly ONE sanctioned wrapper — `reloadAfterWorkspaceChange` in
// lib/persist.ts — so the invariant can't be forgotten at a new call site. The rule:
// no raw `location.reload()` / `location.assign(...)` anywhere else in apps/web/src.
// Auth/external redirects that ASSIGN A URL STRING to `location.href` are a different
// gesture and stay allowed. For a genuinely non-workspace full reload (none exist
// today), add a `// reload-ignore` comment on the line with a reason.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const WEB_SRC = join(process.cwd(), "apps/web/src")

// The wrapper's own home — the one legitimate place for the raw calls it encapsulates.
const ALLOW = new Set(["lib/persist.ts"])

const walk = (dir, out = []) => {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name) && !/\.(test|gen)\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

// `location.reload()` / `location.assign(...)` in any spelling that ends at the
// `location` global or property: `location.reload()`, `window.location.reload()`,
// `globalThis.location.assign(...)`, `document.location.reload()`.
const isLocationCall = (node) => {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
  const method = node.expression.name.getText()
  if (method !== "reload" && method !== "assign") return false
  const receiver = node.expression.expression
  if (ts.isIdentifier(receiver)) return receiver.text === "location"
  if (ts.isPropertyAccessExpression(receiver)) return receiver.name.getText() === "location"
  return false
}

const scan = (file) => {
  const text = readFileSync(file, "utf8")
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines = text.split("\n")
  const out = []
  const visit = (node) => {
    if (isLocationCall(node)) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart(src))
      // The escape hatch is a deliberate `// reload-ignore` COMMENT on the line — not any
      // substring, so an explanatory string can't accidentally suppress the check.
      if (!/\/\/\s*reload-ignore\b/.test(lines[line] ?? ""))
        out.push({ line: line + 1, text: (lines[line] ?? "").trim() })
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

const violations = []
for (const file of walk(WEB_SRC)) {
  const rel = relative(WEB_SRC, file)
  if (ALLOW.has(rel)) continue
  for (const v of scan(file)) violations.push({ rel, ...v })
}

if (violations.length === 0) {
  console.log(
    "workspace-reload: ok — hard navigations ride reloadAfterWorkspaceChange (lib/persist.ts)",
  )
  process.exit(0)
}

console.error(
  `workspace-reload: ${violations.length} raw location.reload()/assign() call(s) outside lib/persist.ts\n`,
)
for (const v of violations) console.error(`  apps/web/src/${v.rel}:${v.line}    ${v.text}`)
console.error(
  `\n  A raw reload restores the previous workspace's persisted query cache on boot,\n` +
    `  which serves another workspace's data after a switch (staleTime-Infinity queries\n` +
    `  never refetch a restored entry). Use reloadAfterWorkspaceChange(target?) from\n` +
    `  lib/persist.ts. For a genuinely non-workspace full reload, add a "reload-ignore"\n` +
    `  comment (with a reason) on the line.`,
)
process.exit(1)
