#!/usr/bin/env node
// Test-id coverage. Interactive controls in the app surfaces (pages + shared
// components) must carry a stable `data-testid` so UI tests select by id, not by
// brittle text/DOM structure. AI-written UI routinely omits them, and the tests
// then break on the next refactor. We parse the TSX and flag interactive
// elements with no test id. The ui/ primitives are exempt (their consumers add
// the id, or pass one through). Escape hatch: a `testid-ignore` comment.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const WEB_SRC = join(process.cwd(), "apps/web/src")
const ROOTS = [join(WEB_SRC, "pages"), join(WEB_SRC, "components/shared")]

// Real interactive controls a test clicks or fills. Plain divs/spans (even with
// onClick plumbing like stopPropagation) are intentionally excluded to stay
// low-noise; if it's a control, it's one of these.
const INTERACTIVE = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "Button",
  "Input",
  "Textarea",
  "DropdownMenuItem",
])
const TESTID_ATTRS = new Set(["data-testid", "testId"])

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
    else if (name.endsWith(".tsx") && !name.endsWith(".gen.tsx")) out.push(full)
  }
  return out
}

const attrName = (a) =>
  ts.isJsxAttribute(a) && a.name ? a.name.getText() : ts.isJsxSpreadAttribute(a) ? "{...}" : ""

const scan = (file) => {
  const text = readFileSync(file, "utf8")
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines = text.split("\n")
  const out = []
  const visit = (node) => {
    const opening = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node : null
    if (opening) {
      const tag = opening.tagName.getText()
      const attrs = opening.attributes.properties
      const names = attrs.map(attrName)
      const interactive = INTERACTIVE.has(tag)
      // A spread may carry the id; don't second-guess it.
      const hasTestId = names.some((n) => TESTID_ATTRS.has(n) || n === "{...}")
      if (interactive && !hasTestId) {
        const { line } = src.getLineAndCharacterOfPosition(opening.getStart(src))
        if (!(lines[line] ?? "").includes("testid-ignore")) out.push({ tag, line: line + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

const violations = []
for (const root of ROOTS)
  for (const file of walk(root)) {
    const rel = relative(WEB_SRC, file)
    for (const v of scan(file)) violations.push({ rel, ...v })
  }

if (violations.length === 0) {
  console.log("testids: ok — every interactive control in pages/ + shared/ has a test id")
  process.exit(0)
}

console.error(`testids: ${violations.length} interactive control(s) without a data-testid\n`)
for (const v of violations) console.error(`  <${v.tag}>  apps/web/src/${v.rel}:${v.line}`)
console.error(
  `\n  Add a surface-scoped data-testid (or testId for a passthrough component),\n` +
    `  or mark a non-assertable control with a "testid-ignore" comment on its line.`,
)
process.exit(1)
