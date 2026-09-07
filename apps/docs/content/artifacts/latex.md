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
  artifact's type is `derive/latex`, shown as "LaTeX" as well, and the viewer lists the files
  beside the page.
- **Figures** in a bundle are referenced by relative path (`\includegraphics{figures/teaser}`
  tries `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`). In a single file, upload the image
  as an asset and reference the `/blob/<sha256>.png` URL the upload returns. PDF and EPS
  figures cannot be shown in the browser; keep a PNG or JPEG export beside them.

Revisions keep the type: an inline edit, an `edits` batch or a full republish of a LaTeX
artifact stays LaTeX. The Edit button on a LaTeX artifact opens the source editor, since a
paper is written in its source; a quick fix to a sentence on the page is still one `e`
keystroke, or Edit on a selection, away.

## Importing a paper from arXiv

A paper somebody else wrote can join a workspace as a read-only Context. On the
new-context page, "Import a paper from arXiv" takes the abstract page, a PDF link, the
DOI, an `arXiv:` reference or a bare id; the form says what it will fetch as you type
and refuses anything that is not an arXiv reference. The Context appears in the list
at once, marked "fetching from arXiv", and a worker fetches the paper in the background:
its metadata (title, authors, abstract), its LaTeX source (never the PDF) and the BibTeX
entry arXiv publishes for it, in that order and never faster than arXiv allows (one
request every three seconds for the whole deployment, further apart when arXiv asks).

What lands is one artifact: the paper. It exists from the moment you paste the link, as a
placeholder document that says the fetch is on its way, and the worker republishes it as
the paper itself, entering at the paper's own top-level file (the archive's `00README` is
honoured, a `main.tex` that is only a chapter is not mistaken for the paper, figures arrive
byte for byte, a `.bbl` is found), with the paper's citation entry beside it as
`CITATION.bib`. It is locked, tagged `arxiv`, attributed to its authors, and never given a
world link: arXiv's licence permits the workspace's own reading, not redistribution. What
the import decided is recorded on the version, where it reads as history.

**You read the paper, not its LaTeX.** The page renders the paper, with its own title,
authors and abstract, and that is the whole surface: an imported paper offers no file list,
no source download, no bibliography editor and no diff, and its raw source is not served to
a person. Agents keep full access, because reading the source is how a model understands a
paper: `read` on the Context returns a summary (authors, abstract, BibTeX) computed from
the paper, `documents` names the one artifact, and reading that short id gives the source
section by section plus the `citation` to cite it with. `use` refuses it, since nothing runs
it. People open it from the Contexts list, where the arXiv chip marks it, and from the
Templates page's Academic section.

A published bundle may hold at most 50 MB (30 MB on the Workers tier) and 2000 files.
The worker pulls up to 150 MB from arXiv to get there: when the unpacked source is over
the limit, the raster figures (PNG, JPEG, WebP) are re-encoded in place, largest first,
to at most 1600 px on the long side, then 1200, then 900, until the bundle fits; a
figure keeps its path and format, so every reference still resolves, and the manifest's
Import notes say what was shrunk and by how much. PDF and EPS figures are never touched;
a source that still does not fit fails naming its largest files. Workers deployments do
not shrink and refuse an oversized source as before. A paper arXiv holds only as a PDF,
one whose source has no document, one that was withdrawn or one arXiv does not know fails
at once with a reason; arXiv being slow or away is retried three times. A failed import can be tried again from its console, or
discarded, which removes the Context and its generated manifest (a paper already
published stays in the library). The same paper pasted twice opens the one Context.

## Start from a template

Two paper starters ship with Derive: **ACM SIGGRAPH** (acmart in the sigconf format,
author-year citations in the compiled PDF; switch to `acmtog` for the journal track) and
**CVPR** (the author kit's layout in review mode, numeric citations). The page cites by
number for both, as every paper does. On the Templates page, choose one under
Academic: the New page opens with `main.tex` in the editor, and publishing creates a paper
bundle with the `.bib` and `derive.sty`. Both starters bind a `results` table
and a `teaser` figure, seeded empty at publish, so the [dynamic data](dynamic-data.md)
API works from the first version.

Over MCP, `read("derive://latex/templates/<id>")` returns the same files map for
`publish({ files })`; over REST it is `GET /v1/latex/templates/<id>`; the CLI has
`derive init --template siggraph|cvpr`.

The CVPR author kit publishes `cvpr.sty` and `ieeenat_fullname.bst` without a license, so
Derive does not ship them. Creating a CVPR paper fetches both from a pinned commit of the
kit into the bundle, verified against pinned hashes. If the fetch fails the paper is still
created and a comment at the top of `main.tex` says what to add.

## Download the source

"Download LaTeX source" in the viewer's More menu (or
`GET /v1/artifacts/:id/source.zip`, with `?v=n` for an older version) is a zip that
compiles as is: every bundle file, `derive.sty`, one `derive-dynamic/<name>.tex` fragment
per dynamic binding written from the slot's current value (plus the image file for a
figure), uploaded figures rewritten from their `/blob/<sha>` URLs to `figures/<sha>.<ext>`
files, and a `README-derive.md` with the provenance, the Overleaf steps and every caveat
the exporter found: a WebP or GIF figure pdfLaTeX cannot read, a slot without data, a
style file the bundle lacks. Upload the zip to Overleaf, set `main.tex` as the main
document and pdfLaTeX as the compiler.

The export finds dynamic bindings through the same entry traversal as the renderer.
Unused `.tex` drafts remain in the archive, but do not create dynamic fragments or
override bindings in the paper. First occurrence follows the paper's include order.

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
  `anonymous` and `review` behave as in the class; journal formats label floats
  `Fig. 1.`.
- **The CVPR author kit** (`article` with `\usepackage[review|final]{cvpr}`): the review
  band with the paper id in review mode, author columns in final mode, numeric compressed
  citations and cleveref wording.

Other classes render generically.

Citations resolve against the `.bib` files named in `\bibliography{...}` and print as
`[1]`, `[2]` in the text on every paper, whatever the class's own citation style (the
compiled PDF keeps that style); the References section carries the matching `[n]`
markers, with entries formatted in the class's style (ACM-Reference-Format for acmart,
ieeenat_fullname for CVPR) and sorted alphabetically, so `[3]` in the text is the third
entry. A compiled `.bbl` beside `main.tex` takes precedence: it is what the PDF shows.

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
projection. Math is typeset in the browser and counts as no characters on both sides,
so a quote that runs past a formula still anchors and survives a republish.

### Editing a paper

Edit on the page (the Edit button, or `e`) works for prose paragraphs, list items,
figure and table captions, section headings, the title and the abstract. Formulas,
tables, images, dynamic tables and figures, footnotes, theorem text, the author block,
generated numbers and labels and the reference list are read-only on the page: a click
on them says so, the caret steps over them, and a Backspace beside a formula cannot
delete it. Everything else is a source edit. The file chips above a paper bundle list
`main.tex` first, then the files at the bundle's root, then one chip per folder: a folder
glyph, the folder's name and a count of the files inside. Pointing at a folder chip opens
a small tree of its contents (twelve rows visible per list, the rest scroll; a nested
folder expands inside it); a root `README.md` is not shown. A chip or a tree row opens
that file in the source editor, whose right pane renders the whole paper with the file
you are typing substituted (sections, citations, figures and dynamic tables included),
and the chips stay in view while you edit so you can move between files; an image opens
in a new tab. Leaving a file with unsaved changes asks first. Every save is a new version
of the bundle, with the other files carried over. An inline edit whose words come from an
`\input` file is refused with the file's name; open that file instead.

### Bibliography

A paper bundle's `.bib` is the source of truth for its references. The References tab
in the right rail lists every entry with its key and whether the paper cites it, and
lets an editor add an entry (paste its BibTeX), edit one as BibTeX, or remove one. Each
save publishes a new version; comments, `@string` macros and the untouched entries keep
their bytes. Agents see the same list in `read` and are told to cite with `\cite{key}`
from it rather than invent keys; the publish receipt reports any `\cite` that did not
resolve. The same edits are available over the API (`GET`/`PUT /v1/artifacts/:id/bib`)
and per file (`GET`/`PUT /v1/artifacts/:id/files/*`).

An edit that would cross a macro boundary or a generated label (a citation, a section
number) is refused with a message instead of guessed.

`GET /v1/artifacts/:id/content` returns the source; `?format=text` returns the rendered
prose; `?outline=1` lists the sections with the ids the page uses; `?section=<slug>`
returns one section's source. Over MCP, `read(format:'text')` and `read(format:'html')`
do the same.

## Math in the browser

Formulas are shipped as TeX inside the page and typeset by KaTeX, served from the
instance's own copy under `/raw/vendor/katex/<version>/`. No third-party host is
contacted. If the typesetter cannot load, the page shows the TeX source in place of each
formula.
