import { describe, expect, it } from "vitest"
import { isTar, TarError, tarSync, untar } from "./tar"

const enc = new TextEncoder()
const CAPS = { maxFiles: 100, maxBytes: 1024 * 1024 }

/** A hand-built header for the shapes tarSync never writes (links, long names, bad sums). */
const header = (
  name: Uint8Array,
  size: number,
  type: string,
  opts: { badSum?: boolean; base256?: boolean; prefix?: string } = {},
): Uint8Array => {
  const h = new Uint8Array(512)
  h.set(name.subarray(0, 100), 0)
  h.set(enc.encode("0000644\0"), 100)
  h.set(enc.encode("0000000\0"), 108)
  h.set(enc.encode("0000000\0"), 116)
  if (opts.base256) {
    h[124] = 0x80
    let v = size
    for (let i = 135; i > 124; i--) {
      h[i] = v & 0xff
      v = Math.floor(v / 256)
    }
  } else h.set(enc.encode(`${size.toString(8).padStart(11, "0")}\0`), 124)
  h.set(enc.encode("00000000000\0"), 136)
  h[156] = type.charCodeAt(0)
  h.set(enc.encode("ustar\0"), 257)
  h.set(enc.encode("00"), 263)
  if (opts.prefix) h.set(enc.encode(opts.prefix), 345)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0)
  if (opts.badSum) sum += 1
  h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148)
  return h
}

const padded = (data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(Math.ceil(data.byteLength / 512) * 512)
  out.set(data)
  return out
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

const entry = (
  name: string | Uint8Array,
  body: string | Uint8Array,
  type = "0",
  opts: Parameters<typeof header>[3] = {},
): Uint8Array => {
  const data = typeof body === "string" ? enc.encode(body) : body
  return concat(
    header(typeof name === "string" ? enc.encode(name) : name, data.byteLength, type, opts),
    padded(data),
  )
}

const trailer = new Uint8Array(1024)

const byPath = (bytes: Uint8Array, caps = CAPS): Record<string, string> =>
  Object.fromEntries(untar(bytes, caps).map((e) => [e.path, new TextDecoder().decode(e.data)]))

describe("untar", () => {
  it("reads regular files, keeps binary bytes intact, and detects the magic", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0x1a, 0xff, 0x00])
    const tar = tarSync({ "paper/main.tex": "\\documentclass{article}", "paper/fig.png": png })
    expect(isTar(tar)).toBe(true)
    expect(isTar(enc.encode("%PDF-1.4"))).toBe(false)
    const entries = untar(tar, CAPS)
    expect(entries.map((e) => e.path)).toEqual(["paper/main.tex", "paper/fig.png"])
    expect([...(entries[1]?.data ?? [])]).toEqual([...png])
  })

  it("joins the ustar prefix, and reads GNU long names and pax path/size records", () => {
    const deep = `${"d/".repeat(60)}main.tex`
    const paxRecord = `${9 + 5 + deep.length + 1} path=${deep}\n`
    const tar = concat(
      entry("main.tex", "root", "0", { prefix: "nested/dir" }),
      entry("././@LongLink", `${deep}\0`, "L"),
      entry("short.tex", "gnu-long"),
      entry("././@PaxHeader", paxRecord, "x"),
      entry("short2.tex", "pax-long"),
      trailer,
    )
    const files = byPath(tar)
    expect(files["nested/dir/main.tex"]).toBe("root")
    expect(files[deep]).toBe("gnu-long")
    expect(files["short.tex"]).toBeUndefined()
    expect(Object.values(files)).toContain("pax-long")
    expect(Object.keys(files)).toHaveLength(3)
  })

  it("skips links, directories, devices and global pax headers with their data", () => {
    const tar = concat(
      entry("dir/", "", "5"),
      entry("link.tex", "", "2"),
      entry("hard.tex", "", "1"),
      entry("dev", "", "3"),
      entry("pax_global_header", "20 comment=ignored\n", "g"),
      entry("kept.tex", "x"),
      trailer,
    )
    expect(byPath(tar)).toEqual({ "kept.tex": "x" })
  })

  it("passes odd names through for the caller to clean, and skips undecodable ones", () => {
    const tar = concat(
      entry("../escape.tex", "a"),
      entry("/abs/main.tex", "b"),
      entry("win\\style.tex", "c"),
      entry(new Uint8Array([0xff, 0xfe, 0x2e, 0x74, 0x65, 0x78]), "d"),
      entry("ok.tex", "e"),
      trailer,
    )
    expect(byPath(tar)).toEqual({
      "../escape.tex": "a",
      "/abs/main.tex": "b",
      "win\\style.tex": "c",
      "ok.tex": "e",
    })
  })

  it("lets a later duplicate win and counts its bytes once", () => {
    const tar = concat(entry("a.tex", "first"), entry("a.tex", "second!"), trailer)
    expect(byPath(tar, { maxFiles: 1, maxBytes: 7 })).toEqual({ "a.tex": "second!" })
  })

  it("reads base-256 sizes and tolerates a missing trailer", () => {
    const tar = entry("big.tex", "x".repeat(600), "0", { base256: true })
    expect(byPath(tar)).toEqual({ "big.tex": "x".repeat(600) })
  })

  it("throws on a bad checksum or a truncated entry", () => {
    const bad = concat(entry("a.tex", "a", "0", { badSum: true }), trailer)
    expect(() => untar(bad, CAPS)).toThrow(TarError)
    expect(() => untar(bad, CAPS)).toThrow(/checksum/)
    const truncated = concat(header(enc.encode("a.tex"), 5000, "0"), enc.encode("short"))
    expect(() => untar(truncated, CAPS)).toThrow(/truncated/)
  })

  it("enforces the file and byte caps while walking", () => {
    const many = tarSync({ "a.tex": "1", "b.tex": "2", "c.tex": "3" })
    expect(() => untar(many, { maxFiles: 2, maxBytes: 100 })).toThrow(
      expect.objectContaining({ code: "too_many_files" }),
    )
    const big = tarSync({ "a.tex": "x".repeat(600), "b.tex": "y".repeat(600) })
    expect(() => untar(big, { maxFiles: 10, maxBytes: 1000 })).toThrow(
      expect.objectContaining({ code: "too_large" }),
    )
    // A header that claims more than the cap fails before any copy.
    const claim = concat(header(enc.encode("a.tex"), 10 ** 9, "0"), new Uint8Array(512))
    expect(() => untar(claim, { maxFiles: 10, maxBytes: 1000 })).toThrow(TarError)
  })
})
