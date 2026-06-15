import {
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  type VersionRecord,
} from "@dock/core"

// Bundle manifests store paths with a leading slash (/index.html); present them
// cleanly to callers, and accept either form on the way back in.
export const cleanPath = (p: string): string => p.replace(/^\//, "")

// A version's bundle manifest (null when it isn't a bundle / is unreadable).
export async function manifestOf(
  blobs: BlobStore,
  v: VersionRecord,
): Promise<BundleManifest | null> {
  if (v.content_type !== BUNDLE_CONTENT_TYPE) return null
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
