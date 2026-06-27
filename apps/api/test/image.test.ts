import { describe, expect, it } from "vitest"
import { MAX_AVATAR_BYTES, sniffImageType } from "../src/lib/image"

const bytes = (...vals: number[]) => Uint8Array.from(vals)
const text = (s: string) => new TextEncoder().encode(s)

// Minimal real magic-byte headers for each accepted raster format.
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)
const GIF89a = text("GIF89a")
const GIF87a = text("GIF87a")
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50) // RIFF....WEBP

describe("sniffImageType — accepts only raster images, by magic bytes", () => {
  it("identifies each supported format from its header", () => {
    expect(sniffImageType(PNG)).toBe("image/png")
    expect(sniffImageType(JPEG)).toBe("image/jpeg")
    expect(sniffImageType(GIF89a)).toBe("image/gif")
    expect(sniffImageType(GIF87a)).toBe("image/gif") // both GIF8 variants
    expect(sniffImageType(WEBP)).toBe("image/webp")
  })

  it("ignores trailing bytes after a valid header", () => {
    expect(sniffImageType(bytes(...PNG, 1, 2, 3, 4, 5))).toBe("image/png")
  })

  it("rejects SVG outright (it can carry script -> stored XSS)", () => {
    expect(
      sniffImageType(text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')),
    ).toBeNull()
    expect(sniffImageType(text('<?xml version="1.0"?><svg>'))).toBeNull()
  })

  it("rejects non-image payloads (html, plain text, empty)", () => {
    expect(sniffImageType(text("<!doctype html><html></html>"))).toBeNull()
    expect(sniffImageType(text("just some text"))).toBeNull()
    expect(sniffImageType(bytes())).toBeNull()
  })

  it("does not mistake another RIFF container (WAV) for a WEBP image", () => {
    // Same RIFF prefix, but the subtype at bytes 8..11 is WAVE, not WEBP.
    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45)
    expect(sniffImageType(wav)).toBeNull()
  })

  it("rejects a truncated header that can't be verified in full", () => {
    expect(sniffImageType(bytes(0x89, 0x50))).toBeNull() // partial PNG (needs >= 8)
    expect(sniffImageType(bytes(0xff, 0xd8))).toBeNull() // partial JPEG (needs >= 3)
    expect(sniffImageType(WEBP.slice(0, 11))).toBeNull() // RIFF + WEB, one byte short
  })

  it("does not trust a forged header beyond its own bytes", () => {
    // PNG magic but only 4 bytes present -> the length guard still rejects it.
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull()
  })
})

describe("MAX_AVATAR_BYTES", () => {
  it("is 2 MB", () => {
    expect(MAX_AVATAR_BYTES).toBe(2 * 1024 * 1024)
  })
})
