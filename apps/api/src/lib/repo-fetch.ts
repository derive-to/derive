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
import {
  CODE_PREFIX,
  cleanPath,
  isTar,
  parseGitmodules,
  parseRepoRef,
  type RepoFile,
  type RepoRef,
  repoArchiveUrl,
  repoRefAt,
  TarError,
  untar,
} from "@derive/core"
import type { AddressGuard } from "../webhooks"
import { ArchiveError, inflateCapped, isGzip, readArchive } from "./archive"
import { isPublicHttpUrl } from "./net"

/** One archive is a single large read; a repository host is not arXiv and asks for no
 *  pacing, but a second between repositories keeps a deep tree from looking like a flood. */
const REPO_REQUEST_INTERVAL_MS = 1_000
const REPO_TIMEOUT_MS = 90_000

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
}

/** The Node tier holds the tree in memory while it is fitted; the edge worker has a
 *  128 MB isolate, so it takes a much smaller repository or none. */
export const NODE_REPO_CAPS: RepoCaps = {
  compressedBytes: 200 * 1024 * 1024,
  inflatedBytes: 250 * 1024 * 1024,
  totalBytes: 300 * 1024 * 1024,
  files: 20_000,
  depth: 3,
  repos: 20,
}
export const EDGE_REPO_CAPS: RepoCaps = {
  compressedBytes: 8 * 1024 * 1024,
  inflatedBytes: 24 * 1024 * 1024,
  totalBytes: 24 * 1024 * 1024,
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
}

export interface RepoFetchResult {
  /** Every file, already at its manifest path under /code/. */
  files: RepoFile[]
  /** What was actually fetched, canonically — the resume marker. */
  fetched: string
  /** Repositories pulled in, the root first. */
  repos: string[]
  /** What a reader should know: submodules skipped, branches guessed, files left behind. */
  notes: string[]
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`

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

const isLfsPointer = (data: Uint8Array, text: boolean): boolean =>
  text &&
  data.byteLength < 1024 &&
  new TextDecoder().decode(data.subarray(0, 64)).startsWith(LFS_MAGIC)

/** Where a host may send one redirect: its own name, and GitHub's two. */
const redirectAllowed = (from: string, to: string): boolean =>
  from === to ||
  (["github.com", "www.github.com", "codeload.github.com"].includes(from) &&
    ["github.com", "codeload.github.com"].includes(to))

/** GET one archive. At most one redirect, and only within the host that was asked. */
const getArchive = async (deps: RepoFetchDeps, url: string): Promise<Response> => {
  let target = url
  for (let hop = 0; hop < 2; hop++) {
    if (!isPublicHttpUrl(target) || (await deps.addressGuard?.precheck(target)))
      throw new RepoFetchError("the repository host is not a public address")
    let res: Response
    try {
      res = await deps.fetch(target, {
        redirect: "manual",
        headers: {
          "user-agent": `Derive/1.0 (+${deps.baseUrl}; paper import)`,
          accept: "application/x-gzip, application/octet-stream, */*",
        },
        signal: AbortSignal.timeout(REPO_TIMEOUT_MS),
      })
    } catch (error) {
      throw new RepoFetchError(
        error instanceof Error && error.name === "TimeoutError"
          ? "the repository host did not answer in time"
          : "the repository host could not be reached",
      )
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

const unpack = (raw: Uint8Array, caps: RepoCaps): { path: string; data: Uint8Array }[] => {
  let bytes: Uint8Array
  try {
    bytes = isGzip(raw) ? inflateCapped(raw, caps.inflatedBytes) : raw
  } catch (error) {
    throw new RepoFetchError(
      error instanceof ArchiveError && error.kind === "inflated"
        ? `the repository inflates past ${mb(caps.inflatedBytes)}`
        : "the repository archive could not be decompressed",
    )
  }
  if (!isTar(bytes)) throw new RepoFetchError("the download was not a repository archive")
  let entries: { path: string; data: Uint8Array }[]
  try {
    entries = untar(bytes, { maxFiles: caps.files, maxBytes: caps.inflatedBytes })
  } catch (error) {
    if (error instanceof TarError)
      throw new RepoFetchError(
        error.code === "malformed"
          ? "the repository archive is unreadable"
          : "the repository is larger than an import holds",
      )
    throw error
  }
  const root = stripRoot(entries.map((e) => e.path))
  return entries
    .map((e) => ({ path: e.path.slice(root.length), data: e.data }))
    .filter((e) => e.path && !e.path.startsWith(".git/"))
}

/**
 * Fetch a repository and everything it declares, into files under /code/.
 *
 * Bounded on every axis a third party controls: bytes per archive, bytes over the tree,
 * files, submodule depth, and repositories in all. What a bound stops is written into the
 * notes, because a quietly half-fetched tree reads exactly like a complete one.
 */
export const fetchRepository = async (
  deps: RepoFetchDeps,
  root: RepoRef,
  caps: RepoCaps,
): Promise<RepoFetchResult> => {
  const files: RepoFile[] = []
  const notes: string[] = []
  const repos: string[] = []
  const seen = new Set<string>()
  let totalBytes = 0
  let lfs = 0
  let requests = 0

  const walk = async (ref: RepoRef, prefix: string, depth: number): Promise<void> => {
    if (seen.has(ref.canonical)) return
    seen.add(ref.canonical)
    if (requests > 0) await deps.sleep(REPO_REQUEST_INTERVAL_MS)
    requests++
    const res = await getArchive(deps, repoArchiveUrl(ref))
    let raw: Uint8Array
    try {
      raw = await readArchive(res, caps)
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error
      throw new RepoFetchError(
        error.kind === "compressed"
          ? `the repository archive is larger than ${mb(caps.compressedBytes)}`
          : error.kind === "inflated"
            ? `the repository inflates past ${mb(caps.inflatedBytes)}`
            : error.kind === "corrupt"
              ? "the repository archive could not be decompressed"
              : "the repository download broke off",
      )
    }
    const entries = unpack(raw, caps)
    repos.push(ref.canonical)

    let gitmodules: string | null = null
    for (const entry of entries) {
      if (entry.path === ".gitmodules") gitmodules = new TextDecoder().decode(entry.data)
      const path = cleanPath(`${prefix}${entry.path}`)
      if (!path) continue
      const text = looksTextual(entry.data)
      if (isLfsPointer(entry.data, text)) {
        lfs++
        continue
      }
      if (files.length >= caps.files || totalBytes + entry.data.byteLength > caps.totalBytes) {
        notes.push(`stopped reading ${ref.canonical} at the import's working budget`)
        return
      }
      files.push({ path, bytes: entry.data, text })
      totalBytes += entry.data.byteLength
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
