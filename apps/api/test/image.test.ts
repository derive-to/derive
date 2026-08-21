import { describe, expect, it } from "vitest"
import { imageDimensions, sniffAssetType, sniffImageType } from "../src/lib/image"

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

describe("sniffAssetType — rasters plus packaged web fonts", () => {
  const WOFF2 = text("wOF2")
  const WOFF = text("wOFF")

  it("identifies woff2 and woff by magic bytes", () => {
    expect(sniffAssetType(bytes(...WOFF2, 0, 0, 0, 0))).toBe("font/woff2")
    expect(sniffAssetType(bytes(...WOFF, 0, 0, 0, 0))).toBe("font/woff")
  })

  it("rejects ttf/otf (no self-describing magic worth trusting) and truncated font headers", () => {
    expect(sniffAssetType(bytes(0x00, 0x01, 0x00, 0x00))).toBeNull() // raw ttf
    expect(sniffAssetType(text("OTTO"))).toBeNull() // raw otf
    expect(sniffAssetType(text("wOF"))).toBeNull() // one byte short
  })

  it("still rejects markup — fonts don't open the SVG/HTML door", () => {
    expect(sniffAssetType(text("<!doctype html><html></html>"))).toBeNull()
    expect(sniffAssetType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })

  it("avatars remain image-only: sniffImageType does not accept fonts", () => {
    expect(sniffImageType(bytes(...WOFF2, 0, 0, 0, 0))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Header-only dimension reading on the upload path: malformed or hostile bytes return
// null and never throw or spin.
describe("imageDimensions", () => {
  // Header-only dimension reading: no decode, no dependency, safe on Workers (there is no
  // image library here and sharp does not run in that runtime). Fixtures are hand-built
  // byte arrays rather than checked-in images, so the test states exactly which bytes carry
  // the meaning — and a malformed header must yield null, never a throw, because this runs
  // on the upload path.

  const png = (w: number, h: number) => {
    const b = new Uint8Array(24)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) // signature
    b.set([0, 0, 0, 13], 8) // IHDR length
    b.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
    new DataView(b.buffer).setUint32(16, w)
    new DataView(b.buffer).setUint32(20, h)
    return b
  }

  it("returns null rather than throwing on anything it cannot read", () => {
    expect(imageDimensions(new Uint8Array(0))).toBeNull()
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(imageDimensions(png(10, 10).slice(0, 16))).toBeNull() // truncated IHDR
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull() // JPEG, no SOF
    // A font is a supported ASSET but has no pixels.
    expect(imageDimensions(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBeNull()
    // Random bytes that happen to start like a marker must terminate, not spin.
    expect(imageDimensions(new Uint8Array(2048).fill(0xff))).toBeNull()
  })
})
