import { unzipSync } from "fflate"
import { newId, newShortId, refFor, slugify } from "./ids"
import { type MergeHunk, merge3, mergeKindFor } from "./merge3"
import { mimeFor } from "./mime"
import {
  type ArtifactKind,
  type ArtifactRecord,
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  type MetaStore,
  type ProposalRecord,
  StaleBaseError,
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
  /** The GitHub identity behind this publish (sync only): the commit author's login,
   *  avatar URL, and numeric user id (text). Stored per-version and denormalized as the
   *  artifact's current author. Omitted/null for a manual or anonymous publish — then
   *  only the `author` display name is recorded. */
  authorLogin?: string | null
  authorAvatar?: string | null
  authorGhId?: string | null
  /** The Dock user publishing this by hand (the signed-in publisher). Stored per-version
   *  and denormalized as the artifact's current `author_id`, so the person's profile and
   *  people-follow surface their hand-published work. Omitted/null for sync and bare
   *  static-token publishes. */
  authorId?: string | null
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
      author_login: input.authorLogin ?? null,
      author_avatar: input.authorAvatar ?? null,
      author_gh_id: input.authorGhId ?? null,
      author_id: input.authorId ?? null,
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
    author_login: input.authorLogin ?? null,
    author_avatar: input.authorAvatar ?? null,
    author_gh_id: input.authorGhId ?? null,
    author_id: input.authorId ?? null,
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

/** A blob's UTF-8 text, or null when it can't be read. */
const blobText = async (blobs: BlobStore, key: string): Promise<string | null> => {
  const bytes = await blobs.get(key)
  return bytes ? new TextDecoder().decode(bytes) : null
}

/**
 * Thrown by approveProposal when the proposal's change can't be auto-merged into
 * the current version — the document advanced under it and the two edits overlap
 * (or the content isn't line/block-mergeable, e.g. a bundle). The caller surfaces
 * the conflict for a human/agent to resolve instead of clobbering either side.
 */
export class MergeConflictError extends Error {
  readonly proposalId: string
  readonly baseVersion: number
  readonly currentVersion: number
  readonly hunks: MergeHunk[]
  constructor(proposalId: string, baseVersion: number, currentVersion: number, hunks: MergeHunk[]) {
    super(`proposal ${proposalId} conflicts with current version ${currentVersion}`)
    this.name = "MergeConflictError"
    this.proposalId = proposalId
    this.baseVersion = baseVersion
    this.currentVersion = currentVersion
    this.hunks = hunks
  }
}

// Resolve the content to publish when approving against a CURRENT that has moved
// past the proposal's base: 3-way merge the proposal (theirs) into the live
// version (ours) over their common ancestor. Returns the merged bytes, or throws
// MergeConflictError when it can't auto-merge.
async function mergeProposalOntoCurrent(
  meta: MetaStore,
  blobs: BlobStore,
  proposal: ProposalRecord,
  currentVersion: number,
  theirsText: string | null,
): Promise<Uint8Array> {
  const conflict = (hunks: MergeHunk[]) =>
    new MergeConflictError(proposal.id, proposal.base_version, currentVersion, hunks)
  // Bundles aren't line/block-mergeable in v1 — don't silently overwrite a drift.
  if (proposal.content_type === BUNDLE_CONTENT_TYPE) throw conflict([])
  const baseV = await meta.getVersion(proposal.artifact_id, proposal.base_version)
  const oursV = await meta.getVersion(proposal.artifact_id, currentVersion)
  const baseText = baseV ? await blobText(blobs, baseV.blob_key) : null
  const oursText = oursV ? await blobText(blobs, oursV.blob_key) : null
  // If any of the three sides is unreadable we can't merge safely → conflict.
  if (baseText === null || oursText === null || theirsText === null) throw conflict([])
  const result = merge3(baseText, oursText, theirsText, mergeKindFor(proposal.content_type))
  if (!result.clean || result.merged === null) throw conflict(result.hunks)
  return new TextEncoder().encode(result.merged)
}

/**
 * Approve a proposal: its change becomes the new current version and the proposal
 * is stamped decided. When the document hasn't moved since the proposal's base it
 * fast-forwards (the proposal's stored blob is reused verbatim). When the document
 * ADVANCED under it, the change is 3-way merged into the current version instead of
 * overwriting it — auto-merging disjoint edits, or throwing MergeConflictError when
 * they overlap. The optimistic-concurrency guard makes a publish that lands
 * mid-approval safe: we re-merge against the new current rather than clobber it.
 * History is never rewritten; the proposal row stays as the audit trail.
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
  const theirs = await blobs.get(proposal.blob_key)
  const theirsText = theirs ? new TextDecoder().decode(theirs) : null

  // Re-merge + re-commit a few times: a publish landing between our read of current
  // and our write loses the optimistic guard, so we recompute against the newly
  // current version rather than blindly re-applying stale bytes.
  const MAX_ATTEMPTS = 3
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const artifact = await meta.getArtifactById(proposal.artifact_id)
    if (!artifact) throw new PublishError(404, `no artifact ${proposal.artifact_id}`)
    const current = artifact.current_version

    let blobKey: string
    let sizeBytes: number
    if (current === proposal.base_version) {
      // No drift — fast-forward the proposal's stored blob verbatim.
      blobKey = proposal.blob_key
      sizeBytes = theirs?.length ?? 0
    } else {
      // Drift — 3-way merge (throws MergeConflictError when the edits overlap).
      const merged = await mergeProposalOntoCurrent(meta, blobs, proposal, current, theirsText)
      blobKey = await blobs.put(merged)
      sizeBytes = merged.length
    }

    try {
      const version = await meta.addVersion(
        proposal.artifact_id,
        {
          id: newId("v"),
          blob_key: blobKey,
          content_type: proposal.content_type,
          size_bytes: sizeBytes,
          author: proposal.author,
          // Attribute the live version to the proposer (who did the work), not the
          // approver, so it shows on the proposer's profile. Null for legacy/anon.
          author_id: proposal.author_id ?? null,
          message: proposal.message ?? "Approved proposal",
          name: null,
          base_version: current,
        },
        { expectedBase: current },
      )
      await meta.decideProposal(proposal.id, {
        state: "approved",
        decided_by: approver,
        decided_version: version.n,
        decision_note: note ?? null,
      })
      return version
    } catch (err) {
      // A concurrent publish moved current between our read and our write — loop to
      // re-merge against the new current. Any other error propagates.
      if (err instanceof StaleBaseError && attempt < MAX_ATTEMPTS - 1) continue
      throw err
    }
  }
  throw new PublishError(409, "approval kept losing a concurrent publish — retry")
}

// Name-first ref: the slug reads first, the short id is the final token. parseRef
// reverses it (the short id is always the last hyphen segment).
export const artifactUrl = (baseUrl: string, a: ArtifactRecord): string =>
  `${baseUrl}/a/${refFor(a)}`

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
  /** Bumped on each new version; drives "most recently updated" sort + the label. */
  updated_at: a.updated_at,
  /** Repo path for a GitHub-synced artifact (drives the folder view); null otherwise. */
  source_path: a.source_path,
  /** The CURRENT (last) author, denormalized — drives "who last changed this" + the
   *  author filter in the list. For a GitHub-synced artifact these mirror the last
   *  commit's author; null for legacy/anonymous/non-synced rows. The route may attach a
   *  resolved `author` profile object (with the Dock handle) on top of these. */
  author_name: a.author_name,
  author_login: a.author_login,
  author_avatar: a.author_avatar,
  author_gh_id: a.author_gh_id,
  versions: versions.map((v) => ({
    n: v.n,
    sha256: v.blob_key,
    content_type: v.content_type,
    author: v.author,
    /** The GitHub identity behind this version (sync only); null otherwise. */
    author_login: v.author_login,
    author_avatar: v.author_avatar,
    author_gh_id: v.author_gh_id,
    message: v.message,
    name: v.name,
    created_at: v.created_at,
  })),
})
