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
// than the worker's memory arrives a file at a time, and only its source is kept. An agent
// reads an implementation for what the method does, never for its weights, datasets or demo
// media, so a file is left out before it is stored when its first bytes are not text, when
// its name says it is data, or when it is larger than source ever is. What was left out is
// counted and the largest named, so a path the README mentions that resolves to nothing is
// explained.

import { unbound } from "@derive/broker"
import {
  type BlobStore,
  CODE_PREFIX,
  cleanPath,
  leaveOut,
  leftOut,
  mb,
  mergeLeftOut,
  nameLeftOut,
  parseGitmodules,
  parseRepoRef,
  type RepoFile,
  type RepoRef,
  rankLeftOut,
  repoArchiveUrl,
  repoRefAt,
  TarError,
} from "@derive/core"
import type { AddressGuard } from "../webhooks"
import {
  ArchiveError,
  type ArchiveErrorKind,
  downloadWindow,
  type StagePolicy,
  stageArchive,
} from "./archive"
import { isPublicHttpUrl } from "./net"

/** One archive is a single large read; a repository host is not arXiv and asks for no
 *  pacing, but a second between repositories keeps a deep tree from looking like a flood. */
const REPO_REQUEST_INTERVAL_MS = 1_000
/** How long a host has to start answering. The archive itself streams under the reader's
 *  limits (a stall, and the download's deadline), since a large one is still arriving after
 *  this. */
const REPO_TIMEOUT_MS = 90_000
/** The longest one archive may take to download, however much time the pass has left. */
const REPO_DEADLINE_MS = 10 * 60_000
/** Every entry an archive may hold, source or not. What is kept is capped separately. */
const TAR_ENTRIES = 50_000
const MB = 1024 * 1024
/** A `.gitmodules` larger than this is not one a repository ships; it is not followed. */
const GITMODULES_BYTES = 64 * 1024
/** A text file larger than this is data or generated output, not source. */
const SOURCE_FILE_BYTES = 10 * MB
/** Text that is data or media rather than source, left out whatever its size. */
const DATA_TEXT =
  /\.(csv|tsv|jsonl|ndjson|geojson|svg|ply|obj|mtl|off|stl|pcd|pts|xyz|vtk|gltf|dae|pdb|fasta|fastq|arff|log)$/i
export interface RepoCaps {
  /** Per archive: the most read off the wire. */
  compressedBytes: number
  /** Across the whole tree: the most its archives may inflate to, source or not. Inflating
   *  is where a fetch spends its CPU, so this is what keeps it inside a pass's CPU time. */
  inflatedBytes: number
  /** Across the whole tree: the most source it may store, and in how many files. */
  totalBytes: number
  files: number
  /** How deep submodules are followed, and how many repositories in all. */
  depth: number
  repos: number
  /** A file up to this is read whole before it is stored; a larger one streams. Default 8 MB. */
  bufferFileBytes?: number
  /** Bytes on their way to storage before reading pauses for them. Default 16 MB. */
  inflightBytes?: number
  /** The largest text file kept as source; past it, a file is data or generated. Default 10 MB. */
  sourceFileBytes?: number
}

/** Both tiers stream a tree into storage as it downloads and keep only its source. The edge
 *  worker has 30 seconds of CPU and 10,000 storage requests a pass, so it inflates at most
 *  600 MB of archive and stores at most 8,000 files; the Node tier has neither limit. */
export const NODE_REPO_CAPS: RepoCaps = {
  compressedBytes: 1024 * MB,
  inflatedBytes: 2048 * MB,
  totalBytes: 250 * MB,
  files: 20_000,
  depth: 3,
  repos: 20,
  bufferFileBytes: 32 * MB,
  inflightBytes: 64 * MB,
}
export const EDGE_REPO_CAPS: RepoCaps = {
  compressedBytes: 500 * MB,
  inflatedBytes: 600 * MB,
  totalBytes: 250 * MB,
  files: 8_000,
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
  /** When the fetch should be done, on `now`'s clock: the pass's, so a download ends inside
   *  the pass it runs in. */
  passDeadline?: number
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
  /** Every stored file, already at its manifest path under /code/: the tree's source. */
  files: RepoFile<StoredFile>[]
  /** What was actually fetched, canonically — the resume marker. */
  fetched: string
  /** Repositories pulled in, the root first. */
  repos: string[]
  /** What a reader should know: submodules skipped, branches guessed, files left behind. */
  notes: string[]
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

const unpacksPast = (caps: RepoCaps): string =>
  `the implementation unpacks to more than the ${mb(caps.inflatedBytes)} an import reads, source and data together`

/** What each way an archive can fail means for a repository that was being fetched. */
const ARCHIVE_FAILURE: Record<ArchiveErrorKind, (caps: RepoCaps) => string> = {
  compressed: (caps) => `the repository archive is larger than ${mb(caps.compressedBytes)}`,
  inflated: unpacksPast,
  corrupt: () => "the repository archive could not be decompressed",
  single: () => "the download was not a repository archive",
  stalled: () => "the repository download stalled or ran out of time",
  broken: () => "the repository download broke off",
}

/** Say what an archive failure means for a repository. */
const asRepoFetchError = (error: unknown, caps: RepoCaps): never => {
  if (error instanceof TarError)
    throw new RepoFetchError(
      error.code === "malformed"
        ? "the repository archive is unreadable"
        : error.code === "too_many_files"
          ? `the repository archive holds more than ${TAR_ENTRIES} files`
          : unpacksPast(caps),
    )
  if (!(error instanceof ArchiveError)) throw error
  throw new RepoFetchError(ARCHIVE_FAILURE[error.kind](caps))
}

/**
 * Fetch a repository and everything it declares, keeping its source under /code/ in the
 * blob store.
 *
 * Bounded on every axis a third party controls: bytes per archive, bytes unpacked over the
 * tree, source kept, submodule depth, and repositories in all. What a bound stops is written
 * into the notes, because a quietly half-fetched tree reads exactly like a complete one.
 * Source past the `room` the paper leaves refuses the repository, or skips the submodule that
 * brought it, rather than keeping an arbitrary part of it.
 */
export const fetchRepository = async (
  deps: RepoFetchDeps,
  root: RepoRef,
  caps: RepoCaps,
  room: RepoRoom,
): Promise<RepoFetchResult> => {
  const files: RepoFile<StoredFile>[] = []
  const notes: string[] = []
  const repos: string[] = []
  const seen = new Set<string>()
  const left = leftOut()
  const sourceFileBytes = caps.sourceFileBytes ?? SOURCE_FILE_BYTES
  // What the tree may keep: the room the paper leaves, within what this tier stores.
  const most = {
    bytes: Math.min(room.bytes, caps.totalBytes),
    files: Math.min(room.files, caps.files),
  }
  const kept = { bytes: 0, files: 0 }
  // Every byte of every archive, kept or not: inflating is what a fetch spends its CPU on.
  let unpacked = 0
  let lfs = 0
  let requests = 0

  const walk = async (ref: RepoRef, prefix: string, depth: number): Promise<void> => {
    if (seen.has(ref.canonical)) return
    seen.add(ref.canonical)
    if (requests > 0) await deps.sleep(REPO_REQUEST_INTERVAL_MS)
    requests++
    const res = await getArchive(deps, repoArchiveUrl(ref))

    // Decided per file as the archive streams. What this archive keeps and leaves out joins
    // the tree's count once all of it has arrived, so a submodule that fails part way
    // leaves nothing of itself behind but the time it took.
    const top = { dir: null as string | null, shared: true }
    const archive = { bytes: 0, files: 0, lfs: 0, left: leftOut() }
    const policy: StagePolicy = {
      header: (name, size) => {
        // The one directory every entry sits under, if there is one, found as names go by.
        const dir = name.split("/")[0] ?? ""
        if (top.dir === null) top.dir = dir
        else if (dir !== top.dir) top.shared = false
        unpacked += size
        if (unpacked > caps.inflatedBytes) throw new RepoFetchError(unpacksPast(caps))
        if (!cleanPath(name)) return false
        if (size > sourceFileBytes || DATA_TEXT.test(name)) {
          leaveOut(archive.left, name, size)
          return false
        }
        return true
      },
      head: (name, size, head) => {
        const text = looksTextual(head)
        if (isLfsPointer(head, size, text)) {
          archive.lfs++
          return "skip"
        }
        if (!text) {
          leaveOut(archive.left, name, size)
          return "skip"
        }
        archive.files++
        archive.bytes += size
        if (kept.files + archive.files > most.files)
          throw new RepoFetchError(
            `the implementation has more than the ${most.files} source files an import stores beside the paper`,
          )
        if (kept.bytes + archive.bytes > most.bytes)
          throw new RepoFetchError(
            `the implementation's source is over the ${mb(most.bytes)} an import stores beside the paper`,
          )
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
          files: TAR_ENTRIES,
          bufferFileBytes: caps.bufferFileBytes ?? 8 * MB,
          inflightBytes: caps.inflightBytes ?? 16 * MB,
          deadlineMs: downloadWindow(deps.now(), deps.passDeadline, REPO_DEADLINE_MS),
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
    kept.bytes += archive.bytes
    kept.files += archive.files
    lfs += archive.lfs

    // Everything a host archive puts under one top directory (`repo-<sha>/`); dropping it
    // makes the repository's own paths the ones an agent reads.
    const strip = top.dir && top.shared ? `${top.dir}/` : ""
    const inTree = (name: string): string | null => {
      const inner = name.slice(strip.length)
      if (!inner || inner.startsWith(".git/")) return null
      return cleanPath(`${prefix}${inner}`)
    }
    let gitmodules: string | null = null
    for (const file of staged.files) {
      if (file.path === `${strip}.gitmodules` && file.bytes)
        gitmodules = new TextDecoder().decode(file.bytes)
      const path = inTree(file.path)
      if (!path) continue
      files.push({ path, size: file.size, text: true, ref: { key: file.key, size: file.size } })
    }
    mergeLeftOut(left, archive.left, inTree)
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

  if (left.count > 0)
    notes.push(
      `left out ${left.count} ${left.count === 1 ? "file that is" : "files that are"} not source (${mb(left.bytes)} of binaries, data, media and text over ${mb(sourceFileBytes)}): ${nameLeftOut(left, /^\/code\//)}`,
    )
  if (repos.length > 1)
    notes.push(
      `included ${repos.length - 1} ${repos.length === 2 ? "submodule" : "submodules"} at their declared branch, which a source archive cannot pin to a commit`,
    )
  if (lfs > 0)
    notes.push(
      `skipped ${lfs} Git LFS ${lfs === 1 ? "pointer" : "pointers"}, whose files live outside the repository`,
    )
  return { files, fetched: root.canonical, repos, notes }
}
