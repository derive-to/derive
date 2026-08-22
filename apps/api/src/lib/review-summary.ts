import {
  type BlobStore,
  type DiffOp,
  diffLines,
  type MetaStore,
  toMarkdown,
  type VersionRecord,
} from "@derive/core"
import { pageTextResolver } from "./bundle"
import { truncate } from "./text"

export type ReviewChangeKind = "added" | "updated" | "removed"

export interface ReviewChange {
  kind: ReviewChangeKind
  title: string
  previousTitle?: string
  added: number
  removed: number
  before?: string
  after?: string
}

export interface ReviewSummary {
  fromVersion: number | null
  toVersion: number
  added: number
  removed: number
  /** Ranked structural changes. Always populated by production; optional for old payloads. */
  changes?: ReviewChange[]
  /** All detected structural changes, including cards omitted from the compact preview. */
  totalChanges?: number
  /** Plain-text fallback used by older consumers and notification payloads. */
  highlights: string[]
  note: string | null
}

interface DocSection {
  key: string
  title: string
  level: number
  lines: string[]
  order: number
}

const readableText = async (blobs: BlobStore, version: VersionRecord): Promise<string> => {
  const resolve = await pageTextResolver(blobs, version)
  const source = (await resolve(null)) ?? ""
  const type = /^\s*<(?:!doctype|html|head|body|main|section)\b/i.test(source)
    ? "text/html"
    : version.content_type
  return toMarkdown(source, type)
}

const diagramNode = (raw: string): string =>
  raw
    .trim()
    .replace(/^[A-Za-z0-9_-]+\s*(?:\[|\(|\{|>)(.+?)(?:\]|\)|\}|])$/, "$1")
    .replace(/^['"]|['"]$/g, "")
    .trim()

const humanizeDiagramLine = (line: string): string => {
  const edge = /^\s*([^\n]+?)\s*--(?:>|[^>|]*\|([^|]+)\|\s*>)\s*([^\n]+?)\s*$/.exec(line)
  if (!edge?.[1] || !edge[3]) return line
  const from = diagramNode(edge[1])
  const to = diagramNode(edge[3])
  return edge[2] ? `${from} → ${edge[2].trim()} → ${to}` : `${from} → ${to}`
}

const cleanLine = (line: string, max = 220): string =>
  truncate(
    humanizeDiagramLine(line)
      .replace(/^\s{0,3}(?:#{1,6}|[-*+] |\d+\. )\s*/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`>#~]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  )

const meaningful = (line: string): boolean => {
  const clean = cleanLine(line)
  return clean.length >= 8 && /[A-Za-z0-9]/.test(clean) && !/^[-=]{3,}$/.test(clean)
}

const normalizedTitle = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

const documentSections = (markdown: string): DocSection[] => {
  const sections: DocSection[] = []
  const seen = new Map<string, number>()
  let current: DocSection = {
    key: "__overview__:1",
    title: "Overview",
    level: 1,
    lines: [],
    order: 0,
  }
  sections.push(current)
  for (const raw of markdown.split("\n")) {
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw)
    if (heading?.[1] && heading[2]) {
      const title = cleanLine(heading[2], 100) || "Untitled section"
      const normalized = normalizedTitle(title) || "untitled"
      const occurrence = (seen.get(normalized) ?? 0) + 1
      seen.set(normalized, occurrence)
      current = {
        key: `${normalized}:${occurrence}`,
        title,
        level: heading[1].length,
        lines: [],
        order: sections.length,
      }
      sections.push(current)
      continue
    }
    if (meaningful(raw)) current.lines.push(raw.trim())
  }
  return sections.filter((section, index) => index > 0 || section.lines.length > 0)
}

const tokens = (section: DocSection): Set<string> =>
  new Set(
    `${section.title} ${section.lines.join(" ")}`
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g)
      ?.filter((token) => !STOP_WORDS.has(token)) ?? [],
  )

const STOP_WORDS = new Set([
  "and",
  "are",
  "but",
  "for",
  "from",
  "have",
  "into",
  "not",
  "that",
  "the",
  "their",
  "this",
  "was",
  "were",
  "with",
  "you",
  "your",
])

const similarity = (a: DocSection, b: DocSection): number => {
  const left = tokens(a)
  const right = tokens(b)
  if (!left.size || !right.size) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection++
  return intersection / (left.size + right.size - intersection)
}

const diffFor = (before: string[], after: string[]): DiffOp[] => {
  if (before.length * after.length <= 80_000) return diffLines(before.join("\n"), after.join("\n"))
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return [
    ...before.filter((line) => !afterSet.has(line)).map((line) => ({ t: "del" as const, line })),
    ...after.filter((line) => !beforeSet.has(line)).map((line) => ({ t: "add" as const, line })),
  ]
}

const bestExcerpt = (lines: string[]): string | undefined => {
  const scored = lines
    .map((line, index) => {
      const clean = cleanLine(line)
      const words = clean.split(/\s+/).filter(Boolean).length
      const score = Math.min(words, 18) + (/[.!?]$/.test(clean) ? 2 : 0) - index * 0.02
      return { clean, score }
    })
    .filter(({ clean }) => meaningful(clean))
    .sort((a, b) => b.score - a.score)
  return scored[0]?.clean
}

const changedSection = (before: DocSection, after: DocSection): ReviewChange | null => {
  const ops = diffFor(before.lines, after.lines)
  const addedLines = ops.filter((op) => op.t === "add" && meaningful(op.line)).map((op) => op.line)
  const removedLines = ops
    .filter((op) => op.t === "del" && meaningful(op.line))
    .map((op) => op.line)
  const renamed = normalizedTitle(before.title) !== normalizedTitle(after.title)
  if (!renamed && addedLines.length === 0 && removedLines.length === 0) return null
  return {
    kind: "updated",
    title: after.title,
    ...(renamed ? { previousTitle: before.title } : {}),
    added: addedLines.length,
    removed: removedLines.length,
    before: bestExcerpt(removedLines),
    after: bestExcerpt(addedLines),
  }
}

const newSection = (section: DocSection): ReviewChange => ({
  kind: "added",
  title: section.title,
  added: section.lines.filter(meaningful).length,
  removed: 0,
  after: bestExcerpt(section.lines),
})

const removedSection = (section: DocSection): ReviewChange => ({
  kind: "removed",
  title: section.title,
  added: 0,
  removed: section.lines.filter(meaningful).length,
  before: bestExcerpt(section.lines),
})

const rank = (change: ReviewChange, section: DocSection): number => {
  const magnitude = Math.min(change.added + change.removed, 20)
  const paired = change.before && change.after ? 8 : 0
  const structural = change.kind === "updated" ? 4 : 6
  const heading = Math.max(0, 5 - section.level)
  return magnitude + paired + structural + heading - section.order * 0.01
}

const structuralChanges = (
  before: string,
  after: string,
): { changes: ReviewChange[]; total: number } => {
  const oldSections = documentSections(before)
  const newSections = documentSections(after)
  const oldByKey = new Map(oldSections.map((section) => [section.key, section]))
  const matchedOld = new Set<string>()
  const candidates: Array<{ change: ReviewChange; section: DocSection; score: number }> = []

  // Exact heading matches preserve a stable section identity even when its body is rewritten.
  for (const section of newSections) {
    const old = oldByKey.get(section.key)
    if (!old) continue
    matchedOld.add(old.key)
    const change = changedSection(old, section)
    if (change) candidates.push({ change, section, score: rank(change, section) })
  }

  // Pair renamed/moved sections by content similarity before calling them add/remove.
  const unmatchedOld = oldSections.filter((section) => !matchedOld.has(section.key))
  for (const section of newSections.filter((candidate) => !oldByKey.has(candidate.key))) {
    let best: DocSection | undefined
    let bestScore = 0
    for (const old of unmatchedOld) {
      if (matchedOld.has(old.key)) continue
      const score = similarity(old, section)
      if (score > bestScore) {
        best = old
        bestScore = score
      }
    }
    if (best && bestScore >= 0.42) {
      matchedOld.add(best.key)
      const change = changedSection(best, section)
      if (change) candidates.push({ change, section, score: rank(change, section) + bestScore * 5 })
    } else {
      const change = newSection(section)
      candidates.push({ change, section, score: rank(change, section) })
    }
  }

  for (const section of oldSections) {
    if (matchedOld.has(section.key)) continue
    const change = removedSection(section)
    candidates.push({ change, section, score: rank(change, section) })
  }

  const ranked = candidates
    .filter(({ change }) => change.added > 0 || change.removed > 0 || !!change.previousTitle)
    .sort((a, b) => b.score - a.score)
  return {
    changes: ranked.slice(0, 3).map(({ change }) => change),
    total: ranked.length,
  }
}

const globalDelta = (before: string, after: string): { added: number; removed: number } => {
  const ops = diffFor(before.split("\n"), after.split("\n"))
  return {
    added: ops.filter((op) => op.t === "add" && meaningful(op.line)).length,
    removed: ops.filter((op) => op.t === "del" && meaningful(op.line)).length,
  }
}

/** Pure structural summarizer, exported so the algorithm can be tested without storage. */
export const summarizeReviewDocuments = (input: {
  before: string
  after: string
  beforeContentType?: string
  afterContentType?: string
  fromVersion: number | null
  toVersion: number
  note?: string | null
}): ReviewSummary => {
  const before = toMarkdown(input.before, input.beforeContentType ?? "text/markdown")
  const after = toMarkdown(input.after, input.afterContentType ?? "text/markdown")
  const delta = globalDelta(before, after)
  const structural = structuralChanges(before, after)
  const changes = structural.changes
  return {
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    ...delta,
    changes,
    totalChanges: structural.total,
    highlights: changes
      .map((change) => change.after ?? change.before)
      .filter((line): line is string => !!line),
    note: input.note ? truncate(input.note, 600) : null,
  }
}

/** Build the compact, channel-neutral change story used by Slack and email. */
export const buildReviewSummary = async (
  meta: MetaStore,
  blobs: BlobStore,
  artifactId: string,
  version: number,
  note?: string | null,
): Promise<ReviewSummary> => {
  const current = await meta.getVersion(artifactId, version)
  const previous = version > 1 ? await meta.getVersion(artifactId, version - 1) : null
  if (!current)
    return {
      fromVersion: previous?.n ?? null,
      toVersion: version,
      added: 0,
      removed: 0,
      changes: [],
      totalChanges: 0,
      highlights: [],
      note: note ? truncate(note, 600) : null,
    }
  const [before, after] = await Promise.all([
    previous ? readableText(blobs, previous) : Promise.resolve(""),
    readableText(blobs, current),
  ])
  return summarizeReviewDocuments({
    before,
    after,
    fromVersion: previous?.n ?? null,
    toVersion: version,
    note: note ?? current.message,
  })
}

export const reviewDeltaLabel = (summary: ReviewSummary): string => {
  if (summary.added === 0 && summary.removed === 0) return "No text changes detected"
  const parts = []
  if (summary.added) parts.push(`${summary.added} added`)
  if (summary.removed) parts.push(`${summary.removed} removed`)
  return parts.join(" · ")
}
