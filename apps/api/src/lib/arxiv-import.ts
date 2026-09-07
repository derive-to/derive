// One arXiv import, end to end: the paper's metadata, its source archive and its BibTeX
// entry, fetched in that order and never faster than arXiv allows, then published as a
// locked LaTeX bundle wrapped in the Context the route created when the import was queued.
//
// The pace is the point. arXiv asks automated clients for one request every three
// seconds on one connection, so every request here goes through one client that waits
// out the gap, that records when the next request may go, and that treats a 429 or 503
// as an instruction to hold back further; the tick that owns the client (imports.ts)
// stores that instant in the import lease, so every worker on the deployment holds back
// with it. The archive is untrusted input from a third party and is inflated inside a
// worker with a memory budget, so it is read under a compressed cap, inflated under an
// inflate cap, and walked under a file cap, and what it turns out to be is decided from
// its bytes rather than from a header arXiv may or may not have set.
import {
  type ArtifactRecord,
  arxivUrls,
  type BlobStore,
  type ContextRecord,
  type FigureShrinker,
  fitBundleBytes,
  type ImportErrorCode,
  type ImportJobRecord,
  isLatexDocument,
  isTar,
  MAX_BUNDLE_UNZIPPED_BYTES,
  type MetaStore,
  newId,
  normalizeLatexSource,
  parseArxivRef,
  parseBibtex,
  publish,
  type SearchIndex,
  TarError,
  untar,
} from "@derive/core"
import { Gunzip } from "fflate"
import type { Backplane } from "../bus"
import { type AfterPublishDeps, afterPublish } from "./after-publish"
import { type ArxivPaperMeta, failedManifest, plainText, readyManifest } from "./arxiv-manifest"
import { readCappedBytes } from "./http"
import { CITATION_PATH } from "./latex-bundle"
import { isPublicHttpUrl } from "./net"
import { normalizeTags } from "./tags"
import { truncate } from "./text"

/** How long the worker is allowed to be quiet before the next request may go. */
export const ARXIV_REQUEST_INTERVAL_MS = 3_000
/** The longest an upstream Retry-After holds every worker back. */
export const ARXIV_MAX_PENALTY_MS = 10 * 60_000
const METADATA_TIMEOUT_MS = 10_000
const SOURCE_TIMEOUT_MS = 60_000

export interface ImportCaps {
  /** The working budget: the most bytes read off the wire for one source archive. */
  compressedBytes: number
  /** The working budget: the most bytes the archive may inflate to while it is unpacked. */
  inflatedBytes: number
  /** What the PUBLISHED bundle may hold. A source over this is fitted by shrinking its
   *  raster figures (fitBundleBytes); one that still does not fit is refused. */
  bundleBytes: number
  files: number
}

/** The Node tier has memory to spare and can shrink figures, so it may pull far more than
 *  it publishes; the edge worker inflates inside a 128 MB isolate with no image codec. */
export const NODE_IMPORT_CAPS: ImportCaps = {
  compressedBytes: 150 * 1024 * 1024,
  inflatedBytes: 200 * 1024 * 1024,
  bundleBytes: MAX_BUNDLE_UNZIPPED_BYTES,
  files: 2000,
}
export const EDGE_IMPORT_CAPS: ImportCaps = {
  compressedBytes: 8 * 1024 * 1024,
  inflatedBytes: 30 * 1024 * 1024,
  bundleBytes: 30 * 1024 * 1024,
  files: 2000,
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`

/** Why an import stopped. `terminal` failures never retry (they are arXiv's verdict on
 *  the paper); the others back off and try again. */
export class ImportFailure extends Error {
  constructor(
    public code: ImportErrorCode,
    public detail: string,
    public terminal: boolean,
    /** Set by a 429/503: how long every worker should hold back. */
    public retryAfterMs: number | null = null,
  ) {
    super(`${code}: ${detail}`)
    this.name = "ImportFailure"
  }
}

/** The job's Context disappeared under it (the person discarded the import). Nothing
 *  to record; the tick just stops. */
export class ImportCancelled extends Error {
  constructor() {
    super("import cancelled")
    this.name = "ImportCancelled"
  }
}

export interface ImportDeps {
  meta: MetaStore
  blobs: BlobStore
  bus: Backplane
  notify: AfterPublishDeps["notify"]
  background: AfterPublishDeps["background"]
  baseUrl: string
  fetch: typeof fetch
  notifyRender?: AfterPublishDeps["notifyRender"]
  search?: SearchIndex
  now: () => number
  sleep: (ms: number) => Promise<void>
  caps: ImportCaps
  /** The figure codec (sharp on Node); absent on the edge, where an oversized source is
   *  refused instead of shrunk. */
  shrink?: FigureShrinker | null
  /** Hand the upstream request gate back as soon as the last arXiv request is done, so
   *  shrinking and publishing (which need no request) never keep other imports waiting. */
  releaseGate?: () => Promise<void>
}

// ---- The paced client -------------------------------------------------------

const ARXIV_HOSTS = new Set(["arxiv.org", "www.arxiv.org", "export.arxiv.org"])

/** Requests to arXiv, spaced by the interval and pinned to arXiv's own hosts. One per
 *  tick: it remembers when its last request went out, and the tick stores that instant
 *  in the lease when it releases it. */
export class ArxivClient {
  /** When the next request may go (epoch ms). Starts at the lease's next allowed instant. */
  nextAllowedAt: number
  /** The longest hold an upstream reply asked for during this client's life. */
  penaltyUntil = 0

  constructor(
    private deps: Pick<ImportDeps, "fetch" | "now" | "sleep" | "baseUrl">,
    nextAllowedAt: number,
    private onRequest?: (nextAllowedAt: number) => Promise<void>,
  ) {
    this.nextAllowedAt = nextAllowedAt
  }

  private get userAgent(): string {
    return `Derive/1.0 (+${this.deps.baseUrl}; paper import)`
  }

  private async pace(): Promise<void> {
    const wait = this.nextAllowedAt - this.deps.now()
    if (wait > 0) await this.deps.sleep(wait)
  }

  private async stamp(): Promise<void> {
    this.nextAllowedAt = this.deps.now() + ARXIV_REQUEST_INTERVAL_MS
    await this.onRequest?.(this.nextAllowedAt)
  }

  /** GET one arXiv URL. Follows at most one redirect, and only to another arXiv host over
   *  https; refuses anything else. Returns the response for the caller to read under its
   *  own cap. Throws ImportFailure for the upstream's moods (429/503 with Retry-After, a
   *  5xx, a timeout) so the tick can classify them. */
  async get(url: string, timeoutMs: number): Promise<Response> {
    let target = url
    for (let hop = 0; hop < 2; hop++) {
      await this.pace()
      let res: Response
      try {
        res = await this.deps.fetch(target, {
          redirect: "manual",
          headers: { "user-agent": this.userAgent, accept: "*/*" },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        await this.stamp()
        throw new ImportFailure(
          "unavailable",
          error instanceof Error && error.name === "TimeoutError"
            ? "arXiv did not answer in time"
            : "arXiv could not be reached",
          false,
        )
      }
      await this.stamp()
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location")
        let next: URL | null = null
        try {
          next = location ? new URL(location, target) : null
        } catch {
          next = null
        }
        if (
          hop === 1 ||
          !next ||
          next.protocol !== "https:" ||
          !ARXIV_HOSTS.has(next.hostname) ||
          !isPublicHttpUrl(next.href)
        )
          throw new ImportFailure("unavailable", "arXiv redirected somewhere unexpected", false)
        target = next.href
        continue
      }
      if (res.status === 429 || res.status === 503) {
        const after = Number(res.headers.get("retry-after"))
        const holdMs = Math.min(
          ARXIV_MAX_PENALTY_MS,
          Number.isFinite(after) && after > 0 ? after * 1000 : 60_000,
        )
        this.penaltyUntil = Math.max(this.penaltyUntil, this.deps.now() + holdMs)
        throw new ImportFailure("rate_limited", `arXiv answered ${res.status}`, false, holdMs)
      }
      if (res.status >= 500)
        throw new ImportFailure("unavailable", `arXiv answered ${res.status}`, false)
      return res
    }
    throw new ImportFailure("unavailable", "arXiv redirected too many times", false)
  }
}

// ---- Metadata (the Atom feed) ----------------------------------------------

const decodeEntities = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml)
  return m ? decodeEntities(m[1] ?? "").trim() : null
}
const attr = (xml: string, name: string, attribute: string): string | null => {
  const m = new RegExp(`<${name}\\b[^>]*\\s${attribute}="([^"]*)"`, "i").exec(xml)
  return m ? decodeEntities(m[1] ?? "") : null
}

/** Parse the Atom feed arXiv's query API returns for one id. Null when the feed carries
 *  no paper: an empty feed, or the "Error" entry an unknown id produces. */
export const parseArxivAtom = (xml: string): ArxivPaperMeta | null => {
  const entry = /<entry\b[^>]*>([\s\S]*?)<\/entry>/i.exec(xml)?.[1]
  if (!entry) return null
  const title = tag(entry, "title") ?? ""
  const id = tag(entry, "id") ?? ""
  if (!title || title === "Error" || !/arxiv\.org\/abs\//i.test(id)) return null
  const authors = [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)]
    .map((m) => tag(m[1] ?? "", "name") ?? "")
    .filter(Boolean)
  const versionMatch = /v(\d+)\s*$/.exec(id)
  return {
    title,
    authors,
    abstract: tag(entry, "summary") ?? "",
    published: tag(entry, "published"),
    primaryCategory: attr(entry, "arxiv:primary_category", "term"),
    categories: [...entry.matchAll(/<category\b[^>]*\sterm="([^"]*)"/gi)].map((m) =>
      decodeEntities(m[1] ?? ""),
    ),
    doi: tag(entry, "arxiv:doi"),
    journalRef: tag(entry, "arxiv:journal_ref"),
    version: versionMatch ? Number(versionMatch[1]) : null,
    comment: tag(entry, "arxiv:comment"),
  }
}

// ---- The source archive -------------------------------------------------------

const startsWith = (bytes: Uint8Array, ascii: string): boolean =>
  bytes.byteLength >= ascii.length && [...ascii].every((ch, i) => bytes[i] === ch.charCodeAt(0))
const isGzip = (bytes: Uint8Array): boolean => bytes[0] === 0x1f && bytes[1] === 0x8b

/** Inflate a gzip stream, refusing past the cap before another chunk is kept. */
const inflateCapped = (bytes: Uint8Array, cap: number): Uint8Array => {
  const chunks: Uint8Array[] = []
  let total = 0
  const gz = new Gunzip((chunk) => {
    total += chunk.byteLength
    if (total > cap) throw new ImportFailure("too_large", "the source inflates past the cap", true)
    chunks.push(chunk)
  })
  try {
    gz.push(bytes, true)
  } catch (error) {
    if (error instanceof ImportFailure) throw error
    throw new ImportFailure("no_tex", "the source archive could not be decompressed", true)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

const concatChunks = (chunks: Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/**
 * Read the source body off the wire. A gzip body streams through the inflater as it
 * arrives, so the peak held in memory is the inflated archive, never compressed plus
 * inflated; anything else is buffered as is. Both the compressed working budget and the
 * inflate budget are enforced while reading.
 */
export const readArchive = async (res: Response, caps: ImportCaps): Promise<Uint8Array> => {
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const out: Uint8Array[] = []
  let inflated = 0
  const keep = (chunk: Uint8Array): void => {
    inflated += chunk.byteLength
    if (inflated > caps.inflatedBytes)
      throw new ImportFailure(
        "too_large",
        `the source inflates past ${mb(caps.inflatedBytes)}`,
        true,
      )
    out.push(chunk)
  }
  let compressed = 0
  let head: Uint8Array | null = null
  let gz: Gunzip | null = null
  let pending: Uint8Array | null = null
  const push = (chunk: Uint8Array, final: boolean): void => {
    if (gz) gz.push(chunk, final)
    else keep(chunk)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      compressed += value.byteLength
      if (compressed > caps.compressedBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ImportFailure(
          "too_large",
          `the source archive is larger than ${mb(caps.compressedBytes)}`,
          true,
        )
      }
      // The first two bytes say whether this is gzip; wait for them before deciding.
      if (head === null) {
        const first: Uint8Array = pending
          ? concatChunks([pending, value], pending.byteLength + value.byteLength)
          : value
        if (first.byteLength < 2) {
          pending = first
          continue
        }
        head = first
        if (isGzip(first)) gz = new Gunzip((chunk) => keep(chunk))
        pending = first
        continue
      }
      if (pending) push(pending, false)
      pending = value
    }
    if (pending) push(pending, true)
    else if (head === null && !gz) return new Uint8Array()
  } catch (error) {
    if (error instanceof ImportFailure) throw error
    if (
      error instanceof Error &&
      /invalid|corrupt|unexpected|gzip|zlib|inflate/i.test(error.message)
    )
      throw new ImportFailure("no_tex", "the source archive could not be decompressed", true)
    throw new ImportFailure("unavailable", "the source download broke off", false)
  } finally {
    reader.releaseLock()
  }
  return concatChunks(out, inflated)
}

/** What arXiv sent, decided from the bytes: a tarball, one gzipped file, a PDF (no
 *  source), or something else. Returns the unpacked files by path. */
export const unpackArxivSource = (
  raw: Uint8Array,
  caps: ImportCaps,
): Record<string, Uint8Array> => {
  if (startsWith(raw, "%PDF") || startsWith(raw, "%!PS"))
    throw new ImportFailure("no_source", "arXiv has only a PDF for this paper", true)
  const bytes = isGzip(raw) ? inflateCapped(raw, caps.inflatedBytes) : raw
  if (startsWith(bytes, "%PDF") || startsWith(bytes, "%!PS"))
    throw new ImportFailure("no_source", "arXiv has only a PDF for this paper", true)
  if (isTar(bytes)) {
    try {
      return Object.fromEntries(
        untar(bytes, { maxFiles: caps.files, maxBytes: caps.inflatedBytes }).map((e) => [
          e.path,
          e.data,
        ]),
      )
    } catch (error) {
      if (error instanceof TarError)
        throw error.code === "malformed"
          ? new ImportFailure("no_tex", "the source archive is unreadable", true)
          : new ImportFailure("too_large", error.message, true)
      throw error
    }
  }
  // One gzipped file: the paper itself when it declares a document.
  if (bytes.byteLength > 0 && isLatexDocument(new TextDecoder().decode(bytes.subarray(0, 65_536))))
    return { "/main.tex": bytes }
  throw new ImportFailure("no_tex", "the source is neither an archive nor a LaTeX file", true)
}

// ---- BibTeX ---------------------------------------------------------------------

const bibKey = (ref: string, meta: ArxivPaperMeta): string => {
  const last = (meta.authors[0] ?? "arxiv").split(/\s+/).at(-1) ?? "arxiv"
  const stem = last.toLowerCase().replace(/[^a-z]/g, "") || "arxiv"
  return `${stem}${meta.published?.slice(0, 4) ?? ""}arxiv${ref.replace(/[^0-9]/g, "")}`
}

/** The entry arXiv publishes for the paper when it parses; otherwise one built from the
 *  metadata, so the Context always has something to cite. */
export const citationFor = (
  ref: string,
  meta: ArxivPaperMeta,
  fetched: string | null,
): { bibtex: string; note: string | null } => {
  if (fetched) {
    const parsed = parseBibtex(fetched)
    if (parsed.entries.length > 0 && parsed.diagnostics.length === 0)
      return { bibtex: fetched.trim(), note: null }
  }
  const field = (k: string, v: string | null) =>
    v ? `  ${k} = {${v.replace(/[{}]/g, "")}},` : null
  const bibtex = [
    `@misc{${bibKey(ref, meta)},`,
    field("title", meta.title.replace(/\s+/g, " ")),
    field("author", meta.authors.join(" and ")),
    field("year", meta.published?.slice(0, 4) ?? null),
    field("eprint", ref),
    "  archivePrefix = {arXiv},",
    field("primaryClass", meta.primaryCategory),
    field("url", `https://arxiv.org/abs/${ref}`),
    "}",
  ]
    .filter((l): l is string => l !== null)
    .join("\n")
  return {
    bibtex,
    note: fetched
      ? "arXiv's BibTeX entry did not parse; CITATION.bib was built from the metadata"
      : "CITATION.bib was built from the metadata",
  }
}

// ---- The job ----------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString()

/** The name the Context takes from the paper's title, within the 80 the create route
 *  allows, cut at a word boundary. */
export const contextNameFor = (title: string, ref: string): string => {
  const plain = plainText(title, 200)
  if (!plain) return `arXiv:${ref}`
  if (plain.length <= 80) return plain
  const cut = plain.slice(0, 79)
  const space = cut.lastIndexOf(" ")
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`
}

const liveContext = async (meta: MetaStore, job: ImportJobRecord): Promise<ContextRecord> => {
  const [ctx, live] = await Promise.all([
    meta.getContext(job.context_id),
    meta.getImportJob(job.id),
  ])
  if (!ctx || !live) throw new ImportCancelled()
  return ctx
}

/** The access a paper lands with: the workspace's default, never a world link (arXiv's
 *  licence permits the workspace's own reading, not redistribution). */
const paperAccess = async (meta: MetaStore, orgId: string) => {
  const settings = await meta.getOrgSettings(orgId).catch(() => null)
  const workspaceAccess = settings?.defaultWorkspaceAccess ?? "member"
  const listed =
    settings?.defaultListed === "workspace" && workspaceAccess === "member"
      ? ("workspace" as const)
      : ("none" as const)
  return { workspaceAccess, linkRole: "none" as const, listed }
}

const publishDeps = (deps: ImportDeps): AfterPublishDeps => ({
  meta: deps.meta,
  blobs: deps.blobs,
  bus: deps.bus,
  notify: deps.notify,
  background: deps.background,
  baseUrl: deps.baseUrl,
  notifyRender: deps.notifyRender,
  search: deps.search,
})

/**
 * Run one claimed job to completion. Throws ImportFailure (the tick records it and
 * schedules or gives up), ImportCancelled (the Context is gone; the tick stops), or
 * anything unexpected (the tick treats it as `unavailable`).
 */
export const importArxivPaper = async (
  deps: ImportDeps,
  job: ImportJobRecord,
  client: ArxivClient,
): Promise<void> => {
  const { meta, blobs } = deps
  const ref = parseArxivRef(job.ref)
  if (!ref) throw new ImportFailure("not_found", "the reference is not an arXiv id", true)
  const urls = arxivUrls(ref)
  let ctx = await liveContext(meta, job)
  const manifest = await meta.getArtifactById(ctx.manifest_artifact_id)
  if (!manifest) throw new ImportCancelled()
  const agent = await meta.getAgent(ctx.agent_id)
  const access = await paperAccess(meta, ctx.org_id)
  const actor = { agentId: agent?.id ?? null, agentName: agent?.name ?? null }

  // 1. Metadata. An unknown id is arXiv's verdict, not a mood.
  const metaRes = await client.get(urls.metadata, METADATA_TIMEOUT_MS)
  if (metaRes.status !== 200)
    throw new ImportFailure("unavailable", `arXiv answered ${metaRes.status}`, false)
  const paperMeta = parseArxivAtom(
    new TextDecoder().decode(await readCappedBytes(metaRes, 1024 * 1024)),
  )
  if (!paperMeta) throw new ImportFailure("not_found", "arXiv has no paper with this id", true)
  if (/withdrawn/i.test(paperMeta.comment ?? "") || /withdrawn/i.test(paperMeta.title))
    throw new ImportFailure("withdrawn", "this paper was withdrawn", true)

  // 2. The source. A reclaimed job that already published its paper skips this.
  let paper = job.paper_artifact_id ? await meta.getArtifactById(job.paper_artifact_id) : null
  const notes: string[] = []
  let fetchedBibtex: string | null = null
  if (!paper) {
    const srcRes = await client.get(urls.source, SOURCE_TIMEOUT_MS)
    if (srcRes.status === 404)
      throw new ImportFailure("no_source", "arXiv has no source for this paper", true)
    if (srcRes.status !== 200)
      throw new ImportFailure("unavailable", `arXiv answered ${srcRes.status}`, false)
    const raw = await readArchive(srcRes, deps.caps)
    const unpacked = unpackArxivSource(raw, deps.caps)
    const normalized = normalizeLatexSource(unpacked)
    if (!normalized.ok) throw new ImportFailure(normalized.code, normalized.detail, true)
    notes.push(...normalized.notes)

    // 3. BibTeX, best effort: the paper still publishes with a built entry.
    try {
      const bibRes = await client.get(urls.bibtex, METADATA_TIMEOUT_MS)
      if (bibRes.status === 200)
        fetchedBibtex = new TextDecoder().decode(await readCappedBytes(bibRes, 64 * 1024))
    } catch (error) {
      if (!(error instanceof ImportFailure) || error.code === "rate_limited") throw error
    }
    const citation = citationFor(ref.id, paperMeta, fetchedBibtex)
    if (citation.note) notes.push(citation.note)
    // That was the last request: the gate goes back while the CPU work below runs.
    await deps.releaseGate?.()

    // 4. Fit the bundle under what Derive publishes, shrinking raster figures if needed.
    const fitted = await fitBundleBytes(normalized.files, {
      cap: deps.caps.bundleBytes,
      shrink: deps.shrink ?? null,
    })
    if (!fitted.fits) {
      const biggest = fitted.largest.map((f) => `${f.path.slice(1)} (${mb(f.bytes)})`).join(", ")
      throw new ImportFailure(
        "too_large",
        `${mb(fitted.after)}${fitted.shrunk ? ` after shrinking ${fitted.shrunk} figures` : ""}; largest: ${biggest}`,
        true,
      )
    }
    notes.push(...fitted.notes)

    ctx = await liveContext(meta, job)
    const title = plainText(paperMeta.title, 200) || `arXiv:${ref.id}`
    const published = await publish(meta, blobs, {
      bytes: new Uint8Array(),
      filename: `${ref.id.replace(/\//g, "_")}.zip`,
      isBundle: true,
      files: { ...fitted.files, [CITATION_PATH]: new TextEncoder().encode(citation.bibtex) },
      entry: normalized.entry,
      title,
      orgId: ctx.org_id,
      author: truncate(paperMeta.authors.map((a) => plainText(a, 80)).join(", ") || "arXiv", 200),
      authorId: null,
      ...actor,
      source: "api",
      message: `Imported from arXiv:${ref.canonical}`,
      ...access,
    })
    paper = published.artifact
    // The importer keeps standing on the paper (unlock, delete) whatever the default
    // access grants members; the same owner seat a hand publish gives its publisher.
    await meta.setArtifactMember({
      id: newId("am"),
      artifact_id: paper.id,
      user_id: job.requested_by,
      role: "owner",
    })
    await afterPublish(publishDeps(deps), paper, published.version, {
      isNew: true,
      onBehalf: null,
      actorId: actor.agentId,
      actorName: actor.agentName,
    })
    await meta.setArtifactTags(paper.id, normalizeTags(["arxiv", `arxiv:${ref.id}`]))
    await meta.setLocked(paper.id, 1)
    await meta.updateImportJob(job.id, {
      paper_artifact_id: paper.id,
      resolved_version: paperMeta.version,
      updated_at: iso(deps.now()),
    })
  } else {
    notes.push("resumed after an interrupted import; the paper was already published")
    await deps.releaseGate?.()
  }

  // 5. The manifest, now the real one, and the Context's name.
  ctx = await liveContext(meta, job)
  const bibtex = await citationBytes(blobs, meta, paper)
  const title = plainText(paperMeta.title, 200) || `arXiv:${ref.id}`
  const md = readyManifest({
    ref: ref.id,
    meta: paperMeta,
    paperShortId: paper.short_id,
    bibtex,
    notes,
  })
  const current = await meta.getArtifactById(manifest.id)
  if (!current) throw new ImportCancelled()
  const republished = await publish(
    meta,
    blobs,
    {
      bytes: new TextEncoder().encode(md),
      filename: "manifest.md",
      isBundle: false,
      title: `${truncate(title, 120)} — context instructions`,
      author: "arXiv",
      authorId: null,
      ...actor,
      source: "api",
      message: `Imported from arXiv:${ref.canonical}`,
      existingArtifact: current,
    },
    current.short_id,
  )
  await afterPublish(publishDeps(deps), republished.artifact, republished.version, {
    isNew: false,
    onBehalf: null,
    actorId: actor.agentId,
    actorName: actor.agentName,
    preparedSource: md,
  })
  await meta.setLocked(manifest.id, 1)
  await meta.updateImportJob(job.id, {
    manifest_version: republished.version.n,
    updated_at: iso(deps.now()),
  })

  const name = contextNameFor(paperMeta.title, ref.id)
  if (name !== ctx.name) {
    await meta
      .renameContext(ctx.id, name)
      .catch(() => meta.renameContext(ctx.id, `${truncate(name, 60)} (arXiv:${ref.id})`))
      .catch(() => undefined)
  }
  await meta.updateImportJob(job.id, {
    status: "ready",
    lease_until: null,
    error_code: null,
    error_detail: null,
    resolved_version: paperMeta.version,
    updated_at: iso(deps.now()),
  })
}

/** The paper bundle's CITATION.bib, read back so a resumed job carries the same entry. */
const citationBytes = async (
  blobs: BlobStore,
  meta: MetaStore,
  paper: ArtifactRecord,
): Promise<string | null> => {
  const v = await meta.getVersion(paper.id, paper.current_version).catch(() => null)
  const bytes = v ? await blobs.get(v.blob_key) : null
  if (!bytes) return null
  try {
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      files?: Record<string, { key: string }>
    }
    const key = manifest.files?.[CITATION_PATH]?.key
    const data = key ? await blobs.get(key) : null
    return data ? new TextDecoder().decode(data).trim() : null
  } catch {
    return null
  }
}

/** Record a dead import on the manifest, so a read never says "fetching" forever. */
export const writeFailedManifest = async (
  deps: ImportDeps,
  job: ImportJobRecord,
  reason: string,
): Promise<void> => {
  const ctx = await deps.meta.getContext(job.context_id)
  if (!ctx?.import_ref) return
  const current = await deps.meta.getArtifactById(ctx.manifest_artifact_id)
  if (!current || current.locked) return
  const md = failedManifest(ctx.import_ref, reason)
  const republished = await publish(
    deps.meta,
    deps.blobs,
    {
      bytes: new TextEncoder().encode(md),
      filename: "manifest.md",
      isBundle: false,
      author: "arXiv",
      authorId: null,
      source: "api",
      message: "Import failed",
      existingArtifact: current,
    },
    current.short_id,
  ).catch(() => null)
  if (republished)
    await afterPublish(publishDeps(deps), republished.artifact, republished.version, {
      isNew: false,
      onBehalf: null,
      preparedSource: md,
    }).catch(() => undefined)
}
