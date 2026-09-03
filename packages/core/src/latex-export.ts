/**
 * "Download LaTeX source": the plan for a zip that compiles the paper the way the page
 * shows it, in Overleaf or a local TeX Live, with no Derive in the loop.
 *
 * A paper on Derive has three kinds of content the source alone does not carry: the
 * dynamic tables and figures (their values live beside the version, not in the .tex),
 * figures uploaded as assets (referenced as `/blob/<sha256>.png` URLs), and, for the CVPR
 * template, style files fetched at creation. The plan copies every bundle file, writes
 * `derive.sty` and one `derive-dynamic/<name>.tex` fragment per binding from the slot's
 * current value, rewrites blob URLs to `figures/<sha>.<ext>` files it adds, and writes a
 * `README-derive.md` with the provenance and every caveat it found. Pure: the API layer
 * hands in the bytes and zips the result.
 */

import {
  DERIVE_STY,
  dynamicFigureTex,
  dynamicTableTex,
  escapeLatex,
  injectDerivePackage,
  latexDynamicBindings,
} from "./latex-dynamic"
import type { DynamicValueLike } from "./latex-emit"

export interface LatexExportInput {
  /** The entry document's path inside `files` (`main.tex`). */
  entry: string
  /** Every file of the artifact by bundle path: text for `.tex`/`.bib`/`.sty`, bytes for the
   *  rest. A single-file artifact passes just its entry. */
  files: Record<string, string | Uint8Array>
  /** The version's dynamic slots by name (a missing name has no data yet). */
  slots: Record<string, DynamicValueLike>
  /** Slot revisions by name, for the README's provenance line. */
  slotRevisions?: Record<string, number>
  /** Bytes of blob-referenced images by sha256, with the extension the asset was stored
   *  under. Collected by the caller from `blobRefsIn` and the figure slots' urls. */
  blobs: Record<string, { bytes: Uint8Array; ext: string }>
  meta: {
    title: string | null
    shortId: string
    version: number
    url: string
    exportedAt: string
  }
}

export interface LatexExportPlan {
  files: Record<string, string | Uint8Array>
  /** Caveats the README repeats: a figure format pdfLaTeX cannot read, a slot without
   *  data, a style file the bundle lacks. Empty when the zip compiles as is. */
  notes: string[]
}

const BLOB_REF = /\/blob\/([0-9a-f]{64})(?:\.([a-z0-9]+))?/gi

/** Every `/blob/<sha256>[.ext]` reference in a text, deduplicated by hash. */
export const blobRefsIn = (text: string): { sha: string; ext: string | null }[] => {
  const seen = new Map<string, string | null>()
  for (const m of text.matchAll(BLOB_REF)) {
    const sha = (m[1] as string).toLowerCase()
    if (!seen.has(sha)) seen.set(sha, m[2] ? m[2].toLowerCase() : null)
  }
  return [...seen].map(([sha, ext]) => ({ sha, ext }))
}

/** The blob hash a figure slot's url points at, when it is an asset URL. */
export const blobRefOfUrl = (url: string | null): { sha: string; ext: string | null } | null =>
  url ? (blobRefsIn(url)[0] ?? null) : null

const INCLUDEGRAPHICS_BLOB =
  /(\\includegraphics(?:\[[^\]]*\])?\{)([^}]*\/blob\/([0-9a-f]{64})(?:\.([a-z0-9]+))?)\}/gi

/** Image formats pdfLaTeX reads. Anything else compiles only after a conversion. */
const PDFLATEX_IMAGE = new Set(["png", "jpg", "jpeg", "pdf"])

const isTex = (path: string): boolean => /\.tex$/i.test(path)

export const planLatexExport = (input: LatexExportInput): LatexExportPlan => {
  const files: Record<string, string | Uint8Array> = { ...input.files }
  const notes: string[] = []
  const texSources = Object.entries(files).filter(
    (e): e is [string, string] => isTex(e[0]) && typeof e[1] === "string",
  )

  // 1. The bindings, across every .tex file: an \input'd section can hold a table too.
  const bindings = new Map<string, "table" | "figure">()
  for (const [, source] of texSources)
    for (const b of latexDynamicBindings(source))
      if (!bindings.has(b.name)) bindings.set(b.name, b.kind)

  // 2. derive.sty and \usepackage{derive} in the entry, so the fragments resolve.
  if (bindings.size) {
    files["derive.sty"] = DERIVE_STY
    const entry = files[input.entry]
    if (typeof entry === "string") files[input.entry] = injectDerivePackage(entry, true)
  }

  // 3. One fragment per binding from the slot's current value.
  for (const [name, kind] of bindings) {
    const value = input.slots[name]
    const fragment = `derive-dynamic/${name}.tex`
    if (kind === "table") {
      if (value?.kind === "table") files[fragment] = dynamicTableTex(value.table)
      else {
        files[fragment] = `\\derivemissing{${escapeLatex(name)}}\n`
        notes.push(`Dynamic table "${name}" has no data yet; the paper prints a placeholder box.`)
      }
      continue
    }
    const url = value?.kind === "figure" ? value.figure.url : null
    if (!url) {
      files[fragment] = dynamicFigureTex(null, name)
      notes.push(`Dynamic figure "${name}" has no image yet; the paper prints a placeholder box.`)
      continue
    }
    const ref = blobRefOfUrl(url)
    const blob = ref ? input.blobs[ref.sha] : undefined
    if (!ref || !blob) {
      files[fragment] = dynamicFigureTex(null, name)
      notes.push(
        ref
          ? `Dynamic figure "${name}" points at an asset that could not be read; the paper prints a placeholder box.`
          : `Dynamic figure "${name}" points at an external URL (${url}); download it and reference it with \\includegraphics.`,
      )
      continue
    }
    const image = `derive-dynamic/${name}.${blob.ext}`
    files[image] = blob.bytes
    files[fragment] = dynamicFigureTex(image, name)
    if (!PDFLATEX_IMAGE.has(blob.ext))
      notes.push(
        `Dynamic figure "${name}" is a .${blob.ext} file; pdfLaTeX reads PNG, JPEG and PDF, so convert ${image} before compiling.`,
      )
  }

  // 4. Uploaded figures: \includegraphics{/blob/<sha>.png} becomes figures/<sha>.png.
  // Read the entry back from `files`: step 2 may have rewritten it.
  for (const [path] of texSources) {
    const source = files[path]
    if (typeof source !== "string") continue
    let changed = false
    const rewritten = source.replace(
      INCLUDEGRAPHICS_BLOB,
      (whole, open: string, _target: string, shaRaw: string, extRaw: string | undefined) => {
        const sha = shaRaw.toLowerCase()
        const blob = input.blobs[sha]
        if (!blob) {
          notes.push(
            `${path}: the figure ${sha.slice(0, 12)}… could not be read; its \\includegraphics still points at the Derive URL.`,
          )
          return whole
        }
        const ext = blob.ext || extRaw?.toLowerCase() || "png"
        const file = `figures/${sha}.${ext}`
        files[file] = blob.bytes
        if (!PDFLATEX_IMAGE.has(ext))
          notes.push(
            `${file} is a .${ext} file; pdfLaTeX reads PNG, JPEG and PDF, so convert it before compiling.`,
          )
        changed = true
        return `${open}${file}}`
      },
    )
    if (changed) files[path] = rewritten
  }

  // 5. Style files a class needs that this bundle does not carry.
  const allTex = texSources.map(([, s]) => s).join("\n")
  if (/\\usepackage(?:\[[^\]]*\])?\{cvpr\}/.test(allTex) && !files["cvpr.sty"])
    notes.push(
      "main.tex loads cvpr.sty, which is not in this bundle; add it from https://github.com/cvpr-org/author-kit next to main.tex.",
    )
  if (/\\bibliographystyle\{ieeenat_fullname\}/.test(allTex) && !files["ieeenat_fullname.bst"])
    notes.push(
      "main.tex uses ieeenat_fullname.bst, which is not in this bundle; add it from https://github.com/cvpr-org/author-kit next to main.tex.",
    )

  const unique = [...new Set(notes)]
  files["README-derive.md"] = readme(input, bindings, unique)
  return { files, notes: unique }
}

const readme = (
  input: LatexExportInput,
  bindings: Map<string, "table" | "figure">,
  notes: string[],
): string => {
  const { meta } = input
  const lines = [
    `# ${meta.title ?? "Paper"}: LaTeX source from Derive`,
    "",
    `Exported from ${meta.url} (version ${meta.version}) on ${meta.exportedAt}.`,
    "",
    "## Compile",
    "",
    "- Overleaf: New Project, Upload Project, choose this zip. Set the main document to",
    `  \`${input.entry}\` and the compiler to pdfLaTeX, then Recompile.`,
    `- Locally: \`pdflatex ${input.entry.replace(/\.tex$/i, "")} && bibtex ${input.entry.replace(/\.tex$/i, "")} && pdflatex ${input.entry.replace(/\.tex$/i, "")} && pdflatex ${input.entry.replace(/\.tex$/i, "")}\`.`,
    "",
  ]
  if (bindings.size) {
    lines.push(
      "## Dynamic tables and figures",
      "",
      "`derive.sty` defines `\\derivetable{name}` and `\\derivefigure{name}`; each reads",
      "`derive-dynamic/<name>.tex`, written from the slot's value at export time. Edit the",
      "paper, not those fragments: the next download regenerates them.",
      "",
      "| Slot | Kind | Revision |",
      "| --- | --- | --- |",
    )
    for (const [name, kind] of bindings)
      lines.push(`| \`${name}\` | ${kind} | ${input.slotRevisions?.[name] ?? "no data"} |`)
    lines.push("")
  }
  if (notes.length) {
    lines.push("## Before you compile", "")
    for (const n of notes) lines.push(`- ${n}`)
    lines.push("")
  }
  return `${lines.join("\n")}\n`
}
