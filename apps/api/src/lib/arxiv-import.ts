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

import { unbound } from "@derive/broker"
import {
  type ArtifactRecord,
  arxivUrls,
  type BlobStore,
  type BundleManifest,
  type ContextRecord,
  cleanPath,
  type FigureShrinker,
  type FigureStore,
  fitBundleBytes,
  fitRepoBytes,
  type ImportErrorCode,
  type ImportJobRecord,
  type ImportStep,
  isCodePath,
  isLatexDocument,
  type LatexSourcePlan,
  MAX_BUNDLE_FILES_WITH_CODE,
  MAX_BUNDLE_UNZIPPED_BYTES,
  MAX_BUNDLE_UNZIPPED_BYTES_WITH_CODE,
  MAX_IMPORTED_PAPER_BYTES,
  type MetaStore,
  parseArxivRef,
  parseBibtex,
  parseRepoRef,
  planLatexSource,
  publish,
  readsLatexText,
  type SearchIndex,
  TarError,
} from "@derive/core"
import type { Backplane } from "../bus"
import { type AfterPublishDeps, afterPublish } from "./after-publish"
import { ArchiveError, stageArchive } from "./archive"
import { type ArxivPaperMeta, failedPaper, plainText } from "./arxiv-paper"
import { manifestOf, materializeBundle } from "./bundle"
import { readCappedBytes } from "./http"
import { CITATION_PATH } from "./latex-bundle"
import { isPublicHttpUrl } from "./net"
import { fetchRepository, type RepoCaps, type RepoFetchDeps, RepoFetchError } from "./repo-fetch"
import { normalizeTags } from "./tags"
import { truncate } from "./text"

/** How long the worker is allowed to be quiet before the next request may go. */
export const ARXIV_REQUEST_INTERVAL_MS = 3_000
/** The longest an upstream Retry-After holds every worker back. */
export const ARXIV_MAX_PENALTY_MS = 10 * 60_000
const METADATA_TIMEOUT_MS = 10_000
/** How long arXiv has to start answering for a source. The body is not held to it: it
 *  streams under the reader's own limits (a stall, and SOURCE_DEADLINE_MS), since a large
 *  source is still arriving long after a minute. */
const SOURCE_TIMEOUT_MS = 60_000
const SOURCE_DEADLINE_MS = 5 * 60_000
const MB = 1024 * 1024

export interface ImportCaps {
  /** The working budget: the most bytes read off the wire for one source archive. */
  compressedBytes: number
  /** The working budget: the most bytes the archive may inflate to while it is unpacked. */
  inflatedBytes: number
  /** What the PUBLISHED bundle may hold. A source over this is fitted by shrinking its
   *  raster figures (fitBundleBytes); one that still does not fit is refused. */
  bundleBytes: number
  files: number
  /** A file up to this is read whole before it is stored; a larger one streams straight
   *  into storage. Default 8 MB. */
  bufferFileBytes?: number
  /** How many bytes may be on their way to storage before reading pauses for them.
   *  Default 16 MB. */
  inflightBytes?: number
  /** The most one file may be: what a request can read whole to serve it. Default 50 MB. */
  maxFileBytes?: number
  /** The paper's text files, which planning reads, held in memory. Default 8 MB. */
  textBytes?: number
}

const streamLimits = (caps: ImportCaps) => ({
  bufferFileBytes: caps.bufferFileBytes ?? 8 * MB,
  inflightBytes: caps.inflightBytes ?? 16 * MB,
  maxFileBytes: caps.maxFileBytes ?? MAX_BUNDLE_UNZIPPED_BYTES,
  textBytes: caps.textBytes ?? 8 * MB,
})

/** Both tiers stream a source into storage as it inflates, so neither holds the paper. What
 *  one holds is a file read whole, the text planning reads, and the bytes on their way to
 *  storage: the Node tier can afford more of each, and shrinks figures; the edge worker runs
 *  in a 128 MB isolate with no image codec. Both publish up to the same ceiling. */
export const NODE_IMPORT_CAPS: ImportCaps = {
  compressedBytes: 150 * MB,
  inflatedBytes: 200 * MB,
  bundleBytes: MAX_IMPORTED_PAPER_BYTES,
  files: 2000,
  bufferFileBytes: 32 * MB,
  inflightBytes: 64 * MB,
  textBytes: 32 * MB,
}
export const EDGE_IMPORT_CAPS: ImportCaps = {
  compressedBytes: 120 * MB,
  inflatedBytes: 150 * MB,
  bundleBytes: MAX_IMPORTED_PAPER_BYTES,
  files: 2000,
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`

/** The host a request was actually going to, for a message that says which one failed. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return "arXiv"
  }
}

/** What the runtime said, short enough to survive the 200-character detail. */
const causeOf = (error: unknown): string =>
  truncate(error instanceof Error ? `${error.name}: ${error.message}` : String(error), 100)

/** Why an import stopped. `terminal` failures never retry (they are arXiv's verdict on
 *  the paper); the others back off and try again. */
export class ImportFailure extends Error {
  /** Which phase raised it. Stamped by `inStep` at the phase boundary rather than at
   *  every throw site, so the throw sites stay about what went wrong. */
  public step: ImportStep | null = null

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

  /** What gets recorded and logged: the phase, then the reason. */
  describe(): string {
    return this.step ? `${this.step}: ${this.detail}` : this.detail
  }
}

/**
 * Run one phase of an import, naming it on whatever comes out.
 *
 * Two jobs. A failure we raised is tagged with the phase, so `arXiv answered 403` becomes
 * `metadata: arXiv answered 403`. Anything else is not ours and is not arXiv's either: a
 * store error, a blob write, a runtime feature missing on this tier. Those become
 * `internal`, because reporting them as "arXiv didn't answer" points whoever is
 * debugging at the wrong system, and the thrown message is the only record of what
 * actually happened.
 */
export const inStep = async <T>(step: ImportStep, work: () => Promise<T>): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    if (error instanceof ImportCancelled) throw error
    if (error instanceof ImportFailure) {
      error.step ??= step
      throw error
    }
    const failure = new ImportFailure(
      "internal",
      error instanceof Error ? error.message : String(error),
      false,
    )
    failure.step = step
    throw failure
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
  /** What an attached repository may cost. Absent means this tier does not fetch one:
   *  the paper still imports, and the attachment reports itself as unavailable here. */
  repoCaps?: RepoCaps | null
  /** Delivery-time address check for repository archives. */
  addressGuard?: RepoFetchDeps["addressGuard"]
  /** The figure codec (sharp on Node); absent on the edge, where an oversized source is
   *  refused instead of shrunk. */
  shrink?: FigureShrinker | null
  /** Hand the upstream request gate back as soon as the last arXiv request is done, so
   *  shrinking and publishing (which need no request) never keep other imports waiting. */
  releaseGate?: () => Promise<void>
  /** The claim this run holds (see imports.ts). Every write to the job goes through it, so
   *  a run whose lease lapsed and was reclaimed stops instead of overwriting the new owner. */
  claimToken?: string
  /** Renew the claim, at most once a minute however often it is called. Throws
   *  ImportCancelled when the claim was lost. Called between phases and during long work. */
  heartbeat?: () => Promise<void>
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
  /** The runtime's fetch as a PLAIN function. `this.deps.fetch(url)` calls the global with
   *  this client as its `this`, which Node tolerates and workerd rejects outright with
   *  "Illegal invocation" — so every request throws in a deployed Worker while every Node
   *  test passes, and the symptom is an honest-looking "arXiv didn't answer" about an arXiv
   *  that is answering fine. Bound once here so no call site can get it wrong again. */
  private readonly send: typeof fetch

  constructor(
    private deps: Pick<ImportDeps, "fetch" | "now" | "sleep" | "baseUrl">,
    nextAllowedAt: number,
    private onRequest?: (nextAllowedAt: number) => Promise<void>,
  ) {
    this.nextAllowedAt = nextAllowedAt
    this.send = unbound(deps.fetch)
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
   *  5xx, a timeout) so the tick can classify them. The timeout covers the whole exchange
   *  for a body read at once; for a `streamed` body only the wait for arXiv to start
   *  answering, because the caller bounds that body itself as it reads it. */
  async get(
    url: string,
    timeoutMs: number,
    body: "whole" | "streamed" = "whole",
  ): Promise<Response> {
    let target = url
    for (let hop = 0; hop < 2; hop++) {
      await this.pace()
      let res: Response
      const answered = new AbortController()
      const timer =
        body === "streamed"
          ? setTimeout(
              () => answered.abort(new DOMException("no answer in time", "TimeoutError")),
              timeoutMs,
            )
          : undefined
      try {
        res = await this.send(target, {
          redirect: "manual",
          headers: { "user-agent": this.userAgent, accept: "*/*" },
          signal: body === "streamed" ? answered.signal : AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        await this.stamp()
        // Name the host and quote the runtime, because "could not be reached" covers a
        // DNS failure, a refused connection, a reset and a TLS error, and those want
        // different fixes. The runtime's own message is the only thing that separates
        // them, and it used to be discarded here. The two arXiv hostnames can also fail
        // independently, so which one went quiet is part of the answer.
        const host = hostOf(target)
        throw new ImportFailure(
          "unavailable",
          error instanceof Error && error.name === "TimeoutError"
            ? `${host} did not answer within ${Math.round(timeoutMs / 1000)}s`
            : `${host} could not be reached (${causeOf(error)})`,
          false,
        )
      } finally {
        clearTimeout(timer)
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

/** Say what an archive failure means for a paper import. The wire and inflate budgets
 *  are arXiv's verdict on the paper's size, so they never retry; a body that went away
 *  or stalled mid-download is a mood, so it does. */
const asImportFailure = (error: unknown, caps: ImportCaps): never => {
  if (error instanceof TarError)
    throw error.code === "malformed"
      ? new ImportFailure("no_tex", "the source archive is unreadable", true)
      : new ImportFailure("too_large", error.message, true)
  if (!(error instanceof ArchiveError)) throw error
  if (error.kind === "compressed")
    throw new ImportFailure(
      "too_large",
      `the source archive is larger than ${mb(caps.compressedBytes)}`,
      true,
    )
  if (error.kind === "inflated")
    throw new ImportFailure("too_large", `the source inflates past ${mb(caps.inflatedBytes)}`, true)
  if (error.kind === "single")
    throw new ImportFailure(
      "too_large",
      `the source is one file larger than ${mb(streamLimits(caps).textBytes)}`,
      true,
    )
  if (error.kind === "corrupt")
    throw new ImportFailure("no_tex", "the source archive could not be decompressed", true)
  if (error.kind === "stalled")
    throw new ImportFailure(
      "unavailable",
      `the source download stalled, or took longer than ${SOURCE_DEADLINE_MS / 60_000} minutes`,
      false,
    )
  throw new ImportFailure("unavailable", "the source download broke off", false)
}

/** A file of the paper's source, already in the blob store. Its bytes stay in memory only
 *  for the text files planning reads. */
interface SourceFile {
  key: string
  size: number
  bytes: Uint8Array | null
}

/**
 * Read the paper's source into the blob store as it arrives, under the import's budgets,
 * and return its files by the names the archive gave them: a tarball's files, or the paper
 * itself when arXiv sent one gzipped file. What the worker holds meanwhile is the text
 * planning reads and what is on its way to storage, never the source.
 */
export const stageArxivSource = async (
  res: Response,
  deps: Pick<ImportDeps, "blobs" | "heartbeat">,
  caps: ImportCaps,
): Promise<Record<string, SourceFile>> => {
  const limits = streamLimits(caps)
  let textBytes = 0
  let staged: Awaited<ReturnType<typeof stageArchive>>
  try {
    staged = await stageArchive(
      res,
      {
        compressedBytes: caps.compressedBytes,
        inflatedBytes: caps.inflatedBytes,
        files: caps.files,
        bufferFileBytes: limits.bufferFileBytes,
        inflightBytes: limits.inflightBytes,
        deadlineMs: SOURCE_DEADLINE_MS,
        singleFileBytes: limits.textBytes,
      },
      { blobs: deps.blobs, heartbeat: deps.heartbeat },
      {
        // What planning would drop anyway is never stored: junk names, resource forks.
        header: (name, size) => {
          const path = cleanPath(name)
          if (!path || path.slice(path.lastIndexOf("/") + 1).startsWith("._")) return false
          if (size > limits.maxFileBytes)
            throw new ImportFailure(
              "too_large",
              `${path.slice(1)} is ${mb(size)}, over the ${mb(limits.maxFileBytes)} one file may be`,
              true,
            )
          return true
        },
        head: (name, size) => {
          if (!readsLatexText(name)) return "store"
          textBytes += size
          if (size > limits.bufferFileBytes || textBytes > limits.textBytes)
            throw new ImportFailure(
              "too_large",
              `the source's text files are over ${mb(limits.textBytes)}`,
              true,
            )
          return "keep"
        },
      },
    )
  } catch (error) {
    return asImportFailure(error, caps)
  }
  if (staged.kind === "pdf")
    throw new ImportFailure("no_source", "arXiv has only a PDF for this paper", true)
  if (staged.kind === "single") {
    // One gzipped file: the paper itself when it declares a document.
    const bytes = staged.bytes
    if (
      bytes.byteLength > 0 &&
      isLatexDocument(new TextDecoder().decode(bytes.subarray(0, 65_536)))
    )
      return { "/main.tex": { key: await deps.blobs.put(bytes), size: bytes.byteLength, bytes } }
    throw new ImportFailure("no_tex", "the source is neither an archive nor a LaTeX file", true)
  }
  return Object.fromEntries(
    staged.files.map((f) => [f.path, { key: f.key, size: f.size, bytes: f.bytes }]),
  )
}

/** Apply a plan's transcoding: latin-1 text is rewritten as UTF-8, stored, and takes the
 *  original's place. An alias such as main.bbl takes the same rewrite. */
const transcodeSource = async (
  plan: LatexSourcePlan<SourceFile>,
  blobs: BlobStore,
): Promise<Record<string, SourceFile>> => {
  const files = { ...plan.files }
  const rewritten = new Map<SourceFile, SourceFile>()
  const latin1 = new TextDecoder("latin1")
  for (const path of plan.transcode) {
    const file = files[path]
    if (!file?.bytes) continue
    let next = rewritten.get(file)
    if (!next) {
      const bytes = new TextEncoder().encode(latin1.decode(file.bytes))
      next = { key: await blobs.put(bytes), size: bytes.byteLength, bytes }
      rewritten.set(file, next)
    }
    files[path] = next
  }
  return files
}

/** The source's files as the figure policy sees them: sizes, each loaded from storage only
 *  to be re-encoded, and stored again when it shrinks. */
const sourceStore = (blobs: BlobStore): FigureStore<SourceFile> => ({
  size: (file) => file.size,
  load: async (file) => file.bytes ?? (await blobs.get(file.key)),
  save: async (bytes) => ({ key: await blobs.put(bytes), size: bytes.byteLength, bytes: null }),
})

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

/** Whether this run still owns the job: it exists, and no other claim has taken it since. */
const stillOwned = (deps: ImportDeps, live: ImportJobRecord | null): live is ImportJobRecord =>
  !!live && (deps.claimToken === undefined || live.claim_token === deps.claimToken)

/** The job's Context, renewing the claim on the way. Throws ImportCancelled when the
 *  Context was discarded or another worker took the job over: this run has nothing left
 *  to do in either case. */
const liveContext = async (deps: ImportDeps, job: ImportJobRecord): Promise<ContextRecord> => {
  await deps.heartbeat?.()
  const [ctx, live] = await Promise.all([
    deps.meta.getContext(job.context_id),
    deps.meta.getImportJob(job.id),
  ])
  if (!ctx || !stillOwned(deps, live)) throw new ImportCancelled()
  return ctx
}

/** Write to the job through this run's claim. A write that lands nowhere means the job is
 *  gone or another worker owns it now, and this run stops either way. */
const writeJob = async (
  deps: ImportDeps,
  job: ImportJobRecord,
  fields: Parameters<MetaStore["updateImportJob"]>[1],
): Promise<void> => {
  const written = await deps.meta.updateImportJob(
    job.id,
    { ...fields, updated_at: iso(deps.now()) },
    deps.claimToken,
  )
  if (!written) throw new ImportCancelled()
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
 * Attach the paper's implementation, when the Context names one.
 *
 * Deliberately independent of the paper. The paper is what an import is for, so a
 * repository that is gone, private, unreachable or too big leaves the import ready and
 * records itself on the job; the person sees the attachment failed and can fix the link
 * without re-fetching a paper that arrived perfectly well.
 *
 * The repository lands inside the PAPER's artifact under /code/, not beside it: one
 * Context, one artifact, one thing to read. The bundle caps are raised for that version,
 * because it is now carrying two things.
 */
const attachImplementation = async (
  deps: ImportDeps,
  job: ImportJobRecord,
  ctx: ContextRecord,
  paper: ArtifactRecord,
  actor: { agentId: string | null; agentName: string | null },
): Promise<void> => {
  const { meta, blobs } = deps
  const stamp = (fields: Parameters<MetaStore["updateImportJob"]>[1]) => writeJob(deps, job, fields)
  const live = await meta.getImportJob(job.id)
  if (!stillOwned(deps, live)) throw new ImportCancelled()

  const repoRef = ctx.code_url ? parseRepoRef(ctx.code_url) : null
  if (ctx.code_url && !repoRef) {
    await stamp({
      code_status: "failed",
      code_error: "that is not a public GitHub or GitLab repository",
      code_ref: null,
    })
    return
  }
  // Already attached, and the link has not changed since. code_ref is the marker of what
  // was actually fetched, the same way paper_artifact_id marks the paper: a requeue for
  // any other reason must not re-fetch a repository that is already in the artifact, or
  // publish a version that changes nothing.
  if (repoRef && live.code_ref === repoRef.canonical) {
    if (live.code_status !== "ready") await stamp({ code_status: "ready", code_error: null })
    return
  }

  const version = await meta.getVersion(paper.id, paper.current_version)
  const manifest = version ? await manifestOf(blobs, version) : null
  if (!manifest) {
    if (repoRef)
      await stamp({
        code_status: "failed",
        code_error: "the paper could not be read back",
        code_ref: null,
      })
    return
  }
  const hadCode = Object.keys(manifest.files).some(isCodePath)
  // Whatever the paper already holds, minus any code from an earlier attachment: a
  // replaced link must not leave the previous repository's files behind, and a removed
  // one must leave none at all.
  const paperContent = await ownFiles(blobs, manifest)

  // The link was removed. Publish the paper on its own again, so the code stops being
  // readable the moment the person says it should.
  if (!repoRef) {
    if (hadCode)
      await republishPaper(deps, paper, manifest, paperContent, actor, "Removed the implementation")
    if (live.code_status || hadCode)
      await stamp({ code_status: null, code_error: null, code_ref: null })
    return
  }
  if (!deps.repoCaps) {
    await stamp({
      code_status: "failed",
      code_error: "this deployment does not fetch repositories",
      code_ref: null,
    })
    return
  }

  let fetched: Awaited<ReturnType<typeof fetchRepository>>
  try {
    await deps.heartbeat?.()
    fetched = await fetchRepository(deps, repoRef, deps.repoCaps)
    await deps.heartbeat?.()
  } catch (error) {
    if (error instanceof ImportCancelled) throw error
    await stamp({
      code_status: "failed",
      code_error: truncate(
        error instanceof RepoFetchError ? error.message : "the repository could not be fetched",
        200,
      ),
      code_ref: null,
    })
    return
  }

  // An artifact carrying an implementation gets twice this tier's room, up to the hard
  // ceiling, and the repository gets what is left of it once the paper has taken its share.
  const withCode = {
    bytes: Math.min(MAX_BUNDLE_UNZIPPED_BYTES_WITH_CODE, deps.caps.bundleBytes * 2),
    files: Math.min(MAX_BUNDLE_FILES_WITH_CODE, deps.caps.files * 2),
  }
  const fitted = fitRepoBytes(fetched.files, {
    cap: Math.max(0, withCode.bytes - contentBytes(paperContent)),
    maxFiles: Math.max(0, withCode.files - contentCount(paperContent)),
  })
  if (!fitted.fits) {
    await stamp({
      code_status: "failed",
      code_error: truncate(fitted.notes[0] ?? "the repository is too large to attach", 200),
      code_ref: null,
    })
    return
  }

  const stored = Object.keys(fitted.files).length
  const message = truncate(
    [
      `Attached ${repoRef.canonical} (${stored} ${stored === 1 ? "file" : "files"}, ${mb(fitted.after)})`,
      ...fetched.notes,
      ...fitted.notes,
    ].join(" · "),
    500,
  )
  const published = await republishPaper(
    deps,
    paper,
    manifest,
    { files: { ...paperContent.files, ...fitted.files }, stored: paperContent.stored },
    actor,
    message,
    withCode,
  )
  await stamp({
    code_status: "ready",
    code_error: null,
    code_ref: repoRef.canonical,
    manifest_version: published.version.n,
  })
}

/** What a paper's artifact is published with: files held in memory, and files already in
 *  the blob store, carried by key. */
interface BundleContent {
  files: Record<string, Uint8Array>
  stored: Record<string, { key: string; size: number }>
}

const contentBytes = (c: BundleContent): number =>
  Object.values(c.files).reduce((n, f) => n + f.byteLength, 0) +
  Object.values(c.stored).reduce((n, f) => n + f.size, 0)

const contentCount = (c: BundleContent): number =>
  Object.keys(c.files).length + Object.keys(c.stored).length

/** A published paper's own files, never its /code/: by key when its manifest records every
 *  file's size, so publishing it again reads nothing back; read from the store when the
 *  manifest predates that (a paper imported before sizes were recorded, 50 MB at most). */
const ownFiles = async (blobs: BlobStore, manifest: BundleManifest): Promise<BundleContent> => {
  const own = Object.entries(manifest.files).filter(([path]) => !isCodePath(path))
  const stored: BundleContent["stored"] = {}
  for (const [path, file] of own) {
    if (file.size === undefined)
      return {
        files: await materializeBundle(blobs, { ...manifest, files: Object.fromEntries(own) }),
        stored: {},
      }
    stored[path] = { key: file.key, size: file.size }
  }
  return { files: {}, stored }
}

/** Publish the paper's artifact again with exactly this content. Used by both sides of an
 *  attachment: adding a repository, and taking one away. */
const republishPaper = async (
  deps: ImportDeps,
  paper: ArtifactRecord,
  manifest: BundleManifest,
  content: BundleContent,
  actor: { agentId: string | null; agentName: string | null },
  message: string,
  caps?: { files: number; bytes: number },
) => {
  const current = await deps.meta.getArtifactById(paper.id)
  if (!current) throw new ImportCancelled()
  const currentVersion = await deps.meta.getVersion(current.id, current.current_version)
  const published = await publish(
    deps.meta,
    deps.blobs,
    {
      bytes: new Uint8Array(),
      filename: "paper.zip",
      isBundle: true,
      files: content.files,
      stored: content.stored,
      // The paper stays the document: without this the entry is re-picked over the merged
      // paths and a README or an HTML page inside the repository could take it.
      entry: manifest.entry,
      // An implementation changes the bundle, not the paper's authorship. Keep the
      // imported byline when code is attached, replaced, or removed.
      author: currentVersion?.author ?? "arXiv",
      authorId: currentVersion?.author_id ?? null,
      ...actor,
      source: "api",
      message,
      existingArtifact: current,
      ...(caps ? { maxFiles: caps.files, maxBundleBytes: caps.bytes } : {}),
    },
    current.short_id,
  )
  await afterPublish(publishDeps(deps), published.artifact, published.version, {
    isNew: false,
    onBehalf: null,
    actorId: actor.agentId,
    actorName: actor.agentName,
  })
  return published
}

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
  let ctx = await liveContext(deps, job)
  // The Context's artifact IS the paper: the queue published a placeholder document into
  // it, and this run republishes it as the paper arXiv holds.
  const target = await meta.getArtifactById(ctx.manifest_artifact_id)
  if (!target) throw new ImportCancelled()
  const agent = await meta.getAgent(ctx.agent_id)
  const actor = { agentId: agent?.id ?? null, agentName: agent?.name ?? null }

  // 1. Metadata. An unknown id is arXiv's verdict, not a mood.
  const paperMeta = await inStep("metadata", async () => {
    const metaRes = await client.get(urls.metadata, METADATA_TIMEOUT_MS)
    if (metaRes.status !== 200)
      throw new ImportFailure("unavailable", `arXiv answered ${metaRes.status}`, false)
    const parsed = parseArxivAtom(
      new TextDecoder().decode(await readCappedBytes(metaRes, 1024 * 1024)),
    )
    if (!parsed) throw new ImportFailure("not_found", "arXiv has no paper with this id", true)
    if (/withdrawn/i.test(parsed.comment ?? "") || /withdrawn/i.test(parsed.title))
      throw new ImportFailure("withdrawn", "this paper was withdrawn", true)
    return parsed
  })

  // 2. The source. A reclaimed job that already published the paper skips this.
  let paper = job.paper_artifact_id ? await meta.getArtifactById(job.paper_artifact_id) : null
  const notes: string[] = []
  let fetchedBibtex: string | null = null
  if (!paper) {
    const normalized = await inStep("source", async () => {
      await deps.heartbeat?.()
      const srcRes = await client.get(urls.source, SOURCE_TIMEOUT_MS, "streamed")
      if (srcRes.status === 404)
        throw new ImportFailure("no_source", "arXiv has no source for this paper", true)
      if (srcRes.status !== 200)
        throw new ImportFailure("unavailable", `arXiv answered ${srcRes.status}`, false)
      const staged = await stageArxivSource(srcRes, deps, deps.caps)
      const plan = planLatexSource(staged, { size: (f) => f.size, text: (f) => f.bytes })
      if (!plan.ok) throw new ImportFailure(plan.code, plan.detail, true)
      return { entry: plan.entry, notes: plan.notes, files: await transcodeSource(plan, blobs) }
    })
    notes.push(...normalized.notes)

    // 3. BibTeX, best effort: the paper still publishes with a built entry. Only a
    // rate limit is worth failing for, because holding arXiv's gate past a 429 is how a
    // deployment gets itself blocked. Everything else here is survivable, INCLUDING an
    // oversized body: an entry we could not read is not a reason to discard a paper we
    // already have. The download before it may have taken minutes, so the claim is
    // renewed first, outside the try, where losing it is never mistaken for a bad entry.
    await deps.heartbeat?.()
    try {
      const bibRes = await client.get(urls.bibtex, METADATA_TIMEOUT_MS)
      if (bibRes.status === 200)
        fetchedBibtex = new TextDecoder().decode(await readCappedBytes(bibRes, 64 * 1024))
    } catch (error) {
      if (error instanceof ImportCancelled) throw error
      if (error instanceof ImportFailure && error.code === "rate_limited") throw error
      notes.push("arXiv's BibTeX entry could not be read")
    }
    const citation = citationFor(ref.id, paperMeta, fetchedBibtex)
    if (citation.note) notes.push(citation.note)
    // That was the last request: the gate goes back while the CPU work below runs.
    await deps.releaseGate?.()

    // 4. Publish. From here nothing else talks to arXiv, so anything that fails is
    // ours: the store, the blob writes, the figure codec. `inStep` says so.
    // Assigned from the result, not across the closure boundary, so `paper` is known
    // non-null to everything below.
    paper = await inStep("publish", async () => {
      // 4. Fit the bundle under what Derive publishes, shrinking raster figures if needed.
      // The citation is published beside the source, so the source gets the rest of the room.
      const cited = new TextEncoder().encode(citation.bibtex)
      const fitted = await fitBundleBytes(normalized.files, {
        cap: deps.caps.bundleBytes - cited.byteLength,
        shrink: deps.shrink ?? null,
        store: sourceStore(blobs),
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

      ctx = await liveContext(deps, job)
      const current = await meta.getArtifactById(target.id)
      if (!current) throw new ImportCancelled()
      const title = plainText(paperMeta.title, 200) || `arXiv:${ref.id}`
      // What the import decided rides on the version, where a reader meets it as history
      // rather than as a second document to read.
      const message = truncate([`Imported from arXiv:${ref.canonical}`, ...notes].join(" · "), 500)
      const published = await publish(
        meta,
        blobs,
        {
          bytes: new Uint8Array(),
          filename: `${ref.id.replace(/\//g, "_")}.zip`,
          isBundle: true,
          // The source is published from the store it streamed into; only the citation,
          // written here, is bytes.
          files: { [CITATION_PATH]: cited },
          stored: Object.fromEntries(
            Object.entries(fitted.files).map(([path, f]) => [path, { key: f.key, size: f.size }]),
          ),
          maxBundleBytes: deps.caps.bundleBytes,
          entry: normalized.entry,
          title,
          author: truncate(
            paperMeta.authors.map((name: string) => plainText(name, 80)).join(", ") || "arXiv",
            200,
          ),
          authorId: null,
          ...actor,
          source: "api",
          message,
          existingArtifact: current,
        },
        current.short_id,
      )
      paper = published.artifact
      await afterPublish(publishDeps(deps), paper, published.version, {
        isNew: false,
        onBehalf: null,
        actorId: actor.agentId,
        actorName: actor.agentName,
      })
      await meta.setArtifactTags(paper.id, normalizeTags(["arxiv", `arxiv:${ref.id}`]))
      await writeJob(deps, job, {
        paper_artifact_id: paper.id,
        manifest_version: published.version.n,
        resolved_version: paperMeta.version,
      })
      return published.artifact
    })
  } else {
    await deps.releaseGate?.()
  }

  // 5. The implementation, when the Context names one. Never fails the paper.
  ctx = await liveContext(deps, job)
  await attachImplementation(deps, job, ctx, paper, actor)

  // 6. The Context takes the paper's name.
  ctx = await liveContext(deps, job)
  const name = contextNameFor(paperMeta.title, ref.id)
  if (name !== ctx.name) {
    await meta
      .renameContext(ctx.id, name)
      .catch(() => meta.renameContext(ctx.id, `${truncate(name, 60)} (arXiv:${ref.id})`))
      .catch(() => undefined)
  }
  await writeJob(deps, job, {
    status: "ready",
    lease_until: null,
    error_code: null,
    error_detail: null,
    resolved_version: paperMeta.version,
  })
}

/** Leave a page that says the import gave up, so it never reads "fetching" forever. The
 *  paper that was already published (a retry that failed later) is left alone. */
export const writeFailedPaper = async (
  deps: ImportDeps,
  job: ImportJobRecord,
  reason: string,
): Promise<void> => {
  const ctx = await deps.meta.getContext(job.context_id)
  if (!ctx?.import_ref) return
  if (job.paper_artifact_id) return
  const current = await deps.meta.getArtifactById(ctx.manifest_artifact_id)
  if (!current) return
  const republished = await publish(
    deps.meta,
    deps.blobs,
    {
      bytes: new Uint8Array(),
      filename: "paper.zip",
      isBundle: true,
      files: {
        "/main.tex": new TextEncoder().encode(failedPaper(ctx.import_ref, reason)),
      },
      author: "arXiv",
      authorId: null,
      source: "api",
      message: `Import failed: ${truncate(reason, 200)}`,
      existingArtifact: current,
    },
    current.short_id,
  ).catch(() => null)
  if (republished)
    await afterPublish(publishDeps(deps), republished.artifact, republished.version, {
      isNew: false,
      onBehalf: null,
    }).catch(() => undefined)
}
