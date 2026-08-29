const BITS_PER_NODE = 4096
const WORDS_PER_NODE = BITS_PER_NODE / 32
const HASHES = 3

export interface FocusIndex {
  filters: Uint32Array
  nodes: number
  bytes: number
}

/**
 * The focus index is only a candidate filter. Every candidate still passes through
 * the exact matcher, so Bloom false positives cost time but never change a result.
 *
 * Keep the fast path to ASCII literals. JavaScript's Unicode case folding has edge
 * cases where lower-casing a string can change its length; those queries use the exact
 * scan so the filter cannot create a false negative.
 */
export const canIndexFocus = (query: string): boolean => {
  if (query.length < 3) return false
  for (let i = 0; i < query.length; i += 1) if (query.charCodeAt(i) > 0x7f) return false
  return true
}

const positions = (a: number, b: number, c: number): [number, number] => {
  const first = Math.imul(a + 0x9e37, 0x85ebca6b) ^ Math.imul(b + 0x7f4a, 0xc2b2ae35) ^ c
  const step = (Math.imul(c + 0x1656, 0x27d4eb2d) ^ Math.imul(a + b, 0x9e3779b1)) | 1
  return [first >>> 0, step >>> 0]
}

const addTrigrams = (filters: Uint32Array, offset: number, source: string): void => {
  const text = source.toLowerCase()
  for (let i = 0; i <= text.length - 3; i += 1) {
    const [first, step] = positions(
      text.charCodeAt(i),
      text.charCodeAt(i + 1),
      text.charCodeAt(i + 2),
    )
    for (let hash = 0; hash < HASHES; hash += 1) {
      const bit = (first + Math.imul(hash, step)) & (BITS_PER_NODE - 1)
      const word = offset + (bit >>> 5)
      filters[word] = (filters[word] ?? 0) | (1 << (bit & 31))
    }
  }
}

/** Build a fixed-size Bloom filter per node without retaining node text. */
export const buildFocusIndex = (nodes: number, bodyAt: (index: number) => string): FocusIndex => {
  const filters = new Uint32Array(nodes * WORDS_PER_NODE)
  for (let node = 0; node < nodes; node += 1)
    addTrigrams(filters, node * WORDS_PER_NODE, bodyAt(node))
  return { filters, nodes, bytes: filters.byteLength + 128 }
}

/** Return node indexes that may contain the literal. Null means use the exact full scan. */
export const focusCandidates = (index: FocusIndex, query: string): number[] | null => {
  if (!canIndexFocus(query)) return null
  const text = query.toLowerCase()
  const candidates: number[] = []
  for (let node = 0; node < index.nodes; node += 1) {
    const offset = node * WORDS_PER_NODE
    let possible = true
    for (let i = 0; i <= text.length - 3 && possible; i += 1) {
      const [first, step] = positions(
        text.charCodeAt(i),
        text.charCodeAt(i + 1),
        text.charCodeAt(i + 2),
      )
      for (let hash = 0; hash < HASHES; hash += 1) {
        const bit = (first + Math.imul(hash, step)) & (BITS_PER_NODE - 1)
        if (((index.filters[offset + (bit >>> 5)] ?? 0) & (1 << (bit & 31))) === 0) {
          possible = false
          break
        }
      }
    }
    if (possible) candidates.push(node)
  }
  return candidates
}
