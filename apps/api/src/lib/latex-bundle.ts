import {
  type BibDiagnostic,
  type BibEntry,
  type BlobStore,
  type BundleManifest,
  parseBibtex,
  renderLatex,
} from "@derive/core"
import { cleanPath } from "./bundle"

/** The text files a LaTeX page may `\input` or cite, decoded up front so the renderer's
 *  synchronous lookups can answer. Capped so a bundle full of data files cannot make one
 *  page read the whole store: past the cap a file is simply absent, and the page says so. */
const MAX_BUNDLE_TEXT_BYTES = 4 * 1024 * 1024
export const TEXT_FILE = /\.(tex|latex|bib|bbl|sty|cls|bst|txt)$/i

/** Decoded text files by manifest path (`/main.tex`, `/refs.bib`). */
export const bundleTextFiles = async (
  blobs: BlobStore,
  manifest: BundleManifest,
): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  let bytes = 0
  for (const [path, file] of Object.entries(manifest.files)) {
    if (!TEXT_FILE.test(path)) continue
    const data = await blobs.get(file.key)
    if (!data) continue
    bytes += data.byteLength
    if (bytes > MAX_BUNDLE_TEXT_BYTES) break
    out.set(path, new TextDecoder().decode(data))
  }
  return out
}

/** The renderer's `resolve` over decoded files: paths the way a document writes them
 *  (`sec/intro.tex`, `./refs.bib`, `/figures/a.tex`) against the manifest's slashed keys. */
export const bundleTextResolver =
  (files: Map<string, string>) =>
  (file: string): string | null =>
    files.get(`/${file.replace(/^\.?\//, "")}`) ?? null

export interface PaperBibliography {
  /** Clean bundle path of the `.bib` file (`refs.bib`). */
  path: string
  source: string
  entries: BibEntry[]
  /** Citation keys the entry file uses, in first-cited order. */
  cited: string[]
  diagnostics: BibDiagnostic[]
}

/** The bibliography a paper bundle edits: the first file its entry names with
 *  `\bibliography{}`. `{ missing }` when that file is not in the bundle; null when the
 *  paper names none (or its entry cannot be read). */
export const paperBibliography = async (
  blobs: BlobStore,
  manifest: BundleManifest,
  files?: Map<string, string>,
): Promise<PaperBibliography | { missing: string } | null> => {
  const texts = files ?? (await bundleTextFiles(blobs, manifest))
  const entry = texts.get(`/${cleanPath(manifest.entry)}`)
  if (entry === undefined) return null
  const resolve = bundleTextResolver(texts)
  const rendered = renderLatex(entry, null, { resolve })
  const name = rendered.bibFiles[0]
  if (!name) return null
  // The same lookup the renderer makes (latex-cite.ts loadBibliography): `refs` or `refs.bib`.
  for (const candidate of [/\.bib$/i.test(name) ? name : `${name}.bib`, name]) {
    const source = resolve(candidate)
    if (source === null) continue
    const parsed = parseBibtex(source)
    return {
      path: cleanPath(candidate.replace(/^\.\//, "")),
      source,
      entries: parsed.entries,
      cited: rendered.cited,
      diagnostics: parsed.diagnostics,
    }
  }
  return { missing: name }
}
