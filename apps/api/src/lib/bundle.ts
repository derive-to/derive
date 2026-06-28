import {
  type BlobStore,
  type BundleManifest,
  isBundleContentType,
  PublishError,
  type VersionRecord,
} from "@dock/core"
import { zipSync } from "fflate"

// Bundle manifests store paths with a leading slash (/index.html); present them
// cleanly to callers, and accept either form on the way back in.
export const cleanPath = (p: string): string => p.replace(/^\//, "")

// A base64 data: URI — data:image/png;base64,…. The mediatype is optional and may
// carry parameters (;charset=…), so match through to the required `;base64,` marker.
const DATA_URI_BASE64 = /^data:[\w.+-]*\/?[\w.+-]*(?:;[\w.+-]+=[\w.+-]+)*;base64,/i

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64.replace(/\s+/g, ""))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Decode a {path: content} map to {path: bytes}: a value that is a base64 data: URI
 * (`data:image/png;base64,…`) becomes raw bytes, everything else is UTF-8 text — so
 * screenshots, fonts, and any binary asset that makes up a site ride the SAME map as
 * the HTML/CSS/JS pages, carried over MCP without inlining multi-MB base64 into one
 * HTML string. The served content-type comes from the path extension (mimeFor), so
 * binary entries must be named with a real extension (shot.png, logo.svg, font.woff2).
 *
 * Throws if a value looks like a base64 data: URI but isn't decodable.
 */
export const decodeBundleFiles = (files: Record<string, string>): Record<string, Uint8Array> => {
  const enc = new TextEncoder()
  const entries: Record<string, Uint8Array> = {}
  for (const [path, value] of Object.entries(files)) {
    const marker = DATA_URI_BASE64.exec(value)
    if (!marker) {
      entries[path] = enc.encode(value)
      continue
    }
    try {
      entries[path] = base64ToBytes(value.slice(marker[0].length))
    } catch {
      throw new PublishError(400, `invalid base64 data URI for "${path}"`)
    }
  }
  return entries
}

/**
 * Pack a {path: content} map into a zip the core publish path ingests exactly like an
 * HTTP bundle upload (it re-validates size, file count, paths, and entry point).
 */
export const zipBundleFiles = (files: Record<string, string>): Uint8Array =>
  zipSync(decodeBundleFiles(files))

/**
 * Build the zip for an INCREMENTAL bundle publish: every file already in the bundle
 * (read back from its blob) with `newFiles` overlaid on top by path — same path
 * overwrites, others are kept. Lets a caller add or replace a few files without
 * re-sending the whole site; the core publish path then republishes the union as one
 * new version, re-running all its size/file-count/entry-point checks. Paths are
 * normalised (leading slash stripped) so a new "shot.png" overwrites an existing
 * "/shot.png" rather than duplicating it.
 */
export const mergeBundleZip = async (
  blobs: BlobStore,
  manifest: BundleManifest,
  newFiles: Record<string, string>,
): Promise<Uint8Array> => {
  const entries: Record<string, Uint8Array> = {}
  for (const [path, entry] of Object.entries(manifest.files)) {
    const bytes = await blobs.get(entry.key)
    if (bytes) entries[cleanPath(path)] = bytes
  }
  for (const [path, bytes] of Object.entries(decodeBundleFiles(newFiles))) {
    entries[cleanPath(path)] = bytes
  }
  return zipSync(entries)
}

// A version's bundle manifest (null when it isn't a bundle / is unreadable).
export async function manifestOf(
  blobs: BlobStore,
  v: VersionRecord,
): Promise<BundleManifest | null> {
  if (!isBundleContentType(v.content_type)) return null
  const bytes = await blobs.get(v.blob_key)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as BundleManifest
  } catch {
    return null
  }
}

/**
 * Resolve the source text of one page of a version. Single-file artifact: every
 * path returns the whole document. Bundle: looks the page up in the manifest
 * (accepts a slashed or clean path); a null path resolves to the entry page.
 * Returns null when the page/blob can't be read.
 */
export async function pageTextResolver(
  blobs: BlobStore,
  v: VersionRecord,
): Promise<(path: string | null) => Promise<string | null>> {
  const manifest = await manifestOf(blobs, v)
  if (!manifest) {
    const bytes = await blobs.get(v.blob_key)
    const text = bytes ? new TextDecoder().decode(bytes) : null
    return async () => text
  }
  const keyFor = (path: string | null): string | undefined => {
    if (!path) return manifest.files[manifest.entry]?.key
    return (manifest.files[path] ?? manifest.files[`/${cleanPath(path)}`])?.key
  }
  return async (path) => {
    const key = keyFor(path)
    if (!key) return null
    const bytes = await blobs.get(key)
    return bytes ? new TextDecoder().decode(bytes) : null
  }
}
