// Avatar uploads. We accept only raster formats whose bytes can't execute, and
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
