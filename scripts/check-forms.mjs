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
// Deliberate scope (a backstop, not a proof): the guard flags only a HAND-ROLLED literal
// `aria-invalid` in pages/ + components/shared + components/chrome .tsx. The sanctioned paths —
// `fieldError(...).aria` (a spread) and `<FormField error=…>` (a runtime clone) — attach both
// aria-* by construction and are invisible here; the `components/ui` primitives only
// forward/style aria-invalid. So this catches the ad-hoc "red field, no message" case, not the
// house helpers. Escape hatch: a `// form-ignore` or `/* form-ignore */` comment on the line.
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
  if (ts.isStringLiteral(init)) return init.text !== "false" // aria-invalid="false"
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false // {false}
    if (ts.isStringLiteral(e)) return e.text !== "false" // {"false"}
    return true
  }
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
        // A deliberate `// form-ignore` or `/* form-ignore */` COMMENT on the line (a block
        // comment is what works inside a JSX attribute expression) — NOT any substring, so a
        // string value or attribute that merely contains the token can't suppress the check.
        if (!/\/[/*]\s*form-ignore\b/.test(lines[line] ?? ""))
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
