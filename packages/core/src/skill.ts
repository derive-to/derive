/**
 * Skill support. A Claude Code "skill" is a folder — a `SKILL.md` (with YAML
 * frontmatter declaring `name`/`description`) plus optional `scripts/`,
 * `references/`, `assets/` — published to Dock as a bundle. These helpers let Dock
 * recognize such a bundle and read its frontmatter, with NO new artifact kind and
 * no heavy YAML dependency (this module must run on Cloudflare Workers).
 */
import type { BundleManifest } from "./ports"

/** A bundle whose entry document is a root `SKILL.md` is a skill. `pickBundleEntry`
 *  selects `/SKILL.md` as the entry for an HTML-less folder that contains one. */
export const isSkillBundle = (manifest: BundleManifest): boolean =>
  manifest.entry.toLowerCase() === "/skill.md"

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

/** A skill's public shape for the artifact API: its declared identity plus the
 *  files in the bundle, so a client can render the doc + a file tree. `name` /
 *  `description` are null when the frontmatter omits them. */
export interface SkillInfo {
  name: string | null
  description: string | null
  /** Entry document path, sans leading slash (e.g. "SKILL.md"). */
  entry: string
  /** Every bundle file, paths sans leading slash, sorted. */
  files: { path: string; type: string }[]
}

export const skillInfo = (manifest: BundleManifest, entrySource: string | null): SkillInfo => {
  const attrs = entrySource ? parseFrontmatter(entrySource).attrs : {}
  return {
    name: attrs.name || null,
    description: attrs.description || null,
    entry: manifest.entry.replace(/^\//, ""),
    files: Object.entries(manifest.files)
      .map(([path, f]) => ({ path: path.replace(/^\//, ""), type: f.type }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  }
}
