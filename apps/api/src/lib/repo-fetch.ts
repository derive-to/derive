// Fetching the repository that implements a paper, recursively, into the paper's artifact.
//
// The paper is the document; the code is what an agent reaches for the moment it wants to
// know what the method actually does. So an import may carry a public repository link, and
// this module turns that link into files stored under /code/ inside the paper's own
// artifact — read by an agent, never listed to a person, who gets a link to the repository
// on its own host instead.
//
// It fetches tarballs, not an API. GitHub and GitLab both serve a whole tree at a ref as
// one anonymous gzipped tar, which is one request per repository, needs no token, and is
// not the REST API's sixty-an-hour budget that a shared egress address would burn through
// in minutes. `HEAD` means the default branch, so nothing has to ask what it is called.
//
// A tarball carries `.gitmodules` but not the commits its submodules are pinned to. So a
// submodule is fetched at the branch it declares, or at its default, and the notes say so
// rather than implying the import reproduced a pinned tree.
//
// Every archive streams into the blob store as it downloads (stageArchive), so a tree larger
// than the worker's memory arrives a file at a time. What could never be kept is decided
// before it is stored: a file over what one file may be, or a binary larger than all the
// room the paper leaves, is left out and named.

import { unbound } from "@derive/broker"
import {
  type BlobStore,
  CODE_PREFIX,
  cleanPath,
  MAX_BUNDLE_UNZIPPED_BYTES,
  parseGitmodules,
  parseRepoRef,
  type RepoFile,
  type RepoRef,
  repoArchiveUrl,
  repoRefAt,
  TarError,
} from "@derive/core"
import type { AddressGuard } from "../webhooks"
import { ArchiveError, type StagePolicy, stageArchive } from "./archive"
import { isPublicHttpUrl } from "./net"

/** One archive is a single large read; a repository host is not arXiv and asks for no
 *  pacing, but a second between repositories keeps a deep tree from looking like a flood. */
const REPO_REQUEST_INTERVAL_MS = 1_000
/** How long a host has to start answering. The archive itself streams under the reader's
 *  limits (a stall, and REPO_DEADLINE_MS), since a large one is still arriving after this. */
const REPO_TIMEOUT_MS = 90_000
const REPO_DEADLINE_MS = 5 * 60_000
const MB = 1024 * 1024
/** A `.gitmodules` larger than this is not one a repository ships; it is not followed. */
const GITMODULES_BYTES = 64 * 1024

export interface RepoCaps {
  /** Per archive: the most read off the wire, and the most it may inflate to. */
  compressedBytes: number
  inflatedBytes: number
  /** Across the whole tree: the working budget, and the file count. */
  totalBytes: number
  files: number
  /** How deep submodules are followed, and how many repositories in all. */
  depth: number
  repos: number
  /** A file up to this is read whole before it is stored; a larger one streams. Default 8 MB. */
  bufferFileBytes?: number
  /** Bytes on their way to storage before reading pauses for them. Default 16 MB. */
  inflightBytes?: number
  /** The most one file may be: what a request can read whole to serve it. Default 50 MB. */
  maxFileBytes?: number
}

/** Both tiers stream a tree into storage as it downloads. The Node tier reads more of each
 *  file whole and follows deeper trees; the edge worker runs in a 128 MB isolate. */
export const NODE_REPO_CAPS: RepoCaps = {
  compressedBytes: 200 * MB,
  inflatedBytes: 250 * MB,
  totalBytes: 300 * MB,
  files: 20_000,
  depth: 3,
  repos: 20,
  bufferFileBytes: 32 * MB,
  inflightBytes: 64 * MB,
}
export const EDGE_REPO_CAPS: RepoCaps = {
  compressedBytes: 150 * MB,
  inflatedBytes: 300 * MB,
  totalBytes: 300 * MB,
  files: 4_000,
  depth: 2,
  repos: 5,
}

/** Why a repository could not be fetched. Never fails the paper: the import records this
 *  on the job and the Context still holds the paper it was for. */
export class RepoFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RepoFetchError"
  }
}

export interface RepoFetchDeps {
  fetch: typeof fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** This deployment's origin, for the contact address in the User-Agent. */
  baseUrl: string
  /** Recheck DNS at request time on runtimes that can reach private networks. */
  addressGuard?: AddressGuard
  /** Where the tree is stored as it arrives. */
  blobs: BlobStore
  /** Called while archives stream, so a long fetch keeps its claim on the job. */
  heartbeat?: () => Promise<void>
}

/** A file already in the blob store. */
export interface StoredFile {
  key: string
  size: number
}

/** What the paper leaves the implementation: bytes and files. */
export interface RepoRoom {
  bytes: number
  files: number
}

export interface RepoFetchResult {
  /** Every stored file, already at its manifest path under /code/. */
  files: RepoFile<StoredFile>[]
  /** Binaries larger than all the room, left out before they were stored: the fit names
   *  them among what it leaves out. */
  unfit: RepoFile<null>[]
  /** What was actually fetched, canonically — the resume marker. */
  fetched: string
  /** Repositories pulled in, the root first. */
  repos: string[]
  /** What a reader should know: submodules skipped, branches guessed, files left behind. */
  notes: string[]
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`

/** Name a few and count the rest: a version message is not a file listing. */
const nameFew = (files: { path: string; bytes: number }[]): string => {
  const shown = files
    .slice(0, 6)
    .map((f) => `${f.path.replace(/^\/code\//, "")} (${mb(f.bytes)})`)
    .join(", ")
  const more = files.length - Math.min(6, files.length)
  return `${shown}${more > 0 ? `, and ${more} more` : ""}`
}

/** A Git LFS pointer stands in for a file the tarball does not carry. Storing it would
 *  give an agent a checksum where it expected a model. */
const LFS_MAGIC = "version https://git-lfs.github.com/spec/v1"

const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })

/**
 * Is this file text? Decided from the bytes, never the extension: a repository is full of
 * source with suffixes nobody has a mime type for, and getting this wrong the cautious way
 * would let a build script be dropped as if it were a video.
 */
export const looksTextual = (data: Uint8Array): boolean => {
  const head = data.subarray(0, 8192)
  if (head.includes(0)) return false
  // A multi-byte character can straddle the sample's end; give back up to three bytes
  // before calling a valid file binary.
  for (let back = 0; back < 4 && head.byteLength - back >= 0; back++) {
    try {
      utf8Strict.decode(head.subarray(0, head.byteLength - back))
      return true
    } catch {
      // try a shorter sample
    }
  }
  return false
}

const isLfsPointer = (head: Uint8Array, size: number, text: boolean): boolean =>
  text && size < 1024 && new TextDecoder().decode(head.subarray(0, 64)).startsWith(LFS_MAGIC)

/** Where a host may send one redirect: its own name, and GitHub's two. */
const redirectAllowed = (from: string, to: string): boolean =>
  from === to ||
  (["github.com", "www.github.com", "codeload.github.com"].includes(from) &&
    ["github.com", "codeload.github.com"].includes(to))

/** GET one archive. At most one redirect, and only within the host that was asked. The
 *  timeout covers the wait for the host to answer; the body is bounded as it is read. */
const getArchive = async (deps: RepoFetchDeps, url: string): Promise<Response> => {
  // A plain function, never a method: see `unbound`. The same defect here would report a
  // reachable repository as unreachable.
  const send = unbound(deps.fetch)
  let target = url
  for (let hop = 0; hop < 2; hop++) {
    if (!isPublicHttpUrl(target) || (await deps.addressGuard?.precheck(target)))
      throw new RepoFetchError("the repository host is not a public address")
    let res: Response
    const answered = new AbortController()
    const timer = setTimeout(
      () => answered.abort(new DOMException("no answer in time", "TimeoutError")),
      REPO_TIMEOUT_MS,
    )
    try {
      res = await send(target, {
        redirect: "manual",
        headers: {
          "user-agent": `Derive/1.0 (+${deps.baseUrl}; paper import)`,
          accept: "application/x-gzip, application/octet-stream, */*",
        },
        signal: answered.signal,
      })
    } catch (error) {
      throw new RepoFetchError(
        error instanceof Error && error.name === "TimeoutError"
          ? "the repository host did not answer in time"
          : "the repository host could not be reached",
      )
    } finally {
      clearTimeout(timer)
    }
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
        !redirectAllowed(new URL(target).hostname.toLowerCase(), next.hostname.toLowerCase())
      )
        throw new RepoFetchError("the repository host redirected somewhere unexpected")
      target = next.href
      continue
    }
    if (res.status === 404)
      throw new RepoFetchError("no such repository, or it is not public (the host answered 404)")
    // 403/406/429: refused, bot-walled or throttled. A host that answers this to one
    // anonymous client answers it to Derive too, so the message says what happened rather
    // than promising that trying again would help.
    if (res.status === 403 || res.status === 406 || res.status === 429)
      throw new RepoFetchError(`the repository host refused an anonymous download (${res.status})`)
    if (res.status !== 200) throw new RepoFetchError(`the repository host answered ${res.status}`)
    return res
  }
  throw new RepoFetchError("the repository host redirected too many times")
}

/** Everything a host archive puts under one top directory (`repo-<sha>/`); dropping it
 *  makes the repository's own paths the ones an agent reads. */
const stripRoot = (paths: string[]): string => {
  const first = paths[0]?.split("/")[0]
  if (!first) return ""
  return paths.every((p) => p === first || p.startsWith(`${first}/`)) ? `${first}/` : ""
}

/** Say what an archive failure means for a repository. */
const asRepoFetchError = (error: unknown, caps: RepoCaps): never => {
  if (error instanceof TarError)
    throw new RepoFetchError(
      error.code === "malformed"
        ? "the repository archive is unreadable"
        : "the repository is larger than an import holds",
    )
  if (!(error instanceof ArchiveError)) throw error
  throw new RepoFetchError(
    error.kind === "compressed"
      ? `the repository archive is larger than ${mb(caps.compressedBytes)}`
      : error.kind === "inflated"
        ? `the repository inflates past ${mb(caps.inflatedBytes)}`
        : error.kind === "corrupt"
          ? "the repository archive could not be decompressed"
          : error.kind === "single"
            ? "the download was not a repository archive"
            : error.kind === "stalled"
              ? `the repository download stalled, or took longer than ${REPO_DEADLINE_MS / 60_000} minutes`
              : "the repository download broke off",
  )
}

/**
 * Fetch a repository and everything it declares, into files under /code/ in the blob store.
 *
 * Bounded on every axis a third party controls: bytes per archive, bytes over the tree,
 * files, submodule depth, and repositories in all. What a bound stops is written into the
 * notes, because a quietly half-fetched tree reads exactly like a complete one. `room` is
 * what the paper leaves: text past it refuses the repository, and a binary past it is never
 * stored.
 */
export const fetchRepository = async (
  deps: RepoFetchDeps,
  root: RepoRef,
  caps: RepoCaps,
  room: RepoRoom,
): Promise<RepoFetchResult> => {
  const files: RepoFile<StoredFile>[] = []
  const unfit: RepoFile<null>[] = []
  const oversize: { path: string; bytes: number }[] = []
  const notes: string[] = []
  const repos: string[] = []
  const seen = new Set<string>()
  const maxFileBytes = caps.maxFileBytes ?? MAX_BUNDLE_UNZIPPED_BYTES
  let treeBytes = 0
  let treeFiles = 0
  let textBytes = 0
  let lfs = 0
  let requests = 0

  const walk = async (ref: RepoRef, prefix: string, depth: number): Promise<void> => {
    if (seen.has(ref.canonical)) return
    seen.add(ref.canonical)
    if (requests > 0) await deps.sleep(REPO_REQUEST_INTERVAL_MS)
    requests++
    const res = await getArchive(deps, repoArchiveUrl(ref))

    // Decided per file as the archive streams: every name it holds (to find its top
    // directory once it has all arrived), which files are text, and what was left out.
    const names: string[] = []
    const text = new Map<string, boolean>()
    const left: { name: string; size: number; unfit: boolean }[] = []
    let exhausted = false
    const policy: StagePolicy = {
      header: (name, size) => {
        names.push(name)
        if (exhausted || !cleanPath(name)) return false
        if (size > maxFileBytes) {
          left.push({ name, size, unfit: false })
          return false
        }
        if (treeFiles >= caps.files || treeBytes + size > caps.totalBytes) {
          exhausted = true
          return false
        }
        return true
      },
      head: (name, size, head) => {
        const isText = looksTextual(head)
        if (isLfsPointer(head, size, isText)) {
          lfs++
          return "skip"
        }
        // Larger than all the room the paper leaves, less the code already in: it could
        // never be kept, so it is not stored at all.
        if (!isText && size > room.bytes - textBytes) {
          left.push({ name, size, unfit: true })
          return "skip"
        }
        if (isText) {
          textBytes += size
          if (textBytes > room.bytes)
            throw new RepoFetchError(
              `the repository's text files alone are over the ${mb(room.bytes)} an artifact with an implementation has room for`,
            )
        }
        text.set(name, isText)
        treeFiles++
        treeBytes += size
        const base = name.slice(name.lastIndexOf("/") + 1)
        return base === ".gitmodules" && size <= GITMODULES_BYTES ? "keep" : "store"
      },
    }
    let staged: Awaited<ReturnType<typeof stageArchive>>
    try {
      staged = await stageArchive(
        res,
        {
          compressedBytes: caps.compressedBytes,
          inflatedBytes: caps.inflatedBytes,
          files: caps.files,
          bufferFileBytes: caps.bufferFileBytes ?? 8 * MB,
          inflightBytes: caps.inflightBytes ?? 16 * MB,
          deadlineMs: REPO_DEADLINE_MS,
          // A repository is a tar or nothing: one plain file is not one.
          singleFileBytes: 0,
        },
        deps,
        policy,
      )
    } catch (error) {
      return asRepoFetchError(error, caps)
    }
    if (staged.kind !== "tar") throw new RepoFetchError("the download was not a repository archive")
    repos.push(ref.canonical)

    const top = stripRoot(names)
    const inTree = (name: string): string | null => {
      const inner = name.slice(top.length)
      if (!inner || inner.startsWith(".git/")) return null
      return cleanPath(`${prefix}${inner}`)
    }
    let gitmodules: string | null = null
    for (const file of staged.files) {
      if (file.path === `${top}.gitmodules` && file.bytes)
        gitmodules = new TextDecoder().decode(file.bytes)
      const path = inTree(file.path)
      if (!path) continue
      files.push({
        path,
        size: file.size,
        text: text.get(file.path) ?? false,
        ref: { key: file.key, size: file.size },
      })
    }
    for (const out of left) {
      const path = inTree(out.name)
      if (!path) continue
      if (out.unfit) unfit.push({ path, size: out.size, text: false, ref: null })
      else oversize.push({ path, bytes: out.size })
    }
    if (exhausted) {
      notes.push(`stopped reading ${ref.canonical} at the import's working budget`)
      return
    }
    if (!gitmodules) return

    // Submodules. A tarball has no pinned commits, so each is fetched at the branch it
    // declares or at its default; that is said once, not once per submodule.
    const declared = parseGitmodules(gitmodules, ref)
    if (declared.length === 0) return
    if (depth >= caps.depth) {
      notes.push(
        `did not follow ${declared.length} nested ${declared.length === 1 ? "submodule" : "submodules"} below ${ref.canonical}`,
      )
      return
    }
    for (const sub of declared) {
      if (repos.length >= caps.repos) {
        notes.push(`stopped after ${repos.length} repositories`)
        return
      }
      const declaredRef = parseRepoRef(sub.url)
      if (!declaredRef) {
        notes.push(`skipped the submodule at ${sub.path}: ${sub.url} is not GitHub or GitLab`)
        continue
      }
      // The branch comes from a third party's file, so it goes through the same grammar
      // as a pasted link before it becomes part of a URL.
      const subRef = repoRefAt(declaredRef, sub.branch) ?? declaredRef
      // A submodule that will not come is a gap in the tree, not the end of the fetch.
      // Plenty of research submodules sit on an institutional host behind a sign-in or an
      // anti-bot wall, and losing a whole implementation over one of them would be the
      // wrong trade: take what there is, and say what is missing.
      try {
        await walk(subRef, `${prefix}${sub.path}/`, depth + 1)
      } catch (error) {
        if (!(error instanceof RepoFetchError)) throw error
        notes.push(
          `could not fetch the submodule at ${sub.path} (${subRef.canonical}): ${error.message}`,
        )
      }
    }
  }

  await walk(root, CODE_PREFIX.slice(1), 0)

  if (oversize.length > 0)
    notes.push(
      `left out ${oversize.length} ${oversize.length === 1 ? "file" : "files"} over the ${mb(maxFileBytes)} one file may be: ${nameFew(oversize)}`,
    )
  if (repos.length > 1)
    notes.push(
      `included ${repos.length - 1} ${repos.length === 2 ? "submodule" : "submodules"} at their declared branch, which a source archive cannot pin to a commit`,
    )
  if (lfs > 0)
    notes.push(
      `skipped ${lfs} Git LFS ${lfs === 1 ? "pointer" : "pointers"}, whose files live outside the repository`,
    )
  return { files, unfit, fetched: root.canonical, repos, notes }
}
