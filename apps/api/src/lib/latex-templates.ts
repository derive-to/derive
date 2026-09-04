import {
  CVPR_KIT_MISSING_NOTE,
  type LatexTemplateId,
  latexTemplate,
  latexTemplateUpstreamFiles,
  type PinnedUpstreamFile,
  sha256Hex,
} from "@derive/core"
import { log } from "../log"

/**
 * A paper starter as the files a bundle publish takes, with the upstream style files the
 * template cannot carry fetched in.
 *
 * The CVPR author kit publishes `cvpr.sty` and `ieeenat_fullname.bst` without a license,
 * so they are not in this repository. They are fetched from a pinned commit, verified
 * against pinned hashes, and added to the user's own bundle (their content, like any file
 * they upload). A fetch that fails, times out or returns other bytes degrades to a note:
 * the paper is still created, a comment on the first line of main.tex says what to add,
 * and the publish receipt carries the same line. Fetched bytes are cached per process,
 * keyed by URL, so a busy instance asks GitHub once.
 */
export interface LatexTemplateBundle {
  id: LatexTemplateId
  label: string
  description: string
  entry: string
  files: Record<string, string>
  /** What could not be included; empty when the bundle is complete. */
  notes: string[]
}

const FETCH_TIMEOUT_MS = 10_000
const cache = new Map<string, string>()

const fetchPinned = async (
  file: PinnedUpstreamFile,
  fetchImpl: typeof fetch,
): Promise<string | null> => {
  const hit = cache.get(file.url)
  if (hit !== undefined) return hit
  try {
    const res = await fetchImpl(file.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    if ((await sha256Hex(bytes)) !== file.sha256) {
      log.warn("latex_template_upstream_mismatch", { path: file.path, url: file.url })
      return null
    }
    const text = new TextDecoder().decode(bytes)
    cache.set(file.url, text)
    return text
  } catch (err) {
    log.warn("latex_template_upstream_fetch_failed", {
      path: file.path,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export const latexTemplateBundle = async (
  id: LatexTemplateId,
  fetchImpl: typeof fetch = fetch,
  // Test seam: the pinned files to fetch, so a suite can verify the hash check without
  // the real kit's bytes.
  upstream: readonly PinnedUpstreamFile[] = latexTemplateUpstreamFiles(id),
): Promise<LatexTemplateBundle> => {
  const t = latexTemplate(id)
  const files: Record<string, string> = { ...t.files }
  const notes: string[] = []
  let missing = false
  for (const file of upstream) {
    const text = await fetchPinned(file, fetchImpl)
    if (text === null) missing = true
    else files[file.path] = text
  }
  if (missing) {
    notes.push(CVPR_KIT_MISSING_NOTE)
    // main.tex travels with the bundle; the receipt does not. A leading TeX comment is
    // the first thing the author sees when they open the paper to compile it.
    const main = files["main.tex"]
    if (main !== undefined) files["main.tex"] = `%% ${CVPR_KIT_MISSING_NOTE}\n${main}`
  }
  return { id, label: t.label, description: t.description, entry: t.entry, files, notes }
}

/** Test seam: forget fetched upstream files. */
export const resetLatexTemplateCache = (): void => cache.clear()
