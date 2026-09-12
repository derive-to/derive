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
//
// `stageArchive` is the streaming form. The body inflates a slice at a time, its tar is read
// as it arrives, and each file goes into the blob store as soon as it is whole or, when it is
// large, while it is still arriving. Reading pauses while storage is behind. So what the
// worker holds is bounded by the limits it is given, never by the size of the archive.
import {
  type BlobStore,
  type BlobWriter,
  bufferedWriter,
  isTar,
  TarReader,
  type TarSink,
} from "@derive/core"
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
  /** Nothing arrived for a while, or the download ran past its deadline. */
  | "stalled"
  /** Not an archive, and more than one file may hold. */
  | "single"

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

// ---- Streaming into the blob store ------------------------------------------------

/** How much of a file a policy sees before it decides what to do with it. */
export const HEAD_BYTES = 8 * 1024
/** Compressed bytes handed to the inflater at a time. Deflate tops out near a thousand to
 *  one, so what one slice inflates to stays within megabytes whatever the archive holds. */
const SLICE_BYTES = 8 * 1024
/** A download that sends nothing for this long has stalled. */
const STALL_MS = 30_000
/** Whole files being put at once. A streamed file goes in archive order, one at a time. */
const MAX_PUTS = 4
const BLOCK = 512
const EMPTY = new Uint8Array(0)

export interface StageCaps extends ArchiveCaps {
  /** Regular files the archive may hold. */
  files: number
  /** A file up to this is read whole and put; a larger one streams through a writer. */
  bufferFileBytes: number
  /** Bytes on their way to storage before reading pauses for them. */
  inflightBytes: number
  /** The longest the whole download may take. */
  deadlineMs: number
  /** A body that is not an archive is one file, held up to this. */
  singleFileBytes: number
}

export interface StagedFile {
  /** The name the archive gave it, uncleaned. */
  path: string
  size: number
  key: string
  /** The whole file, when the policy asked to keep it. */
  bytes: Uint8Array | null
}

/** What the importer decides about each file, as the archive reaches it. Either callback
 *  may throw to refuse the whole archive. */
export interface StagePolicy {
  /** From the tar header, before any data: false skips the file without reading it. */
  header(path: string, size: number): boolean
  /** From the first HEAD_BYTES (all of a smaller file): leave it out, store it, or store it
   *  and keep its bytes in memory, which only a file read whole can be. */
  head(path: string, size: number, head: Uint8Array): "skip" | "store" | "keep"
}

export interface StageDeps {
  blobs: BlobStore
  /** Called as the download goes, so a long one keeps its claim on the job. */
  heartbeat?: () => Promise<void>
}

export type Staged =
  | { kind: "tar"; files: StagedFile[] }
  | { kind: "pdf" }
  | { kind: "single"; bytes: Uint8Array }

const looksLikePdf = (head: Uint8Array): boolean =>
  startsWith(head, "%PDF") || startsWith(head, "%!PS")

/** The first `n` bytes across pieces, copied. */
const firstBytes = (parts: Uint8Array[], n: number): Uint8Array => {
  const out = new Uint8Array(
    Math.min(
      n,
      parts.reduce((sum, p) => sum + p.byteLength, 0),
    ),
  )
  let at = 0
  for (const part of parts) {
    if (at >= out.byteLength) break
    const take = Math.min(part.byteLength, out.byteLength - at)
    out.set(part.subarray(0, take), at)
    at += take
  }
  return out
}

/** Hold the first `need` bytes of a stream, choose from them where the stream goes, then
 *  send it everything, held bytes first. */
const sniff = (need: number, route: (head: Uint8Array) => (chunk: Uint8Array) => void) => {
  let held: Uint8Array[] = []
  let size = 0
  let next: ((chunk: Uint8Array) => void) | null = null
  const decide = (): void => {
    const to = route(firstBytes(held, need))
    next = to
    const flush = held
    held = []
    for (const piece of flush) to(piece)
  }
  return {
    push: (chunk: Uint8Array): void => {
      if (next) {
        next(chunk)
        return
      }
      held.push(chunk)
      size += chunk.byteLength
      if (size >= need) decide()
    },
    /** The stream ended: decide from whatever arrived. */
    end: (): void => {
      if (!next) decide()
    },
  }
}

/** fflate reports a broken stream as a plain Error carrying a numeric code. */
const isInflateError = (error: unknown): boolean =>
  error instanceof Error &&
  Object.getPrototypeOf(error) === Error.prototype &&
  typeof (error as { code?: unknown }).code === "number"

const readSoon = async (reader: ReadableStreamDefaultReader<Uint8Array>, deadline: number) => {
  const wait = Math.min(STALL_MS, deadline - Date.now())
  if (wait <= 0) throw new ArchiveError("stalled")
  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ArchiveError("stalled")), wait)
  })
  try {
    return await Promise.race([
      reader.read().catch(() => Promise.reject(new ArchiveError("broken"))),
      stalled,
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface Entry {
  path: string
  size: number
  /** Position in the archive: a later entry with the same name wins. */
  order: number
}
type Reading = Entry & { mode: "whole" | "head"; parts: Uint8Array[]; got: number }
type Streaming = Entry & { mode: "stream"; writer: BlobWriter; chain: Promise<void> }

/** Takes a tar's files as they stream past and sees each one into the blob store. */
class Stager implements TarSink {
  private current: Reading | Streaming | { mode: "skip" } = { mode: "skip" }
  private order = 0
  private readonly staged = new Map<string, { order: number; file: StagedFile }>()
  private readonly pending = new Set<Promise<void>>()
  private readonly writers = new Set<BlobWriter>()
  private inflight = 0
  private puts = 0
  private failure: { error: unknown } | null = null

  constructor(
    private readonly caps: StageCaps,
    private readonly blobs: BlobStore,
    private readonly policy: StagePolicy,
  ) {}

  entry(path: string, size: number): boolean {
    if (!this.policy.header(path, size)) return false
    const mode = size <= this.caps.bufferFileBytes ? "whole" : "head"
    this.current = { mode, path, size, order: this.order++, parts: [], got: 0 }
    return true
  }

  data(piece: Uint8Array): void {
    const c = this.current
    if (c.mode === "stream") this.write(c, piece)
    else if (c.mode !== "skip") {
      c.parts.push(piece)
      c.got += piece.byteLength
      if (c.mode === "head" && c.got >= HEAD_BYTES) this.stream(c)
    }
  }

  end(): void {
    if (this.current.mode === "head") this.stream(this.current)
    const c = this.current
    this.current = { mode: "skip" }
    if (c.mode === "whole") {
      // Copied: a view would keep alive the whole inflated chunk it came from.
      const bytes = firstBytes(c.parts, c.size)
      const decision = this.policy.head(c.path, c.size, bytes.subarray(0, HEAD_BYTES))
      if (decision === "skip") return
      this.puts++
      this.track(
        bytes.byteLength,
        this.blobs
          .put(bytes)
          .then((key) => this.record(c, key, decision === "keep" ? bytes : null)),
        () => {
          this.puts--
        },
      )
    } else if (c.mode === "stream") {
      this.track(
        0,
        c.chain
          .then(() => c.writer.close())
          .then((key) => {
            this.writers.delete(c.writer)
            this.record(c, key, null)
          }),
      )
    }
  }

  /** Wait while storage is behind: too many bytes on their way, or too many whole files. */
  async settle(): Promise<void> {
    while (
      !this.failure &&
      this.pending.size > 0 &&
      (this.inflight > this.caps.inflightBytes || this.puts >= MAX_PUTS)
    )
      await Promise.race(this.pending)
    if (this.failure) throw this.failure.error
  }

  /** Everything is read: wait for the last files to be stored. */
  async drain(): Promise<StagedFile[]> {
    while (this.pending.size > 0) await Promise.race(this.pending)
    if (this.failure) throw this.failure.error
    return [...this.staged.values()].sort((a, b) => a.order - b.order).map((s) => s.file)
  }

  /** The archive failed: stop the streams and let what is on its way settle. */
  async abandon(): Promise<void> {
    await Promise.allSettled([...this.writers].map((w) => w.abort()))
    while (this.pending.size > 0) await Promise.race(this.pending)
  }

  private stream(c: Reading): void {
    const decision = this.policy.head(c.path, c.size, firstBytes(c.parts, HEAD_BYTES))
    if (decision === "skip") {
      this.current = { mode: "skip" }
      return
    }
    if (decision === "keep")
      throw new Error(`${c.path} is larger than a file that can be kept in memory`)
    const writer =
      this.blobs.writer?.(c.size) ?? bufferedWriter(c.size, (data) => this.blobs.put(data))
    this.writers.add(writer)
    const streaming: Streaming = {
      mode: "stream",
      path: c.path,
      size: c.size,
      order: c.order,
      writer,
      chain: Promise.resolve(),
    }
    this.current = streaming
    for (const part of c.parts) this.write(streaming, part)
  }

  private write(c: Streaming, piece: Uint8Array): void {
    const next = c.chain.then(() => c.writer.write(piece))
    c.chain = next
    this.track(piece.byteLength, next)
  }

  private track(bytes: number, work: Promise<unknown>, done?: () => void): void {
    this.inflight += bytes
    const settled: Promise<void> = work
      .then(
        () => undefined,
        (error: unknown) => {
          this.failure ??= { error }
        },
      )
      .finally(() => {
        this.inflight -= bytes
        done?.()
        this.pending.delete(settled)
      })
    this.pending.add(settled)
  }

  private record(c: Entry, key: string, bytes: Uint8Array | null): void {
    const seen = this.staged.get(c.path)
    if (seen && seen.order > c.order) return
    this.staged.set(c.path, { order: c.order, file: { path: c.path, size: c.size, key, bytes } })
  }
}

/**
 * Read an archive body into the blob store as it arrives, and say what it was: a tar (its
 * files, stored), a PDF, or one other file (held whole, up to `singleFileBytes`). A gzip body
 * inflates as it is read, once more if what it holds is gzipped too. The wire and inflate
 * budgets, the tar's caps and the download's time limits are enforced while reading;
 * anything the policy throws refuses the archive as it stands.
 */
export const stageArchive = async (
  res: Response,
  caps: StageCaps,
  deps: StageDeps,
  policy: StagePolicy,
): Promise<Staged> => {
  if (!res.body) return { kind: "single", bytes: EMPTY }
  const reader = res.body.getReader()
  const stager = new Stager(caps, deps.blobs, policy)
  const state: { kind: "unknown" | "tar" | "pdf" | "single"; tar: TarReader | null } = {
    kind: "unknown",
    tar: null,
  }
  const single: Uint8Array[] = []
  let singleSize = 0
  const decoders: Gunzip[] = []
  const gunzip = (next: (chunk: Uint8Array) => void): Gunzip => {
    let out = 0
    const gz = new Gunzip((chunk) => {
      out += chunk.byteLength
      if (out > caps.inflatedBytes) throw new ArchiveError("inflated")
      next(chunk)
    })
    decoders.push(gz)
    return gz
  }
  // What is left once every gzip layer is off: a tar, a PDF, or one file.
  const payload = sniff(BLOCK, (head) => {
    if (looksLikePdf(head)) {
      state.kind = "pdf"
      return () => {}
    }
    if (isTar(head)) {
      const tar = new TarReader({ maxFiles: caps.files, maxBytes: caps.inflatedBytes }, stager)
      state.kind = "tar"
      state.tar = tar
      return (chunk) => tar.push(chunk)
    }
    state.kind = "single"
    return (chunk) => {
      singleSize += chunk.byteLength
      if (singleSize > caps.singleFileBytes) throw new ArchiveError("single")
      single.push(chunk)
    }
  })
  // A gzipped body can hold a gzipped file.
  const inflated = sniff(2, (head) => {
    if (!isGzip(head)) return (chunk) => payload.push(chunk)
    const inner = gunzip((chunk) => payload.push(chunk))
    return (chunk) => inner.push(chunk)
  })
  const raw = sniff(5, (head) => {
    if (looksLikePdf(head)) {
      state.kind = "pdf"
      return () => {}
    }
    if (!isGzip(head)) return (chunk) => payload.push(chunk)
    const outer = gunzip((chunk) => inflated.push(chunk))
    return (chunk) => outer.push(chunk)
  })
  const inflating = (work: () => void): void => {
    try {
      work()
    } catch (error) {
      throw isInflateError(error) ? new ArchiveError("corrupt") : error
    }
  }

  // Read through a call: the sniffers set the kind from inside callbacks, where narrowing
  // cannot follow it.
  const isPdf = (): boolean => state.kind === "pdf"

  const deadline = Date.now() + caps.deadlineMs
  let compressed = 0
  try {
    for (;;) {
      const { done, value } = await readSoon(reader, deadline)
      if (done) break
      compressed += value.byteLength
      if (compressed > caps.compressedBytes) throw new ArchiveError("compressed")
      for (let at = 0; at < value.byteLength; at += SLICE_BYTES) {
        inflating(() => raw.push(value.subarray(at, at + SLICE_BYTES)))
        await stager.settle()
        await deps.heartbeat?.()
      }
      if (isPdf()) break
    }
    if (isPdf()) {
      await reader.cancel().catch(() => undefined)
      return { kind: "pdf" }
    }
    inflating(() => {
      raw.end()
      const [outer] = decoders
      if (outer) {
        outer.push(EMPTY, true)
        inflated.end()
      }
      decoders[1]?.push(EMPTY, true)
      payload.end()
      state.tar?.finish()
    })
    if (state.kind === "pdf") return { kind: "pdf" }
    const files = await stager.drain()
    if (state.kind === "tar") return { kind: "tar", files }
    return { kind: "single", bytes: concatChunks(single, singleSize) }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    await stager.abandon()
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // A read still pending after a stall; the cancel above already ended the body.
    }
  }
}
