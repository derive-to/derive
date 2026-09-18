/**
 * How a note names sizes, and the files a pass left behind.
 *
 * Several passes leave files out and say so in the notes a person reads on a version: an arXiv
 * source drops what one file may not exceed, a repository tree keeps only source, a figure fit
 * shrinks what it can. Each had grown its own megabyte formatter and its own "name the largest
 * few and count the rest", which is how two notes about the same thing drift into reading
 * differently. They share these.
 */

/** Bytes as a note names them. */
export const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`

/** How many files a note names before it just counts the rest. */
const NAMED = 6

/** What a pass left out: how many files, how many bytes, and the largest few by path. */
export interface LeftOut {
  count: number
  bytes: number
  largest: { path: string; bytes: number }[]
  /** How many of them a note names. */
  keep: number
}

export const leftOut = (keep = NAMED): LeftOut => ({ count: 0, bytes: 0, largest: [], keep })

/** Keep a file among the largest few, if it is one of them. Only those are held, so a tree
 *  that leaves out thousands still costs a handful of entries. */
export const rankLeftOut = (out: LeftOut, path: string, bytes: number): void => {
  const smallest = out.largest[out.keep - 1]
  if (smallest && smallest.bytes >= bytes) return
  out.largest.push({ path, bytes })
  out.largest.sort((a, b) => b.bytes - a.bytes)
  out.largest.length = Math.min(out.largest.length, out.keep)
}

/** Count a file the pass left out, and keep it among the largest few. */
export const leaveOut = (out: LeftOut, path: string, bytes: number): void => {
  out.count++
  out.bytes += bytes
  rankLeftOut(out, path, bytes)
}

/** Fold one pass's tally into the whole run's. `path` re-roots a name the run states
 *  differently (a submodule's file, under the tree it was fetched into) and drops what the
 *  run does not name at all. */
export const mergeLeftOut = (
  out: LeftOut,
  from: LeftOut,
  path?: (p: string) => string | null | undefined,
): void => {
  out.count += from.count
  out.bytes += from.bytes
  for (const file of from.largest) {
    const at = path ? path(file.path) : file.path
    if (at) rankLeftOut(out, at, file.bytes)
  }
}

/** Name the largest few and count the rest: a note is not a file listing. */
export const nameLeftOut = (out: LeftOut, strip?: RegExp): string => {
  const shown = out.largest
    .map((file) => `${strip ? file.path.replace(strip, "") : file.path} (${mb(file.bytes)})`)
    .join(", ")
  const more = out.count - out.largest.length
  return `${shown}${more > 0 ? `, and ${more} more` : ""}`
}

/** The same note, for a list of left-out files already in hand. */
export const nameLargest = (
  files: readonly { path: string; bytes: number }[],
  opts: { keep?: number; strip?: RegExp } = {},
): string => {
  const out = leftOut(opts.keep)
  for (const file of files) leaveOut(out, file.path, file.bytes)
  return nameLeftOut(out, opts.strip)
}
