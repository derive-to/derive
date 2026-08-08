import { describe, expect, it } from "vitest"
import { assetCostNote, imageDimensions } from "../src/lib/image"

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

const gif = (w: number, h: number) => {
  const b = new Uint8Array(10)
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0) // GIF89a
  new DataView(b.buffer).setUint16(6, w, true)
  new DataView(b.buffer).setUint16(8, h, true)
  return b
}

const webpLossy = (w: number, h: number) => {
  const b = new Uint8Array(32)
  b.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  b.set([0x56, 0x50, 0x38, 0x20], 12) // "VP8 "
  new DataView(b.buffer).setUint16(26, w, true)
  new DataView(b.buffer).setUint16(28, h, true)
  return b
}

const webpExtended = (w: number, h: number) => {
  const b = new Uint8Array(32)
  b.set([0x52, 0x49, 0x46, 0x46], 0)
  b.set([0x57, 0x45, 0x42, 0x50], 8)
  b.set([0x56, 0x50, 0x38, 0x58], 12) // "VP8X"
  const cw = w - 1
  const ch = h - 1
  b.set([cw & 0xff, (cw >> 8) & 0xff, (cw >> 16) & 0xff], 24)
  b.set([ch & 0xff, (ch >> 8) & 0xff, (ch >> 16) & 0xff], 27)
  return b
}

/** A JPEG with `segments` filler markers before the SOF0 that carries the size. */
const jpeg = (w: number, h: number, segments = 1) => {
  const parts: number[] = [0xff, 0xd8] // SOI
  for (let i = 0; i < segments; i++) parts.push(0xff, 0xe0, 0x00, 0x04, 0x00, 0x00) // APP0
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff)
  parts.push(...new Array(8).fill(0))
  return new Uint8Array(parts)
}

describe("imageDimensions", () => {
  it("reads PNG from IHDR", () => {
    expect(imageDimensions(png(1200, 630))).toEqual({ width: 1200, height: 630 })
    expect(imageDimensions(png(1, 1))).toEqual({ width: 1, height: 1 })
  })

  it("reads GIF from the logical screen descriptor (little-endian)", () => {
    expect(imageDimensions(gif(640, 480))).toEqual({ width: 640, height: 480 })
  })

  it("reads WebP, both lossy and extended", () => {
    expect(imageDimensions(webpLossy(800, 600))).toEqual({ width: 800, height: 600 })
    expect(imageDimensions(webpExtended(2916, 1834))).toEqual({ width: 2916, height: 1834 })
  })

  it("reads JPEG by walking to the first SOF, however many segments precede it", () => {
    expect(imageDimensions(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 })
    // A real photo has EXIF/JFIF/quantization tables first; the walk must survive them.
    expect(imageDimensions(jpeg(4032, 3024, 12))).toEqual({ width: 4032, height: 3024 })
  })

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

  it("rejects a zero dimension instead of reporting it", () => {
    expect(imageDimensions(png(0, 100))).toBeNull()
  })
})

describe("assetCostNote", () => {
  it("names the before/after size and dimensions when an image was optimized", () => {
    const note = assetCostNote(
      900 * 1024,
      { width: 1920, height: 1208 },
      {
        source: { bytes: 4.1 * 1024 * 1024, size: { width: 2916, height: 1834 } },
      },
    )
    expect(note).toContain("4.1MB")
    expect(note).toContain("2916×1834")
    expect(note).toContain("900KB")
    expect(note).toContain("1920×1208")
    expect(note).toContain("smaller")
  })

  it("makes an explicit full-size choice visible", () => {
    const note = assetCostNote(
      4.1 * 1024 * 1024,
      { width: 2916, height: 1834 },
      {
        fullSize: true,
      },
    )
    expect(note).toContain("full size")
    expect(note).toContain("4.1MB")
  })

  it("still reports a cost when dimensions are unreadable (a font)", () => {
    expect(assetCostNote(300 * 1024, null)).toContain("300KB")
  })
})
