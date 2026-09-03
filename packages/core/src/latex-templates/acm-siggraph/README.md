# ACM SIGGRAPH paper

This folder is a paper on Derive: `main.tex` is the source the page is rendered from,
`references.bib` holds the citations, and `derive.sty` provides `\derivetable{name}` and
`\derivefigure{name}`, the tables and figures that update without a new version.

## Compile it

- **Overleaf**: upload the zip from "Download LaTeX source", set `main.tex` as the main
  document and pdfLaTeX as the compiler. Overleaf ships acmart.
- **Locally**: `pdflatex main && bibtex main && pdflatex main && pdflatex main` with a
  TeX Live that has acmart 2.16 or newer (SIGGRAPH's requirement; CTAN carries 2.20).

The download writes each dynamic slot's current value beside the sources as
`derive-dynamic/<name>.tex` (and the image file for a figure), so the compiled paper
shows the same data as the page. Edit the paper, not those fragments: the next download
regenerates them.

## Journal track

For ACM Transactions on Graphics change the first line to `\documentclass[acmtog]{acmart}`
and, for a double-blind submission, `\documentclass[acmtog,anonymous,review]{acmart}`.
`\citestyle{acmauthoryear}` stays: SIGGRAPH requires author-year citations.

## Packages

ACM's production system (TAPS) accepts a fixed list of packages. Derive reports any
`\usepackage` outside that list, and any package acmart already loads, in the publish
receipt.
