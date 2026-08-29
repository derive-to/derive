import { type DocNode, docMap } from "@derive/core"
import { MAX_CHARS } from "./clip"
import { present } from "./search"

const CHANGED_PART_MAX = 3
const CHANGED_BODY_MAX = Math.floor(MAX_CHARS / CHANGED_PART_MAX)

type ChangeKind = "added" | "changed" | "removed"

export interface ChangedPart {
  change: ChangeKind
  node: string
  type: DocNode["type"]
  title?: string
  chars?: number
  format?: "markdown" | "html"
  body?: string
}

export interface ChangedParts {
  count: number
  changes: ChangedPart[]
  truncated?: true
  more_changes?: number
  note: string
}

/** Prefer authored identity over position when a document supplies it. This keeps a
 *  slide insert from making every later position look edited. Refs remain the returned
 *  address because they name the CURRENT document. */
const stableKey = (node: DocNode): string => {
  if (node.type === "slide" && node.identity !== undefined) return `slide-id:${node.identity}`
  if (node.id) return `${node.type}-id:${node.id}`
  return node.ref
}

const clipBody = (body: string): string =>
  body.length > CHANGED_BODY_MAX
    ? `${body.slice(0, CHANGED_BODY_MAX)}\n\n…[truncated ${body.length - CHANGED_BODY_MAX} chars — read this node for the complete part]`
    : body

const currentPart = (
  change: Exclude<ChangeKind, "removed">,
  node: DocNode,
  source: string,
  contentType: string,
): ChangedPart => {
  const exact = source.slice(node.start, node.end)
  const readable = present(exact, contentType, "markdown")
  // CSS, scripts, and document chrome can convert to an empty readable view. Exact
  // source is the useful receipt there; content nodes keep the smaller readable body.
  const useReadable = readable.trim().length > 0
  const body = useReadable ? readable : exact
  return {
    change,
    node: node.ref,
    type: node.type,
    ...(node.title ? { title: node.title } : {}),
    chars: body.length,
    format: useReadable ? "markdown" : "html",
    body: clipBody(body),
  }
}

/** Compare two stored single-file versions and return a bounded working set. This is
 *  shared by catch_up and publish so the post-edit receipt and the later catch-up view
 *  cannot disagree about which part changed. */
export const changedParts = (
  beforeSource: string,
  beforeContentType: string,
  afterSource: string,
  afterContentType: string,
): ChangedParts => {
  const before = docMap(beforeSource, beforeContentType)
  const after = docMap(afterSource, afterContentType)
  const previous = new Map(before.nodes.map((node) => [stableKey(node), node]))
  const currentKeys = new Set(after.nodes.map(stableKey))
  const changes: ChangedPart[] = []

  for (const node of after.nodes) {
    const old = previous.get(stableKey(node))
    if (!old) {
      changes.push(currentPart("added", node, afterSource, afterContentType))
      continue
    }
    if (
      beforeSource.slice(old.start, old.end) !== afterSource.slice(node.start, node.end) ||
      beforeContentType !== afterContentType
    )
      changes.push(currentPart("changed", node, afterSource, afterContentType))
  }

  for (const node of before.nodes) {
    if (currentKeys.has(stableKey(node))) continue
    changes.push({
      change: "removed",
      node: node.ref,
      type: node.type,
      ...(node.title ? { title: node.title } : {}),
    })
  }

  return {
    count: changes.length,
    changes: changes.slice(0, CHANGED_PART_MAX),
    ...(changes.length > CHANGED_PART_MAX
      ? { truncated: true, more_changes: changes.length - CHANGED_PART_MAX }
      : {}),
    note: changes.length
      ? "Each non-removed result is a bounded readable current part. Use its node ref for exact source only if another edit needs it."
      : "The readable document parts did not change.",
  }
}
