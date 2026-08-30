import { type DocMap, type DocNode, type DocNodeType, docMap } from "./doc-map"

export const PREPARED_VERSION_GENERATION = 1
export const PREPARED_VERSION_MAX_BYTES = 4 * 1024 * 1024

export interface PreparedNode extends DocNode {
  /** First non-whitespace character in this tiled node. Section reads start here. */
  contentStart: number
  /** UTF-8 byte offsets for object-store range reads. */
  byteStart: number
  byteEnd: number
  contentByteStart: number
}

export interface PreparedVersion {
  generation: typeof PREPARED_VERSION_GENERATION
  sourceKey: string
  contentType: string
  sourceBytes: number
  sourceChars: number
  kind: DocMap["kind"]
  nodes: PreparedNode[]
}

type StoredNode = [
  ref: string,
  type: DocNodeType,
  start: number,
  end: number,
  contentStart: number,
  byteStart: number,
  byteEnd: number,
  contentByteStart: number,
  title: string | null,
  identity: number | null,
  level: number | null,
  id: string | null,
]

interface StoredPreparedVersion {
  g: number
  s: string
  t: string
  b: number
  c: number
  k: string
  n: StoredNode[]
}

const NODE_TYPES = new Set<DocNodeType>([
  "head",
  "slide",
  "scene",
  "section",
  "region",
  "style",
  "script",
  "chrome",
  "tail",
  "body",
])
const KINDS = new Set<DocMap["kind"]>(["deck", "video", "page", "markdown"])
const encoder = new TextEncoder()

const firstContentOffset = (part: string): number => {
  const at = part.search(/\S/)
  return at === -1 ? 0 : at
}

/** Build one compact navigation index while encoding each source character once. */
export const prepareVersion = (
  sourceKey: string,
  source: string,
  contentType: string,
  structure: DocMap = docMap(source, contentType),
): PreparedVersion | null => {
  if (!sourceKey || !contentType || structure.nodes.length === 0) return null
  const nodes: PreparedNode[] = []
  let charCursor = 0
  let byteCursor = 0
  for (const node of structure.nodes) {
    if (node.start !== charCursor || node.end <= node.start || node.end > source.length) return null
    const part = source.slice(node.start, node.end)
    const contentOffset = firstContentOffset(part)
    const prefixBytes = encoder.encode(part.slice(0, contentOffset)).byteLength
    const contentBytes = encoder.encode(part.slice(contentOffset)).byteLength
    const byteEnd = byteCursor + prefixBytes + contentBytes
    nodes.push({
      ...node,
      contentStart: node.start + contentOffset,
      byteStart: byteCursor,
      byteEnd,
      contentByteStart: byteCursor + prefixBytes,
    })
    charCursor = node.end
    byteCursor = byteEnd
  }
  if (charCursor !== source.length) return null
  return {
    generation: PREPARED_VERSION_GENERATION,
    sourceKey,
    contentType,
    sourceBytes: byteCursor,
    sourceChars: source.length,
    kind: structure.kind,
    nodes,
  }
}

const storedNode = (node: PreparedNode): StoredNode => [
  node.ref,
  node.type,
  node.start,
  node.end,
  node.contentStart,
  node.byteStart,
  node.byteEnd,
  node.contentByteStart,
  node.title ?? null,
  node.identity ?? null,
  node.level ?? null,
  node.id ?? null,
]

export const encodePreparedVersion = (
  prepared: PreparedVersion,
  maxBytes = PREPARED_VERSION_MAX_BYTES,
): Uint8Array | null => {
  const stored: StoredPreparedVersion = {
    g: prepared.generation,
    s: prepared.sourceKey,
    t: prepared.contentType,
    b: prepared.sourceBytes,
    c: prepared.sourceChars,
    k: prepared.kind,
    n: prepared.nodes.map(storedNode),
  }
  const bytes = encoder.encode(JSON.stringify(stored))
  return bytes.byteLength <= maxBytes ? bytes : null
}

const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const optionalString = (value: unknown): value is string | null =>
  value === null || typeof value === "string"
const optionalInteger = (value: unknown): value is number | null => value === null || integer(value)

export interface PreparedVersionExpected {
  sourceKey: string
  contentType: string
  sourceBytes?: number
}

/** Strictly decode untrusted derived bytes. A fault is a cache miss, never a read failure. */
export const decodePreparedVersion = (
  bytes: Uint8Array,
  expected: PreparedVersionExpected,
): PreparedVersion | null => {
  if (bytes.byteLength === 0 || bytes.byteLength > PREPARED_VERSION_MAX_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const stored = value as Partial<StoredPreparedVersion>
  if (
    stored.g !== PREPARED_VERSION_GENERATION ||
    stored.s !== expected.sourceKey ||
    stored.t !== expected.contentType ||
    !integer(stored.b) ||
    !integer(stored.c) ||
    !KINDS.has(stored.k as DocMap["kind"]) ||
    !Array.isArray(stored.n) ||
    stored.n.length === 0 ||
    (expected.sourceBytes !== undefined &&
      expected.sourceBytes > 0 &&
      stored.b !== expected.sourceBytes)
  )
    return null

  const refs = new Set<string>()
  const nodes: PreparedNode[] = []
  let charCursor = 0
  let byteCursor = 0
  for (const raw of stored.n) {
    if (!Array.isArray(raw) || raw.length !== 12) return null
    const [ref, type, start, end, contentStart, byteStart, byteEnd, contentByteStart] = raw
    const title = raw[8]
    const identity = raw[9]
    const level = raw[10]
    const id = raw[11]
    if (
      typeof ref !== "string" ||
      !ref ||
      refs.has(ref) ||
      typeof type !== "string" ||
      !NODE_TYPES.has(type as DocNodeType) ||
      !integer(start) ||
      !integer(end) ||
      !integer(contentStart) ||
      !integer(byteStart) ||
      !integer(byteEnd) ||
      !integer(contentByteStart) ||
      start !== charCursor ||
      byteStart !== byteCursor ||
      end <= start ||
      byteEnd <= byteStart ||
      contentStart < start ||
      contentStart >= end ||
      contentByteStart < byteStart ||
      contentByteStart >= byteEnd ||
      end > stored.c ||
      byteEnd > stored.b ||
      !optionalString(title) ||
      !optionalInteger(identity) ||
      !optionalInteger(level) ||
      !optionalString(id)
    )
      return null
    refs.add(ref)
    nodes.push({
      ref,
      type: type as DocNodeType,
      start,
      end,
      contentStart,
      byteStart,
      byteEnd,
      contentByteStart,
      ...(title !== null ? { title } : {}),
      ...(identity !== null ? { identity } : {}),
      ...(level !== null ? { level } : {}),
      ...(id !== null ? { id } : {}),
    })
    charCursor = end
    byteCursor = byteEnd
  }
  if (charCursor !== stored.c || byteCursor !== stored.b) return null
  return {
    generation: PREPARED_VERSION_GENERATION,
    sourceKey: stored.s,
    contentType: stored.t,
    sourceBytes: stored.b,
    sourceChars: stored.c,
    kind: stored.k as DocMap["kind"],
    nodes,
  }
}

export const preparedMap = (prepared: PreparedVersion): DocMap => ({
  kind: prepared.kind,
  nodes: prepared.nodes,
})

export const resolvePreparedNode = (
  prepared: PreparedVersion,
  ref: string,
): PreparedNode | null => {
  const wanted = ref.trim()
  if (!wanted) return null
  if (wanted.startsWith("#")) {
    const id = wanted.slice(1)
    const hits = prepared.nodes.filter((node) => node.id === id)
    return hits.length === 1 ? (hits[0] as PreparedNode) : null
  }
  return prepared.nodes.find((node) => node.ref === wanted) ?? null
}
