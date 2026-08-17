/**
 * Skill + markdown-bundle support. A Claude Code "skill" is a folder — a `SKILL.md`
 * (with YAML frontmatter declaring `name`/`description`) plus optional `scripts/`,
 * `references/`, `assets/` — published to Derive as a bundle. More generally, any
 * bundle whose entry is markdown (a docs folder) gets the same treatment: rendered
 * pages plus a navigable file tree. These helpers let Derive recognize such bundles
 * and read frontmatter, with NO new artifact kind and no heavy YAML dependency
 * (this module must run on Cloudflare Workers).
 */
import type { BundleManifest } from "./ports"

/** A bundle whose entry document is a root `SKILL.md` is a skill. `pickBundleEntry`
 *  selects `/SKILL.md` as the entry for an HTML-less folder that contains one. */
export const isSkillBundle = (manifest: BundleManifest): boolean =>
  manifest.entry.toLowerCase() === "/skill.md"

/** A bundle whose entry document is markdown — a skill, or any docs folder (README
 *  / shallowest .md). These render through the markdown path and earn a file tree. */
export const isMarkdownBundle = (manifest: BundleManifest): boolean =>
  /\.(md|markdown)$/i.test(manifest.entry)

export interface Frontmatter {
  /** Flat top-level `key: value` scalars from the leading `--- ... ---` block. */
  attrs: Record<string, string>
  /** The markdown with the frontmatter block stripped. */
  body: string
}

// Leading `--- … ---` block; trailing blank lines after the closing fence are
// consumed so the body starts at the first real content line.
const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)*/

/**
 * Split a leading YAML frontmatter block off a markdown source and read its flat
 * `key: value` pairs. No block ⇒ empty attrs + the unchanged source. Deliberately
 * minimal — top-level scalar keys only (what a skill declares: name, description,
 * version, …), surrounding quotes trimmed, indented/nested lines skipped. Never
 * throws; a malformed block just yields whatever pairs parse.
 */
export const parseFrontmatter = (src: string): Frontmatter => {
  const m = FRONTMATTER_RE.exec(src)
  if (!m) return { attrs: {}, body: src }
  const attrs: Record<string, string> = {}
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    if (!line.trim() || /^[ \t]/.test(line)) continue // blank, or nested/indented
    const i = line.indexOf(":")
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    let val = line.slice(i + 1).trim()
    const q = val[0]
    if (val.length >= 2 && (q === '"' || q === "'") && val.at(-1) === q) val = val.slice(1, -1)
    if (key) attrs[key] = val
  }
  return { attrs, body: src.slice(m[0].length) }
}

/** A markdown bundle's public shape for the artifact API: the entry + file tree so a
 *  client can render the doc and navigate siblings, plus skill identity when it is one.
 *  `isSkill` gates the "Skill" badge; `name`/`description` come from SKILL.md
 *  frontmatter and are null for a plain docs bundle (or when the frontmatter omits them). */
export interface BundleDoc {
  isSkill: boolean
  name: string | null
  description: string | null
  /** Entry document path, sans leading slash (e.g. "SKILL.md", "README.md"). */
  entry: string
  /** Every bundle file, paths sans leading slash, sorted. */
  files: { path: string; type: string }[]
}

export const bundleDoc = (manifest: BundleManifest, entrySource: string | null): BundleDoc => {
  const isSkill = isSkillBundle(manifest)
  // Only a skill carries declared identity in frontmatter; a docs bundle has none.
  const attrs = isSkill && entrySource ? parseFrontmatter(entrySource).attrs : {}
  return {
    isSkill,
    name: attrs.name || null,
    description: attrs.description || null,
    entry: manifest.entry.replace(/^\//, ""),
    files: Object.entries(manifest.files)
      .map(([path, f]) => ({ path: path.replace(/^\//, ""), type: f.type }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  }
}

/** The always-loaded instructions pointer for workspace skills. One short sentence —
 *  it rides the MCP instructions, which are budget-tested (mcp-surface-budget) with a
 *  skill published, so the count-bearing variant is the one the budget measures. The
 *  count arrives from a limit-100 listing, so 100 reads as "100 or more". */
export const workspaceSkillsInstructions = (count: number): string =>
  count > 0
    ? `${count === 100 ? "100+" : count} team skill${count === 1 ? "" : "s"} here — read derive://skills for the catalog. `
    : `Team skills: read derive://skills for the catalog. `
