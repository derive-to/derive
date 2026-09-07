/**
 * Fitting a paper's implementation under what the artifact may hold.
 *
 * A repository is fetched so an agent can read the code, and what makes a research
 * repository large is almost never the code: it is the demo media a README shows. A
 * representative implementation carries a fifth of a megabyte of source beside eighty
 * megabytes of animated GIFs and screenshots. So the policy is asymmetric on purpose,
 * and it is the whole reason this module exists rather than a size check: every text
 * file is kept whatever the total, and binaries are dropped largest first until the rest
 * fits. Dropping a GIF costs an agent nothing; dropping a source file would cost it the
 * thing it was given the repository for.
 *
 * What was dropped is named, so the notes on the version say what is missing rather than
 * leaving a reader to wonder why a path in the README resolves to nothing.
 */

export interface RepoFile {
  /** The manifest path, already prefixed and cleaned by the caller (`/code/train.py`). */
  path: string
  bytes: Uint8Array
  /** Decided from the bytes, not the extension: source with an odd suffix still counts. */
  text: boolean
}

export interface FitRepoOptions {
  /** The most the repository's files may take, summed. */
  cap: number
  /** The most files the repository may contribute. */
  maxFiles: number
}

export interface FitRepoResult {
  files: Record<string, Uint8Array>
  /** False when the text alone is over one of the budgets: nothing more can be dropped. */
  fits: boolean
  /** Total bytes before and after dropping. */
  before: number
  after: number
  dropped: { path: string; bytes: number }[]
  notes: string[]
}

const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`

/** Name a few of them and count the rest: a version message is not a file listing. */
const NAMED = 6

/**
 * Keep all the code, drop the big media. Files come back by manifest path, ready to merge
 * into the bundle beside the paper.
 */
export const fitRepoBytes = (input: RepoFile[], opts: FitRepoOptions): FitRepoResult => {
  const before = input.reduce((n, f) => n + f.bytes.byteLength, 0)
  const text = input.filter((f) => f.text)
  const textBytes = text.reduce((n, f) => n + f.bytes.byteLength, 0)
  const notes: string[] = []

  // Nothing can be dropped below this floor, so say what it would have taken, and name
  // the files that took it: a failure a person cannot act on is barely better than none.
  if (textBytes > opts.cap || text.length > opts.maxFiles) {
    const biggest = [...text]
      .sort((a, b) => b.bytes.byteLength - a.bytes.byteLength)
      .slice(0, 3)
      .map((f) => `${f.path.replace(/^\/code\//, "")} (${mb(f.bytes.byteLength)})`)
      .join(", ")
    return {
      files: {},
      fits: false,
      before,
      after: textBytes,
      dropped: [],
      notes: [
        `the repository's ${text.length} text files alone are ${mb(textBytes)}, over the ${mb(opts.cap)} an artifact with an implementation may hold; largest: ${biggest}`,
      ],
    }
  }

  const binaries = input
    .filter((f) => !f.text)
    .sort((a, b) => b.bytes.byteLength - a.bytes.byteLength)
  const kept = new Map(text.map((f) => [f.path, f.bytes]))
  const dropped: { path: string; bytes: number }[] = []
  let after = textBytes
  // Largest first, so one demo video goes before a hundred small icons.
  for (const f of [...binaries].reverse()) {
    if (after + f.bytes.byteLength > opts.cap || kept.size >= opts.maxFiles) continue
    kept.set(f.path, f.bytes)
    after += f.bytes.byteLength
  }
  for (const f of binaries)
    if (!kept.has(f.path)) dropped.push({ path: f.path, bytes: f.bytes.byteLength })

  if (dropped.length > 0) {
    const shown = dropped
      .slice(0, NAMED)
      .map((f) => `${f.path.replace(/^\/code\//, "")} (${mb(f.bytes)})`)
      .join(", ")
    const more = dropped.length - Math.min(NAMED, dropped.length)
    notes.push(
      `left out ${dropped.length} large ${dropped.length === 1 ? "file" : "files"} to fit: ${shown}${more > 0 ? `, and ${more} more` : ""}`,
    )
  }
  return { files: Object.fromEntries(kept), fits: true, before, after, dropped, notes }
}
