#!/usr/bin/env node
// Read-side feedback governance. A data surface owes the reader three things while it
// resolves: a LOADING frame (never a blank flash or a bare spinner), an EMPTY state, and
// an ERROR state (never a silent degrade to "nothing here" or an infinite skeleton). The
// gold-standard surfaces — library, profile, people, artifact — do all three. This guard
// locks in the two that are crisply checkable:
//
//   A. A route with a data `loader` must declare a `pendingComponent` (a PRESENCE check —
//      that the frame is shape-matched, not `() => null`, stays the author's judgment).
//      Without it the cold-load window falls to the generic AppBoot (a blank-ish flash),
//      not a skeleton shaped like the page. (empty/error are the component's job.)
//
//   B. A .tsx surface that reads a query (`useQuery`/`useInfiniteQuery`) must handle the
//      failure — reference `isError`/`isLoadingError`, or destructure `error`. A query whose
//      `.data` is rendered with no error branch degrades silently: a failed read looks like
//      an empty list, or (when the loading gate is `!data` instead of `isPending`) spins.
//
// Deliberate scope (a proxy, not a proof): Check B is per-FILE — a file passes once it
// handles error on ANY one query, so a secondary/ambient read alongside a handled one rides
// along — and it sees only literal useQuery calls in pages/ + components/ .tsx (a query
// behind a custom hook, or in a .ts file or a route, isn't reached). Ambient / warm-cache /
// degrade-by-design reads are allow-listed; a one-off gets a `surface-ignore` comment.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const WEB_SRC = join(process.cwd(), "apps/web/src")

// --- Check A: routes whose loader legitimately needs no shape-matched pending frame
// (redirect-only, or the loader does non-data work). Calibrated from the route set.
const ROUTE_ALLOW = new Set([])

// --- Check B: query reads that are ambient chrome, warm-cache (enabled:false), or
// degrade gracefully by design — the reader never waits on them for a primary surface.
const QUERY_ALLOW = new Set([
  "components/chrome/nav-rail.tsx", // rail counts degrade to empty; RailSkeleton covers `me`
  "components/chrome/app-shell.tsx", // workspace switcher, ambient
  "components/chrome/command-palette.tsx", // renders whatever's cached
  "components/chrome/sync-chip.tsx", // ambient status indicator
  "components/chrome/notification-bell.tsx", // ambient badge; a failed load stays quiet, SSE/visibility retries
  "components/chrome/getting-started.tsx", // ambient checklist pill; hides itself on any failure
  "pages/library/connect-nudge.tsx", // ambient activation card; hides itself on any failure
  "pages/artifact/artifact-breadcrumb.tsx", // collections/siblings reads degrade to the title (no switcher)
  "pages/artifact/share-dialog.tsx", // reads the warm artifact cache (enabled:false)
  "pages/artifact/header-actions.tsx", // move-menu dropdown, warm read
  "pages/library/quick-organize.tsx", // reads the cached artifact row
  "pages/settings/index.tsx", // reports query drives a nav badge; hide-on-fail, non-critical
])

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
    else if (/\.tsx?$/.test(name) && !/\.(test|gen)\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

// The config object handed to `createFileRoute(...)( { … } )` — the second call's arg.
const routeConfig = (src) => {
  let found
  const visit = (node) => {
    if (
      !found &&
      ts.isCallExpression(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText() === "createFileRoute" &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      found = node.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return found
}
const propNames = (obj) =>
  new Set(obj.properties.map((p) => (p.name ? p.name.getText() : "")).filter(Boolean))

const checkA = () => {
  const out = []
  for (const file of walk(join(WEB_SRC, "routes"))) {
    const rel = relative(WEB_SRC, file)
    if (ROUTE_ALLOW.has(rel)) continue
    const cfg = routeConfig(parse(file))
    if (!cfg) continue
    const props = propNames(cfg)
    if (props.has("loader") && !props.has("pendingComponent"))
      out.push({ rel, kind: "loading", msg: "route has a data loader but no pendingComponent" })
  }
  return out
}

// A file that renders a query but never references `isError`.
const usesQuery = (src) => {
  let hit = false
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      /^use(Infinite|Suspense)?Query$/.test(node.expression.getText())
    )
      hit = true
    if (!hit) ts.forEachChild(node, visit)
  }
  visit(src)
  return hit
}

// A file HANDLES a query's error if it REFERENCES `isError`/`isLoadingError` (a destructured
// var, or a `.isError` access) or destructures `error` from a query result (the console's
// pattern). AST identifiers ONLY — a comment or string that merely mentions "isError" must
// not count, or a file could pass by talking about error handling without doing it.
const handlesError = (src) => {
  let found = false
  const visit = (node) => {
    if (ts.isIdentifier(node) && (node.text === "isError" || node.text === "isLoadingError"))
      found = true
    else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      /^use(Infinite|Suspense)?Query$/.test(node.initializer.expression.getText()) &&
      node.name &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some((e) => (e.propertyName ?? e.name).getText() === "error")
    )
      found = true
    if (!found) ts.forEachChild(node, visit)
  }
  visit(src)
  return found
}

const checkB = () => {
  const out = []
  for (const root of ["pages", "components"]) {
    for (const file of walk(join(WEB_SRC, root))) {
      if (!file.endsWith(".tsx")) continue
      const rel = relative(WEB_SRC, file)
      if (QUERY_ALLOW.has(rel)) continue
      const text = readFileSync(file, "utf8")
      if (text.includes("surface-ignore")) continue
      const src = parse(file)
      if (usesQuery(src) && !handlesError(src))
        out.push({ rel, kind: "error", msg: "reads a query but never handles its error" })
    }
  }
  return out
}

const violations = [...checkA(), ...checkB()]

if (violations.length === 0) {
  console.log("surfaces: ok — every data route has a pending frame; every query handles error")
  process.exit(0)
}

const byKind = (k) => violations.filter((v) => v.kind === k)
console.error(`surfaces: ${violations.length} read-side gap(s)\n`)
for (const v of byKind("loading")) console.error(`  [loading] apps/web/src/${v.rel} — ${v.msg}`)
for (const v of byKind("error")) console.error(`  [error]   apps/web/src/${v.rel} — ${v.msg}`)
console.error(
  `\n  [loading] add a shape-matched pendingComponent to the route (see routes/index.tsx).\n` +
    `  [error]   read isError from the query and render a StatusPanel(tone="danger")+retry\n` +
    `            (see pages/library/index.tsx). Ambient/warm-cache reads go in QUERY_ALLOW;\n` +
    `            a one-off gets a "surface-ignore" comment with a reason.`,
)
process.exit(1)
