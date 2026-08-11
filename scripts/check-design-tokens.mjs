#!/usr/bin/env node
// Design-token guardrail. Colors and text sizes must come from the token system
// — apps/web/src/styles/globals.css (the @theme scale + the [data-theme] palette,
// surfaced as utilities like text-foreground / bg-card / text-sm). Nothing in a
// component should hardcode a hex, an rgb()/hsl(), a raw Tailwind palette color
// (bg-red-500), an arbitrary color (bg-[#abc]), or an absolute font size
// (text-[14px], style fontSize). Runs in CI so the migration can't silently
// regress. Escape hatch: put `tokens-ignore` in a comment on the line.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const WEB_SRC = join(process.cwd(), "apps/web/src")

// The one place raw colors + sizes legitimately live: the token definitions.
const TOKEN_SOURCE = new Set(["styles/globals.css", "styles.css"])

// Files that carry raw color DATA, not theming — avatar identity tints are a
// fixed categorical palette, and the theme picker must show each theme's literal
// swatch color. These are the "right places" for a raw color. The live-cursor
// files are the same shape: a peer's identity tint (derived from their name) and
// the fixed white keyline / lift shadow painted onto the multiplayer overlay.
const ALLOW_FILES = new Set([
  "lib/avatar-tints.ts",
  "ctx.tsx",
  "pages/artifact/cursors/glyph.tsx",
  "pages/artifact/cursors/cursor-layer.tsx",
  // A self-contained HTML document published as an artifact, not app UI — its
  // colors ship inside the document and can't reference the token system.
  "pages/brandprint/profile-placeholder.ts",
  // Self-contained built-in template source: the literal colors are published
  // inside user artifacts and cannot reference the app's runtime token system.
  "pages/templates/template-content.ts",
])

const PALETTE =
  "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)"
const COLOR_UTIL =
  "(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|caret|accent)"

// Each rule: a regex over a code line (comments + shadow utilities already
// stripped) and the fix to point people at.
const RULES = [
  {
    re: /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/,
    msg: "hardcoded hex color — use a semantic token (text-foreground, bg-card, …)",
  },
  { re: /\b(?:rgb|rgba|hsl|hsla)\(/, msg: "hardcoded color function — use a semantic token" },
  {
    re: new RegExp(`${COLOR_UTIL}-\\[(?:#|rgb|hsl|--color)`),
    msg: "arbitrary color utility — use a semantic token (bg-primary, text-muted-foreground, …)",
  },
  {
    re: /\[(?:color|fill|stroke|background|background-color|border-color|outline-color|caret-color):/,
    msg: "arbitrary color property — use a semantic token",
  },
  {
    re: new RegExp(`\\b${COLOR_UTIL}-${PALETTE}-(?:50|100|200|300|400|500|600|700|800|900|950)\\b`),
    msg: "raw Tailwind palette color bypasses theming — use a semantic token",
  },
  {
    re: /text-\[[^\]]*\d*\.?\d+(?:px|rem|pt|vh|vw|vmin|vmax|cm|mm|in|pc|q)\b/,
    msg: "arbitrary font size — use the scale (text-2xs … text-3xl)",
  },
  {
    re: /\bfontSize\s*:\s*["'0-9]/,
    msg: "hardcoded fontSize — use a text-* scale class, or a computed expression",
  },
]

const stripIgnorable = (line) =>
  line
    // line + block comments (colors there aren't applied; avoid false positives)
    .replace(/\/\/.*$/, "")
    .replace(/\/\*.*?\*\//g, "")
    // box-shadow / drop-shadow are elevation, not palette — rgba(0,0,0,…) is fine
    .replace(/(?:drop-)?shadow-\[[^\]]*\]/g, "")

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue
      walk(full, out)
    } else if (/\.(?:tsx?|css)$/.test(name) && !/\.gen\.(?:tsx?|css)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

const violations = []
for (const file of walk(WEB_SRC)) {
  const rel = relative(WEB_SRC, file)
  // components/ui/** is vendored stock shadcn (installed via the CLI) — it's not
  // app-authored code, so it's held to shadcn's conventions (e.g. an occasional
  // arbitrary text size), not derive's token guardrail.
  if (TOKEN_SOURCE.has(rel) || ALLOW_FILES.has(rel) || rel.startsWith("components/ui/")) continue
  const lines = readFileSync(file, "utf8").split("\n")
  lines.forEach((raw, i) => {
    if (raw.includes("tokens-ignore")) return
    const line = stripIgnorable(raw)
    for (const rule of RULES) {
      const m = rule.re.exec(line)
      if (m) violations.push({ rel, line: i + 1, col: m.index + 1, snippet: m[0], msg: rule.msg })
    }
  })
}

if (violations.length === 0) {
  console.log("design-tokens: ok — no hardcoded colors or text sizes in apps/web/src")
  process.exit(0)
}

console.error(
  `design-tokens: ${violations.length} violation(s) — colors and text sizes must come from globals.css tokens\n`,
)
for (const v of violations) {
  console.error(`  apps/web/src/${v.rel}:${v.line}:${v.col}  ${v.snippet}`)
  console.error(`    → ${v.msg}`)
}
console.error("\n  The token system lives in apps/web/src/styles/globals.css.")
console.error("  Legitimate raw-color data (a logo, an identity palette) goes in an allow-listed")
console.error("  file or carries a `tokens-ignore` comment on the line.")
process.exit(1)
