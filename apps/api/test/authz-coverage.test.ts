import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

// Guardrail: every mutating route handler (POST/PUT/PATCH/DELETE) must gate the
// request through identity or permission. AI-written routes routinely forget the
// auth check, and nothing else fails when they do. We parse each routes/*.ts and
// assert each mutating handler references one of the authz/identity helpers from
// the request context. A genuinely public mutation opts out with a
// `authz-exempt: <reason>` comment on the route's registration line.

const ROUTES_DIR = join(__dirname, "../src/routes")
const MUTATIONS = new Set(["post", "put", "patch", "delete"])

// Referencing any of these inside a handler means the request is gated by who is
// calling (a session/agent/membership) or what they may do. A mutating handler
// that touches NONE of them is almost certainly unauthenticated by accident.
const AUTHZ = new Set([
  "authorize",
  "requireArtifact",
  "workspaceCan",
  "collectionRole",
  "canManageCollection",
  "ensureMembership",
  "isMember",
  "activeWorkspace",
  "actingUser",
  "currentUser",
  "requireUser",
  "isLastOwner",
  "agentFor",
  "isToken",
])

const EXEMPT = "authz-exempt"

type Violation = { file: string; method: string; path: string; line: number }

const identifiersIn = (node: ts.Node): Set<string> => {
  const names = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) names.add(n.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return names
}

const scanFile = (file: string): Violation[] => {
  const text = readFileSync(join(ROUTES_DIR, file), "utf8")
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const lines = text.split("\n")
  const out: Violation[] = []

  // Some handlers delegate (e.g. `(c) => handlePublish(c)`), so a local helper
  // that itself does authz counts as gating. Collect named functions in the file
  // whose body references an authz helper, and treat their names as gating too.
  const gaters = new Set(AUTHZ)
  const collect = (n: ts.Node) => {
    const fn =
      (ts.isVariableDeclaration(n) &&
        n.name &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
        ([n.name.text, n.initializer] as const)) ||
      (ts.isFunctionDeclaration(n) && n.name && ([n.name.text, n] as const))
    if (fn && [...identifiersIn(fn[1])].some((x) => AUTHZ.has(x))) gaters.add(fn[0])
    ts.forEachChild(n, collect)
  }
  collect(src)

  const visit = (node: ts.Node) => {
    const pathArg = ts.isCallExpression(node) ? node.arguments[0] : undefined
    const handler = ts.isCallExpression(node)
      ? node.arguments[node.arguments.length - 1]
      : undefined
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MUTATIONS.has(node.expression.name.text) &&
      pathArg &&
      handler &&
      ts.isStringLiteralLike(pathArg) &&
      (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
    ) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart(src))
      const around = `${lines[line - 1] ?? ""}\n${lines[line] ?? ""}`
      const gated = [...identifiersIn(handler)].some((n) => gaters.has(n))
      if (!gated && !around.includes(EXEMPT)) {
        out.push({
          file,
          method: node.expression.name.text.toUpperCase(),
          path: pathArg.getText(src).replace(/['"`]/g, ""),
          line: line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

describe("authz coverage", () => {
  it("every mutating route gates on identity or permission", () => {
    const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))
    const violations = files.flatMap(scanFile)
    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.method} ${v.path}  (${v.file}:${v.line})`)
        .join("\n")
      throw new Error(
        `${violations.length} mutating route(s) with no authz/identity check:\n${report}\n\n` +
          `Add an authz call (authorize / workspaceCan / collectionRole / ensureMembership / …),\n` +
          `or mark a genuinely public mutation with an "authz-exempt: <reason>" comment on its route line.`,
      )
    }
    expect(violations).toEqual([])
  })
})
