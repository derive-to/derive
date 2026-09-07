// Reading a third-party archive off the wire under a memory budget.
//
// Two importers pull a gzipped tarball from somewhere else: a paper's source from arXiv,
// and the repository that implements it from GitHub or GitLab. Both are untrusted bytes
// inflated inside a worker with a fixed memory budget, so both need the same discipline —
// a cap on what is read off the wire, a cap on what it inflates to, both enforced WHILE
// reading rather than after, and what the body turns out to be decided from its bytes
// rather than from a header the upstream may or may not have set.
//
// This module is that discipline and nothing else. It raises ArchiveError with a kind;
// each importer phrases the failure in its own words, because "the source" and "the
// repository" are different things to the person reading the message.
import { Gunzip } from "fflate"

export interface ArchiveCaps {
  /** The most bytes read off the wire for one archive. */
  compressedBytes: number
  /** The most bytes it may inflate to while it is read. */
  inflatedBytes: number
}

export type ArchiveErrorKind =
  /** Past the wire budget. */
  | "compressed"
  /** Past the inflate budget. */
  | "inflated"
  /** Not decompressible: truncated, or not the format it claimed. */
  | "corrupt"
  /** The connection went away mid-body. */
  | "broken"

export class ArchiveError extends Error {
  constructor(public kind: ArchiveErrorKind) {
    super(`archive ${kind}`)
    this.name = "ArchiveError"
  }
}

export const startsWith = (bytes: Uint8Array, ascii: string): boolean =>
  bytes.byteLength >= ascii.length && [...ascii].every((ch, i) => bytes[i] === ch.charCodeAt(0))

export const isGzip = (bytes: Uint8Array): boolean => bytes[0] === 0x1f && bytes[1] === 0x8b

export const concatChunks = (chunks: Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** Inflate a gzip buffer, refusing past the cap before another chunk is kept. */
export const inflateCapped = (bytes: Uint8Array, cap: number): Uint8Array => {
  const chunks: Uint8Array[] = []
  let total = 0
  const gz = new Gunzip((chunk) => {
    total += chunk.byteLength
    if (total > cap) throw new ArchiveError("inflated")
    chunks.push(chunk)
  })
  try {
    gz.push(bytes, true)
  } catch (error) {
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError("corrupt")
  }
  return concatChunks(chunks, total)
}

/**
 * Read an archive body off the wire. A gzip body streams through the inflater as it
 * arrives, so the peak held in memory is the inflated archive, never compressed plus
 * inflated; anything else is buffered as is. Both budgets are enforced while reading.
 */
export const readArchive = async (res: Response, caps: ArchiveCaps): Promise<Uint8Array> => {
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const out: Uint8Array[] = []
  let inflated = 0
  const keep = (chunk: Uint8Array): void => {
    inflated += chunk.byteLength
    if (inflated > caps.inflatedBytes) throw new ArchiveError("inflated")
    out.push(chunk)
  }
  let compressed = 0
  let head: Uint8Array | null = null
  let gz: Gunzip | null = null
  let pending: Uint8Array | null = null
  const push = (chunk: Uint8Array, final: boolean): void => {
    if (gz) gz.push(chunk, final)
    else keep(chunk)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      compressed += value.byteLength
      if (compressed > caps.compressedBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ArchiveError("compressed")
      }
      // The first two bytes say whether this is gzip; wait for them before deciding.
      if (head === null) {
        const first: Uint8Array = pending
          ? concatChunks([pending, value], pending.byteLength + value.byteLength)
          : value
        if (first.byteLength < 2) {
          pending = first
          continue
        }
        head = first
        if (isGzip(first)) gz = new Gunzip((chunk) => keep(chunk))
        pending = first
        continue
      }
      if (pending) push(pending, false)
      pending = value
    }
    if (pending) push(pending, true)
    else if (head === null && !gz) return new Uint8Array()
  } catch (error) {
    if (error instanceof ArchiveError) throw error
    if (
      error instanceof Error &&
      /invalid|corrupt|unexpected|gzip|zlib|inflate/i.test(error.message)
    )
      throw new ArchiveError("corrupt")
    throw new ArchiveError("broken")
  } finally {
    reader.releaseLock()
  }
  return concatChunks(out, inflated)
}
