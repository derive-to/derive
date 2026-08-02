#!/usr/bin/env node
// The `helping` skill tells people where things are in the app: "Settings › Members" is
// /settings/members, the library is /, a document is /artifacts/{short_id}. That is the one
// kind of documentation that goes wrong SILENTLY — rename a route and the skill keeps confidently
// sending people to a 404, in an agent's voice, which reads as the app being broken rather than
// the doc being stale.
//
// So the paths are checked, not trusted. Every in-app path the skill names must resolve to a real
// route in the generated route tree, and every /settings/<section> must be a section the settings
// nav actually renders. Rename a route without updating the skill and the build fails here.
//
// Deliberate scope: this proves the DESTINATION exists, not that the prose about it is true. A
// wrong sentence pointed at a real screen is still a wrong sentence, and no script catches that.
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()
const SKILL = join(ROOT, "apps/api/src/skills/helping.md")
const ROUTE_TREE = join(ROOT, "apps/web/src/routeTree.gen.ts")
const SETTINGS = join(ROOT, "apps/web/src/pages/settings/index.tsx")

const skill = readFileSync(SKILL, "utf8")

// Every route the app actually serves, as authored in the generated tree ("/", "/settings",
// "/artifacts/$ref", …). Parameterised segments stay as `$name` and are matched structurally
// below, so the skill may write a placeholder without naming a real id.
const routes = new Set(
  [...readFileSync(ROUTE_TREE, "utf8").matchAll(/path: '([^']*)'/g)].map((m) => m[1]),
)
// The settings sections the nav renders, which is what /settings/<section> has to hit. Read from
// the nav's own item ids rather than a second list here — a section added or renamed there moves
// this check with it.
const sections = new Set(
  [...readFileSync(SETTINGS, "utf8").matchAll(/\{\s*id:\s*"([a-z-]+)",\s*label:/g)].map(
    (m) => m[1],
  ),
)

/** A path from the skill, as the app would resolve it. */
const resolves = (path) => {
  if (routes.has(path)) return true
  const parts = path.split("/").filter(Boolean)
  // /settings/<section> is a real route ($section) plus a real section id.
  if (parts[0] === "settings" && parts.length === 2) return sections.has(parts[1])
  // One-segment placeholders (/artifacts/{short_id}, /users/{handle}) match a $param route.
  if (parts.length === 2 && /^\{.+\}$/.test(parts[1]))
    return (
      routes.has(`/${parts[0]}/$ref`) ||
      routes.has(`/${parts[0]}/$handle`) ||
      routes.has(`/${parts[0]}/$id`) ||
      routes.has(`/${parts[0]}/$token`)
    )
  return false
}

// Paths as the skill writes them: in a link target, in a table cell, or inline in backticks.
// Anchored on a leading slash and stopped at whitespace/backtick/paren, so prose like "the /
// library" is not mistaken for a route.
const cited = new Set()
for (const m of skill.matchAll(/`(\/[^`\s]*)`/g)) cited.add(m[1])
for (const m of skill.matchAll(/\]\((\/[^)\s]*)\)/g)) cited.add(m[1])

const bad = [...cited].filter((p) => !resolves(p))
if (bad.length) {
  console.error(
    `check-app-map: the helping skill names ${bad.length} path(s) the app does not serve:\n` +
      bad.map((p) => `  ${p}`).join("\n") +
      `\n\nFix apps/api/src/skills/helping.md, or the route it points at.`,
  )
  process.exit(1)
}

// A map with no paths in it would pass every check above while telling nobody anything, so the
// guard also asserts the skill is still doing its job.
if (cited.size < 20) {
  console.error(
    `check-app-map: only ${cited.size} in-app paths in the helping skill — that map has lost its point.`,
  )
  process.exit(1)
}

console.log(`check-app-map: ok — ${cited.size} in-app paths in the helping skill all resolve`)
