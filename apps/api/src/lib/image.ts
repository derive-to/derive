// Avatar and asset uploads. We accept only formats whose bytes can't execute, and
// identify them by magic bytes rather than the client-supplied content-type.
// SVG is deliberately rejected: an uploaded SVG served from our own origin could
// carry script and run if opened directly (stored XSS), so it never gets stored.

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024 // 2 MB

// A standalone bundle asset (a screenshot, a diagram) can be much larger than an
// avatar but is still bounded well under the 100MB raw-upload / 50MB unzipped-bundle
// caps, so one asset can never fill a bundle on its own.
export const MAX_ASSET_BYTES = 25 * 1024 * 1024 // 25 MB

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp"

/** Identify a supported raster image by its magic bytes, or null if unsupported. */
export const sniffImageType = (b: Uint8Array): ImageType | null => {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png"
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return "image/gif"
  // RIFF<4 bytes>WEBP
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp"
  return null
}

/** Pixel dimensions read out of an image's header. */
export interface ImageSize {
  width: number
  height: number
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
const u32be = (b: Uint8Array, i: number) =>
  ((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, i: number) =>
  (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)

/**
 * Read an image's pixel dimensions from its HEADER — no decode, no dependency, and safe
 * on Workers (there is no image library here and `sharp` does not run in that runtime).
 * A natural extension of the magic-byte sniffing above: same "trust the bytes, not the
 * client" posture, just reading a few more of them.
 *
 * Dimensions are what make an upload's real cost legible: bytes alone do not say whether
 * a 4MB screenshot is 4000px of detail or a needlessly doubled retina export, and pixel
 * count (not re-encoding) is the lever that actually shrinks one.
 *
 * Returns null for anything it cannot read confidently — a truncated header, a format
 * variant it does not know, an unsupported type. NEVER throws: this runs on the upload
 * path, where a malformed image must produce a missing dimension, not a failed request.
 */
export const imageDimensions = (b: Uint8Array): ImageSize | null => {
  const type = sniffImageType(b)
  const ok = (width: number, height: number): ImageSize | null =>
    width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)
      ? { width, height }
      : null
  try {
    if (type === "image/png") {
      // The IHDR chunk is mandatory and first: 8-byte signature, 4-byte length, "IHDR",
      // then width/height as big-endian u32.
      if (b.length < 24) return null
      return ok(u32be(b, 16), u32be(b, 20))
    }
    if (type === "image/gif") {
      // Logical screen descriptor, little-endian u16 pair right after the 6-byte header.
      if (b.length < 10) return null
      return ok(u16le(b, 6), u16le(b, 8))
    }
    if (type === "image/webp") {
      // Three sub-formats, distinguished by the fourcc at byte 12.
      const tag = String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0)
      if (tag === "VP8 " && b.length >= 30)
        // Lossy: 16-bit width/height at 26/28, top 2 bits are scaling.
        return ok(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff)
      if (tag === "VP8L" && b.length >= 25) {
        // Lossless: 14 bits each, packed little-endian starting at byte 21.
        const bits = u32be(b, 21)
        const le =
          ((bits >>> 24) & 0xff) |
          (((bits >>> 16) & 0xff) << 8) |
          (((bits >>> 8) & 0xff) << 16) |
          ((bits & 0xff) << 24)
        return ok((le & 0x3fff) + 1, ((le >>> 14) & 0x3fff) + 1)
      }
      if (tag === "VP8X" && b.length >= 30)
        // Extended: 24-bit canvas width/height minus one, at 24/27.
        return ok(u24le(b, 24) + 1, u24le(b, 27) + 1)
      return null
    }
    if (type === "image/jpeg") {
      // Walk the marker segments to the first Start-Of-Frame, which carries the size.
      // Bounded by the buffer, and every step advances, so a malformed file terminates.
      let i = 2
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++ // resync rather than trusting a byte that should have been a marker
          continue
        }
        const marker = b[i + 1] ?? 0
        // Standalone markers (no length payload): padding, RSTn, SOI, EOI.
        if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd9)) {
          i += 2
          continue
        }
        const len = u16be(b, i + 2)
        if (len < 2) return null
        // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
        const isSof =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (isSof) return ok(u16be(b, i + 7), u16be(b, i + 5))
        i += 2 + len
      }
      return null
    }
  } catch {
    return null
  }
  return null
}

export interface AssetCostOptions {
  /** The uploaded image before optimization, present only when different bytes were stored. */
  source?: { bytes: number; size: ImageSize | null }
  /** Original bytes were intentionally stored (explicitly, or because this is Node). */
  fullSize?: boolean
}

/** A human-readable receipt for the bytes every artifact viewer will download. */
export const assetCostNote = (
  bytes: number,
  size: ImageSize | null,
  options: AssetCostOptions = {},
): string => {
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)}MB`
  const kb = (n: number) => `${Math.round(n / 1024)}KB`
  const show = (n: number) => (n >= 1024 * 1024 ? mb(n) : kb(n))
  const dimensions = (s: ImageSize | null) => (s ? ` at ${s.width}×${s.height}` : "")
  if (options.source) {
    const saved = Math.max(0, Math.round((1 - bytes / options.source.bytes) * 100))
    return `Optimized ${show(options.source.bytes)}${dimensions(options.source.size)} to ${show(bytes)}${dimensions(size)} (${saved}% smaller). Every viewer downloads the optimized asset on every load.`
  }
  return `Stored${options.fullSize ? " full size" : ""} ${show(bytes)}${dimensions(size)}. Every viewer downloads this on every load.`
}

export type AssetType = ImageType | "font/woff2" | "font/woff"

/**
 * Identify a supported standalone asset — a raster image or a packaged web font —
 * by its magic bytes. Fonts share the rasters' stored-XSS posture (non-executable
 * bytes served under a fixed content-type + nosniff); SVG/HTML stay out. Avatars
 * are stricter and keep using sniffImageType directly.
 */
export const sniffAssetType = (b: Uint8Array): AssetType | null => {
  const image = sniffImageType(b)
  if (image) return image
  // wOF2 / wOFF
  if (b.length >= 4 && b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46) {
    if (b[3] === 0x32) return "font/woff2"
    if (b[3] === 0x46) return "font/woff"
  }
  return null
}
