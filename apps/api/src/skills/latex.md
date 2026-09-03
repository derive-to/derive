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
  labelled "LaTeX" as well. Upload figures with `stage({target:'asset'})` and reference them as
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
resolve against the bundle's `.bib` (or a compiled `.bbl`, which wins when present) and
print as `[1]`, `[2]` on the page whatever the class says (the compiled PDF keeps the
class's own style); a References section with matching `[n]` markers, entries formatted
in the class's style and sorted alphabetically, is printed where `\bibliography` stands.

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

## Start from a template

`read("derive://latex/templates/acm-siggraph")` or `read("derive://latex/templates/cvpr")`
returns a files map (`main.tex`, the `.bib`, `README.md`, `derive.sty`; for CVPR the author
kit's `cvpr.sty` and `ieeenat_fullname.bst`, fetched at read time). Publish it as is:
`publish({ title, files })`. Both starters bind `results` (table) and `teaser` (figure),
seeded empty at publish, so the data API works from the first version. The same maps are
at `GET /v1/latex/templates/<id>`; `derive init --template siggraph|cvpr` scaffolds one.
If the CVPR kit could not be fetched the map's `notes` say so and the README repeats it.

## Download the source

`GET /v1/artifacts/<short_id>/source.zip` (add `?v=<n>` for an older version; use a
`stage({target:'api'})` bearer with curl) is a zip that compiles in Overleaf or TeX Live:
every bundle file, `derive.sty`, one `derive-dynamic/<name>.tex` per binding written from
the slot's current value (and the image file for a figure), uploaded figures rewritten
from `/blob/<sha>` URLs to `figures/<sha>.<ext>`, and a `README-derive.md` with the
provenance and any caveat (a WebP figure pdfLaTeX cannot read, a slot with no data, a
missing style file). The viewer's More menu has the same download.

## Reading and commenting

`read(format:'text')` returns the rendered prose without macros; `format:'html'` returns
the source for `edits`. Comments anchor to the rendered text; select prose, not a formula
(math is typeset client-side and has no server-side text), and a quote that crosses a
macro cannot be edited inline. On a paper bundle, `edits` apply to the entry file
(`main.tex`) and republish the whole bundle; text that comes from an `\input` file is
refused with the file's name, so republish that file with `files` + `merge`.

## Citing

The bundle's `.bib` is the source of truth for references. `read(short_id)` on a paper
bundle lists `bibliography` (key, authors, year, title) and `cited`; cite with
`\cite{key}` (or `\citep`/`\citet`; the page prints `[n]` either way) using a listed key, never an
invented one. The publish receipt reports any `\cite` that did not resolve. To add,
change or remove an entry without rewriting the file, send its BibTeX to
`PUT /v1/artifacts/<short_id>/bib` with a bearer from `stage({ target: 'api' })`:
`{ "base_version": <version>, "ops": [{ "op": "set", "raw": "@article{key, ...}" }] }`.
`{ "op": "set", "key": "old", "raw": "..." }` replaces one entry (a new key in the text
renames it) and `{ "op": "delete", "key": "old" }` removes one; every save is a new
version, and comments, `@string` macros and untouched entries survive byte for byte.
`GET` the same path to list entries with their `raw` text. `publish({ short_id, merge:
true, files: { "refs.bib": <whole file> } })` rewrites the file instead. A single-file
paper has no `.bib` to cite from; publish it as a bundle.
