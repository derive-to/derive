// Stale skill-pin detection for context manifests. A manifest's frontmatter pins
// the skills a run materializes (`skills:` — id + version), which is the right
// versioning model: a skill edit doesn't silently change what runs. The cost is
// manual bookkeeping — publish skill v(N+1), forget the pin bump, and every run
// quietly executes vN with nothing pointing at the gap. This module parses the
// pins server-side (mirroring the runner's own narrow frontmatter rules: only the
// `skills:` list, unquote, ignore everything else) and reports pins that trail
// the pinned artifact's current version, so the pull that is about to execute the
// manifest can SAY so.
import type { MetaStore } from "@derive/core"

export interface SkillPin {
  id: string
  /** The pinned version; null = unpinned (the runner fetches current — never stale). */
  version: number | null
}

export interface StalePin {
  short_id: string
  pinned: number
  current: number
}

export interface ManifestRepo {
  url: string
  ref: string | null
}

/** Parse the `skills:` list out of a manifest's YAML-ish frontmatter. Deliberately
 *  narrow, mirroring the runner's parseManifest: a `- id:` item optionally followed
 *  by indented `version:`; a top-level key closes the list; no frontmatter or no
 *  list ⇒ []. Never throws. */
export const parseManifestSkillPins = (md: string): SkillPin[] => {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return []
  const unquote = (v: string): string => {
    const t = v.trim()
    const q = t[0]
    return t.length >= 2 && (q === '"' || q === "'") && t.at(-1) === q ? t.slice(1, -1) : t
  }
  const pins: SkillPin[] = []
  let inSkills = false
  let cur: SkillPin | null = null
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    if (/^skills:\s*$/.test(line)) {
      inSkills = true
      continue
    }
    if (inSkills && /^\S/.test(line)) inSkills = false // next top-level key
    if (!inSkills) continue
    const item = line.match(/^\s*-\s+(\w+):\s*(.+)$/)
    const kv = line.match(/^\s+(\w+):\s*(.+)$/)
    if (item) {
      cur = null
      if (item[1] === "id") {
        cur = { id: unquote(item[2] as string), version: null }
        pins.push(cur)
      }
    } else if (kv && cur && kv[1] === "version") {
      const n = Number(kv[2])
      cur.version = Number.isFinite(n) ? n : null
    }
  }
  return pins.filter((p) => p.id)
}

/** Which of these pins trail their artifact's current version. An unpinned entry
 *  and an unresolvable short_id are both skipped (unpinned can't be stale; a bad
 *  id is the manifest author's separate problem, and this check must never turn a
 *  claim into an error). */
export const stalePins = async (meta: MetaStore, pins: SkillPin[]): Promise<StalePin[]> => {
  const out: StalePin[] = []
  for (const pin of pins) {
    if (pin.version === null) continue
    const a = await meta.getByShortId(pin.id).catch(() => null)
    if (a && a.current_version > pin.version)
      out.push({ short_id: pin.id, pinned: pin.version, current: a.current_version })
  }
  return out
}

/** Parse the `repos:` list out of a manifest's frontmatter — the same grammar the
 *  runner's own parseManifest reads (packages/cli/src/runner.js), ported here so the
 *  console can show a context's repo pointers without a round trip through the CLI.
 *  Deliberately narrow: url required and validated against the runner's own scheme
 *  allowlist, ref optional; everything else in the frontmatter is ignored. */
export const parseManifestRepos = (md: string): ManifestRepo[] => {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return []
  const unquote = (v: string): string => {
    const t = v.trim()
    const q = t[0]
    return t.length >= 2 && (q === '"' || q === "'") && t.at(-1) === q ? t.slice(1, -1) : t
  }
  const repos: Record<string, string>[] = []
  let inRepos = false
  let cur: Record<string, string> | null = null
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    if (/^repos:\s*$/.test(line)) {
      inRepos = true
      continue
    }
    if (inRepos && /^\S/.test(line)) inRepos = false // next top-level key
    if (!inRepos) continue
    const item = line.match(/^\s*-\s+(\w+):\s*(.+)$/)
    const kv = line.match(/^\s+(\w+):\s*(.+)$/)
    if (item) {
      cur = { [item[1] as string]: unquote(item[2] as string) }
      repos.push(cur)
    } else if (kv && cur) cur[kv[1] as string] = unquote(kv[2] as string)
  }
  return repos
    .filter((r) => typeof r.url === "string" && /^(https:\/\/|ssh:\/\/|git@|file:\/\/)/.test(r.url))
    .map((r) => ({ url: r.url as string, ref: r.ref ?? null }))
}

/** The manifest's own first paragraph, for a one-line "what is this" — frontmatter
 *  stripped, a single leading heading skipped (most manifests open `# Name`), then the
 *  first non-blank run of lines joined and capped. Null on an empty/frontmatter-only
 *  body rather than an empty string, so callers can tell "no description" from "". */
export const manifestDescription = (md: string, maxChars = 220): string | null => {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
  const lines = body.split(/\r?\n/)
  let i = 0
  const skipBlank = () => {
    while (i < lines.length && (lines[i] as string).trim() === "") i++
  }
  skipBlank()
  if (i < lines.length && /^#{1,6}\s/.test(lines[i] as string)) {
    i++
    skipBlank()
  }
  const para: string[] = []
  while (i < lines.length && (lines[i] as string).trim() !== "") {
    para.push((lines[i] as string).trim())
    i++
  }
  const text = para.join(" ").trim()
  if (!text) return null
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text
}
