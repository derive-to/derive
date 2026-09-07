/**
 * A tar reader for arXiv source archives.
 *
 * arXiv serves a paper's source as a gzipped tar (or one gzipped file). The archive comes
 * from a third party and is inflated in a worker with a memory budget, so this reader
 * walks the headers over views of one buffer, never copies an entry, verifies every
 * header checksum, and enforces the caller's file and byte caps while it walks, stopping
 * at the first entry that would cross either. It understands what arXiv writes: ustar
 * headers with the prefix field, GNU long names, pax extended headers (`path`, `size`),
 * base-256 sizes. Links, directories, devices and unknown types skip their data. Names
 * that are not valid UTF-8 skip their entry. A later entry with the same name wins, as
 * `tar x` would leave it.
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

/** A ustar/GNU magic at offset 257, the cheapest test that a buffer is a tar. */
export const isTar = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= BLOCK &&
  bytes[257] === 0x75 &&
  bytes[258] === 0x73 &&
  bytes[259] === 0x74 &&
  bytes[260] === 0x61 &&
  bytes[261] === 0x72

const latin1 = new TextDecoder("latin1")
const utf8Strict = new TextDecoder("utf-8", { fatal: true })
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

/**
 * Read every regular file in a tar. Throws `TarError` when the archive is malformed
 * (a bad checksum, a truncated entry) or crosses a cap; the caller maps those to its
 * own failure codes.
 */
export const untar = (bytes: Uint8Array, caps: TarCaps): TarEntry[] => {
  const files = new Map<string, Uint8Array>()
  let total = 0
  let at = 0
  let longName: string | null = null
  let pax: Map<string, string> | null = null
  while (at + BLOCK <= bytes.byteLength) {
    const h = bytes.subarray(at, at + BLOCK)
    if (isZeroBlock(h)) break
    if (!checksumOk(h)) throw new TarError("malformed", "tar header checksum mismatch")
    const type = h[156] ?? 0
    const paxSize = pax?.get("size")
    const size = paxSize !== undefined ? Number(paxSize) : numeric(h, 124, 12)
    if (size === null || !Number.isFinite(size) || size < 0)
      throw new TarError("malformed", "tar entry size unreadable")
    const dataAt = at + BLOCK
    const dataEnd = dataAt + size
    at = dataAt + Math.ceil(size / BLOCK) * BLOCK
    const isFile = type === 0 || type === 0x30 || type === 0x37
    if (dataEnd > bytes.byteLength) {
      if (!isFile) break
      throw new TarError("malformed", "tar entry is truncated")
    }
    const data = bytes.subarray(dataAt, dataEnd)
    if (type === 0x4c) {
      // GNU 'L': the next entry's name.
      try {
        longName = utf8Strict.decode(data).replace(/\0+$/, "")
      } catch {
        longName = null
      }
      continue
    }
    if (type === 0x78) {
      // pax 'x': records for the next entry.
      pax = paxRecords(data)
      continue
    }
    const pending = { longName, pax }
    longName = null
    pax = null
    if (!isFile) continue
    let name: string | null = pending.pax?.get("path") ?? pending.longName ?? null
    if (name === null) {
      try {
        const base = utf8Strict.decode(field(h, 0, 100))
        const magic = fieldText(h, 257, 6)
        const prefix = magic.startsWith("ustar") ? utf8Strict.decode(field(h, 345, 155)) : ""
        name = prefix ? `${prefix}/${base}` : base
      } catch {
        name = null
      }
    }
    if (name === null || name === "") continue
    if (!files.has(name) && files.size + 1 > caps.maxFiles)
      throw new TarError("too_many_files", `tar exceeds ${caps.maxFiles} files`)
    const previous = files.get(name)
    total += size - (previous?.byteLength ?? 0)
    if (total > caps.maxBytes) throw new TarError("too_large", "tar is too large once unpacked")
    files.set(name, data)
  }
  return [...files.entries()].map(([path, data]) => ({ path, data }))
}

/** A tiny tar writer for tests and fixtures: plain ustar, regular files only. */
export const tarSync = (entries: Record<string, Uint8Array | string>): Uint8Array => {
  const blocks: Uint8Array[] = []
  const enc = new TextEncoder()
  for (const [path, raw] of Object.entries(entries)) {
    const data = typeof raw === "string" ? enc.encode(raw) : raw
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
    h.set(enc.encode(`${data.byteLength.toString(8).padStart(11, "0")}\0`), 124)
    h.set(enc.encode("00000000000\0"), 136)
    h[156] = 0x30
    h.set(enc.encode("ustar\0"), 257)
    h.set(enc.encode("00"), 263)
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0)
    h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148)
    blocks.push(h, data)
    const pad = (BLOCK - (data.byteLength % BLOCK)) % BLOCK
    if (pad) blocks.push(new Uint8Array(pad))
  }
  blocks.push(new Uint8Array(BLOCK * 2))
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.byteLength, 0))
  let at = 0
  for (const b of blocks) {
    out.set(b, at)
    at += b.byteLength
  }
  return out
}
