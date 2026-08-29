import { type DocNode, docMap } from "@derive/core"
import { MAX_CHARS } from "./clip"
import { documentStructure } from "./doc-structure-cache"
import { present } from "./search"
import { WeightedLruCache } from "./source-text-cache"

const CHANGED_PART_MAX = 3
const CHANGED_BODY_MAX = Math.floor(MAX_CHARS / CHANGED_PART_MAX)

type ChangeKind = "added" | "changed" | "moved" | "removed"

export interface ChangedPart {
  change: ChangeKind
  node: string
  type: DocNode["type"]
  title?: string
  from_node?: string
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

// Change receipts are pure functions of two immutable content-addressed blobs. Keep the
// bounded result, not either source body. Active artifacts often receive repeated catch-up
// reads after one publish, and recomputing the same two structural maps is their main cost.
const receipts = new WeightedLruCache<ChangedParts>({
  maxBytes: 2 * 1024 * 1024,
  maxEntries: 256,
  maxEntryBytes: 64 * 1024,
})

const receiptKey = (
  beforeBlobKey: string,
  beforeContentType: string,
  afterBlobKey: string,
  afterContentType: string,
): string => `${beforeContentType}:${beforeBlobKey}>${afterContentType}:${afterBlobKey}`

export const getChangedPartsReceipt = (
  beforeBlobKey: string,
  beforeContentType: string,
  afterBlobKey: string,
  afterContentType: string,
): ChangedParts | null =>
  receipts.get(receiptKey(beforeBlobKey, beforeContentType, afterBlobKey, afterContentType)) ?? null

/** Prefer authored identity over position when a document supplies it. This keeps a
 *  slide insert from making every later position look edited. Refs remain the returned
 *  address because they name the CURRENT document. */
const stableKey = (node: DocNode): string => {
  if (node.type === "slide" && node.identity !== undefined) return `slide-id:${node.identity}`
  if (node.id) return `${node.type}-id:${node.id}`
  return node.ref
}

const keyed = (nodes: DocNode[]): Map<string, { index: number; node: DocNode }> => {
  const out = new Map<string, { index: number; node: DocNode }>()
  for (const [index, node] of nodes.entries()) {
    const key = stableKey(node)
    if (out.has(key))
      throw new Error(
        `Two document parts share stable identity ${JSON.stringify(key)}, so changes are ambiguous.`,
      )
    out.set(key, { index, node })
  }
  return out
}

/** Indices in one longest increasing subsequence. Added and removed nodes are omitted
 * before this runs, so a node outside this set is one whose relative order changed — not
 * merely one whose positional ref shifted after an insert or delete. */
const increasingIndices = (values: number[]): Set<number> => {
  const tails: number[] = []
  const previous = Array<number>(values.length).fill(-1)
  for (let i = 0; i < values.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if ((values[tails[mid] as number] as number) < (values[i] as number)) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[i] = tails[lo - 1] as number
    tails[lo] = i
  }
  const indices = new Set<number>()
  let cursor = tails[tails.length - 1] ?? -1
  while (cursor >= 0) {
    indices.add(cursor)
    cursor = previous[cursor] as number
  }
  return indices
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
  fromNode?: string,
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
    ...(fromNode ? { from_node: fromNode } : {}),
    chars: body.length,
    format: useReadable ? "markdown" : "html",
    body: clipBody(body),
  }
}

type MaterializeCurrentPart = typeof currentPart

/** Compare two stored single-file versions and return a bounded working set. This is
 *  shared by catch_up and publish so the post-edit receipt and the later catch-up view
 *  cannot disagree about which part changed. */
export const changedParts = (
  beforeSource: string,
  beforeContentType: string,
  afterSource: string,
  afterContentType: string,
  materializeCurrentPart: MaterializeCurrentPart = currentPart,
  prepared?: { before: ReturnType<typeof docMap>; after: ReturnType<typeof docMap> },
): ChangedParts => {
  const before = prepared?.before ?? docMap(beforeSource, beforeContentType)
  const after = prepared?.after ?? docMap(afterSource, afterContentType)
  const previous = keyed(before.nodes)
  const current = keyed(after.nodes)
  const common = after.nodes.filter((node) => previous.has(stableKey(node)))
  const stable = increasingIndices(common.map((node) => previous.get(stableKey(node))?.index ?? -1))
  const moved = new Set(
    common.flatMap((node, index) => (stable.has(index) ? [] : [stableKey(node)])),
  )
  const deltas: Array<
    | { change: Exclude<ChangeKind, "removed">; node: DocNode; previous?: DocNode }
    | { change: "removed"; node: DocNode }
  > = []

  for (const node of after.nodes) {
    const old = previous.get(stableKey(node))?.node
    if (!old) {
      deltas.push({ change: "added", node })
      continue
    }
    const bodyChanged =
      beforeSource.slice(old.start, old.end) !== afterSource.slice(node.start, node.end) ||
      beforeContentType !== afterContentType
    if (bodyChanged || moved.has(stableKey(node)))
      deltas.push({
        change: bodyChanged ? "changed" : "moved",
        node,
        ...(moved.has(stableKey(node)) ? { previous: old } : {}),
      })
  }

  for (const node of before.nodes) {
    if (current.has(stableKey(node))) continue
    deltas.push({ change: "removed", node })
  }

  // Count every delta, but convert only the bounded results to Markdown. A full rewrite
  // can change thousands of parts; materializing bodies that cannot leave this function
  // wastes Worker CPU and briefly retains an extra document-sized set of strings.
  const changes = deltas.slice(0, CHANGED_PART_MAX).map((delta): ChangedPart => {
    if (delta.change === "removed")
      return {
        change: "removed",
        node: delta.node.ref,
        type: delta.node.type,
        ...(delta.node.title ? { title: delta.node.title } : {}),
      }
    return materializeCurrentPart(
      delta.change,
      delta.node,
      afterSource,
      afterContentType,
      delta.previous?.ref,
    )
  })

  return {
    count: deltas.length,
    changes,
    ...(deltas.length > CHANGED_PART_MAX
      ? { truncated: true, more_changes: deltas.length - CHANGED_PART_MAX }
      : {}),
    note: deltas.length
      ? "Each non-removed result is a bounded readable current part. Use its node ref for exact source only if another edit needs it."
      : "The readable document parts did not change.",
  }
}

/** Compute and retain one immutable adjacent-version receipt. Exact callers may check
 *  getChangedPartsReceipt first to avoid loading either source body on a hit. */
export const changedPartsWithReceipt = (
  beforeBlobKey: string,
  beforeSource: string,
  beforeContentType: string,
  afterBlobKey: string,
  afterSource: string,
  afterContentType: string,
  materializeCurrentPart: MaterializeCurrentPart = currentPart,
): ChangedParts => {
  const key = receiptKey(beforeBlobKey, beforeContentType, afterBlobKey, afterContentType)
  const cached = receipts.get(key)
  if (cached) return cached
  const value = changedParts(
    beforeSource,
    beforeContentType,
    afterSource,
    afterContentType,
    materializeCurrentPart,
    {
      before: documentStructure(beforeBlobKey, beforeSource, beforeContentType),
      after: documentStructure(afterBlobKey, afterSource, afterContentType),
    },
  )
  receipts.set(key, value, key.length * 2 + JSON.stringify(value).length * 2)
  return value
}
