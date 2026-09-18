/**
 * A tar reader for the archives an import unpacks: arXiv source tarballs and repository
 * tarballs.
 *
 * Both come from a third party and are unpacked in a worker with a memory budget. So the
 * reader is fed an archive a piece at a time as it inflates (`TarReader`) and hands each
 * file's data straight on, holding nothing of its own but one header and, while it reads
 * one, a long name or pax record. It verifies every header checksum and enforces the
 * caller's file and byte caps from the headers, before an entry's data arrives, stopping at
 * the first entry that would cross either. It understands what arXiv writes: ustar headers
 * with the prefix field, GNU long names, pax extended headers (`path`, `size`), pax global
 * headers (kept in `globals`: a git archive names its commit in `comment`), base-256 sizes.
 * Links, directories, devices and unknown types skip their data. Names that are not
 * valid UTF-8 skip their entry. A later entry with the same name wins, as `tar x` would
 * leave it. `untar` is the same reader over one buffer, returning views of it.
 */

export interface TarEntry {
  /** The entry name as written, slashes forward; the caller cleans it. */
  path: string
  data: Uint8Array
}

export interface TarCaps {
  maxFiles: number
  maxBytes: number
}

export type TarErrorCode = "too_many_files" | "too_large" | "malformed"

export class TarError extends Error {
  constructor(
    public code: TarErrorCode,
    message: string,
  ) {
    super(message)
  }
}

const BLOCK = 512
/** The longest GNU long name or pax record the reader holds. A real one is a few hundred
 *  bytes; an archive that needs more is not one a paper or a repository ships. */
const MAX_META_BYTES = 1024 * 1024

/** A ustar/GNU magic at offset 257, the cheapest test that a buffer is a tar. */
export const isTar = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= BLOCK &&
  bytes[257] === 0x75 &&
  bytes[258] === 0x73 &&
  bytes[259] === 0x74 &&
  bytes[260] === 0x61 &&
  bytes[261] === 0x72

const latin1 = new TextDecoder("latin1")
const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
const utf8 = new TextDecoder()

const field = (h: Uint8Array, at: number, len: number): Uint8Array => {
  let end = at
  while (end < at + len && h[end] !== 0) end++
  return h.subarray(at, end)
}

const fieldText = (h: Uint8Array, at: number, len: number): string =>
  latin1.decode(field(h, at, len))

/** Octal (`0000644\0`) or GNU base-256 (high bit set on the first byte). Null when the
 *  field holds neither. */
const numeric = (h: Uint8Array, at: number, len: number): number | null => {
  const first = h[at] ?? 0
  if (first & 0x80) {
    let v = first & 0x7f
    for (let i = at + 1; i < at + len; i++) {
      v = v * 256 + (h[i] ?? 0)
      if (v > Number.MAX_SAFE_INTEGER) return null
    }
    return v
  }
  const text = fieldText(h, at, len).trim()
  if (text === "") return 0
  if (!/^[0-7]+$/.test(text)) return null
  return Number.parseInt(text, 8)
}

const isZeroBlock = (h: Uint8Array): boolean => {
  for (let i = 0; i < BLOCK; i++) if (h[i] !== 0) return false
  return true
}

/** Sum every header byte with the checksum field read as spaces; tar writers disagree
 *  on signed versus unsigned bytes, so both sums are accepted. */
const checksumOk = (h: Uint8Array): boolean => {
  const stored = numeric(h, 148, 8)
  if (stored === null) return false
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0)
    unsigned += b
    signed += b < 128 ? b : b - 256
  }
  return stored === unsigned || stored === signed
}

/** `<len> <key>=<value>\n` records, the length counting the whole record. */
const paxRecords = (data: Uint8Array): Map<string, string> => {
  const out = new Map<string, string>()
  let at = 0
  while (at < data.byteLength) {
    let sp = at
    while (sp < data.byteLength && data[sp] !== 0x20) sp++
    const len = Number.parseInt(latin1.decode(data.subarray(at, sp)), 10)
    if (!Number.isFinite(len) || len <= 0 || at + len > data.byteLength) break
    const record = data.subarray(sp + 1, at + len)
    let text: string
    try {
      text = utf8Strict.decode(record)
    } catch {
      at += len
      continue
    }
    const eq = text.indexOf("=")
    if (eq > 0) out.set(text.slice(0, eq), text.slice(eq + 1).replace(/\n$/, ""))
    at += len
  }
  return out
}

/** The name an entry goes by: a pax `path`, else a GNU long name, else the ustar name
 *  joined to its prefix. Null when that is not valid UTF-8. */
const entryName = (
  h: Uint8Array,
  longName: string | null,
  pax: Map<string, string> | null,
): string | null => {
  const given = pax?.get("path") ?? longName
  if (given !== null) return given
  try {
    const base = utf8Strict.decode(field(h, 0, 100))
    const magic = fieldText(h, 257, 6)
    const prefix = magic.startsWith("ustar") ? utf8Strict.decode(field(h, 345, 155)) : ""
    return prefix ? `${prefix}/${base}` : base
  } catch {
    return null
  }
}

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** Where the reader hands an archive's regular files as they stream in. */
export interface TarSink {
  /** A regular file begins. Return false to skip its data; it still counts toward the caps. */
  entry(path: string, size: number): boolean
  /** The next piece of the current file: a view of the chunk being pushed, valid only until
   *  `push` returns, so copy it to keep it. */
  data(piece: Uint8Array): void
  /** The current file's data is complete. */
  end(): void
}

type Body = "deliver" | "skip" | "longname" | "pax" | "global"

/**
 * Read a tar fed in pieces of any size: `push` each as it arrives, then `finish`. Either
 * throws `TarError` when the archive is malformed (a bad checksum, a file cut short by the
 * end of the archive) or crosses a cap; the caller maps those to its own failure codes. A
 * trailer that never arrives is not an error, and nothing after the first empty block is
 * read.
 */
export class TarReader {
  private readonly head = new Uint8Array(BLOCK)
  private headFill = 0
  private mode: "header" | "body" | "pad" | "done" = "header"
  private body: Body = "skip"
  private isFile = false
  private remaining = 0
  private padding = 0
  private meta: Uint8Array | null = null
  private metaFill = 0
  private longName: string | null = null
  private pax: Map<string, string> | null = null
  private readonly globalRecords = new Map<string, string>()
  private readonly sizes = new Map<string, number>()
  private total = 0

  constructor(
    private readonly caps: TarCaps,
    private readonly sink: TarSink,
  ) {}

  /** The bytes the reader holds of its own: a partial header, and a long name or pax record
   *  while it reads one. Everything else went straight to the sink. */
  get buffered(): number {
    return this.headFill + this.metaFill
  }

  /** The records of the archive's pax global headers, which describe the whole archive
   *  rather than one entry. `git archive` writes the commit it archived as `comment`. */
  get globals(): ReadonlyMap<string, string> {
    return this.globalRecords
  }

  push(chunk: Uint8Array): void {
    let at = 0
    while (at < chunk.byteLength && this.mode !== "done") {
      const left = chunk.byteLength - at
      if (this.mode === "header") {
        const n = Math.min(BLOCK - this.headFill, left)
        this.head.set(chunk.subarray(at, at + n), this.headFill)
        this.headFill += n
        at += n
        if (this.headFill === BLOCK) {
          this.headFill = 0
          this.header()
        }
      } else if (this.mode === "body") {
        const n = Math.min(this.remaining, left)
        const piece = chunk.subarray(at, at + n)
        if (this.body === "deliver") this.sink.data(piece)
        else if (this.meta) {
          this.meta.set(piece, this.metaFill)
          this.metaFill += n
        }
        this.remaining -= n
        at += n
        if (this.remaining === 0) this.bodyDone()
      } else {
        const n = Math.min(this.padding, left)
        this.padding -= n
        at += n
        if (this.padding === 0) this.mode = "header"
      }
    }
  }

  finish(): void {
    const cutShort = this.mode === "body" && this.isFile
    this.mode = "done"
    if (cutShort) throw new TarError("malformed", "tar entry is truncated")
  }

  private header(): void {
    const h = this.head
    if (isZeroBlock(h)) {
      this.mode = "done"
      return
    }
    if (!checksumOk(h)) throw new TarError("malformed", "tar header checksum mismatch")
    const type = h[156] ?? 0
    const paxSize = this.pax?.get("size")
    const size = paxSize !== undefined ? Number(paxSize) : numeric(h, 124, 12)
    if (size === null || !Number.isFinite(size) || size < 0)
      throw new TarError("malformed", "tar entry size unreadable")
    this.remaining = size
    this.padding = Math.ceil(size / BLOCK) * BLOCK - size
    this.isFile = type === 0 || type === 0x30 || type === 0x37
    if (type === 0x4c || type === 0x78 || type === 0x67) {
      // GNU 'L' names the next entry; pax 'x' carries records for it, and pax 'g' records
      // for the whole archive.
      if (size > MAX_META_BYTES)
        throw new TarError("malformed", "tar long name or pax record is too large")
      this.meta = new Uint8Array(size)
      this.metaFill = 0
      this.begin(type === 0x4c ? "longname" : type === 0x78 ? "pax" : "global")
      return
    }
    const longName = this.longName
    const pax = this.pax
    this.longName = null
    this.pax = null
    if (!this.isFile) {
      this.begin("skip")
      return
    }
    const name = entryName(h, longName, pax)
    if (name === null || name === "") {
      this.begin("skip")
      return
    }
    const previous = this.sizes.get(name)
    if (previous === undefined && this.sizes.size + 1 > this.caps.maxFiles)
      throw new TarError("too_many_files", `tar exceeds ${this.caps.maxFiles} files`)
    this.total += size - (previous ?? 0)
    if (this.total > this.caps.maxBytes)
      throw new TarError("too_large", "tar is too large once unpacked")
    this.sizes.set(name, size)
    this.begin(this.sink.entry(name, size) ? "deliver" : "skip")
  }

  private begin(body: Body): void {
    this.body = body
    this.mode = "body"
    if (this.remaining === 0) this.bodyDone()
  }

  private bodyDone(): void {
    if (this.body === "deliver") this.sink.end()
    else if (this.meta) {
      const data = this.meta.subarray(0, this.metaFill)
      if (this.body === "longname") {
        try {
          let end = data.byteLength
          while (end > 0 && data[end - 1] === 0) end--
          this.longName = utf8Strict.decode(data.subarray(0, end))
        } catch {
          this.longName = null
        }
      } else if (this.body === "global") {
        for (const [key, value] of paxRecords(data)) this.globalRecords.set(key, value)
      } else this.pax = paxRecords(data)
      this.meta = null
      this.metaFill = 0
    }
    this.mode = this.padding > 0 ? "pad" : "header"
  }
}

/**
 * Read every regular file in a tar held in one buffer. Throws `TarError` when the archive
 * is malformed or crosses a cap. Each file comes back as a view of `bytes`, never a copy.
 */
export const untar = (bytes: Uint8Array, caps: TarCaps): TarEntry[] => {
  const files = new Map<string, Uint8Array>()
  let path = ""
  let parts: Uint8Array[] = []
  const reader = new TarReader(caps, {
    entry: (name) => {
      path = name
      parts = []
      return true
    },
    data: (piece) => {
      parts.push(piece)
    },
    end: () => {
      // Pushed as one buffer, a file arrives as one view of it.
      files.set(path, parts.length === 1 ? (parts[0] as Uint8Array) : concatBytes(parts))
    },
  })
  reader.push(bytes)
  reader.finish()
  return [...files.entries()].map(([path, data]) => ({ path, data }))
}

const enc = new TextEncoder()

/** A plain ustar header block, the name split at a slash when it needs the prefix field. */
const ustarHeader = (path: string, size: number, type: number): Uint8Array => {
  const h = new Uint8Array(BLOCK)
  const nameBytes = enc.encode(path)
  if (nameBytes.byteLength > 100) {
    // Split at a slash so the name fits ustar's 100 + 155 fields.
    const text = utf8.decode(nameBytes)
    const cut = text.lastIndexOf("/", 155)
    if (cut <= 0) throw new Error("tarSync: name too long")
    h.set(enc.encode(text.slice(0, cut)), 345)
    h.set(enc.encode(text.slice(cut + 1)), 0)
  } else h.set(nameBytes, 0)
  h.set(enc.encode("0000644\0"), 100)
  h.set(enc.encode("0000000\0"), 108)
  h.set(enc.encode("0000000\0"), 116)
  h.set(enc.encode(`${size.toString(8).padStart(11, "0")}\0`), 124)
  h.set(enc.encode("00000000000\0"), 136)
  h[156] = type
  h.set(enc.encode("ustar\0"), 257)
  h.set(enc.encode("00"), 263)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0)
  h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148)
  return h
}

/** One pax record, `<len> <key>=<value>\n`, its length counting its own digits. */
const paxRecord = (key: string, value: string): Uint8Array => {
  const body = enc.encode(` ${key}=${value}\n`)
  let digits = String(body.byteLength).length
  while (String(body.byteLength + digits).length !== digits) digits++
  return concatBytes([enc.encode(String(body.byteLength + digits)), body])
}

/** A tiny tar writer for tests and fixtures: plain ustar, regular files only, and optionally
 *  a pax global header first, the way `git archive` records the commit it archived. */
export const tarSync = (
  entries: Record<string, Uint8Array | string>,
  opts: { global?: Record<string, string> } = {},
): Uint8Array => {
  const blocks: Uint8Array[] = []
  const add = (header: Uint8Array, data: Uint8Array): void => {
    blocks.push(header, data)
    const pad = (BLOCK - (data.byteLength % BLOCK)) % BLOCK
    if (pad) blocks.push(new Uint8Array(pad))
  }
  if (opts.global) {
    const records = concatBytes(Object.entries(opts.global).map(([k, v]) => paxRecord(k, v)))
    add(ustarHeader("pax_global_header", records.byteLength, 0x67), records)
  }
  for (const [path, raw] of Object.entries(entries)) {
    const data = typeof raw === "string" ? enc.encode(raw) : raw
    add(ustarHeader(path, data.byteLength, 0x30), data)
  }
  blocks.push(new Uint8Array(BLOCK * 2))
  return concatBytes(blocks)
}
