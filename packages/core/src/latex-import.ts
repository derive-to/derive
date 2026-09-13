/**
 * Turning a paper's source archive into a publishable LaTeX bundle.
 *
 * An arXiv source tarball is whatever the authors uploaded: sometimes `main.tex` at the
 * root, often `paper.tex` beside a `main.tex` that is only a chapter, a wrapping
 * directory, macOS resource forks, a README that says which file is the paper, a
 * `.bbl` named after the entry, latin-1 text from an older decade. This module reads
 * those conventions so the published bundle enters at the actual paper and renders the
 * way the PDF did, without renaming anything the authors wrote. Every decision it makes
 * is returned as a note for the import record.
 *
 * Every decision needs only the paths, the sizes, and the bytes of a few text files: the
 * `.tex` candidates and arXiv's 00README, decoded only to be read. So the planner works
 * over whatever the caller holds (`planLatexSource`): the files themselves, or references
 * to files an import already streamed into the blob store. Figures are never read, and
 * reach the bundle untouched.
 */

import { isLatexDocument } from "./latex"
import { cleanPath } from "./publish"

export interface NormalizedLatexSource {
  ok: true
  /** Files by slashed bundle path, ready for `publish({ files })`. */
  files: Record<string, Uint8Array>
  /** The bundle path of the paper's top-level file. */
  entry: string
  /** How the entry was chosen, what was dropped, what was transcoded. */
  notes: string[]
}

/** The same decisions over files the caller does not hold in memory. */
export interface LatexSourcePlan<F> {
  ok: true
  files: Record<string, F>
  entry: string
  notes: string[]
  /** Text files to transcode from latin-1 to UTF-8 before publishing, by bundle path. The
   *  planner decides; the caller reads the bytes wherever it keeps them. Empty unless the
   *  entry declares latin-1. */
  transcode: string[]
}

/** How the planner sees a file: its size, and the bytes of a file it reads (see
 *  `readsLatexText`), or null when the caller did not keep them. */
export interface LatexSourceView<F> {
  size(file: F): number
  text(file: F): Uint8Array | null
}

export type LatexImportRefusalCode = "no_tex"

export interface LatexImportRefusal {
  ok: false
  code: LatexImportRefusalCode
  detail: string
}

const TEX = /\.(tex|latex)$/i
const TEXT_FOR_TRANSCODE = /\.(tex|latex|bib|bbl|sty|cls)$/i
const README = /(^|\/)00README\.(json|XXX)$/
/** Root files that would hijack the bundle's entry or its type (see pickBundleEntry). */
const RESERVED_ROOT = new Set(["/index.html", "/SKILL.md", "/MANIFEST.md"])

const utf8 = new TextDecoder()
const latin1 = new TextDecoder("latin1")
const EMPTY = new Uint8Array()

/** Whether planning a source reads this file's bytes: the `.tex` candidates and arXiv's
 *  00README. An import streaming an archive keeps these in memory and everything else by
 *  reference, a bibliography included however large it is. */
export const readsLatexText = (path: string): boolean => TEX.test(path) || README.test(path)

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)
const stripExt = (name: string): string => name.replace(TEX, "")

/** `00README.XXX` (`<file> toplevelfile`) or `00README.json` (`usage: "toplevel"`), the
 *  files arXiv's own build reads to find the paper. */
const readmeToplevel = <F>(files: Record<string, F>, view: LatexSourceView<F>): string | null => {
  const read = (path: string): Uint8Array | null => {
    const file = files[path]
    return file === undefined ? null : view.text(file)
  }
  const json = read("/00README.json")
  if (json) {
    try {
      const parsed = JSON.parse(utf8.decode(json)) as {
        sources?: { filename?: string; usage?: string }[]
      }
      const top = parsed.sources?.find((s) => s.usage === "toplevel")?.filename
      if (typeof top === "string" && top) return top
    } catch {
      // Not the documented shape; fall through to the text form and the sniff.
    }
  }
  const xxx = read("/00README.XXX")
  if (xxx) {
    for (const line of utf8.decode(xxx).split(/\r?\n/)) {
      const m = /^(\S+)\s+toplevelfile\s*$/.exec(line.trim())
      if (m?.[1]) return m[1]
    }
  }
  return null
}

const INPUT_MACRO = /\\(?:input|include|subfile|import)\s*\{([^}]+)\}/g

/**
 * Plan an unpacked source archive: which files the bundle holds, by bundle path, and the
 * entry to render. Refuses (`no_tex`) when nothing in it is a LaTeX document.
 */
export const planLatexSource = <F>(
  raw: Record<string, F>,
  view: LatexSourceView<F>,
): LatexSourcePlan<F> | LatexImportRefusal => {
  const notes: string[] = []
  let files: Record<string, F> = {}
  for (const [name, data] of Object.entries(raw)) {
    const path = cleanPath(name)
    if (!path) continue
    // AppleDouble resource forks travel beside real files in a macOS-made archive.
    if (basename(path).startsWith("._")) continue
    files[path] = data
  }
  // A wrapping directory (`paper-v2/main.tex`) is not part of the paper.
  const roots = new Set(Object.keys(files).map((p) => p.split("/")[1] ?? ""))
  if (roots.size === 1 && Object.keys(files).every((p) => p.split("/").length > 2)) {
    const [root] = roots
    files = Object.fromEntries(
      Object.entries(files).map(([p, d]) => [p.slice(`/${root}`.length), d]),
    )
    notes.push(`unwrapped the top-level directory ${root}/`)
  }
  for (const reserved of RESERVED_ROOT) {
    if (files[reserved] !== undefined) {
      delete files[reserved]
      notes.push(`dropped ${reserved.slice(1)}, which would have replaced the paper as the entry`)
    }
  }

  const texPaths = Object.keys(files).filter((p) => TEX.test(p))
  if (texPaths.length === 0) return { ok: false, code: "no_tex", detail: "no .tex file" }
  const sizeOf = (p: string): number => {
    const file = files[p]
    return file === undefined ? 0 : view.size(file)
  }
  const texts = new Map<string, string>()
  const textOf = (p: string): string => {
    let t = texts.get(p)
    if (t === undefined) {
      const file = files[p]
      t = utf8.decode((file === undefined ? null : view.text(file)) ?? EMPTY)
      texts.set(p, t)
    }
    return t
  }

  let entry: string | null = null
  const declared = readmeToplevel(files, view)
  if (declared) {
    const path = cleanPath(declared)
    if (path && files[path] !== undefined && TEX.test(path)) {
      entry = path
      notes.push(`entry ${path.slice(1)} named by the archive's 00README`)
    }
  }
  if (!entry && files["/main.tex"] !== undefined && isLatexDocument(textOf("/main.tex")))
    entry = "/main.tex"
  if (!entry) {
    const documents = texPaths.filter((p) => isLatexDocument(textOf(p)))
    // A document another file pulls in is a part, not the paper.
    const included = new Set<string>()
    for (const p of texPaths) {
      for (const m of textOf(p).matchAll(INPUT_MACRO)) {
        const target = stripExt((m[1] ?? "").trim().replace(/^\.\//, ""))
        included.add(basename(target))
      }
    }
    const candidates = documents.filter((p) => !included.has(stripExt(basename(p))))
    const pool = candidates.length > 0 ? candidates : documents
    const score = (p: string): [number, number, number] => [
      /^[ \t]*\\begin\{document\}/m.test(textOf(p)) ? 0 : 1,
      p.split("/").length,
      -sizeOf(p),
    ]
    pool.sort((a, b) => {
      const sa = score(a)
      const sb = score(b)
      return sa[0] - sb[0] || sa[1] - sb[1] || sa[2] - sb[2] || a.localeCompare(b)
    })
    entry = pool[0] ?? null
    if (entry) notes.push(`entry ${entry.slice(1)} chosen by its \\documentclass`)
  }
  if (!entry) return { ok: false, code: "no_tex", detail: "no .tex file declares a document class" }

  // The renderer looks for the compiled bibliography at main.bbl; a paper named
  // otherwise ships `<entry>.bbl`, so make it findable without touching the original.
  const entryBbl = `${entry.replace(TEX, "")}.bbl`
  const bbl = files[entryBbl]
  if (files["/main.bbl"] === undefined && entryBbl !== "/main.bbl" && bbl !== undefined) {
    files["/main.bbl"] = bbl
    notes.push(`copied ${entryBbl.slice(1)} to main.bbl for the bibliography`)
  }

  // Older sources declare latin-1; the renderer decodes UTF-8, so the text files are
  // transcoded (figures and everything binary stay as shipped).
  let transcode: string[] = []
  if (/\\usepackage\s*\[\s*latin[19]\s*\]\s*\{inputenc\}/.test(textOf(entry))) {
    transcode = Object.keys(files).filter((p) => TEXT_FOR_TRANSCODE.test(p))
    notes.push("transcoded the text files from latin-1 to UTF-8")
  }

  return { ok: true, files, entry, notes, transcode }
}

const BYTES: LatexSourceView<Uint8Array> = { size: (b) => b.byteLength, text: (b) => b }

/**
 * Normalise an unpacked source archive held in memory into bundle files plus the entry to
 * render: the plan, with its transcoding applied. Refuses (`no_tex`) when nothing in it is
 * a LaTeX document.
 */
export const normalizeLatexSource = (
  raw: Record<string, Uint8Array>,
): NormalizedLatexSource | LatexImportRefusal => {
  const plan = planLatexSource(raw, BYTES)
  if (!plan.ok) return plan
  const enc = new TextEncoder()
  for (const p of plan.transcode) {
    const d = plan.files[p]
    if (d) plan.files[p] = enc.encode(latin1.decode(d))
  }
  return { ok: true, files: plan.files, entry: plan.entry, notes: plan.notes }
}
