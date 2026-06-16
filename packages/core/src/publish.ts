import { unzipSync } from "fflate"
import { newId, newShortId, slugify } from "./ids"
import { mimeFor } from "./mime"
import {
  type ArtifactKind,
  type ArtifactRecord,
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  type MetaStore,
  type ProposalRecord,
  type VersionRecord,
  type Visibility,
} from "./ports"

/**
 * Does this content begin like a full HTML document? Used to classify a payload as
 * text/html even if it carries a .md name (a self-contained HTML report committed
 * as Markdown would otherwise render blank). Conservative on purpose — it must
 * START with the doctype/`<html>` marker, so ordinary Markdown that merely embeds
 * some inline HTML is NOT misclassified.
 */
export const looksLikeHtmlDocument = (text: string): boolean => {
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 256).toLowerCase()
  return head.startsWith("<!doctype html") || head.startsWith("<html")
}

export interface PublishInput {
  bytes: Uint8Array
  filename: string
  isBundle: boolean
  title?: string
  slug?: string
  spa?: boolean
  message?: string
  author?: string
  /** The workspace the new artifact belongs to (multi-workspace). */
  orgId?: string
  visibility?: Visibility
  /** Salted unlock-password hash, set by the route for `password` visibility. */
  passwordHash?: string | null
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
// Cap the TOTAL decompressed size of a bundle, not just the (compressed) upload.
// `unzipSync` inflates everything into memory at once, so a zip bomb — a small
// upload that expands to gigabytes — would OOM/CPU-kill the worker without this.
const MAX_BUNDLE_UNZIPPED_BYTES = 50 * 1024 * 1024 // 50 MB

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

/** A piece of stored content, ready to become a version or a proposal. */
interface StoredContent {
  blobKey: string
  contentType: string
  kind: ArtifactKind
}

/**
 * Stores raw bytes (a file) or a zip (a bundle) into the blob store and returns
 * the content-addressed key, content type, and kind. Shared by publish() and
 * propose() so a candidate version is processed exactly like a published one.
 */
async function storeContent(
  blobs: BlobStore,
  bytes: Uint8Array,
  filename: string,
  isBundle: boolean,
  spa: boolean,
): Promise<StoredContent> {
  if (isBundle) {
    let unzipped: Record<string, Uint8Array>
    try {
      unzipped = unzipSync(bytes)
    } catch {
      throw new PublishError(400, "not a valid zip")
    }
    const paths = Object.keys(unzipped)
    if (paths.length === 0) throw new PublishError(400, "empty bundle")
    if (paths.length > MAX_BUNDLE_FILES)
      throw new PublishError(400, `bundle exceeds ${MAX_BUNDLE_FILES} files`)
    // Reject zip bombs: bound the total inflated size, not just the upload size.
    let unzippedBytes = 0
    for (const p of paths) {
      unzippedBytes += unzipped[p]?.byteLength ?? 0
      if (unzippedBytes > MAX_BUNDLE_UNZIPPED_BYTES)
        throw new PublishError(413, "bundle is too large once decompressed")
    }

    const files: BundleManifest["files"] = {}
    for (const raw of paths) {
      const path = cleanPath(raw)
      if (!path) continue
      const data = unzipped[raw]
      if (data === undefined) continue
      files[path] = { key: await blobs.put(data), type: mimeFor(path) }
    }
    // Entry point: root index.html, else the shallowest html file.
    const entry =
      "/index.html" in files
        ? "/index.html"
        : Object.keys(files)
            .filter((p) => p.endsWith(".html"))
            .sort((a, b) => a.split("/").length - b.split("/").length)[0]
    if (!entry) throw new PublishError(400, "bundle has no html entry point")

    const manifest: BundleManifest = { entry, spa, files }
    return {
      blobKey: await blobs.put(new TextEncoder().encode(JSON.stringify(manifest))),
      contentType: BUNDLE_CONTENT_TYPE,
      kind: "bundle",
    }
  }
  const text = new TextDecoder().decode(bytes)
  let contentType: string
  if (looksLikeHtmlDocument(text)) {
    // A full HTML document is HTML even when committed with a .md name (common for
    // self-contained reports synced from a repo). Without this it's tagged
    // text/markdown and the markdown renderer strips its <head>/<style>/scripts —
    // i.e. it renders blank. Checked before the extension so the body wins.
    contentType = "text/html"
  } else if (/\.(md|markdown)$/i.test(filename)) {
    contentType = "text/markdown"
  } else if (text.includes("dock-deck")) {
    // Speaks the dock-deck protocol → it's a slide deck. Match the bare protocol
    // name so either quote style (source:'dock-deck' / "dock-deck") is detected.
    contentType = "text/x-dock-deck"
  } else {
    contentType = "text/html"
  }
  return { blobKey: await blobs.put(bytes), contentType, kind: "file" }
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
  const { blobKey, contentType, kind } = await storeContent(
    blobs,
    input.bytes,
    input.filename,
    input.isBundle,
    !!input.spa,
  )

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
      size_bytes: input.bytes.length,
      author,
      message: input.message ?? null,
      name: input.name ?? null,
    })
    // Rename on republish only when a title is explicitly supplied (the in-browser
    // editor sends it; a CLI republish without --title leaves the name untouched).
    const newTitle = input.title?.trim()
    if (newTitle && newTitle !== artifact.title) await meta.setArtifactTitle(artifact.id, newTitle)
    return { artifact: (await meta.getByShortId(shortId)) as ArtifactRecord, version }
  }

  const title = input.title ?? input.filename.replace(/\.(html?|md|markdown|zip)$/i, "")
  const artifact = await meta.createArtifact({
    id: newId("a"),
    short_id: newShortId(),
    org_id: input.orgId ?? "local",
    slug: input.slug ? slugify(input.slug) : slugify(title) || null,
    title,
    visibility: input.visibility ?? "link",
    password_hash: input.passwordHash ?? null,
    kind,
    spa: input.spa ? 1 : 0,
  })
  const version = await meta.addVersion(artifact.id, {
    id: newId("v"),
    blob_key: blobKey,
    content_type: contentType,
    size_bytes: input.bytes.length,
    author,
    message: input.message ?? "first publish",
    name: input.name ?? null,
  })
  return { artifact: (await meta.getByShortId(artifact.short_id)) as ArtifactRecord, version }
}

export interface ProposeInput {
  bytes: Uint8Array
  filename: string
  isBundle: boolean
  spa?: boolean
  /** What the proposer is changing, in their words. */
  message?: string
  author?: string
  /** Stable id of the proposer (user/agent); persisted for withdraw authorization. */
  author_id?: string | null
}

export interface ProposeResult {
  artifact: ArtifactRecord
  proposal: ProposalRecord
}

/**
 * Stores a candidate version for review WITHOUT making it current. A commenter
 * (or an agent) proposes; an editor approves. The content is processed exactly
 * like a publish, so the proposal renders identically to how it will once live.
 */
export async function propose(
  meta: MetaStore,
  blobs: BlobStore,
  shortId: string,
  input: ProposeInput,
): Promise<ProposeResult> {
  const artifact = await meta.getByShortId(shortId)
  if (!artifact) throw new PublishError(404, `no artifact with short_id ${shortId}`)

  const { blobKey, contentType, kind } = await storeContent(
    blobs,
    input.bytes,
    input.filename,
    input.isBundle,
    !!input.spa,
  )
  if (artifact.kind !== kind)
    throw new PublishError(409, `artifact is a ${artifact.kind}; propose the same kind`)

  const proposal = await meta.createProposal({
    id: newId("p"),
    artifact_id: artifact.id,
    blob_key: blobKey,
    content_type: contentType,
    kind,
    title: null,
    message: input.message ?? null,
    author: input.author ?? "anonymous",
    author_id: input.author_id ?? null,
    base_version: artifact.current_version,
  })
  return { artifact, proposal }
}

/**
 * Approving a proposal appends its stored content as the new current version
 * (the experience goes live) and stamps the proposal decided. History is never
 * rewritten: the proposal row stays as the audit trail of who approved what.
 */
export async function approveProposal(
  meta: MetaStore,
  blobs: BlobStore,
  proposal: ProposalRecord,
  approver: string | null,
  note?: string | null,
): Promise<VersionRecord> {
  if (proposal.state !== "open")
    throw new PublishError(409, `proposal is ${proposal.state}, not open`)
  // The proposal already stored its blob; the approved version reuses it, so
  // its byte cost is first counted here (proposals don't create versions).
  const stored = await blobs.get(proposal.blob_key)
  const version = await meta.addVersion(proposal.artifact_id, {
    id: newId("v"),
    blob_key: proposal.blob_key,
    content_type: proposal.content_type,
    size_bytes: stored?.length ?? 0,
    author: proposal.author,
    message: proposal.message ?? "Approved proposal",
    name: null,
  })
  await meta.decideProposal(proposal.id, {
    state: "approved",
    decided_by: approver,
    decided_version: version.n,
    decision_note: note ?? null,
  })
  return version
}

// Name-first ref: the slug reads first, the short id is the final token. parseRef
// reverses it (the short id is always the last hyphen segment).
export const artifactUrl = (baseUrl: string, a: ArtifactRecord): string =>
  `${baseUrl}/a/${a.slug ? `${a.slug}-` : ""}${a.short_id}`

export const toJson = (baseUrl: string, a: ArtifactRecord, versions: VersionRecord[]) => ({
  short_id: a.short_id,
  url: artifactUrl(baseUrl, a),
  title: a.title,
  kind: a.kind,
  current_content_type: a.current_content_type,
  visibility: a.visibility,
  general_role: a.general_role,
  spa: !!a.spa,
  locked: !!a.locked,
  current_version: a.current_version,
  created_at: a.created_at,
  /** Repo path for a GitHub-synced artifact (drives the folder view); null otherwise. */
  source_path: a.source_path,
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
