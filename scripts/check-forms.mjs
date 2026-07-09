#!/usr/bin/env node
// Input-feedback governance — the THIRD "no silent failure" guard, after check-mutations
// (no silent ACTION failure) and check-surfaces (no silent LOAD failure). This one bans a
// silent VALIDATION failure: a control marked invalid with no explanation a user — or a
// screen reader — can read.
//
// The rule: a control that sets `aria-invalid` to a value that can be TRUE (it can actually
// become invalid) must ALSO set `aria-describedby`, associating the rendered error message
// with the field. A red border / an "invalid" announcement with no reason attached is exactly
// the silent failure the read + write layers already eliminated, on the input side.
//
// Scope: JSX in pages/ + components/shared + components/chrome. The house FormField primitive
// wires BOTH aria-* onto its child at runtime (not in the JSX), so a field that uses
// `<FormField error=…>` is correct and invisible here — the guard only ever sees a HAND-ROLLED
// `aria-invalid`, which must therefore self-associate. The `components/ui` primitives only
// FORWARD/style aria-invalid, so they're out of scope. Escape hatch: a `form-ignore` comment.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const WEB_SRC = join(process.cwd(), "apps/web/src")

// Roots to scan — the surfaces that own forms. `components/ui` (the primitives that merely
// forward aria-invalid) and generated/test files are excluded.
const ROOTS = ["pages", "components/shared", "components/chrome"]

// Genuine exceptions live here with a reason. Empty by design — a real one-off uses the
// `form-ignore` line comment instead.
const ALLOW = new Set([])

const parse = (file) =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )

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
    else if (/\.tsx$/.test(name) && !/\.(test|gen)\.tsx$/.test(name)) out.push(full)
  }
  return out
}

const attr = (node, name) =>
  node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name)

// `aria-invalid` can be TRUE unless it's literally `false` / `{false}` — i.e. a bare
// `aria-invalid`, `aria-invalid={true}`, or any dynamic expression (`{!!err}`) all count.
const canBeInvalid = (a) => {
  const init = a.initializer
  if (!init) return true // bare attribute ⇒ true
  if (ts.isStringLiteral(init)) return init.text !== "false"
  if (ts.isJsxExpression(init) && init.expression)
    return init.expression.kind !== ts.SyntaxKind.FalseKeyword
  return true
}

const scan = (file) => {
  const src = parse(file)
  const lines = readFileSync(file, "utf8").split("\n")
  const out = []
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const ai = attr(node, "aria-invalid")
      if (ai && ts.isJsxAttribute(ai) && canBeInvalid(ai) && !attr(node, "aria-describedby")) {
        const { line } = src.getLineAndCharacterOfPosition(ai.getStart(src))
        if (
          !/\/\/\s*form-ignore\b/.test(lines[line] ?? "") &&
          !lines[line]?.includes("form-ignore")
        )
          out.push({ line: line + 1, text: (lines[line] ?? "").trim() })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

const violations = []
for (const root of ROOTS) {
  for (const file of walk(join(WEB_SRC, root))) {
    const rel = relative(WEB_SRC, file)
    if (ALLOW.has(rel)) continue
    for (const v of scan(file)) violations.push({ rel, ...v })
  }
}

if (violations.length === 0) {
  console.log("forms: ok — every invalid control carries an associated error message")
  process.exit(0)
}

console.error(`forms: ${violations.length} control(s) marked invalid with no associated message\n`)
for (const v of violations) console.error(`  apps/web/src/${v.rel}:${v.line}    ${v.text}`)
console.error(
  `\n  A control with aria-invalid must also set aria-describedby pointing at its rendered\n` +
    `  error — otherwise a screen reader announces "invalid" with no reason, and a sighted\n` +
    `  user sees a red field with no explanation. Prefer <FormField error={…}> (it wires both\n` +
    `  for a plain input); for a wrapped control (InputGroup) set aria-describedby by hand and\n` +
    `  render a role="alert" message (see components/shared/username-form.tsx).`,
)
process.exit(1)
