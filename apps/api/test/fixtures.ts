/**
 * Shared binary test fixtures — import these instead of pasting base64 blobs, so
 * every test provably exercises the SAME bytes (fixture drift between copies is
 * invisible in a diff of base64 strings).
 */

/** A real 1x1 transparent PNG: small enough to inline, real enough to pass
 *  sniffAssetType's magic-byte check and round-trip through the asset pipeline. */
export const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
export const PNG_BYTES = new Uint8Array(Buffer.from(PNG_B64, "base64"))

/** The 8-byte PNG file signature, for asserting stored bytes are a real PNG. */
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
