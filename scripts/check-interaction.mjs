#!/usr/bin/env node
// Interaction-state guardrail. Two rules, both from bugs that shipped.
//
// A. A SELECTED STATE MUST NOT LOSE TO HOVER. Tailwind compiles `data-active:bg-x`
//    to `.data-active\:bg-x:where([data-active]:not([data-active=false]))` — the
//    `:where()` contributes zero specificity, so the rule is (0,1,0), while
//    `hover:bg-y` is `.hover\:bg-y:hover` at (0,2,0). Hover wins on specificity, so
//    no ordering saves you. The sidebar shipped like this and repainted the current
//    page's raised chip with the idle-row grey the moment you pointed at it.
//    Write the hover scoped instead — `not-data-active:hover:bg-y` — or, when the
//    state is a JS boolean, put the hover in the else branch of the ternary.
//
// B. "REVEAL ON HOVER" HAS ONE SPELLING. It has to answer keyboard focus, touch,
//    and reduced motion as well as hover; hand-written copies got a different one
//    of those wrong each time (five call sites, four spellings, one of which never
//    revealed at all on a touch device). Use REVEAL / reveal() / REVEAL_MENU /
//    revealInFolder from lib/interaction.ts.
//
// C. MOTION COMES FROM A TOKEN. `duration-state` (feedback: a hover, a control
//    fading in, a menu opening) or `duration-move` (something that travels a
//    distance you can see — the rail collapsing), both defined in globals.css. A
//    hand-picked `duration-200` is how the app ended up with the rail responding at
//    one speed and everything it sits next to at another.
//
// Escape hatch: an `interaction-ignore` comment on the line.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const WEB_SRC = join(process.cwd(), "apps/web/src")
// Where the canonical spellings are allowed to live.
const REGISTER = "lib/interaction.ts"

// Rule C exemptions — timings that aren't UI state and shouldn't be pulled toward
// it. Remote-cursor smoothing is paced by network sampling, and a progress bar eases
// between percentages rather than between states.
const RAW_DURATION_OK = new Set([
  "pages/artifact/cursors/cursor-layer.tsx",
  "pages/settings/github-repo-row.tsx",
  "components/chrome/sync-chip.tsx",
])

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== "dist") walk(full, out)
    } else if (/\.tsx?$/.test(name) && !/\.gen\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

// A class string is one quoted run. Checking per-string (not per-line) keeps a
// `hover:` in the else branch of a ternary from being read as competing with an
// active state declared in the other branch — that form is correct.
const STRINGS = /(["'`])((?:[^\\\n]|\\.)*?)\1/g

const violations = []
for (const file of walk(WEB_SRC)) {
  const rel = relative(WEB_SRC, file)
  if (rel === REGISTER) continue
  const src = readFileSync(file, "utf8")
  const lines = src.split("\n")

  lines.forEach((line, i) => {
    if (line.includes("interaction-ignore")) return
    const code = line.replace(/\/\/.*$/, "")
    for (const [, , body] of code.matchAll(STRINGS)) {
      // A. bare `hover:bg-*` sharing a class string with a `data-active`/`data-[active…]`
      //    background. `not-data-active:hover:` is the fix, so it must not trip.
      const hasActiveBg = /\bdata-(?:active|\[active[^\]]*\]):bg-/.test(body)
      const bareHoverBg = /(?:^|\s)hover:bg-/.test(body)
      if (hasActiveBg && bareHoverBg)
        violations.push(
          `${rel}:${i + 1}  hover:bg-* loses to data-active:bg-* on specificity — ` +
            `scope it (not-data-active:hover:bg-*) so the selected state survives the pointer`,
        )

      // C. a hand-picked duration.
      if (!RAW_DURATION_OK.has(rel))
        for (const [, d] of body.matchAll(/\bduration-(\d+)\b/g))
          violations.push(
            `${rel}:${i + 1}  duration-${d} — use duration-state (feedback) or ` +
              `duration-move (travel); both are tokens in styles/globals.css`,
          )

      // B. a hand-rolled reveal.
      if (
        /\bopacity-0\b/.test(body) &&
        /group-(?:hover|focus-within)[/\w-]*:opacity-100/.test(body)
      )
        violations.push(
          `${rel}:${i + 1}  hand-spelled reveal-on-hover — use REVEAL / reveal() from lib/interaction.ts`,
        )
    }
  })
}

if (violations.length) {
  console.error("check-interaction: found issues\n")
  for (const v of violations) console.error(`  ${v}`)
  console.error(`\n${violations.length} issue(s). See apps/web/src/lib/interaction.ts.`)
  process.exit(1)
}
console.log("check-interaction: ok — selected states outrank hover, one reveal, motion from tokens")
