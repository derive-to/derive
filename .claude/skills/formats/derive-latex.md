# derive-latex

Writing LaTeX papers for Derive. A paper is stored as its LaTeX source (a single `.tex`
file, or a bundle with `main.tex`, a `.bib` and figures) and rendered server-side to a
web page: sections, prose, tables, figures, math typeset by KaTeX in the browser, and
citations resolved from BibTeX. The source you publish is exactly what you get back.

---

## What renders

- Sectioning: `\section` to `\subparagraph`, numbered as the class numbers them; `\appendix`
- Prose: paragraphs, `\emph`, `\textbf`, `\texttt`, `\textsc`, super/subscript, `\footnote`,
  `\url`, `\href`, ligatures and accents
- Lists: `itemize`, `enumerate`, `description`; `quote`, `center`
- Code: `verbatim`, `lstlisting`, `minted`, `\verb`
- Tables: `tabular`, `tabular*`, `tabularx`, `longtable`, booktabs rules, `\multicolumn`,
  `\multirow`; `table` floats with `\caption` above the table
- Figures: `figure`/`figure*`, `subfigure`, `\subfloat`, `\includegraphics` (PNG, JPEG,
  GIF, WebP, SVG), `\caption` below, `\Description` as alt text
- Math: `$…$`, `\(…\)`, `\[…\]`, `equation`, `align`, `gather`, `multline`, numbered
  and cross-referenced; `\newcommand` macros reach the typesetter
- References: `\cite`, `\citep`, `\citet`, `\citeauthor`, `\citeyear`, `\ref`, `\eqref`,
  `\autoref`, `\cref`, `\Cref`; a References section from `\bibliography{...}`
- Theorem-like environments (`\newtheorem`), `proof`

## Class awareness

- **acmart** (SIGGRAPH and the ACM journals): the title block with authors, affiliations,
  ORCID and email; `\acmConference` or the journal line; abstract; CCS concepts from
  `\ccsdesc`; keywords; `teaserfigure`; `anonymous`/`review` options;
  `\citestyle{acmauthoryear}`; journal float labels (`Fig. 1.`)
- **CVPR author kit** (`\documentclass{article}` + `\usepackage[review|final]{cvpr}`):
  the review band with the paper id, author columns in final mode, numeric compressed
  citations (`[1–3]`), cleveref wording (`Fig. 1`, `Tab. 1`, `Sec. 2`)
- Anything else renders generically (title, author, date, sections)

## Bibliography

Put the `.bib` in the bundle and name it in `\bibliography{refs}`. Entries are formatted
in the class's style (ACM-Reference-Format for acmart, ieeenat_fullname for CVPR) and
labelled author-year or numeric as the class would. A compiled `.bbl` next to `main.tex`
wins over the `.bib`. A single `.tex` file cannot reach a `.bib`: citations show their keys
and the receipt says so.

## Figures

In a bundle, reference figures by relative path (`\includegraphics{figures/teaser}` tries
`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`). In a single file, upload the image as an
asset and reference its `/blob/<sha256>.png` URL. PDF and EPS figures cannot be shown in
the browser; keep a PNG or JPEG export beside them. TikZ pictures show a placeholder.

## Dynamic tables and figures

`\derivetable{results}` and `\derivefigure[width=0.8\linewidth]{ablation}` bind a slot
that updates without a new version (see the dynamic-data skill). Wrap them in a `table` or
`figure` environment with a `\caption`.

## What the receipt tells you

Publish advisories carry, with source lines: unknown macros and environments, TikZ,
unresolved `\ref` and `\cite`, figures the artifact cannot reach, a missing `.bib`, and
for acmart every `\usepackage` outside ACM TAPS's accepted list (or already bundled by
the class). None of them blocks the publish; the page always renders.

## Comments and edits

Comments anchor to the rendered prose. Select words, not formulas: math is typeset in
the browser and a quote across it cannot be matched server-side. Inline edits map back to
the source through the same projection; an edit that would cross a macro (`\emph{`, a
citation) is refused with a message rather than guessed.
