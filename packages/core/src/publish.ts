import { unzipSync } from "fflate"
import { isDeckDocument } from "./decks"
import { newId, newShortId, refFor, slugify } from "./ids"
import { LINKED_BUNDLE_CONTENT_TYPE, linkedBundleOf } from "./linked-bundle"
import { mimeFor } from "./mime"
import type { LinkRole, Listed, WorkspaceAccess } from "./permissions"
import {
  type ArtifactKind,
  type ArtifactRecord,
  type BlobStore,
  BUNDLE_CONTENT_TYPE,
  type BundleManifest,
  type MetaStore,
  SKILL_CONTENT_TYPE,
  type VersionRecord,
  type VersionSource,
} from "./ports"
import { isSkillBundle, parseFrontmatter } from "./skill"
import { isVideoDocument, VIDEO_CONTENT_TYPE } from "./videos"

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
  /** The Derive user publishing this by hand (the signed-in publisher). Stored per-version
   *  and denormalized as the artifact's current `author_id`, so the person's profile and
   *  people-follow surface their hand-published work. Omitted/null for historical imports and bare
   *  static-token publishes. */
  authorId?: string | null
  /** The agent principal producing this version on `authorId`'s behalf (id + display name);
   *  omitted for a person's own publish. Recorded as the version's actor. */
  agentId?: string | null
  agentName?: string | null
  /** Which surface created this version ('web' | 'mcp' | 'api', plus historical 'sync' rows);
   *  stored on the version row. Omitted for paths that don't stamp. */
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
  /**
   * Replace this exact current version instead of appending one. Used only for a
   * short burst of attended web edits. The store rejects a stale blob key.
   */
  replaceCurrent?: { n: number; blobKey: string }
  /** Pre-minted short_id for a NEW artifact (create only, ignored on republish) —
   *  lets a caller embed the artifact's own id in its first version's content
   *  (the lineage resume block). 409 if already taken. */
  mintShortId?: string
  /** Expiring anonymous draft (create only): ISO instant after which the draft is
   *  served 410 and swept. Omit for every ordinary publish. */
  expiresAt?: string
  /** Provenance for a NEW artifact created from another artifact or a pinned
   * template entry. The API validates read access before passing the internal id. */
  derivedFrom?: string | null
  /** Trusted artifact record already authorized by the caller for a republish. The core
   *  still validates its short id and kind. Omit when the caller does not already hold the
   *  row; storage remains the exact fallback. This removes a serial read before addVersion
   *  on hot edit paths without changing the public publish contract. */
  existingArtifact?: ArtifactRecord
}

export interface PublishResult {
  artifact: ArtifactRecord
  version: VersionRecord
  timings: {
    /** Time spent in content-addressed blob writes. Bundles include every file and manifest. */
    blobWriteMs: number
    /** Classification, bundle work, and blob writes before the metadata commit. */
    storeContentMs: number
  }
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

/** A piece of stored content, ready to become a version. */
interface StoredContent {
  blobKey: string
  contentType: string
  kind: ArtifactKind
  blobWriteMs: number
  /** A skill bundle's frontmatter `name`, so a new artifact is titled from the skill
   *  rather than the zip's filename when the publisher gives no explicit title. */
  suggestedTitle?: string
}

/**
 * Stores raw bytes (a file) or a zip (a bundle) into the blob store and returns
 * the content-addressed key, content type, and kind. Shared by publish() and
 * every write path, so all content is processed identically.
 */
async function storeContent(
  blobs: BlobStore,
  bytes: Uint8Array,
  filename: string,
  isBundle: boolean,
  spa: boolean,
): Promise<StoredContent> {
  let blobWriteMs = 0
  const put = async (data: Uint8Array): Promise<string> => {
    const startedAt = performance.now()
    try {
      return await blobs.put(data)
    } finally {
      blobWriteMs += performance.now() - startedAt
    }
  }
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
      files[path] = { key: await put(data), type: mimeFor(path) }
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
      blobKey: await put(new TextEncoder().encode(JSON.stringify(manifest))),
      contentType: isSkill ? SKILL_CONTENT_TYPE : BUNDLE_CONTENT_TYPE,
      kind: "bundle",
      blobWriteMs,
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
    //
    // A deck IS a full HTML document, so this branch — not the fragment one below —
    // is where nearly every real deck lands. Until this check was here, every deck
    // written the documented way (doctype, head, the works) typed as plain text/html:
    // the viewer still showed the deck bar (that rides the runtime postMessage), but
    // the library badge and kind label said "Page", so the one visible confirmation
    // that the protocol had worked was missing on exactly the decks that got it right.
    contentType = isVideoDocument(text)
      ? VIDEO_CONTENT_TYPE
      : isDeckDocument(text)
        ? "text/x-derive-deck"
        : linkedBundleOf(text)?.manifest
          ? LINKED_BUNDLE_CONTENT_TYPE
          : "text/html"
  } else if (/\.(md|markdown)$/i.test(filename)) {
    // Markdown stays markdown even when it talks about decks at length — the decks
    // skill and this repo's own docs quote the protocol and slide markup verbatim.
    contentType = "text/markdown"
  } else if (isVideoDocument(text)) {
    contentType = VIDEO_CONTENT_TYPE
  } else if (isDeckDocument(text)) {
    // An HTML FRAGMENT deck (no doctype). Both halves of isDeckDocument matter here:
    // the protocol name alone shows up in any prose about decks.
    contentType = "text/x-derive-deck"
  } else if (/\.html?$/i.test(filename)) {
    // An HTML fragment (no doctype, so the sniff above missed it) saved with an
    // .html name — keep it HTML so the markup renders, not shows as escaped text.
    contentType = linkedBundleOf(text)?.manifest ? LINKED_BUNDLE_CONTENT_TYPE : "text/html"
  } else {
    // Plaintext / unknown extension (.txt, no extension, …): render as markdown.
    // It's the safer, more readable default — sanitized and HTML-escaped through the
    // markdown path — versus serving raw text as HTML. Real HTML still wins above
    // (full doc by content, or an explicit .html name).
    contentType = "text/markdown"
  }
  return { blobKey: await put(bytes), contentType, kind: "file", blobWriteMs }
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
  const storeStartedAt = performance.now()
  const { blobKey, contentType, kind, suggestedTitle, blobWriteMs } = await storeContent(
    blobs,
    input.bytes,
    input.filename,
    input.isBundle,
    !!input.spa,
  )
  const timings = { blobWriteMs, storeContentMs: performance.now() - storeStartedAt }

  const author = input.author ?? "anonymous"

  if (shortId) {
    const artifact =
      input.existingArtifact?.short_id === shortId
        ? input.existingArtifact
        : await meta.getByShortId(shortId)
    if (!artifact) throw new PublishError(404, `no artifact with short_id ${shortId}`)
    if (artifact.kind !== kind)
      throw new PublishError(409, `artifact is a ${artifact.kind}; republish the same kind`)
    const nextVersion = {
      id: newId("v"),
      blob_key: blobKey,
      content_type: contentType,
      size_bytes: input.bytes.length,
      author,
      author_login: null,
      author_avatar: null,
      author_gh_id: null,
      author_id: input.authorId ?? null,
      agent_id: input.agentId ?? null,
      agent_name: input.agentId ? (input.agentName ?? null) : null,
      source: input.source ?? null,
      message: input.message ?? null,
      name: input.name ?? null,
    }
    const version = input.replaceCurrent
      ? await meta.replaceCurrentVersion(artifact.id, input.replaceCurrent, nextVersion)
      : await meta.addVersion(artifact.id, nextVersion)
    if (!version)
      throw new PublishError(409, "artifact changed while editing — reload and try again")
    // Rename on republish only when a title is explicitly supplied (the in-browser
    // editor sends it; a CLI republish without --title leaves the name untouched).
    const newTitle = input.title?.trim()
    // Re-derive the URL name with the title. The slug was computed once at create and
    // never again, so a renamed doc kept advertising its former title in every link it
    // handed out — and nothing could fix it, because renaming is the only lever there is.
    // Safe to change: the ref is `<slug>-<short_id>` and parseRef resolves on the trailing
    // short id, so every link already shared keeps working.
    if (newTitle) {
      const nextSlug = slugify(newTitle) || null
      // Also when the TITLE is unchanged but the slug no longer matches it. Artifacts
      // renamed before the slug followed along are stuck otherwise: their title moved on,
      // their url did not, and republishing under the current title is a no-op because the
      // title already matches — so the one lever that could fix it never fires. This
      // self-heals that drift the next time a title is supplied.
      if (newTitle !== artifact.title || nextSlug !== artifact.slug)
        await meta.setArtifactTitle(artifact.id, newTitle, nextSlug)
    }
    return { artifact: (await meta.getByShortId(shortId)) as ArtifactRecord, version, timings }
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
    derived_from: input.derivedFrom ?? null,
  })
  const version = await meta.addVersion(artifact.id, {
    id: newId("v"),
    blob_key: blobKey,
    content_type: contentType,
    size_bytes: input.bytes.length,
    author,
    author_login: null,
    author_avatar: null,
    author_gh_id: null,
    author_id: input.authorId ?? null,
    source: input.source ?? null,
    message: input.message ?? "first publish",
    name: input.name ?? null,
  })
  return {
    artifact: (await meta.getByShortId(artifact.short_id)) as ArtifactRecord,
    version,
    timings,
  }
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
  // `locked`, which is the publish lock (suggest changes in comments instead).
  password_protected: !!a.password_hash,
  spa: !!a.spa,
  locked: !!a.locked,
  current_version: a.current_version,
  created_at: a.created_at,
  /** Bumped on each new version; drives "most recently updated" sort + the label. */
  updated_at: a.updated_at,
  archived: !!a.archived_at,
  /** The CURRENT (last) author, denormalized for list/history views. GitHub fields can
   *  remain on historical imported rows; new integrations do not write them. */
  author_name: a.author_name,
  author_login: a.author_login,
  author_avatar: a.author_avatar,
  author_gh_id: a.author_gh_id,
  versions: versions.map((v) => ({
    n: v.n,
    sha256: v.blob_key,
    content_type: v.content_type,
    author: v.author,
    /** Historical imported-author metadata; null for current publish paths. */
    author_login: v.author_login,
    author_avatar: v.author_avatar,
    author_gh_id: v.author_gh_id,
    /** The agent that produced this version on the author's behalf; null for the person's own. */
    agent: v.agent_id ? { id: v.agent_id, name: v.agent_name ?? "Agent" } : null,
    message: v.message,
    name: v.name,
    created_at: v.created_at,
  })),
})
