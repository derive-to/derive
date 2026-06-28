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
  /** Optimistic-concurrency base: the current_version the editor started from. When
   *  set on a republish, a drift is 3-way merged (or 409s) instead of clobbering;
   *  omitted ⇒ a plain last-write-wins append (legacy / CLI / GitHub sync). */
  baseVersion?: number
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
    const version =
      input.baseVersion === undefined
        ? await meta.addVersion(artifact.id, {
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
        : await commitWithMerge(meta, blobs, {
            artifactId: artifact.id,
            baseVersion: input.baseVersion,
            theirsBlobKey: blobKey,
            theirsBytes: input.bytes.length,
            theirsText: input.isBundle ? null : new TextDecoder().decode(input.bytes),
            contentType,
            author,
            authorLogin: input.authorLogin ?? null,
            authorAvatar: input.authorAvatar ?? null,
            authorGhId: input.authorGhId ?? null,
            authorId: input.authorId ?? null,
            message: input.message ?? null,
            name: input.name,
            conflictId: shortId,
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

/** Parse a bundle manifest blob, or null when it can't be read. */
const readManifest = async (blobs: BlobStore, key: string): Promise<BundleManifest | null> => {
  const bytes = await blobs.get(key)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as BundleManifest
  } catch {
    return null
  }
}

// Bundle files we'll 3-way merge when both sides changed one: text only. HTML/deck
// still resolve to a whole-blob conflict inside merge3; binary (images, fonts, xml,
// svg) can't be line-merged and conflict here.
const isMergeableText = (type: string): boolean => {
  const t = type.split(";")[0]?.trim() ?? ""
  return t.startsWith("text/") || t === "application/javascript" || t === "application/json"
}

// Pick a valid entry for the merged manifest: ours' entry if it survived, else
// theirs', else a root/shallowest html, else null (no entry → caller conflicts).
const pickEntry = (
  files: BundleManifest["files"],
  ours: BundleManifest,
  theirs: BundleManifest,
): string | null => {
  if (files[ours.entry]) return ours.entry
  if (files[theirs.entry]) return theirs.entry
  if (files["/index.html"]) return "/index.html"
  return (
    Object.keys(files)
      .filter((p) => p.endsWith(".html"))
      .sort((a, b) => a.split("/").length - b.split("/").length)[0] ?? null
  )
}

// 3-way merge two bundle revisions per file over their common ancestor. A file only
// one side changed is taken from that side (incl. deletes); a text file both sides
// changed is recursively merge3'd; add-vs-add, edit-vs-delete, a changed binary/HTML
// file, or an unreadable side conflict the whole bundle.
async function mergeBundle3(
  meta: MetaStore,
  blobs: BlobStore,
  input: MergeCommit,
  currentVersion: number,
): Promise<Uint8Array> {
  const conflict = (hunks: MergeHunk[]) =>
    new MergeConflictError(input.conflictId, input.baseVersion, currentVersion, hunks)
  const baseV = await meta.getVersion(input.artifactId, input.baseVersion)
  const oursV = await meta.getVersion(input.artifactId, currentVersion)
  const baseM = baseV ? await readManifest(blobs, baseV.blob_key) : null
  const oursM = oursV ? await readManifest(blobs, oursV.blob_key) : null
  const theirsM = await readManifest(blobs, input.theirsBlobKey)
  if (!baseM || !oursM || !theirsM) throw conflict([])

  const files: BundleManifest["files"] = {}
  const paths = new Set([
    ...Object.keys(baseM.files),
    ...Object.keys(oursM.files),
    ...Object.keys(theirsM.files),
  ])
  for (const path of paths) {
    const b = baseM.files[path]
    const o = oursM.files[path]
    const t = theirsM.files[path]
    if (o?.key === b?.key) {
      // ours didn't touch this file → take theirs (present = keep/edit, absent = delete)
      if (t) files[path] = t
    } else if (t?.key === b?.key) {
      if (o) files[path] = o
    } else if (o?.key === t?.key) {
      // both made the same change (incl. both deleted)
      if (o) files[path] = o
    } else {
      // both changed this path differently
      if (!o || !t || !b) throw conflict([]) // edit-vs-delete, or add-vs-add (no ancestor)
      if (!isMergeableText(o.type) || o.type !== t.type) throw conflict([])
      const [baseText, oursText, theirsText] = await Promise.all([
        blobText(blobs, b.key),
        blobText(blobs, o.key),
        blobText(blobs, t.key),
      ])
      if (baseText === null || oursText === null || theirsText === null) throw conflict([])
      const r = merge3(baseText, oursText, theirsText, mergeKindFor(o.type))
      if (!r.clean || r.merged === null) throw conflict(r.hunks)
      files[path] = { key: await blobs.put(new TextEncoder().encode(r.merged)), type: o.type }
    }
  }
  const entry = pickEntry(files, oursM, theirsM)
  if (!entry) throw conflict([])
  const manifest: BundleManifest = { entry, spa: oursM.spa, files }
  return new TextEncoder().encode(JSON.stringify(manifest))
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

// An incoming change (`theirs`) committed as the next version, with the metadata
// needed to fast-forward, 3-way merge, or conflict against whatever is CURRENT.
interface MergeCommit {
  artifactId: string
  /** The version `theirs` derived from — the merge ancestor. */
  baseVersion: number
  /** `theirs`, already stored in the blob store (reused verbatim on a fast-forward). */
  theirsBlobKey: string
  theirsBytes: number
  /** `theirs` decoded, or null for non-text (e.g. a bundle) — those can't auto-merge. */
  theirsText: string | null
  contentType: string
  author: string
  authorLogin?: string | null
  authorAvatar?: string | null
  authorGhId?: string | null
  authorId?: string | null
  message: string | null
  name?: string | null
  /** Identifies the source (proposal id / short id) in a MergeConflictError. */
  conflictId: string
}

// 3-way merge `theirs` into the CURRENT version over their common ancestor when the
// document has moved past the base it derived from. Returns the merged bytes, or
// throws MergeConflictError when it can't auto-merge.
async function merge3IntoCurrent(
  meta: MetaStore,
  blobs: BlobStore,
  input: MergeCommit,
  currentVersion: number,
): Promise<Uint8Array> {
  const conflict = (hunks: MergeHunk[]) =>
    new MergeConflictError(input.conflictId, input.baseVersion, currentVersion, hunks)
  // Bundles merge per file (disjoint files combine, same text file 3-way merges,
  // anything else conflicts).
  if (input.contentType === BUNDLE_CONTENT_TYPE)
    return mergeBundle3(meta, blobs, input, currentVersion)
  const baseV = await meta.getVersion(input.artifactId, input.baseVersion)
  const oursV = await meta.getVersion(input.artifactId, currentVersion)
  const baseText = baseV ? await blobText(blobs, baseV.blob_key) : null
  const oursText = oursV ? await blobText(blobs, oursV.blob_key) : null
  // If any of the three sides is unreadable we can't merge safely → conflict.
  if (baseText === null || oursText === null || input.theirsText === null) throw conflict([])
  const result = merge3(baseText, oursText, input.theirsText, mergeKindFor(input.contentType))
  if (!result.clean || result.merged === null) throw conflict(result.hunks)
  return new TextEncoder().encode(result.merged)
}

// Commit `theirs` as the next version with optimistic concurrency: fast-forward when
// the doc hasn't moved past its base, 3-way merge when it has, conflict when the
// edits overlap. A publish that lands between our read and our write loses the
// expectedBase guard, so we re-merge against the new current rather than clobber it.
async function commitWithMerge(
  meta: MetaStore,
  blobs: BlobStore,
  input: MergeCommit,
): Promise<VersionRecord> {
  const MAX_ATTEMPTS = 3
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const artifact = await meta.getArtifactById(input.artifactId)
    if (!artifact) throw new PublishError(404, `no artifact ${input.artifactId}`)
    const current = artifact.current_version

    let blobKey: string
    let sizeBytes: number
    if (current === input.baseVersion) {
      // No drift — fast-forward `theirs` verbatim.
      blobKey = input.theirsBlobKey
      sizeBytes = input.theirsBytes
    } else {
      // Drift — 3-way merge (throws MergeConflictError when the edits overlap).
      const merged = await merge3IntoCurrent(meta, blobs, input, current)
      blobKey = await blobs.put(merged)
      sizeBytes = merged.length
    }

    try {
      return await meta.addVersion(
        input.artifactId,
        {
          id: newId("v"),
          blob_key: blobKey,
          content_type: input.contentType,
          size_bytes: sizeBytes,
          author: input.author,
          author_login: input.authorLogin ?? null,
          author_avatar: input.authorAvatar ?? null,
          author_gh_id: input.authorGhId ?? null,
          author_id: input.authorId ?? null,
          message: input.message,
          name: input.name ?? null,
          base_version: current,
        },
        { expectedBase: current },
      )
    } catch (err) {
      // A concurrent publish moved current between our read and our write — loop to
      // re-merge against the new current. Any other error propagates.
      if (err instanceof StaleBaseError && attempt < MAX_ATTEMPTS - 1) continue
      throw err
    }
  }
  throw new PublishError(409, "write kept losing a concurrent publish — retry")
}

/**
 * Approve a proposal: its change becomes the new current version and the proposal is
 * stamped decided. When the document hasn't moved since the proposal's base it
 * fast-forwards (the proposal's stored blob is reused verbatim). When the document
 * ADVANCED under it, the change is 3-way merged into the current version instead of
 * overwriting it — auto-merging disjoint edits, or throwing MergeConflictError when
 * they overlap. History is never rewritten; the proposal row stays as the audit trail.
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
  const version = await commitWithMerge(meta, blobs, {
    artifactId: proposal.artifact_id,
    baseVersion: proposal.base_version,
    theirsBlobKey: proposal.blob_key,
    theirsBytes: theirs?.length ?? 0,
    theirsText: theirs ? new TextDecoder().decode(theirs) : null,
    contentType: proposal.content_type,
    author: proposal.author,
    authorId: proposal.author_id ?? null,
    message: proposal.message ?? "Approved proposal",
    conflictId: proposal.id,
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
