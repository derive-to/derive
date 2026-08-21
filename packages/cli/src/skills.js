// Materializing Derive skill bundles (and Brandprint notes) onto disk. Shared by the
// context runner (boot: pull the workspace Brandprint + the manifest's pinned skills
// into .claude/skills/, where the spawned claude auto-discovers them) and the CLI
// (`derive skill add` / `derive brandprint pull` into a repo). Pure of any Derive
// client: callers pass a small `api` of three fetchers, so this module is unit-testable
// against a mock and stays free of the @derive/core dependency (the CLI is standalone).
//
// The `api` contract (all keyed by short id + version):
//   outline(id, version)  → { entry, pages: [{ path, type }] }   (bundle file tree)
//   file(id, path, version) → bytes | string                     (one bundle file, raw)
//   content(id, version)  → string                               (a single-file doc's source)
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Read the frontmatter `name:` from a SKILL.md. Dependency-free (the CLI can't import
 *  @derive/core's parseFrontmatter) and deliberately minimal: the leading `--- … ---`
 *  block, first top-level `name:` scalar, quotes trimmed. null when absent. */
export function skillNameFrom(skillMd) {
  const s = String(skillMd ?? "")
  const m = s.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s/.test(line)) continue // nested/indented — top-level scalars only
    const kv = line.match(/^name:\s*(.+)$/)
    if (kv) return kv[1].trim().replace(/^["']|["']$/g, "") || null
  }
  return null
}

/** A filesystem-safe directory/file stem. null when nothing usable survives. */
export function skillSlug(name) {
  const s = String(name ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return s || null
}

/** Fetch one skill version's files WITHOUT writing them (so a caller can resolve a
 *  collision-free directory name across the whole set before touching disk). Returns
 *  { name, entry, files: Map<path, bytes> }; throws if the version has no readable tree.
 *
 *  A pinned entry fetches its exact version. An unpinned one (version null) serves the
 *  artifact's current version. */
export async function fetchSkill(api, { id, version }) {
  const fetchAt = async (v) => {
    const outline = await api.outline(id, v)
    const pages = outline?.pages ?? []
    if (pages.length === 0) throw new Error("no files in this version")
    const entry = String(outline.entry ?? "SKILL.md").replace(/^\//, "")
    const files = new Map()
    for (const p of pages) {
      const path = String(p.path).replace(/^\//, "")
      files.set(path, await api.file(id, path, v))
    }
    return { name: skillNameFrom(files.get(entry)), entry, files }
  }
  return fetchAt(version ?? null)
}

/** Write a fetched skill under destRoot/<dir>/. A skills dir is DERIVED state (like the
 *  runner's repos/), so it's replaced wholesale, never merged — a removed file at the
 *  source must not linger on disk. */
export function writeSkill(destRoot, dir, files) {
  const root = join(destRoot, dir)
  rmSync(root, { recursive: true, force: true })
  for (const [path, bytes] of files) {
    const dest = join(root, path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, bytes)
  }
}

/** Merge the ambient Brandprint skill layer with the manifest's own `skills:` into one
 *  deduped list. A skill named in BOTH must materialize ONCE (not twice under a collided
 *  dir); the manifest pin wins — it's the deliberate, context-specific choice over the
 *  ambient default. Order follows first appearance (Brandprint, then new manifest ids). */
export function mergeSkillLayers(brandprintSkills, manifestSkills) {
  const byId = new Map()
  for (const s of [...brandprintSkills, ...manifestSkills]) byId.set(s.id, s)
  return [...byId.values()]
}

/** Materialize a set of pinned skills into destRoot, deduping directory names by short
 *  id (two skills whose frontmatter name collides get `<name>-<id>`). A failed skill is
 *  loud but NON-fatal — the runner still answers and the catalog marks it unavailable,
 *  exactly the syncRepos posture. Returns the catalog. */
export async function materializeSkills(api, skills, destRoot) {
  const used = new Set()
  const out = []
  for (const s of skills) {
    try {
      const { name, files } = await fetchSkill(api, s)
      const base = skillSlug(name) ?? s.id
      const dir = used.has(base) ? `${base}-${s.id}` : base
      used.add(dir)
      writeSkill(destRoot, dir, files)
      out.push({ id: s.id, version: s.version, dir, name: name ?? dir, ok: true })
      console.log(`[skills] ${dir} @v${s.version}`)
    } catch (e) {
      console.error(`[skills] ${s.id}: ${e?.message ?? e}`)
      out.push({ id: s.id, version: s.version, ok: false })
    }
  }
  return out
}

/** Materialize Brandprint prose notes (single-file convention docs — not skills) into
 *  destRoot as <slug>.md, so the runner can point the model at them. Non-fatal per note. */
export async function materializeNotes(api, notes, destRoot) {
  const out = []
  for (const n of notes) {
    try {
      const body = await api.content(n.short_id, n.version)
      const slug = skillSlug(n.title) ?? n.short_id
      const dest = join(destRoot, `${slug}.md`)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, body)
      out.push({
        short_id: n.short_id,
        title: n.title,
        file: `${destRoot.split("/").at(-1)}/${slug}.md`,
        ok: true,
      })
    } catch (e) {
      console.error(`[notes] ${n.short_id}: ${e?.message ?? e}`)
      out.push({ short_id: n.short_id, ok: false })
    }
  }
  return out
}

/** Pin unpinned `skills:` entries in a manifest's frontmatter by inserting a concrete
 *  `version:` line after each `- id:` — lockfile semantics, so the pushed manifest is
 *  deterministic and the diff IS the upgrade record. `versions` is a Map<id, number> of
 *  the pins to apply (an already-pinned entry isn't in it, so it's left untouched). Pure
 *  string surgery on the frontmatter block: it never reflows the author's manifest, only
 *  splices a line under each named id. Returns { text, pinned:[{id, version}] }. */
export function pinManifestSkills(text, versions) {
  if (!versions || versions.size === 0) return { text, pinned: [] }
  const fm = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (!fm) return { text, pinned: [] }
  const pinned = []
  const out = []
  for (const line of fm[2].split(/\r?\n/)) {
    out.push(line)
    const m = line.match(/^(\s*)-\s+id:\s*(["']?)([A-Za-z0-9_-]+)\2\s*$/)
    if (m && versions.has(m[3])) {
      const version = versions.get(m[3])
      out.push(`${m[1]}  version: ${version}`)
      pinned.push({ id: m[3], version })
    }
  }
  return { text: fm[1] + out.join("\n") + fm[3] + text.slice(fm[0].length), pinned }
}

/** The prompt block naming the conventions on disk (mirrors repoCatalogBlock). Skills in
 *  .claude/skills/ are auto-discovered by the spawned claude, but naming them — and the
 *  notes, which are NOT auto-discovered — is the honest "what's on disk" the model reads,
 *  and an unavailable one is stated outright rather than silently missing. */
export function conventionsBlock(skills, notes) {
  const lines = []
  for (const s of skills)
    lines.push(
      s.ok
        ? `- .claude/skills/${s.dir} — skill "${s.name}" @v${s.version}`
        : `- skill ${s.id} — UNAVAILABLE this run (fetch failed); say so if an answer would need it`,
    )
  for (const n of notes) if (n.ok) lines.push(`- ${n.file} — ${n.title ?? "convention note"}`)
  if (lines.length === 0) return ""
  return `\n\n## Conventions (materialized into your working directory)\n\n${lines.join("\n")}`
}
