/**
 * Skill + markdown-bundle support. A Claude Code "skill" is a folder — a `SKILL.md`
 * (with YAML frontmatter declaring `name`/`description`) plus optional `scripts/`,
 * `references/`, `assets/` — published to Derive as a bundle. More generally, any
 * bundle whose entry is markdown (a docs folder) gets the same treatment: rendered
 * pages plus a navigable file tree. These helpers let Derive recognize such bundles
 * and read frontmatter, with NO new artifact kind and no heavy YAML dependency
 * (this module must run on Cloudflare Workers).
 */
import type { BundleManifest, SkillRelationKind } from "./ports"
import { validateWorkflowDefinition, type WorkflowDefinition } from "./workflow"

export const SKILL_SIDECAR_PATH = "/derive.skill.json"
export const SKILL_DEFINITION_SCHEMA = "derive.skill/v1" as const

export type SkillRuntimeKind = "single" | "graph" | "loop"

export interface SkillRelationRef {
  id: string
  version: number
}

export interface SkillSidecar {
  schema: typeof SKILL_DEFINITION_SCHEMA
  /** Whether this definition appears in the workspace Skills catalog. */
  catalog?: boolean
  relations?: Partial<Record<SkillRelationKind, SkillRelationRef[]>>
  runtime?: { kind: "single" } | { kind: "graph" | "loop"; definition: WorkflowDefinition }
}

export interface SkillDefinitionValidation {
  metadata: { name: string | null; description: string | null; compatibility: string | null }
  sidecar: SkillSidecar | null
  errors: string[]
  warnings: string[]
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const relationKinds: readonly SkillRelationKind[] = ["requires", "extends", "recommends"]

/** Validate the portable Agent Skills contract plus Derive's optional typed sidecar. */
export const validateSkillDefinition = (
  skillMd: string,
  sidecarSource?: string | null,
): SkillDefinitionValidation => {
  const attrs = parseFrontmatter(skillMd).attrs
  const name = attrs.name?.trim() || null
  const description = attrs.description?.trim() || null
  const compatibility = attrs.compatibility?.trim() || null
  const errors: string[] = []
  const warnings: string[] = []

  if (!name) errors.push("SKILL.md frontmatter requires name")
  else {
    if (name.length > 64) errors.push("SKILL.md name must be at most 64 characters")
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      errors.push("SKILL.md name must use lowercase letters, numbers, and single hyphens")
  }
  if (!description) errors.push("SKILL.md frontmatter requires description")
  else if (description.length > 1024)
    errors.push("SKILL.md description must be at most 1024 characters")
  if (compatibility && compatibility.length > 500)
    errors.push("SKILL.md compatibility must be at most 500 characters")

  if (!sidecarSource) {
    return { metadata: { name, description, compatibility }, sidecar: null, errors, warnings }
  }

  let raw: unknown
  try {
    raw = JSON.parse(sidecarSource)
  } catch {
    errors.push("derive.skill.json must be valid JSON")
    return { metadata: { name, description, compatibility }, sidecar: null, errors, warnings }
  }
  if (!object(raw)) {
    errors.push("derive.skill.json must be an object")
    return { metadata: { name, description, compatibility }, sidecar: null, errors, warnings }
  }
  if (raw.schema !== SKILL_DEFINITION_SCHEMA)
    errors.push(`derive.skill.json schema must be "${SKILL_DEFINITION_SCHEMA}"`)
  if (raw.catalog !== undefined && typeof raw.catalog !== "boolean")
    errors.push("derive.skill.json catalog must be boolean")

  const relations: Partial<Record<SkillRelationKind, SkillRelationRef[]>> = {}
  if (raw.relations !== undefined) {
    if (!object(raw.relations)) errors.push("derive.skill.json relations must be an object")
    else {
      for (const kind of relationKinds) {
        const list = raw.relations[kind]
        if (list === undefined) continue
        if (!Array.isArray(list)) {
          errors.push(`derive.skill.json relations.${kind} must be an array`)
          continue
        }
        const parsed: SkillRelationRef[] = []
        const seen = new Set<string>()
        for (const [index, item] of list.entries()) {
          if (
            !object(item) ||
            typeof item.id !== "string" ||
            !item.id.trim() ||
            !Number.isInteger(item.version) ||
            Number(item.version) < 1
          ) {
            errors.push(`derive.skill.json relations.${kind}[${index}] needs id and version`)
            continue
          }
          const ref = { id: item.id.trim(), version: Number(item.version) }
          const key = `${ref.id}@${ref.version}`
          if (seen.has(key)) {
            warnings.push(`duplicate ${kind} relation ${key} was ignored`)
            continue
          }
          seen.add(key)
          parsed.push(ref)
        }
        relations[kind] = parsed
      }
    }
  }

  let runtime: SkillSidecar["runtime"]
  if (raw.runtime !== undefined) {
    if (!object(raw.runtime)) errors.push("derive.skill.json runtime must be an object")
    else if (raw.runtime.kind === "single") runtime = { kind: "single" }
    else if (raw.runtime.kind === "graph" || raw.runtime.kind === "loop") {
      const checked = validateWorkflowDefinition(raw.runtime.definition, null, {
        allowUnlinked: true,
      })
      errors.push(...checked.errors.map((error) => `derive.skill.json runtime: ${error}`))
      warnings.push(...checked.warnings.map((warning) => `derive.skill.json runtime: ${warning}`))
      if (checked.definition) {
        const loops = checked.definition.diagrams.flatMap((diagram) => diagram.loops ?? [])
        if (raw.runtime.kind === "graph" && loops.length > 0)
          errors.push("derive.skill.json graph runtime cannot declare loops")
        if (raw.runtime.kind === "loop" && loops.length === 0)
          errors.push("derive.skill.json loop runtime must declare at least one bounded loop")
        runtime = { kind: raw.runtime.kind, definition: checked.definition }
      }
    } else errors.push('derive.skill.json runtime.kind must be "single", "graph", or "loop"')
  }

  return {
    metadata: { name, description, compatibility },
    sidecar:
      errors.length === 0
        ? {
            schema: SKILL_DEFINITION_SCHEMA,
            ...(typeof raw.catalog === "boolean" ? { catalog: raw.catalog } : {}),
            ...(Object.keys(relations).length > 0 ? { relations } : {}),
            ...(runtime ? { runtime } : {}),
          }
        : null,
    errors,
    warnings,
  }
}

export const skillCatalogEnabled = (sidecar: SkillSidecar | null): boolean =>
  sidecar?.catalog !== false

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
