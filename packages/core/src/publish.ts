import { unzipSync } from "fflate"
import { newId, newShortId, slugify } from "./ids"
import { mimeFor } from "./mime"
import {
  type ArtifactRecord,
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  type MetaStore,
  type VersionRecord,
  type Visibility,
} from "./ports"

export interface PublishInput {
  bytes: Uint8Array
  filename: string
  isBundle: boolean
  title?: string
  slug?: string
  spa?: boolean
  message?: string
  author?: string
  visibility?: Visibility
  /** Names this publish a pinned checkpoint (Docs-style). */
  name?: string
}

export interface PublishResult {
  artifact: ArtifactRecord
  version: VersionRecord
}

export class PublishError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

const MAX_BUNDLE_FILES = 2000

/** Normalizes a zip entry path; null means skip the entry. */
const cleanPath = (raw: string): string | null => {
  const p = raw
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
  if (!p || p.endsWith("/")) return null
  const segs = p.split("/")
  if (segs.some((s) => s === ".." || s === "")) return null
  if (segs[0] === "__MACOSX" || segs[segs.length - 1] === ".DS_Store") return null
  return `/${p}`
}

/**
 * Stores content and creates a new artifact (shortId undefined)
 * or the next version of an existing one.
 */
export async function publish(
  meta: MetaStore,
  blobs: BlobStore,
  input: PublishInput,
  shortId?: string,
): Promise<PublishResult> {
  let blobKey: string
  let contentType: string
  let kind: "file" | "bundle"

  if (input.isBundle) {
    kind = "bundle"
    let unzipped: Record<string, Uint8Array>
    try {
      unzipped = unzipSync(input.bytes)
    } catch {
      throw new PublishError(400, "not a valid zip")
    }
    const paths = Object.keys(unzipped)
    if (paths.length === 0) throw new PublishError(400, "empty bundle")
    if (paths.length > MAX_BUNDLE_FILES)
      throw new PublishError(400, `bundle exceeds ${MAX_BUNDLE_FILES} files`)

    const files: BundleManifest["files"] = {}
    for (const raw of paths) {
      const path = cleanPath(raw)
      if (!path) continue
      files[path] = { key: await blobs.put(unzipped[raw]), type: mimeFor(path) }
    }
    // Entry point: root index.html, else the shallowest html file.
    const entry =
      "/index.html" in files
        ? "/index.html"
        : Object.keys(files)
            .filter((p) => p.endsWith(".html"))
            .sort((a, b) => a.split("/").length - b.split("/").length)[0]
    if (!entry) throw new PublishError(400, "bundle has no html entry point")

    const manifest: BundleManifest = { entry, spa: !!input.spa, files }
    blobKey = await blobs.put(new TextEncoder().encode(JSON.stringify(manifest)))
    contentType = BUNDLE_CONTENT_TYPE
  } else {
    kind = "file"
    contentType = /\.(md|markdown)$/i.test(input.filename) ? "text/markdown" : "text/html"
    blobKey = await blobs.put(input.bytes)
  }

  const author = input.author ?? "anonymous"

  if (shortId) {
    const artifact = await meta.getByShortId(shortId)
    if (!artifact) throw new PublishError(404, `no artifact with short_id ${shortId}`)
    if (artifact.kind !== kind)
      throw new PublishError(409, `artifact is a ${artifact.kind}; republish the same kind`)
    const version = await meta.addVersion(artifact.id, {
      id: newId("v"),
      blob_key: blobKey,
      content_type: contentType,
      author,
      message: input.message ?? null,
      name: input.name ?? null,
    })
    return { artifact: (await meta.getByShortId(shortId)) as ArtifactRecord, version }
  }

  const title = input.title ?? input.filename.replace(/\.(html?|md|markdown|zip)$/i, "")
  const artifact = await meta.createArtifact({
    id: newId("a"),
    short_id: newShortId(),
    org_id: "local",
    slug: input.slug ? slugify(input.slug) : slugify(title) || null,
    title,
    visibility: input.visibility ?? "link",
    kind,
    spa: input.spa ? 1 : 0,
  })
  const version = await meta.addVersion(artifact.id, {
    id: newId("v"),
    blob_key: blobKey,
    content_type: contentType,
    author,
    message: input.message ?? "first publish",
    name: input.name ?? null,
  })
  return { artifact: (await meta.getByShortId(artifact.short_id)) as ArtifactRecord, version }
}

export const artifactUrl = (baseUrl: string, a: ArtifactRecord): string =>
  `${baseUrl}/a/${a.short_id}${a.slug ? `-${a.slug}` : ""}`

export const toJson = (baseUrl: string, a: ArtifactRecord, versions: VersionRecord[]) => ({
  short_id: a.short_id,
  url: artifactUrl(baseUrl, a),
  title: a.title,
  kind: a.kind,
  visibility: a.visibility,
  spa: !!a.spa,
  current_version: a.current_version,
  created_at: a.created_at,
  versions: versions.map((v) => ({
    n: v.n,
    sha256: v.blob_key,
    content_type: v.content_type,
    author: v.author,
    message: v.message,
    name: v.name,
    created_at: v.created_at,
  })),
})
