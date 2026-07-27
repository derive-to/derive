import { unzipSync } from "fflate"
import { newId, newShortId, refFor, slugify } from "./ids"
import { mimeFor } from "./mime"
import type { LinkRole, Listed, WorkspaceAccess } from "./permissions"
import {
  type ArtifactKind,
  type ArtifactRecord,
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  type MetaStore,
  type ProposalRecord,
  SKILL_CONTENT_TYPE,
  type VersionRecord,
  type VersionSource,
} from "./ports"
import { isSkillBundle, parseFrontmatter } from "./skill"

/**
 * Does this content read as an HTML page? Used to classify a payload as text/html
 * even when it carries a .md name or no filename hint (a self-contained HTML report
 * would otherwise render its CSS as visible text). The boundary that matters:
 * ordinary Markdown must NEVER classify as HTML (the retype incident), so only
 * unambiguous page openers count — the doctype/`<html>` markers plus the
 * head/meta/style/title/body openers a headless designed page starts with, after
 * skipping leading HTML comments (both designed pages and Markdown open with those,
 * so a comment alone never decides). A leading `<div>`/`<p>`/custom tag stays
 * NOT-HTML: that is exactly how HTML-flavored Markdown (a centered README)
 * legitimately opens.
 */
export const looksLikeHtmlDocument = (text: string): boolean => {
  let head = text.replace(/^﻿/, "").trimStart()
  for (let i = 0; i < 8 && head.startsWith("<!--"); i++) {
    const end = head.indexOf("-->")
    if (end === -1) return false
    head = head.slice(end + 3).trimStart()
  }
  return /^<(!doctype\s+html|html|head|body|meta|style|title)[\s/>]/i.test(head.slice(0, 64))
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
  /** The Derive user publishing this by hand (the signed-in publisher). Stored per-version
   *  and denormalized as the artifact's current `author_id`, so the person's profile and
   *  people-follow surface their hand-published work. Omitted/null for sync and bare
   *  static-token publishes. */
  authorId?: string | null
  /** Which surface created this version ('web' | 'mcp' | 'api' | 'sync'); stored on the
   *  version row. Omitted for paths that don't stamp. */
  source?: VersionSource | null
  /** The workspace the new artifact belongs to (multi-workspace). */
  orgId?: string
  /** Salted unlock-password hash, set by the route when the world link is locked. */
  passwordHash?: string | null
  /** The access triple for a NEW artifact (see access-model.md). Set-on-create —
   *  ignored on a republish (shortId), which never re-stamps them. The route
   *  resolves the default chain (explicit request > the org's defaults > the
   *  factory: workspace_access `member`, link `none`, listed `none`) and the
   *  listing preconditions before calling publish(); omitted values fall through
   *  to the store's fail-closed defaults. */
  workspaceAccess?: WorkspaceAccess
  linkRole?: LinkRole
  listed?: Listed
  /** Names this publish a pinned checkpoint (Docs-style). */
  name?: string
  /** Pre-minted short_id for a NEW artifact (create only, ignored on republish) —
   *  lets a caller embed the artifact's own id in its first version's content
   *  (the lineage resume block). 409 if already taken. */
  mintShortId?: string
  /** Expiring anonymous draft (create only): ISO instant after which the draft is
   *  served 410 and swept. Omit for every ordinary publish. */
  expiresAt?: string
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

/**
 * Choose a bundle's entry page. An HTML site enters at its root `index.html`, else
 * its shallowest `.html`. A doc/skill bundle with no HTML (a Claude Code skill is a
 * folder of `SKILL.md` + scripts/refs, no HTML) falls back to `SKILL.md`, then
 * `MANIFEST.md` (a context source dir — the entry is the runner's system prompt, and
 * a stray root README must not hijack it), then `README.md`, then the shallowest
 * markdown file — markdown entries render through the markdown path at serve time.
 * Null when the bundle has neither HTML nor markdown.
 */
export const pickBundleEntry = (paths: string[]): string | null => {
  const shallowest = (pred: (p: string) => boolean): string | undefined =>
    paths.filter(pred).sort((a, b) => a.split("/").length - b.split("/").length)[0]
  if (paths.includes("/index.html")) return "/index.html"
  // A root SKILL.md wins over any NON-root HTML: a skill folder is a skill even when it
  // ships an HTML reference (references/example.html is exactly what a chart-style skill
  // carries) — otherwise that reference would steal the entry and the bundle would lose
  // its skill identity. An html site is still picked below when there's no root SKILL.md.
  if (paths.includes("/SKILL.md")) return "/SKILL.md"
  const html = shallowest((p) => p.endsWith(".html"))
  if (html) return html
  if (paths.includes("/MANIFEST.md")) return "/MANIFEST.md"
  if (paths.includes("/README.md")) return "/README.md"
  return shallowest((p) => /\.(md|markdown)$/i.test(p)) ?? null
}

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
  /** A skill bundle's frontmatter `name`, so a new artifact is titled from the skill
   *  rather than the zip's filename when the publisher gives no explicit title. */
  suggestedTitle?: string
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
    // Entry point: an HTML site enters at index/shallowest .html; a skill/doc
    // bundle with no HTML enters at SKILL.md / README.md / shallowest markdown.
    const entry = pickBundleEntry(Object.keys(files))
    if (!entry) throw new PublishError(400, "bundle has no html or markdown entry point")

    const manifest: BundleManifest = { entry, spa, files }
    // A skill bundle (entry = SKILL.md) gets the distinct derive/skill content type — so
    // the library can badge it without opening the manifest — and is titled from its
    // frontmatter `name`, not the zip's filename, when no title is given.
    const isSkill = isSkillBundle(manifest)
    let suggestedTitle: string | undefined
    if (isSkill) {
      const entryKey = files[entry]?.key
      const entryBytes = entryKey ? await blobs.get(entryKey) : null
      const name = entryBytes && parseFrontmatter(new TextDecoder().decode(entryBytes)).attrs.name
      if (name) suggestedTitle = name
    }
    return {
      blobKey: await blobs.put(new TextEncoder().encode(JSON.stringify(manifest))),
      contentType: isSkill ? SKILL_CONTENT_TYPE : BUNDLE_CONTENT_TYPE,
      kind: "bundle",
      suggestedTitle,
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
  } else if (text.includes("derive-deck")) {
    // Speaks the derive-deck protocol → it's a slide deck. Match the bare protocol
    // name so either quote style (source:'derive-deck' / "derive-deck") is detected.
    contentType = "text/x-derive-deck"
  } else if (/\.html?$/i.test(filename)) {
    // An HTML fragment (no doctype, so the sniff above missed it) saved with an
    // .html name — keep it HTML so the markup renders, not shows as escaped text.
    contentType = "text/html"
  } else {
    // Plaintext / unknown extension (.txt, no extension, …): render as markdown.
    // It's the safer, more readable default — sanitized and HTML-escaped through the
    // markdown path — versus serving raw text as HTML. Real HTML still wins above
    // (full doc by content, or an explicit .html name).
    contentType = "text/markdown"
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
  const { blobKey, contentType, kind, suggestedTitle } = await storeContent(
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
      source: input.source ?? null,
      message: input.message ?? null,
      name: input.name ?? null,
    })
    // Rename on republish only when a title is explicitly supplied (the in-browser
    // editor sends it; a CLI republish without --title leaves the name untouched).
    const newTitle = input.title?.trim()
    if (newTitle && newTitle !== artifact.title) await meta.setArtifactTitle(artifact.id, newTitle)
    return { artifact: (await meta.getByShortId(shortId)) as ArtifactRecord, version }
  }

  const title =
    input.title ?? suggestedTitle ?? input.filename.replace(/\.(html?|md|markdown|zip)$/i, "")
  if (input.mintShortId && (await meta.getByShortId(input.mintShortId)))
    throw new PublishError(409, `short_id ${input.mintShortId} is already taken`)
  const artifact = await meta.createArtifact({
    id: newId("a"),
    short_id: input.mintShortId ?? newShortId(),
    org_id: input.orgId ?? "local",
    slug: input.slug ? slugify(input.slug) : slugify(title) || null,
    title,
    // The route resolves the default chain before calling us; omitted values
    // fall through to the store's fail-closed defaults (none/none/none). The
    // orphaned visibility/general_role columns take their DB defaults.
    workspace_access: input.workspaceAccess,
    link_role: input.linkRole,
    listed: input.listed,
    password_hash: input.passwordHash ?? null,
    kind,
    spa: input.spa ? 1 : 0,
    expires_at: input.expiresAt ?? null,
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
    source: input.source ?? null,
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
  /** When an agent proposed, the human it acted on behalf of (delegation provenance). */
  on_behalf_of?: string | null
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
    on_behalf_of: input.on_behalf_of ?? null,
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
    // Attribute the live version to the proposer (who did the work), not the approver,
    // so it shows up on the proposer's profile. Null for legacy/anonymous proposals.
    author_id: proposal.author_id ?? null,
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
  `${baseUrl}/artifacts/${refFor(a)}`

export const toJson = (baseUrl: string, a: ArtifactRecord, versions: VersionRecord[]) => ({
  short_id: a.short_id,
  url: artifactUrl(baseUrl, a),
  title: a.title,
  kind: a.kind,
  current_content_type: a.current_content_type,
  workspace_access: a.workspace_access,
  link_role: a.link_role,
  listed: a.listed,
  // A password on the world link (never the hash itself). Distinct from
  // `locked`, which is the publish lock (changes must go through proposals).
  password_protected: !!a.password_hash,
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
   *  resolved `author` profile object (with the Derive handle) on top of these. */
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
