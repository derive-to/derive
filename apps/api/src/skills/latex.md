---
name: latex
summary: publish a LaTeX paper as a rendered page (acmart, CVPR, .bib citations)
order: 4.6
---
# LaTeX papers

A paper is stored as its LaTeX source and read as a web page: Derive renders the source
to HTML at serve time (sections, prose, lists, tables, figures, math, citations), so the
paper is commentable, editable and searchable like a Markdown document, and the `.tex` you
publish is exactly what you get back. There is no PDF tier; the page is the structural
reading of the paper, and the LaTeX source stays what compiles.

## Publish

- **Single file.** `publish({ content, filename: "paper.tex" })`. A payload that starts with
  `\documentclass` or `\begin{document}` is typed as LaTeX even without a filename; name it
  anyway when the file is a chapter without either. Stored as `text/x-latex`, labelled
  "LaTeX".
- **Paper bundle.** `publish({ files: { "main.tex": ..., "refs.bib": ..., "sec/intro.tex": ...,
  "figures/teaser.png": "asset:<sha256>" } })`. The root `main.tex` is the entry (else the
  shallowest `.tex`); `\input{sec/intro}`, `\bibliography{refs}` and
  `\includegraphics{figures/teaser}` resolve inside the bundle. Stored as `derive/latex`,
  labelled "Paper". Upload figures with `stage({target:'asset'})` and reference them as
  `asset:<sha>` in the map, the same as any bundle.
- **Figures in a single file.** `\includegraphics{/blob/<sha256>.png}` with the URL an asset
  upload returns. PNG and JPEG only if the paper is meant to compile with pdfLaTeX later.
- **Revise** with `edits` (quote edits map onto the source through the rendered text) or a
  full `content` republish. The type is kept across revisions.

## What renders

`\section` to `\subparagraph` (numbered like the class), paragraphs, `\emph`/`\textbf`/
`\texttt` and friends, lists, `quote`, `verbatim` and listings, tables (`tabular`,
booktabs rules, `\multicolumn`), `figure`/`table` floats with captions, sub-floats,
footnotes, theorem-like environments, `\ref`/`\eqref`/`\cref`, `\url`/`\href`, and math
(`$…$`, `\[…\]`, `equation`, `align`, `gather`) typeset in the browser by KaTeX. Citations
resolve against the bundle's `.bib` (or a compiled `.bbl`, which wins when present) in the
class's style: author-year for acmart journals and `\citestyle{acmauthoryear}`, numeric
otherwise; a References section is printed where `\bibliography` stands.

Class awareness: **acmart** (title block, authors with affiliations and ORCID, the
conference or journal line, abstract, CCS concepts from `\ccsdesc`, keywords, the teaser,
`anonymous`/`review` modes) and the **CVPR author kit** (`\usepackage[review|final]{cvpr}`,
the review band and paper id, cleveref wording, numeric compressed citations). Other
classes render generically.

Fail-soft: an unknown macro prints nothing but its braces' text survives; an unknown
environment renders its body; TikZ shows a placeholder. Each of these is a diagnostic in
the publish receipt's `advisories`, with the source line, as are unresolved `\ref`/
`\cite`, a figure the artifact cannot reach, a missing `.bib`, and (for acmart) any
`\usepackage` ACM TAPS does not accept.

## Tables and figures that update without a version

`\derivetable{results}` and `\derivefigure[width=0.8\linewidth]{ablation}` bind a dynamic
slot (derive://skills/dynamic-data): the page shows the slot's current value, and updates
through `PATCH /v1/artifacts/<short_id>/dynamic/<name>` land without a new version. Put
them inside a `table` or `figure` environment with a `\caption` the way you would a
`tabular`.

## Reading and commenting

`read(format:'text')` returns the rendered prose without macros; `format:'html'` returns
the source for `edits`. Comments anchor to the rendered text; select prose, not a formula
(math is typeset client-side and has no server-side text), and a quote that crosses a
macro cannot be edited inline.
