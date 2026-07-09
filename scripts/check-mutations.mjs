#!/usr/bin/env node
// Mutation-feedback governance. Every data mutation in the web app goes through the
// one house primitive — `useApiMutation` (apps/web/src/lib/use-api-mutation.ts) — whose
// rejections surface through the global MutationCache safety net (lib/query-client.ts).
// That is what keeps action feedback uniform: no mutation can silently fail, and two
// copies of the same action can't drift, because there is exactly ONE place that turns a
// mutation error into a toast.
//
// The tell of a HAND-ROLLED mutation handler is echoing a caught error into a toast:
// `toast.error((e as Error).message)`, `toast.error(e.message)`, `toast.error(x instanceof
// Error ? x.message : "…")`. Deliberate UX messages, by contrast, are string LITERALS —
// `toast.error("Couldn't copy to clipboard")`. So the rule is precise: a `toast.error`
// whose argument is NOT a plain string literal belongs to the safety net and nowhere
// else. Anywhere else, route the mutation through `useApiMutation` (which toasts for you)
// or, for a genuinely bespoke non-cache case, add a `mutation-ignore` comment on the line
// with a reason.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const WEB_SRC = join(process.cwd(), "apps/web/src")

// The ONE legitimate home for a dynamic error toast is the safety net; the primitive +
// the sonner house-layer define/relay `toast` itself. Everything else must be governed.
const ALLOW = new Set([
  "lib/query-client.ts",
  "lib/use-api-mutation.ts",
  "components/ui/sonner.tsx",
])

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

// A static, human-authored message — the allowed shape. `"…"` / `'…'`, a backtick
// template with no `${}` interpolation, or a ternary that only ever PICKS between static
// messages (both branches literal). Anything else — a `.message`, a bare identifier, an
// interpolated template — is a dynamic/caught value, i.e. a hand-rolled handler. So
// `toast.error(cond ? "Expired" : "Failed")` is fine, but `toast.error(e instanceof Error
// ? e.message : "…")` is not.
const isLiteralMessage = (arg) => {
  if (!arg) return false
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return true
  if (ts.isParenthesizedExpression(arg)) return isLiteralMessage(arg.expression)
  if (ts.isConditionalExpression(arg))
    return isLiteralMessage(arg.whenTrue) && isLiteralMessage(arg.whenFalse)
  return false
}

const scan = (file) => {
  const text = readFileSync(file, "utf8")
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines = text.split("\n")
  const out = []
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText() === "toast" &&
      node.expression.name.getText() === "error" &&
      !isLiteralMessage(node.arguments[0])
    ) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart(src))
      if (!(lines[line] ?? "").includes("mutation-ignore"))
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
  console.log("mutations: ok — no hand-rolled mutation error toasts outside the safety net")
  process.exit(0)
}

console.error(
  `mutations: ${violations.length} hand-rolled mutation error toast(s) — route these through useApiMutation\n`,
)
for (const v of violations) console.error(`  apps/web/src/${v.rel}:${v.line}    ${v.text}`)
console.error(
  `\n  A dynamic toast.error(...) is the signature of a hand-rolled mutation handler.\n` +
    `  Use useApiMutation (lib/use-api-mutation.ts) — its rejections toast via the global\n` +
    `  safety net. For a deliberate static message use a string literal; for a genuinely\n` +
    `  bespoke non-cache case add a "mutation-ignore" comment (with a reason) on the line.`,
)
process.exit(1)
