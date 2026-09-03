# LaTeX papers

A paper published to Derive is stored as its LaTeX source and read as a web page. Derive
renders the source to HTML when it serves the artifact: the title block, sections, prose,
lists, tables, figures, footnotes, math (typeset in the browser by KaTeX) and citations
resolved from BibTeX. The page is commentable, editable and searchable the way a Markdown
document is, and the source you published is exactly what comes back from the API.

There is no PDF tier. The page is the structural reading of the paper; the LaTeX source is
what compiles, and it stays the source of truth.

## Publishing a paper

- **A single `.tex` file** publishes like any file: upload `paper.tex`, or pass `content`
  with `filename: "paper.tex"` over the API or MCP. A payload that begins with
  `\documentclass` or `\begin{document}` is typed as LaTeX even without a filename. The
  artifact's type is `text/x-latex`, shown as "LaTeX".
- **A paper bundle** is a zip (or an MCP `files` map) with `main.tex` at its root, plus the
  `.bib`, the sections it `\input`s, its figures and any class or style files. The entry
  is `main.tex` (else the shallowest `.tex`); relative paths resolve inside the bundle. The
  artifact's type is `derive/latex`, shown as "Paper", and the viewer lists the files
  beside the page.
- **Figures** in a bundle are referenced by relative path (`\includegraphics{figures/teaser}`
  tries `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`). In a single file, upload the image
  as an asset and reference the `/blob/<sha256>.png` URL the upload returns. PDF and EPS
  figures cannot be shown in the browser; keep a PNG or JPEG export beside them.

Revisions keep the type: an inline edit, an `edits` batch or a full republish of a LaTeX
artifact stays LaTeX.

## What renders

Sectioning (`\section` to `\subparagraph`, `\appendix`), prose and formatting, footnotes,
lists, quotes, verbatim and listings, `tabular` and its relatives with booktabs rules,
`\multicolumn` and `\multirow`, `figure` and `table` floats with numbered captions,
sub-floats, `\ref`/`\eqref`/`\autoref`/`\cref`, `\url`/`\href`, theorem-like environments,
and math in every common delimiter and environment, numbered and cross-referenced.
`\newcommand` definitions are expanded in prose and handed to the typesetter for math.

The renderer knows two classes well:

- **acmart** (ACM SIGGRAPH and the ACM journals): authors with affiliations, ORCID and
  email, the conference or journal line, the abstract, CCS concepts from `\ccsdesc`,
  keywords and the teaser figure are typeset at `\maketitle` the way the class does;
  `anonymous` and `review` behave as in the class; citations are author-year for journals
  and with `\citestyle{acmauthoryear}`, numeric otherwise; journal formats label floats
  `Fig. 1.`.
- **The CVPR author kit** (`article` with `\usepackage[review|final]{cvpr}`): the review
  band with the paper id in review mode, author columns in final mode, numeric compressed
  citations and cleveref wording.

Other classes render generically.

Citations resolve against the `.bib` files named in `\bibliography{...}`, formatted in the
class's style (ACM-Reference-Format for acmart, ieeenat_fullname for CVPR) and sorted
alphabetically. A compiled `.bbl` beside `main.tex` takes precedence: it is what the PDF
shows.

## When something is unsupported

The page always renders. An unknown macro prints nothing while the text in its braces
survives; an unknown environment renders its body; a TikZ picture shows a placeholder;
an unresolved `\ref` prints `??` and an unresolved `\cite` prints its key. Each of these
is reported once, with its source line, in the publish response's `advisories`, together
with figures the artifact cannot reach, a missing `.bib`, and, for acmart, every
`\usepackage` that ACM TAPS does not accept or that the class already loads.

## Dynamic tables and figures

`\derivetable{results}` and `\derivefigure[width=0.8\linewidth]{ablation}` bind a
[dynamic slot](dynamic-data.md): the page shows the slot's current value, updates land
through the dynamic-data API without a new version, and each version keeps the data it
had. Place them inside a `table` or `figure` environment with a `\caption`, as you would a
`tabular`.

## Comments, edits and reads

Comments anchor to the rendered prose and re-anchor on republish through the same
projection. Select words rather than formulas: math is typeset in the browser and has no
server-side text, so a quote across a formula goes outdated when the paper changes.
Inline edits map back to the source through the projection; an edit that would cross a
macro boundary or a generated label (a citation, a section number) is refused with a
message instead of guessed.

`GET /v1/artifacts/:id/content` returns the source; `?format=text` returns the rendered
prose; `?outline=1` lists the sections with the ids the page uses; `?section=<slug>`
returns one section's source. Over MCP, `read(format:'text')` and `read(format:'html')`
do the same.

## Math in the browser

Formulas are shipped as TeX inside the page and typeset by KaTeX, served from the
instance's own copy under `/raw/vendor/katex/<version>/`. No third-party host is
contacted. If the typesetter cannot load, the page shows the TeX source in place of each
formula.
